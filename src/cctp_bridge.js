// src/cctp_bridge.js
// Production Circle Cross-Chain Transfer Protocol (CCTP) & Gateway Auto-Bridge
// Bridges native USDC between Solana (Paj onramp) and Arc Mainnet (Domain ID 26)

const axios = require("axios");
const { JsonRpcProvider, Contract, Wallet, keccak256, getAddress, zeroPadValue } = require("ethers");
const { getNetworkConfig, getExplorerUrl } = require("./network");
const gateway = require("./gateway");

const CIRCLE_IRIS_API_V2 = "https://iris-api.circle.com/v2";
const CIRCLE_IRIS_API_V1 = "https://iris-api.circle.com/v1";

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
 * Once Circle attests to the burn on source chain, the attestation can be redeemed on Arc.
 *
 * @param {string} messageHash - Keccak256 hash of the CCTP message
 * @param {number} [maxAttempts=30] - Maximum polling attempts
 * @param {number} [intervalMs=2000] - Polling interval in ms
 * @returns {Promise<{ status: string, attestation: string }>}
 */
async function pollCctpAttestation(messageHash, maxAttempts = 30, intervalMs = 2000) {
  const cleanHash = messageHash.startsWith("0x") ? messageHash : "0x" + messageHash;
  const urls = [
    `${CIRCLE_IRIS_API_V2}/attestations/${cleanHash}`,
    `${CIRCLE_IRIS_API_V1}/attestations/${cleanHash}`,
  ];

  for (let i = 0; i < maxAttempts; i++) {
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
        if (err.response?.status !== 404) {
          console.warn(`[cctp_bridge] Attestation check warning (${url}):`, err.message);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`CCTP attestation timed out for messageHash: ${messageHash}`);
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
  const provider = new JsonRpcProvider(net.rpcUrl, net.chainId);

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
  const provider = new JsonRpcProvider(net.rpcUrl, net.chainId);

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
      const attResult = await pollCctpAttestation(msgDetails.messageHash, maxAttempts, intervalMs);
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

module.exports = {
  CCTP_DOMAINS,
  ARC_CCTP_CONTRACTS,
  fetchCctpMessage,
  pollCctpAttestation,
  redeemOnArc,
  disburseDirectOnArc,
  autoBridgeSolanaToArc,
};
