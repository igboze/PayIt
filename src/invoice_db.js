// src/invoice_db.js
// Personal invoice database with HD wallet support
// Each invoice has a unique, deterministic payment address derived from user's master key

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
      paid_at         TEXT,
      
      -- HD Wallet fields (added for invoice-specific payment addresses)
      derivation_index  INTEGER,
      payment_address   TEXT UNIQUE,
      expected_amount_micro BIGINT,
      paid_tx_hash      TEXT
    );
  `);
  
  // Indexes for HD wallet lookups
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_invoices_payment_address 
        ON invoices(payment_address);
      CREATE INDEX IF NOT EXISTS idx_invoices_derivation_index 
        ON invoices(telegram_id, derivation_index);
      CREATE INDEX IF NOT EXISTS idx_invoices_status 
        ON invoices(telegram_id, status);
    `);
  } catch (e) {
    // Indexes may already exist; silently continue
  }
}

function getNextInvoiceNumber(telegramId) {
  const last = db.prepare(
    "SELECT invoice_number FROM invoices WHERE telegram_id = ? ORDER BY id DESC LIMIT 1"
  ).get(telegramId);
  if (!last) return "INV-0001";
  const num = parseInt(last.invoice_number.replace("INV-", "")) + 1;
  return `INV-${String(num).padStart(4, "0")}`;
}

/**
 * Get the next derivation index for this user's invoices
 * This ensures each invoice gets a unique, sequential HD address
 */
function getNextDerivationIndex(telegramId) {
  const last = db.prepare(
    "SELECT MAX(derivation_index) as maxIndex FROM invoices WHERE telegram_id = ?"
  ).get(telegramId);
  return (last?.maxIndex ?? -1) + 1;
}

/**
 * Create invoice with HD wallet address (preferred method)
 * Automatically derives unique payment address for this invoice
 */
function createInvoiceWithHDAddress(
  telegramId,
  {
    invoiceNumber,
    clientName,
    clientEmail,
    items,
    totalUsdc,
    dueDate,
    notes,
    walletAddress,
    pngPath,
    paymentAddress,           // Derived HD address (from wallet.deriveInvoiceAddress)
    derivationIndex,          // Invoice's index in derivation path
    expectedAmountMicro       // Amount in Arc's 18-decimal format (BigInt string)
  }
) {
  const result = db.prepare(`
    INSERT INTO invoices
      (
        telegram_id, invoice_number, client_name, client_email, 
        items_json, total_usdc, due_date, notes, wallet_address, 
        png_path, paymentAddress, derivation_index, expected_amount_micro, status
      )
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
    pngPath || null,
    paymentAddress,           // Unique per invoice
    derivationIndex,          // Sequence number
    String(expectedAmountMicro), // Store as string to preserve precision
    "unpaid"
  );
  
  return result.lastInsertRowid;
}

function createInvoice(telegramId, { invoiceNumber, clientName, clientEmail, items, totalUsdc, dueDate, notes, walletAddress, pngPath }) {
  const result = db.prepare(`
    INSERT INTO invoices
      (telegram_id, invoice_number, client_name, client_email, items_json, total_usdc, due_date, notes, wallet_address, png_path, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(telegramId, invoiceNumber, clientName, clientEmail || null, JSON.stringify(items), totalUsdc, dueDate || null, notes || null, walletAddress, pngPath || null, "unpaid");
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

/**
 * Look up invoice by its unique payment address (HD wallet)
 * Used to validate incoming payments on-chain
 */
function getInvoiceByPaymentAddress(paymentAddress) {
  return db.prepare(
    "SELECT * FROM invoices WHERE payment_address = ?"
  ).get(paymentAddress) || null;
}

function markInvoicePaid(invoiceId) {
  db.prepare(
    "UPDATE invoices SET status = 'paid', paid_at = datetime('now') WHERE id = ?"
  ).run(invoiceId);
}

/**
 * Mark invoice as paid with transaction hash
 * Called when payment is validated on-chain
 */
function markInvoicePaidWithTxHash(invoiceId, txHash) {
  db.prepare(
    "UPDATE invoices SET status = 'paid', paid_at = datetime('now'), paid_tx_hash = ? WHERE id = ?"
  ).run(txHash, invoiceId);
}

module.exports = { 
  initInvoiceTables, 
  getNextInvoiceNumber,
  getNextDerivationIndex,      // NEW: HD wallet support
  createInvoice, 
  createInvoiceWithHDAddress,  // NEW: HD wallet creation
  getUserInvoices, 
  getInvoice,
  getInvoiceByPaymentAddress,  // NEW: payment validation
  markInvoicePaid,
  markInvoicePaidWithTxHash    // NEW: record tx hash
};
