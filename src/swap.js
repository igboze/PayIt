// src/swap.js
// Circle Stablecoin FX & Token Swaps on Arc via Circle SwapKit (@circle-fin/swap-kit)
// Enables real-time, on-chain FX swaps between USDC and EURC on Arc

const { SwapKit, KitError } = require("@circle-fin/swap-kit");
const { createEthersAdapterFromPrivateKey } = require("@circle-fin/adapter-ethers-v6");
const { getNetworkConfig } = require("./network");
const { formatUnits, parseUnits } = require("ethers");

let _swapKit = null;
function getSwapKit() {
  if (!_swapKit) _swapKit = new SwapKit();
  return _swapKit;
}

/**
 * Get real-time FX exchange rates on Arc.
 */
async function getFxRates() {
  const kit = getSwapKit();
  const net = getNetworkConfig();
  const chain = net.isTestnet ? "Arc_Testnet" : "Arc";
  const rates = await kit.getTokenRates({ chain });
  return rates?.rates?.[chain] || {};
}

/**
 * Get quote for swapping tokenIn -> tokenOut (USDC <-> EURC).
 */
async function getSwapQuote(tokenIn, tokenOut, amountInMicro, privateKey = null) {
  const kit = getSwapKit();
  const net = getNetworkConfig();
  const chain = net.isTestnet ? "Arc_Testnet" : "Arc";
  const apiKey = process.env.CIRCLE_KIT_KEY || process.env.ARC_API_KEY;

  const pk = privateKey || "0x0123456789012345678901234567890123456789012345678901234567890123";
  const adapter = createEthersAdapterFromPrivateKey({ privateKey: pk });
  const humanAmount = formatUnits(BigInt(amountInMicro.toString()), 18);

  const quote = await kit.estimate({
    from: { adapter, chain },
    tokenIn,
    tokenOut,
    amountIn: humanAmount,
    ...(apiKey ? { config: { apiKey } } : {}),
  });

  const outAmount = quote?.estimatedOutput?.amount || quote?.estimatedOutput || "";
  return {
    ...quote,
    amountOut: outAmount,
    destinationAmount: outAmount,
    tokenIn,
    tokenOut,
  };
}

/**
 * Execute on-chain swap using user's privateKey.
 */
async function executeSwap(privateKey, tokenIn, tokenOut, amountInMicro) {
  const kit = getSwapKit();
  const net = getNetworkConfig();
  const chain = net.isTestnet ? "Arc_Testnet" : "Arc";
  const apiKey = process.env.CIRCLE_KIT_KEY || process.env.ARC_API_KEY;

  const adapter = createEthersAdapterFromPrivateKey({ privateKey });
  const humanAmount = formatUnits(BigInt(amountInMicro.toString()), 18);

  const result = await kit.swap({
    from: { adapter, chain },
    tokenIn,
    tokenOut,
    amountIn: humanAmount,
    ...(apiKey ? { config: { apiKey } } : {}),
  });

  return result;
}

module.exports = {
  getSwapKit,
  getFxRates,
  getSwapQuote,
  executeSwap,
};
