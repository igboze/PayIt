// src/invoice_db.js
// Personal invoice database (separate table from business invoices)

const db = require("./db").db;

function initInvoiceTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
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
      png_path        TEXT,
      status          TEXT NOT NULL DEFAULT 'unpaid',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at         TEXT
    );
  `);
}

function getNextInvoiceNumber(telegramId) {
  const last = db.prepare(
    "SELECT invoice_number FROM invoices WHERE telegram_id = ? ORDER BY id DESC LIMIT 1"
  ).get(telegramId);
  if (!last) return "INV-0001";
  const num = parseInt(last.invoice_number.replace("INV-", "")) + 1;
  return `INV-${String(num).padStart(4, "0")}`;
}

function createInvoice(telegramId, { invoiceNumber, clientName, clientEmail, items, totalUsdc, dueDate, notes, walletAddress, pngPath }) {
  const result = db.prepare(`
    INSERT INTO invoices
      (telegram_id, invoice_number, client_name, client_email, items_json, total_usdc, due_date, notes, wallet_address, png_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(telegramId, invoiceNumber, clientName, clientEmail || null, JSON.stringify(items), totalUsdc, dueDate || null, notes || null, walletAddress, pngPath || null);
  return result.lastInsertRowid;
}

function getUserInvoices(telegramId, limit = 20) {
  return db.prepare(
    "SELECT * FROM invoices WHERE telegram_id = ? ORDER BY id DESC LIMIT ?"
  ).all(telegramId, limit);
}

function getInvoice(invoiceId) {
  return db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId) || null;
}

function markInvoicePaid(invoiceId) {
  db.prepare(
    "UPDATE invoices SET status = 'paid', paid_at = datetime('now') WHERE id = ?"
  ).run(invoiceId);
}

module.exports = { initInvoiceTables, getNextInvoiceNumber, createInvoice, getUserInvoices, getInvoice, markInvoicePaid };
