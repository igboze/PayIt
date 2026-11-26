// src/app_api/stocks.js
// Tokenized US Stocks & ETFs API for the Proxim mobile app (powered by Pods Finance / Ondo Global Markets).
// Provides:
//   - Official company logos for every stock/ETF
//   - Live US stock market open/closed schedule (Pods live market-status + America/New_York NYSE/NASDAQ clock)
//   - Real historical price series (1D, 1W, 1M, 3M, 1Y) via Yahoo Finance v8 chart API + live Pods price merge
//   - User portfolio holdings, average entry price, purchase history timestamps & live P&L

const axios = require("axios");

const deps = {
  get pods() { return require("../pods"); },
  get podsStore() { return require("../pods_store"); },
  get db() { return require("../db"); },
  get features() { return require("./features"); },
};
const overrides = {};
const dep = (name) => (name in overrides ? overrides[name] : deps[name]);

function __setTestDeps(o = {}) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setTestDeps cannot be used in production.");
  }
  for (const k of Object.keys(overrides)) delete overrides[k];
  Object.assign(overrides, o);
  _chartCache.clear();
  _quoteCache.clear();
}

// Curated popular tickers with official company domains for crisp logo fallback.
const STOCK_DOMAINS = {
  AAPL: { name: "Apple Inc.", domain: "apple.com", sector: "Technology" },
  NVDA: { name: "NVIDIA Corp.", domain: "nvidia.com", sector: "Semiconductors" },
  TSLA: { name: "Tesla Inc.", domain: "tesla.com", sector: "Automotive & AI" },
  MSFT: { name: "Microsoft Corp.", domain: "microsoft.com", sector: "Technology" },
  AMZN: { name: "Amazon.com Inc.", domain: "amazon.com", sector: "E-Commerce & Cloud" },
  GOOGL: { name: "Alphabet Inc.", domain: "google.com", sector: "Technology" },
  GOOG: { name: "Alphabet Inc.", domain: "google.com", sector: "Technology" },
  META: { name: "Meta Platforms", domain: "meta.com", sector: "Technology" },
  SPY: { name: "SPDR S&P 500 ETF", domain: "ssga.com", sector: "Index ETF" },
  QQQ: { name: "Invesco Nasdaq-100 ETF", domain: "invesco.com", sector: "Index ETF" },
  VOO: { name: "Vanguard S&P 500 ETF", domain: "vanguard.com", sector: "Index ETF" },
  VTI: { name: "Vanguard Total Stock ETF", domain: "vanguard.com", sector: "Index ETF" },
  IVV: { name: "iShares Core S&P 500 ETF", domain: "ishares.com", sector: "Index ETF" },
  NFLX: { name: "Netflix Inc.", domain: "netflix.com", sector: "Entertainment" },
  COIN: { name: "Coinbase Global", domain: "coinbase.com", sector: "Fintech" },
  AMD: { name: "AMD Inc.", domain: "amd.com", sector: "Semiconductors" },
  INTC: { name: "Intel Corp.", domain: "intel.com", sector: "Semiconductors" },
  AVGO: { name: "Broadcom Inc.", domain: "broadcom.com", sector: "Semiconductors" },
  TSM: { name: "TSMC", domain: "tsmc.com", sector: "Semiconductors" },
  ARM: { name: "Arm Holdings", domain: "arm.com", sector: "Semiconductors" },
  PLTR: { name: "Palantir Technologies", domain: "palantir.com", sector: "AI & Data" },
  UBER: { name: "Uber Technologies", domain: "uber.com", sector: "Mobility" },
  ABNB: { name: "Airbnb Inc.", domain: "airbnb.com", sector: "Travel" },
  SPOT: { name: "Spotify Technology", domain: "spotify.com", sector: "Entertainment" },
  SHOP: { name: "Shopify Inc.", domain: "shopify.com", sector: "E-Commerce" },
  PYPL: { name: "PayPal Holdings", domain: "paypal.com", sector: "Fintech" },
  SQ: { name: "Block Inc.", domain: "block.xyz", sector: "Fintech" },
  XYZ: { name: "Block Inc.", domain: "block.xyz", sector: "Fintech" },
  HOOD: { name: "Robinhood Markets", domain: "robinhood.com", sector: "Fintech" },
  MSTR: { name: "Strategy (MicroStrategy)", domain: "strategy.com", sector: "Software" },
  DIS: { name: "Walt Disney Co.", domain: "thewaltdisneycompany.com", sector: "Entertainment" },
  NKE: { name: "Nike Inc.", domain: "nike.com", sector: "Consumer" },
  JPM: { name: "JPMorgan Chase", domain: "jpmorganchase.com", sector: "Banking" },
  V: { name: "Visa Inc.", domain: "visa.com", sector: "Payments" },
  MA: { name: "Mastercard Inc.", domain: "mastercard.com", sector: "Payments" },
  WMT: { name: "Walmart Inc.", domain: "walmart.com", sector: "Retail" },
  COST: { name: "Costco Wholesale", domain: "costco.com", sector: "Retail" },
  KO: { name: "Coca-Cola Co.", domain: "coca-colacompany.com", sector: "Consumer" },
  PEP: { name: "PepsiCo Inc.", domain: "pepsico.com", sector: "Consumer" },
  MCD: { name: "McDonald's Corp.", domain: "mcdonalds.com", sector: "Consumer" },
  SBUX: { name: "Starbucks Corp.", domain: "starbucks.com", sector: "Consumer" },
  BA: { name: "Boeing Co.", domain: "boeing.com", sector: "Aerospace" },
  CRM: { name: "Salesforce Inc.", domain: "salesforce.com", sector: "Cloud Software" },
  ORCL: { name: "Oracle Corp.", domain: "oracle.com", sector: "Cloud Software" },
  IBM: { name: "IBM Corp.", domain: "ibm.com", sector: "Technology" },
  ADBE: { name: "Adobe Inc.", domain: "adobe.com", sector: "Software" },
  SNOW: { name: "Snowflake Inc.", domain: "snowflake.com", sector: "Cloud Data" },
  CRWD: { name: "CrowdStrike", domain: "crowdstrike.com", sector: "Cybersecurity" },
  PANW: { name: "Palo Alto Networks", domain: "paloaltonetworks.com", sector: "Cybersecurity" },
  LLY: { name: "Eli Lilly & Co.", domain: "lilly.com", sector: "Healthcare" },
  UNH: { name: "UnitedHealth Group", domain: "unitedhealthgroup.com", sector: "Healthcare" },
  JNJ: { name: "Johnson & Johnson", domain: "jnj.com", sector: "Healthcare" },
  XOM: { name: "Exxon Mobil", domain: "exxonmobil.com", sector: "Energy" },
  CVX: { name: "Chevron Corp.", domain: "chevron.com", sector: "Energy" },
  GS: { name: "Goldman Sachs", domain: "goldmansachs.com", sector: "Banking" },
  BAC: { name: "Bank of America", domain: "bankofamerica.com", sector: "Banking" },
  MS: { name: "Morgan Stanley", domain: "morganstanley.com", sector: "Banking" },
  RDDT: { name: "Reddit Inc.", domain: "reddit.com", sector: "Social" },
  SNAP: { name: "Snap Inc.", domain: "snap.com", sector: "Social" },
  DASH: { name: "DoorDash Inc.", domain: "doordash.com", sector: "Delivery" },
  RBLX: { name: "Roblox Corp.", domain: "roblox.com", sector: "Gaming" },
  SOFI: { name: "SoFi Technologies", domain: "sofi.com", sector: "Fintech" },
  NU: { name: "Nu Holdings", domain: "nubank.com.br", sector: "Fintech" },
  BABA: { name: "Alibaba Group", domain: "alibaba.com", sector: "E-Commerce" },
  SONY: { name: "Sony Group", domain: "sony.com", sector: "Electronics" },
  MU: { name: "Micron Technology", domain: "micron.com", sector: "Semiconductors" },
  QCOM: { name: "Qualcomm Inc.", domain: "qualcomm.com", sector: "Semiconductors" },
  CSCO: { name: "Cisco Systems", domain: "cisco.com", sector: "Networking" },
  F: { name: "Ford Motor Co.", domain: "ford.com", sector: "Automotive" },
  GM: { name: "General Motors", domain: "gm.com", sector: "Automotive" },
  RIVN: { name: "Rivian Automotive", domain: "rivian.com", sector: "Automotive" },
  AAL: { name: "American Airlines", domain: "aa.com", sector: "Airlines" },
  DAL: { name: "Delta Air Lines", domain: "delta.com", sector: "Airlines" },
  GLD: { name: "SPDR Gold Shares ETF", domain: "spdrgoldshares.com", sector: "Commodity ETF" },
  SLV: { name: "iShares Silver Trust", domain: "ishares.com", sector: "Commodity ETF" },
  IBIT: { name: "iShares Bitcoin Trust", domain: "ishares.com", sector: "Crypto ETF" },
  TLT: { name: "iShares 20+ Year Treasury ETF", domain: "ishares.com", sector: "Bond ETF" },
  ARKK: { name: "ARK Innovation ETF", domain: "ark-invest.com", sector: "Thematic ETF" },
  GME: { name: "GameStop Corp.", domain: "gamestop.com", sector: "Retail" },
  ZM: { name: "Zoom Communications", domain: "zoom.us", sector: "Software" },
};

function getStockLogos(ticker) {
  const clean = String(ticker || "").trim().toUpperCase().replace(/[^A-Z0-9.-]/g, "");
  const info = STOCK_DOMAINS[clean] || null;
  const primaryLogo = `https://assets.parqet.com/logos/symbol/${encodeURIComponent(clean)}?format=png`;
  const fallbackLogo = info?.domain
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(info.domain)}&sz=128`
    : null;
  return {
    logoUrl: primaryLogo,
    fallbackLogoUrl: fallbackLogo,
    sector: info?.sector || "US Equity",
    knownName: info?.name || null,
  };
}

// ─── US Stock Market Clock (NYSE / NASDAQ · America/New_York) ───────────────────

function getEasternParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    weekday: dayMap[parts.weekday] ?? 0,
    weekdayName: parts.weekday || "Mon",
    hour,
    minute,
    minutesOfDay: hour * 60 + minute,
  };
}

function formatDurationMinutes(totalMins) {
  const mins = Math.max(1, Math.round(totalMins));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function formatIsoToEtShort(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d) + " ET";
  } catch (_) {
    return d.toUTCString();
  }
}

/**
 * Compute live US market status (NYSE/NASDAQ regular hours Mon-Fri 9:30 AM - 4:00 PM ET),
 * merged with live Pods/Ondo market status (which includes US market holidays & exact settlement windows).
 */
function buildMarketStatus(podsStatus = null, now = new Date()) {
  const et = getEasternParts(now);
  const isWeekday = et.weekday >= 1 && et.weekday <= 5;
  const openMin = 9 * 60 + 30;  // 09:30 ET
  const closeMin = 16 * 60;     // 16:00 ET
  const preOpenMin = 4 * 60;    // 04:00 ET
  const afterCloseMin = 20 * 60; // 20:00 ET

  let isOpen = isWeekday && et.minutesOfDay >= openMin && et.minutesOfDay < closeMin;
  let session = "closed";
  if (isOpen) session = "open";
  else if (isWeekday && et.minutesOfDay >= preOpenMin && et.minutesOfDay < openMin) session = "pre_market";
  else if (isWeekday && et.minutesOfDay >= closeMin && et.minutesOfDay < afterCloseMin) session = "after_hours";

  let nextOpen = podsStatus?.nextOpen || null;
  let nextClose = podsStatus?.nextClose || null;
  let tradable = podsStatus?.tradable != null ? Boolean(podsStatus.tradable) : true;
  let paused = Boolean(podsStatus?.paused);
  let blockingReason = podsStatus?.blockingReason || null;

  // Prefer live Pods/Ondo status when available (handles US holidays like Thanksgiving accurately)
  if (podsStatus && typeof podsStatus.isOpen === "boolean") {
    isOpen = podsStatus.isOpen;
    if (isOpen) {
      session = "open";
    } else {
      const ms = String(podsStatus.marketStatus || "").toLowerCase();
      if (ms.includes("pre")) session = "pre_market";
      else if (ms.includes("after") || ms.includes("post")) session = "after_hours";
      else session = "closed";
    }
  }

  let nextChangeLabel = "";
  const nowMs = now.getTime();
  if (isOpen) {
    if (nextClose && !Number.isNaN(Date.parse(nextClose)) && Date.parse(nextClose) > nowMs) {
      const minsLeft = (Date.parse(nextClose) - nowMs) / 60_000;
      nextChangeLabel = `Closes in ${formatDurationMinutes(minsLeft)}`;
    } else if (isWeekday && et.minutesOfDay < closeMin) {
      nextChangeLabel = `Closes in ${formatDurationMinutes(closeMin - et.minutesOfDay)}`;
    } else {
      nextChangeLabel = "Closes 4:00 PM ET";
    }
  } else {
    if (nextOpen && !Number.isNaN(Date.parse(nextOpen)) && Date.parse(nextOpen) > nowMs) {
      const minsUntil = (Date.parse(nextOpen) - nowMs) / 60_000;
      nextChangeLabel = minsUntil <= 24 * 60
        ? `Opens in ${formatDurationMinutes(minsUntil)} (${formatIsoToEtShort(nextOpen)})`
        : `Opens ${formatIsoToEtShort(nextOpen)}`;
    } else if (isWeekday && et.minutesOfDay < openMin) {
      nextChangeLabel = `Opens in ${formatDurationMinutes(openMin - et.minutesOfDay)} (9:30 AM ET)`;
    } else {
      const daysUntilMon = et.weekday === 5 ? 3 : et.weekday === 6 ? 2 : et.weekday === 0 ? 1 : 1;
      const nextDayLabel = daysUntilMon > 1 ? "Mon 9:30 AM ET" : "Tomorrow 9:30 AM ET";
      nextChangeLabel = `Opens ${nextDayLabel}`;
    }
  }

  const label = isOpen
    ? "Market Open"
    : session === "pre_market"
      ? "Pre-Market · Closed"
      : session === "after_hours"
        ? "After-Hours · Closed"
        : "Market Closed";

  return {
    isOpen,
    session,
    label,
    nextChangeLabel,
    nextOpen,
    nextClose,
    hoursLabel: "Mon–Fri · 9:30 AM – 4:00 PM ET (NYSE / NASDAQ)",
    etTimeLabel: `${et.weekdayName} ${String(et.hour).padStart(2, "0")}:${String(et.minute).padStart(2, "0")} ET`,
    tradable,
    paused,
    blockingReason,
  };
}

// ─── Yahoo Finance Historical Chart & Live Quotes (Cached) ────────────────────

const RANGE_SPECS = {
  "1D": { range: "1d", interval: "5m" },
  "1W": { range: "5d", interval: "30m" },
  "1M": { range: "1mo", interval: "1d" },
  "3M": { range: "3mo", interval: "1d" },
  "1Y": { range: "1y", interval: "1wk" },
};

const _chartCache = new Map();
const _quoteCache = new Map();
const CHART_TTL_MS = 60_000;
const QUOTE_TTL_MS = 45_000;

function downsamplePoints(points, maxPoints = 64) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points || [];
  const out = [];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = i === maxPoints - 1 ? points.length - 1 : Math.round(i * step);
    out.push(points[idx]);
  }
  return out;
}

async function fetchYahooChart(ticker, rangeKey = "1M") {
  const clean = String(ticker || "").trim().toUpperCase();
  const key = RANGE_SPECS[rangeKey] ? rangeKey : "1M";
  const cacheKey = `${clean}:${key}`;
  const cached = _chartCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CHART_TTL_MS) {
    return cached.data;
  }
  const spec = RANGE_SPECS[key];
  const yahooSymbol = clean.replace(/\./g, "-");
  try {
    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`,
      {
        params: { range: spec.range, interval: spec.interval, includePrePost: "false" },
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ProximApp/1.0)",
          Accept: "application/json",
        },
        timeout: 6500,
      }
    );
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta || {};
    const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const rawPoints = [];
    for (let i = 0; i < timestamps.length; i++) {
      const p = Number(closes[i]);
      const ts = Number(timestamps[i]);
      if (Number.isFinite(p) && p > 0 && Number.isFinite(ts)) {
        rawPoints.push({ t: ts * 1000, price: Number(p.toFixed(4)) });
      }
    }
    const points = downsamplePoints(rawPoints, 64);
    const price = Number(meta.regularMarketPrice || points[points.length - 1]?.price || 0) || null;
    const prevClose = Number(meta.chartPreviousClose || meta.previousClose || points[0]?.price || 0) || null;
    const firstPrice = points[0]?.price || prevClose || price;
    const changeAbs = price != null && firstPrice != null ? Number((price - firstPrice).toFixed(4)) : null;
    const changePct = price != null && firstPrice ? Number((((price - firstPrice) / firstPrice) * 100).toFixed(2)) : null;
    const dayChangePct = price != null && prevClose ? Number((((price - prevClose) / prevClose) * 100).toFixed(2)) : changePct;

    const payload = {
      range: key,
      price,
      previousClose: prevClose,
      high: points.length ? Math.max(...points.map((x) => x.price)) : price,
      low: points.length ? Math.min(...points.map((x) => x.price)) : price,
      changeAbs,
      changePct,
      dayChangePct,
      currency: meta.currency || "USD",
      exchangeName: meta.exchangeName || "NASDAQ",
      longName: meta.longName || meta.shortName || null,
      points,
    };
    _chartCache.set(cacheKey, { at: Date.now(), data: payload });
    if (price) {
      _quoteCache.set(clean, {
        at: Date.now(),
        data: {
          price,
          changePct24h: dayChangePct,
          longName: payload.longName,
        },
      });
    }
    return payload;
  } catch (err) {
    return null;
  }
}

async function fetchQuickQuote(ticker) {
  const clean = String(ticker || "").trim().toUpperCase();
  const cached = _quoteCache.get(clean);
  if (cached && Date.now() - cached.at < QUOTE_TTL_MS) {
    return cached.data;
  }
  const chart = await fetchYahooChart(clean, "1D");
  if (chart && chart.price) {
    return {
      price: chart.price,
      changePct24h: chart.dayChangePct,
      longName: chart.longName,
    };
  }
  return null;
}

function getWalletAddress(user, accountType) {
  return accountType === "business" ? user?.business_deposit_address : user?.deposit_address;
}

function getUserStockActionRows(telegramId, accountType, ticker = null) {
  try {
    const db = dep("db").db;
    // Ensure pods_actions table exists
    dep("podsStore");
    if (ticker) {
      return db.prepare(`
        SELECT * FROM pods_actions
        WHERE telegram_id = ? AND account_type = ? AND UPPER(ticker) = UPPER(?)
          AND kind IN ('stock_buy', 'stock_sell')
        ORDER BY id DESC LIMIT 50
      `).all(Number(telegramId), String(accountType || "personal"), String(ticker));
    }
    return db.prepare(`
      SELECT * FROM pods_actions
      WHERE telegram_id = ? AND account_type = ?
        AND kind IN ('stock_buy', 'stock_sell')
      ORDER BY id DESC LIMIT 100
    `).all(Number(telegramId), String(accountType || "personal"));
  } catch (_) {
    return [];
  }
}

function parseActionMeta(row) {
  if (!row || !row.meta_json) return {};
  try {
    return JSON.parse(row.meta_json) || {};
  } catch (_) {
    return {};
  }
}

/**
 * Compute user's purchase history & entry state for a single ticker,
 * merging live Pods spot position (when available) with recorded pods_actions orders.
 */
function buildPositionSummary(ticker, livePos, actionRows, currentPrice, ngnRate) {
  const buys = (actionRows || []).filter((r) => r.kind === "stock_buy");
  const sells = (actionRows || []).filter((r) => r.kind === "stock_sell");
  const purchases = buys.map((r) => {
    const meta = parseActionMeta(r);
    const priceAtOrder = Number(meta.priceAtOrder || meta.price || livePos?.avgPurchasePrice || 0) || null;
    const amountUsd = Number(r.amount_usd || 0);
    const estShares = priceAtOrder && amountUsd > 0 ? Number((amountUsd / priceAtOrder).toFixed(6)) : null;
    return {
      id: r.id,
      timestamp: r.created_at ? (r.created_at.includes("T") ? r.created_at : r.created_at.replace(" ", "T") + "Z") : null,
      amountUsd,
      priceAtBuy: priceAtOrder,
      estimatedShares: estShares,
      status: String(r.status || "PENDING").toUpperCase(),
      txHash: r.tx_hash || null,
    };
  });

  const liveShares = Number(livePos?.currentPosition || 0);
  const pendingBuyUsd = buys
    .filter((r) => !["SUCCESS", "FAILED", "REFUNDED", "EXPIRED"].includes(String(r.status || "").toUpperCase()))
    .reduce((sum, r) => sum + Number(r.amount_usd || 0), 0);
  const confirmedBuyUsd = buys
    .filter((r) => String(r.status || "").toUpperCase() === "SUCCESS")
    .reduce((sum, r) => sum + Number(r.amount_usd || 0), 0);
  const totalBuyUsd = buys
    .filter((r) => !["FAILED", "REFUNDED", "EXPIRED"].includes(String(r.status || "").toUpperCase()))
    .reduce((sum, r) => sum + Number(r.amount_usd || 0), 0);

  if (liveShares <= 0.000001 && pendingBuyUsd <= 0 && purchases.length === 0) {
    return null;
  }

  // Weighted average entry price across buy orders (or live Pods avgPurchasePrice)
  let avgBuyPrice = livePos?.avgPurchasePrice != null && Number(livePos.avgPurchasePrice) > 0
    ? Number(livePos.avgPurchasePrice)
    : null;
  if (!avgBuyPrice && purchases.length > 0) {
    let weightedSum = 0;
    let weightUsd = 0;
    for (const p of purchases) {
      if (p.priceAtBuy && p.amountUsd > 0 && !["FAILED", "REFUNDED", "EXPIRED"].includes(p.status)) {
        weightedSum += p.priceAtBuy * p.amountUsd;
        weightUsd += p.amountUsd;
      }
    }
    if (weightUsd > 0) avgBuyPrice = Number((weightedSum / weightUsd).toFixed(4));
  }

  const presentPrice = Number(currentPrice || 0) || (livePos?.currentPositionUsd && liveShares > 0 ? livePos.currentPositionUsd / liveShares : null);
  const currentValueUsd = livePos?.currentPositionUsd != null && Number(livePos.currentPositionUsd) > 0
    ? Number(livePos.currentPositionUsd)
    : (liveShares > 0 && presentPrice ? Number((liveShares * presentPrice).toFixed(2)) : pendingBuyUsd);

  const costBasisUsd = liveShares > 0 && avgBuyPrice
    ? Number((liveShares * avgBuyPrice).toFixed(2))
    : (confirmedBuyUsd > 0 ? confirmedBuyUsd : totalBuyUsd);

  let pnlUsd = 0;
  if (liveShares > 0) {
    pnlUsd = livePos?.profit != null && Number.isFinite(Number(livePos.profit)) && Number(livePos.profit) !== 0
      ? Number(livePos.profit)
      : Number((currentValueUsd - costBasisUsd).toFixed(2));
  }
  const pnlPct = costBasisUsd > 0 && liveShares > 0
    ? Number(((pnlUsd / costBasisUsd) * 100).toFixed(2))
    : (avgBuyPrice && presentPrice ? Number((((presentPrice - avgBuyPrice) / avgBuyPrice) * 100).toFixed(2)) : 0);

  const validBuys = purchases.filter((p) => !["FAILED", "REFUNDED", "EXPIRED"].includes(p.status));
  const firstBoughtAt = validBuys.length ? validBuys[validBuys.length - 1].timestamp : null;
  const lastBoughtAt = validBuys.length ? validBuys[0].timestamp : null;

  return {
    ticker,
    shares: Number(liveShares.toFixed(6)),
    avgBuyPrice: avgBuyPrice ? Number(avgBuyPrice.toFixed(2)) : null,
    currentPrice: presentPrice ? Number(presentPrice.toFixed(2)) : null,
    costBasisUsd: Number(costBasisUsd.toFixed(2)),
    currentValueUsd: Number(currentValueUsd.toFixed(2)),
    currentValueNgn: ngnRate ? Math.round(currentValueUsd * ngnRate) : null,
    pnlUsd: Number(pnlUsd.toFixed(2)),
    pnlNgn: ngnRate ? Math.round(pnlUsd * ngnRate) : null,
    pnlPct,
    pendingBuyUsd: Number(pendingBuyUsd.toFixed(2)),
    firstBoughtAt,
    lastBoughtAt,
    purchases,
    sellCount: sells.length,
  };
}

// ─── Route Handlers ───────────────────────────────────────────────────────────

async function listStocks(auth, url) {
  const pods = dep("pods");
  const accountType = (url.searchParams.get("account") || auth.accountHeader || "personal") === "business" ? "business" : "personal";
  const q = (url.searchParams.get("q") || "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 24), 1), 60);
  const wallet = getWalletAddress(auth.user, accountType);
  const configured = typeof pods.isConfigured === "function" ? Boolean(pods.isConfigured()) : false;
  const tradingEnabled = typeof pods.isInvestmentsEnabledForUser === "function"
    ? Boolean(pods.isInvestmentsEnabledForUser(auth.telegramId))
    : configured;

  const ngnRate = await dep("features").getLiveUsdNgnRate().catch(() => null);

  // 1. Live market status (probe AAPL from Pods when configured so US market holidays are accurate)
  let livePodsMarket = null;
  if (configured && typeof pods.getStockMarketStatus === "function") {
    try {
      livePodsMarket = await pods.getStockMarketStatus("AAPL");
    } catch (_) {}
  }
  const market = buildMarketStatus(livePodsMarket);

  // 2. Stock catalog (Pods full 470+ Ondo catalog when configured, popular curated fallback otherwise)
  let rawStocks = [];
  if (configured && typeof pods.searchStocks === "function") {
    try {
      rawStocks = await pods.searchStocks(q, limit);
    } catch (_) {}
  }
  if (!rawStocks.length) {
    const fallback = (pods.POPULAR_STOCKS || []).map((p) => ({
      id: pods.toOndoStrategyId ? pods.toOndoStrategyId(p.ticker) : `Ondo-${p.ticker}-bsc`,
      ticker: p.ticker,
      name: p.name,
      network: "bsc",
      paused: false,
    }));
    const up = q.toUpperCase().replace(/^\$/, "");
    rawStocks = up
      ? fallback.filter((s) => s.ticker.includes(up) || s.name.toUpperCase().includes(up))
      : fallback;
    // Also allow looking up any valid ticker symbol in search even if not in popular fallback
    if (up && /^[A-Z]{1,5}$/.test(up) && !rawStocks.some((s) => s.ticker === up)) {
      const info = STOCK_DOMAINS[up];
      rawStocks.unshift({
        id: `Ondo-${up}-bsc`,
        ticker: up,
        name: info?.name || up,
        network: "bsc",
        paused: false,
      });
    }
  }

  // 3. User's tracked stock orders & live holdings
  const allActions = getUserStockActionRows(auth.telegramId, accountType);
  const actionsByTicker = new Map();
  for (const row of allActions) {
    const tk = String(row.ticker || "").toUpperCase();
    if (!tk) continue;
    if (!actionsByTicker.has(tk)) actionsByTicker.set(tk, []);
    actionsByTicker.get(tk).push(row);
  }
  const trackedTickers = [...actionsByTicker.keys()];

  // Fetch live quotes for top visible stocks + held stocks in parallel (bounded)
  const quoteTargets = [...new Set([...rawStocks.slice(0, 16).map((s) => s.ticker), ...trackedTickers])];
  const quoteMap = new Map();
  if (livePodsMarket?.price) {
    quoteMap.set("AAPL", {
      price: livePodsMarket.price,
      changePct24h: livePodsMarket.priceChangePct24h,
    });
  }
  await Promise.allSettled(
    quoteTargets.map(async (tk) => {
      if (quoteMap.has(tk)) return;
      const quote = await fetchQuickQuote(tk);
      if (quote) quoteMap.set(tk, quote);
    })
  );

  // Fetch live Pods positions for held tickers
  const holdings = [];
  if (trackedTickers.length > 0 && wallet) {
    const posResults = await Promise.allSettled(
      trackedTickers.map(async (tk) => {
        let livePos = null;
        if (configured && typeof pods.getStrategyPosition === "function") {
          try {
            livePos = await pods.getStrategyPosition(pods.toOndoStrategyId(tk), wallet);
          } catch (_) {}
        }
        const qInfo = quoteMap.get(tk) || null;
        const summary = buildPositionSummary(tk, livePos, actionsByTicker.get(tk), qInfo?.price ?? null, ngnRate);
        if (!summary) return null;
        const logos = getStockLogos(tk);
        return {
          ...summary,
          name: logos.knownName || qInfo?.longName || tk,
          logoUrl: logos.logoUrl,
          fallbackLogoUrl: logos.fallbackLogoUrl,
        };
      })
    );
    for (const r of posResults) {
      if (r.status === "fulfilled" && r.value && (r.value.shares > 0 || r.value.pendingBuyUsd > 0)) {
        holdings.push(r.value);
      }
    }
  }

  const holdingByTicker = new Map(holdings.map((h) => [h.ticker, h]));
  const stocks = rawStocks.slice(0, limit).map((s) => {
    const tk = String(s.ticker || "").toUpperCase();
    const logos = getStockLogos(tk);
    const qInfo = quoteMap.get(tk) || null;
    const h = holdingByTicker.get(tk) || null;
    const price = qInfo?.price != null ? Number(qInfo.price.toFixed(2)) : null;
    return {
      ticker: tk,
      strategyId: s.id || `Ondo-${tk}-bsc`,
      name: logos.knownName || (s.name && s.name !== tk ? s.name : qInfo?.longName || tk),
      sector: logos.sector,
      logoUrl: logos.logoUrl,
      fallbackLogoUrl: logos.fallbackLogoUrl,
      price,
      priceNgn: price != null && ngnRate ? Math.round(price * ngnRate) : null,
      changePct24h: qInfo?.changePct24h != null ? Number(qInfo.changePct24h.toFixed(2)) : null,
      paused: Boolean(s.paused),
      ownedShares: h ? h.shares : 0,
      ownedValueUsd: h ? h.currentValueUsd : 0,
    };
  });

  const totalPortfolioUsd = Number(holdings.reduce((sum, h) => sum + Number(h.currentValueUsd || 0), 0).toFixed(2));
  const totalPnlUsd = Number(holdings.reduce((sum, h) => sum + Number(h.pnlUsd || 0), 0).toFixed(2));
  const totalCostBasisUsd = Number(holdings.reduce((sum, h) => sum + Number(h.costBasisUsd || 0), 0).toFixed(2));

  return {
    status: 200,
    data: {
      accountType,
      configured,
      tradingEnabled,
      minBuyUsd: Number(pods.MIN_STOCK_BUY_USD || 10),
      usdToNgnRate: ngnRate,
      market,
      portfolio: {
        totalValueUsd: totalPortfolioUsd,
        totalValueNgn: ngnRate ? Math.round(totalPortfolioUsd * ngnRate) : null,
        totalPnlUsd,
        totalPnlNgn: ngnRate ? Math.round(totalPnlUsd * ngnRate) : null,
        totalPnlPct: totalCostBasisUsd > 0 ? Number(((totalPnlUsd / totalCostBasisUsd) * 100).toFixed(2)) : 0,
        holdings,
      },
      stocks,
    },
  };
}

async function getStockDetailAndChart(auth, url, rawTicker) {
  const pods = dep("pods");
  const clean = typeof pods.normalizeTicker === "function"
    ? pods.normalizeTicker(rawTicker)
    : String(rawTicker || "").trim().toUpperCase().replace(/[^A-Z0-9.-]/g, "");
  if (!clean) {
    const err = new Error("Valid stock ticker is required.");
    err.status = 400;
    err.code = "invalid_ticker";
    throw err;
  }

  const accountType = (url.searchParams.get("account") || auth.accountHeader || "personal") === "business" ? "business" : "personal";
  const rangeKey = String(url.searchParams.get("range") || "1M").toUpperCase();
  const wallet = getWalletAddress(auth.user, accountType);
  const configured = typeof pods.isConfigured === "function" ? Boolean(pods.isConfigured()) : false;
  const tradingEnabled = typeof pods.isInvestmentsEnabledForUser === "function"
    ? Boolean(pods.isInvestmentsEnabledForUser(auth.telegramId))
    : configured;
  const strategyId = typeof pods.toOndoStrategyId === "function" ? pods.toOndoStrategyId(clean) : `Ondo-${clean}-bsc`;

  const [chartRes, podsMarketRes, livePosRes, ngnRate] = await Promise.all([
    fetchYahooChart(clean, rangeKey),
    configured && typeof pods.getStockMarketStatus === "function"
      ? pods.getStockMarketStatus(clean).catch(() => null)
      : Promise.resolve(null),
    configured && wallet && typeof pods.getStrategyPosition === "function"
      ? pods.getStrategyPosition(strategyId, wallet).catch(() => null)
      : Promise.resolve(null),
    dep("features").getLiveUsdNgnRate().catch(() => null),
  ]);

  const logos = getStockLogos(clean);
  const market = buildMarketStatus(podsMarketRes);
  const currentPrice = podsMarketRes?.price ?? chartRes?.price ?? null;

  let points = chartRes?.points ? [...chartRes.points] : [];
  // Append live present price from Pods if newer/available so chart ends at exact present price
  if (currentPrice != null && points.length > 0) {
    const last = points[points.length - 1];
    if (Math.abs(last.price - currentPrice) / Math.max(last.price, 0.01) > 0.0002) {
      points.push({ t: Date.now(), price: Number(Number(currentPrice).toFixed(4)) });
    }
  } else if (currentPrice != null && points.length === 0) {
    points = [{ t: Date.now(), price: Number(Number(currentPrice).toFixed(4)) }];
  }

  const firstPrice = points.length > 0 ? points[0].price : currentPrice;
  const rangeChangeAbs = currentPrice != null && firstPrice != null ? Number((currentPrice - firstPrice).toFixed(2)) : null;
  const rangeChangePct = currentPrice != null && firstPrice ? Number((((currentPrice - firstPrice) / firstPrice) * 100).toFixed(2)) : null;

  const actionRows = getUserStockActionRows(auth.telegramId, accountType, clean);
  const position = buildPositionSummary(clean, livePosRes, actionRows, currentPrice, ngnRate);

  return {
    status: 200,
    data: {
      accountType,
      configured,
      tradingEnabled,
      minBuyUsd: Number(pods.MIN_STOCK_BUY_USD || 10),
      usdToNgnRate: ngnRate,
      stock: {
        ticker: clean,
        strategyId,
        name: logos.knownName || chartRes?.longName || clean,
        sector: logos.sector,
        exchange: chartRes?.exchangeName || "NYSE / NASDAQ",
        logoUrl: logos.logoUrl,
        fallbackLogoUrl: logos.fallbackLogoUrl,
        price: currentPrice != null ? Number(Number(currentPrice).toFixed(2)) : null,
        priceNgn: currentPrice != null && ngnRate ? Math.round(Number(currentPrice) * ngnRate) : null,
        changePct24h: podsMarketRes?.priceChangePct24h != null
          ? Number(Number(podsMarketRes.priceChangePct24h).toFixed(2))
          : (chartRes?.dayChangePct ?? rangeChangePct),
      },
      market,
      chart: {
        range: RANGE_SPECS[rangeKey] ? rangeKey : "1M",
        ranges: Object.keys(RANGE_SPECS),
        high: points.length ? Number(Math.max(...points.map((p) => p.price)).toFixed(2)) : null,
        low: points.length ? Number(Math.min(...points.map((p) => p.price)).toFixed(2)) : null,
        changeAbs: rangeChangeAbs,
        changePct: rangeChangePct,
        points,
      },
      position,
    },
  };
}

module.exports = {
  STOCK_DOMAINS,
  getStockLogos,
  buildMarketStatus,
  buildPositionSummary,
  listStocks,
  getStockDetailAndChart,
  __setTestDeps,
};
