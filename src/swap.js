// src/swap.js
// Circle Stablecoin FX & Token Swaps on Arc via Circle SwapKit (@circle-fin/swap-kit)
// Enables real-time, on-chain FX swaps between USDC and EURC on Arc

const { SwapKit, KitError } = require("@circle-fin/swap-kit");
const { createEthersAdapterFromPrivateKey } = require("@circle-fin/adapter-ethers-v6");
const { getNetworkConfig } = require("./network");
const { formatUnits, parseUnits, Wallet } = require("ethers");

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
  const apiKey = process.env.CIRCLE_KIT_KEY || process.env.ARC_API_KEY;
  const rates = await kit.getTokenRates({
    chain,
    ...(apiKey ? { config: { apiKey } } : {}),
  });
  return rates?.rates?.[chain] || {};
}

async function getUsdcEurcPairRate() {
  const net = getNetworkConfig();
  const usdcKey = String(net.usdcAddress || "").toLowerCase();
  const eurcKey = String(net.eurcAddress || "").toLowerCase();
  let usdcUsd = null;
  let eurcUsd = null;
  let rawRates = {};

  try {
    rawRates = await getFxRates();
    const lookup = (addr) => {
      for (const [k, v] of Object.entries(rawRates || {})) {
        if (k.toLowerCase() === addr && v?.priceUSD) return Number(v.priceUSD);
      }
      return null;
    };
    usdcUsd = lookup(usdcKey);
    eurcUsd = lookup(eurcKey);
  } catch (_) {}

  let usdcToEurc = usdcUsd && eurcUsd ? Number((usdcUsd / eurcUsd).toFixed(4)) : null;
  let eurcToUsdc = usdcUsd && eurcUsd ? Number((eurcUsd / usdcUsd).toFixed(4)) : null;

  if (!usdcToEurc) {
    try {
      const q = await getSwapQuote("USDC", "EURC", parseUnits("100", 18));
      const out = Number(q?.amountOut || 0);
      if (out > 0) {
        usdcToEurc = Number((out / 100).toFixed(4));
        eurcToUsdc = Number((100 / out).toFixed(4));
      }
    } catch (_) {}
  }

  return {
    usdcUsd: usdcUsd ? Number(usdcUsd.toFixed(4)) : null,
    eurcUsd: eurcUsd ? Number(eurcUsd.toFixed(4)) : null,
    usdcToEurc,
    eurcToUsdc,
    feePct: Number((SWAP_PROTOCOL_FEE_BPS / 100).toFixed(2)),
    updatedAt: new Date().toISOString(),
    rawRates,
  };
}

const SWAP_PROTOCOL_FEE_BPS = Number(process.env.SWAP_PROTOCOL_FEE_BPS ?? 100); // 1.00% protocol fee

/**
 * Get quote for swapping tokenIn -> tokenOut (USDC <-> EURC).
 */
async function getSwapQuote(tokenIn, tokenOut, amountInMicro, privateKey = null) {
  const kit = getSwapKit();
  const net = getNetworkConfig();
  const chain = net.isTestnet ? "Arc_Testnet" : "Arc";
  const apiKey = process.env.CIRCLE_KIT_KEY || process.env.ARC_API_KEY;

  const pk = privateKey || Wallet.createRandom().privateKey;
  const adapter = createEthersAdapterFromPrivateKey({ privateKey: pk });
  const humanAmount = formatUnits(BigInt(amountInMicro.toString()), 18);

  const quote = await kit.estimate({
    from: { adapter, chain },
    tokenIn,
    tokenOut,
    amountIn: humanAmount,
    ...(apiKey ? { config: { apiKey } } : {}),
  });

  const rawOut = quote?.estimatedOutput?.amount || quote?.estimatedOutput || "";
  const numOut = parseFloat(rawOut);
  const feeAmount = !isNaN(numOut) && numOut > 0 ? numOut * (SWAP_PROTOCOL_FEE_BPS / 10000) : 0;
  const outAmount = !isNaN(numOut) && numOut > 0 ? (numOut - feeAmount).toFixed(4) : rawOut;

  return {
    ...quote,
    amountOut: outAmount,
    destinationAmount: outAmount,
    protocolFee: feeAmount.toFixed(4),
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
  getUsdcEurcPairRate,
  getSwapQuote,
  executeSwap,
};
