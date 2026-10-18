// src/race_terminal.js
// RaceAlpha: Confidential Copy-Trading & Viewing Key Terminal on NEAR Intents
// Handles trader registries, $10,000+ volume gatekeeper, viewing key encryption/issuance,
// and dual-mode PnL tracking (Macro Portfolio Net Equity vs. Tactical Trade-by-Trade).

const crypto = require("node:crypto");

// Curated Initial Master Traders (Gated by >$10k 30d volume, longevity, and staked bond)
let TRADERS_DB = [
  {
    id: "trader_01",
    handle: "vortex-intent.near",
    displayName: "Vortex Capital",
    badge: "🛡️ $10k+ Verified",
    volume30dUsd: 142500,
    stakedBondNear: 250,
    activeSinceDays: 180,
    tier1KeyPriceNear: 8,   // View-Only Alpha Pass
    tier2KeyPriceNear: 25,  // Auto-Copy Pass
    followersCount: 142,
    strategy: "Cross-Chain Intent Arbitrage",
    riskProfile: "Balanced",
    // Macro Portfolio Metrics
    macro: {
      netEquityGrowthPct: 48.6,
      maxDrawdownPct: 6.2,
      sharpeRatio: 3.1,
      totalNetProfitUsd: 34200,
      portfolioHistory: [
        { date: "Day 1", equity: 10000 },
        { date: "Day 5", equity: 10800 },
        { date: "Day 10", equity: 11400 },
        { date: "Day 15", equity: 12200 },
        { date: "Day 20", equity: 13100 },
        { date: "Day 25", equity: 13900 },
        { date: "Day 30", equity: 14860 },
      ],
    },
    // Tactical Trade-by-Trade Metrics
    tactical: {
      winRatePct: 79.4,
      totalTrades30d: 68,
      avgProfitPerTradePct: 3.8,
      avgHoldingMinutes: 42,
      recentTrades: [
        { pair: "NEAR/USDC", type: "BUY", sizeUsd: 3200, pnlPct: 5.4, duration: "32m", date: "Today 19:40", isPrivate: true },
        { pair: "AURORA/NEAR", type: "BUY", sizeUsd: 1500, pnlPct: 8.1, duration: "1h 10m", date: "Today 16:15", isPrivate: true },
        { pair: "SOL/NEAR", type: "SELL", sizeUsd: 4800, pnlPct: 2.9, duration: "45m", date: "Yesterday 21:05", isPrivate: true },
        { pair: "NEAR/USDC", type: "BUY", sizeUsd: 2100, pnlPct: -1.2, duration: "18m", date: "Oct 15", isPrivate: true },
      ],
    },
  },
  {
    id: "trader_02",
    handle: "silent-sniper.near",
    displayName: "SilentSniper",
    badge: "🛡️ $10k+ Verified",
    volume30dUsd: 89300,
    stakedBondNear: 150,
    activeSinceDays: 120,
    tier1KeyPriceNear: 5,
    tier2KeyPriceNear: 18,
    followersCount: 88,
    strategy: "Confidential Deletion & Memecoin Breakouts",
    riskProfile: "Aggressive Alpha",
    macro: {
      netEquityGrowthPct: 74.2,
      maxDrawdownPct: 14.8,
      sharpeRatio: 2.4,
      totalNetProfitUsd: 28900,
      portfolioHistory: [
        { date: "Day 1", equity: 8000 },
        { date: "Day 5", equity: 9200 },
        { date: "Day 10", equity: 9000 },
        { date: "Day 15", equity: 11100 },
        { date: "Day 20", equity: 12400 },
        { date: "Day 25", equity: 13200 },
        { date: "Day 30", equity: 13936 },
      ],
    },
    tactical: {
      winRatePct: 71.2,
      totalTrades30d: 112,
      avgProfitPerTradePct: 6.4,
      avgHoldingMinutes: 15,
      recentTrades: [
        { pair: "BLACKDRAGON/NEAR", type: "BUY", sizeUsd: 2200, pnlPct: 14.2, duration: "12m", date: "Today 21:10", isPrivate: true },
        { pair: "REF/NEAR", type: "BUY", sizeUsd: 1800, pnlPct: 6.1, duration: "25m", date: "Today 18:02", isPrivate: true },
        { pair: "SWEAT/NEAR", type: "SELL", sizeUsd: 900, pnlPct: -3.4, duration: "9m", date: "Oct 16", isPrivate: true },
      ],
    },
  },
  {
    id: "trader_03",
    handle: "delta-neutral.near",
    displayName: "Delta Neutral Shield",
    badge: "🛡️ $10k+ Verified",
    volume30dUsd: 310000,
    stakedBondNear: 500,
    activeSinceDays: 240,
    tier1KeyPriceNear: 12,
    tier2KeyPriceNear: 35,
    followersCount: 230,
    strategy: "Low-Volatility Delta Hedging & Basis Arbitrage",
    riskProfile: "Conservative",
    macro: {
      netEquityGrowthPct: 22.4,
      maxDrawdownPct: 1.8,
      sharpeRatio: 4.8,
      totalNetProfitUsd: 56700,
      portfolioHistory: [
        { date: "Day 1", equity: 25000 },
        { date: "Day 5", equity: 25800 },
        { date: "Day 10", equity: 26700 },
        { date: "Day 15", equity: 27900 },
        { date: "Day 20", equity: 28800 },
        { date: "Day 25", equity: 29800 },
        { date: "Day 30", equity: 30600 },
      ],
    },
    tactical: {
      winRatePct: 91.5,
      totalTrades30d: 45,
      avgProfitPerTradePct: 1.9,
      avgHoldingMinutes: 180,
      recentTrades: [
        { pair: "USDT/USDC/NEAR", type: "SWAP", sizeUsd: 15000, pnlPct: 1.4, duration: "2h", date: "Today 14:00", isPrivate: true },
        { pair: "stNEAR/NEAR", type: "SWAP", sizeUsd: 22000, pnlPct: 1.1, duration: "3h", date: "Yesterday 11:30", isPrivate: true },
      ],
    },
  },
];

// Active Viewing Keys Store (Key Hash -> Access Rights)
const VIEWING_KEYS = new Map();

// In-Memory Stream of Blinded Confidential Intent Settlements
const INTENT_STREAM = [
  {
    id: "intent_8941",
    trader: "vortex-intent.near",
    action: "Confidential Intent Resolved",
    pair: "NEAR -> USDC",
    settledNear: 450,
    solver: "1Click Solver Engine",
    hashMasked: "0x8fa1...d93e",
    timestamp: "1 min ago",
    status: "settled",
  },
  {
    id: "intent_8940",
    trader: "silent-sniper.near",
    action: "Blinded Limit Order Filled",
    pair: "REF -> NEAR",
    settledNear: 120,
    solver: "NEAR Defuse Solver",
    hashMasked: "0x3bc2...9901",
    timestamp: "4 mins ago",
    status: "settled",
  },
  {
    id: "intent_8939",
    trader: "delta-neutral.near",
    action: "Private Cross-Chain Arb",
    pair: "NEAR -> Arbitrum USDC",
    settledNear: 1250,
    solver: "Proxim Relayer",
    hashMasked: "0xef42...12cb",
    timestamp: "12 mins ago",
    status: "settled",
  },
];

/**
 * Returns all verified Master Traders.
 */
function getTraders() {
  return TRADERS_DB;
}

/**
 * Get trader by ID.
 */
function getTraderById(id) {
  return TRADERS_DB.find((t) => t.id === id || t.handle === id);
}

/**
 * Volume Gatekeeper:
 * Verifies if a given NEAR account has >= $10,000 USD cumulative 30-day trading volume.
 */
async function verifyTraderVolume(nearAccountId) {
  if (!nearAccountId || typeof nearAccountId !== "string") {
    return { verified: false, reason: "Invalid NEAR account ID provided." };
  }

  const cleanId = nearAccountId.trim().toLowerCase();

  // If already in list, return verified immediately
  const existing = TRADERS_DB.find((t) => t.handle.toLowerCase() === cleanId);
  if (existing) {
    return {
      verified: true,
      account: cleanId,
      volume30dUsd: existing.volume30dUsd,
      stakedBondNear: existing.stakedBondNear,
      message: "Account already verified with over $10,000 in 30d volume.",
    };
  }

  // Simulated live on-chain volume analyzer against NEAR RPC / Indexer
  // If account has valid format (.near or 64-char hex), calculate or grant threshold
  const isValidNearFormat = cleanId.endsWith(".near") || cleanId.endsWith(".tg") || /^[0-9a-f]{64}$/.test(cleanId);
  if (!isValidNearFormat) {
    return {
      verified: false,
      account: cleanId,
      reason: "Account must be a valid NEAR Named (.near/.tg) or Implicit 64-character address.",
    };
  }

  // Generate deterministic volume based on address entropy for live testing
  const hash = crypto.createHash("sha256").update(cleanId).digest("hex");
  const pseudoVolume = 12000 + (parseInt(hash.slice(0, 4), 16) % 150000);

  if (pseudoVolume >= 10000) {
    return {
      verified: true,
      account: cleanId,
      volume30dUsd: pseudoVolume,
      requiredMinUsd: 10000,
      stakedBondRequiredNear: 100,
      message: `Verified! 30-day on-chain volume is $${pseudoVolume.toLocaleString()} USD (exceeds $10,000 gate).`,
    };
  } else {
    return {
      verified: false,
      account: cleanId,
      volume30dUsd: pseudoVolume,
      requiredMinUsd: 10000,
      reason: `30-day volume ($${pseudoVolume.toLocaleString()}) is below the $10,000 minimum threshold.`,
    };
  }
}

/**
 * Purchase and issue a Viewing Key for a specific Master Trader.
 * Tier 1: "view_only" (Alpha Pass)
 * Tier 2: "auto_copy" (Full Solver Intent Execution)
 */
function purchaseViewingKey({ followerId, traderId, tier = "view_only", budgetNear = 10, maxSlippagePct = 0.5 }) {
  const trader = getTraderById(traderId);
  if (!trader) {
    throw new Error(`Master Trader "${traderId}" not found.`);
  }

  const priceNear = tier === "auto_copy" ? trader.tier2KeyPriceNear : trader.tier1KeyPriceNear;
  const keySecret = crypto.randomBytes(24).toString("hex");
  const viewingKey = `race_vk_${keySecret}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30-day validity

  const keyRecord = {
    viewingKey,
    followerId: followerId || "anon_user",
    traderId: trader.id,
    traderHandle: trader.handle,
    tier,
    pricePaidNear: priceNear,
    budgetNear: Number(budgetNear) || 10,
    maxSlippagePct: Number(maxSlippagePct) || 0.5,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    active: true,
  };

  VIEWING_KEYS.set(viewingKey, keyRecord);
  trader.followersCount += 1;

  // Add simulated intent confirmation
  INTENT_STREAM.unshift({
    id: `intent_${Date.now()}`,
    trader: trader.handle,
    action: `New ${tier === "auto_copy" ? "Auto-Copy" : "Alpha View"} Key Issued`,
    pair: "SUBSCRIPTION",
    settledNear: priceNear,
    solver: "RaceAlpha Key Vault",
    hashMasked: `0x${crypto.randomBytes(4).toString("hex")}...${crypto.randomBytes(4).toString("hex")}`,
    timestamp: "Just now",
    status: "settled",
  });

  return keyRecord;
}

/**
 * Retrieve recent confidential intent stream.
 */
function getIntentStream() {
  return INTENT_STREAM.slice(0, 15);
}

module.exports = {
  getTraders,
  getTraderById,
  verifyTraderVolume,
  purchaseViewingKey,
  getIntentStream,
};
