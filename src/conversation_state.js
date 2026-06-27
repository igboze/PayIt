// src/conversation_state.js
// Persistent conversation state store — replaces the in-memory pendingAction Map.
//
// Why this exists:
//   The original bot used a Map() for pending multi-step flows. That works
//   until the process restarts (state gone), a user walks away mid-flow and
//   comes back hours later (stale state), or the context switches mid-flow
//   (wrong wallet used). This module fixes all three.
//
// Key behaviours:
//   - Stored in SQLite alongside the rest of the app data (same db instance)
//   - Every state entry carries the account context it was created in
//   - States expire after STATE_TTL_MINUTES of inactivity
//   - Expired states are cleaned up lazily on every read and on a periodic sweep
//   - API is a drop-in replacement for Map: setState / getState / clearState

const STATE_TTL_MINUTES = 30;

let _db = null;

function getDb() {
  if (!_db) _db = require("./db").db;
  return _db;
}

function initStateTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS conversation_state (
      telegram_id   INTEGER PRIMARY KEY,
      state_type    TEXT    NOT NULL,
      state_data    TEXT    NOT NULL DEFAULT '{}',
      context       TEXT    NOT NULL DEFAULT 'personal',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at    TEXT    NOT NULL
    );
  `);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function expiresAt() {
  const d = new Date();
  d.setMinutes(d.getMinutes() + STATE_TTL_MINUTES);
  return d.toISOString();
}

function isExpired(row) {
  return row && new Date(row.expires_at) < new Date();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Set (or replace) the pending state for a user.
 *
 * @param {number|string} telegramId
 * @param {string}        stateType   - e.g. "await_withdraw_amount"
 * @param {object}        data        - any JSON-serialisable payload
 * @param {string}        context     - 'personal' | 'business'
 */
function setState(telegramId, stateType, data = {}, context = "personal") {
  const db = getDb();
  db.prepare(`
    INSERT INTO conversation_state (telegram_id, state_type, state_data, context, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      state_type = excluded.state_type,
      state_data = excluded.state_data,
      context    = excluded.context,
      created_at = datetime('now'),
      expires_at = excluded.expires_at
  `).run(
    Number(telegramId),
    stateType,
    JSON.stringify(data),
    context,
    expiresAt()
  );
}

/**
 * Get the current pending state for a user.
 * Returns null if no state exists or the state has expired.
 *
 * @param {number|string} telegramId
 * @returns {{ type: string, data: object, context: string } | null}
 */
function getState(telegramId) {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM conversation_state WHERE telegram_id = ?"
  ).get(Number(telegramId));

  if (!row) return null;

  if (isExpired(row)) {
    clearState(telegramId);
    return null;
  }

  return {
    type:    row.state_type,
    data:    JSON.parse(row.state_data),
    context: row.context,
  };
}

/**
 * Clear the pending state for a user (after a flow completes or is cancelled).
 *
 * @param {number|string} telegramId
 */
function clearState(telegramId) {
  getDb()
    .prepare("DELETE FROM conversation_state WHERE telegram_id = ?")
    .run(Number(telegramId));
}

/**
 * Bump the expiry on an existing state (keeps a long-running flow alive).
 * Call this each time a valid step is received inside a multi-step flow.
 *
 * @param {number|string} telegramId
 */
function touchState(telegramId) {
  getDb().prepare(`
    UPDATE conversation_state
    SET expires_at = ?
    WHERE telegram_id = ?
  `).run(expiresAt(), Number(telegramId));
}

/**
 * Sweep expired rows. Call this on bot startup and periodically (e.g. hourly).
 */
function purgeExpired() {
  const result = getDb()
    .prepare("DELETE FROM conversation_state WHERE expires_at < datetime('now')")
    .run();
  if (result.changes > 0) {
    console.log(`[conversation_state] Purged ${result.changes} expired state(s).`);
  }
}

module.exports = {
  initStateTable,
  setState,
  getState,
  clearState,
  touchState,
  purgeExpired,
};
