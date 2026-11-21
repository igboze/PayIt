// src/fraud_guard.js
// Production Anti-Fraud Engine, Velocity Tripwires, Chargeback Hold Screener & 1-Second Circuit Breaker
//
// Protects Proxim against:
// 1. Coordinated burst / velocity attacks (auto-freezes user + alerts ADMIN_IDS before funds leave)
// 2. Tier-0 vs Tier-1 daily cumulative withdrawal cap violations
// 3. Chargeback / reversal arbitrage on hosted payment links (Interac, Faster Payments, SEPA, MoMo)
// 4. Emergency 1-second Global Payout Circuit Breaker (/pause_payouts & /resume_payouts)

const dbModule = require("./db");
const rawDb = dbModule.db;

function ensureFraudSchema() {
  try {
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS system_security_flags (
        flag_key    TEXT PRIMARY KEY,
        flag_value  TEXT NOT NULL,
        reason      TEXT,
        updated_by  TEXT,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS outbound_velocity_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id   INTEGER NOT NULL,
        account_type  TEXT NOT NULL DEFAULT 'personal',
        action        TEXT NOT NULL,
        amount_usd    REAL NOT NULL DEFAULT 0,
        reference     TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_outbound_vel_user_time
        ON outbound_velocity_log(telegram_id, created_at);

      CREATE TABLE IF NOT EXISTS inbound_paylink_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id   INTEGER NOT NULL,
        entity_id     TEXT,
        inflow_id     TEXT UNIQUE,
        currency      TEXT NOT NULL,
        amount_usd    REAL NOT NULL DEFAULT 0,
        status        TEXT NOT NULL DEFAULT 'cleared',
        reason        TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_inbound_paylink_user_time
        ON inbound_paylink_log(telegram_id, created_at);
    `);
  } catch (err) {
    console.warn("[fraud_guard] ensureFraudSchema note:", err.message);
  }
}

ensureFraudSchema();

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getAdminIds() {
  return String(process.env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getBotTelegram(bot) {
  if (!bot) return null;
  if (bot.telegram && typeof bot.telegram.sendMessage === "function") return bot.telegram;
  if (bot.bot?.telegram && typeof bot.bot.telegram.sendMessage === "function") return bot.bot.telegram;
  return null;
}

async function alertAdmins(bot, htmlMessage, extraMarkup = {}) {
  const telegram = getBotTelegram(bot);
  const admins = getAdminIds();
  if (!telegram || !admins.length) return;
  for (const adminId of admins) {
    try {
      await telegram.sendMessage(adminId, htmlMessage, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...extraMarkup,
      });
    } catch (_) {}
  }
}

// ── 1. Global Payout Circuit Breaker (1-Second Emergency Halt) ───────────────

function isPayoutsPaused() {
  ensureFraudSchema();
  if (String(process.env.PROXIM_PAUSE_ALL_PAYOUTS || "").toLowerCase() === "true") {
    return {
      paused: true,
      reason: "Emergency maintenance (PROXIM_PAUSE_ALL_PAYOUTS=true)",
      updatedAt: null,
    };
  }
  const row = rawDb
    .prepare("SELECT * FROM system_security_flags WHERE flag_key = 'pause_all_payouts'")
    .get();
  if (row && row.flag_value === "1") {
    return {
      paused: true,
      reason: row.reason || "Temporary security maintenance",
      updatedBy: row.updated_by || null,
      updatedAt: row.updated_at || null,
    };
  }
  return { paused: false, reason: null };
}

function setPayoutsPaused(paused, reason = null, updatedBy = null) {
  ensureFraudSchema();
  const val = paused ? "1" : "0";
  rawDb
    .prepare(`
      INSERT INTO system_security_flags (flag_key, flag_value, reason, updated_by, updated_at)
      VALUES ('pause_all_payouts', ?, ?, ?, datetime('now'))
      ON CONFLICT(flag_key) DO UPDATE SET
        flag_value = excluded.flag_value,
        reason = excluded.reason,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `)
    .run(val, reason || null, updatedBy ? String(updatedBy) : null);
  return isPayoutsPaused();
}

// ── 2. Tier-Aware Velocity & Daily Cap Configuration ─────────────────────────

function getVelocityConfig() {
  return {
    // Max number of outbound money movements within a 10-minute rolling window before auto-freeze
    maxTxPer10Min: Math.max(2, Number(process.env.PROXIM_MAX_OUTBOUND_10M || 8)),
    // Max number of outbound money movements within a 1-hour rolling window before auto-freeze
    maxTxPerHour: Math.max(5, Number(process.env.PROXIM_MAX_OUTBOUND_1H || 20)),
    // Tier 0 (Unverified — NGN & local only) daily & hourly caps in USD
    tier0HourlyLimitUsd: Math.max(50, Number(process.env.PROXIM_TIER0_HOURLY_LIMIT_USD || 1000)),
    tier0DailyLimitUsd: Math.max(100, Number(process.env.PROXIM_TIER0_DAILY_LIMIT_USD || 2000)),
    // Tier 1 Personal (KYC Verified) daily & hourly caps in USD
    tier1HourlyLimitUsd: Math.max(500, Number(process.env.PROXIM_TIER1_HOURLY_LIMIT_USD || 10000)),
    tier1DailyLimitUsd: Math.max(1000, Number(process.env.PROXIM_TIER1_DAILY_LIMIT_USD || 25000)),
    // Tier 1 Business (KYB Verified) daily & hourly caps in USD
    tier1BizHourlyLimitUsd: Math.max(1000, Number(process.env.PROXIM_TIER1_BIZ_HOURLY_LIMIT_USD || 50000)),
    tier1BizDailyLimitUsd: Math.max(5000, Number(process.env.PROXIM_TIER1_BIZ_DAILY_LIMIT_USD || 100000)),
    // Hosted Payment Link (Interac / Open Banking / MoMo) chargeback risk caps
    paylinkMaxSingleUsd: Math.max(50, Number(process.env.PROXIM_PAYLINK_MAX_SINGLE_USD || 2500)),
    paylinkMaxDailyUsd: Math.max(100, Number(process.env.PROXIM_PAYLINK_MAX_DAILY_USD || 5000)),
  };
}

function isUserTier1Approved(telegramId, accountType = "personal") {
  try {
    const ent = dbModule.getNuvionEntityByUser(telegramId, accountType);
    return String(ent?.status || "").toLowerCase() === "approved";
  } catch (_) {
    return false;
  }
}

function getUserOutboundStats(telegramId) {
  ensureFraudSchema();
  const row10m = rawDb
    .prepare(`
      SELECT COUNT(*) AS tx_count, COALESCE(SUM(amount_usd), 0) AS total_usd
      FROM outbound_velocity_log
      WHERE telegram_id = ? AND created_at >= datetime('now', '-10 minutes')
    `)
    .get(Number(telegramId));

  const row1h = rawDb
    .prepare(`
      SELECT COUNT(*) AS tx_count, COALESCE(SUM(amount_usd), 0) AS total_usd
      FROM outbound_velocity_log
      WHERE telegram_id = ? AND created_at >= datetime('now', '-60 minutes')
    `)
    .get(Number(telegramId));

  const row24h = rawDb
    .prepare(`
      SELECT COUNT(*) AS tx_count, COALESCE(SUM(amount_usd), 0) AS total_usd
      FROM outbound_velocity_log
      WHERE telegram_id = ? AND created_at >= datetime('now', '-24 hours')
    `)
    .get(Number(telegramId));

  return {
    txCount10m: Number(row10m?.tx_count || 0),
    usd10m: Number(row10m?.total_usd || 0),
    txCount1h: Number(row1h?.tx_count || 0),
    usd1h: Number(row1h?.total_usd || 0),
    txCount24h: Number(row24h?.tx_count || 0),
    usd24h: Number(row24h?.total_usd || 0),
  };
}

/**
 * Record an outbound transaction attempt in the velocity log.
 */
function recordOutboundVelocity({ telegramId, accountType = "personal", action, amountUsd, reference = null }) {
  ensureFraudSchema();
  rawDb
    .prepare(`
      INSERT INTO outbound_velocity_log (telegram_id, account_type, action, amount_usd, reference, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `)
    .run(Number(telegramId), String(accountType || "personal"), String(action || "outbound"), Number(amountUsd || 0), reference || null);
}

/**
 * Assert that a user is allowed to execute an outbound payout/cash-out/card-load/bill payment.
 * - Checks Global Circuit Breaker
 * - Checks if user is blocked/frozen
 * - Checks 10-minute & 1-hour burst frequency tripwires (auto-freezes user + alerts admins on breach!)
 * - Checks Tier-0 vs Tier-1 hourly & 24-hour cumulative USD caps
 * - Logs the outbound movement when allowed
 */
async function assertOutboundAllowed({
  telegramId,
  accountType = "personal",
  action = "outbound",
  amountUsd = 0,
  reference = null,
  bot = null,
  record = true,
}) {
  const cleanAmt = Number(amountUsd || 0);
  if (!Number.isFinite(cleanAmt) || cleanAmt < 0) {
    throw new Error("Invalid transaction amount.");
  }

  // 1. Check Global Circuit Breaker
  const pauseState = isPayoutsPaused();
  if (pauseState.paused) {
    throw new Error(
      `Outbound transfers and card loads are temporarily paused for security maintenance (${pauseState.reason}). Your funds remain 100% safe in your wallet.`
    );
  }

  // 2. Check if user is blocked / frozen
  if (dbModule.isBlocked(telegramId)) {
    throw new Error(
      "Your account is currently frozen by our security system. Please contact Proxim Support or use /unlock if self-locked."
    );
  }

  const cfg = getVelocityConfig();
  const stats = getUserOutboundStats(telegramId);
  const isBiz = accountType === "business";
  const isTier1 = isUserTier1Approved(telegramId, accountType);

  const hourlyLimitUsd = isTier1
    ? (isBiz ? cfg.tier1BizHourlyLimitUsd : cfg.tier1HourlyLimitUsd)
    : cfg.tier0HourlyLimitUsd;
  const dailyLimitUsd = isTier1
    ? (isBiz ? cfg.tier1BizDailyLimitUsd : cfg.tier1DailyLimitUsd)
    : cfg.tier0DailyLimitUsd;

  // 3. Burst Frequency Tripwire -> Auto-Freeze Account + Alert Admins!
  if (stats.txCount10m >= cfg.maxTxPer10Min || stats.txCount1h >= cfg.maxTxPerHour) {
    const tripReason = `fraud_tripwire: burst velocity (${stats.txCount10m + 1} txs in 10m / ${stats.txCount1h + 1} txs in 1h on ${action})`;
    dbModule.blockUser(telegramId, tripReason);

    await alertAdmins(
      bot,
      `🚨 <b>FRAUD TRIPWIRE TRIGGERED — USER AUTO-FROZEN</b>\n` +
      `──────────────────────────\n` +
      `• <b>User ID:</b> <code>${escapeHtml(telegramId)}</code>\n` +
      `• <b>Profile:</b> ${isBiz ? "Business" : "Personal"} (${isTier1 ? "Tier 1" : "Tier 0"})\n` +
      `• <b>Action Blocked:</b> <code>${escapeHtml(action)}</code> ($${cleanAmt.toFixed(2)})\n` +
      `• <b>10-Min Burst:</b> ${stats.txCount10m + 1} txs ($${(stats.usd10m + cleanAmt).toFixed(2)})\n` +
      `• <b>1-Hour Burst:</b> ${stats.txCount1h + 1} txs ($${(stats.usd1h + cleanAmt).toFixed(2)})\n` +
      `• <b>Status:</b> 🔒 Account automatically frozen before funds could leave.`
    );

    throw new Error(
      "Security Tripwire: Unusual transaction burst detected. Your account has been temporarily frozen to protect your balance. Please contact Proxim Support."
    );
  }

  // 4. Hourly USD Velocity Cap
  if (stats.usd1h + cleanAmt > hourlyLimitUsd) {
    const remainingHour = Math.max(0, hourlyLimitUsd - stats.usd1h);
    const tierHint = !isTier1
      ? " Upgrade to Tier 1 (Verify ID/Business) to unlock higher hourly and daily limits."
      : "";
    throw new Error(
      `This transaction ($${cleanAmt.toFixed(2)}) exceeds your ${isTier1 ? "Tier 1" : "Tier 0"} hourly security limit of $${hourlyLimitUsd.toLocaleString()}/hr ($${remainingHour.toFixed(2)} remaining this hour).${tierHint}`
    );
  }

  // 5. 24-Hour Daily Cumulative Cap
  if (stats.usd24h + cleanAmt > dailyLimitUsd) {
    const remainingDay = Math.max(0, dailyLimitUsd - stats.usd24h);
    const tierHint = !isTier1
      ? " Upgrade to Tier 1 (Verify ID/Business) to unlock up to $25,000/day ($100,000/day for Business)."
      : "";
    throw new Error(
      `This transaction ($${cleanAmt.toFixed(2)}) exceeds your ${isTier1 ? "Tier 1" : "Tier 0"} 24-hour limit of $${dailyLimitUsd.toLocaleString()}/day ($${remainingDay.toFixed(2)} remaining today).${tierHint}`
    );
  }

  if (record && cleanAmt > 0) {
    recordOutboundVelocity({
      telegramId,
      accountType,
      action,
      amountUsd: cleanAmt,
      reference,
    });
  }

  return {
    allowed: true,
    tier: isTier1 ? 1 : 0,
    hourlyLimitUsd,
    dailyLimitUsd,
    stats,
  };
}

// ── 3. Chargeback & Reversal Arbitrage Screener for Inbound Fiat / Payment Links

const APPROX_USD_RATES = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  CAD: 0.73,
  AUD: 0.65,
  NZD: 0.60,
  CHF: 1.12,
  AED: 0.272,
  SGD: 0.74,
  HKD: 0.128,
  NGN: 0.00064,
  GHS: 0.065,
  KES: 0.0077,
  TZS: 0.00038,
  UGX: 0.00027,
  ZAR: 0.055,
  MXN: 0.050,
  BRL: 0.18,
};

function estimateUsdValue(currency, amountMajor) {
  const code = String(currency || "USD").toUpperCase();
  const amt = Number(amountMajor || 0);
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  const mult = APPROX_USD_RATES[code] || 1;
  return Number((amt * mult).toFixed(2));
}

/**
 * Screen an inbound Nuvion fiat inflow before auto-sweeping it to irreversible Base USDC.
 * Protects the parent Nuvion account against chargeback-arbitrage on hosted payment links
 * (Interac e-Transfer, Open Banking, MoMo) or inflows arriving on a frozen account.
 */
async function screenInboundFiatInflow({
  entityRecord,
  confirmed,
  netMajor,
  isPaymentLink = false,
  bot = null,
}) {
  ensureFraudSchema();
  const telegramId = entityRecord?.telegram_id;
  const currency = String(confirmed?.currency || "USD").toUpperCase();
  const inflowId = String(confirmed?.id || "");
  const estUsd = estimateUsdValue(currency, netMajor);

  // If an admin already explicitly approved & released this inflow, let it sweep
  const existingLog = inflowId
    ? rawDb.prepare("SELECT * FROM inbound_paylink_log WHERE inflow_id = ?").get(inflowId)
    : null;
  if (existingLog && existingLog.status === "admin_approved") {
    return { hold: false, estUsd, reason: null };
  }

  // 1. Hold if user account is currently blocked/frozen
  if (telegramId && dbModule.isBlocked(telegramId)) {
    const reason = "User account is currently frozen (`is_blocked = 1`)";
    _recordInboundPaylinkLog({ telegramId, entityId: entityRecord?.entity_id, inflowId, currency, amountUsd: estUsd, status: "held", reason });
    await alertAdmins(
      bot,
      `🛡️ <b>INBOUND FIAT HELD (FROZEN USER)</b>\n──────────────────────────\n` +
      `• <b>User ID:</b> <code>${escapeHtml(telegramId)}</code>\n` +
      `• <b>Inflow ID:</b> <code>${escapeHtml(inflowId)}</code>\n` +
      `• <b>Amount:</b> ${escapeHtml(currency)} ${Number(netMajor).toLocaleString()} (~$${estUsd.toFixed(2)})\n` +
      `• <b>Reason:</b> ${escapeHtml(reason)}\n\n` +
      `Funds are safely held in the user's Nuvion ${escapeHtml(currency)} account and were NOT swept to Base.`
    );
    return { hold: true, estUsd, reason };
  }

  // 2. Screen Hosted Payment Links (Interac / Open Banking / MoMo) for chargeback-arbitrage velocity
  const hasFundingSession = Boolean(
    isPaymentLink ||
    confirmed?.meta?.funding_session_id ||
    confirmed?.funding_session_id ||
    String(confirmed?.payment_type || "").toLowerCase().includes("interac")
  );

  if (hasFundingSession && telegramId) {
    const cfg = getVelocityConfig();
    const row24h = rawDb
      .prepare(`
        SELECT COALESCE(SUM(amount_usd), 0) AS total_usd
        FROM inbound_paylink_log
        WHERE telegram_id = ? AND created_at >= datetime('now', '-24 hours')
      `)
      .get(Number(telegramId));
    const prior24hUsd = Number(row24h?.total_usd || 0);

    if (estUsd > cfg.paylinkMaxSingleUsd || prior24hUsd + estUsd > cfg.paylinkMaxDailyUsd) {
      const reason = estUsd > cfg.paylinkMaxSingleUsd
        ? `Hosted payment link inflow (~$${estUsd.toFixed(2)}) exceeds single-tx anti-chargeback threshold ($${cfg.paylinkMaxSingleUsd.toLocaleString()})`
        : `24h hosted payment link volume (~$${(prior24hUsd + estUsd).toFixed(2)}) exceeds daily anti-chargeback cap ($${cfg.paylinkMaxDailyUsd.toLocaleString()})`;

      _recordInboundPaylinkLog({
        telegramId,
        entityId: entityRecord?.entity_id,
        inflowId,
        currency,
        amountUsd: estUsd,
        status: "held",
        reason,
      });

      await alertAdmins(
        bot,
        `🛡️ <b>CHARGEBACK GUARD — PAYMENT LINK INFLOW HELD FOR REVIEW</b>\n` +
        `──────────────────────────\n` +
        `• <b>User ID:</b> <code>${escapeHtml(telegramId)}</code>\n` +
        `• <b>Inflow ID:</b> <code>${escapeHtml(inflowId)}</code>\n` +
        `• <b>Amount:</b> ${escapeHtml(currency)} ${Number(netMajor).toLocaleString()} (~$${estUsd.toFixed(2)})\n` +
        `• <b>Reason:</b> ${escapeHtml(reason)}\n\n` +
        `Funds remain safely in the user's Nuvion ${escapeHtml(currency)} account. Use <code>/release_inflow ${escapeHtml(inflowId)}</code> after verifying the payment source.`
      );

      return { hold: true, estUsd, reason };
    }

    _recordInboundPaylinkLog({
      telegramId,
      entityId: entityRecord?.entity_id,
      inflowId,
      currency,
      amountUsd: estUsd,
      status: "cleared",
      reason: null,
    });
  }

  return { hold: false, estUsd, reason: null };
}

function _recordInboundPaylinkLog({ telegramId, entityId, inflowId, currency, amountUsd, status, reason }) {
  if (!inflowId) return;
  try {
    rawDb
      .prepare(`
        INSERT INTO inbound_paylink_log (telegram_id, entity_id, inflow_id, currency, amount_usd, status, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(inflow_id) DO UPDATE SET
          status = excluded.status,
          reason = excluded.reason
      `)
      .run(Number(telegramId || 0), entityId || null, String(inflowId), String(currency), Number(amountUsd || 0), String(status), reason || null);
  } catch (_) {}
}

function approveHeldInflow(inflowId) {
  ensureFraudSchema();
  if (!inflowId) return false;
  rawDb
    .prepare(`
      INSERT INTO inbound_paylink_log (telegram_id, entity_id, inflow_id, currency, amount_usd, status, reason, created_at)
      VALUES (0, NULL, ?, 'USD', 0, 'admin_approved', 'Approved by admin', datetime('now'))
      ON CONFLICT(inflow_id) DO UPDATE SET
        status = 'admin_approved',
        reason = 'Approved by admin'
    `)
    .run(String(inflowId));

  // Also flip any held_fraud_review job back to retry_pending so the reconciler/orchestrator can sweep it
  try {
    rawDb
      .prepare(`
        UPDATE nuvion_jobs
        SET state = 'retry_pending', updated_at = datetime('now')
        WHERE (nuvion_transfer_id = ? OR unique_reference = ?)
          AND state = 'held_fraud_review'
      `)
      .run(String(inflowId), `sweep-in-${inflowId}`);
  } catch (_) {}

  return true;
}

module.exports = {
  ensureFraudSchema,
  isPayoutsPaused,
  setPayoutsPaused,
  getVelocityConfig,
  isUserTier1Approved,
  getUserOutboundStats,
  recordOutboundVelocity,
  assertOutboundAllowed,
  estimateUsdValue,
  screenInboundFiatInflow,
  approveHeldInflow,
  alertAdmins,
};
