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
const db = require("./db");

const DEFAULT_API_URL = "https://1click.chaindefuser.com";

// Asset IDs on the 1Click token registry (overridable via env).
const ASSETS = {
  NEAR_USDC: process.env.NEAR_INTENTS_USDC || "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  NEAR_USDT: process.env.NEAR_INTENTS_USDT || "nep141:usdt.tether-token.near",
  NEAR_WNEAR: process.env.NEAR_INTENTS_WNEAR || "nep141:wrap.near",
  BASE_USDC: process.env.NEAR_INTENTS_BASE_USDC || "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  ARB_USDC: process.env.NEAR_INTENTS_ARB_USDC || "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  // Solana native tokens via NEAR Intents (omft.near bridge)
  SOL_NATIVE: process.env.NEAR_INTENTS_SOL || "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  SOL_USDC: process.env.NEAR_INTENTS_SOL_USDC || "nep141:sol-epcrhbpnlmxqtqljmohe4hfzs4etwe7qkpnvqwqfqmfwjr.omft.near",
  SOL_USDT: process.env.NEAR_INTENTS_SOL_USDT || "nep141:sol-es9vmfrzacermjfrf4h4qmzezaqsf3s9a9jiqvtqx3fcd.omft.near",
  // Robinhood Chain tokens via NEAR Intents (omft.near bridge)
  HOOD_USDG: process.env.NEAR_INTENTS_HOOD_USDG || "nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near",
  HOOD_ETH: process.env.NEAR_INTENTS_HOOD_ETH || "nep141:hood.omft.near",
  HOOD_WETH: process.env.NEAR_INTENTS_HOOD_WETH || "nep141:hood-0x0bd7d308f8e1639fab988df18a8011f41eacad73.omft.near",
  HOOD_USDE: process.env.NEAR_INTENTS_HOOD_USDE || "nep141:hood-0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34.omft.near",
  HOOD_PONS: process.env.NEAR_INTENTS_HOOD_PONS || "nep141:hood-0x39dbed3a2bd333467115de45665cc57f813c4571.omft.near",
  HOOD_CASHCAT: process.env.NEAR_INTENTS_HOOD_CASHCAT || "nep141:hood-0x020bfc650a365f8bb26819deaabf3e21291018b4.omft.near",
  // Starknet tokens via NEAR Intents (1Click)
  STARKNET_STRK: process.env.NEAR_INTENTS_STARKNET_STRK || "nep141:starknet.omft.near",
  STARKNET_ETH: process.env.NEAR_INTENTS_STARKNET_ETH || "1cs_v1:starknet:erc20:0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  STARKNET_ZEC: process.env.NEAR_INTENTS_STARKNET_ZEC || "1cs_v1:starknet:erc20:0x05ce53b9b68fb8e9ecab9283a96d97948914733fd6ed8d9a53a276a419497841",
  STARKNET_XRP: process.env.NEAR_INTENTS_STARKNET_XRP || "1cs_v1:starknet:erc20:0x07bc19585817a78f2304b2f3b31f954d80e8a1eff6e8d81a84eb5cedb7267728",
};

// Known popular NEAR tokens supported by 1Click / Defuse solvers.
const SUPPORTED_NEAR_TOKENS = [
  {
    symbol: "USDC",
    name: "USD Coin (Native)",
    assetId: ASSETS.NEAR_USDC,
    decimals: 6,
    icon: "💵",
    minDeposit: 2,
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    assetId: ASSETS.NEAR_USDT,
    decimals: 6,
    icon: "🟢",
    minDeposit: 2,
  },
  {
    symbol: "NEAR",
    name: "NEAR Protocol / wNEAR",
    assetId: ASSETS.NEAR_WNEAR,
    decimals: 24,
    icon: "Ⓝ",
    minDeposit: 0.5,
  },
  {
    symbol: "WBTC",
    name: "Wrapped Bitcoin",
    assetId: process.env.NEAR_INTENTS_WBTC || "nep141:btc.omft.near",
    decimals: 8,
    icon: "🪙",
    minDeposit: 0.0001,
  },
  {
    symbol: "WETH",
    name: "Wrapped Ethereum",
    assetId: process.env.NEAR_INTENTS_WETH || "nep141:eth.omft.near",
    decimals: 18,
    icon: "🔷",
    minDeposit: 0.001,
  },
  {
    symbol: "DAI",
    name: "Dai Stablecoin",
    assetId: process.env.NEAR_INTENTS_DAI || "nep141:6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near",
    decimals: 18,
    icon: "🟡",
    minDeposit: 2,
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
    symbol: "BONK",
    name: "Bonk",
    assetId: process.env.NEAR_INTENTS_SOL_BONK || "nep141:sol-bonkfxp8vbpq9xtnv1mseqbm6bhkq6dkn6xxuqj2jbxs.omft.near",
    decimals: 5,
    icon: "🐕",
    minDeposit: 500000,
    blockchain: "sol",
  },
  {
    symbol: "WIF",
    name: "dogwifhat",
    assetId: process.env.NEAR_INTENTS_SOL_WIF || "nep141:sol-ekcabpgahfkbp9b8a2lbxbkxjagxauqnqjegkqtajzxw.omft.near",
    decimals: 6,
    icon: "🎩",
    minDeposit: 1,
    blockchain: "sol",
  },
  {
    symbol: "JUP",
    name: "Jupiter",
    assetId: process.env.NEAR_INTENTS_SOL_JUP || "nep141:sol-jupsolfjlxxbpufjp4lazamkbsfepd3ntptunnnzufka.omft.near",
    decimals: 6,
    icon: "🪐",
    minDeposit: 2,
    blockchain: "sol",
  },
  {
    symbol: "PYTH",
    name: "Pyth Network",
    assetId: process.env.NEAR_INTENTS_SOL_PYTH || "nep141:sol-hz1jqxmjmpvwf8vfatbfwcqhebmxeqb7r7q3yfmjkxb8.omft.near",
    decimals: 6,
    icon: "🔮",
    minDeposit: 2,
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
    symbol: "ETH",
    name: "Ethereum (Starknet)",
    assetId: ASSETS.STARKNET_ETH,
    decimals: 18,
    icon: "🔷",
    minDeposit: 0.001,
    blockchain: "starknet",
    contractAddress: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
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
 * Default 50 bps (0.50%), configurable via NEAR_INTENT_FEE_BPS.
 */
function getNearFeeBps() {
  const bps = Number(process.env.NEAR_INTENT_FEE_BPS ?? 50);
  return isNaN(bps) || bps < 0 ? 50 : Math.min(bps, 500);
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
      const isNear =
        item.blockchain === "near" ||
        (typeof item.assetId === "string" && item.assetId.startsWith("nep141:"));
      if (!isNear) continue;

      const sym = (item.symbol || "").toUpperCase();
      const existing = tokenMap.get(sym);
      const entry = {
        symbol: sym || "TOKEN",
        name: item.name || sym,
        assetId: item.assetId,
        decimals: Number(item.decimals ?? 6),
        icon: sym === "NEAR" ? "Ⓝ" : sym === "USDT" ? "🟢" : sym.includes("USD") ? "💵" : sym === "WBTC" ? "🪙" : sym === "WETH" ? "🔷" : "🪙",
        priceUsd: item.price ? Number(item.price) : undefined,
        minDeposit: existing?.minDeposit ?? 1,
      };
      tokenMap.set(sym, entry);
      tokenMap.set(item.assetId.toLowerCase(), entry);
    }
  } catch (_) {
    // Dynamic endpoint fallback to standard catalog
  }

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

/**
 * Fetch Solana tokens supported by 1Click. Returns static catalog merged with
 * any extra sol-blockchain tokens from the /v0/tokens endpoint.
 */
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

  const tokens = await getSupportedNearTokens();
  const bySymbol = tokens.find((t) => t.symbol.toUpperCase() === qUpper);
  if (bySymbol) return bySymbol;

  const byAssetId = tokens.find((t) => t.assetId.toLowerCase() === qLower);
  if (byAssetId) return byAssetId;

  if (q.startsWith("nep141:") || q.endsWith(".near")) {
    const assetId = q.startsWith("nep141:") ? q : `nep141:${q}`;
    const cleanSym = (q.split(/[:.]/)[1] || "TOKEN").toUpperCase();
    return {
      symbol: cleanSym,
      name: q,
      assetId,
      decimals: 18,
      icon: "🪙",
      minDeposit: 0.1,
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
function deriveNearAddress(evmPrivateKey) {
  if (!evmPrivateKey) throw new Error("EVM private key required to derive NEAR address");
  const cleanHex = evmPrivateKey.startsWith("0x") ? evmPrivateKey.slice(2) : evmPrivateKey;
  const keyBuffer = Buffer.from(cleanHex, "hex");

  const hmac = crypto.createHmac("sha512", Buffer.from("Proxim-NEAR-Intent-Bridge-Salt", "utf8"));
  hmac.update(keyBuffer);
  const seed32 = hmac.digest().subarray(0, 32);

  const naclKeypair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(seed32));
  const publicKeyHex = Buffer.from(naclKeypair.publicKey).toString("hex");
  return {
    nearAddress: publicKeyHex.toLowerCase(),
    publicKeyHex: publicKeyHex.toLowerCase(),
    secretKeyHex: Buffer.from(naclKeypair.secretKey).toString("hex"),
  };
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
async function getQuote({ originAsset, destinationAsset, amount, recipient, refundTo, dry = false, appFees = null }) {
  let resolvedAppFees = appFees;
  if (!resolvedAppFees) {
    const feeRecipient = getNearFeeRecipient();
    const feeBps = getNearFeeBps();
    if (feeRecipient && feeBps > 0) {
      resolvedAppFees = [{ recipient: feeRecipient, fee: feeBps }];
    }
  }

  const payload = {
    dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: Number(process.env.NEAR_INTENT_SLIPPAGE_BPS || 100),
    originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset,
    amount: String(amount),
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: defaultDeadline(),
  };

  if (resolvedAppFees && resolvedAppFees.length > 0) {
    payload.appFees = resolvedAppFees;
  }

  return apiRequest("POST", "/v0/quote", payload);
}

/**
 * Check swap execution status for a deposit address.
 * @returns {Promise<{status: string, swapDetails?: object}>}
 */
async function getExecutionStatus(depositAddress, depositMemo) {
  const qs = new URLSearchParams({ depositAddress });
  if (depositMemo) qs.set("depositMemo", depositMemo);
  return apiRequest("GET", `/v0/status?${qs.toString()}`);
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
  const chosenAmount = amount !== undefined && amount !== null ? amount : amountUsdc;
  const chosenAsset = originAsset || ASSETS.NEAR_USDC;

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

      if (TERMINAL_STATUSES.has(status)) {
        terminal++;
        if (bot && row.telegram_id) {
          const swap = st?.swapDetails || {};
          const inAmount = row.amount_token !== undefined && row.amount_token !== null ? Number(row.amount_token) : Number(row.amount_usdc);
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
          const refundChainName = isHood ? "Robinhood/EVM" : (isSol ? "Solana" : (isStark ? "Starknet" : "NEAR"));

          if (status === "SUCCESS") {
            const out = row.amount_out ? `$${row.amount_out.toFixed(2)}` : "your USDC";
            await bot.telegram.sendMessage(
              row.telegram_id,
              `🎉 <b>${chainName} Deposit Bridged!</b>\n` +
              `──────────────────────────\n` +
              `📥 <b>Deposited:</b> ${inAmount} ${inSymbol}\n` +
              `💰 <b>Converted to:</b> ${out} USDC arriving on Base\n` +
              `🌉 <b>Route:</b> ${routeName}\n` +
              `⏳ <b>Next:</b> Auto-sweeping to your Arc balance — you'll get a credit confirmation in about a minute.\n\n` +
              `<i>No action needed.</i>`,
              { parse_mode: "HTML" }
            ).catch(() => {});

            // Auto-trigger background EVM sweep immediately with gas sponsorship
            try {
              const evmSweeper = require("./evm_deposit_sweeper");
              evmSweeper.sweepUserDeposits(row.telegram_id, bot, { force: true }).catch((sweepErr) => {
                console.warn("[near:auto_sweep_trigger_error]", sweepErr.message);
              });
            } catch (_) {}
          } else if (status === "REFUNDED") {
            await bot.telegram.sendMessage(
              row.telegram_id,
              `↩️ <b>${chainName} Deposit Refunded</b>\n` +
              `──────────────────────────\n` +
              `Your deposit of ${inAmount} ${inSymbol} was refunded to your ${refundChainName} refund address:\n` +
              `<code>${row.refund_to}</code>\n\n` +
              `<i>Contact support if you need help moving it back.</i>`,
              { parse_mode: "HTML" }
            ).catch(() => {});
          } else {
            await bot.telegram.sendMessage(
              row.telegram_id,
              `❌ <b>${chainName} Deposit Failed</b>\n──────────────────────────\n` +
              `The bridge could not complete. Your funds were not lost — contact support with reference <code>${row.correlation_id || row.id}</code>.`,
              { parse_mode: "HTML" }
            ).catch(() => {});
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
      ).catch(() => {});
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
  getSupportedNearTokens,
  getSupportedSolanaTokens,
  getSupportedRobinhoodTokens,
  getSupportedStarknetTokens,
  resolveNearToken,
  resolveSolanaToken,
  resolveRobinhoodToken,
  resolveStarknetToken,
  deriveNearAddress,
  deriveStarknetAddress,
  getQuote,
  getExecutionStatus,
  createNearDeposit,
  createSolanaDeposit,
  createRobinhoodDeposit,
  createStarknetDeposit,
  pollPendingNearDeposits,
  expireStaleNearDeposits,
};

