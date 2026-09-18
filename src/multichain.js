// src/multichain.js
// Multi-chain key derivation and transaction execution for PayIT:
// Arc Mainnet (EVM) + Solana.
// Derives deterministic Solana Keypair from the same root secret / private key.
// Supports native SOL and SPL USDC transfers with automatic ATA creation.

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
const bs58 = require("bs58");
const tweetnacl = require("tweetnacl");

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

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
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

/**
 * Creates an instruction to create an Associated Token Account.
 */
function createAssociatedTokenAccountInstruction(payer, ata, owner, mint) {
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.alloc(0),
  });
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
    await connection.confirmTransaction({
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

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

module.exports = {
  deriveSolanaFromEvmKey,
  isSolanaAddress,
  getSolanaConnection,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSplTokenTransferInstruction,
  sendSolanaTransfer,
  SOLANA_USDC_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
};
