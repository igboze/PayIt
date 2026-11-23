// src/pods_store.js
// SQLite ledger, webhook processor, and fallback poller for Pods Finance Investments
// (Ondo US Stocks & ETFs + OpenCover Insured & High-Yield Savings Vaults)

const dbMod = require("./db");
const pods = require("./pods");

const db = dbMod.db;

db.exec(`
  CREATE TABLE IF NOT EXISTS pods_actions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id     INTEGER NOT NULL,
    account_type    TEXT NOT NULL DEFAULT 'personal',
    wallet_address  TEXT NOT NULL,
    kind            TEXT NOT NULL,
    strategy_id     TEXT NOT NULL,
    ticker          TEXT,
    amount_usd      REAL NOT NULL DEFAULT 0,
    tx_hash         TEXT,
    pods_action_id  TEXT UNIQUE,
    status          TEXT NOT NULL DEFAULT 'PENDING',
    notified        INTEGER NOT NULL DEFAULT 0,
    meta_json       TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_pods_actions_user ON pods_actions(telegram_id, account_type);
  CREATE INDEX IF NOT EXISTS idx_pods_actions_status ON pods_actions(status, notified);

  CREATE TABLE IF NOT EXISTS pods_disclaimers (
    telegram_id  INTEGER PRIMARY KEY,
    accepted_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const TERMINAL_STATUSES = new Set(["SUCCESS", "FAILED", "REFUNDED", "EXPIRED"]);

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hasAcceptedInvestmentsDisclaimer(telegramId) {
  const row = db.prepare("SELECT telegram_id FROM pods_disclaimers WHERE telegram_id = ?").get(Number(telegramId));
  return Boolean(row);
}

function acceptInvestmentsDisclaimer(telegramId) {
  db.prepare(
    "INSERT OR IGNORE INTO pods_disclaimers (telegram_id, accepted_at) VALUES (?, datetime('now'))"
  ).run(Number(telegramId));
}

function recordPodsAction({
  telegramId,
  accountType = "personal",
  walletAddress,
  kind,
  strategyId,
  ticker = null,
  amountUsd = 0,
  txHash = null,
  podsActionId = null,
  status = "PENDING",
  meta = null,
}) {
  const stmt = db.prepare(`
    INSERT INTO pods_actions
      (telegram_id, account_type, wallet_address, kind, strategy_id, ticker, amount_usd, tx_hash, pods_action_id, status, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const res = stmt.run(
    Number(telegramId),
    String(accountType || "personal"),
    String(walletAddress),
    String(kind),
    String(strategyId),
    ticker ? String(ticker).toUpperCase() : null,
    Number(amountUsd || 0),
    txHash ? String(txHash) : null,
    podsActionId ? String(podsActionId) : null,
    String(status || "PENDING").toUpperCase(),
    meta ? JSON.stringify(meta) : null
  );
  return Number(res.lastInsertRowid);
}

function getPodsActionByPodsId(podsActionId) {
  if (!podsActionId) return null;
  return db.prepare("SELECT * FROM pods_actions WHERE pods_action_id = ?").get(String(podsActionId)) || null;
}

function getPendingPodsActions(limit = 30) {
  return db.prepare(`
    SELECT * FROM pods_actions
    WHERE pods_action_id IS NOT NULL
      AND notified = 0
      AND status NOT IN ('SUCCESS', 'FAILED', 'REFUNDED', 'EXPIRED')
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}

function getUserTrackedStockTickers(telegramId, accountType = "personal") {
  const rows = db.prepare(`
    SELECT DISTINCT ticker FROM pods_actions
    WHERE telegram_id = ? AND account_type = ? AND ticker IS NOT NULL
      AND kind IN ('stock_buy', 'stock_sell')
    ORDER BY id DESC
  `).all(Number(telegramId), String(accountType || "personal"));
  return rows.map((r) => r.ticker).filter(Boolean);
}

function getUserTrackedVaultIds(telegramId, accountType = "personal") {
  const rows = db.prepare(`
    SELECT DISTINCT strategy_id FROM pods_actions
    WHERE telegram_id = ? AND account_type = ?
      AND kind IN ('vault_deposit', 'vault_withdraw')
    ORDER BY id DESC
  `).all(Number(telegramId), String(accountType || "personal"));
  return rows.map((r) => r.strategy_id).filter(Boolean);
}

function getUserRecentPodsActions(telegramId, accountType = "personal", limit = 10) {
  return db.prepare(`
    SELECT * FROM pods_actions
    WHERE telegram_id = ? AND account_type = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(Number(telegramId), String(accountType || "personal"), limit);
}

function updatePodsActionStatus(podsActionId, status, { notified = null, meta = null } = {}) {
  const fields = ["status = ?", "updated_at = datetime('now')"];
  const values = [String(status || "PENDING").toUpperCase()];
  if (notified !== null) {
    fields.push("notified = ?");
    values.push(notified ? 1 : 0);
  }
  if (meta !== null) {
    fields.push("meta_json = ?");
    values.push(typeof meta === "string" ? meta : JSON.stringify(meta));
  }
  values.push(String(podsActionId));
  db.prepare(`UPDATE pods_actions SET ${fields.join(", ")} WHERE pods_action_id = ?`).run(...values);
}

/**
 * Process a Pods ACTION_UPDATE webhook payload (or polled action object) idempotently
 * and notify the user in Telegram once it reaches a terminal state.
 */
async function processPodsActionUpdate(bot, actionData) {
  if (!actionData || !actionData.id) return { handled: false, reason: "missing_id" };
  const podsActionId = String(actionData.id);
  const nextStatus = String(actionData.status || "PENDING").toUpperCase();
  const row = getPodsActionByPodsId(podsActionId);
  if (!row) return { handled: false, reason: "unknown_action" };

  const isTerminal = TERMINAL_STATUSES.has(nextStatus);
  if (row.notified === 1 && row.status === nextStatus) {
    return { handled: true, duplicate: true, status: nextStatus };
  }

  updatePodsActionStatus(podsActionId, nextStatus, {
    notified: isTerminal ? 1 : 0,
    meta: actionData,
  });

  if (!isTerminal || row.notified === 1) {
    return { handled: true, notified: false, status: nextStatus };
  }

  const tg = bot?.telegram || bot?.bot?.telegram || null;
  if (tg && row.telegram_id) {
    const isStock = row.kind === "stock_buy" || row.kind === "stock_sell";
    const label = isStock
      ? `${row.ticker || row.strategy_id} Stock`
      : (pods.getSavingsVaultByShortId(row.strategy_id)?.name || row.strategy_id);
    const verb =
      row.kind === "stock_buy" ? "Stock Purchase" :
      row.kind === "stock_sell" ? "Stock Sale" :
      row.kind === "vault_deposit" ? "Savings Deposit" :
      "Savings Withdrawal";

    let msg;
    if (nextStatus === "SUCCESS") {
      msg =
        `✅ <b>${escapeHtml(verb)} Settled!</b>\n` +
        `──────────────────────────\n` +
        `• <b>Asset:</b> ${escapeHtml(label)}\n` +
        (row.amount_usd > 0 ? `• <b>Amount:</b> $${Number(row.amount_usd).toFixed(2)}\n` : "") +
        `• <b>Status:</b> Confirmed\n` +
        (row.kind === "stock_sell" || row.kind === "vault_withdraw"
          ? `\n<i>Proceeds settle into your Proxim USD balance automatically.</i>`
          : `\n<i>View your live holdings anytime under 📈 Stocks &amp; Yield.</i>`);
    } else {
      msg =
        `⚠️ <b>${escapeHtml(verb)} ${escapeHtml(nextStatus)}</b>\n` +
        `──────────────────────────\n` +
        `• <b>Asset:</b> ${escapeHtml(label)}\n` +
        `• <b>Action ID:</b> <code>${escapeHtml(podsActionId)}</code>\n` +
        `<i>If funds were debited, Pods automatically refunds them to your wallet.</i>`;
    }

    await tg.sendMessage(row.telegram_id, msg, { parse_mode: "HTML" }).catch((err) => {
      console.warn("[pods_store] Telegram notify notice:", err.message);
    });
  }

  return { handled: true, notified: true, status: nextStatus };
}

/**
 * Fallback background poller for pending Pods actions (so notifications work even before
 * Pods support registers POST /webhooks/pods).
 */
async function pollPendingPodsActions(bot) {
  if (!pods.isConfigured()) return 0;
  const pending = getPendingPodsActions(25);
  let updated = 0;
  for (const row of pending) {
    try {
      const live = await pods.getActionStatus(row.pods_action_id);
      if (live && live.status && String(live.status).toUpperCase() !== row.status) {
        await processPodsActionUpdate(bot, live);
        updated++;
      }
    } catch (err) {
      // Non-fatal: retry next cycle
      console.warn(`[pods_poller] Action ${row.pods_action_id} check:`, err.message);
    }
  }
  return updated;
}

module.exports = {
  hasAcceptedInvestmentsDisclaimer,
  acceptInvestmentsDisclaimer,
  recordPodsAction,
  getPodsActionByPodsId,
  getPendingPodsActions,
  getUserTrackedStockTickers,
  getUserTrackedVaultIds,
  getUserRecentPodsActions,
  updatePodsActionStatus,
  processPodsActionUpdate,
  pollPendingPodsActions,
};
