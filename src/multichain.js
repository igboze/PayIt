// src/multichain.js
// Multi-chain key derivation and transaction execution for PayIT:
// Arc Mainnet (EVM) + Solana.
// Derives deterministic Solana Keypair from the same root secret / private key.
// Supports native SOL and SPL USDC transfers with automatic ATA creation.
// Also provides receiveCctpMessageOnSolana() to complete Arc→Solana CCTP withdrawals
// using PayIT's backend as the Solana fee-payer (~$0.001 per withdrawal, no user SOL needed).

const crypto = require("crypto");
const {
  Keypair,
  PublicKey,
  Connection,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction: createAtaInstruction,
} = require("@solana/spl-token");
const bs58 = require("bs58");
const tweetnacl = require("tweetnacl");

// Solana USDC Mint (Mainnet default)
const SOLANA_USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_USDC_MINT = new PublicKey(process.env.SOLANA_USDC_MINT || SOLANA_USDC_MINT_MAINNET);

/**
 * Derives a deterministic 32-byte Ed25519 seed from an EVM private key.
 * Uses HMAC-SHA512 (BIP-32 / SLIP-0010 principle) so the same EVM private key
 * ALWAYS generates the exact same Solana address.
 *
 * @param {string} evmPrivateKey - Hex string (with or without 0x prefix)
 * @returns {{ keypair: Keypair, solanaAddress: string, secretKeyBase58: string }}
 */
function deriveSolanaFromEvmKey(evmPrivateKey) {
  if (!evmPrivateKey) {
    throw new Error("EVM private key required to derive Solana keypair");
  }

  const cleanHex = evmPrivateKey.startsWith("0x") ? evmPrivateKey.slice(2) : evmPrivateKey;
  const keyBuffer = Buffer.from(cleanHex, "hex");

  // Domain-separated HMAC to produce an Ed25519 seed
  const hmac = crypto.createHmac("sha512", Buffer.from("PayIT-Solana-CCTP-Bridge-Salt", "utf8"));
  hmac.update(keyBuffer);
  const derived = hmac.digest();

  // First 32 bytes as Ed25519 seed
  const seed32 = derived.subarray(0, 32);
  const naclKeypair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(seed32));

  const keypair = Keypair.fromSecretKey(naclKeypair.secretKey);
  const solanaAddress = keypair.publicKey.toBase58();
  const bs58Encode = bs58.default ? bs58.default.encode : bs58.encode;
  const secretKeyBase58 = bs58Encode(keypair.secretKey);

  return {
    keypair,
    solanaAddress,
    secretKeyBase58,
  };
}

/**
 * Validates whether a string is a valid Solana public key (Base58, 32-44 chars, on curve).
 *
 * @param {string} address
 * @returns {boolean}
 */
function isSolanaAddress(address) {
  if (!address || typeof address !== "string") return false;
  const trimmed = address.trim();
  if (trimmed.startsWith("0x")) return false;
  if (trimmed.length < 32 || trimmed.length > 44) return false;
  try {
    const pk = new PublicKey(trimmed);
    return PublicKey.isOnCurve(pk.toBuffer());
  } catch {
    return false;
  }
}

/**
 * Get a Solana web3 Connection instance.
 *
 * @returns {Connection}
 */
function getSolanaConnection() {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  return new Connection(rpcUrl, "confirmed");
}

/**
 * Derive the Associated Token Account (ATA) address for an owner and token mint.
 *
 * @param {PublicKey} owner
 * @param {PublicKey} mint
 * @returns {PublicKey}
 */
function getAssociatedTokenAddress(owner, mint = SOLANA_USDC_MINT) {
  // Delegate to the trusted @solana/spl-token implementation
  return getAssociatedTokenAddressSync(mint, owner, true /* allowOwnerOffCurve */);
}

/**
 * Creates an instruction to create an Associated Token Account.
 * Delegates to @solana/spl-token for correctness.
 */
function createAssociatedTokenAccountInstruction(payer, ata, owner, mint) {
  return createAtaInstruction(payer, ata, owner, mint);
}

/**
 * Creates an instruction to transfer SPL tokens (Transfer instruction, index 3).
 */
function createSplTokenTransferInstruction(sourceAta, destAta, owner, amountBaseUnits) {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0); // Instruction 3 = Transfer
  data.writeBigUInt64LE(BigInt(amountBaseUnits), 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  });
}

/**
 * Executes a transfer on Solana to a recipient address.
 * Automatically selects between native SOL transfer and SPL USDC token transfer.
 *
 * @param {object} params
 * @param {Keypair} params.keypair - Sender's Solana Keypair
 * @param {string} params.recipientAddress - Destination Solana address
 * @param {number} params.amount - Amount in token / SOL
 * @param {string} [params.currency="USDC"] - Currency ("USDC" or "SOL")
 * @returns {Promise<{ success: boolean, txHash?: string, error?: string, amount?: number, to?: string, currency?: string }>}
 */
async function sendSolanaTransfer({ keypair, recipientAddress, amount, currency = "USDC" }) {
  if (!keypair) {
    return { success: false, error: "Solana keypair required for Solana transfer" };
  }
  if (!isSolanaAddress(recipientAddress)) {
    return { success: false, error: `Invalid Solana recipient address: ${recipientAddress}` };
  }

  const isSplUsdc = currency.toUpperCase() === "USDC";
  const connection = getSolanaConnection();

  try {
    const recipientPubKey = new PublicKey(recipientAddress);
    const latestBlockhash = await connection.getLatestBlockhash();
    const transaction = new Transaction({
      feePayer: keypair.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
    });

    const solBalance = await connection.getBalance(keypair.publicKey);
    if (solBalance === 0) {
      return {
        success: false,
        error: `Insufficient SOL on sender account ${keypair.publicKey.toBase58()} to cover transaction fee.`,
      };
    }

    if (isSplUsdc) {
      // ── SPL USDC Transfer ──
      const mint = SOLANA_USDC_MINT;
      const sourceAta = getAssociatedTokenAddress(keypair.publicKey, mint);
      const destAta = getAssociatedTokenAddress(recipientPubKey, mint);

      // Check if recipient ATA exists, create if missing
      const destAccountInfo = await connection.getAccountInfo(destAta);
      if (!destAccountInfo) {
        transaction.add(
          createAssociatedTokenAccountInstruction(keypair.publicKey, destAta, recipientPubKey, mint)
        );
      }

      // USDC has 6 decimals on Solana
      const amountBaseUnits = BigInt(Math.round(amount * 1e6));
      transaction.add(
        createSplTokenTransferInstruction(sourceAta, destAta, keypair.publicKey, amountBaseUnits)
      );
    } else {
      // ── Native SOL Transfer ──
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: recipientPubKey,
          lamports: Math.round(amount * 1e9),
        })
      );
    }

    transaction.sign(keypair);
    const signature = await connection.sendRawTransaction(transaction.serialize());
    try {
      await Promise.race([
        connection.confirmTransaction({
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Solana confirmation timeout")), 12000))
      ]);
    } catch (confErr) {
      console.warn("[multichain:solana_confirm_note]", confErr.message);
    }

    return {
      success: true,
      txHash: signature,
      amount,
      to: recipientAddress,
      currency,
    };
  } catch (err) {
    return {
      success: false,
      error: `Solana transfer failed: ${err.message}`,
      amount,
      to: recipientAddress,
      currency,
    };
  }
}

/**
 * Query SPL token balance for an address.
 *
 * @param {string} ownerAddress - Solana public key
 * @param {PublicKey} [mint=SOLANA_USDC_MINT] - Token mint
 * @returns {Promise<{ uiAmount: number, amountRaw: string, decimals: number }>}
 */
async function getSplTokenBalance(ownerAddress, mint = SOLANA_USDC_MINT) {
  if (!isSolanaAddress(ownerAddress)) {
    return { uiAmount: 0, amountRaw: "0", decimals: 6 };
  }
  try {
    const connection = getSolanaConnection();
    const ownerPubkey = new PublicKey(ownerAddress);
    const ata = getAssociatedTokenAddress(ownerPubkey, mint);
    const balanceRes = await connection.getTokenAccountBalance(ata);
    return {
      uiAmount: balanceRes?.value?.uiAmount || 0,
      amountRaw: balanceRes?.value?.amount || "0",
      decimals: balanceRes?.value?.decimals || 6,
    };
  } catch (err) {
    return { uiAmount: 0, amountRaw: "0", decimals: 6 };
  }
}

// Solana CCTP Mainnet Program IDs (Circle CCTP V2)
const SOLANA_CCTP_MESSAGE_TRANSMITTER = new PublicKey("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");
const SOLANA_CCTP_TOKEN_MESSENGER = new PublicKey("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");

/**
 * Execute CCTP depositForBurn on Solana to burn SPL USDC for Arc Mainnet (Domain 26).
 *
 * @param {object} params
 * @param {Keypair} params.userKeypair - User's derived Solana keypair
 * @param {number} params.amountUsdc - Amount to burn
 * @param {string} params.recipientArcAddress - Destination 0x... EVM address on Arc
 * @param {Keypair} [params.feePayerKeypair] - Optional fee payer keypair (PayIT pays the $0.0008 fee)
 * @returns {Promise<{ success: boolean, txSignature?: string, error?: string }>}
 */
async function executeSolanaCctpBurn({ userKeypair, amountUsdc, recipientArcAddress, feePayerKeypair }) {
  if (!userKeypair) {
    return { success: false, error: "User Solana keypair required for CCTP burn" };
  }
  const connection = getSolanaConnection();
  const payer = feePayerKeypair || userKeypair;

  try {
    const mint = SOLANA_USDC_MINT;
    const userAta = getAssociatedTokenAddress(userKeypair.publicKey, mint);

    const [messageTransmitterPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("message_transmitter")],
      SOLANA_CCTP_MESSAGE_TRANSMITTER
    );

    const [tokenMessengerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_messenger")],
      SOLANA_CCTP_TOKEN_MESSENGER
    );

    const [tokenMinterPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_minter")],
      SOLANA_CCTP_TOKEN_MESSENGER
    );

    const [localTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("local_token"), mint.toBuffer()],
      SOLANA_CCTP_TOKEN_MESSENGER
    );

    const [remoteTokenMessengerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("remote_token_messenger"), Buffer.from("26", "utf8")],
      SOLANA_CCTP_TOKEN_MESSENGER
    );

    const [senderAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sender_authority")],
      SOLANA_CCTP_TOKEN_MESSENGER
    );

    // Format 32-byte recipient: zero-padded EVM address
    const cleanEvm = recipientArcAddress.replace(/^0x/, "").toLowerCase();
    const recipientBuffer = Buffer.alloc(32);
    Buffer.from(cleanEvm, "hex").copy(recipientBuffer, 12);

    const discriminator = Buffer.from([198, 210, 137, 240, 109, 179, 135, 14]);
    const amountBaseUnits = BigInt(Math.round(amountUsdc * 1e6));
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(amountBaseUnits, 0);

    const data = Buffer.concat([
      discriminator,
      amountBuf,
      Buffer.from([26, 0, 0, 0]),
      recipientBuffer,
    ]);

    const keys = [
      { pubkey: userKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: senderAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: localTokenPda, isSigner: false, isWritable: true },
      { pubkey: tokenMinterPda, isSigner: false, isWritable: true },
      { pubkey: remoteTokenMessengerPda, isSigner: false, isWritable: false },
      { pubkey: tokenMessengerPda, isSigner: false, isWritable: false },
      { pubkey: messageTransmitterPda, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: SOLANA_CCTP_MESSAGE_TRANSMITTER, isSigner: false, isWritable: false },
      { pubkey: SOLANA_CCTP_TOKEN_MESSENGER, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ];

    const ix = new TransactionInstruction({
      programId: SOLANA_CCTP_TOKEN_MESSENGER,
      keys,
      data,
    });

    const latestBlockhash = await connection.getLatestBlockhash();
    const tx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
    });

    tx.add(ix);
    tx.sign(payer, userKeypair);

    const txSignature = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction({
      signature: txSignature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    return { success: true, txSignature };
  } catch (err) {
    console.warn("[multichain:cctp_burn_error]", err.message);
    return { success: false, error: err.message };
  }
}

// ─── CCTP Message Parsing ─────────────────────────────────────────────────────

/**
 * Parse a raw CCTP V2 message buffer to extract key routing fields.
 *
 * CCTP V2 message layout (all big-endian):
 *   [0-3]   version:            uint32
 *   [4-7]   sourceDomain:       uint32
 *   [8-11]  destinationDomain:  uint32
 *   [12-19] nonce:              uint64 (nonceBytes used directly as PDA seed)
 *   [20-51] sender:             bytes32
 *   [52-83] recipient:          bytes32 (TokenMessenger program on Solana)
 *   [84-115] destinationCaller: bytes32
 *   [116+]  messageBody:
 *     [0-3]   messageBodyVersion: uint32
 *     [4-35]  burnToken:          bytes32 (Arc USDC contract address, zero-padded, offset 120)
 *     [36-67] mintRecipient:      bytes32 (Solana recipient public key, offset 152)
 *     [68-99] amount:             uint256
 *
 * @param {string} messageHex - Hex message bytes (with or without 0x)
 * @returns {{ sourceDomain, nonceBytes, nonce, mintRecipient, burnToken }}
 */
function parseCctpMessage(messageHex) {
  const buf = Buffer.from(messageHex.replace(/^0x/, ""), "hex");
  if (buf.length < 184) {
    throw new Error(`CCTP message too short (${buf.length} bytes), expected ≥ 184`);
  }
  const sourceDomain = buf.readUInt32BE(4);
  const nonceBytes   = buf.slice(12, 20); // 8-byte big-endian nonce
  const nonce        = buf.readBigUInt64BE(12);

  // messageBody starts at offset 116
  // V2: messageBody[4..36] is burnToken (offset 120..152)
  //     messageBody[36..68] is mintRecipient (offset 152..184)
  const burnToken     = buf.slice(120, 152); // 32 bytes
  const mintRecipient = buf.slice(152, 184); // 32 bytes (Solana recipient pubkey)
  return { sourceDomain, nonceBytes, nonce, mintRecipient, burnToken };
}

/**
 * Derive the used_nonce PDA for the CCTP V2 MessageTransmitter.
 * seeds = ["used_nonce", nonce_bytes_8_be]
 *
 * @param {Buffer} nonceBytes - 8-byte big-endian nonce from the CCTP message
 * @returns {PublicKey}
 */
function getUsedNoncePda(nonceBytes) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("used_nonce"), nonceBytes],
    SOLANA_CCTP_MESSAGE_TRANSMITTER
  );
  return pda;
}

// ─── CCTP receiveMessage on Solana ────────────────────────────────────────────

/**
 * Submit a CCTP V2 `receiveMessage` on Solana after Circle attests to a burn on
 * a source chain (Arc Mainnet, domain 26).  This mints USDC directly to
 * the recipient's token account (e.g. Paj's deposit address).  PayIT's backend
 * wallet is the fee-payer, spending only ~$0.001 in SOL per call — the recipient
 * needs zero SOL.
 *
 * @param {object}  params
 * @param {string}  params.messageHex             - Raw CCTP message bytes (hex, ±0x)
 * @param {string}  params.attestationHex          - Circle attestation bytes (hex, ±0x)
 * @param {Keypair} params.feePayerKeypair         - PayIT backend Solana wallet (holds SOL)
 * @param {number}  [params.sourceDomainOverride]  - Override parsed source domain
 * @returns {Promise<{ success: boolean, txSignature?: string, error?: string }>}
 */
async function receiveCctpMessageOnSolana({ messageHex, attestationHex, feePayerKeypair, sourceDomainOverride }) {
  if (!feePayerKeypair) {
    return { success: false, error: "feePayerKeypair required to submit CCTP receiveMessage on Solana" };
  }
  if (!messageHex || !attestationHex) {
    return { success: false, error: "message and attestation hex bytes are required" };
  }

  const connection = getSolanaConnection();

  try {
    const { sourceDomain, nonceBytes, mintRecipient, burnToken } = parseCctpMessage(messageHex);
    const effectiveSrcDomain = sourceDomainOverride !== undefined ? sourceDomainOverride : sourceDomain;

    // mintRecipient is the 32-byte Solana public key of the token recipient
    const recipientPubkey = new PublicKey(mintRecipient);
    const recipientAta    = getAssociatedTokenAddress(recipientPubkey, SOLANA_USDC_MINT);

    // ── MessageTransmitterV2 PDAs ───────────────────────────────────────────
    const [authorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("message_transmitter_authority"), SOLANA_CCTP_TOKEN_MESSENGER.toBuffer()],
      SOLANA_CCTP_MESSAGE_TRANSMITTER
    );

    const [messageTransmitterPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("message_transmitter")],
      SOLANA_CCTP_MESSAGE_TRANSMITTER
    );

    const [usedNoncePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("used_nonce"), nonceBytes],
      SOLANA_CCTP_MESSAGE_TRANSMITTER
    );

    const [mtEventAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      SOLANA_CCTP_MESSAGE_TRANSMITTER
    );

    // ── TokenMessengerMinterV2 PDAs ─────────────────────────────────────────
    const [tokenMessengerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_messenger")],
      SOLANA_CCTP_TOKEN_MESSENGER
    );

    const [remoteTokenMessengerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("remote_token_messenger"), Buffer.from(effectiveSrcDomain.toString(), "utf8")],
      SOLANA_CCTP_TOKEN_MESSENGER
    );

    const [tokenMinterPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_minter")],
      SOLANA_CCTP_TOKEN_MESSENGER
    );

    const [localTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("local_token"), SOLANA_USDC_MINT.toBuffer()],
      SOLANA_CCTP_TOKEN_MESSENGER
    );

    const [tokenPairPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_pair"), Buffer.from(effectiveSrcDomain.toString(), "utf8"), burnToken],
      SOLANA_CCTP_TOKEN_MESSENGER
    );

    // Circle CCTP V2 fee recipient token account
    const feeRecipient = new PublicKey("4BPnUzFDibVcWQ5zzixGodRUHwqDxHYpUPdPYus3Bn56");
    const feeRecipientAta = getAssociatedTokenAddress(feeRecipient, SOLANA_USDC_MINT);

    const [custodyTokenAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("custody"), SOLANA_USDC_MINT.toBuffer()],
      SOLANA_CCTP_TOKEN_MESSENGER
    );

    const [tmEventAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      SOLANA_CCTP_TOKEN_MESSENGER
    );

    // ── Build instruction data (Anchor Borsh encoding) ───────────────────────
    // discriminator = sha256("global:receive_message")[0:8]
    const discriminator = crypto
      .createHash("sha256")
      .update("global:receive_message")
      .digest()
      .slice(0, 8);

    const msgBytes = Buffer.from(messageHex.replace(/^0x/, ""), "hex");
    const attBytes = Buffer.from(attestationHex.replace(/^0x/, ""), "hex");

    // Vec<u8> = [length: u32 LE][bytes]
    const msgLenBuf = Buffer.alloc(4);
    msgLenBuf.writeUInt32LE(msgBytes.length, 0);
    const attLenBuf = Buffer.alloc(4);
    attLenBuf.writeUInt32LE(attBytes.length, 0);

    const data = Buffer.concat([discriminator, msgLenBuf, msgBytes, attLenBuf, attBytes]);

    // ── Account list (order is contract-defined in CCTP V2) ───────────────────
    // Accounts 0-8: MessageTransmitterV2 receive_message context
    // Accounts 9-19: Forwarded to TokenMessengerMinterV2 handle_receive_finalized_message
    const keys = [
      /* 0  payer              */ { pubkey: feePayerKeypair.publicKey,       isSigner: true,  isWritable: true  },
      /* 1  caller             */ { pubkey: feePayerKeypair.publicKey,       isSigner: true,  isWritable: false },
      /* 2  authorityPda       */ { pubkey: authorityPda,                    isSigner: false, isWritable: false },
      /* 3  messageTransmitter */ { pubkey: messageTransmitterPda,           isSigner: false, isWritable: false },
      /* 4  usedNonce          */ { pubkey: usedNoncePda,                    isSigner: false, isWritable: true  },
      /* 5  receiver           */ { pubkey: SOLANA_CCTP_TOKEN_MESSENGER,     isSigner: false, isWritable: false },
      /* 6  systemProgram      */ { pubkey: SystemProgram.programId,         isSigner: false, isWritable: false },
      /* 7  mtEventAuthority   */ { pubkey: mtEventAuthorityPda,             isSigner: false, isWritable: false },
      /* 8  mtProgram (self)   */ { pubkey: SOLANA_CCTP_MESSAGE_TRANSMITTER, isSigner: false, isWritable: false },
      // Forwarded remaining accounts for TokenMessengerMinterV2 CPI:
      /* 9  tokenMessenger     */ { pubkey: tokenMessengerPda,               isSigner: false, isWritable: false },
      /* 10 remoteTokenMsg     */ { pubkey: remoteTokenMessengerPda,         isSigner: false, isWritable: false },
      /* 11 tokenMinter        */ { pubkey: tokenMinterPda,                  isSigner: false, isWritable: false },
      /* 12 localToken         */ { pubkey: localTokenPda,                   isSigner: false, isWritable: true  },
      /* 13 tokenPair          */ { pubkey: tokenPairPda,                    isSigner: false, isWritable: false },
      /* 14 feeRecipientAta    */ { pubkey: feeRecipientAta,                 isSigner: false, isWritable: true  },
      /* 15 recipientTokenAcct */ { pubkey: recipientAta,                    isSigner: false, isWritable: true  },
      /* 16 custodyTokenAcct   */ { pubkey: custodyTokenAccountPda,          isSigner: false, isWritable: true  },
      /* 17 tokenProgram       */ { pubkey: TOKEN_PROGRAM_ID,                isSigner: false, isWritable: false },
      /* 18 tmEventAuthority   */ { pubkey: tmEventAuthorityPda,             isSigner: false, isWritable: false },
      /* 19 tmProgram (self)   */ { pubkey: SOLANA_CCTP_TOKEN_MESSENGER,     isSigner: false, isWritable: false },
    ];

    const receiveIx = new TransactionInstruction({
      programId: SOLANA_CCTP_MESSAGE_TRANSMITTER,
      keys,
      data,
    });

    // ── Build transaction ────────────────────────────────────────────────────
    const latestBlockhash = await connection.getLatestBlockhash();
    const tx = new Transaction({
      feePayer: feePayerKeypair.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
    });

    // Create recipient ATA if it doesn't exist yet (fee payer covers ~0.002 SOL rent)
    const ataInfo = await connection.getAccountInfo(recipientAta);
    if (!ataInfo) {
      console.log(`[multichain:receive_cctp] Creating ATA for ${recipientPubkey.toBase58()}...`);
      tx.add(createAssociatedTokenAccountInstruction(
        feePayerKeypair.publicKey, // payer
        recipientAta,
        recipientPubkey,
        SOLANA_USDC_MINT
      ));
    }

    tx.add(receiveIx);
    tx.sign(feePayerKeypair);

    const txSignature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    console.log(`[multichain:receive_cctp] receiveMessage submitted: ${txSignature}`);

    try {
      await Promise.race([
        connection.confirmTransaction({
          signature: txSignature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Confirmation timeout")), 45000)),
      ]);
      console.log(`[multichain:receive_cctp] USDC minted on Solana ✓ tx=${txSignature}`);
    } catch (confErr) {
      // Non-fatal — tx may still confirm, caller can check status
      console.warn("[multichain:receive_cctp_confirm_note]", confErr.message);
    }

    return { success: true, txSignature };
  } catch (err) {
    console.warn("[multichain:receive_cctp_error]", err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  deriveSolanaFromEvmKey,
  isSolanaAddress,
  getSolanaConnection,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSplTokenTransferInstruction,
  sendSolanaTransfer,
  getSplTokenBalance,
  executeSolanaCctpBurn,
  parseCctpMessage,
  getUsedNoncePda,
  getUsedNoncesPda: getUsedNoncePda,
  receiveCctpMessageOnSolana,
  SOLANA_USDC_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
};
