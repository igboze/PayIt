// src/payee_book.js
// Payee / contact book — lets users save wallet addresses and bank details
// under a human name so they never have to type a 0x address again.
//
// On-chain payees: name + wallet_address
// Off-ramp payees: name + bank_name + account_number + account_name
// A payee can have both (same person, two payout methods).
//
// Resolution: the intent router calls resolvePayee(userId, nameOrAddress)
// which returns the best match, falling back to a raw 0x address if the
// input already looks like one.

let _db = null;
function getDb() {
  if (!_db) _db = require("./db").db;
  return _db;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

function initPayeeTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS payee_book (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id     INTEGER NOT NULL,
      name            TEXT    NOT NULL,
      wallet_address  TEXT,
      bank_name       TEXT,
      account_number  TEXT,
      account_name    TEXT,
      notes           TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(telegram_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_payee_user ON payee_book(telegram_id);
  `);
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Save or update a payee.
 * At least one of walletAddress or accountNumber must be provided.
 */
function upsertPayee(telegramId, {
  name,
  walletAddress  = null,
  bankName       = null,
  accountNumber  = null,
  accountName    = null,
  notes          = null,
}) {
  if (!walletAddress && !accountNumber) {
    throw new Error("Payee must have at least a wallet address or bank account number.");
  }
  getDb().prepare(`
    INSERT INTO payee_book
      (telegram_id, name, wallet_address, bank_name, account_number, account_name, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id, name) DO UPDATE SET
      wallet_address = COALESCE(excluded.wallet_address, wallet_address),
      bank_name      = COALESCE(excluded.bank_name,      bank_name),
      account_number = COALESCE(excluded.account_number, account_number),
      account_name   = COALESCE(excluded.account_name,   account_name),
      notes          = COALESCE(excluded.notes,          notes)
  `).run(
    Number(telegramId), name,
    walletAddress, bankName, accountNumber, accountName, notes
  );
}

/**
 * Look up a payee by exact name (case-insensitive).
 */
function getPayeeByName(telegramId, name) {
  return getDb().prepare(`
    SELECT * FROM payee_book
    WHERE telegram_id = ? AND LOWER(name) = LOWER(?)
  `).get(Number(telegramId), name) || null;
}

/**
 * Fuzzy name search — returns up to 5 partial matches.
 * Used when the intent router finds a name that isn't an exact match.
 */
function searchPayees(telegramId, query) {
  return getDb().prepare(`
    SELECT * FROM payee_book
    WHERE telegram_id = ? AND LOWER(name) LIKE LOWER(?)
    ORDER BY name ASC
    LIMIT 5
  `).all(Number(telegramId), `%${query}%`);
}

/**
 * Get all payees for a user.
 */
function getAllPayees(telegramId) {
  return getDb().prepare(`
    SELECT * FROM payee_book WHERE telegram_id = ? ORDER BY name ASC
  `).all(Number(telegramId));
}

/**
 * Delete a payee by name.
 */
function deletePayee(telegramId, name) {
  getDb().prepare(`
    DELETE FROM payee_book WHERE telegram_id = ? AND LOWER(name) = LOWER(?)
  `).run(Number(telegramId), name);
}

// ─── Resolution helper ────────────────────────────────────────────────────────

/**
 * Resolve a name or raw address to a payee record.
 *
 * - If input looks like a 0x address → return a synthetic payee object
 * - If exact name match → return payee
 * - If partial match → return array of candidates (caller handles disambiguation)
 * - If no match → return null
 *
 * @param {number} telegramId
 * @param {string} input  — could be "Emeka", "0xABC...", "Tech Corp", etc.
 * @returns {object|object[]|null}
 */
function resolvePayee(telegramId, input) {
  const trimmed = (input || "").trim();

  // Raw wallet address — wrap it so callers always get the same shape
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return {
      id: null,
      name: trimmed,
      wallet_address: trimmed,
      bank_name: null,
      account_number: null,
      account_name: null,
    };
  }

  // Exact name match
  const exact = getPayeeByName(telegramId, trimmed);
  if (exact) return exact;

  // Partial matches
  const partial = searchPayees(telegramId, trimmed);
  if (partial.length === 1) return partial[0];   // only one match → use it
  if (partial.length > 1)  return partial;        // ambiguous → caller disambiguates

  return null;
}

/**
 * Format a payee list for display in Telegram.
 */
function formatPayeeList(payees) {
  if (!payees.length) return "No saved contacts yet.";
  return payees.map((p, i) => {
    const wallet = p.wallet_address ? `\n   Wallet: \`${p.wallet_address}\`` : "";
    const bank   = p.account_number
      ? `\n   Bank: ${p.bank_name || "?"} · ${p.account_number} (${p.account_name || "?"})`
      : "";
    return `${i + 1}. *${p.name}*${wallet}${bank}`;
  }).join("\n\n");
}

module.exports = {
  initPayeeTable,
  upsertPayee,
  getPayeeByName,
  searchPayees,
  getAllPayees,
  deletePayee,
  resolvePayee,
  formatPayeeList,
};
