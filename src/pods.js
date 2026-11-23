// src/pods.js
// Pods Finance Investments API Client
// Powers:
//   1. Ondo Global Markets Tokenized US Stocks & ETFs (471 tickers on BSC, cross-chain funded from Base USDC)
//   2. Insured Dollar Savings (OpenCover) & High-Yield Treasury/USDC Vaults
//   3. Portfolio & PnL Tracking + Action Status Polling + Webhook HMAC Verification

const crypto = require("node:crypto");
const axios = require("axios");

const PODS_API_URL = (process.env.PODS_API_URL || "https://api.pods.finance").replace(/\/+$/, "");

const BASE_CHAIN_ID = 8453;
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BSC_CHAIN_ID = 56;
const BSC_USDC_ADDRESS = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";

const MIN_STOCK_BUY_USD = 10;
const MIN_VAULT_DEPOSIT_USD = 1;

const POPULAR_STOCKS = [
  { ticker: "AAPL", name: "Apple Inc.", icon: "🍎" },
  { ticker: "NVDA", name: "NVIDIA Corp.", icon: "💚" },
  { ticker: "TSLA", name: "Tesla Inc.", icon: "🚗" },
  { ticker: "MSFT", name: "Microsoft Corp.", icon: "🪟" },
  { ticker: "AMZN", name: "Amazon.com", icon: "📦" },
  { ticker: "GOOGL", name: "Alphabet (Google)", icon: "🔍" },
  { ticker: "META", name: "Meta Platforms", icon: "♾️" },
  { ticker: "SPY", name: "S&P 500 ETF", icon: "🇺🇸" },
  { ticker: "QQQ", name: "Nasdaq-100 ETF", icon: "⚡" },
  { ticker: "NFLX", name: "Netflix Inc.", icon: "🎬" },
  { ticker: "COIN", name: "Coinbase Global", icon: "🪙" },
  { ticker: "AMD", name: "AMD Inc.", icon: "🔴" },
];

const CURATED_SAVINGS_VAULTS = [
  {
    id: "Sky-CoveredSavingsDAI-gnosis",
    shortId: "insured",
    name: "Insured Dollar Savings",
    badge: "🛡️ OpenCover Insured",
    network: "gnosis",
    chainId: 100,
    lockPeriod: "No lockup",
    unlockPeriod: "~1 min settlement",
    riskLabel: "Low · Principal Insured (1% of yield)",
    depositAction: "request-lend",
    withdrawAction: "request-withdraw",
  },
  {
    id: "Theo-thbill-arbitrum",
    shortId: "tbill",
    name: "US Treasury Bills (thBILL)",
    badge: "🏛️ Tokenized T-Bills",
    network: "arbitrum",
    chainId: 42161,
    lockPeriod: "No lockup",
    unlockPeriod: "~1–3 min cross-chain",
    riskLabel: "Low · US Treasury Backed",
    depositAction: "lend",
    withdrawAction: "withdraw",
  },
  {
    id: "YO-yoUSD-base",
    shortId: "yousd",
    name: "Base Liquid USD (YO)",
    badge: "⚡ Instant Liquid",
    network: "base",
    chainId: 8453,
    lockPeriod: "No lockup",
    unlockPeriod: "Instant (same-block)",
    riskLabel: "Low–Medium · Native Base",
    depositAction: "lend",
    withdrawAction: "withdraw",
  },
  {
    id: "Aave-USDC-base",
    shortId: "aave",
    name: "Aave USDC Savings",
    badge: "🔵 Blue-Chip DeFi",
    network: "base",
    chainId: 8453,
    lockPeriod: "No lockup",
    unlockPeriod: "Instant (same-block)",
    riskLabel: "Low · Battle-Tested Lending",
    depositAction: "lend",
    withdrawAction: "withdraw",
  },
  {
    id: "Lido-EarnUSD-ethereum",
    shortId: "earnusd",
    name: "High-Yield USD (EarnUSD)",
    badge: "📈 Highest Yield",
    network: "ethereum",
    chainId: 1,
    lockPeriod: "24h deposit settle",
    unlockPeriod: "Up to 72h withdrawal",
    riskLabel: "Medium · Curated Multi-Strategy",
    depositAction: "request-lend",
    withdrawAction: "request-withdraw",
  },
];

let _stockCatalogCache = { fetchedAt: 0, items: [] };
let _vaultApyCache = { fetchedAt: 0, map: new Map() };

function isConfigured() {
  return Boolean(process.env.PODS_API_KEY && String(process.env.PODS_API_KEY).trim().length > 0);
}

/**
 * Feature gate: hidden from general users until PODS_INVESTMENTS_ENABLED=true.
 * Admins/testers can preview privately by adding their Telegram ID to PODS_ALLOWED_TELEGRAM_IDS.
 */
function isInvestmentsEnabledForUser(telegramId) {
  if (!isConfigured()) return false;
  if (String(process.env.PODS_INVESTMENTS_ENABLED || "").toLowerCase() === "true") {
    return true;
  }
  const allowRaw = String(process.env.PODS_ALLOWED_TELEGRAM_IDS || "").trim();
  if (!allowRaw || !telegramId) return false;
  const allowed = new Set(allowRaw.split(",").map((s) => s.trim()).filter(Boolean));
  return allowed.has(String(telegramId));
}

function getClient() {
  const apiKey = String(process.env.PODS_API_KEY || "").trim();
  if (!apiKey) throw new Error("PODS_API_KEY is not configured");
  return axios.create({
    baseURL: PODS_API_URL,
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });
}

function normalizeTicker(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/^\$/, "")
    .replace(/ON$/i, "")
    .replace(/[^A-Z0-9.-]/g, "");
}

function toOndoStrategyId(ticker) {
  return `Ondo-${normalizeTicker(ticker)}-bsc`;
}

function toOndoMarketSymbol(ticker) {
  return `${normalizeTicker(ticker)}on`;
}

/**
 * Fetch and cache all Ondo Global Markets stock strategies enabled on this API key.
 */
async function getStocksCatalog(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _stockCatalogCache.items.length > 0 && now - _stockCatalogCache.fetchedAt < 10 * 60 * 1000) {
    return _stockCatalogCache.items;
  }
  const client = getClient();
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const { data } = await client.get("/strategies", {
      params: { protocol: "Ondo", page, limit: 100 },
    });
    const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    if (!rows.length) break;
    for (const s of rows) {
      const m = String(s.id || "").match(/^Ondo-([A-Za-z0-9.-]+)-bsc$/i);
      if (!m) continue;
      const ticker = m[1].toUpperCase();
      if (ticker === "USDON" || ticker === "USD") continue;
      const popular = POPULAR_STOCKS.find((p) => p.ticker === ticker);
      items.push({
        id: s.id,
        ticker,
        marketSymbol: `${ticker}on`,
        name: popular?.name || s.assetName || s.name || ticker,
        icon: popular?.icon || "📈",
        network: s.network || "bsc",
        asset: s.asset || null,
        paused: Boolean(s.paused),
      });
    }
    if (rows.length < 100) break;
  }
  _stockCatalogCache = { fetchedAt: now, items };
  return items;
}

/**
 * Search Ondo stocks by ticker or company name.
 */
async function searchStocks(query, limit = 10) {
  const q = String(query || "").trim().toUpperCase().replace(/^\$/, "");
  const catalog = await getStocksCatalog();
  if (!q) {
    const popSet = new Set(POPULAR_STOCKS.map((p) => p.ticker));
    return POPULAR_STOCKS.map((p) => catalog.find((c) => c.ticker === p.ticker) || {
      id: toOndoStrategyId(p.ticker),
      ticker: p.ticker,
      marketSymbol: toOndoMarketSymbol(p.ticker),
      name: p.name,
      icon: p.icon,
      network: "bsc",
    }).filter((x) => !catalog.length || popSet.has(x.ticker)).slice(0, limit);
  }

  const exact = catalog.filter((s) => s.ticker === q);
  const starts = catalog.filter((s) => s.ticker !== q && (s.ticker.startsWith(q) || s.name.toUpperCase().startsWith(q)));
  const contains = catalog.filter(
    (s) => s.ticker !== q && !s.ticker.startsWith(q) && !s.name.toUpperCase().startsWith(q) &&
      (s.ticker.includes(q) || s.name.toUpperCase().includes(q))
  );
  return [...exact, ...starts, ...contains].slice(0, limit);
}

/**
 * Fetch live market status, price, 24h change, and tradability for an Ondo stock.
 */
async function getStockMarketStatus(ticker) {
  const clean = normalizeTicker(ticker);
  const symbol = toOndoMarketSymbol(clean);
  const client = getClient();
  const { data } = await client.get("/ondo/stocks/market-status", { params: { symbol } });
  const primary = data?.asset?.marketData?.primaryMarket || {};
  return {
    ticker: clean,
    symbol,
    isOpen: Boolean(data?.isOpen),
    marketStatus: data?.marketStatus || "unknown",
    nextOpen: data?.nextOpen || null,
    nextClose: data?.nextClose || null,
    tradable: Boolean(data?.asset?.tradable),
    paused: Boolean(data?.asset?.paused),
    blockingReason: data?.asset?.blockingReason || null,
    price: primary.price != null ? Number(primary.price) : null,
    priceChange24h: primary.priceChange24h != null ? Number(primary.priceChange24h) : null,
    priceChangePct24h: primary.priceChangePct24h != null ? Number(primary.priceChangePct24h) : null,
    raw: data,
  };
}

/**
 * Fetch live strategy details & wallet position (balance, avgPurchasePrice, profit, APY).
 */
async function getStrategyPosition(strategyId, wallet = null) {
  const client = getClient();
  const params = wallet ? { wallet } : {};
  const { data } = await client.get(`/v2/strategies/${encodeURIComponent(strategyId)}`, { params });
  const sp = data?.spotPosition || {};
  const st = data?.strategy || data || {};
  return {
    strategyId,
    protocol: st.protocol || null,
    network: st.network || null,
    assetName: st.assetName || null,
    paused: Boolean(st.paused),
    apy: sp.apy != null ? Number(sp.apy) : (st.apy != null ? Number(st.apy) : 0),
    currentPosition: sp.currentPosition != null ? Number(sp.currentPosition) : 0,
    currentPositionUsd: sp.currentPositionUsd != null ? Number(sp.currentPositionUsd) : null,
    avgPurchasePrice: sp.avgPurchasePrice != null ? Number(sp.avgPurchasePrice) : null,
    profit: sp.profit != null ? Number(sp.profit) : 0,
    requestedToLend: sp.requestedToLend != null ? Number(sp.requestedToLend) : 0,
    requestedToWithdraw: sp.requestedToWithdraw != null ? Number(sp.requestedToWithdraw) : 0,
    raw: data,
  };
}

/**
 * Fetch live APYs for all curated savings vaults (cached 5 min).
 */
async function getCuratedSavingsVaults(forceRefresh = false) {
  const now = Date.now();
  if (forceRefresh || _vaultApyCache.map.size === 0 || now - _vaultApyCache.fetchedAt > 5 * 60 * 1000) {
    const client = getClient();
    const results = await Promise.allSettled(
      CURATED_SAVINGS_VAULTS.map((v) => client.get(`/v2/strategies/${encodeURIComponent(v.id)}`))
    );
    const nextMap = new Map();
    results.forEach((res, idx) => {
      const vault = CURATED_SAVINGS_VAULTS[idx];
      if (res.status === "fulfilled") {
        const d = res.value.data || {};
        const apy = d.spotPosition?.apy ?? d.strategy?.apy ?? 0;
        nextMap.set(vault.id, { apy: Number(apy) || 0, paused: Boolean(d.strategy?.paused) });
      }
    });
    _vaultApyCache = { fetchedAt: now, map: nextMap };
  }
  return CURATED_SAVINGS_VAULTS.map((v) => {
    const live = _vaultApyCache.map.get(v.id) || { apy: 0, paused: false };
    return {
      ...v,
      apy: live.apy,
      apyPct: (live.apy * 100).toFixed(2),
      paused: live.paused,
    };
  });
}

function getSavingsVaultByShortId(shortId) {
  return CURATED_SAVINGS_VAULTS.find((v) => v.shortId === shortId || v.id === shortId) || null;
}

/**
 * Generate atomic bytecode + quote for a Pods strategy action (stock buy/sell or vault deposit/withdraw).
 */
async function getStrategyBytecode({
  strategyId,
  action,
  amount,
  wallet,
  fromChainId = null,
  fromTokenAddress = null,
  toChainId = null,
  toTokenAddress = null,
  destinationAddress = null,
  slippage = null,
  webhookURL = null,
}) {
  const client = getClient();
  const params = {
    action,
    amount: String(amount),
    wallet,
  };
  if (fromChainId != null) params.fromChainId = String(fromChainId);
  if (fromTokenAddress) params.fromTokenAddress = fromTokenAddress;
  if (toChainId != null) params.toChainId = String(toChainId);
  if (toTokenAddress) params.toTokenAddress = toTokenAddress;
  if (destinationAddress) params.destinationAddress = destinationAddress;
  if (slippage != null) params.slippage = String(slippage);
  if (webhookURL) params.webhookURL = webhookURL;

  const { data } = await client.get(`/strategies/${encodeURIComponent(strategyId)}/bytecode`, { params });
  return data;
}

/**
 * Poll action execution status from Pods API.
 */
async function getActionStatus(actionId) {
  const client = getClient();
  const { data } = await client.get(`/actions/${encodeURIComponent(actionId)}`);
  return data;
}

/**
 * Verify Pods webhook HMAC-SHA256 signature.
 * Headers: X-Deframe-Webhook-Id, X-Deframe-Webhook-Timestamp, X-Deframe-Webhook-Signature
 */
function verifyPodsWebhookSignature(rawBody, headers, secret = process.env.PODS_WEBHOOK_SECRET) {
  if (!secret) return true; // allow unsigned only if PODS_WEBHOOK_SECRET is not configured yet
  const id = headers?.["x-deframe-webhook-id"] || headers?.["X-Deframe-Webhook-Id"] || "";
  const ts = headers?.["x-deframe-webhook-timestamp"] || headers?.["X-Deframe-Webhook-Timestamp"] || "";
  const sigHeader = headers?.["x-deframe-webhook-signature"] || headers?.["X-Deframe-Webhook-Signature"] || "";
  if (!sigHeader) return false;

  try {
    const cleanSecret = String(secret).startsWith("whsec_") ? String(secret).slice(6) : String(secret);
    const keyBuf = Buffer.from(cleanSecret, "hex").length === 32
      ? Buffer.from(cleanSecret, "hex")
      : Buffer.from(String(secret), "utf8");

    const candidates = [
      `${id}.${ts}.${rawBody}`,
      `${ts}.${rawBody}`,
      String(rawBody),
    ];

    const providedSigs = String(sigHeader)
      .split(/\s+/)
      .map((s) => s.replace(/^v\d+,/, "").replace(/^sha256=/, "").trim())
      .filter(Boolean);

    for (const payload of candidates) {
      const hexDigest = crypto.createHmac("sha256", keyBuf).update(payload).digest("hex");
      const b64Digest = crypto.createHmac("sha256", keyBuf).update(payload).digest("base64");
      for (const p of providedSigs) {
        if (p.length === hexDigest.length && crypto.timingSafeEqual(Buffer.from(p), Buffer.from(hexDigest))) return true;
        if (p.length === b64Digest.length && crypto.timingSafeEqual(Buffer.from(p), Buffer.from(b64Digest))) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = {
  PODS_API_URL,
  BASE_CHAIN_ID,
  BASE_USDC_ADDRESS,
  BSC_CHAIN_ID,
  BSC_USDC_ADDRESS,
  MIN_STOCK_BUY_USD,
  MIN_VAULT_DEPOSIT_USD,
  POPULAR_STOCKS,
  CURATED_SAVINGS_VAULTS,
  isConfigured,
  isInvestmentsEnabledForUser,
  normalizeTicker,
  toOndoStrategyId,
  toOndoMarketSymbol,
  getStocksCatalog,
  searchStocks,
  getStockMarketStatus,
  getStrategyPosition,
  getCuratedSavingsVaults,
  getSavingsVaultByShortId,
  getStrategyBytecode,
  getActionStatus,
  verifyPodsWebhookSignature,
};
