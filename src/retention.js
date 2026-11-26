// src/retention.js
// User Activation, Retention & Two-Tier Clarity Engine for Proxim:
// 1. Scannable Tier 0 (Active Now — No KYC) vs Tier 1 (Personal KYC / Business KYB) cards
// 2. First-Transaction Welcome Bonus (+20 pts = $1.00 airtime/bill credit) + Just-in-Time Tier-1 Nudge
// 3. 1-Tap Monthly Bill Payment Reminders (SQLite-backed)
// 4. Weekly Auto-Earn Yield Earnings Nudges (deduplicated per ISO week)

const { Markup } = require("telegraf");
const dbModule = require("./db");
const savings = require("./savings");

const rawDb = dbModule.db;
const FIRST_TX_BONUS_POINTS = 20; // 20 pts = $1.00 airtime/bill credit

function ensureRetentionSchema() {
  try {
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS user_retention_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        event_key   TEXT NOT NULL,
        meta_json   TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(telegram_id, event_key)
      );

      CREATE TABLE IF NOT EXISTS bill_reminders (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id   INTEGER NOT NULL,
        category      TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        recipient     TEXT NOT NULL,
        amount_ngn    REAL NOT NULL DEFAULT 0,
        remind_at     TEXT NOT NULL,
        sent_at       TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_bill_reminders_due
        ON bill_reminders(sent_at, remind_at);
    `);
  } catch (err) {
    console.warn("[retention] ensureRetentionSchema note:", err.message);
  }
}

ensureRetentionSchema();

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getBotTelegram(bot) {
  if (!bot) return null;
  if (bot.telegram && typeof bot.telegram.sendMessage === "function") return bot.telegram;
  if (bot.bot?.telegram && typeof bot.bot.telegram.sendMessage === "function") return bot.bot.telegram;
  return null;
}

// ── 1. Tier 0 vs Tier 1 Comparison Card ──────────────────────────────────────

function _formatTierStatusBadge(st, kind = "KYC") {
  const s = String(st || "").toLowerCase();
  if (s === "approved") return `Tier 1 ${kind} Verified ✅`;
  if (s === "pending" || s === "incomplete") return `Tier 0 Active · ⏳ ${kind} Under Review`;
  if (s === "rejected" || s === "failed" || s === "blocked") return `❌ ${kind} Action Needed`;
  return `Tier 0 — Active Now (No ${kind} Needed)`;
}

function buildTierComparisonHtml(isBusiness = false, nuvionStatus = "", extra = {}) {
  const activeKind = isBusiness ? "KYB" : "KYC";
  const statusBadge = _formatTierStatusBadge(nuvionStatus, activeKind);

  const hasSeparateStatuses = extra && (extra.personalStatus !== undefined || extra.businessStatus !== undefined);
  const statusSection = hasSeparateStatuses
    ? `• <b>Personal KYC:</b> ${_formatTierStatusBadge(extra.personalStatus, "KYC")}\n` +
      (extra.hasBusiness
        ? `• <b>Business KYB:</b> ${_formatTierStatusBadge(extra.businessStatus, "KYB")}\n`
        : `• <b>Business KYB:</b> <i>No Business account set up yet</i>\n`) +
      `• <b>Active Account:</b> ${isBusiness ? "Business 💼" : "Personal 👤"}\n\n`
    : `<b>Your Status (${isBusiness ? "Business KYB" : "Personal KYC"}):</b> ${statusBadge}\n\n`;

  const tier1Label = isBusiness ? "Tier 1 — Business KYB" : "Tier 1 — Personal KYC";
  const tier1Limit = isBusiness ? "$50,000/hr · $100,000/day" : "$10,000/hr · $25,000/day";
  const tier1Extras = isBusiness
    ? "• Named Company Bank Accounts (USD, GBP, EUR, CAD, AED)\n• Business &amp; Team USD Cards\n• Send Abroad &amp; CSV Payroll (27+ Currencies)"
    : "• Named Global Bank Accounts (USD, GBP, EUR, CAD, AED)\n• Virtual &amp; Disposable USD Cards\n• Send Abroad to 27+ Currencies";

  return (
    `🏷️ <b>Proxim Account Tiers &amp; Limits</b>\n` +
    `──────────────────────────\n` +
    statusSection +
    `✅ <b>Tier 0 — Ready Now (No ${activeKind} Needed)</b>\n` +
    `• Nigerian Naira (NGN) deposits &amp; bank transfers\n` +
    `• Crypto deposits &amp; transfers (11 chains) + instant @username sends\n` +
    `• Dollar Savings (auto-yield), Bills &amp; Airtime, Crypto Invoices\n` +
    `• <i>Limits: up to $300/hr · $500/day</i>\n\n` +
    `🌍 <b>${tier1Label} (2-Min Verification)</b>\n` +
    `${tier1Extras}\n` +
    `• <i>Limits: up to ${tier1Limit}</i>`
  );
}

// ── 2. First-Transaction Welcome Bonus + Just-in-Time Tier-1 Nudge ───────────

async function handleFirstQualifyingTransaction({
  telegramId,
  amountUsd = 0,
  action = "transaction",
  context = "personal",
  bot = null,
}) {
  ensureRetentionSchema();
  if (!telegramId) return { awarded: false, reason: "no_user" };

  // Ignore free/non-value actions
  if (action === "invoice" || action === "businessInvoice" || action === "referral_bonus" || action === "first_tx_bonus") {
    return { awarded: false, reason: "non_qualifying_action" };
  }

  // Atomic once-per-user claim
  const insertRes = rawDb
    .prepare(
      "INSERT OR IGNORE INTO user_retention_events (telegram_id, event_key, meta_json) VALUES (?, 'first_tx_bonus', ?)"
    )
    .run(Number(telegramId), JSON.stringify({ action, amountUsd }));

  if (!insertRes || insertRes.changes === 0) {
    return { awarded: false, reason: "already_awarded" };
  }

  try {
    dbModule.awardPoints(
      Number(telegramId),
      FIRST_TX_BONUS_POINTS,
      "first_tx_bonus",
      "First transaction welcome bonus ($1.00 airtime/bill credit)"
    );
  } catch (err) {
    console.warn("[retention:first_tx_bonus]", err.message);
  }

  const telegram = getBotTelegram(bot);
  if (telegram) {
    const isBiz = context === "business";
    const ent = dbModule.getNuvionEntityByUser(Number(telegramId), context);
    const isApproved = String(ent?.status || "").toLowerCase() === "approved";

    const upgradeBlock = isApproved
      ? ""
      : `\n\n🌍 <b>Ready for more?</b> Unlock named USD, GBP &amp; EUR bank accounts + Virtual USD Cards in 2 mins.`;
    const buttons = isApproved
      ? [[Markup.button.callback("🏅 View Rewards", "action_rewards")]]
      : [
          [Markup.button.callback(isBiz ? "💼 Unlock Tier 1 (Business KYB)" : "🪪 Unlock Tier 1 (Global Accounts & Cards)", isBiz ? "biz_nuvion_portal" : "action_nuvion_portal")],
          [Markup.button.callback("🏅 View Rewards ($1.00 Credit)", "action_rewards")],
        ];

    await telegram
      .sendMessage(
        Number(telegramId),
        `🎉 <b>First Transaction Bonus Unlocked!</b>\n` +
          `──────────────────────────\n` +
          `You earned <b>+${FIRST_TX_BONUS_POINTS} points ($1.00 credit)</b> — redeem anytime for airtime or bills in <b>Settings → Rewards</b>.` +
          upgradeBlock,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) }
      )
      .catch(() => {});
  }

  return { awarded: true, points: FIRST_TX_BONUS_POINTS };
}

// ── 3. 1-Tap Monthly Bill Payment Reminders ──────────────────────────────────

function scheduleBillReminder({ telegramId, category, providerName, recipient, amountNgn, days = 30 }) {
  ensureRetentionSchema();
  const safeDays = Math.max(1, Math.min(90, Number(days) || 30));
  const remindDate = new Date(Date.now() + safeDays * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const res = rawDb
    .prepare(`
      INSERT INTO bill_reminders (telegram_id, category, provider_name, recipient, amount_ngn, remind_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      Number(telegramId),
      String(category || "bills"),
      String(providerName || "Bill"),
      String(recipient || ""),
      Number(amountNgn || 0),
      remindDate
    );
  return { id: Number(res.lastInsertRowid), remindAt: remindDate };
}

async function processDueBillReminders(bot = null) {
  ensureRetentionSchema();
  const due = rawDb
    .prepare("SELECT * FROM bill_reminders WHERE sent_at IS NULL AND remind_at <= datetime('now') LIMIT 50")
    .all();

  if (!due.length) return { sent: 0 };
  const telegram = getBotTelegram(bot);
  let sent = 0;

  for (const r of due) {
    rawDb.prepare("UPDATE bill_reminders SET sent_at = datetime('now') WHERE id = ?").run(r.id);
    if (telegram) {
      await telegram
        .sendMessage(
          r.telegram_id,
          `🔔 <b>Monthly Bill Reminder</b>\n` +
            `──────────────────────────\n` +
            `Your <b>${escapeHtml(r.provider_name)}</b> bill (₦${Number(r.amount_ngn || 0).toLocaleString("en-NG")} for <code>${escapeHtml(r.recipient)}</code>) is due.\n\n` +
            `Tap below to renew in seconds:`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("⚡ Pay Bills Now", "action_bills_menu")],
              [Markup.button.callback("💰 Check Balance", "action_balance")],
            ]),
          }
        )
        .catch(() => {});
      sent++;
    }
  }
  return { sent };
}

// ── 4. Weekly Auto-Earn Yield Nudge ──────────────────────────────────────────

function getIsoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `yield_nudge_${d.getUTCFullYear()}_W${String(weekNo).padStart(2, "0")}`;
}

async function sendWeeklyYieldNudges(bot = null) {
  ensureRetentionSchema();
  const telegram = getBotTelegram(bot);
  if (!telegram) return { sent: 0 };

  const weekKey = getIsoWeekKey();
  const positions = rawDb
    .prepare("SELECT * FROM yield_positions WHERE status = 'open' AND amount_usdc >= 1")
    .all();

  let sent = 0;
  for (const pos of positions) {
    const gross = savings.calcAccruedYield(pos);
    const netProfit = gross * (1 - savings.PAYIT_FEE_FRACTION);
    if (netProfit < 0.01) continue;

    const claimed = rawDb
      .prepare(
        "INSERT OR IGNORE INTO user_retention_events (telegram_id, event_key, meta_json) VALUES (?, ?, ?)"
      )
      .run(Number(pos.telegram_id), weekKey, JSON.stringify({ netProfit, principal: pos.amount_usdc }));

    if (!claimed || claimed.changes === 0) continue;

    await telegram
      .sendMessage(
        pos.telegram_id,
        `📈 <b>Your Dollars Earned +$${netProfit.toFixed(4)}!</b>\n` +
          `──────────────────────────\n` +
          `• <b>Saved Principal:</b> $${Number(pos.amount_usdc).toFixed(2)} USDC\n` +
          `• <b>Live APY:</b> ${Number(pos.apy || 0).toFixed(1)}%\n\n` +
          `<i>Your balance compounds automatically — withdraw anytime with zero lockup.</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("💰 View Balance", "action_balance"), Markup.button.callback("💵 Withdraw Savings", "yield_withdraw_start")],
          ]),
        }
      )
      .catch(() => {});
    sent++;
  }
  return { sent };
}

let _retentionInterval = null;
function startRetentionScheduler(bot, intervalMs = 60 * 60 * 1000) {
  if (process.env.NODE_ENV === "test") return;
  if (_retentionInterval) return;
  _retentionInterval = setInterval(async () => {
    try {
      await processDueBillReminders(bot);
      // Send weekly yield nudges on Mondays (UTC day === 1)
      if (new Date().getUTCDay() === 1) {
        await sendWeeklyYieldNudges(bot);
      }
    } catch (err) {
      console.warn("[retention:scheduler]", err.message);
    }
  }, intervalMs);
}

function stopRetentionScheduler() {
  if (_retentionInterval) {
    clearInterval(_retentionInterval);
    _retentionInterval = null;
  }
}

module.exports = {
  FIRST_TX_BONUS_POINTS,
  ensureRetentionSchema,
  buildTierComparisonHtml,
  handleFirstQualifyingTransaction,
  scheduleBillReminder,
  processDueBillReminders,
  sendWeeklyYieldNudges,
  startRetentionScheduler,
  stopRetentionScheduler,
};
