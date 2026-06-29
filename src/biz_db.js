// src/biz_db.js
// Business account database layer
// Tables: biz_invoices, biz_expenses, biz_savings_goals, biz_savings_balance

const db = require("./db").db; // reuse the same SQLite connection

// ─── Schema ───────────────────────────────────────────────────────────────────

function initBizTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS biz_invoices (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id     INTEGER NOT NULL,
      invoice_number  TEXT NOT NULL,
      client_name     TEXT NOT NULL,
      client_email    TEXT,
      items_json      TEXT NOT NULL,
      total_usdc      REAL NOT NULL,
      due_date        TEXT,
      notes           TEXT,
      wallet_address  TEXT NOT NULL,
      payment_address TEXT UNIQUE,
      invoice_private_key_encrypted TEXT,
      png_path        TEXT,
      status          TEXT NOT NULL DEFAULT 'unpaid',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at         TEXT,
      derivation_index INTEGER,
      expected_amount_micro BIGINT,
      paid_tx_hash    TEXT,
      settlement_tx_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS biz_expenses (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      amount      REAL NOT NULL,
      currency    TEXT NOT NULL DEFAULT 'NGN',
      category    TEXT NOT NULL DEFAULT 'General',
      description TEXT NOT NULL,
      logged_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS biz_savings_goals (
      telegram_id INTEGER PRIMARY KEY,
      percentage  INTEGER NOT NULL DEFAULT 10,
      label       TEXT NOT NULL DEFAULT 'Savings',
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS biz_savings_balance (
      telegram_id INTEGER PRIMARY KEY,
      balance_usdc REAL NOT NULL DEFAULT 0,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Add HD invoice support columns if the table already exists.
  try {
    db.exec("ALTER TABLE biz_invoices ADD COLUMN derivation_index INTEGER;");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE biz_invoices ADD COLUMN expected_amount_micro BIGINT;");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE biz_invoices ADD COLUMN paid_tx_hash TEXT;");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE biz_invoices ADD COLUMN payment_address TEXT;");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE biz_invoices ADD COLUMN invoice_private_key_encrypted TEXT;");
  } catch (e) {}
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_biz_invoices_wallet_address ON biz_invoices(wallet_address);");
  } catch (e) {}
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_biz_invoices_payment_address ON biz_invoices(payment_address);");
  } catch (e) {}
}

// ─── Invoice number sequencing ────────────────────────────────────────────────

function getNextBizInvoiceNumber(telegramId) {
  const last = db.prepare(
    "SELECT invoice_number FROM biz_invoices WHERE telegram_id = ? ORDER BY id DESC LIMIT 1"
  ).get(telegramId);
  if (!last) return "BIZ-0001";
  const num = parseInt(last.invoice_number.replace("BIZ-", "")) + 1;
  return `BIZ-${String(num).padStart(4, "0")}`;
}

// ─── Invoice CRUD ─────────────────────────────────────────────────────────────

function createBizInvoice(telegramId, { invoiceNumber, clientName, clientEmail, items, totalUsdc, dueDate, notes, walletAddress, pngPath }) {
  const result = db.prepare(`
    INSERT INTO biz_invoices
      (telegram_id, invoice_number, client_name, client_email, items_json, total_usdc, due_date, notes, wallet_address, png_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(telegramId, invoiceNumber, clientName, clientEmail || null, JSON.stringify(items), totalUsdc, dueDate || null, notes || null, walletAddress, pngPath || null);
  return result.lastInsertRowid;
}

function createBizInvoiceWithHDAddress(telegramId, {
  invoiceNumber,
  clientName,
  clientEmail,
  items,
  totalUsdc,
  dueDate,
  notes,
  walletAddress,
  pngPath,
  paymentAddress,
  derivationIndex,
  expectedAmountMicro,
  invoicePrivateKeyEncrypted,
}) {
  const result = db.prepare(`
    INSERT INTO biz_invoices
      (telegram_id, invoice_number, client_name, client_email, items_json, total_usdc, due_date, notes, wallet_address, payment_address, invoice_private_key_encrypted, png_path, derivation_index, expected_amount_micro)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    telegramId,
    invoiceNumber,
    clientName,
    clientEmail || null,
    JSON.stringify(items),
    totalUsdc,
    dueDate || null,
    notes || null,
    walletAddress,
    paymentAddress || null,
    invoicePrivateKeyEncrypted || null,
    pngPath || null,
    derivationIndex,
    String(expectedAmountMicro)
  );
  return result.lastInsertRowid;
}

function getUnpaidBizInvoices() {
  return db.prepare("SELECT * FROM biz_invoices WHERE status = 'unpaid' AND (payment_address IS NOT NULL OR wallet_address IS NOT NULL)").all();
}

function getBizInvoiceByWalletAddress(walletAddress) {
  return db.prepare("SELECT * FROM biz_invoices WHERE payment_address = ? OR wallet_address = ?").get(walletAddress, walletAddress) || null;
}

function getBizInvoices(telegramId, limit = 20) {
  return db.prepare(
    "SELECT * FROM biz_invoices WHERE telegram_id = ? ORDER BY id DESC LIMIT ?"
  ).all(telegramId, limit);
}

function getBizInvoice(invoiceId) {
  return db.prepare("SELECT * FROM biz_invoices WHERE id = ?").get(invoiceId) || null;
}

function markBizInvoicePaid(invoiceId) {
  db.prepare(
    "UPDATE biz_invoices SET status = 'paid', paid_at = datetime('now') WHERE id = ?"
  ).run(invoiceId);
}

function markBizInvoicePaidWithTxHash(invoiceId, txHash) {
  db.prepare(
    "UPDATE biz_invoices SET status = 'paid', paid_at = datetime('now'), paid_tx_hash = ? WHERE id = ?"
  ).run(txHash, invoiceId);
}

function updateBizInvoiceSettlementTxHash(invoiceId, settlementTxHash) {
  db.prepare(
    "UPDATE biz_invoices SET settlement_tx_hash = ? WHERE id = ?"
  ).run(settlementTxHash, invoiceId);
}

function getNextBizDerivationIndex(telegramId) {
  const last = db.prepare(
    "SELECT MAX(derivation_index) as maxIndex FROM biz_invoices WHERE telegram_id = ?"
  ).get(telegramId);
  return (last?.maxIndex ?? -1) + 1;
}

function getPendingInvoiceCount(telegramId) {
  return db.prepare(
    "SELECT COUNT(*) as c FROM biz_invoices WHERE telegram_id = ? AND status = 'unpaid'"
  ).get(telegramId)?.c || 0;
}

function getPendingInvoiceTotal(telegramId) {
  return db.prepare(
    "SELECT COALESCE(SUM(total_usdc), 0) as total FROM biz_invoices WHERE telegram_id = ? AND status = 'unpaid'"
  ).get(telegramId)?.total || 0;
}

// ─── Recent clients (for quick-reply buttons) ─────────────────────────────────

function getRecentClients(telegramId, limit = 3) {
  const rows = db.prepare(
    "SELECT DISTINCT client_name FROM biz_invoices WHERE telegram_id = ? ORDER BY id DESC LIMIT ?"
  ).all(telegramId, limit);
  return rows.map(r => r.client_name);
}

// ─── Expense logging ──────────────────────────────────────────────────────────

// Simple category inference from description keywords
function inferCategory(description) {
  const d = description.toLowerCase();
  if (/transport|ride|uber|bolt|fuel|travel/.test(d)) return "Transport";
  if (/food|lunch|dinner|meal|eat|restaurant/.test(d)) return "Food";
  if (/saas|software|subscription|tool|app|hosting/.test(d)) return "Software";
  if (/salary|staff|payroll|pay|hire/.test(d)) return "Payroll";
  if (/office|rent|space|cowork/.test(d)) return "Office";
  if (/market|ads|promo|adverti/.test(d)) return "Marketing";
  if (/data|airtime|internet|sim/.test(d)) return "Telecoms";
  return "General";
}

function logExpense(telegramId, amount, currency, description) {
  const category = inferCategory(description);
  db.prepare(
    "INSERT INTO biz_expenses (telegram_id, amount, currency, category, description) VALUES (?, ?, ?, ?, ?)"
  ).run(telegramId, amount, currency.toUpperCase(), category, description);
}

// ─── Cash flow aggregates ─────────────────────────────────────────────────────

function getMonthIncome(telegramId) {
  const start = new Date();
  start.setDate(1); start.setHours(0, 0, 0, 0);
  return db.prepare(
    "SELECT COALESCE(SUM(total_usdc), 0) as total FROM biz_invoices WHERE telegram_id = ? AND status = 'paid' AND paid_at >= ?"
  ).get(telegramId, start.toISOString())?.total || 0;
}

function getMonthExpenses(telegramId) {
  // Sum USDC expenses only for cash flow (NGN logged separately for record)
  const start = new Date();
  start.setDate(1); start.setHours(0, 0, 0, 0);
  return db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM biz_expenses WHERE telegram_id = ? AND currency = 'USDC' AND logged_at >= ?"
  ).get(telegramId, start.toISOString())?.total || 0;
}

function getMonthInvoiceCount(telegramId) {
  const start = new Date();
  start.setDate(1); start.setHours(0, 0, 0, 0);
  return db.prepare(
    "SELECT COUNT(*) as c FROM biz_invoices WHERE telegram_id = ? AND status = 'paid' AND paid_at >= ?"
  ).get(telegramId, start.toISOString())?.c || 0;
}

// ─── Report aggregates ────────────────────────────────────────────────────────

function getExpenseBreakdown(telegramId) {
  const start = new Date();
  start.setDate(1); start.setHours(0, 0, 0, 0);
  return db.prepare(`
    SELECT category, COALESCE(SUM(amount), 0) as total
    FROM biz_expenses
    WHERE telegram_id = ? AND currency = 'USDC' AND logged_at >= ?
    GROUP BY category ORDER BY total DESC
  `).all(telegramId, start.toISOString());
}

function getTopClient(telegramId) {
  const start = new Date();
  start.setDate(1); start.setHours(0, 0, 0, 0);
  return db.prepare(`
    SELECT client_name as name, COALESCE(SUM(total_usdc), 0) as total
    FROM biz_invoices
    WHERE telegram_id = ? AND status = 'paid' AND paid_at >= ?
    GROUP BY client_name ORDER BY total DESC LIMIT 1
  `).get(telegramId, start.toISOString()) || null;
}

// ─── Savings ──────────────────────────────────────────────────────────────────

function getSavingsGoal(telegramId) {
  return db.prepare("SELECT * FROM biz_savings_goals WHERE telegram_id = ?").get(telegramId) || null;
}

function setSavingsGoal(telegramId, percentage, label) {
  db.prepare(`
    INSERT INTO biz_savings_goals (telegram_id, percentage, label)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET percentage = excluded.percentage, label = excluded.label, updated_at = datetime('now')
  `).run(telegramId, percentage, label);
}

function getBizSavingsBalance(telegramId) {
  return db.prepare(
    "SELECT COALESCE(balance_usdc, 0) as b FROM biz_savings_balance WHERE telegram_id = ?"
  ).get(telegramId)?.b || 0;
}

function addToBizSavings(telegramId, amount) {
  db.prepare(`
    INSERT INTO biz_savings_balance (telegram_id, balance_usdc)
    VALUES (?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET balance_usdc = balance_usdc + excluded.balance_usdc, updated_at = datetime('now')
  `).run(telegramId, amount);
}

module.exports = {
  initBizTables,
  getNextBizInvoiceNumber,
  createBizInvoice,
  createBizInvoiceWithHDAddress,
  getBizInvoices,
  getBizInvoice,
  getBizInvoiceByWalletAddress,
  markBizInvoicePaid,
  markBizInvoicePaidWithTxHash,
  updateBizInvoiceSettlementTxHash,
  getNextBizDerivationIndex,
  getPendingInvoiceCount,
  getPendingInvoiceTotal,
  getRecentClients,
  logExpense,
  getMonthIncome,
  getMonthExpenses,
  getMonthInvoiceCount,
  getExpenseBreakdown,
  getTopClient,
  getSavingsGoal,
  setSavingsGoal,
  getBizSavingsBalance,
  addToBizSavings,
  createBizInvoiceWithHDAddress,
  getUnpaidBizInvoices,
  getBizInvoiceByWalletAddress,
  markBizInvoicePaidWithTxHash,
  getNextBizDerivationIndex,
};
