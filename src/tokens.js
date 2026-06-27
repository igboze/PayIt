// src/tokens.js
// Multi-token support: EURC (ERC-20) on Arc Testnet
// EURC contract: 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a (confirmed from Arc docs)
// USDC ERC-20 interface: 0x3600000000000000000000000000000000000000 (optional, native is default)

const { JsonRpcProvider, Contract, parseUnits, formatUnits } = require("ethers");

const ARC_RPC   = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const CHAIN_ID  = 5042002;

// Confirmed Arc Testnet contract addresses
const EURC_ADDRESS = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const USDC_ERC20_ADDRESS = "0x3600000000000000000000000000000000000000"; // optional ERC-20 interface

// Minimal ERC-20 ABI — only what we need
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

let _provider = null;
function getProvider() {
  if (!_provider) _provider = new JsonRpcProvider(ARC_RPC, CHAIN_ID);
  return _provider;
}

// ─── EURC ─────────────────────────────────────────────────────────────────────

function getEurcContract(signerOrProvider) {
  return new Contract(EURC_ADDRESS, ERC20_ABI, signerOrProvider || getProvider());
}

/**
 * Get EURC balance in 18-decimal "micro" representation (same convention as native USDC).
 * EURC on Arc is ERC-20 with 6 decimals — we normalise to 18 for display consistency.
 */
async function getEurcBalance(address) {
  try {
    const contract = getEurcContract();
    const raw = await contract.balanceOf(address);      // BigInt, 6 decimals
    const decimals = await contract.decimals();
    // Normalise to 18 decimals for consistent formatting with native USDC
    const normalised = raw * BigInt(10 ** (18 - Number(decimals)));
    return normalised;
  } catch (err) {
    console.error("[tokens] EURC balance error:", err.message);
    return BigInt(0);
  }
}

/**
 * Send EURC from a signer wallet to a recipient.
 * amountMicro is in 18-decimal normalised format — we convert back to 6 decimals before sending.
 */
async function sendEurc(signerWallet, toAddress, amountMicro) {
  const contract = getEurcContract(signerWallet);
  const decimals = Number(await contract.decimals()); // should be 6
  // Convert 18-decimal input back to token decimals
  const rawAmount = amountMicro / BigInt(10 ** (18 - decimals));
  const tx = await contract.transfer(toAddress, rawAmount);
  const receipt = await tx.wait();
  return receipt.hash;
}

// ─── USDC ERC-20 (optional interface) ────────────────────────────────────────
// For use cases that need ERC-20 methods (approve, transferFrom) on native USDC.
// Normal sends still use native transfer in wallet.js.

function getUsdcErc20Contract(signerOrProvider) {
  return new Contract(USDC_ERC20_ADDRESS, ERC20_ABI, signerOrProvider || getProvider());
}

async function approveUsdcSpend(signerWallet, spenderAddress, amountMicro) {
  const contract = getUsdcErc20Contract(signerWallet);
  // USDC ERC-20 on Arc shares balance with native — decimals match native (18)
  const tx = await contract.approve(spenderAddress, amountMicro);
  const receipt = await tx.wait();
  return receipt.hash;
}

// ─── Token info ───────────────────────────────────────────────────────────────

const SUPPORTED_TOKENS = {
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    address: USDC_ERC20_ADDRESS,
    nativeOnArc: true,  // primary balance is native, not ERC-20
    decimals: 18,       // native uses 18 decimals on Arc testnet
    faucet: "https://faucet.circle.com (select Arc Testnet, USDC)",
  },
  EURC: {
    symbol: "EURC",
    name: "Euro Coin",
    address: EURC_ADDRESS,
    nativeOnArc: false,
    decimals: 6,
    faucet: "https://faucet.circle.com (select Arc Testnet, EURC)",
  },
};

module.exports = {
  EURC_ADDRESS,
  USDC_ERC20_ADDRESS,
  SUPPORTED_TOKENS,
  getEurcBalance,
  sendEurc,
  getUsdcErc20Contract,
  approveUsdcSpend,
};
