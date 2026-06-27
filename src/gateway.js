// src/gateway.js
// Circle Gateway — cross-chain USDC inflow to Arc Testnet
//
// HOW IT ACTUALLY WORKS (not a single deposit address):
//   1. User approves the Gateway Wallet contract to spend their USDC on source chain
//   2. User calls deposit() on the Gateway Wallet contract — NOT a plain transfer
//   3. After source chain finality, user signs a burn intent (EIP-712)
//   4. Bot submits intent to Gateway API → gets attestation
//   5. Bot calls gatewayMint() on Arc with the attestation → USDC appears on Arc
//
// ⚠️  Plain ERC-20 transfers to the Gateway Wallet contract = permanent loss of funds
//
// Testnet API: https://gateway-api-testnet.circle.com/v1
// Docs: https://developers.circle.com/gateway

const axios = require("axios");
const { Contract, Wallet, JsonRpcProvider, keccak256, AbiCoder, toUtf8Bytes, solidityPackedKeccak256 } = require("ethers");

const GATEWAY_API_BASE = process.env.GATEWAY_API_URL || "https://gateway-api-testnet.circle.com/v1";

// ── Confirmed contract addresses (same on all supported chains) ────────────────
const GATEWAY_WALLET_ADDRESS  = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const GATEWAY_MINTER_ADDRESS  = "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B";

// ── USDC contract addresses per testnet chain ──────────────────────────────────
const USDC_ADDRESSES = {
  "Ethereum Sepolia": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  "Base Sepolia":     "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "Avalanche Fuji":   "0x5425890298aed601595a70ab815c96711a31bc65",
};

// ── CCTP domain IDs ────────────────────────────────────────────────────────────
const DOMAIN_IDS = {
  "Ethereum Sepolia": 0,
  "Avalanche Fuji":   1,
  "Base Sepolia":     6,
  "Arc Testnet":      7, // destination domain
};

// ── RPC endpoints for each source chain ───────────────────────────────────────
const CHAIN_RPCS = {
  "Ethereum Sepolia": "https://rpc.sepolia.org",
  "Base Sepolia":     "https://sepolia.base.org",
  "Avalanche Fuji":   "https://api.avax-test.network/ext/bc/C/rpc",
};

const SUPPORTED_CHAINS = [
  { name: "Ethereum Sepolia", chainId: 11155111, symbol: "ETH",  domain: 0, explorer: "https://sepolia.etherscan.io/tx/" },
  { name: "Base Sepolia",     chainId: 84532,    symbol: "BASE", domain: 6, explorer: "https://sepolia.basescan.org/tx/" },
  { name: "Avalanche Fuji",   chainId: 43113,    symbol: "AVAX", domain: 1, explorer: "https://testnet.snowtrace.io/tx/" },
];

// ── ABIs (minimal) ─────────────────────────────────────────────────────────────
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
];

const GATEWAY_WALLET_ABI = [
  // Must use this — plain transfer() loses funds permanently
  "function deposit(address token, uint256 amount) external",
  "function balanceOf(address owner, uint32 domain) view returns (uint256)",
];

const GATEWAY_MINTER_ABI = [
  "function gatewayMint(bytes calldata attestation, bytes calldata signature) external",
];

// ── Gateway API helpers ────────────────────────────────────────────────────────

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
 * Check user's available Gateway balance on a domain (post-finality deposits).
 * domainId: 0=Sepolia, 1=Fuji, 6=Base Sepolia
 */
async function getGatewayBalance(depositorAddress, domainId) {
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
 * Check pending deposits (submitted but not yet finalized on source chain).
 */
async function getPendingDeposits(depositorAddress) {
  try {
    const res = await axios.get(`${GATEWAY_API_BASE}/deposits`, {
      params: { depositor: depositorAddress },
    });
    return res.data;
  } catch (err) {
    console.error("[gateway] getPendingDeposits error:", err.message);
    return null;
  }
}

/**
 * Submit burn intent to Gateway API → returns attestation for minting on Arc.
 * burnIntentRequest: { burnIntent, signature } constructed and signed by user wallet.
 */
async function submitTransfer(burnIntentRequests) {
  try {
    const res = await axios.post(`${GATEWAY_API_BASE}/transfer`, burnIntentRequests, {
      headers: { "Content-Type": "application/json" },
    });
    return res.data;
  } catch (err) {
    console.error("[gateway] submitTransfer error:", err?.response?.data || err.message);
    return null;
  }
}

// ── Main bot-facing helpers ────────────────────────────────────────────────────

/**
 * Returns structured deposit instructions for the bot's Gateway screen.
 * The user must call deposit() on the Gateway Wallet contract — NOT a plain send.
 */
async function getDepositInfo(arcAddress) {
  const info = await getGatewayInfo();
  const apiOnline = !!info;

  return {
    apiOnline,
    arcAddress,
    gatewayWalletAddress: GATEWAY_WALLET_ADDRESS,
    gatewayMinterAddress: GATEWAY_MINTER_ADDRESS,
    chains: SUPPORTED_CHAINS,
    usdcAddresses: USDC_ADDRESSES,
    // Step-by-step instructions for the bot message
    steps: [
      `*Step 1 — Get testnet USDC*\nVisit https://faucet.circle.com, select your chain and request USDC.`,
      `*Step 2 — Approve*\nIn your web3 wallet (MetaMask etc), approve the Gateway Wallet contract to spend your USDC:\nContract: \`${GATEWAY_WALLET_ADDRESS}\``,
      `*Step 3 — Deposit (NOT a plain send)*\nCall \`deposit(usdcAddress, amount)\` on the Gateway Wallet contract.\n⚠️ A plain USDC transfer to this address permanently loses your funds.`,
      `*Step 4 — Wait for finality*\nSepolia: ~12 mins · Base Sepolia: ~2 mins · Avalanche Fuji: instant`,
      `*Step 5 — Transfer to Arc*\nOnce finalized, tap *Transfer to Arc* and sign the burn intent. Your USDC will appear on Arc in <500ms.`,
    ],
  };
}

/**
 * Check all gateway balances for a user address across supported chains.
 * Returns a summary of available + pending balances.
 */
async function getTransferStatus(depositorAddress) {
  const results = {};
  for (const chain of SUPPORTED_CHAINS) {
    const available = await getGatewayBalance(depositorAddress, chain.domain);
    if (available) results[chain.name] = { available };
  }
  const pending = await getPendingDeposits(depositorAddress);
  if (pending) results.pending = pending;
  return Object.keys(results).length ? results : null;
}

module.exports = {
  getDepositInfo,
  getTransferStatus,
  getGatewayInfo,
  getGatewayBalance,
  getPendingDeposits,
  submitTransfer,
  SUPPORTED_CHAINS,
  GATEWAY_WALLET_ADDRESS,
  GATEWAY_MINTER_ADDRESS,
  USDC_ADDRESSES,
  DOMAIN_IDS,
  GATEWAY_WALLET_ABI,
  GATEWAY_MINTER_ABI,
  ERC20_ABI,
};