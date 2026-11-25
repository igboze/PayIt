// src/near.js
// NEAR Intents (1Click) integration — NEAR deposits bridged to Base USDC,
// then auto-swept to Arc by the existing EVM deposit sweeper.
//
// Routing reality (verified against live 1Click API):
//   Any NEAR Token -> Base USDC : quoted by solvers  <- our route
//   Any NEAR Token -> Arbitrum USDC: fallback route
// The one-time depositAddress comes from POST /v0/quote (dry=false).
// Settlement is tracked with GET /v0/status — crediting itself always happens
// through the EVM sweeper (Base -> Arc CCTP), never here, to avoid double credit.
//
// Refunds: refundTo is the user's derived NEAR implicit account (same ed25519
// secret material as their Solana key, domain-separated salt). Refunded tokens
// sit there until the user requests a manual/assisted recovery.

const crypto = require("crypto");
const tweetnacl = require("tweetnacl");
const bs58 = require("bs58");
const db = require("./db");

const DEFAULT_API_URL = "https://1click.chaindefuser.com";

// Asset IDs on the 1Click token registry (overridable via env).
const ASSETS = {
  NEAR_USDC: process.env.NEAR_INTENTS_USDC || "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  NEAR_USDT: process.env.NEAR_INTENTS_USDT || "nep141:usdt.tether-token.near",
  NEAR_WNEAR: process.env.NEAR_INTENTS_WNEAR || "nep141:wrap.near",
  BASE_USDC: process.env.NEAR_INTENTS_BASE_USDC || "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  ARB_USDC: process.env.NEAR_INTENTS_ARB_USDC || "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  // Solana tokens via NEAR Intents (omft.near bridge — verified against live /v0/tokens)
  SOL_NATIVE: process.env.NEAR_INTENTS_SOL || "nep141:sol.omft.near",
  SOL_USDC: process.env.NEAR_INTENTS_SOL_USDC || "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  SOL_USDT: process.env.NEAR_INTENTS_SOL_USDT || "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",
  // Robinhood Chain tokens via NEAR Intents (omft.near bridge)
  HOOD_USDG: process.env.NEAR_INTENTS_HOOD_USDG || "nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near",
  HOOD_ETH: process.env.NEAR_INTENTS_HOOD_ETH || "nep141:hood.omft.near",
  HOOD_WETH: process.env.NEAR_INTENTS_HOOD_WETH || "nep141:hood-0x0bd7d308f8e1639fab988df18a8011f41eacad73.omft.near",
  HOOD_USDE: process.env.NEAR_INTENTS_HOOD_USDE || "nep141:hood-0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34.omft.near",
  HOOD_PONS: process.env.NEAR_INTENTS_HOOD_PONS || "nep141:hood-0x39dbed3a2bd333467115de45665cc57f813c4571.omft.near",
  HOOD_CASHCAT: process.env.NEAR_INTENTS_HOOD_CASHCAT || "nep141:hood-0x020bfc650a365f8bb26819deaabf3e21291018b4.omft.near",
  // Starknet tokens via NEAR Intents (1Click — verified against live /v0/tokens)
  STARKNET_STRK: process.env.NEAR_INTENTS_STARKNET_STRK || "nep141:starknet.omft.near",
  STARKNET_ZEC: process.env.NEAR_INTENTS_STARKNET_ZEC || "1cs_v1:starknet:erc20:0x05ce53b9b68fb8e9ecab9283a96d97948914733fd6ed8d9a53a276a419497841",
  STARKNET_XRP: process.env.NEAR_INTENTS_STARKNET_XRP || "1cs_v1:starknet:erc20:0x07bc19585817a78f2304b2f3b31f954d80e8a1eff6e8d81a84eb5cedb7267728",
  STARKNET_SOL: process.env.NEAR_INTENTS_STARKNET_SOL || "1cs_v1:starknet:erc20:0x0752c64c8430f1a81a8f87e6252a8853cb9428352d585d90b4151cfe3702dcfe",
};

// Known popular NEAR tokens supported by 1Click / Defuse solvers.
const SUPPORTED_NEAR_TOKENS = [
  {
    symbol: "USDC",
    name: "USD Coin (Native NEAR)",
    assetId: ASSETS.NEAR_USDC,
    decimals: 6,
    icon: "💵",
    minDeposit: 2,
    blockchain: "near",
  },
  {
    symbol: "USDT",
    name: "Tether USD (NEAR)",
    assetId: ASSETS.NEAR_USDT,
    decimals: 6,
    icon: "🟢",
    minDeposit: 2,
    blockchain: "near",
  },
  {
    symbol: "NEAR",
    name: "NEAR Protocol / wNEAR",
    assetId: ASSETS.NEAR_WNEAR,
    decimals: 24,
    icon: "Ⓝ",
    minDeposit: 0.5,
    blockchain: "near",
  },
  {
    symbol: "wNEAR",
    name: "Wrapped NEAR",
    assetId: ASSETS.NEAR_WNEAR,
    decimals: 24,
    icon: "Ⓝ",
    minDeposit: 0.5,
    blockchain: "near",
  },
  {
    symbol: "WBTC",
    name: "Wrapped Bitcoin (Rainbow)",
    assetId: "nep141:2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near",
    decimals: 8,
    icon: "🪙",
    minDeposit: 0.0001,
    blockchain: "near",
  },
  {
    symbol: "BTC",
    name: "Bitcoin (Rainbow Bridge)",
    assetId: "nep141:nbtc.bridge.near",
    decimals: 8,
    icon: "🪙",
    minDeposit: 0.0001,
    blockchain: "near",
  },
  {
    symbol: "ETH",
    name: "Ethereum (Rainbow Bridge)",
    assetId: "nep141:eth.bridge.near",
    decimals: 18,
    icon: "🔷",
    minDeposit: 0.001,
    blockchain: "near",
  },
  {
    symbol: "AURORA",
    name: "Aurora",
    assetId: "nep141:aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near",
    decimals: 18,
    icon: "🅰️",
    minDeposit: 10,
    blockchain: "near",
  },
  {
    symbol: "SWEAT",
    name: "Sweat Economy",
    assetId: "nep141:token.sweat",
    decimals: 18,
    icon: "💧",
    minDeposit: 50,
    blockchain: "near",
  },
  {
    symbol: "FRAX",
    name: "Frax",
    assetId: "nep141:853d955acef822db058eb8505911ed77f175b99e.factory.bridge.near",
    decimals: 18,
    icon: "🟡",
    minDeposit: 2,
    blockchain: "near",
  },
  {
    symbol: "BLACKDRAGON",
    name: "Black Dragon",
    assetId: "nep141:blackdragon.tkn.near",
    decimals: 24,
    icon: "🐉",
    minDeposit: 1000000,
    blockchain: "near",
  },
  {
    symbol: "SHITZU",
    name: "Shitzu",
    assetId: "nep141:token.0xshitzu.near",
    decimals: 18,
    icon: "🐶",
    minDeposit: 10000,
    blockchain: "near",
  },
  {
    symbol: "mpDAO",
    name: "Meta Pool DAO",
    assetId: "nep141:mpdao-token.near",
    decimals: 6,
    icon: "🌊",
    minDeposit: 50,
    blockchain: "near",
  },
  {
    symbol: "stNEAR",
    name: "Staked NEAR",
    assetId: "nep141:meta-pool.near",
    decimals: 24,
    icon: "🌊",
    minDeposit: 0.5,
    blockchain: "near",
  },
];

/**
 * Solana tokens supported by 1Click / NEAR Intents via omft.near bridge.
 * assetId uses the `sol-<mint_address>.omft.near` NEP-141 wrapper format.
 * refundType must be "ORIGIN_CHAIN" so failed swaps refund to user's Solana address.
 */
const SUPPORTED_SOLANA_TOKENS = [
  {
    symbol: "SOL",
    name: "Solana (Native)",
    assetId: ASSETS.SOL_NATIVE,
    decimals: 9,
    icon: "☀️",
    minDeposit: 0.02,
    blockchain: "sol",
  },
  {
    symbol: "USDC",
    name: "USD Coin (Solana)",
    assetId: ASSETS.SOL_USDC,
    decimals: 6,
    icon: "💵",
    minDeposit: 2,
    blockchain: "sol",
  },
  {
    symbol: "USDT",
    name: "Tether USD (Solana)",
    assetId: ASSETS.SOL_USDT,
    decimals: 6,
    icon: "🟢",
    minDeposit: 2,
    blockchain: "sol",
  },
  {
    symbol: "$WIF",
    name: "dogwifhat",
    assetId: process.env.NEAR_INTENTS_SOL_WIF || "nep141:sol-b9c68f94ec8fd160137af8cdfe5e61cd68e2afba.omft.near",
    decimals: 6,
    icon: "🎩",
    minDeposit: 1,
    blockchain: "sol",
  },
  {
    symbol: "USD1",
    name: "USD1 (Solana)",
    assetId: process.env.NEAR_INTENTS_SOL_USD1 || "nep141:sol-0x936420c6ae310eb29511d139991654f922456fbe.omdep.near",
    decimals: 6,
    icon: "💵",
    minDeposit: 2,
    blockchain: "sol",
  },
  {
    symbol: "TRUMP",
    name: "OFFICIAL TRUMP",
    assetId: process.env.NEAR_INTENTS_SOL_TRUMP || "nep141:sol-c58e6539c2f2e097c251f8edf11f9c03e581f8d4.omft.near",
    decimals: 6,
    icon: "🪙",
    minDeposit: 0.5,
    blockchain: "sol",
  },
  {
    symbol: "PENGU",
    name: "Pudgy Penguins",
    assetId: process.env.NEAR_INTENTS_SOL_PENGU || "nep141:sol-0xaad74c68eecfc9f8c5bdcea614f6167048c795ef.omdep.near",
    decimals: 6,
    icon: "🐧",
    minDeposit: 100,
    blockchain: "sol",
  },
  {
    symbol: "BOME",
    name: "BOOK OF MEME",
    assetId: process.env.NEAR_INTENTS_SOL_BOME || "nep141:sol-57d087fd8c460f612f8701f5499ad8b2eec5ab68.omft.near",
    decimals: 6,
    icon: "🐸",
    minDeposit: 500,
    blockchain: "sol",
  },
  {
    symbol: "xBTC",
    name: "OKX Wrapped BTC (Solana)",
    assetId: process.env.NEAR_INTENTS_SOL_XBTC || "nep141:sol-91914f13d3b54f8126a2824d71632d4b078d7403.omft.near",
    decimals: 8,
    icon: "🪙",
    minDeposit: 0.0001,
    blockchain: "sol",
  },
];

/**
 * Robinhood Chain tokens supported by 1Click / NEAR Intents.
 * Robinhood Chain is an Arbitrum Orbit L2 (EVM).
 * refundType is "ORIGIN_CHAIN" which refunds to the user's EVM address on Robinhood Chain.
 */
const SUPPORTED_ROBINHOOD_TOKENS = [
  {
    symbol: "USDG",
    name: "Global Dollar (Robinhood)",
    assetId: ASSETS.HOOD_USDG,
    decimals: 6,
    icon: "💵",
    minDeposit: 1,
    blockchain: "hood",
    contractAddress: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  },
  {
    symbol: "ETH",
    name: "Ethereum (Robinhood)",
    assetId: ASSETS.HOOD_ETH,
    decimals: 18,
    icon: "🔷",
    minDeposit: 0.001,
    blockchain: "hood",
  },
  {
    symbol: "WETH",
    name: "Wrapped Ether (Robinhood)",
    assetId: ASSETS.HOOD_WETH,
    decimals: 18,
    icon: "🔷",
    minDeposit: 0.001,
    blockchain: "hood",
    contractAddress: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  },
  {
    symbol: "USDe",
    name: "Ethena USDe (Robinhood)",
    assetId: ASSETS.HOOD_USDE,
    decimals: 18,
    icon: "🟢",
    minDeposit: 1,
    blockchain: "hood",
    contractAddress: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
  },
  {
    symbol: "PONS",
    name: "Pons (Robinhood)",
    assetId: ASSETS.HOOD_PONS,
    decimals: 18,
    icon: "🪙",
    minDeposit: 1,
    blockchain: "hood",
    contractAddress: "0x39dbed3a2bd333467115de45665cc57f813c4571",
  },
  {
    symbol: "CASHCAT",
    name: "Cash Cat (Robinhood)",
    assetId: ASSETS.HOOD_CASHCAT,
    decimals: 18,
    icon: "🐱",
    minDeposit: 1,
    blockchain: "hood",
    contractAddress: "0x020bfc650a365f8bb26819deaabf3e21291018b4",
  },
];

/**
 * Starknet tokens supported by 1Click / NEAR Intents.
 * Users deposit on Starknet to a one-time Starknet address,
 * which 1Click solvers swap to Base USDC and auto-sweep to Arc.
 */
const SUPPORTED_STARKNET_TOKENS = [
  {
    symbol: "STRK",
    name: "Starknet Token",
    assetId: ASSETS.STARKNET_STRK,
    decimals: 18,
    icon: "🐺",
    minDeposit: 5,
    blockchain: "starknet",
  },
  {
    symbol: "ZEC",
    name: "Zcash (Starknet)",
    assetId: ASSETS.STARKNET_ZEC,
    decimals: 8,
    icon: "🛡️",
    minDeposit: 0.01,
    blockchain: "starknet",
    contractAddress: "0x05ce53b9b68fb8e9ecab9283a96d97948914733fd6ed8d9a53a276a419497841",
  },
  {
    symbol: "XRP",
    name: "Ripple (Starknet)",
    assetId: ASSETS.STARKNET_XRP,
    decimals: 6,
    icon: "✕",
    minDeposit: 2,
    blockchain: "starknet",
    contractAddress: "0x07bc19585817a78f2304b2f3b31f954d80e8a1eff6e8d81a84eb5cedb7267728",
  },
  {
    symbol: "SOL",
    name: "Solana (Starknet)",
    assetId: ASSETS.STARKNET_SOL,
    decimals: 9,
    icon: "☀️",
    minDeposit: 0.02,
    blockchain: "starknet",
    contractAddress: "0x0752c64c8430f1a81a8f87e6252a8853cb9428352d585d90b4151cfe3702dcfe",
  },
];

const TERMINAL_STATUSES = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

function getApiKey() {
  return process.env.NEAR_INTENTS_API_KEY || "";
}

function getApiBaseUrl() {
  return (process.env.NEAR_INTENTS_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

/**
 * Platform fee recipient for NEAR Intents 1Click deposits.
 * Defaults to the platform's APP_FEE_RECIPIENT_ADDRESS or PAYIT_DEV_FEE_ADDRESS.
 */
function getNearFeeRecipient() {
  return (
    process.env.NEAR_INTENT_FEE_RECIPIENT ||
    process.env.APP_FEE_RECIPIENT_ADDRESS ||
    process.env.PAYIT_DEV_FEE_ADDRESS ||
    "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359"
  );
}

/**
 * Platform fee in basis points (BPS) collected on 1Click solver deposits.
 * Default 100 bps (1.00%), configurable via NEAR_INTENT_FEE_BPS.
 */
function getNearFeeBps() {
  const bps = Number(process.env.NEAR_INTENT_FEE_BPS ?? 100);
  return isNaN(bps) || bps < 0 ? 100 : Math.min(bps, 500);
}

/**
 * Accurately convert decimal amount string/number into base units integer string.
 * Avoids JavaScript floating-point precision errors for tokens with high decimals (like NEAR 24).
 */
function toBaseUnits(amount, decimals = 6) {
  const s = String(amount).trim();
  if (!s || isNaN(Number(s))) throw new Error(`Invalid amount: ${amount}`);
  const [whole, frac = ""] = s.split(".");
  const cleanWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const cleanFrac = frac.slice(0, decimals).padEnd(decimals, "0");
  const full = (cleanWhole === "0" ? "" : cleanWhole) + cleanFrac;
  const normalized = full.replace(/^0+/, "") || "0";
  return normalized;
}

let _cachedDynamicTokens = null;
let _cachedDynamicTokensExpiry = 0;
let _cachedSolanaTokens = null;
let _cachedSolanaTokensExpiry = 0;
let _cachedRobinhoodTokens = null;
let _cachedRobinhoodTokensExpiry = 0;
let _cachedStarknetTokens = null;
let _cachedStarknetTokensExpiry = 0;

/**
 * Fetch supported tokens dynamically from 1Click API `/v0/tokens` if available,
 * merged with the catalog of known NEAR tokens.
 */
async function getSupportedNearTokens(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cachedDynamicTokens && now < _cachedDynamicTokensExpiry) {
    return _cachedDynamicTokens;
  }

  const tokenMap = new Map();
  for (const t of SUPPORTED_NEAR_TOKENS) {
    tokenMap.set(t.symbol.toUpperCase(), { ...t });
    tokenMap.set(t.assetId.toLowerCase(), { ...t });
  }

  try {
    const axios = require("axios");
    const key = getApiKey();
    const headers = { "Content-Type": "application/json" };
    if (key) headers["Authorization"] = `Bearer ${key}`;

    const res = await axios({
      method: "GET",
      url: `${getApiBaseUrl()}/v0/tokens`,
      timeout: 3500,
      headers,
    });

    const tokens = Array.isArray(res.data) ? res.data : [];
    for (const item of tokens) {
      // CRITICAL FIX: Only include tokens whose origin blockchain is natively "near"!
      // Bridged OMFT tokens from other chains (like sui-*, miden-*, arb-*, eth-*, hood-*)
      // have assetIds ending in .omft.near, but their blockchain is "sui", "eth", etc.,
      // which causes 1Click to return non-NEAR (EVM) deposit addresses and require non-NEAR refund addresses!
      const isNativeNear = item.blockchain === "near";
      if (!isNativeNear) continue;

      const sym = (item.symbol || "").toUpperCase();
      const existing = tokenMap.get(sym);
      const entry = {
        symbol: sym || "TOKEN",
        name: item.name || sym,
        assetId: item.assetId,
        decimals: Number(item.decimals ?? 6),
        icon: sym === "NEAR" || sym === "WNEAR" ? "Ⓝ" : sym === "USDT" ? "🟢" : sym.includes("USD") ? "💵" : sym === "WBTC" || sym === "BTC" ? "🪙" : sym === "WETH" || sym === "ETH" ? "🔷" : sym === "AURORA" ? "🅰️" : sym === "SWEAT" ? "💧" : "🪙",
        priceUsd: item.price ? Number(item.price) : undefined,
        minDeposit: existing?.minDeposit ?? (sym.includes("USD") ? 2 : (item.price && item.price > 0 ? Math.max(0.001, Math.ceil(2 / item.price * 1000) / 1000) : 1)),
        blockchain: "near",
      };
      tokenMap.set(sym, entry);
      tokenMap.set(item.assetId.toLowerCase(), entry);
    }
  } catch (_) {
    // Dynamic endpoint fallback to standard catalog
  }

  // Ensure canonical native NEAR tokens always map strictly to their official NEAR contracts
  tokenMap.set("USDC", {
    symbol: "USDC",
    name: "USD Coin (Native NEAR)",
    assetId: ASSETS.NEAR_USDC,
    decimals: 6,
    icon: "💵",
    minDeposit: 2,
    blockchain: "near",
  });
  tokenMap.set("USDT", {
    symbol: "USDT",
    name: "Tether USD (NEAR)",
    assetId: ASSETS.NEAR_USDT,
    decimals: 6,
    icon: "🟢",
    minDeposit: 2,
    blockchain: "near",
  });
  tokenMap.set("NEAR", {
    symbol: "NEAR",
    name: "NEAR Protocol / wNEAR",
    assetId: ASSETS.NEAR_WNEAR,
    decimals: 24,
    icon: "Ⓝ",
    minDeposit: 0.5,
    blockchain: "near",
  });
  tokenMap.set("WNEAR", {
    symbol: "wNEAR",
    name: "Wrapped NEAR",
    assetId: ASSETS.NEAR_WNEAR,
    decimals: 24,
    icon: "Ⓝ",
    minDeposit: 0.5,
    blockchain: "near",
  });

  const list = [];
  const seenAssets = new Set();
  for (const token of tokenMap.values()) {
    if (seenAssets.has(token.assetId)) continue;
    seenAssets.add(token.assetId);
    list.push(token);
  }

  _cachedDynamicTokens = list;
  _cachedDynamicTokensExpiry = now + 60 * 60 * 1000;
  return list;
}

async function getSupportedSolanaTokens(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cachedSolanaTokens && now < _cachedSolanaTokensExpiry) {
    return _cachedSolanaTokens;
  }

  // Start with static catalog
  const tokenMap = new Map();
  for (const t of SUPPORTED_SOLANA_TOKENS) {
    tokenMap.set(t.symbol.toUpperCase(), { ...t });
    tokenMap.set(t.assetId.toLowerCase(), { ...t });
  }

  try {
    const axios = require("axios");
    const key = getApiKey();
    const headers = { "Content-Type": "application/json" };
    if (key) headers["Authorization"] = `Bearer ${key}`;

    const res = await axios({
      method: "GET",
      url: `${getApiBaseUrl()}/v0/tokens`,
      timeout: 3500,
      headers,
    });

    const tokens = Array.isArray(res.data) ? res.data : [];
    for (const item of tokens) {
      const isSol = item.blockchain === "sol" ||
        (typeof item.assetId === "string" && item.assetId.includes("sol-") && item.assetId.endsWith(".omft.near"));
      if (!isSol) continue;

      const sym = (item.symbol || "").toUpperCase();
      const existing = tokenMap.get(sym);
      const entry = {
        symbol: sym || "TOKEN",
        name: item.name || sym,
        assetId: item.assetId,
        decimals: Number(item.decimals ?? 6),
        icon: sym === "SOL" ? "☀️" : sym.includes("USD") ? "💵" : "🪙",
        priceUsd: item.price ? Number(item.price) : undefined,
        minDeposit: existing?.minDeposit ?? 1,
        blockchain: "sol",
      };
      tokenMap.set(sym, entry);
      tokenMap.set(item.assetId.toLowerCase(), entry);
    }
  } catch (_) {
    // Fallback to static catalog
  }

  const list = [];
  const seenAssets = new Set();
  for (const token of tokenMap.values()) {
    if (seenAssets.has(token.assetId)) continue;
    seenAssets.add(token.assetId);
    list.push(token);
  }

  _cachedSolanaTokens = list;
  _cachedSolanaTokensExpiry = now + 60 * 60 * 1000;
  return list;
}

/**
 * Resolve a Solana token by symbol or assetId.
 */
async function resolveSolanaToken(query) {
  if (!query) return null;
  const q = String(query).trim();
  const qUpper = q.toUpperCase();
  const qLower = q.toLowerCase();

  const tokens = await getSupportedSolanaTokens();
  const bySymbol = tokens.find((t) => t.symbol.toUpperCase() === qUpper);
  if (bySymbol) return bySymbol;

  const byAssetId = tokens.find((t) => t.assetId.toLowerCase() === qLower);
  if (byAssetId) return byAssetId;

  return null;
}

/**
 * Fetch Robinhood Chain tokens supported by 1Click. Returns static catalog merged with
 * any extra hood-blockchain tokens from the /v0/tokens endpoint.
 */
async function getSupportedRobinhoodTokens(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cachedRobinhoodTokens && now < _cachedRobinhoodTokensExpiry) {
    return _cachedRobinhoodTokens;
  }

  // Start with static catalog
  const tokenMap = new Map();
  for (const t of SUPPORTED_ROBINHOOD_TOKENS) {
    tokenMap.set(t.symbol.toUpperCase(), { ...t });
    tokenMap.set(t.assetId.toLowerCase(), { ...t });
    if (t.contractAddress) {
      tokenMap.set(t.contractAddress.toLowerCase(), { ...t });
    }
  }

  try {
    const axios = require("axios");
    const key = getApiKey();
    const headers = { "Content-Type": "application/json" };
    if (key) headers["Authorization"] = `Bearer ${key}`;

    const res = await axios({
      method: "GET",
      url: `${getApiBaseUrl()}/v0/tokens`,
      timeout: 3500,
      headers,
    });

    const tokens = Array.isArray(res.data) ? res.data : [];
    for (const item of tokens) {
      const isHood = item.blockchain === "hood" ||
        (typeof item.assetId === "string" && (item.assetId.includes("hood-") || item.assetId.startsWith("nep141:hood")));
      if (!isHood) continue;

      const sym = (item.symbol || "").toUpperCase();
      const existing = tokenMap.get(sym);
      const entry = {
        symbol: sym || "TOKEN",
        name: item.name || (sym === "USDG" ? "Global Dollar" : sym === "ETH" ? "Ethereum" : sym),
        assetId: item.assetId,
        decimals: Number(item.decimals ?? 18),
        icon: sym === "USDG" || sym.includes("USD") ? "💵" : (sym === "ETH" || sym === "WETH") ? "🔷" : sym === "USDE" ? "🟢" : sym === "CASHCAT" ? "🐱" : "🪙",
        priceUsd: item.price ? Number(item.price) : undefined,
        minDeposit: existing?.minDeposit ?? (sym.includes("USD") ? 1 : 0.001),
        blockchain: "hood",
        contractAddress: item.contractAddress,
      };
      tokenMap.set(sym, entry);
      tokenMap.set(item.assetId.toLowerCase(), entry);
      if (item.contractAddress) {
        tokenMap.set(item.contractAddress.toLowerCase(), entry);
      }
    }
  } catch (_) {
    // Fallback to static catalog
  }

  const list = [];
  const seenAssets = new Set();
  for (const token of tokenMap.values()) {
    if (seenAssets.has(token.assetId)) continue;
    seenAssets.add(token.assetId);
    list.push(token);
  }

  _cachedRobinhoodTokens = list;
  _cachedRobinhoodTokensExpiry = now + 60 * 60 * 1000;
  return list;
}

/**
 * Resolve a Robinhood Chain token by symbol, assetId or contract address.
 */
async function resolveRobinhoodToken(query) {
  if (!query) return null;
  const q = String(query).trim();
  const qUpper = q.toUpperCase();
  const qLower = q.toLowerCase();

  const tokens = await getSupportedRobinhoodTokens();
  const bySymbol = tokens.find((t) => t.symbol.toUpperCase() === qUpper);
  if (bySymbol) return bySymbol;

  const byAssetId = tokens.find((t) => t.assetId.toLowerCase() === qLower);
  if (byAssetId) return byAssetId;

  const byContract = tokens.find((t) => t.contractAddress && t.contractAddress.toLowerCase() === qLower);
  if (byContract) return byContract;

  return null;
}

/**
 * Fetch Starknet tokens supported by 1Click. Returns static catalog merged with
 * any extra starknet-blockchain tokens from the /v0/tokens endpoint.
 */
async function getSupportedStarknetTokens(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cachedStarknetTokens && now < _cachedStarknetTokensExpiry) {
    return _cachedStarknetTokens;
  }

  // Start with static catalog
  const tokenMap = new Map();
  for (const t of SUPPORTED_STARKNET_TOKENS) {
    tokenMap.set(t.symbol.toUpperCase(), { ...t });
    tokenMap.set(t.assetId.toLowerCase(), { ...t });
    if (t.contractAddress) {
      tokenMap.set(t.contractAddress.toLowerCase(), { ...t });
    }
  }

  try {
    const axios = require("axios");
    const key = getApiKey();
    const headers = { "Content-Type": "application/json" };
    if (key) headers["Authorization"] = `Bearer ${key}`;

    const res = await axios({
      method: "GET",
      url: `${getApiBaseUrl()}/v0/tokens`,
      timeout: 3500,
      headers,
    });

    const tokens = Array.isArray(res.data) ? res.data : [];
    for (const item of tokens) {
      const isStark =
        item.blockchain === "starknet" ||
        (typeof item.assetId === "string" && (item.assetId.includes("starknet") || item.assetId.startsWith("1cs_v1:starknet")));
      if (!isStark) continue;

      const sym = (item.symbol || "").toUpperCase();
      const existing = tokenMap.get(sym);
      const entry = {
        symbol: sym || "TOKEN",
        name: item.name || (sym === "STRK" ? "Starknet Token" : (sym === "ETH" ? "Ethereum (Starknet)" : sym)),
        assetId: item.assetId,
        decimals: Number(item.decimals ?? 18),
        icon: sym === "STRK" ? "🐺" : sym === "ETH" ? "🔷" : sym.includes("USD") ? "💵" : sym === "ZEC" ? "🛡️" : sym === "XRP" ? "✕" : "🪙",
        priceUsd: item.price ? Number(item.price) : undefined,
        minDeposit: existing?.minDeposit ?? (sym === "STRK" ? 5 : (sym === "ETH" ? 0.001 : 1)),
        blockchain: "starknet",
        ...(item.contractAddress ? { contractAddress: item.contractAddress } : {}),
      };
      tokenMap.set(sym, entry);
      tokenMap.set(item.assetId.toLowerCase(), entry);
      if (item.contractAddress) {
        tokenMap.set(item.contractAddress.toLowerCase(), entry);
      }
    }
  } catch (_) {
    // Fallback to static catalog
  }

  const list = [];
  const seenAssets = new Set();
  for (const token of tokenMap.values()) {
    if (seenAssets.has(token.assetId)) continue;
    seenAssets.add(token.assetId);
    list.push(token);
  }

  _cachedStarknetTokens = list;
  _cachedStarknetTokensExpiry = now + 60 * 60 * 1000;
  return list;
}

/**
 * Resolve a Starknet token by symbol, assetId or contract address.
 */
async function resolveStarknetToken(query) {
  if (!query) return null;
  const q = String(query).trim();
  const qUpper = q.toUpperCase();
  const qLower = q.toLowerCase();

  const tokens = await getSupportedStarknetTokens();
  const bySymbol = tokens.find((t) => t.symbol.toUpperCase() === qUpper);
  if (bySymbol) return bySymbol;

  const byAssetId = tokens.find((t) => t.assetId.toLowerCase() === qLower);
  if (byAssetId) return byAssetId;

  const byContract = tokens.find((t) => t.contractAddress && t.contractAddress.toLowerCase() === qLower);
  if (byContract) return byContract;

  return null;
}

/**
 * Resolve token by symbol, assetId or contract address.
 */
async function resolveNearToken(query) {
  if (!query) return null;
  const q = String(query).trim();
  const qUpper = q.toUpperCase();
  const qLower = q.toLowerCase();

  // Canonical shortcuts
  if (qUpper === "NEAR" || qUpper === "WNEAR") {
    return {
      symbol: qUpper === "WNEAR" ? "wNEAR" : "NEAR",
      name: "NEAR Protocol / wNEAR",
      assetId: ASSETS.NEAR_WNEAR,
      decimals: 24,
      icon: "Ⓝ",
      minDeposit: 0.5,
      blockchain: "near",
    };
  }
  if (qUpper === "USDC") {
    return {
      symbol: "USDC",
      name: "USD Coin (Native NEAR)",
      assetId: ASSETS.NEAR_USDC,
      decimals: 6,
      icon: "💵",
      minDeposit: 2,
      blockchain: "near",
    };
  }
  if (qUpper === "USDT") {
    return {
      symbol: "USDT",
      name: "Tether USD (NEAR)",
      assetId: ASSETS.NEAR_USDT,
      decimals: 6,
      icon: "🟢",
      minDeposit: 2,
      blockchain: "near",
    };
  }

  const tokens = await getSupportedNearTokens();
  const bySymbol = tokens.find((t) => t.symbol.toUpperCase() === qUpper);
  if (bySymbol) return bySymbol;

  const byAssetId = tokens.find((t) => t.assetId.toLowerCase() === qLower);
  if (byAssetId) return byAssetId;

  // Match contract address without nep141: prefix
  const byContract = tokens.find((t) => {
    const raw = t.assetId.replace(/^nep141:/, "").toLowerCase();
    return raw === qLower;
  });
  if (byContract) return byContract;

  // Custom NEAR token handling
  if (q.startsWith("nep141:") || q.endsWith(".near") || isNearAddress(q)) {
    // Reject foreign OMFT wrappers disguised with nep141: prefix
    if (/nep141:(sui|miden|hood|sol|eth|arb|base|aptos|bera|gnosis|doge|cardano|movement|plasma)-/i.test(q)) {
      return null;
    }
    const assetId = q.startsWith("nep141:") ? q : `nep141:${q}`;
    const cleanSym = (q.split(/[:.]/)[1] || "TOKEN").toUpperCase();
    return {
      symbol: cleanSym,
      name: q,
      assetId,
      decimals: 18,
      icon: "🪙",
      minDeposit: 0.1,
      blockchain: "near",
    };
  }

  return null;
}

async function apiRequest(method, path, body) {
  const key = getApiKey();
  if (!key) throw new Error("NEAR_INTENTS_API_KEY is not configured");
  const axios = require("axios");
  const res = await axios({
    method,
    url: `${getApiBaseUrl()}${path}`,
    ...(body ? { data: body } : {}),
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });
  return res.data;
}

/**
 * Derive the user's NEAR implicit account from their EVM private key.
 * Same construction as multichain.deriveSolanaFromEvmKey but with a
 * NEAR-specific domain-separation salt — the two chains never share keys.
 *
 * NEAR implicit account = lowercase hex of the 32-byte ed25519 public key.
 *
 * @param {string} evmPrivateKey - hex private key (0x-prefixed or not)
 * @returns {{ nearAddress: string, publicKeyHex: string, secretKeyHex: string }}
 */
function isNearAddress(address) {
  const clean = String(address || "").trim();
  if (!clean) return false;
  return /^(([a-z0-9_-]+\.)*(near|tg)|[a-f0-9]{64})$/i.test(clean);
}

function deriveNearAddress(evmPrivateKey) {
  if (!evmPrivateKey) throw new Error("EVM private key required to derive NEAR address");
  const cleanHex = evmPrivateKey.startsWith("0x") ? evmPrivateKey.slice(2) : evmPrivateKey;
  const keyBuffer = Buffer.from(cleanHex, "hex");

  const hmac = crypto.createHmac("sha512", Buffer.from("Proxim-NEAR-Intent-Bridge-Salt", "utf8"));
  hmac.update(keyBuffer);
  const seed32 = hmac.digest().subarray(0, 32);

  const naclKeypair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(seed32));
  const publicKeyHex = Buffer.from(naclKeypair.publicKey).toString("hex");
  const encodeBs58 = bs58.default ? bs58.default.encode : bs58.encode;
  const secretKeyBase58 = "ed25519:" + encodeBs58(naclKeypair.secretKey);
  return {
    nearAddress: publicKeyHex.toLowerCase(),
    publicKeyHex: publicKeyHex.toLowerCase(),
    secretKeyHex: Buffer.from(naclKeypair.secretKey).toString("hex"),
    secretKeyBase58,
  };
}

/**
 * Query NEAR Mainnet RPC for on-chain account balance of a NEAR address.
 * Unfunded implicit accounts return exists: false (they exist in cryptographic keys,
 * but state is created on first inbound transfer).
 *
 * @param {string} nearAddress
 * @returns {Promise<{ exists: boolean, balanceNear: number, raw: string }>}
 */
async function getNearAccountBalance(nearAddress) {
  if (!nearAddress) return { exists: false, balanceNear: 0, raw: "0" };
  try {
    const axios = require("axios");
    const rpcUrl = process.env.NEAR_RPC_URL || "https://rpc.mainnet.near.org";
    const res = await axios.post(
      rpcUrl,
      {
        jsonrpc: "2.0",
        id: "balance_check",
        method: "query",
        params: {
          request_type: "view_account",
          finality: "final",
          account_id: nearAddress,
        },
      },
      { timeout: 6000 }
    );
    if (res.data?.result?.amount) {
      const raw = String(res.data.result.amount);
      const whole = raw.length > 24 ? raw.slice(0, raw.length - 24) : "0";
      const frac = raw.length > 24 ? raw.slice(raw.length - 24, raw.length - 20) : raw.padStart(24, "0").slice(0, 4);
      return { exists: true, balanceNear: Number(whole + "." + frac), raw };
    }
  } catch (err) {
    if (err.response?.data?.error?.data?.includes("does not exist")) {
      return { exists: false, balanceNear: 0, raw: "0" };
    }
  }
  return { exists: false, balanceNear: 0, raw: "0" };
}

/**
 * Derive the user's Starknet address from their EVM private key.
 * Uses HMAC-SHA512 with domain-separated salt "Proxim-Starknet-Intent-Bridge-Salt"
 * and returns a standard 0x-prefixed 32-byte hex string (66 chars).
 *
 * @param {string} evmPrivateKey - hex private key (0x-prefixed or not)
 * @returns {{ starknetAddress: string, publicKeyHex: string }}
 */
function deriveStarknetAddress(evmPrivateKey) {
  if (!evmPrivateKey) throw new Error("EVM private key required to derive Starknet address");
  const cleanHex = evmPrivateKey.startsWith("0x") ? evmPrivateKey.slice(2) : evmPrivateKey;
  const keyBuffer = Buffer.from(cleanHex, "hex");

  const hmac = crypto.createHmac("sha512", Buffer.from("Proxim-Starknet-Intent-Bridge-Salt", "utf8"));
  hmac.update(keyBuffer);
  const seed32 = hmac.digest().subarray(0, 32);

  const addressHex = "0x" + seed32.toString("hex").toLowerCase();
  return {
    starknetAddress: addressHex,
    publicKeyHex: seed32.toString("hex").toLowerCase(),
  };
}

function defaultDeadline() {
  const mins = Number(process.env.NEAR_INTENT_DEADLINE_MIN || 30);
  return new Date(Date.now() + mins * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Request a 1Click quote (dry or real).
 *
 * @param {object} p
 * @param {string} p.originAsset      - e.g. ASSETS.NEAR_USDC or any supported token
 * @param {string} p.destinationAsset - e.g. ASSETS.BASE_USDC
 * @param {string} p.amount           - base units as integer string
 * @param {string} p.recipient        - destination-chain address (user's Arc/Base address)
 * @param {string} p.refundTo         - origin-chain refund address
 * @param {boolean} [p.dry=false]
 * @param {Array<{recipient: string, fee: number}>} [p.appFees]
 */
async function getQuote({ originAsset, destinationAsset, amount, recipient, refundTo, dry = false, appFees = null, swapType = "FLEX_INPUT", refundType = "ORIGIN_CHAIN" }) {
  let resolvedAppFees = appFees;
  if (!resolvedAppFees) {
    const feeRecipient = getNearFeeRecipient();
    const feeBps = getNearFeeBps();
    if (feeRecipient && feeBps > 0) {
      // Defuse 1Click API splits the requested appFee 50/50 between the integration partner
      // and the Defuse solver protocol (5880ad...). To ensure our feeRecipient receives the
      // full target net fee (e.g. 100 bps = 1.00%), we request gross fee = feeBps * 2 so Defuse's
      // 50/50 revenue split delivers the exact 1.00% net fee to our fee recipient.
      const grossFee = Math.min(feeBps * 2, 1000);
      resolvedAppFees = [{ recipient: feeRecipient, fee: grossFee }];
    }
  }

  const payload = {
    dry,
    swapType,
    slippageTolerance: Number(process.env.NEAR_INTENT_SLIPPAGE_BPS || 200),
    originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset,
    amount: String(amount),
    refundTo,
    refundType: refundType === "INTENTS" ? "INTENTS" : "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: defaultDeadline(),
  };

  if (resolvedAppFees && resolvedAppFees.length > 0) {
    payload.appFees = resolvedAppFees;
  }

  const caller = module.exports.apiRequest || apiRequest;
  return caller("POST", "/v0/quote", payload);
}

/**
 * Check swap execution status for a deposit address.
 * @returns {Promise<{status: string, swapDetails?: object}>}
 */
async function getExecutionStatus(depositAddress, depositMemo) {
  const qs = new URLSearchParams({ depositAddress });
  if (depositMemo) qs.set("depositMemo", depositMemo);
  const caller = module.exports.apiRequest || apiRequest;
  return caller("GET", `/v0/status?${qs.toString()}`);
}

/**
 * Create a NEAR deposit intent: persist the row first, then fetch a real quote
 * to auto-convert the token into Base USDC and store the one-time deposit address.
 *
 * @param {object} p
 * @param {number|string} p.telegramId
 * @param {string} [p.accountType="personal"]
 * @param {string} [p.originAsset]
 * @param {string} [p.originSymbol]
 * @param {number} [p.originDecimals]
 * @param {number} [p.amount]
 * @param {number} [p.amountUsdc]
 * @param {string} p.recipientAddress
 * @param {string} p.refundTo
 * @returns {Promise<object>} near_deposits row (with quote fields)
 */
async function createNearDeposit({
  telegramId,
  accountType = "personal",
  originAsset,
  originSymbol,
  originDecimals,
  amount,
  amountUsdc,
  recipientAddress,
  refundTo,
}) {
  if (!isNearAddress(refundTo)) {
    throw new Error(`refundTo must be a valid NEAR account or 64-char implicit address (got: ${refundTo})`);
  }

  const chosenAmount = amount !== undefined && amount !== null ? amount : amountUsdc;
  let chosenAsset = originAsset || ASSETS.NEAR_USDC;

  let resolvedDecimals = originDecimals;
  let resolvedSymbol = originSymbol;
  if (!resolvedDecimals || !resolvedSymbol) {
    const tokenInfo = await resolveNearToken(chosenAsset);
    resolvedDecimals = resolvedDecimals ?? tokenInfo?.decimals ?? (chosenAsset.includes("usdc") || chosenAsset.includes("usdt") ? 6 : (chosenAsset.includes("wrap.near") ? 24 : 18));
    resolvedSymbol = resolvedSymbol ?? tokenInfo?.symbol ?? (chosenAsset.includes("usdc") ? "USDC" : "TOKEN");
  }

  const id = db.createNearDeposit({
    telegramId,
    accountType,
    originAsset: chosenAsset,
    originSymbol: resolvedSymbol,
    amountToken: chosenAmount,
    amountUsdc: chosenAmount,
    recipientAddress,
    refundTo,
    status: "quoting",
  });

  try {
    const baseUnits = toBaseUnits(chosenAmount, resolvedDecimals);
    // Routed via module.exports so tests can stub the API layer.
    const quoteRes = await module.exports.getQuote({
      originAsset: chosenAsset,
      destinationAsset: ASSETS.BASE_USDC,
      amount: baseUnits,
      recipient: recipientAddress,
      refundTo,
      dry: false,
    });
    const q = quoteRes?.quote || {};
    db.updateNearDeposit(id, {
      status: "awaiting_deposit",
      deposit_address: q.depositAddress || null,
      deposit_memo: q.depositMemo || null,
      amount_out: q.amountOut ? Number(q.amountOut) / 1e6 : null,
      quote_json: JSON.stringify(quoteRes),
      deadline: quoteRes?.quoteRequest?.deadline || null,
      correlation_id: quoteRes?.correlationId || null,
      origin_symbol: resolvedSymbol,
      amount_token: Number(chosenAmount),
    });
    return db.getNearDepositById(id);
  } catch (err) {
    db.updateNearDeposit(id, { status: "failed", error: String(err.message).slice(0, 500) });
    throw err;
  }
}

/**
 * Poll all non-terminal NEAR deposits, update statuses, and notify users on
 * terminal transitions. SUCCESS means funds landed on Base — the EVM sweeper
 * detects that balance and credits Arc independently; this function only
 * reports progress, it never credits.
 *
 * @param {object} [bot] - Telegraf bot for notifications
 * @returns {Promise<{updated: number, terminal: number}>}
 */
async function pollPendingNearDeposits(bot = null) {
  const pending = db.getActiveNearDeposits();
  let updated = 0;
  let terminal = 0;

  for (const row of pending) {
    if (!row.deposit_address) continue;
    try {
      // Routed via module.exports so tests can stub the API layer.
      const st = await module.exports.getExecutionStatus(row.deposit_address, row.deposit_memo);
      const status = String(st?.status || "").toUpperCase();
      if (!status || status === row.status) continue;

      db.updateNearDeposit(row.id, { status });
      updated++;

      if (status === "INCOMPLETE_DEPOSIT" && bot && row.telegram_id) {
        const swap = st?.swapDetails || {};
        const quoteObj = st?.quoteResponse?.quote || {};
        const inAmount = row.amount_token !== undefined && row.amount_token !== null ? Number(row.amount_token) : Number(row.amount_usdc);
        const inSymbol = row.origin_symbol || (row.origin_asset?.includes("usdc") ? "USDC" : "tokens");
        const receivedStr = swap.depositedAmountFormatted ? `${swap.depositedAmountFormatted} ${inSymbol}` : "a smaller amount than required";
        const minRequiredStr = quoteObj.minAmountIn
          ? `${(Number(quoteObj.minAmountIn) / Math.pow(10, inSymbol === "NEAR" || inSymbol === "wNEAR" ? 24 : 6)).toFixed(6).replace(/\.?0+$/, "")} ${inSymbol}`
          : `${inAmount} ${inSymbol}`;
        const isHood = row.origin_asset && (row.origin_asset.includes("hood-") || row.origin_asset.includes("hood."));
        const isSol = row.origin_asset && row.origin_asset.includes("sol-");
        const isStark = row.origin_asset && (row.origin_asset.includes("starknet") || row.origin_asset.includes("strk") || row.origin_symbol === "STRK");
        const chainName = isHood ? "Robinhood Chain" : (isSol ? "Solana" : (isStark ? "Starknet" : "NEAR Protocol"));
        const refundChainName = isHood ? "Robinhood/EVM" : (isSol ? "Solana" : (isStark ? "Starknet" : "NEAR Mainnet"));
        await bot.telegram.sendMessage(
          row.telegram_id,
          `⚠️ <b>${chainName} Deposit Below Minimum Quote Threshold</b>\n` +
          `──────────────────────────\n` +
          `📥 <b>Received:</b> ${receivedStr}\n` +
          `🎯 <b>Minimum Required:</b> ${minRequiredStr}\n\n` +
          `1Click Defuse solvers cannot fulfill a deposit below the quote minimum and are issuing an automatic refund to your ${refundChainName} address:\n` +
          `<code>${row.refund_to}</code>\n\n` +
          `🔑 <b>Your Funds Are Safe & In Your Control:</b>\n` +
          `1. Go to <b>Settings & Help → Export Private Keys</b> (or /export_keys).\n` +
          `2. Enter your PIN to view your <code>ed25519:...</code> NEAR Private Key.\n` +
          `3. Import into Meteor Wallet (wallet.meteorwallet.app) or HERE Wallet on NEAR Mainnet.`,
          { parse_mode: "HTML" }
        ).catch(() => { });
      }

      if (TERMINAL_STATUSES.has(status)) {
        terminal++;
        if (bot && row.telegram_id) {
          const swap = st?.swapDetails || {};
          const inAmount = row.amount_token !== undefined && row.amount_token !== null ? Number(row.amount_token) : Number(row.amount_usdc);
          const actualIn = swap.depositedAmountFormatted || inAmount;
          const inSymbol = row.origin_symbol || (row.origin_asset?.includes("usdc") ? "USDC" : "tokens");

          const isHood = row.origin_asset && (row.origin_asset.includes("hood-") || row.origin_asset.includes("hood."));
          const isSol = row.origin_asset && row.origin_asset.includes("sol-");
          const isStark = row.origin_asset && (row.origin_asset.includes("starknet") || row.origin_asset.includes("strk") || row.origin_symbol === "STRK");
          const chainName = isHood ? "Robinhood Chain" : (isSol ? "Solana" : (isStark ? "Starknet" : "NEAR"));
          const routeName = isHood
            ? "Robinhood Chain → NEAR Intents (1Click) → Base USDC"
            : (isSol
              ? "Solana → NEAR Intents (1Click) → Base USDC"
              : (isStark
                ? "Starknet → NEAR Intents (1Click) → Base USDC"
                : "NEAR Intents (1Click) → Base USDC"));
          const refundChainName = isHood ? "Robinhood/EVM" : (isSol ? "Solana" : (isStark ? "Starknet" : "NEAR Mainnet"));

          if (status === "SUCCESS") {
            // Auto-settle any matching Merchant Checkout Session (NEAR Intents rail)
            try {
              const merchantCheckout = require("./merchant_checkout");
              await merchantCheckout.trySettleSessionByNearIntent(row);
            } catch (_) {}

            const actualOutNum = swap.amountOutFormatted ? Number(swap.amountOutFormatted) : (row.amount_out ? Number(row.amount_out) : null);
            const out = actualOutNum ? `$${actualOutNum.toFixed(2)}` : "your USDC";
            await bot.telegram.sendMessage(
              row.telegram_id,
              `🎉 <b>${chainName} Deposit Bridged!</b>\n` +
              `──────────────────────────\n` +
              `📥 <b>Deposited:</b> ${actualIn} ${inSymbol}\n` +
              `💰 <b>Converted to:</b> ${out} USDC arriving on Base\n` +
              `🌉 <b>Route:</b> ${routeName}\n` +
              `⏳ <b>Next:</b> Auto-sweeping to your Arc balance — you'll get a credit confirmation in about a minute.\n\n` +
              `<i>No action needed.</i>`,
              { parse_mode: "HTML" }
            ).catch(() => { });

            // Auto-trigger targeted Base -> Arc sweep with delayed retries (Base RPC can lag 1Click by a few blocks)
            try {
              const evmSweeper = require("./evm_deposit_sweeper");
              const sweepOpts = {
                force: true,
                onlyChain: "BASE",
                onlyAccountType: row.account_type || "personal",
              };
              const runRetrySweep = async () => {
                const delaysMs = process.env.NODE_ENV === "test" ? [10] : [5000, 15000, 40000];
                for (let attempt = 0; attempt < delaysMs.length; attempt++) {
                  await new Promise((r) => {
                    const t = setTimeout(r, delaysMs[attempt]);
                    if (t && typeof t.unref === "function") t.unref();
                  });
                  try {
                    const res = await evmSweeper.sweepUserDeposits(row.telegram_id, bot, sweepOpts);
                    if (Array.isArray(res) && res.some((r) => r && r.success)) {
                      return; // Swept cleanly to Arc!
                    }
                  } catch (sweepErr) {
                    console.warn(`[near:auto_sweep_attempt_${attempt + 1}]`, sweepErr.message);
                  }
                }
              };
              runRetrySweep().catch(() => {});
            } catch (_) { }
          } else if (status === "REFUNDED") {
            await bot.telegram.sendMessage(
              row.telegram_id,
              `↩️ <b>${chainName} Deposit Refunded</b>\n` +
              `──────────────────────────\n` +
              `Your deposit of ${inAmount} ${inSymbol} has been refunded to your ${refundChainName} address:\n` +
              `<code>${row.refund_to}</code>\n\n` +
              `🔑 <b>Access Your Funds on NEAR Mainnet:</b>\n` +
              `1. Go to <b>Settings & Help → Export Private Keys</b> (or /export_keys).\n` +
              `2. Enter your 4-digit PIN to copy your <code>ed25519:...</code> NEAR Private Key.\n` +
              `3. Import into Meteor Wallet (wallet.meteorwallet.app) or HERE Wallet on NEAR Mainnet.\n\n` +
              `<i>Your keys are exportable anytime via /export_keys (Self-Custodial Key Export Enabled).</i>`,
              { parse_mode: "HTML" }
            ).catch(() => { });
          } else {
            await bot.telegram.sendMessage(
              row.telegram_id,
              `❌ <b>${chainName} Deposit Failed</b>\n──────────────────────────\n` +
              `The bridge could not complete. Your funds were not lost — contact support with reference <code>${row.correlation_id || row.id}</code>.`,
              { parse_mode: "HTML" }
            ).catch(() => { });
          }
        }
      }
    } catch (err) {
      console.warn(`[near] Status poll note for deposit #${row.id}:`, err.message);
    }
  }

  return { updated, terminal };
}

/**
 * Recover deposits stuck in `awaiting_deposit` past their deadline:
 * keep polling (the solver auto-refunds by deadline, which the status poll
 * will pick up), but nudge the user once.
 */
async function expireStaleNearDeposits(bot = null) {
  const stale = db.getStaleNearDeposits();
  for (const row of stale) {
    db.updateNearDeposit(row.id, { status: "expired" });
    if (bot && row.telegram_id) {
      const inAmount = row.amount_token !== undefined && row.amount_token !== null ? Number(row.amount_token) : Number(row.amount_usdc);
      const inSymbol = row.origin_symbol || (row.origin_asset?.includes("usdc") ? "USDC" : "tokens");
      const isHood = row.origin_asset && (row.origin_asset.includes("hood-") || row.origin_asset.includes("hood."));
      const isSol = row.origin_asset && row.origin_asset.includes("sol-");
      const isStark = row.origin_asset && (row.origin_asset.includes("starknet") || row.origin_asset.includes("strk") || row.origin_symbol === "STRK");
      const chainName = isHood ? "Robinhood Chain" : (isSol ? "Solana" : (isStark ? "Starknet" : "NEAR"));
      const refundChainName = isHood ? "Robinhood/EVM" : (isSol ? "Solana" : (isStark ? "Starknet" : "NEAR"));

      await bot.telegram.sendMessage(
        row.telegram_id,
        `⏰ <b>${chainName} Deposit Window Expired</b>\n──────────────────────────\n` +
        `The deposit address for ${inAmount} ${inSymbol} was one-time and has expired.\n` +
        `<i>If you already sent funds, don't worry — they refund automatically to your ${refundChainName} refund address.</i>`,
        { parse_mode: "HTML" }
      ).catch(() => { });
    }
  }
  return stale.length;
}

/**
 * Create a Solana → Base USDC → Arc deposit via NEAR Intents 1Click.
 *
 * The user sends Solana tokens to the returned deposit address (a Solana address).
 * 1Click/Defuse swaps to Base USDC and delivers to the user's Arc address.
 * On failure, funds are refunded to the user's Solana address (refundTo).
 *
 * @param {object} p
 * @param {number|string} p.telegramId
 * @param {string} [p.accountType="personal"]
 * @param {string} p.originAsset      - Solana token assetId (sol-*.omft.near)
 * @param {string} p.originSymbol
 * @param {number} p.originDecimals
 * @param {number} p.amount           - human-readable amount
 * @param {string} p.recipientAddress - user's Arc/Base wallet (destination)
 * @param {string} p.refundTo         - user's Solana address (refund target)
 * @returns {Promise<object>} near_deposits row
 */
async function createSolanaDeposit({
  telegramId,
  accountType = "personal",
  originAsset,
  originSymbol,
  originDecimals,
  amount,
  recipientAddress,
  refundTo,
}) {
  if (!originAsset) throw new Error("originAsset required for Solana deposit");
  if (!refundTo) throw new Error("refundTo (Solana address) required for Solana deposit");

  const id = db.createNearDeposit({
    telegramId,
    accountType,
    originAsset,
    originSymbol,
    amountToken: amount,
    amountUsdc: amount,
    recipientAddress,
    refundTo,
    status: "quoting",
  });

  try {
    const baseUnits = toBaseUnits(amount, originDecimals);
    const quoteRes = await module.exports.getQuote({
      originAsset,
      destinationAsset: ASSETS.BASE_USDC,
      amount: baseUnits,
      recipient: recipientAddress,
      // Solana refund: refundType="ORIGIN_CHAIN" means refund to user's Solana address
      refundTo,
      dry: false,
    });
    const q = quoteRes?.quote || {};
    db.updateNearDeposit(id, {
      status: "awaiting_deposit",
      deposit_address: q.depositAddress || null,
      deposit_memo: q.depositMemo || null,
      amount_out: q.amountOut ? Number(q.amountOut) / 1e6 : null,
      quote_json: JSON.stringify(quoteRes),
      deadline: quoteRes?.quoteRequest?.deadline || null,
      correlation_id: quoteRes?.correlationId || null,
      origin_symbol: originSymbol,
      amount_token: Number(amount),
    });
    return db.getNearDepositById(id);
  } catch (err) {
    db.updateNearDeposit(id, { status: "failed", error: String(err.message).slice(0, 500) });
    throw err;
  }
}

/**
 * Create a Robinhood Chain → Base USDC → Arc deposit via NEAR Intents 1Click.
 *
 * The user sends Robinhood Chain tokens (USDG, ETH, WETH, USDe, PONS, CASHCAT)
 * to the returned deposit address (an EVM address on Robinhood Chain).
 * 1Click/Defuse swaps to Base USDC and delivers to the user's Arc/Base address.
 * On failure, funds are refunded to the user's Robinhood Chain EVM address (refundTo).
 *
 * @param {object} p
 * @param {number|string} p.telegramId
 * @param {string} [p.accountType="personal"]
 * @param {string} p.originAsset      - Robinhood token assetId (hood-*.omft.near or hood.omft.near)
 * @param {string} p.originSymbol
 * @param {number} p.originDecimals
 * @param {number} p.amount           - human-readable amount
 * @param {string} p.recipientAddress - user's Arc/Base wallet (destination)
 * @param {string} p.refundTo         - user's Robinhood/EVM address (refund target)
 * @returns {Promise<object>} near_deposits row
 */
async function createRobinhoodDeposit({
  telegramId,
  accountType = "personal",
  originAsset,
  originSymbol,
  originDecimals,
  amount,
  recipientAddress,
  refundTo,
}) {
  if (!originAsset) throw new Error("originAsset required for Robinhood Chain deposit");
  if (!refundTo) throw new Error("refundTo (Robinhood EVM address) required for Robinhood Chain deposit");

  const id = db.createNearDeposit({
    telegramId,
    accountType,
    originAsset,
    originSymbol,
    amountToken: amount,
    amountUsdc: amount,
    recipientAddress,
    refundTo,
    status: "quoting",
  });

  try {
    const baseUnits = toBaseUnits(amount, originDecimals);
    const quoteRes = await module.exports.getQuote({
      originAsset,
      destinationAsset: ASSETS.BASE_USDC,
      amount: baseUnits,
      recipient: recipientAddress,
      // Robinhood refund: refundType="ORIGIN_CHAIN" means refund to user's EVM address
      refundTo,
      dry: false,
    });
    const q = quoteRes?.quote || {};
    db.updateNearDeposit(id, {
      status: "awaiting_deposit",
      deposit_address: q.depositAddress || null,
      deposit_memo: q.depositMemo || null,
      amount_out: q.amountOut ? Number(q.amountOut) / 1e6 : null,
      quote_json: JSON.stringify(quoteRes),
      deadline: quoteRes?.quoteRequest?.deadline || null,
      correlation_id: quoteRes?.correlationId || null,
      origin_symbol: originSymbol,
      amount_token: Number(amount),
    });
    return db.getNearDepositById(id);
  } catch (err) {
    db.updateNearDeposit(id, { status: "failed", error: String(err.message).slice(0, 500) });
    throw err;
  }
}

/**
 * Create a Starknet → Base USDC → Arc deposit via NEAR Intents 1Click.
 *
 * The user sends Starknet tokens (STRK, ETH, etc.) to the returned deposit address (a Starknet address).
 * 1Click/Defuse swaps to Base USDC and delivers to the user's Arc/Base address.
 * On failure, funds are refunded to the user's Starknet address (refundTo).
 *
 * @param {object} p
 * @param {number|string} p.telegramId
 * @param {string} [p.accountType="personal"]
 * @param {string} p.originAsset      - Starknet token assetId (nep141:starknet.omft.near or 1cs_v1:starknet:*)
 * @param {string} p.originSymbol
 * @param {number} p.originDecimals
 * @param {number} p.amount           - human-readable amount
 * @param {string} p.recipientAddress - user's Arc/Base wallet (destination)
 * @param {string} p.refundTo         - user's Starknet address (refund target)
 * @returns {Promise<object>} near_deposits row
 */
async function createStarknetDeposit({
  telegramId,
  accountType = "personal",
  originAsset,
  originSymbol,
  originDecimals,
  amount,
  recipientAddress,
  refundTo,
}) {
  if (!originAsset) throw new Error("originAsset required for Starknet deposit");
  if (!refundTo) throw new Error("refundTo (Starknet address) required for Starknet deposit");

  const id = db.createNearDeposit({
    telegramId,
    accountType,
    originAsset,
    originSymbol,
    amountToken: amount,
    amountUsdc: amount,
    recipientAddress,
    refundTo,
    status: "quoting",
  });

  try {
    const baseUnits = toBaseUnits(amount, originDecimals);
    const quoteRes = await module.exports.getQuote({
      originAsset,
      destinationAsset: ASSETS.BASE_USDC,
      amount: baseUnits,
      recipient: recipientAddress,
      // Starknet refund: refundType="ORIGIN_CHAIN" means refund to user's Starknet address
      refundTo,
      dry: false,
    });
    const q = quoteRes?.quote || {};
    db.updateNearDeposit(id, {
      status: "awaiting_deposit",
      deposit_address: q.depositAddress || null,
      deposit_memo: q.depositMemo || null,
      amount_out: q.amountOut ? Number(q.amountOut) / 1e6 : null,
      quote_json: JSON.stringify(quoteRes),
      deadline: quoteRes?.quoteRequest?.deadline || null,
      correlation_id: quoteRes?.correlationId || null,
      origin_symbol: originSymbol,
      amount_token: Number(amount),
    });
    return db.getNearDepositById(id);
  } catch (err) {
    db.updateNearDeposit(id, { status: "failed", error: String(err.message).slice(0, 500) });
    throw err;
  }
}

// ─── Universal Multi-Chain NEAR Intents (1Click) Catalog & Deposit Creator ────

const INTENT_CHAIN_META = {
  sol: { key: "sol", name: "Solana", short: "SOL", isEvm: false, priority: 1, iconSymbol: "sol" },
  eth: { key: "eth", name: "Ethereum", short: "ETH", isEvm: true, priority: 2, iconSymbol: "eth" },
  base: { key: "base", name: "Base", short: "BASE", isEvm: true, priority: 3, iconSymbol: "eth" },
  btc: { key: "btc", name: "Bitcoin", short: "BTC", isEvm: false, priority: 4, iconSymbol: "btc" },
  bsc: { key: "bsc", name: "BNB Chain", short: "BNB", isEvm: true, priority: 5, iconSymbol: "bnb" },
  arb: { key: "arb", name: "Arbitrum", short: "ARB", isEvm: true, priority: 6, iconSymbol: "arb" },
  pol: { key: "pol", name: "Polygon", short: "POL", isEvm: true, priority: 7, iconSymbol: "matic" },
  op: { key: "op", name: "Optimism", short: "OP", isEvm: true, priority: 8, iconSymbol: "op" },
  tron: { key: "tron", name: "Tron", short: "TRX", isEvm: false, priority: 9, iconSymbol: "trx" },
  ton: { key: "ton", name: "TON", short: "TON", isEvm: false, priority: 10, iconSymbol: "ton" },
  avax: { key: "avax", name: "Avalanche", short: "AVAX", isEvm: true, priority: 11, iconSymbol: "avax" },
  near: { key: "near", name: "NEAR", short: "NEAR", isEvm: false, priority: 12, iconSymbol: "near" },
  sui: { key: "sui", name: "Sui", short: "SUI", isEvm: false, priority: 13, iconSymbol: "sui" },
  starknet: { key: "starknet", name: "Starknet", short: "STRK", isEvm: false, priority: 14, iconSymbol: "strk" },
  xrp: { key: "xrp", name: "XRP Ledger", short: "XRP", isEvm: false, priority: 15, iconSymbol: "xrp" },
  doge: { key: "doge", name: "Dogecoin", short: "DOGE", isEvm: false, priority: 16, iconSymbol: "doge" },
  ltc: { key: "ltc", name: "Litecoin", short: "LTC", isEvm: false, priority: 17, iconSymbol: "ltc" },
  bch: { key: "bch", name: "Bitcoin Cash", short: "BCH", isEvm: false, priority: 18, iconSymbol: "bch" },
  stellar: { key: "stellar", name: "Stellar", short: "XLM", isEvm: false, priority: 19, iconSymbol: "xlm" },
  cardano: { key: "cardano", name: "Cardano", short: "ADA", isEvm: false, priority: 20, iconSymbol: "ada" },
  aptos: { key: "aptos", name: "Aptos", short: "APT", isEvm: false, priority: 21, iconSymbol: "apt" },
  zec: { key: "zec", name: "Zcash", short: "ZEC", isEvm: false, priority: 22, iconSymbol: "zec" },
  hood: { key: "hood", name: "Robinhood Chain", short: "HOOD", isEvm: true, priority: 23, iconSymbol: "eth" },
  gnosis: { key: "gnosis", name: "Gnosis", short: "GNO", isEvm: true, priority: 24, iconSymbol: "gno" },
  bera: { key: "bera", name: "Berachain", short: "BERA", isEvm: true, priority: 25, iconSymbol: "bera" },
  scroll: { key: "scroll", name: "Scroll", short: "SCR", isEvm: true, priority: 26, iconSymbol: "eth" },
  monad: { key: "monad", name: "Monad", short: "MON", isEvm: true, priority: 27, iconSymbol: "mon" },
  xlayer: { key: "xlayer", name: "X Layer", short: "OKB", isEvm: true, priority: 28, iconSymbol: "okb" },
  dash: { key: "dash", name: "Dash", short: "DASH", isEvm: false, priority: 29, iconSymbol: "dash" },
  movement: { key: "movement", name: "Movement", short: "MOVE", isEvm: false, priority: 30, iconSymbol: "move" },
  aleo: { key: "aleo", name: "Aleo", short: "ALEO", isEvm: false, priority: 31, iconSymbol: "aleo" },
  hypercore: { key: "hypercore", name: "Hyperliquid", short: "HYPE", isEvm: false, priority: 32, iconSymbol: "hype" },
  plasma: { key: "plasma", name: "Plasma", short: "PLASMA", isEvm: true, priority: 33, iconSymbol: "usdt" },
  miden: { key: "miden", name: "Miden", short: "MIDEN", isEvm: false, priority: 34, iconSymbol: "miden" },
  abs: { key: "abs", name: "Abstract", short: "ABS", isEvm: true, priority: 35, iconSymbol: "eth" },
};

const CHAIN_ALIASES = {
  solana: "sol",
  ethereum: "eth",
  bitcoin: "btc",
  arbitrum: "arb",
  optimism: "op",
  polygon: "pol",
  matic: "pol",
  avalanche: "avax",
  bnb: "bsc",
  robinhood: "hood",
  trx: "tron",
  xlm: "stellar",
  ada: "cardano",
  apt: "aptos",
};

const TOKEN_LOGO_OVERRIDES = {
  USDC: "https://assets.coincap.io/assets/icons/usdc@2x.png",
  USDT: "https://assets.coincap.io/assets/icons/usdt@2x.png",
  ETH: "https://assets.coincap.io/assets/icons/eth@2x.png",
  WETH: "https://assets.coincap.io/assets/icons/weth@2x.png",
  BTC: "https://assets.coincap.io/assets/icons/btc@2x.png",
  WBTC: "https://assets.coincap.io/assets/icons/wbtc@2x.png",
  CBBTC: "https://assets.coincap.io/assets/icons/btc@2x.png",
  XBTC: "https://assets.coincap.io/assets/icons/btc@2x.png",
  SOL: "https://assets.coincap.io/assets/icons/sol@2x.png",
  NEAR: "https://assets.coincap.io/assets/icons/near@2x.png",
  WNEAR: "https://assets.coincap.io/assets/icons/near@2x.png",
  BNB: "https://assets.coincap.io/assets/icons/bnb@2x.png",
  POL: "https://assets.coincap.io/assets/icons/matic@2x.png",
  MATIC: "https://assets.coincap.io/assets/icons/matic@2x.png",
  ARB: "https://assets.coincap.io/assets/icons/arb@2x.png",
  OP: "https://assets.coincap.io/assets/icons/op@2x.png",
  AVAX: "https://assets.coincap.io/assets/icons/avax@2x.png",
  TRX: "https://assets.coincap.io/assets/icons/trx@2x.png",
  TON: "https://assets.coincap.io/assets/icons/ton@2x.png",
  SUI: "https://assets.coincap.io/assets/icons/sui@2x.png",
  XRP: "https://assets.coincap.io/assets/icons/xrp@2x.png",
  DOGE: "https://assets.coincap.io/assets/icons/doge@2x.png",
  LTC: "https://assets.coincap.io/assets/icons/ltc@2x.png",
  BCH: "https://assets.coincap.io/assets/icons/bch@2x.png",
  XLM: "https://assets.coincap.io/assets/icons/xlm@2x.png",
  ADA: "https://assets.coincap.io/assets/icons/ada@2x.png",
  APT: "https://assets.coincap.io/assets/icons/apt@2x.png",
  ZEC: "https://assets.coincap.io/assets/icons/zec@2x.png",
  STRK: "https://assets.coincap.io/assets/icons/strk@2x.png",
  DAI: "https://assets.coincap.io/assets/icons/dai@2x.png",
  LINK: "https://assets.coincap.io/assets/icons/link@2x.png",
  UNI: "https://assets.coincap.io/assets/icons/uni@2x.png",
  AAVE: "https://assets.coincap.io/assets/icons/aave@2x.png",
  PEPE: "https://assets.coincap.io/assets/icons/pepe@2x.png",
  SHIB: "https://assets.coincap.io/assets/icons/shib@2x.png",
  BONK: "https://assets.coincap.io/assets/icons/bonk@2x.png",
  WIF: "https://assets.coincap.io/assets/icons/wif@2x.png",
  DASH: "https://assets.coincap.io/assets/icons/dash@2x.png",
  GNO: "https://assets.coincap.io/assets/icons/gno@2x.png",
  EURC: "https://assets.coincap.io/assets/icons/eurc@2x.png",
  USDE: "https://assets.coincap.io/assets/icons/usde@2x.png",
  FRAX: "https://assets.coincap.io/assets/icons/frax@2x.png",
  OKB: "https://assets.coincap.io/assets/icons/okb@2x.png",
  AURORA: "https://assets.coincap.io/assets/icons/aurora@2x.png",
  SWEAT: "https://assets.coincap.io/assets/icons/sweat@2x.png",
};

function getTokenLogoUrl(symbol) {
  const clean = String(symbol || "").replace(/^\$/, "").toUpperCase();
  if (TOKEN_LOGO_OVERRIDES[clean]) return TOKEN_LOGO_OVERRIDES[clean];
  if (/^[A-Z0-9]{2,10}$/.test(clean)) {
    return `https://assets.coincap.io/assets/icons/${clean.toLowerCase()}@2x.png`;
  }
  return null;
}

function normalizeIntentChainKey(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return CHAIN_ALIASES[s] || s;
}

function getChainMeta(rawKey) {
  const key = normalizeIntentChainKey(rawKey);
  if (INTENT_CHAIN_META[key]) {
    const m = INTENT_CHAIN_META[key];
    return { ...m, logoUrl: getTokenLogoUrl(m.iconSymbol || m.short) };
  }
  return {
    key,
    name: key ? key.charAt(0).toUpperCase() + key.slice(1) : "Unknown",
    short: key.toUpperCase().slice(0, 6),
    isEvm: false,
    priority: 99,
    logoUrl: getTokenLogoUrl(key),
  };
}

let _cachedAllIntentCatalog = null;
let _cachedAllIntentCatalogExpiry = 0;

/**
 * Fetches and groups ALL blockchains and tokens live from NEAR Intents 1Click `/v0/tokens`,
 * enriched with token logos and chain metadata. Falls back cleanly to curated catalogs offline.
 */
async function getAllSupportedIntentTokens(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cachedAllIntentCatalog && now < _cachedAllIntentCatalogExpiry) {
    return _cachedAllIntentCatalog;
  }

  let rawTokens = [];
  try {
    const axios = require("axios");
    const key = getApiKey();
    const headers = { "Content-Type": "application/json" };
    if (key) headers["Authorization"] = `Bearer ${key}`;
    const res = await axios({
      method: "GET",
      url: `${getApiBaseUrl()}/v0/tokens`,
      timeout: 5000,
      headers,
    });
    if (Array.isArray(res.data)) rawTokens = res.data;
  } catch (_) {
    // Fallback to built-in catalogs below
  }

  const byChain = new Map();
  const seenAssetIds = new Set();

  const addToken = (item) => {
    const chainKey = normalizeIntentChainKey(item.blockchain);
    if (!chainKey || !item.assetId) return;
    const dedupeKey = `${chainKey}:${String(item.assetId).toLowerCase()}`;
    if (seenAssetIds.has(dedupeKey)) return;
    seenAssetIds.add(dedupeKey);

    const symbol = String(item.symbol || "TOKEN").trim();
    const priceUsd = item.price !== undefined && item.price !== null ? Number(item.price) : (item.priceUsd !== undefined ? Number(item.priceUsd) : null);
    const entry = {
      symbol,
      name: item.name || `${symbol} (${getChainMeta(chainKey).name})`,
      assetId: item.assetId,
      decimals: Number(item.decimals ?? 6),
      blockchain: chainKey,
      contractAddress: item.contractAddress || null,
      priceUsd: Number.isFinite(priceUsd) ? priceUsd : null,
      logoUrl: getTokenLogoUrl(symbol),
    };
    if (!byChain.has(chainKey)) byChain.set(chainKey, []);
    byChain.get(chainKey).push(entry);
  };

  for (const item of rawTokens) addToken(item);
  // Ensure curated tokens are always present if live fetch was unavailable or partial
  for (const t of [...SUPPORTED_SOLANA_TOKENS, ...SUPPORTED_NEAR_TOKENS, ...SUPPORTED_ROBINHOOD_TOKENS, ...SUPPORTED_STARKNET_TOKENS]) {
    addToken(t);
  }

  const POPULAR_SYMBOLS = new Map([
    ["USDC", 1], ["USDT", 2], ["ETH", 3], ["BTC", 4], ["SOL", 5], ["BNB", 6],
    ["NEAR", 7], ["WNEAR", 8], ["TRX", 9], ["TON", 10], ["SUI", 11], ["AVAX", 12],
    ["POL", 13], ["ARB", 14], ["OP", 15], ["XRP", 16], ["DOGE", 17], ["LTC", 18],
    ["ADA", 19], ["XLM", 20], ["APT", 21], ["STRK", 22], ["ZEC", 23], ["WBTC", 24],
    ["WETH", 25], ["USDG", 26], ["DAI", 27],
  ]);

  const chains = [];
  const tokensByChain = {};
  for (const [chainKey, list] of byChain.entries()) {
    list.sort((a, b) => {
      const pa = POPULAR_SYMBOLS.get(a.symbol.toUpperCase()) ?? 99;
      const pb = POPULAR_SYMBOLS.get(b.symbol.toUpperCase()) ?? 99;
      if (pa !== pb) return pa - pb;
      return a.symbol.localeCompare(b.symbol);
    });
    const meta = getChainMeta(chainKey);
    chains.push({
      key: chainKey,
      name: meta.name,
      short: meta.short,
      isEvm: meta.isEvm,
      priority: meta.priority,
      logoUrl: meta.logoUrl,
      tokenCount: list.length,
    });
    tokensByChain[chainKey] = list;
  }

  chains.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  const result = { chains, tokensByChain };
  _cachedAllIntentCatalog = result;
  _cachedAllIntentCatalogExpiry = now + 10 * 60 * 1000;
  return result;
}

async function resolveIntentToken({ chain = null, symbol = null, assetId = null }) {
  const catalog = await getAllSupportedIntentTokens();
  if (assetId) {
    const target = String(assetId).trim().toLowerCase();
    for (const list of Object.values(catalog.tokensByChain)) {
      const hit = list.find((t) => t.assetId.toLowerCase() === target);
      if (hit) return hit;
    }
  }
  if (chain && symbol) {
    const ck = normalizeIntentChainKey(chain);
    const sym = String(symbol).trim().toUpperCase();
    const list = catalog.tokensByChain[ck] || [];
    const hit = list.find((t) => t.symbol.toUpperCase() === sym);
    if (hit) return hit;
  }
  return null;
}

async function createUniversalCryptoDeposit({
  telegramId,
  accountType = "personal",
  originAsset,
  originSymbol,
  originDecimals,
  amount,
  recipientAddress,
  refundTo,
  refundType = "ORIGIN_CHAIN",
}) {
  if (!originAsset) throw new Error("originAsset is required");
  if (!refundTo) throw new Error("refundTo is required");

  const id = db.createNearDeposit({
    telegramId,
    accountType,
    originAsset,
    originSymbol,
    amountToken: amount,
    amountUsdc: amount,
    recipientAddress,
    refundTo,
    status: "quoting",
  });

  try {
    const baseUnits = toBaseUnits(amount, originDecimals);
    const quoteRes = await module.exports.getQuote({
      originAsset,
      destinationAsset: ASSETS.BASE_USDC,
      amount: baseUnits,
      recipient: recipientAddress,
      refundTo,
      refundType,
      dry: false,
    });
    const q = quoteRes?.quote || {};
    db.updateNearDeposit(id, {
      status: "awaiting_deposit",
      deposit_address: q.depositAddress || null,
      deposit_memo: q.depositMemo || null,
      amount_out: q.amountOut ? Number(q.amountOut) / 1e6 : null,
      quote_json: JSON.stringify(quoteRes),
      deadline: quoteRes?.quoteRequest?.deadline || null,
      correlation_id: quoteRes?.correlationId || null,
      origin_symbol: originSymbol,
      amount_token: Number(amount),
    });
    return db.getNearDepositById(id);
  } catch (err) {
    db.updateNearDeposit(id, { status: "failed", error: String(err.message).slice(0, 500) });
    throw err;
  }
}

module.exports = {
  ASSETS,
  SUPPORTED_NEAR_TOKENS,
  SUPPORTED_SOLANA_TOKENS,
  SUPPORTED_ROBINHOOD_TOKENS,
  SUPPORTED_STARKNET_TOKENS,
  TERMINAL_STATUSES,
  toBaseUnits,
  getNearFeeRecipient,
  getNearFeeBps,
  getTokenLogoUrl,
  getChainMeta,
  normalizeIntentChainKey,
  getAllSupportedIntentTokens,
  resolveIntentToken,
  getSupportedNearTokens,
  getSupportedSolanaTokens,
  getSupportedRobinhoodTokens,
  getSupportedStarknetTokens,
  resolveNearToken,
  resolveSolanaToken,
  resolveRobinhoodToken,
  resolveStarknetToken,
  isNearAddress,
  deriveNearAddress,
  deriveStarknetAddress,
  getNearAccountBalance,
  getQuote,
  getExecutionStatus,
  createNearDeposit,
  createSolanaDeposit,
  createRobinhoodDeposit,
  createStarknetDeposit,
  createUniversalCryptoDeposit,
  pollPendingNearDeposits,
  expireStaleNearDeposits,
  apiRequest,
  __test_apiRequest: apiRequest,
};

