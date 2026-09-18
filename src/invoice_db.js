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
      invoice_private_key_encrypted TEXT,
      paid_tx_hash      TEXT,
      settlement_tx_hash TEXT
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

// Add encrypted invoice child key storage column if table exists without it.
try {
  db.exec("ALTER TABLE invoices ADD COLUMN invoice_private_key_encrypted TEXT;");
} catch (e) {
  // Ignore if already exists.
}

try {
  db.exec("ALTER TABLE invoices ADD COLUMN settlement_tx_hash TEXT;");
} catch (e) {
  // Ignore if already exists.
}

try { db.exec("ALTER TABLE invoices ADD COLUMN telegram_id INTEGER;"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN owner_telegram_id INTEGER;"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN wallet_address TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN items_json TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN items TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN total_usdc REAL;"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN total REAL;"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN subtotal REAL;"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN png_path TEXT;"); } catch (e) {}

try { db.exec("ALTER TABLE invoices ADD COLUMN derivation_index INTEGER;"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_address TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN expected_amount_micro BIGINT;"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN paid_tx_hash TEXT;"); } catch (e) {}

try { db.exec("ALTER TABLE invoices ADD COLUMN fiat_account_number TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN fiat_bank_name TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN fiat_account_name TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN fiat_amount REAL;"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN fiat_order_id TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN fiat_rate REAL;"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_invoices_fiat_order_id ON invoices(fiat_order_id);"); } catch (e) {}

// Auto-initialize tables
try {
  initInvoiceTables();
} catch (e) {
  // Ignore
}

function getNextInvoiceNumber(telegramId) {
  const last = db.prepare(
    "SELECT invoice_number FROM invoices WHERE telegram_id = ? OR owner_telegram_id = ? ORDER BY id DESC LIMIT 1"
  ).get(telegramId, telegramId);
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
    "SELECT MAX(derivation_index) as maxIndex FROM invoices WHERE telegram_id = ? OR owner_telegram_id = ?"
  ).get(telegramId, telegramId);
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
    expectedAmountMicro,      // Amount in Arc's 18-decimal format (BigInt string)
    invoicePrivateKeyEncrypted,
  }
) {
  const itemsJson = JSON.stringify(items);
  const result = db.prepare(`
    INSERT INTO invoices
      (
        telegram_id, owner_telegram_id, invoice_number, client_name, client_email, 
        items_json, items, total_usdc, total, subtotal, due_date, notes, wallet_address, 
        png_path, payment_address, derivation_index, expected_amount_micro, invoice_private_key_encrypted, status
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    telegramId,
    telegramId,
    invoiceNumber,
    clientName,
    clientEmail || null,
    itemsJson,
    itemsJson,
    totalUsdc,
    totalUsdc,
    totalUsdc,
    dueDate || null,
    notes || null,
    walletAddress,
    pngPath || null,
    paymentAddress,           // Unique per invoice
    derivationIndex,          // Sequence number
    String(expectedAmountMicro), // Store as string to preserve precision
    invoicePrivateKeyEncrypted || null,
    "unpaid"
  );
  
  return result.lastInsertRowid;
}

function createInvoice(telegramId, { invoiceNumber, clientName, clientEmail, items, totalUsdc, dueDate, notes, walletAddress, pngPath }) {
  const itemsJson = JSON.stringify(items);
  const result = db.prepare(`
    INSERT INTO invoices
      (
        telegram_id, owner_telegram_id, invoice_number, client_name, client_email, 
        items_json, items, total_usdc, total, subtotal, due_date, notes, wallet_address, png_path, status
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    telegramId,
    telegramId,
    invoiceNumber,
    clientName,
    clientEmail || null,
    itemsJson,
    itemsJson,
    totalUsdc,
    totalUsdc,
    totalUsdc,
    dueDate || null,
    notes || null,
    walletAddress,
    pngPath || null,
    "unpaid"
  );
  return result.lastInsertRowid;
}

function getUserInvoices(telegramId, limit = 20) {
  const rows = db.prepare(
    "SELECT * FROM invoices WHERE telegram_id = ? OR owner_telegram_id = ? ORDER BY id DESC LIMIT ?"
  ).all(telegramId, telegramId, limit);
  return rows.map((r) => ({
    ...r,
    telegram_id: r.telegram_id ?? r.owner_telegram_id,
    total_usdc: r.total_usdc ?? r.total,
    items_json: r.items_json ?? r.items,
  }));
}

function getInvoice(invoiceId) {
  const row = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId);
  if (!row) return null;
  return {
    ...row,
    telegram_id: row.telegram_id ?? row.owner_telegram_id,
    total_usdc: row.total_usdc ?? row.total,
    items_json: row.items_json ?? row.items,
  };
}

/**
 * Look up invoice by its unique payment address (HD wallet)
 * Used to validate incoming payments on-chain
 */
function getUnpaidPersonalInvoices() {
  return db.prepare(
    "SELECT * FROM invoices WHERE status = 'unpaid' AND payment_address IS NOT NULL"
  ).all();
}

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

function updateInvoiceSettlementTxHash(invoiceId, settlementTxHash) {
  db.prepare(
    "UPDATE invoices SET settlement_tx_hash = ? WHERE id = ?"
  ).run(settlementTxHash, invoiceId);
}

function updateInvoicePngPath(invoiceId, pngPath) {
  db.prepare(
    "UPDATE invoices SET png_path = ? WHERE id = ?"
  ).run(pngPath, invoiceId);
}

function getInvoiceByNumber(invoiceNumber) {
  return db.prepare("SELECT * FROM invoices WHERE invoice_number = ?").get(invoiceNumber) || null;
}

function getInvoiceByFiatOrderId(orderId) {
  return db.prepare("SELECT * FROM invoices WHERE fiat_order_id = ?").get(orderId) || null;
}

function updateInvoiceFiatDetails(invoiceId, { fiatAccountNumber, fiatBankName, fiatAccountName, fiatAmount, fiatOrderId, fiatRate }) {
  db.prepare(`
    UPDATE invoices SET
      fiat_account_number = ?,
      fiat_bank_name = ?,
      fiat_account_name = ?,
      fiat_amount = ?,
      fiat_order_id = ?,
      fiat_rate = ?
    WHERE id = ?
  `).run(fiatAccountNumber, fiatBankName, fiatAccountName, fiatAmount, fiatOrderId, fiatRate, invoiceId);
}

module.exports = { 
  initInvoiceTables, 
  getNextInvoiceNumber,
  getNextDerivationIndex,      // NEW: HD wallet support
  createInvoice, 
  createInvoiceWithHDAddress,  // NEW: HD wallet creation
  getUserInvoices, 
  getInvoice,
  getInvoiceByNumber,
  getInvoiceByFiatOrderId,
  updateInvoiceFiatDetails,
  getUnpaidPersonalInvoices,
  getInvoiceByPaymentAddress,  // NEW: payment validation
  markInvoicePaid,
  markInvoicePaidWithTxHash,   // NEW: record tx hash
  updateInvoiceSettlementTxHash,
  updateInvoicePngPath
};
