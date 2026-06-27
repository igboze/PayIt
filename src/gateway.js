// src/gateway.js
// Circle Gateway — cross-chain USDC inflow to Arc
// Gateway lets users bring USDC from Ethereum, Base, Polygon, Arbitrum, Avalanche, OP Mainnet
// without manual bridging. Sub-500ms settlement. ~0.05% fee.
// Docs: https://docs.arc.io/arc/gateway
// Set GATEWAY_API_KEY in .env for full status tracking (optional — deposit address works without it)

const axios = require("axios");

const GATEWAY_API_BASE = process.env.GATEWAY_API_URL || "https://api.gateway.circle.com";
const GATEWAY_API_KEY  = process.env.GATEWAY_API_KEY || "";

// Supported source chains (as of Arc testnet — mainnet will add more)
const SUPPORTED_CHAINS = [
  { name: "Ethereum",   chainId: 1,     symbol: "ETH"  },
  { name: "Base",       chainId: 8453,  symbol: "BASE" },
  { name: "Polygon",    chainId: 137,   symbol: "MATIC"},
  { name: "Arbitrum",   chainId: 42161, symbol: "ARB"  },
  { name: "Avalanche",  chainId: 43114, symbol: "AVAX" },
  { name: "OP Mainnet", chainId: 10,    symbol: "OP"   },
];

/**
 * Get Gateway deposit instructions for an Arc wallet address.
 * With API key: fetches a Gateway-managed inbound address and transfer details.
 * Without API key: returns manual instructions (the Arc address IS the deposit target).
 */
async function getDepositInfo(arcAddress) {
  if (!GATEWAY_API_KEY) {
    return {
      instructions:
        `Send USDC directly to your Arc address from any supported chain.\n` +
        `Gateway auto-converts and settles on Arc within ~500ms.\n\n` +
        `Supported chains: Ethereum · Base · Polygon · Arbitrum · Avalanche · OP Mainnet\n\n` +
        `Note: Set GATEWAY_API_KEY in .env for full transfer status tracking.`,
      address: arcAddress,
      chains: SUPPORTED_CHAINS,
    };
  }

  // With API key: create a Gateway deposit session
  try {
    const response = await axios.post(
      `${GATEWAY_API_BASE}/v1/deposits`,
      { destinationAddress: arcAddress, destinationChain: "ARC-TESTNET" },
      { headers: { Authorization: `Bearer ${GATEWAY_API_KEY}`, "Content-Type": "application/json" } }
    );
    const { depositAddress, sessionId, estimatedFee } = response.data;
    return {
      instructions:
        `Gateway session created. Send USDC from any supported chain to:\n\n` +
        `${depositAddress}\n\n` +
        `Session ID: ${sessionId}\n` +
        `Estimated fee: ${estimatedFee || "~0.05%"}\n` +
        `Funds arrive on Arc in under 500ms after source confirmation.`,
      address: depositAddress || arcAddress,
      sessionId,
      chains: SUPPORTED_CHAINS,
    };
  } catch (err) {
    // Graceful fallback if Gateway API call fails
    console.error("[gateway] API error:", err.message);
    return {
      instructions:
        `Send USDC from any supported chain to your Arc address above.\n` +
        `Gateway settles within ~500ms after source confirmation.\n` +
        `Fee: ~0.05%.\n\n` +
        `Supported: Ethereum · Base · Polygon · Arbitrum · Avalanche · OP Mainnet`,
      address: arcAddress,
      chains: SUPPORTED_CHAINS,
    };
  }
}

/**
 * Check status of a Gateway transfer by session ID.
 * Returns { status, txHash, amount } or null if unavailable.
 */
async function getTransferStatus(sessionId) {
  if (!GATEWAY_API_KEY || !sessionId) return null;
  try {
    const response = await axios.get(
      `${GATEWAY_API_BASE}/v1/deposits/${sessionId}`,
      { headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` } }
    );
    return response.data;
  } catch (err) {
    console.error("[gateway] Status check error:", err.message);
    return null;
  }
}

module.exports = { getDepositInfo, getTransferStatus, SUPPORTED_CHAINS };
