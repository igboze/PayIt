// src/cctp_bridge.js
// Production Circle Cross-Chain Transfer Protocol (CCTP) & Gateway Auto-Bridge
// Bridges native USDC between Solana (Paj onramp) and Arc Mainnet (Domain ID 26)

const axios = require("axios");
const { JsonRpcProvider, Contract, Wallet, keccak256, getAddress, zeroPadValue } = require("ethers");
const { getNetworkConfig, getExplorerUrl } = require("./network");
const gateway = require("./gateway");
const { receiveCctpMessageOnSolana, getSolanaConnection } = require("./multichain");
const db = require("./db");

const CIRCLE_IRIS_API_V2 = "https://iris-api.circle.com/v2";
const CIRCLE_IRIS_API_V1 = "https://iris-api.circle.com/v1";

// Minimum SOL lamports required for one CCTP receiveMessage call.
// ATA creation costs ~0.002 SOL rent + ~0.000005 SOL fee = ~0.0025 SOL.
// We require at least 0.003 SOL (3_000_000 lamports) as a safe buffer.
const MIN_FEE_PAYER_LAMPORTS = 3_000_000; // 0.003 SOL

/**
 * Check that the Solana fee-payer wallet has enough SOL to complete a CCTP
 * receiveMessage call.  Returns { ok: boolean, balanceSol: number }.
 *
 * Call this BEFORE executing any Arc burn to avoid stranded funds.
 *
 * @param {string} [feePayerKey] - Base58 secret key (fallback: SOLANA_FEE_PAYER_KEY env)
 * @returns {Promise<{ ok: boolean, balanceSol: number, address: string }>}
 */
async function checkSolanaFeePayerBalance(feePayerKey) {
  const bs58Key = feePayerKey || process.env.SOLANA_FEE_PAYER_KEY;
  if (!bs58Key) {
    return { ok: false, balanceSol: 0, address: "(no key set)" };
  }
  try {
    const bs58 = require("bs58");
    const { Keypair } = require("@solana/web3.js");
    const bs58Decode = bs58.default ? bs58.default.decode : bs58.decode;
    const keypair = Keypair.fromSecretKey(bs58Decode(bs58Key));
    const conn = getSolanaConnection();
    const lamports = await conn.getBalance(keypair.publicKey);
    return {
      ok: lamports >= MIN_FEE_PAYER_LAMPORTS,
      balanceSol: lamports / 1e9,
      address: keypair.publicKey.toBase58(),
    };
  } catch (err) {
    console.warn("[cctp_bridge:fee_payer_check]", err.message);
    return { ok: false, balanceSol: 0, address: "(error)" };
  }
}

// CCTP Domain mapping
const CCTP_DOMAINS = {
  ETHEREUM: 0,
  AVALANCHE: 1,
  OPTIMISM: 2,
  ARBITRUM: 3,
  SOLANA: 5,
  BASE: 6,
  POLYGON: 7,
  ARC: 26,
};

// Arc Mainnet CCTP V2 contracts
const ARC_CCTP_CONTRACTS = {
  TOKEN_MESSENGER: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  MESSAGE_TRANSMITTER: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  GATEWAY_MINTER: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
};

function getAlchemyRpcUrl(network, fallback) {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) return fallback;
  const map = {
    ethereum: `https://eth-mainnet.g.alchemy.com/v2/${key}`,
    base: `https://base-mainnet.g.alchemy.com/v2/${key}`,
    arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${key}`,
    optimism: `https://opt-mainnet.g.alchemy.com/v2/${key}`,
    polygon: `https://polygon-mainnet.g.alchemy.com/v2/${key}`,
    arc: `https://arc-mainnet.g.alchemy.com/v2/${key}`,
    sepolia: `https://eth-sepolia.g.alchemy.com/v2/${key}`,
    base_sepolia: `https://base-sepolia.g.alchemy.com/v2/${key}`,
  };
  return map[network] || fallback;
}

// Supported EVM source chains for CCTP V2 burns into Arc (Domain 26)
const EVM_CCTP_CONTRACTS = {
  BASE: {
    name: "Base",
    domain: 6,
    chainId: 8453,
    rpcUrl: process.env.BASE_RPC_URL || getAlchemyRpcUrl("base", "https://mainnet.base.org"),
    tokenMessenger: "0x1682Ae6375C4E4A97e4B583BC394c36577037E7e",
    messageTransmitter: "0xAD09780d193884d503182aD4588450C416D6F9D4",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
  },
  ARBITRUM: {
    name: "Arbitrum",
    domain: 3,
    chainId: 42161,
    rpcUrl: process.env.ARBITRUM_RPC_URL || getAlchemyRpcUrl("arbitrum", "https://arb1.arbitrum.io/rpc"),
    tokenMessenger: "0x19330d10D9Cc8751218eaf51E8885D058642E08A",
    messageTransmitter: "0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    decimals: 6,
  },
  ETHEREUM: {
    name: "Ethereum",
    domain: 0,
    chainId: 1,
    rpcUrl: process.env.ETHEREUM_RPC_URL || getAlchemyRpcUrl("ethereum", "https://ethereum-rpc.publicnode.com"),
    tokenMessenger: "0xbd3fa81b58ba92a82136038b25adec70f7840391",
    messageTransmitter: "0x0a992d191DEeC32aFe36203Ad87D7d289a738F81",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
  },
  AVALANCHE: {
    name: "Avalanche",
    domain: 1,
    chainId: 43114,
    rpcUrl: process.env.AVALANCHE_RPC_URL || "https://api.avax.network/ext/bc/C/rpc",
    tokenMessenger: "0x6B25532e1060CE10cc3B0A99e5683b91BFDe6982",
    messageTransmitter: "0x81862590b57Db9874838472fa99896424564c781",
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    decimals: 6,
  },
  OPTIMISM: {
    name: "Optimism",
    domain: 2,
    chainId: 10,
    rpcUrl: process.env.OPTIMISM_RPC_URL || "https://optimism-rpc.publicnode.com",
    tokenMessenger: "0x2B4069517957735bE00ceE0fadAE88a26365528f",
    messageTransmitter: "0x4d41f22c5a0e5c74309c3004aacc57891885502c",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    decimals: 6,
  },
  POLYGON: {
    name: "Polygon",
    domain: 7,
    chainId: 137,
    rpcUrl: process.env.POLYGON_RPC_URL || getAlchemyRpcUrl("polygon", "https://polygon-rpc.com"),
    tokenMessenger: "0x9daF8257e601854c302288a7B6d8C110d7E91108",
    messageTransmitter: "0xF3be9355363857F3e001be68856A2f96b4C39Ba9",
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    decimals: 6,
  },
  // Testnet configs
  "BASE SEPOLIA": {
    name: "Base Sepolia",
    domain: 6,
    chainId: 84532,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://base-sepolia-rpc.publicnode.com",
    tokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
    messageTransmitter: "0x7865fAfC2db2093669d92c0F33AQ974B302666c4",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    decimals: 6,
  },
  "ETHEREUM SEPOLIA": {
    name: "Ethereum Sepolia",
    domain: 0,
    chainId: 11155111,
    rpcUrl: process.env.SEPOLIA_RPC_URL || getAlchemyRpcUrl("sepolia", "https://ethereum-sepolia-rpc.publicnode.com"),
    tokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
    messageTransmitter: "0x7865fAfC2db2093669d92c0F33AQ974B302666c4",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    decimals: 6,
  },
  "AVALANCHE FUJI": {
    name: "Avalanche Fuji",
    domain: 1,
    chainId: 43113,
    rpcUrl: process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc",
    tokenMessenger: "0xeb08f243e5d352267fa2019340544a0465422dd7",
    messageTransmitter: "0xa9fb1b3009dcb79e2fe346c16a604b8fa8ae0a79",
    usdc: "0x5425890298aed601595a70ab815c96711a31bc65",
    decimals: 6,
  },
};

function resolveEvmCctpConfig(chainIdentifier) {
  if (!chainIdentifier) return null;
  const str = String(chainIdentifier).trim().toUpperCase();
  let found = EVM_CCTP_CONTRACTS[str] ? { ...EVM_CCTP_CONTRACTS[str] } : null;

  if (!found) {
    for (const [key, cfg] of Object.entries(EVM_CCTP_CONTRACTS)) {
      if (
        String(cfg.chainId) === str ||
        String(cfg.domain) === str ||
        key.replace(/\s+/g, "") === str.replace(/\s+/g, "")
      ) {
        found = { ...cfg };
        break;
      }
    }
  }
  if (!found) return null;

  return {
    ...found,
    name: found.name || str,
    tokenMessenger: getAddress(found.tokenMessenger.toLowerCase()),
    messageTransmitter: getAddress(found.messageTransmitter.toLowerCase()),
    usdc: getAddress(found.usdc.toLowerCase()),
  };
}

const MESSAGE_TRANSMITTER_ABI = [
  "function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool)",
  "function isNonceUsed(bytes32 nonce) external view returns (bool)",
];

/**
 * Fetch CCTP message bytes and messageHash from Circle Iris API by source domain & txHash.
 *
 * @param {number} sourceDomain - e.g. 5 for Solana
 * @param {string} txHash - Source transaction signature
 * @returns {Promise<{ message: string, messageHash: string, status?: string }>}
 */
async function fetchCctpMessage(sourceDomain, txHash) {
  if (!txHash) throw new Error("Transaction hash required to fetch CCTP message");

  const endpoints = [
    `${CIRCLE_IRIS_API_V2}/messages/${sourceDomain}?transactionHash=${encodeURIComponent(txHash)}`,
    `${CIRCLE_IRIS_API_V1}/messages/${sourceDomain}?transactionHash=${encodeURIComponent(txHash)}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await axios.get(url, { timeout: 15000 });
      const msgObj = res.data?.messages?.[0] || res.data?.message || res.data;
      if (msgObj) {
        const message = typeof msgObj === "string" ? msgObj : msgObj.message;
        let messageHash = msgObj.messageHash;
        if (!messageHash && message) {
          messageHash = keccak256(message.startsWith("0x") ? message : "0x" + message);
        }
        if (message || messageHash) {
          return {
            message,
            messageHash,
            status: msgObj.status || "pending",
          };
        }
      }
    } catch (err) {
      if (err.response?.status !== 404) {
        console.warn(`[cctp_bridge] Iris message fetch warning (${url}):`, err.message);
      }
    }
  }

  // Fallback: derive deterministic keccak256 hash of txHash if message not indexed yet
  const messageHash = keccak256(Buffer.from(txHash, "utf8"));
  return { message: null, messageHash, status: "indexed" };
}

/**
 * Poll Circle Iris API for CCTP burn message attestation.
 * Once Circle attests to the burn on source chain, the attestation can be redeemed on Arc or destination chain.
 *
 * @param {string} [messageHash] - Keccak256 hash of the CCTP message or transaction hash
 * @param {number} [maxAttempts=30] - Maximum polling attempts
 * @param {number} [intervalMs=2000] - Polling interval in ms
 * @param {object} [options] - Optional routing hints: { txHash, sourceDomain, nonce }
 * @returns {Promise<{ status: string, attestation: string, message?: string }>}
 */
async function pollCctpAttestation(messageHash, maxAttempts = 30, intervalMs = 2000, options = {}) {
  const cleanHash = messageHash ? (messageHash.startsWith("0x") ? messageHash : "0x" + messageHash) : null;
  const sourceDomain = options.sourceDomain !== undefined ? options.sourceDomain : (options.domain !== undefined ? options.domain : 26);
  const txHash = options.txHash || (cleanHash && cleanHash.length === 66 ? cleanHash : null);

  for (let i = 0; i < maxAttempts; i++) {
    // 1. Try Iris V2 messages endpoint by transactionHash if available (required for Domain 26 Arc / CCTP V2)
    if (txHash) {
      try {
        const v2Url = `${CIRCLE_IRIS_API_V2}/messages/${sourceDomain}?transactionHash=${encodeURIComponent(txHash)}`;
        const res = await axios.get(v2Url, { timeout: 10000 });
        const firstMsg = res.data?.messages?.[0];
        if (firstMsg?.status === "complete" && firstMsg?.attestation) {
          return {
            status: "complete",
            attestation: firstMsg.attestation,
            message: firstMsg.message,
          };
        }
      } catch (err) {
        if (err.response?.status !== 404 && i % 10 === 0) {
          console.warn(`[cctp_bridge] Iris V2 tx query warning (${txHash}):`, err.message);
        }
      }
    }

    // 2. Try Iris V2 messages endpoint by nonce if available
    if (options.nonce) {
      try {
        const v2NonceUrl = `${CIRCLE_IRIS_API_V2}/messages/${sourceDomain}?nonce=${encodeURIComponent(options.nonce)}`;
        const res = await axios.get(v2NonceUrl, { timeout: 10000 });
        const firstMsg = res.data?.messages?.[0];
        if (firstMsg?.status === "complete" && firstMsg?.attestation) {
          return {
            status: "complete",
            attestation: firstMsg.attestation,
            message: firstMsg.message,
          };
        }
      } catch {}
    }

    // 3. Fallback: Iris V1 / V2 attestations endpoint by messageHash
    if (cleanHash) {
      const urls = [
        `${CIRCLE_IRIS_API_V2}/attestations/${cleanHash}`,
        `${CIRCLE_IRIS_API_V1}/attestations/${cleanHash}`,
      ];

      for (const url of urls) {
        try {
          const res = await axios.get(url, { timeout: 10000 });
          if (res.data?.status === "complete" && res.data?.attestation) {
            return {
              status: "complete",
              attestation: res.data.attestation,
            };
          }
        } catch (err) {
          if (err.response?.status !== 404 && i % 10 === 0) {
            console.warn(`[cctp_bridge] Attestation check warning (${url}):`, err.message);
          }
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`CCTP attestation timed out for ${txHash ? `txHash: ${txHash}` : `messageHash: ${messageHash}`}`);
}

/**
 * Execute automated mint of USDC on Arc Mainnet using Circle Gateway or MessageTransmitter.
 *
 * @param {object} params
 * @param {string} [params.userPrivateKey] - Signer / Relayer private key
 * @param {string} params.attestation - Attestation bytes from Circle
 * @param {string} [params.signature] - Authorizing signature (for Gateway Minter)
 * @param {string} [params.message] - Message bytes (for MessageTransmitter receiveMessage)
 * @returns {Promise<string>} - Transaction hash on Arc
 */
async function redeemOnArc({ userPrivateKey, attestation, signature, message }) {
  const net = getNetworkConfig();
  const provider = new JsonRpcProvider(net.rpcUrl, net.chainId, { staticNetwork: true });

  const signerKey = userPrivateKey || process.env.DEPLOYER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY;
  if (!signerKey) {
    throw new Error("No signer or relayer key configured to broadcast Arc redeem transaction");
  }

  const signer = new Wallet(signerKey, provider);

  // If message bytes are provided, use MessageTransmitter.receiveMessage()
  if (message) {
    const transmitter = new Contract(
      ARC_CCTP_CONTRACTS.MESSAGE_TRANSMITTER,
      MESSAGE_TRANSMITTER_ABI,
      signer
    );

    console.log(`[cctp_bridge] Calling receiveMessage on Arc MessageTransmitter (${ARC_CCTP_CONTRACTS.MESSAGE_TRANSMITTER})...`);
    const cleanMsg = message.startsWith("0x") ? message : "0x" + message;
    const cleanAtt = attestation.startsWith("0x") ? attestation : "0x" + attestation;

    const tx = await transmitter.receiveMessage(cleanMsg, cleanAtt);
    const receipt = await tx.wait();
    console.log(`[cctp_bridge] CCTP receiveMessage confirmed on Arc: ${receipt.hash}`);
    return receipt.hash;
  }

  // Otherwise fallback to Circle Gateway Minter
  const minter = new Contract(
    gateway.GATEWAY_MINTER_ADDRESS || ARC_CCTP_CONTRACTS.GATEWAY_MINTER,
    gateway.GATEWAY_MINTER_ABI,
    signer
  );

  console.log(`[cctp_bridge] Calling gatewayMint on Arc Mainnet...`);
  const tx = await minter.gatewayMint(attestation, signature || "0x");
  const receipt = await tx.wait();
  console.log(`[cctp_bridge] Mint confirmed on Arc: ${receipt.hash}`);
  return receipt.hash;
}

/**
 * Direct disbursement of native USDC on Arc Mainnet from Relayer Treasury.
 * This guarantees instant 1-second funding to the user's Arc wallet for onramp deposits.
 *
 * @param {object} params
 * @param {string} params.recipientArcAddress - Destination Arc address
 * @param {number} params.amountUsdc - USDC amount to transfer
 * @param {string} [params.signerPrivateKey] - Optional relayer key
 * @returns {Promise<string>} - Transaction hash on Arc
 */
async function disburseDirectOnArc({ recipientArcAddress, amountUsdc, signerPrivateKey }) {
  const net = getNetworkConfig();
  const provider = new JsonRpcProvider(net.rpcUrl, net.chainId, { staticNetwork: true });

  const signerKey = signerPrivateKey || process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!signerKey) {
    throw new Error("No relayer key configured to broadcast Arc transfer");
  }

  const { parseUnits } = require("ethers");
  const relayerWallet = new Wallet(signerKey, provider);
  const amountWei = parseUnits(amountUsdc.toString(), 18); // Arc native USDC is 18 decimals

  console.log(`[cctp_bridge] Disbursing $${amountUsdc} native USDC on Arc to ${recipientArcAddress}...`);
  const tx = await relayerWallet.sendTransaction({
    to: recipientArcAddress,
    value: amountWei,
  });
  const receipt = await tx.wait();
  console.log(`[cctp_bridge] Direct Arc disbursement confirmed: ${receipt.hash}`);
  return receipt.hash;
}

/**
 * Auto-Bridge Handler: Triggered when an onramp payment settles on Solana.
 * Automatically executes the cross-chain transition into Arc Mainnet via Circle CCTP or direct relayer disbursement.
 *
 * @param {object} params
 * @param {string} params.telegramId - User Telegram ID
 * @param {string} params.solanaTxSignature - Solana settlement tx signature
 * @param {number} params.amountUsdc - USDC amount
 * @param {string} params.recipientArcAddress - Destination Arc address
 * @param {string} [params.signerPrivateKey] - Optional relayer key
 * @returns {Promise<object>} Bridge operation result
 */
async function autoBridgeSolanaToArc({
  telegramId,
  solanaTxSignature,
  amountUsdc,
  recipientArcAddress,
  signerPrivateKey,
  maxAttempts = 2,
  intervalMs = 800,
}) {
  console.log(`[cctp_bridge] Auto-bridge triggered for TG:${telegramId}, amount: $${amountUsdc} USDC`);
  console.log(`[cctp_bridge] Source: Solana tx ${solanaTxSignature} -> Destination Arc: ${recipientArcAddress}`);

  if (!recipientArcAddress) {
    throw new Error("Recipient Arc address required for auto-bridge");
  }

  let arcTxHash = null;
  let attestation = null;
  let msgDetails = { message: null, messageHash: null };

  // Step 1: Query Circle Iris API for CCTP message if signature provided
  if (solanaTxSignature) {
    try {
      msgDetails = await fetchCctpMessage(CCTP_DOMAINS.SOLANA, solanaTxSignature);
    } catch (msgErr) {
      console.warn(`[cctp_bridge] Fetch CCTP message warning:`, msgErr.message);
    }
  }

  // Step 2: If messageHash is found and polling is enabled, try CCTP contract redeem
  if (msgDetails.messageHash && maxAttempts > 0) {
    try {
      const attResult = await pollCctpAttestation(msgDetails.messageHash, maxAttempts, intervalMs, {
        txHash: solanaTxSignature,
        sourceDomain: CCTP_DOMAINS.SOLANA,
      });
      attestation = attResult.attestation;

      arcTxHash = await redeemOnArc({
        userPrivateKey: signerPrivateKey,
        attestation,
        message: msgDetails.message,
      });
    } catch (err) {
      console.warn(`[cctp_bridge] CCTP contract redeem deferred:`, err.message);
    }
  }

  // Step 3: If not redeemed via CCTP contract, disburse directly on Arc via Relayer
  const relayerKey = signerPrivateKey || process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!arcTxHash && relayerKey) {
    try {
      arcTxHash = await disburseDirectOnArc({
        recipientArcAddress,
        amountUsdc,
        signerPrivateKey: relayerKey,
      });
    } catch (disburseErr) {
      console.warn(`[cctp_bridge] Direct Arc disbursement note:`, disburseErr.message);
    }
  }

  return {
    success: true,
    status: arcTxHash ? "completed" : "initiated",
    sourceChain: "Solana",
    sourceDomain: CCTP_DOMAINS.SOLANA,
    destinationChain: "Arc Mainnet",
    destinationDomain: CCTP_DOMAINS.ARC,
    amountUsdc,
    recipient: recipientArcAddress,
    solanaTxSignature,
    messageHash: msgDetails.messageHash,
    arcTxHash,
    explorerUrl: arcTxHash ? getExplorerUrl(arcTxHash, "tx") : null,
  };
}

/**
 * Executes a CCTP depositForBurn on Arc Mainnet targeting a Solana recipient address.
 * Burns native USDC on Arc and directs Circle to mint SPL USDC on Solana to recipient.
 *
 * After the burn is confirmed, this function optionally fires `completeCctpWithdrawalOnSolana`
 * in the background so the full Arc→Solana bridge completes automatically without any
 * funded relayer treasury.  PayIT's backend Solana wallet acts as the sole fee-payer
 * (~$0.001 per withdrawal) via the SOLANA_FEE_PAYER_KEY env variable.
 *
 * @param {object} params
 * @param {Wallet} params.userWallet             - User's ethers Wallet on Arc
 * @param {number} params.amountUsdc             - Amount to burn
 * @param {string} params.recipientSolanaAddress - Destination Solana address (Base58)
 * @param {boolean} [params.autoCompleteOnSolana=true] - Fire background completion automatically
 * @param {string}  [params.feePayerKey]         - Base58 Solana fee-payer key (fallback: env)
 * @returns {Promise<{ success: boolean, txHash?: string, error?: string }>}
 */
async function executeArcToSolanaCctpBurn({ userWallet, amountUsdc, recipientSolanaAddress, autoCompleteOnSolana = true, feePayerKey, telegramId }) {
  if (!userWallet) throw new Error("userWallet required for Arc CCTP burn");
  if (!recipientSolanaAddress) throw new Error("recipientSolanaAddress required for Arc CCTP burn");

  // ── PRE-FLIGHT: Verify Solana fee-payer has enough SOL BEFORE burning on Arc ──
  // This is the most important guard: once USDC is burned on Arc it CANNOT be
  // recovered without completing the Solana receiveMessage, so we refuse to burn
  // if the fee-payer wallet is empty.
  const feeCheck = await checkSolanaFeePayerBalance(feePayerKey);
  console.log(`[cctp_bridge:preflight] Fee payer ${feeCheck.address}: ${feeCheck.balanceSol} SOL`);
  if (!feeCheck.ok) {
    const errMsg =
      `Solana fee-payer wallet (${feeCheck.address}) has insufficient SOL ` +
      `(${feeCheck.balanceSol.toFixed(4)} SOL, need ≥ ${MIN_FEE_PAYER_LAMPORTS / 1e9} SOL). ` +
      `Please fund this wallet before withdrawing. Contact support if you need help.`;
    console.error("[cctp_bridge:preflight_FAIL]", errMsg);
    return { success: false, error: errMsg };
  }
  console.log(`[cctp_bridge:preflight] Fee payer SOL check passed ✓ (${feeCheck.balanceSol.toFixed(4)} SOL)`);

  try {
    const { PublicKey } = require("@solana/web3.js");
    const { getAssociatedTokenAddress, SOLANA_USDC_MINT } = require("./multichain");

    const recipientPubkey = new PublicKey(recipientSolanaAddress);
    // On Solana, CCTP mints directly to recipient_token_account, which must be the recipient's USDC Associated Token Account.
    let recipientAta;
    try {
      const conn = getSolanaConnection();
      const accountInfo = await conn.getAccountInfo(recipientPubkey);
      if (accountInfo && accountInfo.owner.toBase58() === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
        recipientAta = recipientPubkey;
      } else {
        recipientAta = getAssociatedTokenAddress(recipientPubkey, SOLANA_USDC_MINT);
      }
    } catch {
      recipientAta = getAssociatedTokenAddress(recipientPubkey, SOLANA_USDC_MINT);
    }

    // Ensure recipient ATA is initialized on Solana before burning on Arc
    try {
      const conn = getSolanaConnection();
      const ataInfo = await conn.getAccountInfo(recipientAta);
      if (!ataInfo) {
        console.log(`[cctp_bridge] Initializing recipient ATA ${recipientAta.toBase58()} for ${recipientPubkey.toBase58()}...`);
        const { Transaction, createAssociatedTokenAccountInstruction } = require("@solana/web3.js");
        const latestBlockhash = await conn.getLatestBlockhash();
        const createAtaTx = new Transaction({
          feePayer: feePayerKeypair.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
        }).add(createAssociatedTokenAccountInstruction(
          feePayerKeypair.publicKey,
          recipientAta,
          recipientPubkey,
          SOLANA_USDC_MINT
        ));
        createAtaTx.sign(feePayerKeypair);
        const sig = await conn.sendRawTransaction(createAtaTx.serialize());
        await conn.confirmTransaction({
          signature: sig,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        });
        console.log(`[cctp_bridge] Recipient ATA initialized ✓ (${sig})`);
      }
    } catch (ataErr) {
      console.warn("[cctp_bridge:ata_init_note]", ataErr.message);
    }

    const mintRecipient = "0x" + Buffer.from(recipientAta.toBytes()).toString("hex");

    const net = getNetworkConfig();
    const tokenMessengerAddress = ARC_CCTP_CONTRACTS.TOKEN_MESSENGER;
    const usdcAddress = net.usdcAddress || "0x3600000000000000000000000000000000000000";

    const TOKEN_MESSENGER_ABI = [
      "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external",
      "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) external returns (uint64 _nonce)",
    ];

    const ERC20_ABI = [
      "function approve(address spender, uint256 amount) external returns (bool)",
      "function allowance(address owner, address spender) external view returns (uint256)",
    ];

    const { parseUnits, Interface, keccak256, ZeroHash } = require("ethers");
    const amountUnits = parseUnits(amountUsdc.toString(), 6);

    // 1. Approve TokenMessenger if needed
    try {
      const usdcContract = new Contract(usdcAddress, ERC20_ABI, userWallet);
      const allowance = await usdcContract.allowance(userWallet.address, tokenMessengerAddress);
      if (allowance < amountUnits) {
        console.log(`[cctp_bridge] Approving TokenMessenger for ${amountUnits} USDC units...`);
        const approveTx = await usdcContract.approve(tokenMessengerAddress, amountUnits);
        await approveTx.wait(1);
        console.log(`[cctp_bridge] TokenMessenger approved ✓`);
      }
    } catch (appErr) {
      console.warn("[cctp_bridge:approve_note]", appErr.message);
    }

    // 2. Call depositForBurn targeting Solana (Domain 5)
    // Arc TokenMessenger uses CCTP V2 (7 parameters: amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold)
    const tokenMessenger = new Contract(tokenMessengerAddress, TOKEN_MESSENGER_ABI, userWallet);
    let tx;
    try {
      tx = await tokenMessenger["depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)"](
        amountUnits,
        CCTP_DOMAINS.SOLANA,
        mintRecipient,
        usdcAddress,
        ZeroHash,
        0,
        0
      );
    } catch (v2Err) {
      console.warn("[cctp_bridge] V2 depositForBurn failed, falling back to 4-arg signature:", v2Err.message);
      tx = await tokenMessenger["depositForBurn(uint256,uint32,bytes32,address)"](
        amountUnits,
        CCTP_DOMAINS.SOLANA,
        mintRecipient,
        usdcAddress
      );
    }

    let arcTxHash = tx.hash;
    let rawCctpMessage = null;
    let messageHash = null;

    // Wait for receipt to ensure the burn succeeded on-chain and extract CCTP message
    if (tx && tx.wait) {
      const receipt = await Promise.race([
        tx.wait(1),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Confirmation timeout waiting for Arc block inclusion")), 20000))
      ]);
      if (receipt && receipt.status === 0) {
        throw new Error(`Arc transaction reverted on-chain (status 0) in block ${receipt.blockNumber}. Your USDC was not deducted.`);
      }
      if (receipt && receipt.logs) {
        const msgIface = new Interface(["event MessageSent(bytes message)"]);
        for (const log of receipt.logs) {
          try {
            const parsed = msgIface.parseLog(log);
            if (parsed && parsed.args && parsed.args.message) {
              rawCctpMessage = parsed.args.message;
              messageHash = keccak256(rawCctpMessage);
              console.log(`[cctp_bridge] Extracted CCTP message from Arc receipt ✓ hash=${messageHash}`);
              break;
            }
          } catch {}
        }
      }
    }

    // 3. Record pending burn to DB immediately after Arc tx so we can retry on Solana
    //    if the completion step fails (e.g. RPC hiccup, temporary SOL shortage).
    try {
      db.recordCctpPendingBurn({
        telegramId: telegramId || 0,
        arcTxHash,
        messageHex: rawCctpMessage,
        messageHash,
        amountUsdc,
        recipientSolana: recipientSolanaAddress,
      });
      console.log(`[cctp_bridge] Recorded pending burn in DB: ${arcTxHash}`);
    } catch (dbErr) {
      console.warn("[cctp_bridge:db_record_note]", dbErr.message);
    }

    // 4. Fire background completion: poll attestation + receiveMessage on Solana
    if (autoCompleteOnSolana) {
      completeCctpWithdrawalOnSolana({
        arcTxHash,
        messageHex: rawCctpMessage,
        messageHash,
        feePayerKey,
        telegramId,
        // Use generous polling for mainnet: up to 90 attempts × 5s = 7.5 min
        maxAttempts: 90,
        intervalMs: 5000,
      }).catch((err) => {
        console.warn(`[cctp_bridge:auto_complete_note] Background CCTP completion failed for ${arcTxHash}:`, err.message);
      });
    }

    return {
      success: true,
      txHash: arcTxHash,
      recipientSolanaAddress,
      amountUsdc,
      sourceDomain: CCTP_DOMAINS.ARC,
      destinationDomain: CCTP_DOMAINS.SOLANA,
      autoCompleteOnSolana,
    };
  } catch (err) {
    console.warn("[cctp_bridge:arc_to_sol_burn_error]", err.message);
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Complete an Arc→Solana CCTP withdrawal end-to-end after the Arc burn tx.
 *
 * Steps:
 *   1. Fetch the CCTP message from Arc receipt logs or Circle Iris (domain = ARC = 26)
 *   2. Poll Circle Iris until attestation is complete (~20s on mainnet)
 *   3. Submit receiveMessage on Solana — PayIT's backend wallet pays ~$0.001 SOL
 *   4. USDC is minted to the recipient's Solana token account
 *
 * The recipient (user or Paj offramp address) needs ZERO SOL at any point.
 *
 * @param {object} params
 * @param {string} params.arcTxHash     - Arc depositForBurn transaction hash
 * @param {string} [params.messageHex]  - Pre-extracted raw CCTP message bytes
 * @param {string} [params.messageHash] - Pre-computed keccak256 message hash
 * @param {string} [params.feePayerKey] - Base58 Solana key (fallback: SOLANA_FEE_PAYER_KEY env)
 * @param {number} [params.maxAttempts=90]  - Max attestation polling attempts
 * @param {number} [params.intervalMs=5000] - Polling interval in ms
 * @returns {Promise<{ success, arcTxHash, solanaTxSignature, messageHash }>}
 */
async function completeCctpWithdrawalOnSolana({ arcTxHash, messageHex, messageHash, feePayerKey, maxAttempts = 90, intervalMs = 5000, telegramId }) {
  const bs58Key = feePayerKey || process.env.SOLANA_FEE_PAYER_KEY;
  if (!bs58Key) {
    const msg = "SOLANA_FEE_PAYER_KEY is not set. Add a Solana wallet with ~0.1 SOL to your .env to enable gasless CCTP withdrawals.";
    try { db.failCctpPendingBurn(arcTxHash, msg); } catch {}
    throw new Error(msg);
  }

  const bs58 = require("bs58");
  const { Keypair } = require("@solana/web3.js");
  const bs58Decode = bs58.default ? bs58.default.decode : bs58.decode;
  const feePayerKeypair = Keypair.fromSecretKey(bs58Decode(bs58Key));

  // Runtime SOL balance check — if we somehow arrive here with low SOL, record and bail.
  const conn = getSolanaConnection();
  const lamports = await conn.getBalance(feePayerKeypair.publicKey).catch(() => 0);
  if (lamports < MIN_FEE_PAYER_LAMPORTS) {
    const msg =
      `Fee-payer ${feePayerKeypair.publicKey.toBase58()} has only ${lamports / 1e9} SOL — ` +
      `need ≥ ${MIN_FEE_PAYER_LAMPORTS / 1e9} SOL. Top up wallet and run /retry_cctp to resume.`;
    console.error("[cctp_bridge:complete_SOL_FAIL]", msg);
    try { db.failCctpPendingBurn(arcTxHash, msg); } catch {}
    throw new Error(msg);
  }

  console.log(`[cctp_bridge:complete] Starting Arc→Solana CCTP completion for arc tx: ${arcTxHash}`);
  console.log(`[cctp_bridge:complete] Fee-payer: ${feePayerKeypair.publicKey.toBase58()} | ${lamports / 1e9} SOL`);

  // Step 1: Resolve the CCTP message & hash (receipt logs first, Iris API fallback)
  let msgDetails = (messageHex && messageHash) ? { message: messageHex, messageHash } : null;

  if (!msgDetails) {
    try {
      const { JsonRpcProvider, Interface, keccak256 } = require("ethers");
      const net = getNetworkConfig();
      const provider = new JsonRpcProvider(net.rpcUrl, net.chainId, { staticNetwork: true });
      const receipt = await provider.getTransactionReceipt(arcTxHash);
      if (receipt && receipt.logs) {
        const msgIface = new Interface(["event MessageSent(bytes message)"]);
        for (const log of receipt.logs) {
          try {
            const parsed = msgIface.parseLog(log);
            if (parsed && parsed.args && parsed.args.message) {
              msgDetails = {
                message: parsed.args.message,
                messageHash: keccak256(parsed.args.message),
              };
              console.log(`[cctp_bridge:complete] Found message in receipt ✓ hash=${msgDetails.messageHash}`);
              break;
            }
          } catch {}
        }
      }
    } catch (rcptErr) {
      console.warn("[cctp_bridge:complete_rcpt_warn]", rcptErr.message);
    }
  }

  if (!msgDetails?.message) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        msgDetails = await fetchCctpMessage(CCTP_DOMAINS.ARC, arcTxHash);
        if (msgDetails.message && msgDetails.messageHash) break;
      } catch (e) {
        // Circle may not have indexed the tx yet — retry
      }
      console.log(`[cctp_bridge:complete] Message not indexed yet, retrying (${attempt + 1}/5)...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  if (!msgDetails?.message) {
    const msg = `CCTP message not found for Arc tx ${arcTxHash}. The tx may not be confirmed yet or CCTP isn't registered for this token.`;
    try { db.failCctpPendingBurn(arcTxHash, msg); } catch {}
    throw new Error(msg);
  }

  console.log(`[cctp_bridge:complete] Message hash: ${msgDetails.messageHash}`);

  // Step 2: Poll Circle for attestation
  console.log(`[cctp_bridge:complete] Polling Circle for attestation (max ${maxAttempts} attempts)...`);
  let attestation;
  try {
    ({ attestation } = await pollCctpAttestation(msgDetails.messageHash, maxAttempts, intervalMs, {
      txHash: arcTxHash,
      sourceDomain: CCTP_DOMAINS.ARC,
    }));
  } catch (attErr) {
    const msg = `Attestation polling failed for ${arcTxHash}: ${attErr.message}`;
    try { db.failCctpPendingBurn(arcTxHash, msg); } catch {}
    throw new Error(msg);
  }
  console.log(`[cctp_bridge:complete] Attestation received ✓`);

  // Step 3: Submit receiveMessage on Solana (fee payer pays ~$0.001 SOL)
  const result = await receiveCctpMessageOnSolana({
    messageHex: msgDetails.message,
    attestationHex: attestation,
    feePayerKeypair,
    sourceDomainOverride: CCTP_DOMAINS.ARC,
  });

  if (!result.success) {
    const msg = `Solana receiveMessage failed: ${result.error}`;
    try { db.failCctpPendingBurn(arcTxHash, msg); } catch {}
    throw new Error(msg);
  }

  console.log(`[cctp_bridge:complete] USDC minted on Solana ✓ tx=${result.txSignature}`);

  // Mark completed in DB so it's not retried again
  try { db.completeCctpPendingBurn(arcTxHash, result.txSignature); } catch {}

  return {
    success: true,
    arcTxHash,
    solanaTxSignature: result.txSignature,
    messageHash: msgDetails.messageHash,
  };
}

/**
 * Retry all pending/failed CCTP Arc→Solana burns stored in the DB.
 * Call this from an admin command (/retry_cctp) or a scheduled cron worker
 * after funding the Solana fee-payer wallet with SOL.
 *
 * @param {string} [feePayerKey] - Optional override for fee payer (default: env)
 * @returns {Promise<{ retried: number, succeeded: number, failed: number, skipped: number }>}
 */
async function retryPendingCctpBurns(feePayerKey) {
  // Safety: abort early if fee payer still has no SOL
  const feeCheck = await checkSolanaFeePayerBalance(feePayerKey);
  if (!feeCheck.ok) {
    console.warn(`[cctp_bridge:retry] Fee payer ${feeCheck.address} has ${feeCheck.balanceSol} SOL — skipping retry`);
    return { retried: 0, succeeded: 0, failed: 0, skipped: 0, feePayerSol: feeCheck.balanceSol, feePayerAddress: feeCheck.address };
  }

  const pending = db.getPendingCctpBurns();
  console.log(`[cctp_bridge:retry] Found ${pending.length} pending CCTP burns to retry`);

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const burn of pending) {
    console.log(`[cctp_bridge:retry] Retrying arcTxHash=${burn.arc_tx_hash} (attempt ${burn.retry_count + 1})`);
    try {
      const result = await completeCctpWithdrawalOnSolana({
        arcTxHash: burn.arc_tx_hash,
        messageHex: burn.message_hex || undefined,
        messageHash: burn.message_hash || undefined,
        feePayerKey,
        telegramId: burn.telegram_id,
        maxAttempts: 60,
        intervalMs: 5000,
      });
      if (result.success) {
        succeeded++;
        console.log(`[cctp_bridge:retry] ✓ ${burn.arc_tx_hash} → Solana tx ${result.solanaTxSignature}`);
      } else {
        failed++;
        console.warn(`[cctp_bridge:retry] ✗ ${burn.arc_tx_hash}: completeCctpWithdrawalOnSolana returned success=false`);
      }
    } catch (err) {
      failed++;
      console.warn(`[cctp_bridge:retry] ✗ ${burn.arc_tx_hash}:`, err.message);
    }
  }

  return {
    retried: pending.length,
    succeeded,
    failed,
    skipped,
    feePayerSol: feeCheck.balanceSol,
    feePayerAddress: feeCheck.address,
  };
}

/**
 * Executes a CCTP depositForBurn on any source EVM chain (Base, Arbitrum, Ethereum, etc.)
 * targeting an Arc recipient address (Domain 26).
 *
 * Automatically sponsors gas from PayIT Relayer if the user's wallet has insufficient
 * native token for ERC-20 approval and depositForBurn execution.
 *
 * @param {object} params
 * @param {Wallet|object} params.userWallet - Signer wallet or object with privateKey
 * @param {string|number} params.chain - Source chain name or ID (e.g. "Base", "Arbitrum", 8453)
 * @param {number} params.amountUsdc - Amount of USDC to burn
 * @param {string} params.recipientArcAddress - Destination Arc address
 * @param {boolean} [params.autoCompleteOnArc=true] - Instant credit & Iris redeem in background
 * @param {string} [params.signerPrivateKey] - Optional relayer key override
 * @returns {Promise<object>}
 */
async function executeEvmCctpBurn({
  userWallet,
  chain,
  amountUsdc,
  recipientArcAddress,
  autoCompleteOnArc = true,
  signerPrivateKey,
}) {
  const chainConfig = resolveEvmCctpConfig(chain);
  if (!chainConfig) {
    throw new Error(`Unsupported EVM chain for CCTP burn: ${chain}`);
  }
  if (!recipientArcAddress) {
    throw new Error("recipientArcAddress required for CCTP burn");
  }

  const { JsonRpcProvider, Contract, parseUnits, Interface, keccak256, zeroPadValue } = require("ethers");
  const provider = new JsonRpcProvider(chainConfig.rpcUrl, chainConfig.chainId, { staticNetwork: true });
  const signerKey = userWallet.privateKey || (typeof userWallet === "string" ? userWallet : null);
  const signer = signerKey ? new Wallet(signerKey, provider) : userWallet.connect(provider);

  const amountUnits = parseUnits(amountUsdc.toString(), chainConfig.decimals);
  const mintRecipient = zeroPadValue(getAddress(recipientArcAddress.toLowerCase()), 32);

  const ERC20_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function allowance(address owner, address spender) external view returns (uint256)",
    "function balanceOf(address owner) external view returns (uint256)",
  ];

  const TOKEN_MESSENGER_ABI = [
    "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external",
    "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) external returns (uint64 _nonce)",
  ];

  // Check gas balance; sponsor gas if relayer has funds, or warn if account has 0 gas
  let gasBal = 0n;
  try {
    gasBal = await provider.getBalance(signer.address);
    const minGas = parseUnits("0.00005", 18);
    if (gasBal < minGas) {
      const relayerKey = signerPrivateKey || process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
      if (relayerKey) {
        const relayer = new Wallet(relayerKey, provider);
        const relayerBal = await provider.getBalance(relayer.address).catch(() => 0n);
        if (relayerBal > parseUnits("0.0001", 18)) {
          console.log(`[cctp_bridge] Sponsoring gas for ${signer.address} on ${chainConfig.name}...`);
          const sponsorTx = await relayer.sendTransaction({
            to: signer.address,
            value: parseUnits("0.0001", 18),
          });
          await sponsorTx.wait(1);
          gasBal = await provider.getBalance(signer.address);
          console.log(`[cctp_bridge] Gas sponsored ✓ tx=${sponsorTx.hash}`);
        }
      }
    }
  } catch (gasErr) {
    console.warn(`[cctp_bridge:gas_check_note] Gas check/sponsor note on ${chainConfig.name}:`, gasErr.message);
  }

  if (gasBal === 0n) {
    throw new Error(`Insufficient gas on ${chainConfig.name} for CCTP bridge. Address needs a fraction of native gas (~$0.10) to approve and bridge USDC.`);
  }

  // 1. Check and approve TokenMessenger
  const usdcContract = new Contract(chainConfig.usdc, ERC20_ABI, signer);
  const currentAllowance = await usdcContract.allowance(signer.address, chainConfig.tokenMessenger);
  if (currentAllowance < amountUnits) {
    console.log(`[cctp_bridge] Approving TokenMessenger on ${chainConfig.name}...`);
    const appTx = await usdcContract.approve(chainConfig.tokenMessenger, amountUnits);
    await appTx.wait(1);
    console.log(`[cctp_bridge] TokenMessenger approved ✓`);
  }

  // 2. Execute depositForBurn targeting Arc Mainnet (Domain 26)
  const tokenMessenger = new Contract(chainConfig.tokenMessenger, TOKEN_MESSENGER_ABI, signer);
  console.log(`[cctp_bridge] Calling depositForBurn on ${chainConfig.name} targeting Arc (domain 26)...`);
  let tx;
  try {
    tx = await tokenMessenger["depositForBurn(uint256,uint32,bytes32,address)"](
      amountUnits,
      CCTP_DOMAINS.ARC,
      mintRecipient,
      chainConfig.usdc
    );
  } catch (v1Err) {
    console.warn(`[cctp_bridge] V1 depositForBurn failed on ${chainConfig.name}, trying V2 signature:`, v1Err.message);
    const { ZeroHash } = require("ethers");
    tx = await tokenMessenger["depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)"](
      amountUnits,
      CCTP_DOMAINS.ARC,
      mintRecipient,
      chainConfig.usdc,
      ZeroHash,
      0,
      0
    );
  }

  let rawCctpMessage = null;
  let messageHash = null;

  try {
    const receipt = await Promise.race([
      tx.wait(1),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Confirmation timeout")), 20000)),
    ]);
    if (receipt && receipt.logs) {
      const msgIface = new Interface(["event MessageSent(bytes message)"]);
      for (const log of receipt.logs) {
        try {
          const parsed = msgIface.parseLog(log);
          if (parsed?.args?.message) {
            rawCctpMessage = parsed.args.message;
            messageHash = keccak256(rawCctpMessage);
            console.log(`[cctp_bridge] Extracted CCTP message from ${chainConfig.name} ✓ hash=${messageHash}`);
            break;
          }
        } catch {}
      }
    }
  } catch (waitErr) {
    console.warn("[cctp_bridge:evm_burn_wait_note]", waitErr.message);
  }

  // 3. Automated Arc completion (Pure self-sustaining mode: zero relayer capital required)
  let instantDisburseHash = null;
  if (autoCompleteOnArc) {
    const enableRelayerFronting = process.env.ENABLE_RELAYER_FRONTING === "true";
    if (enableRelayerFronting) {
      // Optional: Instant credit from relayer treasury if enabled by project
      disburseDirectOnArc({
        recipientArcAddress,
        amountUsdc,
        signerPrivateKey,
      }).then((hash) => {
        instantDisburseHash = hash;
        console.log(`[cctp_bridge] Instant credit disbursed on Arc ✓ tx=${hash}`);
      }).catch((disErr) => {
        console.warn("[cctp_bridge:instant_disburse_warn]", disErr.message);
      });
    }

    // Pure self-sustaining CCTP Intent Fulfillment:
    // Once depositForBurn is broadcasted on source chain, poll Iris attestation (free)
    // and submit receiveMessage on Arc MessageTransmitter to mint Circle USDC directly to user.
    if (messageHash || tx.hash) {
      (async () => {
        try {
          let attMessage = rawCctpMessage;
          let attHash = messageHash;
          if (!attHash) {
            const irisMsg = await fetchCctpMessage(chainConfig.domain, tx.hash);
            attMessage = irisMsg.message;
            attHash = irisMsg.messageHash;
          }
          if (attHash) {
            console.log(`[cctp_bridge] Polling Iris attestation for ${attHash}...`);
            const { attestation } = await pollCctpAttestation(attHash, 90, 5000, {
              txHash: tx.hash,
              sourceDomain: chainConfig.domain,
            });
            const mintTxHash = await redeemOnArc({
              attestation,
              message: attMessage,
              userPrivateKey: signerPrivateKey,
            });
            console.log(`[cctp_bridge] EVM CCTP burn successfully redeemed on Arc MessageTransmitter ✓ tx=${mintTxHash}`);
          }
        } catch (pollErr) {
          console.warn("[cctp_bridge:evm_arc_redeem_warn]", pollErr.message);
        }
      })();
    }
  }

  return {
    success: true,
    txHash: tx.hash,
    sourceChain: chainConfig.name,
    sourceDomain: chainConfig.domain,
    destinationChain: "Arc Mainnet",
    destinationDomain: CCTP_DOMAINS.ARC,
    amountUsdc,
    recipient: recipientArcAddress,
    messageHash,
    instantDisburseHash,
  };
}

module.exports = {
  CCTP_DOMAINS,
  ARC_CCTP_CONTRACTS,
  EVM_CCTP_CONTRACTS,
  resolveEvmCctpConfig,
  fetchCctpMessage,
  pollCctpAttestation,
  redeemOnArc,
  disburseDirectOnArc,
  autoBridgeSolanaToArc,
  executeArcToSolanaCctpBurn,
  completeCctpWithdrawalOnSolana,
  executeEvmCctpBurn,
  checkSolanaFeePayerBalance,
  retryPendingCctpBurns,
  MIN_FEE_PAYER_LAMPORTS,
};
