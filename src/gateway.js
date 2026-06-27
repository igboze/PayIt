// src/gateway.js
// Circle Gateway — cross-chain USDC inflow to Arc Testnet
// Uses the real Circle Gateway testnet API and smart contracts.
// Docs: https://developers.circle.com/gateway
//
// How it works:
//   1. User deposits USDC into the Gateway Wallet contract on a source chain (e.g. Sepolia)
//   2. They call /transfer on the Gateway API to get an attestation
//   3. The Gateway Minter contract on Arc mints equivalent USDC to their address
//
// Required .env:
//   GATEWAY_API_URL (optional, defaults to testnet below)
//   No API key needed — Gateway API is unauthenticated for reads/transfers

const axios = require("axios");

// ── Testnet API & contract addresses (confirmed from Circle docs) ──────────────
const GATEWAY_API_BASE = process.env.GATEWAY_API_URL || "https://gateway-api-testnet.circle.com/v1";

// Gateway Wallet contract — same address on ALL supported chains
const GATEWAY_WALLET_ADDRESS = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

// Gateway Minter contract — used on the destination chain (Arc) to mint USDC
const GATEWAY_MINTER_ADDRESS = "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B";

// USDC contract addresses on each supported testnet source chain
const USDC_ADDRESSES = {
  "Ethereum Sepolia":  "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  "Base Sepolia":      "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "Avalanche Fuji":    "0x5425890298aed601595a70ab815c96711a31bc65",
};

// CCTP domain IDs (used in burn intent construction)
const DOMAIN_IDS = {
  "Ethereum Sepolia": 0,
  "Avalanche Fuji":   1,
  "Base Sepolia":     6,
};

// Chain IDs for user reference
const SUPPORTED_CHAINS = [
  { name: "Ethereum Sepolia", chainId: 11155111, symbol: "ETH",  domain: 0 },
  { name: "Base Sepolia",     chainId: 84532,    symbol: "BASE", domain: 6 },
  { name: "Avalanche Fuji",   chainId: 43113,    symbol: "AVAX", domain: 1 },
];

// ── Minimal ABIs needed ────────────────────────────────────────────────────────

const GATEWAY_WALLET_ABI = [
  // Deposit USDC into the Gateway unified balance
  "function deposit(address token, uint256 amount) external",
  // Check unified balance for an address across domains
  "function balanceOf(address owner, uint32 domain) view returns (uint256)",
];

const ERC20_APPROVE_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const GATEWAY_MINTER_ABI = [
  // Mint USDC on destination chain using attestation from Gateway API
  "function gatewayMint(bytes calldata attestation, bytes calldata signature) external",
];

// ── Gateway API helpers ────────────────────────────────────────────────────────

/**
 * Get supported chains and contract addresses from the Gateway API.
 * Useful for verifying the API is reachable and getting live contract addresses.
 */
async function getGatewayInfo() {
  try {
    const res = await axios.get(`${GATEWAY_API_BASE}/info`);
    return res.data;
  } catch (err) {
    console.error("[gateway] getGatewayInfo error:", err.message);
    return null;
  }
}

/**
 * Check the unified Gateway balance for an address on a given domain.
 * domainId: 0 = Ethereum/Sepolia, 1 = Avalanche/Fuji, 6 = Base/Base Sepolia
 */
async function getGatewayBalance(depositorAddress, domainId = 0) {
  try {
    const res = await axios.get(`${GATEWAY_API_BASE}/balances`, {
      params: { depositor: depositorAddress, domains: domainId },
    });
    return res.data;
  } catch (err) {
    console.error("[gateway] getGatewayBalance error:", err.message);
    return null;
  }
}

/**
 * Submit burn intents and get attestation for minting on Arc.
 * burnIntents: array of signed burn intent objects (constructed on-chain by user's wallet)
 * Returns attestation data needed to call gatewayMint on Arc.
 */
async function submitTransfer(burnIntents) {
  try {
    const res = await axios.post(`${GATEWAY_API_BASE}/transfer`, burnIntents, {
      headers: { "Content-Type": "application/json" },
    });
    return res.data;
  } catch (err) {
    console.error("[gateway] submitTransfer error:", err.message);
    return null;
  }
}

// ── Main bot-facing helper ─────────────────────────────────────────────────────

/**
 * Returns deposit instructions for the bot's 🌉 Gateway screen.
 * This tells the user exactly what to do to fund their Arc wallet from a testnet chain.
 */
async function getDepositInfo(arcAddress) {
  // Verify API is reachable and get live info
  const info = await getGatewayInfo();
  const apiStatus = info ? "✅ Gateway API online" : "⚠️ Gateway API unreachable — instructions below still valid";

  const chainLines = SUPPORTED_CHAINS.map(
    (c) => `• ${c.name} — USDC: \`${USDC_ADDRESSES[c.name]}\``
  ).join("\n");

  return {
    instructions:
      `${apiStatus}\n\n` +
      `To fund your Arc wallet from a testnet chain:\n\n` +
      `*Step 1 — Approve*\n` +
      `On your source chain, approve the Gateway Wallet contract to spend your USDC:\n` +
      `Gateway Wallet: \`${GATEWAY_WALLET_ADDRESS}\`\n\n` +
      `*Step 2 — Deposit*\n` +
      `Call \`deposit(usdcAddress, amount)\` on the Gateway Wallet contract.\n\n` +
      `*Step 3 — Transfer*\n` +
      `After deposit confirms, your USDC is minted on Arc automatically.\n\n` +
      `*Supported source chains & USDC addresses:*\n${chainLines}\n\n` +
      `Your Arc destination address:\n\`${arcAddress}\`\n\n` +
      `Fee: ~0.05% · Settlement: <500ms after source confirmation`,
    address: arcAddress,
    gatewayWallet: GATEWAY_WALLET_ADDRESS,
    gatewayMinter: GATEWAY_MINTER_ADDRESS,
    chains: SUPPORTED_CHAINS,
    usdcAddresses: USDC_ADDRESSES,
  };
}

/**
 * Check transfer status — checks the user's Gateway balance on all supported domains.
 */
async function getTransferStatus(depositorAddress) {
  const results = {};
  for (const chain of SUPPORTED_CHAINS) {
    const bal = await getGatewayBalance(depositorAddress, chain.domain);
    if (bal) results[chain.name] = bal;
  }
  return Object.keys(results).length ? results : null;
}

module.exports = {
  getDepositInfo,
  getTransferStatus,
  getGatewayInfo,
  getGatewayBalance,
  submitTransfer,
  SUPPORTED_CHAINS,
  GATEWAY_WALLET_ADDRESS,
  GATEWAY_MINTER_ADDRESS,
  USDC_ADDRESSES,
  DOMAIN_IDS,
  GATEWAY_WALLET_ABI,
  GATEWAY_MINTER_ABI,
  ERC20_APPROVE_ABI,
};