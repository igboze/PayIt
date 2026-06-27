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
// FIX 1: Added executeDeposit() which actually runs the approve + deposit() on-chain.
// FIX 2: CHAIN_RPCS is now exported so wallet.js and other modules can use it.
// FIX 3: Source-chain USDC decimals are correctly 6 (not 18).
//
// Testnet API: https://gateway-api-testnet.circle.com/v1
// Docs: https://developers.circle.com/gateway

const axios = require("axios");
const { Contract, Wallet, JsonRpcProvider, parseUnits, formatUnits } = require("ethers");

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
// FIX 2: Exported so wallet.js can use these for balance checks
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
 * FIX 1: Actually execute the approve + deposit on-chain for a given source chain.
 *
 * This function does what the docs describe — it's what the bot must call when
 * the user initiates a cross-chain deposit from within PayIT (i.e. the user has
 * their private key stored in the bot's DB and triggers "Add from Abroad").
 *
 * NOTE: Source-chain USDC is always 6 decimals — NOT 18 like Arc's native USDC.
 *
 * @param {string} privateKey       - User's private key (decrypted from DB)
 * @param {string} sourceChainName  - e.g. "Ethereum Sepolia"
 * @param {string|number} amountUsdc - Human-readable USDC amount, e.g. "25.00"
 * @returns {{ approveTxHash: string, depositTxHash: string }}
 */
async function executeDeposit(privateKey, sourceChainName, amountUsdc) {
  const chain = SUPPORTED_CHAINS.find(c => c.name === sourceChainName);
  if (!chain) throw new Error(`Unsupported chain: ${sourceChainName}`);

  const rpcUrl      = CHAIN_RPCS[sourceChainName];
  const usdcAddress = USDC_ADDRESSES[sourceChainName];
  if (!rpcUrl || !usdcAddress) {
    throw new Error(`Missing RPC or USDC address config for: ${sourceChainName}`);
  }

  const provider = new JsonRpcProvider(rpcUrl, chain.chainId);
  const signer   = new Wallet(privateKey, provider);

  // Source chains use 6 decimals (NOT 18 — that's only Arc's native USDC)
  const amountBN = parseUnits(amountUsdc.toString(), 6);

  const usdc    = new Contract(usdcAddress, ERC20_ABI, signer);
  const gateway = new Contract(GATEWAY_WALLET_ADDRESS, GATEWAY_WALLET_ABI, signer);

  // Step 1: Approve Gateway Wallet to spend user's USDC
  console.log(`[gateway] Approving ${amountUsdc} USDC on ${sourceChainName}...`);
  const approveTx = await usdc.approve(GATEWAY_WALLET_ADDRESS, amountBN);
  const approveReceipt = await approveTx.wait();
  console.log(`[gateway] Approve confirmed: ${approveReceipt.hash}`);

  // Step 2: Call deposit() — NOT a plain transfer
  console.log(`[gateway] Depositing ${amountUsdc} USDC via Gateway Wallet contract...`);
  const depositTx = await gateway.deposit(usdcAddress, amountBN);
  const depositReceipt = await depositTx.wait();
  console.log(`[gateway] Deposit confirmed: ${depositReceipt.hash}`);

  return {
    approveTxHash: approveReceipt.hash,
    depositTxHash: depositReceipt.hash,
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
  executeDeposit,           // FIX 1: new export
  getGatewayInfo,
  getGatewayBalance,
  getPendingDeposits,
  submitTransfer,
  SUPPORTED_CHAINS,
  CHAIN_RPCS,               // FIX 2: new export
  GATEWAY_WALLET_ADDRESS,
  GATEWAY_MINTER_ADDRESS,
  USDC_ADDRESSES,
  DOMAIN_IDS,
  GATEWAY_WALLET_ABI,
  GATEWAY_MINTER_ABI,
  ERC20_ABI,
};