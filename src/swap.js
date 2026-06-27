// src/swap.js
// Uniswap-V2-style swap logic for Arc testnet
// SWAP_ROUTER_ADDRESS must be set in .env with a verified Arc DEX address before this is live.
// Use: arc-canteen context sync → check ~/.arc-canteen/context/ for verified addresses.

const { Contract, parseUnits, formatUnits } = require("ethers");
const walletLib = require("./wallet");
const tokens    = require("./tokens");

const ROUTER_ADDRESS = process.env.SWAP_ROUTER_ADDRESS || "";

// Minimal Uniswap V2 Router ABI
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
];

// Slippage: 0.5% default
const SLIPPAGE_BPS = 50;

/**
 * Get a quote for swapping tokenIn → tokenOut.
 * Returns { amountOut, amountOutMin } in raw token units.
 */
async function getSwapQuote(signerOrProvider, tokenInAddress, tokenOutAddress, amountInMicro) {
  if (!ROUTER_ADDRESS) throw new Error("SWAP_ROUTER_ADDRESS not set — swap not live yet.");
  const router = new Contract(ROUTER_ADDRESS, ROUTER_ABI, signerOrProvider);
  const path   = [tokenInAddress, tokenOutAddress];
  const amounts = await router.getAmountsOut(amountInMicro, path);
  const amountOut    = amounts[1];
  const amountOutMin = amountOut * BigInt(10000 - SLIPPAGE_BPS) / BigInt(10000);
  return { amountOut, amountOutMin };
}

/**
 * Execute a swap: USDC → EURC or EURC → USDC.
 * Requires signer wallet (decrypted with PIN in bot.js before calling).
 */
async function executeSwap(signerWallet, tokenIn, tokenOut, amountInMicro) {
  if (!ROUTER_ADDRESS) throw new Error("SWAP_ROUTER_ADDRESS not set — swap not live yet.");

  const tokenInAddress  = tokenIn  === "EURC" ? tokens.EURC_ADDRESS : tokens.USDC_ERC20_ADDRESS;
  const tokenOutAddress = tokenOut === "EURC" ? tokens.EURC_ADDRESS : tokens.USDC_ERC20_ADDRESS;

  // Approve router to spend tokenIn
  await tokens.approveUsdcSpend(signerWallet, ROUTER_ADDRESS, amountInMicro);

  const { amountOutMin } = await getSwapQuote(signerWallet, tokenInAddress, tokenOutAddress, amountInMicro);

  const router   = new Contract(ROUTER_ADDRESS, ROUTER_ABI, signerWallet);
  const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min deadline
  const tx = await router.swapExactTokensForTokens(
    amountInMicro, amountOutMin, [tokenInAddress, tokenOutAddress],
    await signerWallet.getAddress(), deadline
  );
  const receipt = await tx.wait();
  return { txHash: receipt.hash, amountOutMin: formatUnits(amountOutMin, 18) };
}

module.exports = { getSwapQuote, executeSwap };
