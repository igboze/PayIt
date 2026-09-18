// src/idempotency.js
// Deterministic Idempotency Ledger for PayIT Payroll & Bulk Payments
// Prevents duplicate debits, race conditions, and double payouts across retries and re-submissions.

const crypto = require("crypto");
const db = require("./db").db;

/**
 * Initialize idempotency table in SQLite.
 */
function initIdempotencyTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_idempotency (
      key           TEXT PRIMARY KEY,
      batch_id      TEXT NOT NULL,
      row_index     INTEGER,
      recipient     TEXT NOT NULL,
      amount        REAL NOT NULL,
      currency      TEXT NOT NULL,
      method        TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      tx_hash       TEXT,
      reference     TEXT,
      error         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_payroll_idemp_batch 
      ON payroll_idempotency(batch_id);
    CREATE INDEX IF NOT EXISTS idx_payroll_idemp_status 
      ON payroll_idempotency(status);
  `);
}

// Auto-initialize on file load
try {
  initIdempotencyTable();
  initUniversalIdempotency();
} catch (e) {
  // Ignore
}

function initUniversalIdempotency() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_webhook_events (
      event_id      TEXT PRIMARY KEY,
      event_type    TEXT NOT NULL,
      resource_id   TEXT,
      processed_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS universal_idempotency (
      key           TEXT PRIMARY KEY,
      scope         TEXT NOT NULL,
      telegram_id   INTEGER,
      account_type  TEXT NOT NULL DEFAULT 'personal',
      amount        REAL,
      status        TEXT NOT NULL DEFAULT 'pending',
      tx_hash       TEXT,
      response_data TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_univ_idemp_scope ON universal_idempotency(scope, status);
  `);
}

/**
 * Check if a webhook event ID has already been executed.
 */
function isWebhookProcessed(eventId) {
  if (!eventId) return false;
  const row = db.prepare("SELECT event_id FROM processed_webhook_events WHERE event_id = ?").get(String(eventId));
  return Boolean(row);
}

/**
 * Mark a webhook event as successfully executed to prevent duplicate delivery.
 */
function markWebhookProcessed(eventId, eventType = "unknown", resourceId = null) {
  if (!eventId) return;
  db.prepare(`
    INSERT OR IGNORE INTO processed_webhook_events (event_id, event_type, resource_id, processed_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(String(eventId), String(eventType), resourceId ? String(resourceId) : null);
}

/**
 * Check if a payment/offramp/yield operation with this idempotency key already exists.
 */
function checkOperationIdempotency(key) {
  if (!key) return null;
  const row = db.prepare("SELECT * FROM universal_idempotency WHERE key = ?").get(String(key));
  if (!row) return null;
  let parsedResponse = null;
  try {
    parsedResponse = row.response_data ? JSON.parse(row.response_data) : null;
  } catch {}
  return {
    key: row.key,
    scope: row.scope,
    telegramId: row.telegram_id,
    accountType: row.account_type,
    amount: row.amount,
    status: row.status,
    txHash: row.tx_hash,
    responseData: parsedResponse,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/**
 * Acquire lock / start operation under an idempotency key.
 */
function startOperationIdempotency(key, { scope = "general", telegramId = null, accountType = "personal", amount = 0 } = {}) {
  if (!key) return;
  db.prepare(`
    INSERT INTO universal_idempotency (
      key, scope, telegram_id, account_type, amount, status, created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      status = 'pending',
      tx_hash = NULL
    WHERE status != 'completed'
  `).run(String(key), scope, telegramId, accountType, Number(amount || 0));
}

/**
 * Mark operation as successfully completed.
 */
function completeOperationIdempotency(key, { txHash = null, responseData = null } = {}) {
  if (!key) return;
  const respStr = responseData ? JSON.stringify(responseData) : null;
  db.prepare(`
    UPDATE universal_idempotency SET
      status = 'completed',
      tx_hash = ?,
      response_data = ?,
      completed_at = datetime('now')
    WHERE key = ?
  `).run(txHash, respStr, String(key));
}

/**
 * Mark operation as failed to release lock.
 */
function failOperationIdempotency(key, error = null) {
  if (!key) return;
  db.prepare(`
    UPDATE universal_idempotency SET
      status = 'failed',
      response_data = ?,
      completed_at = datetime('now')
    WHERE key = ? AND status != 'completed'
  `).run(JSON.stringify({ error: String(error || "Operation failed") }), String(key));
}

/**
 * Clear operation records for testing.
 */
function clearOperationIdempotency(key) {
  if (!key) return;
  db.prepare("DELETE FROM universal_idempotency WHERE key = ?").run(String(key));
}

/**
 * Generate a deterministic SHA-256 idempotency key for a payroll payment row.
 *
 * @param {string} batchId - Unique ID for the payroll file/session
 * @param {number} rowIndex - 0-indexed position in the file
 * @param {object} item - Payment record { to, amount, currency, account_number, id }
 * @returns {string} Hex idempotency key
 */
function generateIdempotencyKey(batchId, rowIndex, item) {
  if (item && item.idempotency_key) {
    return String(item.idempotency_key);
  }
  if (item && item.id) {
    return `${batchId}:${item.id}`;
  }

  const destination = item.to || item.account_number || item.wallet_address || `row_${rowIndex}`;
  const amountStr = String(item.amount || 0);
  const currencyStr = String(item.currency || "USDC").toUpperCase();

  const raw = `${batchId || "default_batch"}:${rowIndex}:${destination}:${amountStr}:${currencyStr}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/**
 * Check if a payment with this idempotency key already exists.
 *
 * @param {string} key
 * @returns {object|null}
 */
function checkIdempotency(key) {
  if (!key) return null;
  const row = db.prepare("SELECT * FROM payroll_idempotency WHERE key = ?").get(key);
  if (!row) return null;

  return {
    key: row.key,
    batchId: row.batch_id,
    rowIndex: row.row_index,
    recipient: row.recipient,
    amount: row.amount,
    currency: row.currency,
    method: row.method,
    status: row.status,
    txHash: row.tx_hash,
    reference: row.reference,
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/**
 * Record payment initiation under an idempotency key.
 *
 * @param {string} key
 * @param {object} details
 */
function startIdempotency(key, { batchId, rowIndex, recipient, amount, currency, method }) {
  if (!key) return;
  db.prepare(`
    INSERT INTO payroll_idempotency (
      key, batch_id, row_index, recipient, amount, currency, method, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      status = 'pending',
      error = NULL
    WHERE status != 'completed'
  `).run(
    key,
    batchId || "batch",
    rowIndex ?? null,
    String(recipient || ""),
    Number(amount || 0),
    String(currency || "USDC"),
    String(method || "unknown")
  );
}

/**
 * Mark payment as successfully completed under an idempotency key.
 *
 * @param {string} key
 * @param {object} details - { txHash, reference }
 */
function completeIdempotency(key, { txHash, reference } = {}) {
  if (!key) return;
  db.prepare(`
    UPDATE payroll_idempotency SET
      status = 'completed',
      tx_hash = ?,
      reference = ?,
      error = NULL,
      completed_at = datetime('now')
    WHERE key = ?
  `).run(txHash || null, reference || null, key);
}

/**
 * Mark payment as failed under an idempotency key.
 *
 * @param {string} key
 * @param {string} error
 */
function failIdempotency(key, error) {
  if (!key) return;
  db.prepare(`
    UPDATE payroll_idempotency SET
      status = 'failed',
      error = ?
    WHERE key = ? AND status != 'completed'
  `).run(String(error || "Payment failed"), key);
}

/**
 * Get summary of payments for a given batch.
 *
 * @param {string} batchId
 * @returns {{ total: number, completed: number, pending: number, failed: number, records: object[] }}
 */
function getBatchStatus(batchId) {
  const records = db.prepare("SELECT * FROM payroll_idempotency WHERE batch_id = ? ORDER BY row_index ASC").all(batchId);
  const completed = records.filter(r => r.status === "completed").length;
  const pending = records.filter(r => r.status === "pending").length;
  const failed = records.filter(r => r.status === "failed").length;

  return {
    total: records.length,
    completed,
    pending,
    failed,
    records,
  };
}

/**
 * Clear records for testing.
 */
function clearBatch(batchId) {
  db.prepare("DELETE FROM payroll_idempotency WHERE batch_id = ?").run(batchId);
}

module.exports = {
  initIdempotencyTable,
  initUniversalIdempotency,
  isWebhookProcessed,
  markWebhookProcessed,
  checkOperationIdempotency,
  startOperationIdempotency,
  completeOperationIdempotency,
  failOperationIdempotency,
  clearOperationIdempotency,
  generateIdempotencyKey,
  checkIdempotency,
  startIdempotency,
  completeIdempotency,
  failIdempotency,
  getBatchStatus,
  clearBatch,
};
