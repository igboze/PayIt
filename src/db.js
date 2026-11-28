// src/db.js
// SQLite database layer — personal + business dual wallets, multi-token, context switching
// Uses Node's BUILT-IN SQLite (node:sqlite, Node 22+) — no native compilation
// needed, no Visual Studio / build tools required on Windows.
// All crypto (AES-256-GCM + scrypt) stays in walletLib; this file just reads/writes rows.
//
// Invoice ledger added: SME invoicing with status tracking (draft/sent/paid/
// overdue/cancelled), VAT/WHT breakdown, and multi-currency settlement
// (USDC/EURC, per Arc stablecoin FX). Invoices settle to the business
// wallet specifically, not whichever context happens to be active when the
// invoice is created, since invoicing is inherently a business action.

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("path");
const walletLib = require("./wallet");
const multichain = require("./multichain");

function resolveDbPath() {
  const rawPath = process.env.PAYIT_DB_PATH || path.join(__dirname, "..", "payit.db");
  return path.resolve(rawPath);
}

const DB_PATH = resolveDbPath();
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (!process.env.PAYIT_DB_PATH) {
  console.warn(
    "WARNING: PAYIT_DB_PATH is not set. Using default database path:",
    DB_PATH,
    "This may be lost on ephemeral deploy environments. Set PAYIT_DB_PATH to a stable mounted path."
  );
} else {
  console.log("PayIT database path:", DB_PATH);
}
const db = new DatabaseSync(DB_PATH);
try { db.exec("PRAGMA busy_timeout = 5000"); } catch (_) { }
installSafeIntegerReads(db);

// node:sqlite throws "Value is too large to be represented as a JavaScript number" when a row
// holds an INTEGER above Number.MAX_SAFE_INTEGER (e.g. 18-decimal Arc USDC amounts such as
// invoices.expected_amount_micro = 690000000000000000). One such row breaks every query that
// reads it. Read integers as BigInt, then return safe ones as plain numbers (unchanged
// behaviour) and unsafe ones as decimal strings, which callers already pass to BigInt().
function normalizeSqlValue(v) {
  if (typeof v !== "bigint") return v;
  return (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)) ? Number(v) : v.toString();
}
function normalizeSqlRow(row) {
  if (!row || typeof row !== "object") return row;
  for (const k of Object.keys(row)) row[k] = normalizeSqlValue(row[k]);
  return row;
}
function installSafeIntegerReads(database) {
  const originalPrepare = database.prepare.bind(database);
  database.prepare = (sql) => {
    const stmt = originalPrepare(sql);
    if (typeof stmt.setReadBigInts !== "function") return stmt;
    stmt.setReadBigInts(true);
    const get = stmt.get.bind(stmt);
    const all = stmt.all.bind(stmt);
    const run = stmt.run.bind(stmt);
    stmt.get = (...args) => normalizeSqlRow(get(...args));
    stmt.all = (...args) => all(...args).map(normalizeSqlRow);
    stmt.run = (...args) => normalizeSqlRow(run(...args));
    if (typeof stmt.iterate === "function") {
      const iterate = stmt.iterate.bind(stmt);
      stmt.iterate = function* (...args) { for (const r of iterate(...args)) yield normalizeSqlRow(r); };
    }
    return stmt;
  };
}
const REFERRAL_BONUS_POINTS = 20;

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id       INTEGER PRIMARY KEY,
    username          TEXT,
    -- Personal wallet
    deposit_address   TEXT NOT NULL,
    encrypted_key     TEXT NOT NULL,
    key_salt          TEXT NOT NULL,
    key_iv            TEXT NOT NULL,
    key_tag           TEXT NOT NULL,
    -- Business wallet (nullable — created on demand)
    business_deposit_address  TEXT,
    biz_encrypted_key         TEXT,
    biz_key_salt              TEXT,
    biz_key_iv                TEXT,
    biz_key_tag               TEXT,
    -- Context
    active_context    TEXT NOT NULL DEFAULT 'personal',
    -- Phone
    phone_number      TEXT,
    phone_verified    INTEGER NOT NULL DEFAULT 0,
    -- Linked external wallet
    external_wallet_address TEXT,
    is_blocked         INTEGER NOT NULL DEFAULT 0,
    blocked_at         TEXT,
    blocked_reason     TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    referrer_telegram_id INTEGER,
    referral_code        TEXT UNIQUE,
    referred_at          TEXT,
    referred_on_first_point INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id   INTEGER NOT NULL,
    type          TEXT NOT NULL,
    amount_micro  TEXT NOT NULL,
    status        TEXT NOT NULL,
    tx_hash       TEXT,
    account_type  TEXT NOT NULL DEFAULT 'personal',
    decimals      INTEGER NOT NULL DEFAULT 18,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS yield_positions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    amount_usdc REAL NOT NULL,
    apy         REAL NOT NULL,
    project     TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    chain       TEXT NOT NULL,
    opened_at   TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at   TEXT,
    payout      REAL,
    status      TEXT NOT NULL DEFAULT 'active'
  );

  -- SME invoice ledger. currency supports USDC and EURC (Arc stablecoin FX),
  -- so an SME can bill international clients in their own stablecoin.
  -- vat_*/wht_* fields store the breakdown separately from the total, so
  -- the SME sees exactly what's owed vs. what's tax, rather than one
  -- opaque number.
  CREATE TABLE IF NOT EXISTS points_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id   INTEGER NOT NULL,
    points        INTEGER NOT NULL,
    action        TEXT NOT NULL,
    details       TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number    TEXT NOT NULL UNIQUE,
    owner_telegram_id INTEGER NOT NULL,
    client_name       TEXT NOT NULL,
    client_email      TEXT,
    items             TEXT NOT NULL,
    currency          TEXT NOT NULL DEFAULT 'USDC',
    subtotal          REAL NOT NULL,
    vat_rate          REAL,
    vat_amount        REAL,
    wht_rate          REAL,
    wht_amount        REAL,
    total             REAL NOT NULL,
    due_date          TEXT,
    notes             TEXT,
    status            TEXT NOT NULL DEFAULT 'draft',
    payment_address   TEXT,
    paid_tx_hash      TEXT,
    paid_at           TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pin_security (
    telegram_id       INTEGER PRIMARY KEY,
    failed_attempts   INTEGER NOT NULL DEFAULT 0,
    locked_until      INTEGER NOT NULL DEFAULT 0,
    last_attempt_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Pending CCTP Arc→Solana burns awaiting Solana receiveMessage completion.
  -- Written immediately after the Arc depositForBurn tx is confirmed so funds
  -- can NEVER be permanently stuck even if the Solana fee-payer runs out of SOL.
  -- Auto-retried by retryPendingCctpBurns() whenever the fee payer is funded.
  CREATE TABLE IF NOT EXISTS cctp_pending_burns (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id       INTEGER NOT NULL,
    arc_tx_hash       TEXT NOT NULL UNIQUE,
    message_hex       TEXT,
    message_hash      TEXT,
    amount_usdc       REAL NOT NULL,
    recipient_solana  TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    error             TEXT,
    retry_count       INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at      TEXT,
    solana_tx_sig     TEXT
  );

  CREATE TABLE IF NOT EXISTS paj_onramp_orders (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id          TEXT UNIQUE NOT NULL,
    telegram_id       INTEGER NOT NULL,
    account_type      TEXT NOT NULL DEFAULT 'personal',
    fiat_amount       REAL NOT NULL,
    amount_usdc       REAL,
    rate              REAL,
    recipient_address TEXT NOT NULL,
    settlement_rail   TEXT NOT NULL DEFAULT 'arc',
    status            TEXT NOT NULL DEFAULT 'pending',
    tx_hash           TEXT,
    narration         TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS paj_offramp_orders (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id          TEXT UNIQUE NOT NULL,
    telegram_id       INTEGER NOT NULL,
    account_type      TEXT NOT NULL DEFAULT 'personal',
    account_number    TEXT NOT NULL,
    bank_code         TEXT,
    bank_name         TEXT,
    account_name      TEXT,
    amount_usdc       REAL NOT NULL,
    fee_usdc          REAL NOT NULL DEFAULT 0,
    net_amount_usdc   REAL NOT NULL,
    fiat_amount       REAL,
    rate              REAL,
    rail              TEXT NOT NULL DEFAULT 'solana',
    status            TEXT NOT NULL DEFAULT 'pending',
    tx_hash           TEXT,
    fee_tx_hash       TEXT,
    narration         TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_paj_offramp_status ON paj_offramp_orders(status);

  CREATE TABLE IF NOT EXISTS crosschain_pending_withdrawals (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id             INTEGER NOT NULL,
    arc_tx_hash             TEXT NOT NULL UNIQUE,
    destination_chain       TEXT NOT NULL,
    destination_address     TEXT NOT NULL,
    amount_usdc             REAL NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'attesting',
    engine                  TEXT NOT NULL DEFAULT 'CCTP',
    encrypted_private_key   TEXT,
    account_type            TEXT NOT NULL DEFAULT 'personal',
    message_hex             TEXT,
    message_hash            TEXT,
    attestation             TEXT,
    mint_tx_hash            TEXT,
    intent_deposit_address  TEXT,
    intent_tx_hash          TEXT,
    destination_tx_hash     TEXT,
    delivered_amount        TEXT,
    error                   TEXT,
    retry_count             INTEGER NOT NULL DEFAULT 0,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at            TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_cc_pending_status ON crosschain_pending_withdrawals(status);
`);

function ensureUserSchema() {
  const columns = db.prepare("PRAGMA table_info(users)").all().map((row) => row.name);
  if (!columns.includes("is_blocked")) {
    db.exec("ALTER TABLE users ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.includes("blocked_at")) {
    db.exec("ALTER TABLE users ADD COLUMN blocked_at TEXT");
  }
  if (!columns.includes("blocked_reason")) {
    db.exec("ALTER TABLE users ADD COLUMN blocked_reason TEXT");
  }
  if (!columns.includes("points_balance")) {
    db.exec("ALTER TABLE users ADD COLUMN points_balance INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.includes("deposit_address")) {
    db.exec("ALTER TABLE users ADD COLUMN deposit_address TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.includes("encrypted_key")) {
    db.exec("ALTER TABLE users ADD COLUMN encrypted_key TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.includes("key_salt")) {
    db.exec("ALTER TABLE users ADD COLUMN key_salt TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.includes("key_iv")) {
    db.exec("ALTER TABLE users ADD COLUMN key_iv TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.includes("key_tag")) {
    db.exec("ALTER TABLE users ADD COLUMN key_tag TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.includes("business_deposit_address")) {
    db.exec("ALTER TABLE users ADD COLUMN business_deposit_address TEXT");
  }
  if (!columns.includes("biz_encrypted_key")) {
    db.exec("ALTER TABLE users ADD COLUMN biz_encrypted_key TEXT");
  }
  if (!columns.includes("biz_key_salt")) {
    db.exec("ALTER TABLE users ADD COLUMN biz_key_salt TEXT");
  }
  if (!columns.includes("biz_key_iv")) {
    db.exec("ALTER TABLE users ADD COLUMN biz_key_iv TEXT");
  }
  if (!columns.includes("biz_key_tag")) {
    db.exec("ALTER TABLE users ADD COLUMN biz_key_tag TEXT");
  }
  if (!columns.includes("active_context")) {
    db.exec("ALTER TABLE users ADD COLUMN active_context TEXT NOT NULL DEFAULT 'personal'");
  }
  if (!columns.includes("phone_number")) {
    db.exec("ALTER TABLE users ADD COLUMN phone_number TEXT");
  }
  if (!columns.includes("phone_verified")) {
    db.exec("ALTER TABLE users ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.includes("external_wallet_address")) {
    db.exec("ALTER TABLE users ADD COLUMN external_wallet_address TEXT");
  }
  if (!columns.includes("referrer_telegram_id")) {
    db.exec("ALTER TABLE users ADD COLUMN referrer_telegram_id INTEGER");
  }
  if (!columns.includes("referral_code")) {
    db.exec("ALTER TABLE users ADD COLUMN referral_code TEXT");
  }
  try {
    const unassigned = db.prepare("SELECT telegram_id FROM users WHERE referral_code IS NULL OR referral_code = ''").all();
    for (const r of unassigned) {
      try {
        db.prepare("UPDATE users SET referral_code = ? WHERE telegram_id = ?").run(`ref${r.telegram_id}`, r.telegram_id);
      } catch { }
    }
  } catch (err) { }
  if (!columns.includes("referred_at")) {
    db.exec("ALTER TABLE users ADD COLUMN referred_at TEXT");
  }
  if (!columns.includes("referred_on_first_point")) {
    db.exec("ALTER TABLE users ADD COLUMN referred_on_first_point INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.includes("solana_deposit_address")) {
    db.exec("ALTER TABLE users ADD COLUMN solana_deposit_address TEXT");
  }
  if (!columns.includes("paj_permanent_offramp_address")) {
    db.exec("ALTER TABLE users ADD COLUMN paj_permanent_offramp_address TEXT");
  }
  if (!columns.includes("biz_solana_deposit_address")) {
    db.exec("ALTER TABLE users ADD COLUMN biz_solana_deposit_address TEXT");
  }
  if (!columns.includes("system_encrypted_key")) {
    db.exec("ALTER TABLE users ADD COLUMN system_encrypted_key TEXT");
  }
  if (!columns.includes("biz_system_encrypted_key")) {
    db.exec("ALTER TABLE users ADD COLUMN biz_system_encrypted_key TEXT");
  }
  if (!columns.includes("auto_earn_enabled")) {
    db.exec("ALTER TABLE users ADD COLUMN auto_earn_enabled INTEGER DEFAULT 0");
  }
  if (!columns.includes("deposit_settlement_mode")) {
    try { db.exec("ALTER TABLE users ADD COLUMN deposit_settlement_mode TEXT DEFAULT 'local'"); } catch (_) { }
  }
  if (!columns.includes("deposit_settlement_chosen")) {
    try { db.exec("ALTER TABLE users ADD COLUMN deposit_settlement_chosen INTEGER DEFAULT 0"); } catch (_) { }
  }
  if (!columns.includes("last_activity_at")) {
    db.exec("ALTER TABLE users ADD COLUMN last_activity_at TEXT");
    db.exec("UPDATE users SET last_activity_at = datetime('now') WHERE last_activity_at IS NULL");
  }
  if (!columns.includes("sender_name")) {
    try { db.exec("ALTER TABLE users ADD COLUMN sender_name TEXT"); } catch (_) { }
  }
  if (!columns.includes("biz_sender_name")) {
    try { db.exec("ALTER TABLE users ADD COLUMN biz_sender_name TEXT"); } catch (_) { }
  }
  if (!columns.includes("accepted_terms_at")) {
    try { db.exec("ALTER TABLE users ADD COLUMN accepted_terms_at TEXT"); } catch (_) { }
  }
  if (!columns.includes("accepted_terms_version")) {
    try { db.exec("ALTER TABLE users ADD COLUMN accepted_terms_version TEXT"); } catch (_) { }
  }

  // SQLite does not allow adding a UNIQUE constraint directly on ALTER TABLE for an existing column,
  // so create a unique index if possible. If duplicates already exist, ignore the failure and keep
  // the non-unique column so the service can still start.
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_unique ON users(referral_code)");
  } catch (err) {
    console.warn("Could not create unique index on referral_code:", err?.message || err);
  }
}

function ensureYieldPositionsSchema() {
  const info = db.prepare("PRAGMA table_info(yield_positions)").all();
  const cols = info.map(c => c.name);
  if (!cols.includes("amount_usdc")) db.exec("ALTER TABLE yield_positions ADD COLUMN amount_usdc REAL DEFAULT 0");
  if (!cols.includes("apy")) db.exec("ALTER TABLE yield_positions ADD COLUMN apy REAL DEFAULT 0");
  if (!cols.includes("project")) db.exec("ALTER TABLE yield_positions ADD COLUMN project TEXT DEFAULT ''");
  if (!cols.includes("symbol")) db.exec("ALTER TABLE yield_positions ADD COLUMN symbol TEXT DEFAULT 'USDC'");
  if (!cols.includes("chain")) db.exec("ALTER TABLE yield_positions ADD COLUMN chain TEXT DEFAULT 'arc'");
  if (!cols.includes("opened_at")) db.exec("ALTER TABLE yield_positions ADD COLUMN opened_at TEXT DEFAULT (datetime('now'))");
  if (!cols.includes("closed_at")) db.exec("ALTER TABLE yield_positions ADD COLUMN closed_at TEXT");
  if (!cols.includes("payout")) db.exec("ALTER TABLE yield_positions ADD COLUMN payout REAL");
  if (!cols.includes("status")) db.exec("ALTER TABLE yield_positions ADD COLUMN status TEXT DEFAULT 'active'");
  if (!cols.includes("vault_address")) db.exec("ALTER TABLE yield_positions ADD COLUMN vault_address TEXT");
  if (!cols.includes("is_auto_earn")) db.exec("ALTER TABLE yield_positions ADD COLUMN is_auto_earn INTEGER DEFAULT 0");
  if (!cols.includes("dev_fee_usdc")) db.exec("ALTER TABLE yield_positions ADD COLUMN dev_fee_usdc REAL DEFAULT 0");
  if (!cols.includes("deposit_tx_hash")) db.exec("ALTER TABLE yield_positions ADD COLUMN deposit_tx_hash TEXT");
  if (!cols.includes("withdraw_tx_hash")) db.exec("ALTER TABLE yield_positions ADD COLUMN withdraw_tx_hash TEXT");
  if (!cols.includes("fee_tx_hash")) db.exec("ALTER TABLE yield_positions ADD COLUMN fee_tx_hash TEXT");
  if (!cols.includes("account_type")) db.exec("ALTER TABLE yield_positions ADD COLUMN account_type TEXT DEFAULT 'personal'");
  if (!cols.includes("user_apy")) db.exec("ALTER TABLE yield_positions ADD COLUMN user_apy REAL DEFAULT 0");
  if (!cols.includes("payit_fee_apy")) db.exec("ALTER TABLE yield_positions ADD COLUMN payit_fee_apy REAL DEFAULT 0");
  try { db.exec("UPDATE yield_positions SET status = 'active' WHERE status IS NULL"); } catch { }
  try { db.exec("UPDATE yield_positions SET payit_fee_apy = 0 WHERE payit_fee_apy IS NULL"); } catch { }
}

function ensureInvoicesSchema() {
  try {
    const info = db.prepare("PRAGMA table_info(invoices)").all();
    const cols = info.map(c => c.name);
    if (!cols.includes("currency")) {
      db.exec("ALTER TABLE invoices ADD COLUMN currency TEXT NOT NULL DEFAULT 'USDC'");
    }
  } catch (err) {
    console.warn("[db] ensureInvoicesSchema warning:", err.message);
  }
}

function ensureTransactionsSchema() {
  const info = db.prepare("PRAGMA table_info(transactions)").all();
  const cols = info.map(c => c.name);
  if (!cols.includes("tx_hash")) db.exec("ALTER TABLE transactions ADD COLUMN tx_hash TEXT");
  if (!cols.includes("account_type")) db.exec("ALTER TABLE transactions ADD COLUMN account_type TEXT DEFAULT 'personal'");
  if (!cols.includes("amount_micro")) db.exec("ALTER TABLE transactions ADD COLUMN amount_micro TEXT");
  if (!cols.includes("status")) db.exec("ALTER TABLE transactions ADD COLUMN status TEXT DEFAULT 'pending'");
  if (!cols.includes("type")) db.exec("ALTER TABLE transactions ADD COLUMN type TEXT DEFAULT 'general'");
  if (!cols.includes("decimals")) db.exec("ALTER TABLE transactions ADD COLUMN decimals INTEGER NOT NULL DEFAULT 18");
  if (!cols.includes("chain")) db.exec("ALTER TABLE transactions ADD COLUMN chain TEXT NOT NULL DEFAULT 'arc'");
  if (!cols.includes("narration")) db.exec("ALTER TABLE transactions ADD COLUMN narration TEXT");
  if (!cols.includes("source_currency")) db.exec("ALTER TABLE transactions ADD COLUMN source_currency TEXT");
  if (!cols.includes("source_amount")) db.exec("ALTER TABLE transactions ADD COLUMN source_amount REAL");
  if (!cols.includes("deposit_channel")) db.exec("ALTER TABLE transactions ADD COLUMN deposit_channel TEXT");
  if (!cols.includes("counterparty_name")) db.exec("ALTER TABLE transactions ADD COLUMN counterparty_name TEXT");
  if (!cols.includes("counterparty_bank")) db.exec("ALTER TABLE transactions ADD COLUMN counterparty_bank TEXT");
  if (!cols.includes("counterparty_account")) db.exec("ALTER TABLE transactions ADD COLUMN counterparty_account TEXT");
}

function ensurePajOrdersSchema() {
  try {
    const offrampCols = db.prepare("PRAGMA table_info(paj_offramp_orders)").all().map(c => c.name);
    if (!offrampCols.includes("narration")) {
      db.exec("ALTER TABLE paj_offramp_orders ADD COLUMN narration TEXT");
    }
    if (!offrampCols.includes("sender_name")) {
      db.exec("ALTER TABLE paj_offramp_orders ADD COLUMN sender_name TEXT");
    }
  } catch (err) {
    console.warn("[db] ensurePajOrdersSchema offramp note:", err.message);
  }
  try {
    const onrampCols = db.prepare("PRAGMA table_info(paj_onramp_orders)").all().map(c => c.name);
    if (!onrampCols.includes("narration")) {
      db.exec("ALTER TABLE paj_onramp_orders ADD COLUMN narration TEXT");
    }
    if (!onrampCols.includes("sender_name")) {
      db.exec("ALTER TABLE paj_onramp_orders ADD COLUMN sender_name TEXT");
    }
    if (!onrampCols.includes("sender_bank")) {
      db.exec("ALTER TABLE paj_onramp_orders ADD COLUMN sender_bank TEXT");
    }
    if (!onrampCols.includes("sender_account")) {
      db.exec("ALTER TABLE paj_onramp_orders ADD COLUMN sender_account TEXT");
    }
  } catch (err) {
    console.warn("[db] ensurePajOrdersSchema onramp note:", err.message);
  }
}

function ensureCctpPendingSchema() {
  // Idempotently add the cctp_pending_burns table for deployments that pre-date it.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cctp_pending_burns (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id       INTEGER NOT NULL,
        arc_tx_hash       TEXT NOT NULL UNIQUE,
        message_hex       TEXT,
        message_hash      TEXT,
        amount_usdc       REAL NOT NULL,
        recipient_solana  TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending',
        error             TEXT,
        retry_count       INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at      TEXT,
        solana_tx_sig     TEXT
      )
    `);
  } catch (err) {
    console.warn("[db] ensureCctpPendingSchema note:", err.message);
  }
}

function ensureCctpInboundSchema() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cctp_inbound_transfers (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id       INTEGER NOT NULL,
        solana_address    TEXT NOT NULL,
        arc_address       TEXT NOT NULL,
        amount_usdc       REAL NOT NULL,
        solana_burn_sig   TEXT UNIQUE,
        message_hex       TEXT,
        message_hash      TEXT,
        attestation       TEXT,
        arc_tx_hash       TEXT,
        status            TEXT NOT NULL DEFAULT 'initiated',
        error             TEXT,
        retry_count       INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at      TEXT
      )
    `);
    const cols = db.prepare("PRAGMA table_info(cctp_inbound_transfers)").all().map((r) => r.name);
    if (!cols.includes("cctp_message")) {
      db.exec("ALTER TABLE cctp_inbound_transfers ADD COLUMN cctp_message TEXT");
    }
  } catch (err) {
    console.warn("[db] ensureCctpInboundSchema note:", err.message);
  }
}

ensureUserSchema();
ensureYieldPositionsSchema();
ensureInvoicesSchema();
ensureTransactionsSchema();
ensurePajOrdersSchema();
ensureCctpPendingSchema();
ensureCctpInboundSchema();
cleanupOrphanData();

function cleanupOrphanData() {
  try {
    db.exec("DROP TABLE IF EXISTS test_tg");
    db.exec("DROP TABLE IF EXISTS test_match");
    db.exec(`
      DELETE FROM yield_positions 
      WHERE telegram_id IS NULL 
         OR (
           telegram_id NOT IN (SELECT telegram_id FROM users)
           AND CAST(telegram_id AS TEXT) NOT IN (SELECT CAST(telegram_id AS TEXT) FROM users)
         )
    `);
    db.exec(`
      DELETE FROM transactions 
      WHERE telegram_id IS NULL 
         OR (
           telegram_id NOT IN (SELECT telegram_id FROM users)
           AND CAST(telegram_id AS TEXT) NOT IN (SELECT CAST(telegram_id AS TEXT) FROM users)
         )
    `);
  } catch (err) {
    console.warn("[db] cleanupOrphanData note:", err.message);
  }
}
ensureNearDepositsSchema();
ensureSettlementRunsSchema();

// ─── User helpers ─────────────────────────────────────────────────────────────

function findUserByUsername(username) {
  if (!username) return null;
  const clean = String(username).replace(/^@/, "").trim().toLowerCase();
  return db.prepare("SELECT * FROM users WHERE LOWER(username) = ?").get(clean) || null;
}

function syncUsername(telegramId, username) {
  if (!telegramId || !username) return;
  const clean = String(username).replace(/^@/, "").trim();
  if (!clean) return;
  try {
    db.prepare("UPDATE users SET username = ? WHERE telegram_id = ? AND (username IS NULL OR LOWER(username) != LOWER(?))")
      .run(clean, telegramId, clean);
  } catch (_) { }
}

function getUser(telegramId) {
  if (telegramId === null || telegramId === undefined || telegramId === "" || telegramId === "undefined" || telegramId === "null") {
    return null;
  }
  const direct = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId);
  if (direct) return direct;
  const numId = Number(telegramId);
  if (Number.isSafeInteger(numId)) {
    const byNum = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(numId);
    if (byNum) return byNum;
  }
  const strId = String(telegramId).trim();
  const byStr = db.prepare("SELECT * FROM users WHERE CAST(telegram_id AS TEXT) = ? OR telegram_id = ?").get(strId, `${strId}.0`);
  return byStr || null;
}

function recordTermsAcceptance(telegramId, version = "2026-11") {
  const res = db
    .prepare(
      "UPDATE users SET accepted_terms_at = COALESCE(accepted_terms_at, datetime('now')), accepted_terms_version = ? WHERE telegram_id = ?"
    )
    .run(String(version), Number(telegramId));
  return res.changes > 0;
}

function hasAcceptedTerms(user) {
  return Boolean(user && user.accepted_terms_at);
}

function getAllUsers() {
  return db.prepare("SELECT * FROM users").all() || [];
}

function getUserByReferralCode(code) {
  if (!code) return null;
  const cleanCode = String(code).trim();
  const direct = db.prepare("SELECT * FROM users WHERE LOWER(referral_code) = LOWER(?)").get(cleanCode);
  if (direct) return direct;

  // Fallback: check if cleanCode matches 'ref<id>' or numeric '<id>'
  let candidateId = null;
  if (/^ref\d+$/i.test(cleanCode)) {
    candidateId = Number(cleanCode.replace(/^ref/i, ""));
  } else if (/^\d+$/.test(cleanCode)) {
    candidateId = Number(cleanCode);
  }

  if (candidateId && Number.isSafeInteger(candidateId)) {
    const user = getUser(candidateId);
    if (user) {
      if (!user.referral_code) {
        const standardCode = `ref${candidateId}`;
        try {
          db.prepare("UPDATE users SET referral_code = ? WHERE telegram_id = ?").run(standardCode, candidateId);
          user.referral_code = standardCode;
        } catch { }
      }
      return user;
    }
  }

  return null;
}

/**
 * Create a new user with personal wallet (and optionally business wallet).
 * Encrypts both keys with the same PIN before writing.
 */
function createUserWithWallet(
  telegramId, username, address, privateKey, pin,
  businessAddress = null, businessPrivateKey = null,
  referrerId = null
) {
  // Encrypt personal key
  const enc = walletLib.encryptPrivateKey(privateKey, pin);

  // Encrypt business key if provided
  let bizEnc = null;
  if (businessAddress && businessPrivateKey) {
    bizEnc = walletLib.encryptPrivateKey(businessPrivateKey, pin);
  }

  const referralCode = `ref${telegramId}`;
  const referredAt = referrerId ? new Date().toISOString() : null;

  let solanaDepositAddress = null;
  try {
    const derivedSol = multichain.deriveSolanaFromEvmKey(privateKey);
    solanaDepositAddress = derivedSol.solanaAddress;
  } catch (err) {
    console.warn("[db] Failed to derive Solana address during user creation:", err.message);
  }

  let bizSolanaDepositAddress = null;
  if (businessAddress && businessPrivateKey) {
    try {
      const derivedBizSol = multichain.deriveSolanaFromEvmKey(businessPrivateKey);
      bizSolanaDepositAddress = derivedBizSol.solanaAddress;
    } catch (err) {
      console.warn("[db] Failed to derive Business Solana address:", err.message);
    }
  }

  let systemEncryptedKey = null;
  try {
    systemEncryptedKey = walletLib.encryptSensitiveValue(privateKey);
  } catch (err) {
    console.warn("[db] Failed to encrypt system_encrypted_key:", err.message);
  }

  let bizSystemEncryptedKey = null;
  if (businessAddress && businessPrivateKey) {
    try {
      bizSystemEncryptedKey = walletLib.encryptSensitiveValue(businessPrivateKey);
    } catch (err) {
      console.warn("[db] Failed to encrypt biz_system_encrypted_key:", err.message);
    }
  }

  db.prepare(`
    INSERT INTO users (
      telegram_id, username,
      deposit_address, encrypted_key, key_salt, key_iv, key_tag,
      business_deposit_address, biz_encrypted_key, biz_key_salt, biz_key_iv, biz_key_tag,
      active_context,
      referrer_telegram_id, referral_code, referred_at, referred_on_first_point,
      solana_deposit_address, biz_solana_deposit_address,
      system_encrypted_key, biz_system_encrypted_key,
      auto_earn_enabled, deposit_settlement_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    telegramId, username || null,
    address, enc.encryptedKey, enc.salt, enc.iv, enc.tag,
    businessAddress || null,
    bizEnc?.encryptedKey || null, bizEnc?.salt || null,
    bizEnc?.iv || null, bizEnc?.tag || null,
    businessAddress ? "business" : "personal",
    referrerId || null,
    referralCode,
    referredAt,
    0,
    solanaDepositAddress,
    bizSolanaDepositAddress,
    systemEncryptedKey,
    bizSystemEncryptedKey,
    0,
    "local"
  );

  return getUser(telegramId);
}

/**
 * Add a business wallet to an existing personal-only user.
 * Encrypts with the same PIN they already use.
 */
function addBusinessWallet(telegramId, businessAddress, businessPrivateKey, pin) {
  const bizEnc = walletLib.encryptPrivateKey(businessPrivateKey, pin);
  let bizSolanaDepositAddress = null;
  try {
    const derivedBizSol = multichain.deriveSolanaFromEvmKey(businessPrivateKey);
    bizSolanaDepositAddress = derivedBizSol.solanaAddress;
  } catch (err) {
    console.warn("[db] Failed to derive Business Solana address on add:", err.message);
  }

  let bizSystemEncryptedKey = null;
  try {
    bizSystemEncryptedKey = walletLib.encryptSensitiveValue(businessPrivateKey);
  } catch (err) {
    console.warn("[db] Failed to encrypt biz_system_encrypted_key on add:", err.message);
  }

  db.prepare(`
    UPDATE users SET
      business_deposit_address = ?,
      biz_encrypted_key = ?, biz_key_salt = ?, biz_key_iv = ?, biz_key_tag = ?,
      biz_solana_deposit_address = ?,
      biz_system_encrypted_key = ?,
      active_context = 'business'
    WHERE telegram_id = ?
  `).run(
    businessAddress,
    bizEnc.encryptedKey, bizEnc.salt, bizEnc.iv, bizEnc.tag,
    bizSolanaDepositAddress,
    bizSystemEncryptedKey,
    telegramId
  );
}

function setActiveContext(telegramId, context) {
  db.prepare("UPDATE users SET active_context = ? WHERE telegram_id = ?").run(context, telegramId);
}

// ─── PIN / key management & security ─────────────────────────────────────────

const MAX_FAILED_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function getPinSecurity(telegramId) {
  try {
    return db.prepare("SELECT * FROM pin_security WHERE telegram_id = ?").get(telegramId);
  } catch {
    return null;
  }
}

function isPinLocked(telegramId) {
  const sec = getPinSecurity(telegramId);
  if (!sec || !sec.locked_until) return { locked: false, remainingSec: 0 };
  const now = Date.now();
  if (sec.locked_until > now) {
    const remainingSec = Math.ceil((sec.locked_until - now) / 1000);
    return { locked: true, remainingSec };
  }
  return { locked: false, remainingSec: 0 };
}

function recordFailedPinAttempt(telegramId) {
  const sec = getPinSecurity(telegramId);
  const now = Date.now();
  let failed = (sec?.failed_attempts || 0) + 1;
  let lockedUntil = 0;
  if (failed >= MAX_FAILED_PIN_ATTEMPTS) {
    lockedUntil = now + PIN_LOCKOUT_DURATION_MS;
  }
  try {
    db.prepare(`
      INSERT INTO pin_security (telegram_id, failed_attempts, locked_until, last_attempt_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(telegram_id) DO UPDATE SET
        failed_attempts = excluded.failed_attempts,
        locked_until = excluded.locked_until,
        last_attempt_at = excluded.last_attempt_at
    `).run(telegramId, failed, lockedUntil);
  } catch (err) {
    console.error("[db] Error recording failed PIN attempt:", err.message);
  }

  const remainingAttempts = Math.max(0, MAX_FAILED_PIN_ATTEMPTS - failed);
  const remainingSec = lockedUntil > now ? Math.ceil((lockedUntil - now) / 1000) : 0;
  return {
    locked: lockedUntil > now,
    remainingAttempts,
    remainingSec,
  };
}

function resetPinLockout(telegramId) {
  try {
    db.prepare(`
      INSERT INTO pin_security (telegram_id, failed_attempts, locked_until, last_attempt_at)
      VALUES (?, 0, 0, datetime('now'))
      ON CONFLICT(telegram_id) DO UPDATE SET
        failed_attempts = 0,
        locked_until = 0,
        last_attempt_at = datetime('now')
    `).run(telegramId);
  } catch (err) {
    console.error("[db] Error resetting PIN lockout:", err.message);
  }
}

function verifyPinWithStatus(telegramId, pin) {
  const lockStatus = isPinLocked(telegramId);
  if (lockStatus.locked) {
    return {
      valid: false,
      locked: true,
      remainingAttempts: 0,
      remainingSec: lockStatus.remainingSec,
    };
  }

  const user = getUser(telegramId);
  if (!user) {
    return { valid: false, locked: false, remainingAttempts: 0, remainingSec: 0 };
  }

  try {
    const privKey = walletLib.decryptPrivateKey(pin, {
      encryptedKey: user.encrypted_key,
      salt: user.key_salt,
      iv: user.key_iv,
      tag: user.key_tag,
    });

    // Seamlessly backfill system_encrypted_key for automated background operations if missing
    if (!user.system_encrypted_key) {
      try {
        const sysEnc = walletLib.encryptSensitiveValue(privKey);
        db.prepare("UPDATE users SET system_encrypted_key = ? WHERE telegram_id = ?").run(sysEnc, telegramId);
        user.system_encrypted_key = sysEnc;
      } catch (e) {
        console.warn("[db] Failed to backfill system_encrypted_key:", e.message);
      }
    }
    if (user.biz_encrypted_key && !user.biz_system_encrypted_key) {
      try {
        const bizPrivKey = walletLib.decryptPrivateKey(pin, {
          encryptedKey: user.biz_encrypted_key,
          salt: user.biz_key_salt,
          iv: user.biz_key_iv,
          tag: user.biz_key_tag,
        });
        const bizSysEnc = walletLib.encryptSensitiveValue(bizPrivKey);
        db.prepare("UPDATE users SET biz_system_encrypted_key = ? WHERE telegram_id = ?").run(bizSysEnc, telegramId);
        user.biz_system_encrypted_key = bizSysEnc;
      } catch (e) {
        console.warn("[db] Failed to backfill biz_system_encrypted_key:", e.message);
      }
    }

    // Keep the stored Solana deposit address in sync with the key that was just unlocked.
    // Lazy require avoids a circular import at load time.
    try {
      require("./solana_address").reconcileUser(user);
    } catch (e) {
      console.warn("[db] Solana address reconcile warning:", e.message);
    }

    resetPinLockout(telegramId);
    return { valid: true, locked: false, remainingAttempts: MAX_FAILED_PIN_ATTEMPTS, remainingSec: 0 };
  } catch {
    const failResult = recordFailedPinAttempt(telegramId);
    return {
      valid: false,
      locked: failResult.locked,
      remainingAttempts: failResult.remainingAttempts,
      remainingSec: failResult.remainingSec,
    };
  }
}

function verifyPin(telegramId, pin) {
  const result = verifyPinWithStatus(telegramId, pin);
  return result.valid;
}

function decryptPrivateKey(pin, user) {
  return walletLib.decryptPrivateKey(pin, {
    encryptedKey: user.encrypted_key,
    salt: user.key_salt,
    iv: user.key_iv,
    tag: user.key_tag,
  });
}

function decryptBusinessPrivateKey(pin, user) {
  if (!user.biz_encrypted_key) throw new Error("No business wallet found.");
  return walletLib.decryptPrivateKey(pin, {
    encryptedKey: user.biz_encrypted_key,
    salt: user.biz_key_salt,
    iv: user.biz_key_iv,
    tag: user.biz_key_tag,
  });
}

/**
 * Re-encrypts both personal and business keys with a new PIN.
 * Called from changepin flow after old PIN verified and keys already decrypted.
 */
function updatePin(telegramId, newPin, personalPrivateKey, businessPrivateKey = null) {
  const enc = walletLib.encryptPrivateKey(personalPrivateKey, newPin);
  if (businessPrivateKey) {
    const bizEnc = walletLib.encryptPrivateKey(businessPrivateKey, newPin);
    db.prepare(`
      UPDATE users SET
        encrypted_key = ?, key_salt = ?, key_iv = ?, key_tag = ?,
        biz_encrypted_key = ?, biz_key_salt = ?, biz_key_iv = ?, biz_key_tag = ?
      WHERE telegram_id = ?
    `).run(
      enc.encryptedKey, enc.salt, enc.iv, enc.tag,
      bizEnc.encryptedKey, bizEnc.salt, bizEnc.iv, bizEnc.tag,
      telegramId
    );
  } else {
    db.prepare(`
      UPDATE users SET encrypted_key = ?, key_salt = ?, key_iv = ?, key_tag = ?
      WHERE telegram_id = ?
    `).run(enc.encryptedKey, enc.salt, enc.iv, enc.tag, telegramId);
  }
}

// ─── Profile helpers ──────────────────────────────────────────────────────────

function setExternalWallet(telegramId, address) {
  db.prepare("UPDATE users SET external_wallet_address = ? WHERE telegram_id = ?").run(address, telegramId);
}

function setPhoneNumber(telegramId, phone) {
  db.prepare("UPDATE users SET phone_number = ?, phone_verified = 0 WHERE telegram_id = ?").run(phone, telegramId);
}

function setPhoneVerified(telegramId, verified) {
  db.prepare("UPDATE users SET phone_verified = ? WHERE telegram_id = ?").run(verified ? 1 : 0, telegramId);
}

// Actions that NEVER qualify for triggering a referral bonus (e.g. free invoice creation)
const NON_QUALIFYING_REFERRAL_ACTIONS = new Set([
  "invoice",
  "businessInvoice",
  "invoice_created",
  "referral_bonus",
]);

function awardPoints(telegramId, points, action, details = null, options = {}) {
  if (!Number.isInteger(points) || points === 0) return;
  const normalized = Number(points);
  if (normalized > 0 && !options.skipReferral) {
    maybeAwardReferralBonus(telegramId, options.notify, {
      action,
      amountUsd: options.amountUsd,
    });
  }
  db.prepare("UPDATE users SET points_balance = points_balance + ? WHERE telegram_id = ?").run(normalized, telegramId);
  db.prepare(
    "INSERT INTO points_history (telegram_id, points, action, details) VALUES (?, ?, ?, ?)"
  ).run(telegramId, normalized, action, details);

  if (typeof options.notify === "function") {
    options.notify({
      telegramId,
      action,
      points: normalized,
      details,
      type: normalized > 0 ? "points_earned" : "points_spent",
    });
  }
}

function maybeAwardReferralBonus(telegramId, notify = null, context = {}) {
  const act = String(context?.action || "").trim();
  if (act && NON_QUALIFYING_REFERRAL_ACTIONS.has(act)) {
    return;
  }
  const minQualifyingUsd = Math.max(0, Number(process.env.MIN_REFERRAL_QUALIFYING_USD ?? 5));
  if (context?.amountUsd !== undefined && context?.amountUsd !== null) {
    const vol = Number(context.amountUsd);
    if (!Number.isFinite(vol) || vol < minQualifyingUsd) {
      return;
    }
  }

  const row = db.prepare(
    "SELECT referrer_telegram_id, referred_on_first_point FROM users WHERE telegram_id = ?"
  ).get(telegramId);
  if (!row?.referrer_telegram_id || row.referred_on_first_point === 1) return;
  if (row.referrer_telegram_id === telegramId) return;

  const referrer = getUser(row.referrer_telegram_id);
  if (!referrer) return;

  // Atomic check-and-set so concurrent transactions can never double-award the referral bonus
  const claim = db.prepare(
    "UPDATE users SET referred_on_first_point = 1 WHERE telegram_id = ? AND COALESCE(referred_on_first_point, 0) = 0"
  ).run(telegramId);
  if (!claim || claim.changes === 0) return;

  awardPoints(referrer.telegram_id, REFERRAL_BONUS_POINTS, "referral_bonus", `Referral: ${telegramId}`, {
    skipReferral: true,
    notify,
  });
}

/**
 * Atomically deduct points from a user's balance only if `points_balance >= points`.
 * Prevents concurrent PIN submissions from driving `points_balance` negative.
 */
function redeemPointsAtomic(telegramId, points, action = "redeem", details = null) {
  const pts = Math.round(Number(points));
  if (!Number.isInteger(pts) || pts <= 0) {
    throw new Error("Invalid points amount to redeem.");
  }
  const info = db.prepare(
    "UPDATE users SET points_balance = points_balance - ? WHERE telegram_id = ? AND points_balance >= ?"
  ).run(pts, telegramId, pts);
  if (!info || info.changes === 0) {
    throw new Error("Insufficient points balance.");
  }
  db.prepare(
    "INSERT INTO points_history (telegram_id, points, action, details) VALUES (?, ?, ?, ?)"
  ).run(telegramId, -pts, action, details);
  return getPointsBalance(telegramId);
}

function getPointsBalance(telegramId) {
  const row = db.prepare("SELECT points_balance FROM users WHERE telegram_id = ?").get(telegramId);
  return row ? Number(row.points_balance || 0) : 0;
}

function getPointsHistory(telegramId, limit = 20) {
  return db.prepare(
    "SELECT * FROM points_history WHERE telegram_id = ? ORDER BY id DESC LIMIT ?"
  ).all(telegramId, limit);
}

function blockUser(telegramId, reason = null) {
  db.prepare(
    "UPDATE users SET is_blocked = 1, blocked_at = datetime('now'), blocked_reason = ? WHERE telegram_id = ?"
  ).run(reason, telegramId);
}

function unblockUser(telegramId) {
  db.prepare(
    "UPDATE users SET is_blocked = 0, blocked_at = NULL, blocked_reason = NULL WHERE telegram_id = ?"
  ).run(telegramId);
}

function isBlocked(telegramId) {
  const row = db.prepare("SELECT is_blocked FROM users WHERE telegram_id = ?").get(telegramId);
  return row?.is_blocked === 1;
}
// ─── Transactions ─────────────────────────────────────────────────────────────

const TERMINAL_TX_STATUSES = new Set(["confirmed", "completed", "paid", "settled"]);

function _txStatusRank(status) {
  const s = String(status || "").toLowerCase();
  if (TERMINAL_TX_STATUSES.has(s)) return 3;
  if (/fail|reject|cancel|error|refund/.test(s)) return 2;
  return 1; // pending / submitted / processing
}

function recordTransaction(telegramId, type, amountMicro, status, txHash, accountType = "personal", decimals = 18, chain = "arc", narration = null, meta = null) {
  const sourceCurrency = meta && meta.sourceCurrency ? String(meta.sourceCurrency).toUpperCase() : null;
  const rawSourceAmt = meta && meta.sourceAmount !== undefined && meta.sourceAmount !== null ? Number(meta.sourceAmount) : null;
  const sourceAmount = rawSourceAmt !== null && Number.isFinite(rawSourceAmt) && rawSourceAmt > 0 ? rawSourceAmt : null;
  const depositChannel = meta && meta.depositChannel ? String(meta.depositChannel).toLowerCase() : null;
  const counterpartyName = meta && meta.counterpartyName ? String(meta.counterpartyName).trim().slice(0, 140) : null;
  const counterpartyBank = meta && meta.counterpartyBank ? String(meta.counterpartyBank).trim().slice(0, 120) : null;
  const counterpartyAccount = meta && meta.counterpartyAccount ? String(meta.counterpartyAccount).trim().slice(0, 120) : null;
  const cleanHash = txHash ? String(txHash).trim() : null;
  const cleanAcct = accountType || "personal";
  const amountStr = amountMicro.toString();

  // Deduplication / upsert guard: prevent webhooks + pollers + action handlers from creating
  // two ledger rows for the exact same transfer, payout, or deposit.
  try {
    let existing = null;
    if (cleanHash) {
      existing = db.prepare(
        "SELECT * FROM transactions WHERE telegram_id = ? AND account_type = ? AND type = ? AND tx_hash = ? ORDER BY id DESC LIMIT 1"
      ).get(telegramId, cleanAcct, type, cleanHash);
    }

    // For Paj offramp payouts, the initial action records tx_hash = on-chain txHash while the
    // webhook/poller later arrives with tx_hash = order_id (or vice-versa). Merge via paj_offramp_orders.
    if (!existing && type === "offramp") {
      const refHashes = [];
      if (cleanHash) refHashes.push(cleanHash);
      if (meta && meta.orderId) refHashes.push(String(meta.orderId).trim());
      if (meta && meta.onchainTxHash) refHashes.push(String(meta.onchainTxHash).trim());
      if (cleanHash) {
        try {
          const order = db.prepare(
            "SELECT order_id, tx_hash FROM paj_offramp_orders WHERE telegram_id = ? AND (order_id = ? OR tx_hash = ?) ORDER BY id DESC LIMIT 1"
          ).get(telegramId, cleanHash, cleanHash);
          if (order?.order_id) refHashes.push(String(order.order_id));
          if (order?.tx_hash) refHashes.push(String(order.tx_hash));
        } catch (_) { }
      }
      const uniqueRefs = [...new Set(refHashes.filter(Boolean))];
      for (const ref of uniqueRefs) {
        const hit = db.prepare(
          "SELECT * FROM transactions WHERE telegram_id = ? AND account_type = ? AND type = 'offramp' AND tx_hash = ? ORDER BY id DESC LIMIT 1"
        ).get(telegramId, cleanAcct, ref);
        if (hit) {
          existing = hit;
          break;
        }
      }
      // Fallback: upgrade a recent submitted/pending offramp of the exact same amount when order hashes differ
      if (!existing && _txStatusRank(status) >= 2) {
        existing = db.prepare(
          `SELECT * FROM transactions
           WHERE telegram_id = ? AND account_type = ? AND type = 'offramp'
             AND status IN ('pending', 'submitted', 'processing')
             AND amount_micro = ?
             AND created_at >= datetime('now', '-6 hours')
           ORDER BY id DESC LIMIT 1`
        ).get(telegramId, cleanAcct, amountStr);
      }
    }

    // For Paj onramp Naira deposits, webhook + poller can both fire with order_id vs settlement txHash.
    if (!existing && type === "deposit_naira") {
      const refHashes = [];
      if (cleanHash) refHashes.push(cleanHash);
      if (meta && meta.orderId) refHashes.push(String(meta.orderId).trim());
      if (cleanHash) {
        try {
          const order = db.prepare(
            "SELECT order_id, tx_hash FROM paj_onramp_orders WHERE telegram_id = ? AND (order_id = ? OR tx_hash = ?) ORDER BY id DESC LIMIT 1"
          ).get(telegramId, cleanHash, cleanHash);
          if (order?.order_id) refHashes.push(String(order.order_id));
          if (order?.tx_hash) refHashes.push(String(order.tx_hash));
        } catch (_) { }
      }
      const uniqueRefs = [...new Set(refHashes.filter(Boolean))];
      for (const ref of uniqueRefs) {
        const hit = db.prepare(
          "SELECT * FROM transactions WHERE telegram_id = ? AND account_type = ? AND type = 'deposit_naira' AND tx_hash = ? ORDER BY id DESC LIMIT 1"
        ).get(telegramId, cleanAcct, ref);
        if (hit) {
          existing = hit;
          break;
        }
      }
    }

    if (existing) {
      const nextStatus = _txStatusRank(status) >= _txStatusRank(existing.status) ? status : existing.status;
      const nextHash = existing.tx_hash || cleanHash;
      const nextNarration = existing.narration || narration || null;
      const nextSourceCur = existing.source_currency || sourceCurrency;
      const nextSourceAmt = existing.source_amount ?? sourceAmount;
      const nextChannel = existing.deposit_channel || depositChannel;
      const nextCpName = existing.counterparty_name || counterpartyName;
      const nextCpBank = existing.counterparty_bank || counterpartyBank;
      const nextCpAcct = existing.counterparty_account || counterpartyAccount;
      db.prepare(
        `UPDATE transactions
         SET status = ?, tx_hash = ?, narration = ?, source_currency = ?, source_amount = ?, deposit_channel = ?,
             counterparty_name = ?, counterparty_bank = ?, counterparty_account = ?
         WHERE id = ?`
      ).run(nextStatus, nextHash, nextNarration, nextSourceCur, nextSourceAmt, nextChannel, nextCpName, nextCpBank, nextCpAcct, existing.id);
      return existing.id;
    }
  } catch (dedupeErr) {
    console.warn("[db:recordTransaction] dedupe check note:", dedupeErr.message);
  }

  const result = db.prepare(
    "INSERT INTO transactions (telegram_id, type, amount_micro, status, tx_hash, account_type, decimals, chain, narration, source_currency, source_amount, deposit_channel, counterparty_name, counterparty_bank, counterparty_account) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    telegramId,
    type,
    amountStr,
    status,
    cleanHash,
    cleanAcct,
    decimals,
    chain,
    narration || null,
    sourceCurrency,
    sourceAmount,
    depositChannel,
    counterpartyName,
    counterpartyBank,
    counterpartyAccount
  );
  const insertedId = result.lastInsertRowid;

  // Send transaction alert email asynchronously for every settled transaction on verified KYC/KYB accounts
  if (process.env.NODE_ENV !== "test" || process.env.ENABLE_TX_EMAIL_IN_TEST === "true") {
    setImmediate(() => {
      try {
        require("./email").dispatchVerifiedTransactionEmail({
          telegramId,
          txId: insertedId,
          type,
          amountMicro: amountStr,
          decimals,
          status,
          txHash: cleanHash,
          accountType: cleanAcct,
          narration: narration || null,
          sourceCurrency,
          sourceAmount,
          counterpartyName,
          counterpartyBank,
          counterpartyAccount,
        }).catch(() => { });
      } catch (_) { }
    });
  }

  return insertedId;
}

function updateTransactionStatus(txId, status, txHash = null) {
  if (txHash) {
    db.prepare("UPDATE transactions SET status = ?, tx_hash = ? WHERE id = ?").run(status, txHash, txId);
  } else {
    db.prepare("UPDATE transactions SET status = ? WHERE id = ?").run(status, txId);
  }
}

function updateTransactionByTxHash(oldTxHash, status, newTxHash = null) {
  if (!oldTxHash) return;
  try {
    if (newTxHash) {
      db.prepare("UPDATE transactions SET status = ?, tx_hash = ? WHERE tx_hash = ?").run(status, newTxHash, oldTxHash);
    } else {
      db.prepare("UPDATE transactions SET status = ? WHERE tx_hash = ?").run(status, oldTxHash);
    }
  } catch (err) {
    console.warn("[db] updateTransactionByTxHash error:", err.message);
  }
}

function getTransactions(telegramId, limit = 10, accountType = null) {
  if (!telegramId || telegramId === "undefined" || telegramId === "null" || Number.isNaN(Number(telegramId))) {
    return [];
  }
  const numId = Math.round(Number(telegramId));
  const rawId = telegramId;
  const strId = String(numId || telegramId);
  const floatStrId = `${numId}.0`;

  if (accountType) {
    return db.prepare(
      "SELECT * FROM transactions WHERE (telegram_id = ? OR telegram_id = ? OR telegram_id = ? OR telegram_id = ?) AND account_type = ? ORDER BY id DESC LIMIT ?"
    ).all(numId, rawId, strId, floatStrId, accountType, limit);
  }
  return db.prepare(
    "SELECT * FROM transactions WHERE (telegram_id = ? OR telegram_id = ? OR telegram_id = ? OR telegram_id = ?) ORDER BY id DESC LIMIT ?"
  ).all(numId, rawId, strId, floatStrId, limit);
}

// ─── Yield positions ──────────────────────────────────────────────────────────

function getOpenYieldPosition(telegramId, accountType = null) {
  if (!telegramId || telegramId === "undefined" || telegramId === "null" || Number.isNaN(Number(telegramId))) {
    return null;
  }
  const numId = Math.round(Number(telegramId));
  const rawId = telegramId;
  const strId = String(numId || telegramId);
  const floatStrId = `${numId}.0`;
  let activePos = null;
  if (accountType) {
    const isPersonal = String(accountType).toLowerCase() === "personal";
    return db.prepare(
      `SELECT * FROM yield_positions
       WHERE (telegram_id = ? OR telegram_id = ? OR telegram_id = ? OR telegram_id = ?)
         AND (LOWER(account_type) = LOWER(?) ${isPersonal ? "OR account_type IS NULL" : ""})
         AND (status = 'active' OR status IS NULL)
       ORDER BY id DESC LIMIT 1`
    ).get(numId, rawId, strId, floatStrId, accountType) || null;
  }
  return db.prepare(
    "SELECT * FROM yield_positions WHERE (telegram_id = ? OR telegram_id = ? OR telegram_id = ? OR telegram_id = ?) AND (status = 'active' OR status IS NULL) ORDER BY id DESC LIMIT 1"
  ).get(numId, rawId, strId, floatStrId) || null;
}

function recoverUncreditedYieldPosition(telegramId, accountType = null) {
  if (!telegramId || telegramId === "undefined" || telegramId === "null" || Number.isNaN(Number(telegramId))) {
    return null;
  }
  const numId = Math.round(Number(telegramId));
  const rawId = telegramId;
  const strId = String(numId || telegramId);
  const floatStrId = `${numId}.0`;

  try {
    const isPersonal = !accountType || String(accountType).toLowerCase() === "personal";
    const latestClosed = accountType
      ? db.prepare(
        `SELECT * FROM yield_positions
           WHERE (telegram_id = ? OR telegram_id = ? OR telegram_id = ? OR telegram_id = ?)
             AND (LOWER(account_type) = LOWER(?) ${isPersonal ? "OR account_type IS NULL" : ""})
             AND status = 'closed'
           ORDER BY id DESC LIMIT 1`
      ).get(numId, rawId, strId, floatStrId, accountType)
      : db.prepare(
        `SELECT * FROM yield_positions
           WHERE (telegram_id = ? OR telegram_id = ? OR telegram_id = ? OR telegram_id = ?)
             AND status = 'closed'
           ORDER BY id DESC LIMIT 1`
      ).get(numId, rawId, strId, floatStrId);

    if (latestClosed && (latestClosed.withdraw_tx_hash === "0xsimulated_withdraw_tx_hash" || !latestClosed.withdraw_tx_hash)) {
      const hasTx = db.prepare(
        `SELECT id FROM transactions
         WHERE (telegram_id = ? OR telegram_id = ? OR telegram_id = ?)
           AND type = 'yield_withdraw'
           AND (created_at >= ? OR id >= ?)
         LIMIT 1`
      ).get(numId, rawId, strId, latestClosed.opened_at || "1970-01-01", latestClosed.id);

      if (!hasTx) {
        db.prepare(
          "UPDATE yield_positions SET status = 'active', closed_at = NULL, payout = NULL, withdraw_tx_hash = NULL WHERE id = ?"
        ).run(latestClosed.id);
        latestClosed.status = "active";
        latestClosed.closed_at = null;
        latestClosed.payout = null;
        latestClosed.withdraw_tx_hash = null;
        return latestClosed;
      }
    }
  } catch (_) { }

  return null;
}

function getLatestYieldPosition(telegramId) {
  if (!telegramId || telegramId === "undefined" || telegramId === "null" || Number.isNaN(Number(telegramId))) {
    return null;
  }
  const numId = Math.round(Number(telegramId));
  const rawId = telegramId;
  const strId = String(numId || telegramId);
  const floatStrId = `${numId}.0`;
  return db.prepare(
    "SELECT * FROM yield_positions WHERE (telegram_id = ? OR telegram_id = ? OR telegram_id = ? OR telegram_id = ?) ORDER BY id DESC LIMIT 1"
  ).get(numId, rawId, strId, floatStrId) || null;
}


function openYieldPosition(telegramId, amountUsdc, pool, options = {}) {
  const normTgId = Math.round(Number(telegramId));
  const vaultAddress = pool.vaultAddress || pool.address || null;
  const isAutoEarn = options.isAutoEarn ? 1 : 0;
  const depositTxHash = options.depositTxHash || null;
  const accountType = options.accountType || "personal";
  const userApy = pool.userApy ?? pool.apy ?? 0;
  const payitFeeApy = pool.payitApy ?? pool.payit_fee_apy ?? 0;
  const apy = pool.rawApy ?? pool.apy ?? userApy;
  const project = pool.project || "Arc Morpho Vault";
  const symbol = pool.symbol || "USDC";
  const chain = pool.chain || "arc";

  const cols = db.prepare("PRAGMA table_info(yield_positions)").all().map(c => c.name);

  // If the user already has an active position in this same vault for this account type,
  // top up its principal instead of creating a duplicate active row that hides earlier deposits.
  if (vaultAddress) {
    const isPersonal = String(accountType).toLowerCase() === "personal";
    const existing = db.prepare(
      `SELECT * FROM yield_positions
       WHERE telegram_id = ?
         AND (LOWER(account_type) = LOWER(?) ${isPersonal ? "OR account_type IS NULL" : ""})
         AND LOWER(vault_address) = LOWER(?)
         AND (status = 'active' OR status IS NULL)
       ORDER BY id DESC LIMIT 1`
    ).get(normTgId, accountType, vaultAddress);

    if (existing) {
      const mergedAmount = parseFloat((Number(existing.amount_usdc || 0) + Number(amountUsdc || 0)).toFixed(6));
      const setParts = ["amount_usdc = ?", "apy = ?", "project = ?", "symbol = ?", "chain = ?"];
      const updateVals = [mergedAmount, apy, project, symbol, chain];
      if (depositTxHash) {
        setParts.push("deposit_tx_hash = ?");
        updateVals.push(depositTxHash);
      }
      if (cols.includes("user_apy")) {
        setParts.push("user_apy = ?");
        updateVals.push(userApy);
      }
      if (cols.includes("payit_fee_apy")) {
        setParts.push("payit_fee_apy = ?");
        updateVals.push(payitFeeApy);
      }
      updateVals.push(existing.id);
      db.prepare(`UPDATE yield_positions SET ${setParts.join(", ")} WHERE id = ?`).run(...updateVals);
      return;
    }
  }

  const insertCols = [
    "telegram_id", "amount_usdc", "apy", "project", "symbol", "chain",
    "vault_address", "is_auto_earn", "deposit_tx_hash", "account_type", "status"
  ];
  const vals = [
    normTgId, amountUsdc, apy, project, symbol, chain,
    vaultAddress, isAutoEarn, depositTxHash, accountType, "active"
  ];

  if (cols.includes("user_apy")) {
    insertCols.push("user_apy");
    vals.push(userApy);
  }
  if (cols.includes("payit_fee_apy")) {
    insertCols.push("payit_fee_apy");
    vals.push(payitFeeApy);
  }

  const placeholders = insertCols.map(() => "?").join(", ");
  db.prepare(`
    INSERT INTO yield_positions (${insertCols.join(", ")})
    VALUES (${placeholders})
  `).run(...vals);
}

function closeYieldPosition(telegramId, payout, options = {}) {
  const devFee = options.devFee || 0;
  const withdrawTxHash = options.withdrawTxHash || null;
  const feeTxHash = options.feeTxHash || null;
  const positionId = options.positionId || null;
  const accountType = options.accountType || null;
  const vaultAddress = options.vaultAddress || null;

  if (positionId) {
    db.prepare(`
      UPDATE yield_positions SET
        status = 'closed',
        closed_at = datetime('now'),
        payout = ?,
        dev_fee_usdc = ?,
        withdraw_tx_hash = ?,
        fee_tx_hash = ?
      WHERE id = ? AND status = 'active'
    `).run(payout, devFee, withdrawTxHash, feeTxHash, positionId);

    // If full redemption cleared this vault, also close any legacy duplicate active rows in the same vault.
    if (vaultAddress && telegramId != null && !Number.isNaN(Number(telegramId))) {
      const normTgId = Math.round(Number(telegramId));
      const isPersonal = !accountType || String(accountType).toLowerCase() === "personal";
      try {
        if (accountType) {
          db.prepare(`
            UPDATE yield_positions SET
              status = 'closed',
              closed_at = datetime('now'),
              payout = 0,
              dev_fee_usdc = 0,
              withdraw_tx_hash = ?,
              fee_tx_hash = ?
            WHERE telegram_id = ?
              AND id != ?
              AND (LOWER(account_type) = LOWER(?) ${isPersonal ? "OR account_type IS NULL" : ""})
              AND LOWER(vault_address) = LOWER(?)
              AND (status = 'active' OR status IS NULL)
          `).run(withdrawTxHash, feeTxHash, normTgId, positionId, accountType, vaultAddress);
        } else {
          db.prepare(`
            UPDATE yield_positions SET
              status = 'closed',
              closed_at = datetime('now'),
              payout = 0,
              dev_fee_usdc = 0,
              withdraw_tx_hash = ?,
              fee_tx_hash = ?
            WHERE telegram_id = ?
              AND id != ?
              AND LOWER(vault_address) = LOWER(?)
              AND (status = 'active' OR status IS NULL)
          `).run(withdrawTxHash, feeTxHash, normTgId, positionId, vaultAddress);
        }
      } catch (_) { }
    }
    return;
  }

  if (accountType) {
    const isPersonal = String(accountType).toLowerCase() === "personal";
    db.prepare(`
      UPDATE yield_positions SET
        status = 'closed',
        closed_at = datetime('now'),
        payout = ?,
        dev_fee_usdc = ?,
        withdraw_tx_hash = ?,
        fee_tx_hash = ?
      WHERE telegram_id = ?
        AND (LOWER(account_type) = LOWER(?) ${isPersonal ? "OR account_type IS NULL" : ""})
        AND status = 'active'
    `).run(payout, devFee, withdrawTxHash, feeTxHash, telegramId, accountType);
    return;
  }

  db.prepare(`
    UPDATE yield_positions SET
      status = 'closed',
      closed_at = datetime('now'),
      payout = ?,
      dev_fee_usdc = ?,
      withdraw_tx_hash = ?,
      fee_tx_hash = ?
    WHERE telegram_id = ? AND status = 'active'
  `).run(payout, devFee, withdrawTxHash, feeTxHash, telegramId);
}

function updateUserLastActivity(telegramId) {
  try {
    db.prepare("UPDATE users SET last_activity_at = datetime('now') WHERE telegram_id = ?").run(telegramId);
  } catch { }
}

function updateAutoEarnSetting(telegramId, enabled) {
  db.prepare("UPDATE users SET auto_earn_enabled = ? WHERE telegram_id = ?").run(enabled ? 1 : 0, telegramId);
}

function updateDepositSettlementMode(telegramId, mode) {
  const clean = String(mode || "local").trim().toLowerCase() === "usdc" ? "usdc" : "local";
  db.prepare("UPDATE users SET deposit_settlement_mode = ?, deposit_settlement_chosen = 1 WHERE telegram_id = ?").run(clean, telegramId);
  return clean;
}

function getIdleUsersForAutoEarn(idleHours = 2) {
  return db.prepare(`
    SELECT * FROM users 
    WHERE auto_earn_enabled = 1 
      AND datetime(last_activity_at) <= datetime('now', '-' || ? || ' hours')
      AND telegram_id NOT IN (
        SELECT telegram_id FROM yield_positions WHERE status = 'active'
      )
  `).all(idleHours);
}

// ─── Invoice ledger ───────────────────────────────────────────────────────────

/**
 * Generate the next invoice number for a given owner, format INV-<ownerId>-0001.
 * Scoped per-owner so each SME's numbering starts clean and reads naturally,
 * but still globally unique across all owners (invoice_number has a UNIQUE
 * constraint on the whole table, not just per-owner).
 */
function nextInvoiceNumber(ownerTelegramId) {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM invoices WHERE owner_telegram_id = ?"
  ).get(ownerTelegramId);
  const next = (row.count || 0) + 1;
  return `INV-${ownerTelegramId}-${String(next).padStart(4, "0")}`;
}

/**
 * Create a new invoice from parsed data (the output shape of
 * invoice_parser.js's parseInvoiceIntent), plus computed totals.
 * Settles to the user's business wallet address if one exists, otherwise
 * falls back to their personal deposit address.
 *
 * @param {number} ownerTelegramId
 * @param {object} parsed - { clientName, clientEmail, items, dueDate, notes, invoiceNumber? }
 * @param {object} totals - { subtotal, vatRate?, vatAmount?, whtRate?, whtAmount?, total, currency? }
 * @returns {object} the created invoice row, with items parsed back to an array
 */
function createInvoice(ownerTelegramId, parsed, totals) {
  const owner = getUser(ownerTelegramId);
  const paymentAddress = owner?.business_deposit_address || owner?.deposit_address || null;
  const invoiceNumber = parsed.invoiceNumber || nextInvoiceNumber(ownerTelegramId);

  const info = db.prepare(`
    INSERT INTO invoices (
      invoice_number, owner_telegram_id, client_name, client_email, items,
      currency, subtotal, vat_rate, vat_amount, wht_rate, wht_amount, total,
      due_date, notes, status, payment_address
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
  `).run(
    invoiceNumber,
    ownerTelegramId,
    parsed.clientName,
    parsed.clientEmail || null,
    JSON.stringify(parsed.items),
    totals.currency || "USDC",
    totals.subtotal,
    totals.vatRate ?? null,
    totals.vatAmount ?? null,
    totals.whtRate ?? null,
    totals.whtAmount ?? null,
    totals.total,
    parsed.dueDate || null,
    parsed.notes || null,
    paymentAddress
  );

  return getInvoiceById(info.lastInsertRowid);
}

function getInvoiceById(id) {
  const row = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
  return row ? { ...row, items: JSON.parse(row.items) } : null;
}

function getInvoiceByNumber(invoiceNumber) {
  const row = db.prepare("SELECT * FROM invoices WHERE invoice_number = ?").get(invoiceNumber);
  return row ? { ...row, items: JSON.parse(row.items) } : null;
}

/**
 * List invoices for an owner, optionally filtered by status.
 * @param {number} ownerTelegramId
 * @param {string|string[]|null} status - single status, array of statuses, or null for all
 */
function getInvoices(ownerTelegramId, status = null) {
  let rows;
  if (!status) {
    rows = db.prepare(
      "SELECT * FROM invoices WHERE owner_telegram_id = ? ORDER BY id DESC"
    ).all(ownerTelegramId);
  } else if (Array.isArray(status)) {
    const placeholders = status.map(() => "?").join(", ");
    rows = db.prepare(
      `SELECT * FROM invoices WHERE owner_telegram_id = ? AND status IN (${placeholders}) ORDER BY id DESC`
    ).all(ownerTelegramId, ...status);
  } else {
    rows = db.prepare(
      "SELECT * FROM invoices WHERE owner_telegram_id = ? AND status = ? ORDER BY id DESC"
    ).all(ownerTelegramId, status);
  }
  return rows.map((r) => ({ ...r, items: JSON.parse(r.items) }));
}

function updateInvoiceStatus(id, status) {
  db.prepare(
    "UPDATE invoices SET status = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, id);
}

/**
 * Mark an invoice as paid, recording the matching on-chain transaction.
 * Call this from the payment-detection matcher once an incoming USDC/EURC
 * transfer is confirmed to correspond to this invoice's total.
 */
function markInvoicePaid(id, txHash) {
  db.prepare(`
    UPDATE invoices
    SET status = 'paid', paid_tx_hash = ?, paid_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(txHash, id);
}

/**
 * Find outstanding (sent or overdue) invoices for an owner whose total
 * matches a given amount within a small tolerance. Used by the payment
 * matcher to figure out which invoice an incoming transfer corresponds to.
 *
 * @param {number} ownerTelegramId
 * @param {number} amount - the amount received, in the invoice's currency units
 * @param {number} tolerance - absolute tolerance, default 0.01
 */
function findMatchingOutstandingInvoice(ownerTelegramId, amount, tolerance = 0.01) {
  const rows = db.prepare(`
    SELECT * FROM invoices
    WHERE owner_telegram_id = ?
      AND status IN ('sent', 'overdue')
      AND ABS(total - ?) <= ?
    ORDER BY id ASC
    LIMIT 1
  `).all(ownerTelegramId, amount, tolerance);
  const row = rows[0];
  return row ? { ...row, items: JSON.parse(row.items) } : null;
}

/**
 * Sweep overdue invoices: any 'sent' invoice whose due_date has passed
 * gets flipped to 'overdue'. Call this periodically (e.g. once a day via
 * the existing scheduler) or lazily whenever invoices are queried.
 */
function sweepOverdueInvoices() {
  db.exec(`
    UPDATE invoices
    SET status = 'overdue', updated_at = datetime('now')
    WHERE status = 'sent'
      AND due_date IS NOT NULL
      AND due_date < date('now')
  `);
}

/**
 * Financial summary for an owner: total owed (sent + overdue), total paid
 * this calendar month, and total paid all-time. Powers conversational
 * queries like "how much am I owed" or "how much did I make this month".
 */
function getFinancialSummary(ownerTelegramId) {
  const owed = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS sum
    FROM invoices
    WHERE owner_telegram_id = ? AND status IN ('sent', 'overdue')
  `).get(ownerTelegramId);

  const paidThisMonth = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS sum
    FROM invoices
    WHERE owner_telegram_id = ? AND status = 'paid'
      AND strftime('%Y-%m', paid_at) = strftime('%Y-%m', 'now')
  `).get(ownerTelegramId);

  const paidAllTime = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS sum
    FROM invoices
    WHERE owner_telegram_id = ? AND status = 'paid'
  `).get(ownerTelegramId);

  const overdueList = db.prepare(`
    SELECT invoice_number, client_name, total, currency, due_date
    FROM invoices
    WHERE owner_telegram_id = ? AND status = 'overdue'
    ORDER BY due_date ASC
  `).all(ownerTelegramId);

  return {
    totalOwed: owed.sum,
    paidThisMonth: paidThisMonth.sum,
    paidAllTime: paidAllTime.sum,
    overdueInvoices: overdueList,
  };
}

function updateSolanaAddress(telegramId, solanaAddress) {
  db.prepare("UPDATE users SET solana_deposit_address = ? WHERE telegram_id = ?").run(solanaAddress, telegramId);
}

function updateBizSolanaAddress(telegramId, solanaAddress) {
  db.prepare("UPDATE users SET biz_solana_deposit_address = ? WHERE telegram_id = ?").run(solanaAddress, telegramId);
}

function updatePermanentOfframpAddress(telegramId, offrampAddress) {
  db.prepare("UPDATE users SET paj_permanent_offramp_address = ? WHERE telegram_id = ?").run(offrampAddress, telegramId);
}

function updateSystemEncryptedKey(telegramId, systemEncryptedKey) {
  db.prepare("UPDATE users SET system_encrypted_key = ? WHERE telegram_id = ?").run(systemEncryptedKey, telegramId);
}

function updateBizSystemEncryptedKey(telegramId, systemEncryptedKey) {
  db.prepare("UPDATE users SET biz_system_encrypted_key = ? WHERE telegram_id = ?").run(systemEncryptedKey, telegramId);
}

function getUserBySolanaAddress(solanaAddress) {
  if (!solanaAddress) return null;
  return db.prepare("SELECT * FROM users WHERE solana_deposit_address = ? OR biz_solana_deposit_address = ?").get(solanaAddress, solanaAddress) || null;
}

function getUserByBizSolanaAddress(solanaAddress) {
  if (!solanaAddress) return null;
  return db.prepare("SELECT * FROM users WHERE biz_solana_deposit_address = ?").get(solanaAddress) || null;
}

/**
 * Lookup a user by their EVM deposit address (checks personal or business wallet address).
 * Case-insensitive.
 *
 * @param {string} address - 0x... EVM address
 * @returns {object|null}
 */
function getUserByDepositAddress(address) {
  if (!address) return null;
  const clean = String(address).trim().toLowerCase();
  return db.prepare(`
    SELECT * FROM users 
    WHERE LOWER(deposit_address) = ? OR LOWER(business_deposit_address) = ?
  `).get(clean, clean) || null;
}

/**
 * Decrypts a user's private key using the system operational key (INVOICE_FORWARDING_SECRET)
 * for automated background cross-chain sweeps and CCTP operations without requiring interactive PIN entry.
 *
 * @param {object} user - User record from DB
 * @param {string} [accountType="personal"] - "personal" or "business"
 * @returns {string} - Decrypted hex private key
 */
function getSystemDecryptedPrivateKey(user, accountType = "personal") {
  if (!user) throw new Error("User required to decrypt system key");
  const enc = accountType === "business"
    ? user.biz_system_encrypted_key
    : user.system_encrypted_key;
  if (!enc) {
    throw new Error(`System encrypted key not configured for user ${user.telegram_id} (${accountType})`);
  }
  return walletLib.decryptSensitiveValue(enc);
}

/**
 * Platform-wide volume stats for the admin dashboard.
 * Returns totals for each major flow over today, 7d, 30d, and all-time.
 * amount_micro is stored as a BigInt-compatible string (18-decimal USDC on Arc).
 * Dynamically handles both standard 18-decimal (Arc) and 6-decimal amounts.
 */
function getVolumeStats() {
  const MICRO = 1e18; // Arc uses 18-decimal USDC natively

  const VALID_STATUSES = "('confirmed', 'submitted', 'success', 'completed')";
  const NORMALIZE_AMOUNT = "CASE WHEN decimals = 6 THEN CAST(amount_micro AS REAL) * 1e12 ELSE CAST(amount_micro AS REAL) END";

  function sumWhere(whereSql, params, since) {
    const sinceClause = since ? `AND datetime(created_at) >= datetime('now', '${since}')` : "";
    const row = db.prepare(`
      SELECT COALESCE(SUM(${NORMALIZE_AMOUNT}), 0) AS total,
             COUNT(*) AS count
      FROM transactions
      WHERE ${whereSql} AND status IN ${VALID_STATUSES}
      ${sinceClause}
    `).get(...params);
    return { count: row.count, usdc: row.total / MICRO };
  }

  function sumForTypes(types, since) {
    const placeholders = types.map(() => "?").join(", ");
    return sumWhere(`type IN (${placeholders})`, types, since);
  }

  function txBreakdown(types) {
    return {
      today: sumForTypes(types, "-1 day"),
      week: sumForTypes(types, "-7 days"),
      month: sumForTypes(types, "-30 days"),
      allTime: sumForTypes(types, null),
    };
  }

  function whereBreakdown(whereSql, params = []) {
    return {
      today: sumWhere(whereSql, params, "-1 day"),
      week: sumWhere(whereSql, params, "-7 days"),
      month: sumWhere(whereSql, params, "-30 days"),
      allTime: sumWhere(whereSql, params, null),
    };
  }

  // Product / flow breakdowns covering BOTH Mobile App and Telegram Bot across Paj, Nuvion, Airbills & On-Chain
  const onramp = txBreakdown(["deposit_naira", "onramp", "paj_onramp"]);
  const nuvionDeposits = txBreakdown(["deposit_fiat"]);
  const crypto = txBreakdown(["deposit_crosschain", "crypto_deposit", "deposit_crypto"]);
  const offramp = txBreakdown(["offramp", "offramp_request", "payout", "withdraw_naira"]);
  const globalPayouts = txBreakdown(["payout_global", "global_payout", "nuvion_payout", "payroll"]);
  const cards = txBreakdown(["card_load", "card_spend"]);
  const airbills = whereBreakdown("(type LIKE 'bill_%' OR type IN ('airbills', 'airtime', 'data', 'electricity', 'cable'))");
  const sends = txBreakdown([
    "send_usdc", "send_eurc", "autopay", "payment",
    "transfer", "p2p_send", "p2p_escrow", "scheduled_transfer",
    "crosschain_withdraw", "withdraw_crypto",
  ]);
  const savings = txBreakdown([
    "yield_deposit", "savings_deposit", "yield_withdraw",
    "auto_earn_liquidate", "auto_earn_deposit",
  ]);
  const invoices = txBreakdown(["invoice_payment", "invoice", "merchant_checkout"]);
  const swaps = txBreakdown(["swap", "swap_usdc_eurc", "swap_eurc_usdc"]);
  const stocks = txBreakdown(["stock_buy", "stock_sell"]);

  // Explicit provider breakdowns (Paj vs Nuvion vs Airbills)
  // Note: Paj always settles on Solana/Arc; Nuvion fiat deposits/sweeps settle on local_fiat or Base.
  const byProvider = {
    paj: whereBreakdown(
      "((type IN ('deposit_naira', 'onramp', 'paj_onramp', 'offramp', 'offramp_request', 'payout')) AND COALESCE(chain, '') NOT IN ('local_fiat', 'base') AND COALESCE(deposit_channel, '') != 'international')"
    ),
    nuvion: whereBreakdown(
      "(type IN ('deposit_fiat', 'deposit_crypto', 'withdraw_naira', 'payout_global', 'global_payout', 'nuvion_payout', 'card_load', 'card_spend') OR COALESCE(chain, '') = 'local_fiat' OR (type = 'deposit_naira' AND COALESCE(chain, '') = 'base'))"
    ),
    airbills,
  };

  // Explicit channel breakdown: Mobile App (app-only negative IDs + app-only tx types) vs Telegram Bot
  const byChannel = {
    mobileApp: whereBreakdown(
      "(telegram_id < 0 OR type IN ('transfer', 'p2p_send', 'p2p_escrow', 'scheduled_transfer', 'savings_deposit', 'stock_buy', 'stock_sell', 'swap'))"
    ),
    telegramBot: whereBreakdown(
      "(telegram_id > 0 AND type NOT IN ('transfer', 'p2p_send', 'p2p_escrow', 'scheduled_transfer', 'savings_deposit', 'stock_buy', 'stock_sell', 'swap'))"
    ),
  };

  // All-time & windowed totals across EVERY confirmed/completed transaction (excluding double-counted p2p_receive)
  const totalAll = whereBreakdown("type != 'p2p_receive'");
  const totalAllRow = totalAll.allTime;

  // User growth (Mobile App + Telegram Bot)
  const usersRow = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN telegram_id < 0 THEN 1 ELSE 0 END), 0) AS mobile_total,
      COALESCE(SUM(CASE WHEN telegram_id > 0 THEN 1 ELSE 0 END), 0) AS telegram_total,
      COALESCE(SUM(CASE WHEN datetime(created_at) >= datetime('now', '-1 day')  THEN 1 ELSE 0 END), 0) AS today,
      COALESCE(SUM(CASE WHEN datetime(created_at) >= datetime('now', '-7 days') THEN 1 ELSE 0 END), 0) AS week,
      COALESCE(SUM(CASE WHEN datetime(created_at) >= datetime('now', '-30 days') THEN 1 ELSE 0 END), 0) AS month
    FROM users
  `).get();

  const users = {
    total: usersRow?.total ?? 0,
    mobileTotal: usersRow?.mobile_total ?? 0,
    telegramTotal: usersRow?.telegram_total ?? 0,
    today: usersRow?.today ?? 0,
    week: usersRow?.week ?? 0,
    month: usersRow?.month ?? 0,
  };

  // Top 5 users by volume (all-time, Mobile + Telegram)
  const topUsers = db.prepare(`
    SELECT t.telegram_id,
           u.username,
           u.sender_name,
           COALESCE(SUM(${NORMALIZE_AMOUNT}), 0) AS vol,
           COUNT(*) AS tx_count
    FROM transactions t
    LEFT JOIN users u ON u.telegram_id = t.telegram_id
    WHERE t.status IN ${VALID_STATUSES} AND t.type != 'p2p_receive'
    GROUP BY t.telegram_id
    ORDER BY vol DESC LIMIT 5
  `).all().map(r => ({
    telegram_id: r.telegram_id,
    channel: Number(r.telegram_id) < 0 ? "app" : "tg",
    username: r.username ? `@${r.username}` : (r.sender_name || (Number(r.telegram_id) < 0 ? `app_${Math.abs(r.telegram_id)}` : `user_${r.telegram_id}`)),
    usdc: r.vol / MICRO,
    tx_count: r.tx_count,
  }));

  return {
    onramp,
    nuvionDeposits,
    crypto,
    offramp,
    globalPayouts,
    cards,
    airbills,
    sends,
    savings,
    invoices,
    swaps,
    stocks,
    byProvider,
    byChannel,
    totalAll: { count: totalAllRow.count, usdc: totalAllRow.usdc, today: totalAll.today, week: totalAll.week, month: totalAll.month },
    users,
    topUsers,
  };
}

/**
 * Scans the live database state across all tables and backfills/normalizes
 * any missing or mis-scaled records into the \`transactions\` ledger.
 * Safe to run multiple times (idempotent).
 */
function reconcileLiveProductVolume() {
  let fixedScale = 0;
  let backfilledInvoices = 0;
  let backfilledPayments = 0;
  let backfilledYield = 0;
  let backfilledOnramp = 0;
  let backfilledAirbills = 0;
  let backfilledPaj = 0;
  let backfilledNuvion = 0;
  let deduplicatedSweeps = 0;

  try {
    // 1. Rescale legacy 6-decimal amounts in transactions (decimals = 6)
    const lowRows = db.prepare(
      "SELECT id, amount_micro FROM transactions WHERE decimals = 6"
    ).all();
    for (const row of lowRows) {
      try {
        const scaled = (BigInt(row.amount_micro) * 1_000_000_000_000n).toString();
        db.prepare("UPDATE transactions SET amount_micro = ?, decimals = 18 WHERE id = ?").run(scaled, row.id);
        fixedScale++;
      } catch { }
    }

    // 2. Backfill paid invoices from invoices table
    const paidInvoices = db.prepare("SELECT * FROM invoices WHERE status = 'paid'").all();
    for (const inv of paidInvoices) {
      const txHash = inv.paid_tx_hash || `inv_${inv.id}_${inv.invoice_number}`;
      const existing = db.prepare("SELECT id FROM transactions WHERE tx_hash = ?").get(txHash);
      if (!existing) {
        const tgId = inv.owner_telegram_id || inv.telegram_id || 0;
        const micro = inv.expected_amount_micro
          ? BigInt(inv.expected_amount_micro)
          : BigInt(Math.round((inv.total || inv.total_usdc || 0) * 1e6)) * 1_000_000_000_000n;
        db.prepare(`
          INSERT INTO transactions (telegram_id, type, amount_micro, status, tx_hash, created_at, account_type)
          VALUES (?, 'invoice_payment', ?, 'confirmed', ?, ?, 'personal')
        `).run(tgId, micro.toString(), txHash, inv.paid_at || inv.created_at);
        backfilledInvoices++;
      }
    }

    // 3. Backfill paid invoices from biz_invoices table
    try {
      const paidBizInvoices = db.prepare("SELECT * FROM biz_invoices WHERE status = 'paid'").all();
      for (const inv of paidBizInvoices) {
        const txHash = inv.paid_tx_hash || `bizinv_${inv.id}`;
        const existing = db.prepare("SELECT id FROM transactions WHERE tx_hash = ?").get(txHash);
        if (!existing) {
          const micro = inv.expected_amount_micro
            ? BigInt(inv.expected_amount_micro)
            : BigInt(Math.round((inv.total_usdc || 0) * 1e6)) * 1_000_000_000_000n;
          db.prepare(`
            INSERT INTO transactions (telegram_id, type, amount_micro, status, tx_hash, created_at, account_type)
            VALUES (?, 'invoice_payment', ?, 'confirmed', ?, ?, 'business')
          `).run(inv.telegram_id, micro.toString(), txHash, inv.paid_at || inv.created_at);
          backfilledInvoices++;
        }
      }
    } catch { }

    // 4. Backfill completed universal_idempotency payments and offramps
    try {
      const completedPayments = db.prepare("SELECT * FROM universal_idempotency WHERE status = 'completed' AND amount > 0").all();
      for (const p of completedPayments) {
        const txHash = p.tx_hash || p.key;
        const existing = db.prepare("SELECT id FROM transactions WHERE tx_hash = ?").get(txHash);
        if (!existing) {
          const type = p.scope === "offramp" ? "offramp" : "send_usdc";
          const micro = BigInt(Math.round(p.amount * 1e6)) * 1_000_000_000_000n;
          db.prepare(`
            INSERT INTO transactions (telegram_id, type, amount_micro, status, tx_hash, created_at, account_type)
            VALUES (?, ?, ?, 'confirmed', ?, ?, ?)
          `).run(p.telegram_id || 0, type, micro.toString(), txHash, p.completed_at || p.created_at, p.account_type || "personal");
          backfilledPayments++;
        }
      }
    } catch { }

    // 5. Backfill savings positions from yield_positions
    try {
      const yieldRows = db.prepare("SELECT * FROM yield_positions WHERE amount_usdc > 0").all();
      for (const yp of yieldRows) {
        const txHash = yp.deposit_tx_hash || `yield_pos_${yp.id}`;
        const existing = db.prepare("SELECT id FROM transactions WHERE tx_hash = ?").get(txHash);
        if (!existing) {
          const micro = BigInt(Math.round(yp.amount_usdc * 1e6)) * 1_000_000_000_000n;
          db.prepare(`
            INSERT INTO transactions (telegram_id, type, amount_micro, status, tx_hash, created_at, account_type)
            VALUES (?, 'yield_deposit', ?, 'confirmed', ?, ?, ?)
          `).run(yp.telegram_id || 0, micro.toString(), txHash, yp.opened_at, yp.account_type || "personal");
          backfilledYield++;
        }
      }
    } catch { }

    // 6. Backfill onramp events from processed_webhook_events if not already recorded
    try {
      const onrampEvents = db.prepare("SELECT * FROM processed_webhook_events WHERE event_type = 'onramp.successful'").all();
      for (const ev of onrampEvents) {
        const existing = db.prepare("SELECT id FROM transactions WHERE tx_hash = ?").get(ev.event_id);
        if (!existing) {
          const inv = db.prepare("SELECT * FROM invoices WHERE fiat_order_id = ?").get(ev.event_id);
          let tgId = 0;
          let usdcAmount = 0;
          if (inv) {
            tgId = inv.owner_telegram_id || inv.telegram_id || 0;
            usdcAmount = inv.total || inv.total_usdc || 0;
          } else {
            const match = ev.event_id.match(/_(\d{6,12})_/);
            if (match) {
              const parsed = parseInt(match[1]);
              const u = db.prepare("SELECT telegram_id FROM users WHERE telegram_id = ?").get(parsed);
              if (u) tgId = parsed;
            }
          }
          if (usdcAmount > 0) {
            const micro = BigInt(Math.round(usdcAmount * 1e6)) * 1_000_000_000_000n;
            db.prepare(`
              INSERT INTO transactions (telegram_id, type, amount_micro, status, tx_hash, created_at, account_type)
              VALUES (?, 'deposit_naira', ?, 'confirmed', ?, ?, 'personal')
            `).run(tgId, micro.toString(), ev.event_id, ev.processed_at);
            backfilledOnramp++;
          }
        }
      }
    } catch { }

    // 7. Backfill completed Airbills payments from bill_payments table
    try {
      const bills = db.prepare("SELECT * FROM bill_payments WHERE LOWER(status) IN ('successful', 'completed', 'confirmed', 'success') AND amount_usdc > 0").all();
      for (const b of bills) {
        const txHash = b.solana_tx_sig || b.arc_tx_hash || b.airbills_tx_id || `airbills_${b.id}`;
        const existing = db.prepare("SELECT id FROM transactions WHERE tx_hash = ?").get(txHash);
        if (!existing) {
          const micro = BigInt(Math.round(Number(b.amount_usdc) * 1e6)) * 1_000_000_000_000n;
          db.prepare(`
            INSERT INTO transactions (telegram_id, type, amount_micro, status, tx_hash, created_at, account_type, chain, narration)
            VALUES (?, ?, ?, 'confirmed', ?, ?, ?, 'solana', ?)
          `).run(
            b.telegram_id || 0,
            `bill_${String(b.category || "airtime").toLowerCase()}`,
            micro.toString(),
            txHash,
            b.created_at,
            b.account_type || "personal",
            `${b.provider_name || b.category || "Bill"} ₦${Math.round(Number(b.amount_ngn || 0)).toLocaleString()}`
          );
          backfilledAirbills++;
        }
      }
    } catch { }

    // 8. Backfill completed Paj paj_onramp_orders and paj_offramp_orders missing from transactions
    try {
      const pajOn = db.prepare("SELECT * FROM paj_onramp_orders WHERE LOWER(status) IN ('completed', 'confirmed', 'success', 'successful', 'settled') AND amount_usdc > 0").all();
      for (const o of pajOn) {
        const txHash = o.tx_hash || o.order_id;
        const existing = db.prepare("SELECT id FROM transactions WHERE tx_hash = ? OR tx_hash = ?").get(txHash, o.order_id);
        if (!existing) {
          const micro = BigInt(Math.round(Number(o.amount_usdc) * 1e6)) * 1_000_000_000_000n;
          db.prepare(`
            INSERT INTO transactions (telegram_id, type, amount_micro, status, tx_hash, created_at, account_type, chain, source_currency, source_amount, deposit_channel)
            VALUES (?, 'deposit_naira', ?, 'confirmed', ?, ?, ?, ?, 'NGN', ?, 'naira')
          `).run(o.telegram_id || 0, micro.toString(), txHash, o.completed_at || o.created_at, o.account_type || "personal", o.settlement_rail || "solana", o.fiat_amount || null);
          backfilledPaj++;
        }
      }
    } catch { }

    try {
      const pajOff = db.prepare("SELECT * FROM paj_offramp_orders WHERE LOWER(status) IN ('completed', 'confirmed', 'success', 'successful', 'submitted', 'paid', 'settled') AND amount_usdc > 0").all();
      for (const o of pajOff) {
        const txHash = o.tx_hash || o.order_id;
        const existing = db.prepare("SELECT id FROM transactions WHERE tx_hash = ? OR tx_hash = ?").get(txHash, o.order_id);
        if (!existing) {
          const micro = BigInt(Math.round(Number(o.amount_usdc) * 1e6)) * 1_000_000_000_000n;
          db.prepare(`
            INSERT INTO transactions (telegram_id, type, amount_micro, status, tx_hash, created_at, account_type, chain, narration)
            VALUES (?, 'offramp', ?, 'confirmed', ?, ?, ?, ?, ?)
          `).run(o.telegram_id || 0, micro.toString(), txHash, o.completed_at || o.created_at, o.account_type || "personal", o.rail || "arc", o.narration || null);
          backfilledPaj++;
        }
      }
    } catch { }

    // 9. Backfill completed Nuvion jobs (inbound fiat hold/sweep & outbound payouts) missing from transactions
    try {
      const nJobs = db.prepare("SELECT * FROM nuvion_jobs WHERE job_type IN ('inbound_fiat_hold', 'inbound_fiat_sweep', 'outbound_fiat_payout') AND state IN ('completed', 'dispatched')").all();
      for (const j of nJobs) {
        const txHash = j.nuvion_transfer_id || j.unique_reference;
        if (!txHash) continue;
        const existing = db.prepare("SELECT id FROM transactions WHERE tx_hash = ?").get(txHash);
        if (!existing) {
          let payload = {};
          try { payload = j.payload_json ? JSON.parse(j.payload_json) : {}; } catch { }
          let estUsd = Number(payload.userTotalUsd || payload.creditedUsd || 0);
          const cur = String(j.currency || "USD").toUpperCase();
          if (estUsd <= 0) {
            const major = Number(j.amount_minor || 0) / 100;
            estUsd = cur === "NGN" ? major / 1500 : major;
          }
          if (estUsd > 0) {
            const micro = BigInt(Math.round(estUsd * 1e6)) * 1_000_000_000_000n;
            const txType = j.job_type === "outbound_fiat_payout"
              ? (cur === "NGN" ? "withdraw_naira" : "payout_global")
              : (cur === "NGN" ? "deposit_naira" : "deposit_fiat");
            const chain = j.job_type === "inbound_fiat_hold" || payload.fundingMode === "held_fiat" ? "local_fiat" : "base";
            db.prepare(`
              INSERT INTO transactions (telegram_id, type, amount_micro, status, tx_hash, created_at, account_type, chain)
              VALUES (?, ?, ?, 'confirmed', ?, ?, ?, ?)
            `).run(j.telegram_id || 0, txType, micro.toString(), txHash, j.created_at, j.account_type || "personal", chain);
            backfilledNuvion++;
          }
        }
      }
    } catch { }

    // 10. Deduplicate repeating synthetic sweep deposits created by background monitor loops
    try {
      const dupes = db.prepare(`
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY telegram_id, type, amount_micro, DATE(created_at)
            ORDER BY id ASC
          ) as rn
          FROM transactions
          WHERE (tx_hash LIKE 'sweep_%' OR tx_hash LIKE '0xrelay_%') AND type = 'deposit_crosschain'
        )
        WHERE rn > 1
      `).all();
      for (const d of dupes) {
        db.prepare("DELETE FROM transactions WHERE id = ?").run(d.id);
        deduplicatedSweeps++;
      }
    } catch (dupeErr) {
      console.warn("[db:reconcileLiveProductVolume] Deduplication note:", dupeErr.message);
    }
  } catch (scanErr) {
    console.warn("[db:reconcileLiveProductVolume] Error during live scan:", scanErr.message);
  }

  return {
    fixedScale,
    backfilledInvoices,
    backfilledPayments,
    backfilledYield,
    backfilledOnramp,
    backfilledAirbills,
    backfilledPaj,
    backfilledNuvion,
    deduplicatedSweeps,
  };
}

// ─── CCTP Pending Burns ────────────────────────────────────────────────────────

/**
 * Record an Arc→Solana CCTP burn that has been submitted on Arc but not yet
 * finalised on Solana.  Allows recovery if the Solana fee-payer has no SOL.
 */
function recordCctpPendingBurn({ telegramId, arcTxHash, messageHex, messageHash, amountUsdc, recipientSolana }) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO cctp_pending_burns
        (telegram_id, arc_tx_hash, message_hex, message_hash, amount_usdc, recipient_solana, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).run(telegramId || 0, arcTxHash, messageHex || null, messageHash || null, amountUsdc, recipientSolana);
  } catch (err) {
    console.warn("[db:cctp_pending] recordCctpPendingBurn error:", err.message);
  }
}

/**
 * Mark a pending CCTP burn as successfully completed on Solana.
 */
function completeCctpPendingBurn(arcTxHash, solanaTxSig) {
  try {
    db.prepare(`
      UPDATE cctp_pending_burns
      SET status = 'completed', solana_tx_sig = ?, completed_at = datetime('now')
      WHERE arc_tx_hash = ?
    `).run(solanaTxSig, arcTxHash);
  } catch (err) {
    console.warn("[db:cctp_pending] completeCctpPendingBurn error:", err.message);
  }
}

/**
 * Mark a pending CCTP burn as failed with an error message and increment retry count.
 */
function failCctpPendingBurn(arcTxHash, errorMsg) {
  try {
    db.prepare(`
      UPDATE cctp_pending_burns
      SET status = 'failed', error = ?, retry_count = retry_count + 1
      WHERE arc_tx_hash = ?
    `).run(errorMsg, arcTxHash);
  } catch (err) {
    console.warn("[db:cctp_pending] failCctpPendingBurn error:", err.message);
  }
}

/**
 * Retrieve all pending CCTP burns that need to be retried.
 * Returns burns with status = 'pending' or 'failed' (up to 3 previous retries).
 */
function getPendingCctpBurns() {
  try {
    return db.prepare(`
      SELECT * FROM cctp_pending_burns
      WHERE status IN ('pending', 'failed') AND retry_count < 10
      ORDER BY created_at ASC
    `).all();
  } catch (err) {
    console.warn("[db:cctp_pending] getPendingCctpBurns error:", err.message);
    return [];
  }
}

/**
 * Get the count of outstanding (un-completed) pending CCTP burns.
 */
function countPendingCctpBurns() {
  try {
    const row = db.prepare(`SELECT COUNT(*) as c FROM cctp_pending_burns WHERE status IN ('pending','failed') AND retry_count < 10`).get();
    return row?.c || 0;
  } catch {
    return 0;
  }
}

/**
 * Record a newly initiated Paj fiat onramp order.
 */
function recordOnrampOrder({
  orderId,
  telegramId,
  accountType = "personal",
  fiatAmount,
  amountNgn,
  amountUsdc,
  rate,
  recipientAddress = null,
  virtualAccount = null,
  settlementRail = "arc",
  narration = null,
}) {
  try {
    const effectiveFiat = fiatAmount !== undefined ? Number(fiatAmount) : (amountNgn !== undefined ? Number(amountNgn) : 0);
    const effectiveRecipient = recipientAddress || virtualAccount || "0x0000000000000000000000000000000000000000";
    db.prepare(`
      INSERT OR REPLACE INTO paj_onramp_orders
        (order_id, telegram_id, account_type, fiat_amount, amount_usdc, rate, recipient_address, settlement_rail, status, narration)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      orderId,
      telegramId,
      accountType || "personal",
      effectiveFiat,
      amountUsdc ? Number(amountUsdc) : null,
      rate ? Number(rate) : null,
      effectiveRecipient,
      settlementRail || "arc",
      narration || null
    );
  } catch (err) {
    console.warn("[db:onramp_order] recordOnrampOrder error:", err.message);
  }
}

function getOnrampOrderByOrderId(orderId) {
  if (!orderId) return null;
  try {
    return db.prepare("SELECT * FROM paj_onramp_orders WHERE order_id = ?").get(orderId) || null;
  } catch (err) {
    console.warn("[db:onramp_order] getOnrampOrderByOrderId error:", err.message);
    return null;
  }
}

function getPendingOnrampOrders() {
  try {
    return db.prepare(`
      SELECT * FROM paj_onramp_orders
      WHERE status = 'pending' AND created_at >= datetime('now', '-6 hours')
      ORDER BY id DESC
    `).all() || [];
  } catch (err) {
    console.warn("[db:onramp_order] getPendingOnrampOrders error:", err.message);
    return [];
  }
}

function completeOnrampOrder(orderId, txHashOrOpts = {}, maybeStatusOrNarration = "completed") {
  let txHash = null;
  let amountUsdc = null;
  let status = "completed";
  let narration = null;

  if (typeof txHashOrOpts === "string") {
    txHash = txHashOrOpts;
    if (typeof maybeStatusOrNarration === "string") {
      if (maybeStatusOrNarration === "completed" || maybeStatusOrNarration === "failed" || maybeStatusOrNarration === "pending") {
        status = maybeStatusOrNarration;
      } else {
        narration = maybeStatusOrNarration;
      }
    }
  } else if (txHashOrOpts && typeof txHashOrOpts === "object") {
    txHash = txHashOrOpts.txHash || null;
    amountUsdc = txHashOrOpts.amountUsdc || null;
    if (txHashOrOpts.status) status = txHashOrOpts.status;
    if (txHashOrOpts.narration) narration = txHashOrOpts.narration;
  }

  try {
    db.prepare(`
      UPDATE paj_onramp_orders
      SET status = ?,
          tx_hash = COALESCE(?, tx_hash),
          amount_usdc = COALESCE(?, amount_usdc),
          narration = COALESCE(?, narration),
          completed_at = datetime('now')
      WHERE order_id = ?
    `).run(status, txHash || null, amountUsdc ? Number(amountUsdc) : null, narration || null, orderId);
  } catch (err) {
    console.warn("[db:onramp_order] completeOnrampOrder error:", err.message);
  }
}

/**
 * Record a newly initiated Paj fiat offramp order with clean NUBAN bank details.
 */
function recordOfframpOrder({
  orderId,
  telegramId,
  accountType = "personal",
  accountNumber,
  bankCode = null,
  bankName = null,
  accountName = null,
  amountUsdc,
  feeUsdc = 0,
  netAmountUsdc = null,
  fiatAmount = null,
  rate = null,
  rail = "solana",
  txHash = null,
  feeTxHash = null,
  narration = null,
  senderName = null,
  status = "pending",
}) {
  try {
    const cleanAccountNum = String(accountNumber || "").trim();
    const effectiveNet = netAmountUsdc != null ? Number(netAmountUsdc) : Number(Number(amountUsdc).toFixed(4));
    db.prepare(`
      INSERT OR REPLACE INTO paj_offramp_orders
        (order_id, telegram_id, account_type, account_number, bank_code, bank_name, account_name,
         amount_usdc, fee_usdc, net_amount_usdc, fiat_amount, rate, rail, status, tx_hash, fee_tx_hash, narration, sender_name, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      orderId,
      telegramId,
      accountType,
      cleanAccountNum,
      bankCode,
      bankName,
      accountName,
      Number(amountUsdc),
      Number(feeUsdc || 0),
      effectiveNet,
      fiatAmount ? Number(fiatAmount) : null,
      rate ? Number(rate) : null,
      rail,
      status,
      txHash,
      feeTxHash,
      narration || null,
      senderName || null
    );
  } catch (err) {
    console.warn("[db:offramp_order] recordOfframpOrder error:", err.message);
  }
}

function getOfframpOrderByOrderId(orderId) {
  if (!orderId) return null;
  try {
    return db.prepare("SELECT * FROM paj_offramp_orders WHERE order_id = ? OR tx_hash = ?").get(orderId, orderId) || null;
  } catch (err) {
    console.warn("[db:offramp_order] getOfframpOrderByOrderId error:", err.message);
    return null;
  }
}

function getPendingOfframpOrders() {
  try {
    return db.prepare(`
      SELECT * FROM paj_offramp_orders
      WHERE status IN ('pending', 'submitted') AND created_at >= datetime('now', '-6 hours')
      ORDER BY id DESC
    `).all() || [];
  } catch (err) {
    console.warn("[db:offramp_order] getPendingOfframpOrders error:", err.message);
    return [];
  }
}

function completeOfframpOrder(orderId, txHashOrOpts = {}, maybeStatus = "completed") {
  let txHash = null;
  let status = maybeStatus || "completed";

  if (typeof txHashOrOpts === "string") {
    txHash = txHashOrOpts;
  } else if (txHashOrOpts && typeof txHashOrOpts === "object") {
    txHash = txHashOrOpts.txHash || null;
    if (txHashOrOpts.status) status = txHashOrOpts.status;
  }

  try {
    db.prepare(`
      UPDATE paj_offramp_orders
      SET status = ?,
          tx_hash = COALESCE(?, tx_hash),
          completed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE order_id = ?
    `).run(status, txHash || null, orderId);
  } catch (err) {
    console.warn("[db:offramp_order] completeOfframpOrder error:", err.message);
  }
}

/**
 * Record a newly initiated cross-chain withdrawal (CCTP or Intent routing).
 */
// The NEAR Intents asset a withdrawal delivers (e.g. "nep141:..."), so the background
// sweeper sends the same token the user picked. Null means the chain's default token.
let _ccAssetColumnReady = false;
function ensureCrosschainAssetColumn() {
  if (_ccAssetColumnReady) return;
  const cols = db.prepare("PRAGMA table_info(crosschain_pending_withdrawals)").all().map((c) => c.name);
  if (!cols.includes("destination_asset")) db.exec("ALTER TABLE crosschain_pending_withdrawals ADD COLUMN destination_asset TEXT");
  _ccAssetColumnReady = true;
}

function recordCrosschainWithdrawal({
  telegramId,
  arcTxHash,
  destinationChain,
  destinationAddress,
  amountUsdc,
  status = "attesting",
  engine = "CCTP",
  encryptedPrivateKey = null,
  accountType = "personal",
  messageHex = null,
  messageHash = null,
  destinationAsset = null,
}) {
  try {
    ensureCrosschainAssetColumn();
    db.prepare(`
      INSERT OR REPLACE INTO crosschain_pending_withdrawals
        (telegram_id, arc_tx_hash, destination_chain, destination_address, amount_usdc, status, engine, encrypted_private_key, account_type, message_hex, message_hash, destination_asset, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      telegramId,
      arcTxHash,
      destinationChain,
      destinationAddress,
      Number(amountUsdc),
      status,
      engine,
      encryptedPrivateKey,
      accountType,
      messageHex,
      messageHash,
      destinationAsset || null
    );
    return db.prepare("SELECT * FROM crosschain_pending_withdrawals WHERE arc_tx_hash = ?").get(arcTxHash);
  } catch (err) {
    console.warn("[db:crosschain_withdrawal] recordCrosschainWithdrawal error:", err.message);
    return null;
  }
}

function getPendingCrosschainWithdrawals() {
  try {
    return db.prepare(`
      SELECT * FROM crosschain_pending_withdrawals
      WHERE status NOT IN ('completed', 'failed')
        AND created_at >= datetime('now', '-24 hours')
      ORDER BY id ASC
    `).all() || [];
  } catch (err) {
    console.warn("[db:crosschain_withdrawal] getPendingCrosschainWithdrawals error:", err.message);
    return [];
  }
}

function getCrosschainWithdrawalByArcTx(arcTxHash) {
  if (!arcTxHash) return null;
  try {
    return db.prepare("SELECT * FROM crosschain_pending_withdrawals WHERE arc_tx_hash = ?").get(arcTxHash) || null;
  } catch (err) {
    console.warn("[db:crosschain_withdrawal] getCrosschainWithdrawalByArcTx error:", err.message);
    return null;
  }
}

function updateCrosschainWithdrawal(idOrArcTx, fields = {}) {
  try {
    const isId = typeof idOrArcTx === "number" || /^\d+$/.test(idOrArcTx);
    const whereCol = isId ? "id" : "arc_tx_hash";
    const sets = ["updated_at = datetime('now')"];
    const values = [];

    for (const [key, val] of Object.entries(fields)) {
      sets.push(`${key} = ?`);
      values.push(val);
    }
    values.push(idOrArcTx);

    db.prepare(`UPDATE crosschain_pending_withdrawals SET ${sets.join(", ")} WHERE ${whereCol} = ?`).run(...values);
  } catch (err) {
    console.warn("[db:crosschain_withdrawal] updateCrosschainWithdrawal error:", err.message);
  }
}

function completeCrosschainWithdrawal(idOrArcTx, { destinationTxHash, deliveredAmount } = {}) {
  try {
    const isId = typeof idOrArcTx === "number" || /^\d+$/.test(idOrArcTx);
    const whereCol = isId ? "id" : "arc_tx_hash";
    db.prepare(`
      UPDATE crosschain_pending_withdrawals
      SET status = 'completed',
          destination_tx_hash = COALESCE(?, destination_tx_hash),
          delivered_amount = COALESCE(?, delivered_amount),
          encrypted_private_key = NULL,
          completed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE ${whereCol} = ?
    `).run(destinationTxHash || null, deliveredAmount || null, idOrArcTx);
  } catch (err) {
    console.warn("[db:crosschain_withdrawal] completeCrosschainWithdrawal error:", err.message);
  }
}

function failCrosschainWithdrawal(idOrArcTx, error) {
  try {
    const isId = typeof idOrArcTx === "number" || /^\d+$/.test(idOrArcTx);
    const whereCol = isId ? "id" : "arc_tx_hash";
    db.prepare(`
      UPDATE crosschain_pending_withdrawals
      SET status = 'failed',
          error = ?,
          updated_at = datetime('now')
      WHERE ${whereCol} = ?
    `).run(String(error).slice(0, 500), idOrArcTx);
  } catch (err) {
    console.warn("[db:crosschain_withdrawal] failCrosschainWithdrawal error:", err.message);
  }
}

/**
 * Record an incoming Solana→Arc CCTP transfer before or immediately after burn.
 */
function recordInboundCctpTransfer({ telegramId, solanaAddress, arcAddress, amountUsdc, solanaBurnSig, status = "initiated" }) {
  try {
    if (solanaBurnSig) {
      const existing = db.prepare(`SELECT id FROM cctp_inbound_transfers WHERE solana_burn_sig = ?`).get(solanaBurnSig);
      if (existing) {
        return existing.id;
      }
    }
    const info = db.prepare(`
      INSERT INTO cctp_inbound_transfers (telegram_id, solana_address, arc_address, amount_usdc, solana_burn_sig, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(telegramId || 0, solanaAddress || '', arcAddress, amountUsdc, solanaBurnSig || null, status);
    return info.lastInsertRowid;
  } catch (err) {
    console.warn("[db:cctp_inbound] recordInboundCctpTransfer error:", err.message);
    return null;
  }
}

/**
 * Update an inbound CCTP transfer record by ID or burn signature.
 */
function updateInboundCctpTransfer(idOrSig, updates = {}) {
  try {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(updates)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    const isNum = typeof idOrSig === "number" || /^\d+$/.test(String(idOrSig));
    const where = isNum ? "id = ?" : "solana_burn_sig = ?";
    vals.push(idOrSig);
    db.prepare(`UPDATE cctp_inbound_transfers SET ${sets.join(", ")} WHERE ${where}`).run(...vals);
  } catch (err) {
    console.warn("[db:cctp_inbound] updateInboundCctpTransfer error:", err.message);
  }
}

/**
 * Mark an inbound CCTP transfer complete once minted on Arc.
 */
function completeInboundCctpTransfer(idOrSig, arcTxHash) {
  try {
    const isNum = typeof idOrSig === "number" || /^\d+$/.test(String(idOrSig));
    const where = isNum ? "id = ?" : "solana_burn_sig = ?";
    db.prepare(`
      UPDATE cctp_inbound_transfers
      SET status = 'completed', arc_tx_hash = ?, completed_at = datetime('now')
      WHERE ${where}
    `).run(arcTxHash, idOrSig);
  } catch (err) {
    console.warn("[db:cctp_inbound] completeInboundCctpTransfer error:", err.message);
  }
}

/**
 * Retrieve pending inbound CCTP transfers that need Iris polling or Arc redemption.
 */
function getPendingInboundCctpTransfers() {
  try {
    return db.prepare(`
      SELECT * FROM cctp_inbound_transfers
      WHERE status IN ('initiated', 'burned', 'attested', 'pending_retry') AND retry_count < 30
      ORDER BY created_at ASC
    `).all();
  } catch (err) {
    console.warn("[db:cctp_inbound] getPendingInboundCctpTransfers error:", err.message);
    return [];
  }
}

/**
 * Retrieve a user's most recent Arc→Solana CCTP burns (any status), newest
 * first, for the "Move Funds" status screen.
 */
function getRecentCctpBurnsByUser(telegramId, limit = 5) {
  try {
    return db.prepare(`
      SELECT * FROM cctp_pending_burns
      WHERE telegram_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(telegramId, limit);
  } catch (err) {
    console.warn("[db:cctp_pending] getRecentCctpBurnsByUser error:", err.message);
    return [];
  }
}

/**
 * Retrieve a user's most recent Solana→Arc inbound CCTP transfers (any
 * status), newest first, for the "Move Funds" status screen.
 */
function getRecentInboundByUser(telegramId, limit = 5) {
  try {
    return db.prepare(`
      SELECT * FROM cctp_inbound_transfers
      WHERE telegram_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(telegramId, limit);
  } catch (err) {
    console.warn("[db:cctp_inbound] getRecentInboundByUser error:", err.message);
    return [];
  }
}

// ─── NEAR Intents (1Click) deposits ────────────────────────────────────────────

function ensureNearDepositsSchema() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS near_deposits (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id        INTEGER NOT NULL,
        account_type       TEXT NOT NULL DEFAULT 'personal',
        origin_asset       TEXT NOT NULL,
        amount_usdc        REAL NOT NULL,
        amount_out         REAL,
        recipient_address  TEXT NOT NULL,
        refund_to          TEXT NOT NULL,
        deposit_address    TEXT,
        deposit_memo       TEXT,
        correlation_id     TEXT,
        deadline           TEXT,
        quote_json         TEXT,
        status             TEXT NOT NULL DEFAULT 'quoting',
        error              TEXT,
        retry_count        INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const cols = db.prepare("PRAGMA table_info(near_deposits)").all().map((r) => r.name);
    if (!cols.includes("quote_json")) db.exec("ALTER TABLE near_deposits ADD COLUMN quote_json TEXT");
    if (!cols.includes("retry_count")) db.exec("ALTER TABLE near_deposits ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
    if (!cols.includes("origin_symbol")) db.exec("ALTER TABLE near_deposits ADD COLUMN origin_symbol TEXT");
    if (!cols.includes("amount_token")) db.exec("ALTER TABLE near_deposits ADD COLUMN amount_token REAL");
  } catch (err) {
    console.warn("[db] ensureNearDepositsSchema note:", err.message);
  }
}

function createNearDeposit({
  telegramId,
  accountType = "personal",
  originAsset,
  originSymbol = null,
  amountToken = null,
  amountUsdc,
  recipientAddress,
  refundTo,
  status = "quoting",
}) {
  const finalSymbol = originSymbol || (originAsset?.includes("usdc") ? "USDC" : "TOKEN");
  const finalAmountUsdc = amountUsdc !== undefined && amountUsdc !== null ? Number(amountUsdc) : (amountToken !== null ? Number(amountToken) : 0);
  const finalAmountToken = amountToken !== undefined && amountToken !== null ? Number(amountToken) : finalAmountUsdc;

  const cols = db.prepare("PRAGMA table_info(near_deposits)").all().map((r) => r.name);
  let result;
  if (cols.includes("origin_symbol") && cols.includes("amount_token")) {
    result = db.prepare(
      `INSERT INTO near_deposits (telegram_id, account_type, origin_asset, origin_symbol, amount_token, amount_usdc, recipient_address, refund_to, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(telegramId, accountType, originAsset, finalSymbol, finalAmountToken, finalAmountUsdc, recipientAddress, refundTo, status);
  } else {
    result = db.prepare(
      `INSERT INTO near_deposits (telegram_id, account_type, origin_asset, amount_usdc, recipient_address, refund_to, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(telegramId, accountType, originAsset, finalAmountUsdc, recipientAddress, refundTo, status);
  }
  return Number(result.lastInsertRowid);
}

function updateNearDeposit(id, fields) {
  const allowed = [
    "status",
    "deposit_address",
    "deposit_memo",
    "amount_out",
    "quote_json",
    "deadline",
    "correlation_id",
    "error",
    "retry_count",
    "origin_symbol",
    "amount_token",
  ];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(typeof v === "object" && v !== null ? JSON.stringify(v) : v);
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE near_deposits SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

function getNearDepositById(id) {
  return db.prepare("SELECT * FROM near_deposits WHERE id = ?").get(id) || null;
}

function getActiveNearDeposits() {
  return db.prepare(
    `SELECT * FROM near_deposits
     WHERE status NOT IN ('SUCCESS', 'REFUNDED', 'FAILED', 'expired')
       AND created_at >= datetime('now', '-24 hours')
     ORDER BY id ASC`
  ).all();
}

function getStaleNearDeposits() {
  return db.prepare(
    `SELECT * FROM near_deposits
     WHERE status = 'awaiting_deposit' AND deadline IS NOT NULL AND deadline < datetime('now')`
  ).all();
}

// ─── Settlement daemon ledger ────────────────────────────────────────────────

function ensureSettlementRunsSchema() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settlement_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'running',
        error       TEXT,
        result      TEXT,
        started_at  TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      )
    `);
  } catch (err) {
    console.warn("[db:settlement_runs] ensureSettlementRunsSchema note:", err.message);
  }
}

/**
 * Claim a ledger row for a task run. Returns the run id, or null when another
 * run of the same task is still marked 'running' (e.g. left by a crash — the
 * daemon interrupts stale rows at startup before claiming new ones).
 */
function beginSettlementRun(task) {
  try {
    const existing = db.prepare(
      "SELECT id FROM settlement_runs WHERE task = ? AND status = 'running' ORDER BY id DESC LIMIT 1"
    ).get(task);
    if (existing) return null;
    const info = db.prepare(
      "INSERT INTO settlement_runs (task, status) VALUES (?, 'running')"
    ).run(task);
    return Number(info.lastInsertRowid);
  } catch (err) {
    console.warn("[db:settlement_runs] beginSettlementRun error:", err.message);
    return null;
  }
}

function finishSettlementRun(id, { status = "succeeded", error = null, result = null } = {}) {
  try {
    if (!id) return;
    const resultStr = result ? JSON.stringify(result).slice(0, 4000) : null;
    db.prepare(
      "UPDATE settlement_runs SET status = ?, error = ?, result = ?, finished_at = datetime('now') WHERE id = ?"
    ).run(status, error, resultStr, id);
  } catch (err) {
    console.warn("[db:settlement_runs] finishSettlementRun error:", err.message);
  }
}

/**
 * Mark 'running' rows older than maxAgeMinutes as interrupted (crash recovery).
 */
function interruptStaleSettlementRuns(maxAgeMinutes = 15) {
  try {
    const info = db.prepare(
      "UPDATE settlement_runs SET status = 'interrupted', finished_at = datetime('now') WHERE status = 'running' AND started_at < datetime('now', ?)"
    ).run(`-${Number(maxAgeMinutes) || 15} minutes`);
    return info.changes || 0;
  } catch (err) {
    console.warn("[db:settlement_runs] interruptStaleSettlementRuns error:", err.message);
    return 0;
  }
}

function getRecentSettlementRuns(task = null, limit = 20) {
  try {
    if (task) {
      return db.prepare("SELECT * FROM settlement_runs WHERE task = ? ORDER BY id DESC LIMIT ?").all(task, limit);
    }
    return db.prepare("SELECT * FROM settlement_runs ORDER BY id DESC LIMIT ?").all(limit);
  } catch (err) {
    console.warn("[db:settlement_runs] getRecentSettlementRuns error:", err.message);
    return [];
  }
}

/**
 * Keep the most recent `keep` finished rows (running rows are never pruned).
 */
function pruneSettlementRuns(keep = 500) {
  try {
    db.prepare(`
      DELETE FROM settlement_runs
      WHERE id NOT IN (SELECT id FROM settlement_runs WHERE status = 'running')
        AND id <= (SELECT COALESCE(MAX(id), 0) FROM settlement_runs) - ?
    `).run(Number(keep) || 500);
  } catch (err) {
    console.warn("[db:settlement_runs] pruneSettlementRuns error:", err.message);
  }
}

// ─── Builder API Keys ────────────────────────────────────────────────────────

function ensureApiKeysSchema() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id             TEXT UNIQUE NOT NULL,
        key_hash           TEXT NOT NULL,
        key_prefix         TEXT NOT NULL,
        telegram_id        INTEGER NOT NULL DEFAULT 0,
        app_name           TEXT NOT NULL,
        allowed_features   TEXT NOT NULL DEFAULT '["all"]',
        rate_limit_per_min INTEGER NOT NULL DEFAULT 120,
        webhook_url        TEXT,
        is_active          INTEGER NOT NULL DEFAULT 1,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
      CREATE INDEX IF NOT EXISTS idx_api_keys_telegram ON api_keys(telegram_id);
      CREATE TABLE IF NOT EXISTS api_key_wallets (
        key_id      TEXT NOT NULL,
        telegram_id INTEGER NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (key_id, telegram_id)
      );
      CREATE INDEX IF NOT EXISTS idx_api_key_wallets_tg ON api_key_wallets(telegram_id);
    `);
  } catch (err) {
    console.warn("[db] ensureApiKeysSchema note:", err.message);
  }
}

try {
  ensureApiKeysSchema();
} catch (_) { }

function createApiKey({
  keyId,
  keyHash,
  keyPrefix,
  telegramId = 0,
  appName,
  allowedFeatures = ["all"],
  rateLimitPerMin = 120,
  webhookUrl = null,
}) {
  ensureApiKeysSchema();
  const featJson = typeof allowedFeatures === "string" ? allowedFeatures : JSON.stringify(allowedFeatures);
  db.prepare(`
    INSERT INTO api_keys (key_id, key_hash, key_prefix, telegram_id, app_name, allowed_features, rate_limit_per_min, webhook_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(keyId, keyHash, keyPrefix, telegramId, appName, featJson, rateLimitPerMin, webhookUrl);
  return getApiKeyById(keyId);
}

function getApiKeyByHash(keyHash) {
  ensureApiKeysSchema();
  const row = db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(keyHash);
  if (!row) return null;
  return {
    ...row,
    allowed_features: JSON.parse(row.allowed_features || '["all"]'),
  };
}

function getApiKeyById(keyId) {
  ensureApiKeysSchema();
  const row = db.prepare("SELECT * FROM api_keys WHERE key_id = ?").get(keyId);
  if (!row) return null;
  return {
    ...row,
    allowed_features: JSON.parse(row.allowed_features || '["all"]'),
  };
}

function getApiKeysByTelegramId(telegramId) {
  ensureApiKeysSchema();
  const rows = db.prepare("SELECT * FROM api_keys WHERE telegram_id = ? ORDER BY id DESC").all(telegramId);
  return rows.map((r) => ({
    ...r,
    allowed_features: JSON.parse(r.allowed_features || '["all"]'),
  }));
}

function updateApiKey(keyId, fields = {}) {
  ensureApiKeysSchema();
  const allowed = ["app_name", "allowed_features", "rate_limit_per_min", "webhook_url", "is_active", "last_used_at"];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(k === "allowed_features" && typeof v !== "string" ? JSON.stringify(v) : v);
  }
  if (!sets.length) return getApiKeyById(keyId);
  vals.push(keyId);
  db.prepare(`UPDATE api_keys SET ${sets.join(", ")} WHERE key_id = ?`).run(...vals);
  return getApiKeyById(keyId);
}

function revokeApiKey(keyId, telegramId = null) {
  ensureApiKeysSchema();
  if (telegramId !== null && telegramId !== undefined) {
    db.prepare("UPDATE api_keys SET is_active = 0 WHERE key_id = ? AND telegram_id = ?").run(keyId, telegramId);
  } else {
    db.prepare("UPDATE api_keys SET is_active = 0 WHERE key_id = ?").run(keyId);
  }
  return true;
}

function recordApiKeyUsage(keyId) {
  try {
    ensureApiKeysSchema();
    db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE key_id = ?").run(keyId);
  } catch (_) { }
}

/**
 * True when this ID belongs to a wallet created through the builder API. Such a row must never be
 * used by a Telegram account with the same numeric ID (older builder wallets used random positive
 * IDs that can collide with real Telegram users).
 */
function isApiProvisionedWallet(telegramId) {
  try {
    ensureApiKeysSchema();
    return Boolean(db.prepare("SELECT 1 FROM api_key_wallets WHERE telegram_id = ? LIMIT 1").get(Number(telegramId)));
  } catch (_) {
    return false;
  }
}

function registerApiKeyWallet(keyId, telegramId) {
  if (!keyId || !telegramId) return false;
  ensureApiKeysSchema();
  db.prepare("INSERT OR IGNORE INTO api_key_wallets (key_id, telegram_id) VALUES (?, ?)").run(
    String(keyId),
    Number(telegramId)
  );
  return true;
}

function getApiKeyWallets(keyId) {
  if (!keyId) return [];
  ensureApiKeysSchema();
  return db
    .prepare("SELECT telegram_id FROM api_key_wallets WHERE key_id = ? ORDER BY created_at DESC")
    .all(String(keyId))
    .map((r) => r.telegram_id);
}

function isWalletOwnedByApiKey(keyId, telegramId, ownerTelegramId = 0) {
  const targetId = Number(telegramId);
  // Builder-provisioned wallets use negative IDs; 0 and non-integers are never valid.
  if (!Number.isSafeInteger(targetId) || targetId === 0) return false;
  if (ownerTelegramId && Number(ownerTelegramId) > 0 && targetId === Number(ownerTelegramId)) {
    return true;
  }
  if (!keyId) return false;
  ensureApiKeysSchema();
  const row = db
    .prepare("SELECT 1 FROM api_key_wallets WHERE key_id = ? AND telegram_id = ?")
    .get(String(keyId), targetId);
  return Boolean(row);
}

// ─── Social Escrows & P2P Gifts ──────────────────────────────────────────────

function ensureSocialEscrowsSchema() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS social_escrows (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id               INTEGER NOT NULL,
        sender_account_type     TEXT NOT NULL DEFAULT 'personal',
        platform                TEXT NOT NULL DEFAULT 'telegram',
        target_handle           TEXT NOT NULL,
        amount_usdc             REAL NOT NULL,
        claim_token             TEXT UNIQUE NOT NULL,
        status                  TEXT NOT NULL DEFAULT 'pending',
        claimed_by_telegram_id  INTEGER,
        claimed_at              TEXT,
        expires_at              TEXT NOT NULL,
        created_at              TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_social_escrows_token ON social_escrows(claim_token);
      CREATE INDEX IF NOT EXISTS idx_social_escrows_sender ON social_escrows(sender_id, status);
    `);
  } catch (err) {
    console.warn("[db] ensureSocialEscrowsSchema note:", err.message);
  }
}

try {
  ensureSocialEscrowsSchema();
} catch (_) { }

function createSocialEscrow({
  senderId,
  senderAccountType = "personal",
  platform = "telegram",
  targetHandle,
  amountUsdc,
  claimToken,
  expiresHours = 48,
}) {
  ensureSocialEscrowsSchema();
  const cleanHandle = String(targetHandle).replace(/^@/, "").trim().toLowerCase();
  const info = db.prepare(`
    INSERT INTO social_escrows (sender_id, sender_account_type, platform, target_handle, amount_usdc, claim_token, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' hours'))
  `).run(senderId, senderAccountType, platform, cleanHandle, Number(amountUsdc), claimToken, expiresHours);
  return getSocialEscrowById(info.lastInsertRowid);
}

function getSocialEscrowById(id) {
  ensureSocialEscrowsSchema();
  return db.prepare("SELECT * FROM social_escrows WHERE id = ?").get(id) || null;
}

function getSocialEscrowByToken(claimToken) {
  ensureSocialEscrowsSchema();
  if (!claimToken) return null;
  return db.prepare("SELECT * FROM social_escrows WHERE claim_token = ?").get(claimToken) || null;
}

function getPendingSocialEscrowsBySender(senderId) {
  ensureSocialEscrowsSchema();
  return db.prepare("SELECT * FROM social_escrows WHERE sender_id = ? AND status = 'pending' ORDER BY id DESC").all(senderId) || [];
}

function claimSocialEscrow(claimToken, claimantTelegramId) {
  ensureSocialEscrowsSchema();
  const row = getSocialEscrowByToken(claimToken);
  if (!row || row.status !== "pending") return { success: false, reason: "invalid_or_claimed" };

  const expired = db.prepare("SELECT datetime('now') > datetime(expires_at) as is_expired FROM social_escrows WHERE claim_token = ?").get(claimToken);
  if (expired?.is_expired) {
    db.prepare("UPDATE social_escrows SET status = 'expired' WHERE claim_token = ?").run(claimToken);
    return { success: false, reason: "expired" };
  }

  const info = db.prepare(`
    UPDATE social_escrows
    SET status = 'claimed', claimed_by_telegram_id = ?, claimed_at = datetime('now')
    WHERE claim_token = ? AND status = 'pending'
  `).run(claimantTelegramId, claimToken);
  if (!info || info.changes !== 1) {
    return { success: false, reason: "already_claimed" };
  }
  return { success: true, escrow: getSocialEscrowByToken(claimToken) };
}

function cancelSocialEscrow(claimToken, senderId) {
  ensureSocialEscrowsSchema();
  const row = getSocialEscrowByToken(claimToken);
  if (!row) return { success: false, reason: "not_found" };
  if (row.sender_id !== senderId) return { success: false, reason: "unauthorized" };
  if (row.status !== "pending") return { success: false, reason: `already_${row.status}` };

  db.prepare("UPDATE social_escrows SET status = 'cancelled' WHERE claim_token = ?").run(claimToken);
  return { success: true, escrow: getSocialEscrowByToken(claimToken) };
}

function expireStaleSocialEscrows() {
  ensureSocialEscrowsSchema();
  return db.prepare(`
    UPDATE social_escrows
    SET status = 'expired'
    WHERE status = 'pending' AND datetime('now') > datetime(expires_at)
  `).run();
}

// ─── Airbills Utility Bill Payments ───────────────────────────────────────────

function ensureBillPaymentsSchema() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bill_payments (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id      INTEGER NOT NULL,
        account_type     TEXT    NOT NULL DEFAULT 'personal',
        product_code     TEXT    NOT NULL,
        category         TEXT    NOT NULL,
        provider_name    TEXT,
        recipient        TEXT    NOT NULL,
        amount_ngn       REAL    NOT NULL,
        amount_usdc      REAL    NOT NULL DEFAULT 0,
        airbills_tx_id   TEXT,
        arc_tx_hash      TEXT,
        solana_tx_sig    TEXT,
        meter_token      TEXT,
        status           TEXT    NOT NULL DEFAULT 'pending',
        error_message    TEXT,
        created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_bill_payments_user ON bill_payments(telegram_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bill_payments_airbills ON bill_payments(airbills_tx_id);
    `);
  } catch (err) {
    console.warn("[db] ensureBillPaymentsSchema note:", err.message);
  }
}

try {
  ensureBillPaymentsSchema();
} catch (_) { }

function createBillPayment({
  telegramId,
  accountType = "personal",
  productCode,
  category,
  providerName = null,
  recipient,
  amountNgn,
  amountUsdc = 0,
  status = "pending",
}) {
  ensureBillPaymentsSchema();
  const info = db.prepare(`
    INSERT INTO bill_payments (telegram_id, account_type, product_code, category, provider_name, recipient, amount_ngn, amount_usdc, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(telegramId, accountType, String(productCode), String(category), providerName, String(recipient), Number(amountNgn), Number(amountUsdc), status);
  return getBillPaymentById(info.lastInsertRowid);
}

function getBillPaymentById(id) {
  ensureBillPaymentsSchema();
  return db.prepare("SELECT * FROM bill_payments WHERE id = ?").get(id) || null;
}

function updateBillPayment(id, fields = {}) {
  ensureBillPaymentsSchema();
  const allowed = [
    "amount_usdc",
    "airbills_tx_id",
    "arc_tx_hash",
    "solana_tx_sig",
    "meter_token",
    "status",
    "error_message",
    "provider_name",
  ];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(fields[key]);
    }
  }
  if (!sets.length) return getBillPaymentById(id);
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE bill_payments SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getBillPaymentById(id);
}

function getUserBillPayments(telegramId, limit = 10) {
  ensureBillPaymentsSchema();
  return db.prepare(`
    SELECT * FROM bill_payments
    WHERE telegram_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(telegramId, limit) || [];
}

// ─── Nuvion Global Banking (Tier-1 Entities, Base Bridge, Accounts, Cards, Jobs) ─

function ensureNuvionSchema() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS nuvion_entities (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id                 INTEGER NOT NULL,
        account_type                TEXT NOT NULL DEFAULT 'personal',
        entity_id                   TEXT UNIQUE NOT NULL,
        entity_type                 TEXT NOT NULL DEFAULT 'individual',
        person_id                   TEXT,
        business_id                 TEXT,
        legal_name                  TEXT,
        email                       TEXT,
        status                      TEXT NOT NULL DEFAULT 'incomplete',
        risk_level                  TEXT,
        country_code                TEXT,
        rejection_reason            TEXT,
        self_counterparty_id        TEXT,
        self_base_payment_detail_id TEXT,
        usc_account_id              TEXT,
        usc_base_detail_id          TEXT,
        usc_base_address            TEXT,
        created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(telegram_id, account_type)
      );
      CREATE INDEX IF NOT EXISTS idx_nuvion_entities_entity ON nuvion_entities(entity_id);
      CREATE INDEX IF NOT EXISTS idx_nuvion_entities_tg ON nuvion_entities(telegram_id, account_type);

      CREATE TABLE IF NOT EXISTS monthly_maintenance_fees (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id     INTEGER NOT NULL,
        account_type    TEXT NOT NULL DEFAULT 'personal',
        billing_month   TEXT NOT NULL,
        amount_ngn      REAL NOT NULL DEFAULT 200,
        amount_usd      REAL DEFAULT 0,
        funding_source  TEXT,
        tx_ref          TEXT,
        status          TEXT NOT NULL DEFAULT 'charged',
        error_message   TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(telegram_id, billing_month)
      );
      CREATE INDEX IF NOT EXISTS idx_monthly_fees_month ON monthly_maintenance_fees(billing_month, status);

      CREATE TABLE IF NOT EXISTS global_account_maintenance_fees (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id      INTEGER NOT NULL,
        entity_id        TEXT NOT NULL,
        account_type     TEXT NOT NULL DEFAULT 'personal',
        account_id       TEXT NOT NULL,
        currency         TEXT NOT NULL,
        billing_month    TEXT NOT NULL,
        amount_major     REAL NOT NULL,
        amount_minor     INTEGER NOT NULL,
        amount_usd       REAL DEFAULT 0,
        funding_source   TEXT,
        tx_ref           TEXT,
        status           TEXT NOT NULL DEFAULT 'charged',
        notified_at      TEXT,
        reminder_sent_at TEXT,
        grace_expires_at TEXT,
        closed_at        TEXT,
        error_message    TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(account_id, billing_month)
      );
      CREATE INDEX IF NOT EXISTS idx_global_acct_fees_status ON global_account_maintenance_fees(status, grace_expires_at);
      CREATE INDEX IF NOT EXISTS idx_global_acct_fees_tg ON global_account_maintenance_fees(telegram_id, status);

      CREATE TABLE IF NOT EXISTS nuvion_kyc_drafts (
        telegram_id  INTEGER NOT NULL,
        account_type TEXT NOT NULL DEFAULT 'personal',
        step         TEXT NOT NULL,
        data_json    TEXT NOT NULL DEFAULT '{}',
        updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (telegram_id, account_type)
      );

      CREATE TABLE IF NOT EXISTS nuvion_accounts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id    TEXT NOT NULL,
        account_id   TEXT UNIQUE NOT NULL,
        currency     TEXT NOT NULL,
        account_type TEXT NOT NULL DEFAULT 'checking',
        display_name TEXT,
        nuvion_ban   TEXT,
        purpose      TEXT NOT NULL DEFAULT 'receiving',
        status       TEXT NOT NULL DEFAULT 'active',
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_nuvion_accounts_entity ON nuvion_accounts(entity_id, currency);

      CREATE TABLE IF NOT EXISTS nuvion_account_details (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id       TEXT NOT NULL,
        detail_id        TEXT UNIQUE NOT NULL,
        entity_id        TEXT NOT NULL,
        asset_type       TEXT NOT NULL DEFAULT 'fiat',
        currency         TEXT NOT NULL,
        chain            TEXT,
        account_number   TEXT,
        iban             TEXT,
        routing_number   TEXT,
        sort_code        TEXT,
        swift_code       TEXT,
        bank_name        TEXT,
        beneficiary_name TEXT,
        status           TEXT NOT NULL DEFAULT 'pending',
        raw_meta_json    TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_nuvion_details_account ON nuvion_account_details(account_id);
      CREATE INDEX IF NOT EXISTS idx_nuvion_details_entity ON nuvion_account_details(entity_id, currency);

      CREATE TABLE IF NOT EXISTS nuvion_counterparties (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id           TEXT NOT NULL,
        counterparty_id     TEXT NOT NULL,
        payment_detail_id   TEXT UNIQUE NOT NULL,
        label               TEXT,
        currency            TEXT NOT NULL,
        country             TEXT,
        scheme              TEXT,
        payment_method      TEXT NOT NULL,
        account_holder_name TEXT,
        summary_json        TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_nuvion_cp_entity ON nuvion_counterparties(entity_id, currency);

      CREATE TABLE IF NOT EXISTS nuvion_cards (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id   TEXT NOT NULL,
        account_id  TEXT NOT NULL,
        card_id     TEXT UNIQUE NOT NULL,
        card_type   TEXT NOT NULL DEFAULT 'virtual',
        card_name   TEXT,
        currency    TEXT NOT NULL DEFAULT 'USD',
        last4       TEXT,
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_nuvion_cards_entity ON nuvion_cards(entity_id);

      CREATE TABLE IF NOT EXISTS nuvion_jobs (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id          TEXT NOT NULL,
        telegram_id        INTEGER NOT NULL,
        account_type       TEXT NOT NULL DEFAULT 'personal',
        job_type           TEXT NOT NULL,
        state              TEXT NOT NULL DEFAULT 'pending',
        currency           TEXT,
        amount_minor       INTEGER DEFAULT 0,
        margin_minor       INTEGER DEFAULT 0,
        unique_reference   TEXT UNIQUE,
        source_tx_hash     TEXT,
        nuvion_transfer_id TEXT,
        fx_quote_id        TEXT,
        session_id         TEXT,
        card_id            TEXT,
        payload_json       TEXT,
        error_message      TEXT,
        retry_count        INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_nuvion_jobs_state ON nuvion_jobs(job_type, state);
      CREATE INDEX IF NOT EXISTS idx_nuvion_jobs_entity ON nuvion_jobs(entity_id, state);
    `);
  } catch (err) {
    console.warn("[db] ensureNuvionSchema note:", err.message);
  }
}

try {
  ensureNuvionSchema();
} catch (_) { }

function upsertNuvionEntity({
  telegramId,
  accountType = "personal",
  entityId,
  entityType = "individual",
  personId = null,
  businessId = null,
  legalName = null,
  email = null,
  status = "incomplete",
  riskLevel = null,
  countryCode = null,
  rejectionReason = null,
}) {
  ensureNuvionSchema();
  try {
    const cols = db.prepare("PRAGMA table_info(nuvion_entities)").all().map((c) => c.name);
    if (!cols.includes("country_code")) db.exec("ALTER TABLE nuvion_entities ADD COLUMN country_code TEXT");
    if (!cols.includes("rejection_reason")) db.exec("ALTER TABLE nuvion_entities ADD COLUMN rejection_reason TEXT");
  } catch (_) { }
  db.prepare(`
    INSERT INTO nuvion_entities
      (telegram_id, account_type, entity_id, entity_type, person_id, business_id, legal_name, email, status, risk_level, country_code, rejection_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id, account_type) DO UPDATE SET
      entity_id        = excluded.entity_id,
      entity_type      = excluded.entity_type,
      person_id        = COALESCE(excluded.person_id, nuvion_entities.person_id),
      business_id      = COALESCE(excluded.business_id, nuvion_entities.business_id),
      legal_name       = COALESCE(excluded.legal_name, nuvion_entities.legal_name),
      email            = COALESCE(excluded.email, nuvion_entities.email),
      status           = excluded.status,
      risk_level       = COALESCE(excluded.risk_level, nuvion_entities.risk_level),
      country_code     = COALESCE(excluded.country_code, nuvion_entities.country_code),
      rejection_reason = excluded.rejection_reason,
      updated_at       = datetime('now')
  `).run(
    Number(telegramId),
    accountType,
    String(entityId),
    entityType,
    personId,
    businessId,
    legalName,
    email,
    status,
    riskLevel,
    countryCode,
    rejectionReason
  );
  return getNuvionEntityByUser(telegramId, accountType);
}

function getNuvionEntityByUser(telegramId, accountType = "personal") {
  ensureNuvionSchema();
  return db.prepare(
    "SELECT * FROM nuvion_entities WHERE telegram_id = ? AND account_type = ?"
  ).get(Number(telegramId), accountType) || null;
}

function getNuvionEntityByEntityId(entityId) {
  ensureNuvionSchema();
  return db.prepare("SELECT * FROM nuvion_entities WHERE entity_id = ?").get(String(entityId)) || null;
}

function isUserAnyKycApproved(telegramId) {
  if (!telegramId) return false;
  ensureNuvionSchema();
  const row = db.prepare(
    "SELECT 1 AS ok FROM nuvion_entities WHERE telegram_id = ? AND LOWER(status) = 'approved' LIMIT 1"
  ).get(Number(telegramId));
  return Boolean(row?.ok);
}

function getVerifiedUsersForMonthlyFee(billingMonth) {
  ensureNuvionSchema();
  return db.prepare(`
    SELECT u.*
    FROM users u
    WHERE COALESCE(u.is_blocked, 0) = 0
      AND EXISTS (
        SELECT 1 FROM nuvion_entities ne
        WHERE ne.telegram_id = u.telegram_id AND LOWER(ne.status) = 'approved'
      )
      AND NOT EXISTS (
        SELECT 1 FROM monthly_maintenance_fees mf
        WHERE mf.telegram_id = u.telegram_id
          AND mf.billing_month = ?
          AND mf.status = 'charged'
      )
    ORDER BY u.telegram_id ASC
  `).all(String(billingMonth));
}

function recordMonthlyMaintenanceFee({
  telegramId,
  accountType = "personal",
  billingMonth,
  amountNgn = 200,
  amountUsd = 0,
  fundingSource = null,
  txRef = null,
  status = "charged",
  errorMessage = null,
}) {
  ensureNuvionSchema();
  db.prepare(`
    INSERT INTO monthly_maintenance_fees
      (telegram_id, account_type, billing_month, amount_ngn, amount_usd, funding_source, tx_ref, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id, billing_month) DO UPDATE SET
      account_type   = excluded.account_type,
      amount_ngn     = excluded.amount_ngn,
      amount_usd     = excluded.amount_usd,
      funding_source = COALESCE(excluded.funding_source, monthly_maintenance_fees.funding_source),
      tx_ref         = COALESCE(excluded.tx_ref, monthly_maintenance_fees.tx_ref),
      status         = excluded.status,
      error_message  = excluded.error_message,
      created_at     = datetime('now')
  `).run(
    Number(telegramId),
    accountType,
    String(billingMonth),
    Number(amountNgn),
    Number(amountUsd || 0),
    fundingSource,
    txRef,
    status,
    errorMessage
  );
  return db.prepare(
    "SELECT * FROM monthly_maintenance_fees WHERE telegram_id = ? AND billing_month = ? LIMIT 1"
  ).get(Number(telegramId), String(billingMonth));
}

function updateNuvionEntity(entityId, fields = {}) {
  ensureNuvionSchema();
  try {
    const cols = db.prepare("PRAGMA table_info(nuvion_entities)").all().map((c) => c.name);
    if (!cols.includes("country_code")) db.exec("ALTER TABLE nuvion_entities ADD COLUMN country_code TEXT");
    if (!cols.includes("rejection_reason")) db.exec("ALTER TABLE nuvion_entities ADD COLUMN rejection_reason TEXT");
  } catch (_) { }
  const allowed = [
    "person_id", "business_id", "legal_name", "email", "status", "risk_level",
    "country_code", "rejection_reason",
    "self_counterparty_id", "self_base_payment_detail_id",
    "usc_account_id", "usc_base_detail_id", "usc_base_address",
  ];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(fields[key]);
    }
  }
  if (!sets.length) return getNuvionEntityByEntityId(entityId);
  sets.push("updated_at = datetime('now')");
  vals.push(String(entityId));
  db.prepare(`UPDATE nuvion_entities SET ${sets.join(", ")} WHERE entity_id = ?`).run(...vals);
  return getNuvionEntityByEntityId(entityId);
}

function saveNuvionKycDraft(telegramId, accountType = "personal", step, data = {}) {
  ensureNuvionSchema();
  db.prepare(`
    INSERT INTO nuvion_kyc_drafts (telegram_id, account_type, step, data_json, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(telegram_id, account_type) DO UPDATE SET
      step = excluded.step,
      data_json = excluded.data_json,
      updated_at = datetime('now')
  `).run(Number(telegramId), accountType, String(step), JSON.stringify(data || {}));
}

function getNuvionKycDraft(telegramId, accountType = "personal") {
  ensureNuvionSchema();
  const row = db.prepare(
    "SELECT * FROM nuvion_kyc_drafts WHERE telegram_id = ? AND account_type = ?"
  ).get(Number(telegramId), accountType);
  if (!row) return null;
  let parsed = {};
  try { parsed = JSON.parse(row.data_json || "{}"); } catch (_) { }
  return { ...row, data: parsed };
}

function deleteNuvionKycDraft(telegramId, accountType = "personal") {
  ensureNuvionSchema();
  db.prepare("DELETE FROM nuvion_kyc_drafts WHERE telegram_id = ? AND account_type = ?").run(
    Number(telegramId),
    accountType
  );
}

function upsertNuvionAccount({
  entityId,
  accountId,
  currency,
  accountType = "checking",
  displayName = null,
  nuvionBan = null,
  purpose = "receiving",
  status = "active",
}) {
  ensureNuvionSchema();
  db.prepare(`
    INSERT INTO nuvion_accounts (entity_id, account_id, currency, account_type, display_name, nuvion_ban, purpose, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, nuvion_accounts.display_name),
      nuvion_ban   = COALESCE(excluded.nuvion_ban, nuvion_accounts.nuvion_ban),
      purpose      = excluded.purpose,
      status       = excluded.status,
      updated_at   = datetime('now')
  `).run(String(entityId), String(accountId), String(currency).toUpperCase(), accountType, displayName, nuvionBan, purpose, status);
  return db.prepare("SELECT * FROM nuvion_accounts WHERE account_id = ?").get(String(accountId)) || null;
}

function getNuvionAccountsByEntity(entityId, { currency = null, purpose = null, includeClosed = false } = {}) {
  ensureNuvionSchema();
  let sql = "SELECT * FROM nuvion_accounts WHERE entity_id = ?";
  const vals = [String(entityId)];
  if (!includeClosed) { sql += " AND LOWER(COALESCE(status, 'active')) != 'closed'"; }
  if (currency) { sql += " AND currency = ?"; vals.push(String(currency).toUpperCase()); }
  if (purpose) { sql += " AND purpose = ?"; vals.push(purpose); }
  sql += " ORDER BY id ASC";
  return db.prepare(sql).all(...vals) || [];
}

function markNuvionAccountClosed(accountId) {
  ensureNuvionSchema();
  const id = String(accountId);
  db.prepare(
    "UPDATE nuvion_accounts SET status = 'closed', updated_at = datetime('now') WHERE account_id = ?"
  ).run(id);
  db.prepare(
    "UPDATE nuvion_account_details SET status = 'closed', updated_at = datetime('now') WHERE account_id = ?"
  ).run(id);
  return db.prepare("SELECT * FROM nuvion_accounts WHERE account_id = ?").get(id) || null;
}

function getBillableGlobalAccountsForMonth(billingMonth, minAgeDays = 15) {
  ensureNuvionSchema();
  const safeDays = Math.max(0, Math.floor(Number(minAgeDays) || 0));
  return db.prepare(`
    SELECT
      na.account_id,
      na.entity_id,
      na.currency,
      na.display_name,
      na.nuvion_ban,
      na.created_at AS account_created_at,
      ne.telegram_id,
      ne.account_type,
      ne.legal_name,
      ne.email AS entity_email,
      u.deposit_address,
      u.business_deposit_address
    FROM nuvion_accounts na
    JOIN nuvion_entities ne ON ne.entity_id = na.entity_id
    JOIN users u ON u.telegram_id = ne.telegram_id
    WHERE COALESCE(u.is_blocked, 0) = 0
      AND LOWER(COALESCE(ne.status, '')) = 'approved'
      AND LOWER(COALESCE(na.status, 'active')) = 'active'
      AND LOWER(COALESCE(na.purpose, 'receiving')) = 'receiving'
      AND UPPER(na.currency) NOT IN ('NGN', 'USC', 'UST', 'RLD')
      AND datetime(na.created_at) <= datetime('now', '-' || ? || ' days')
      AND NOT EXISTS (
        SELECT 1 FROM global_account_maintenance_fees gaf
        WHERE gaf.account_id = na.account_id
          AND gaf.billing_month = ?
          AND gaf.status IN ('charged', 'closed_unpaid', 'waived')
      )
    ORDER BY ne.telegram_id ASC, na.id ASC
  `).all(safeDays, String(billingMonth)) || [];
}

function recordGlobalAccountMaintenanceFee({
  telegramId,
  entityId,
  accountType = "personal",
  accountId,
  currency,
  billingMonth,
  amountMajor,
  amountMinor,
  amountUsd = 0,
  fundingSource = null,
  txRef = null,
  status = "charged",
  notifiedAt = null,
  graceExpiresAt = null,
  closedAt = null,
  errorMessage = null,
}) {
  ensureNuvionSchema();
  db.prepare(`
    INSERT INTO global_account_maintenance_fees (
      telegram_id, entity_id, account_type, account_id, currency, billing_month,
      amount_major, amount_minor, amount_usd, funding_source, tx_ref, status,
      notified_at, grace_expires_at, closed_at, error_message, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(account_id, billing_month) DO UPDATE SET
      amount_major     = excluded.amount_major,
      amount_minor     = excluded.amount_minor,
      amount_usd       = excluded.amount_usd,
      funding_source   = COALESCE(excluded.funding_source, global_account_maintenance_fees.funding_source),
      tx_ref           = COALESCE(excluded.tx_ref, global_account_maintenance_fees.tx_ref),
      status           = excluded.status,
      notified_at      = COALESCE(global_account_maintenance_fees.notified_at, excluded.notified_at),
      grace_expires_at = COALESCE(global_account_maintenance_fees.grace_expires_at, excluded.grace_expires_at),
      closed_at        = COALESCE(excluded.closed_at, global_account_maintenance_fees.closed_at),
      error_message    = excluded.error_message,
      updated_at       = datetime('now')
  `).run(
    Number(telegramId),
    String(entityId),
    accountType,
    String(accountId),
    String(currency).toUpperCase(),
    String(billingMonth),
    Number(amountMajor || 0),
    Math.round(Number(amountMinor || 0)),
    Number(amountUsd || 0),
    fundingSource,
    txRef,
    status,
    notifiedAt,
    graceExpiresAt,
    closedAt,
    errorMessage
  );
  return db.prepare(
    "SELECT * FROM global_account_maintenance_fees WHERE account_id = ? AND billing_month = ? LIMIT 1"
  ).get(String(accountId), String(billingMonth));
}

function getPastDueGlobalAccountFees({ telegramId = null, expiredOnly = false, needsReminderOnly = false } = {}) {
  ensureNuvionSchema();
  let sql = `
    SELECT gaf.*, ne.legal_name, ne.email AS entity_email
    FROM global_account_maintenance_fees gaf
    LEFT JOIN nuvion_entities ne ON ne.entity_id = gaf.entity_id
    WHERE gaf.status = 'past_due'
  `;
  const vals = [];
  if (telegramId != null) {
    sql += " AND gaf.telegram_id = ?";
    vals.push(Number(telegramId));
  }
  if (expiredOnly) {
    sql += " AND gaf.grace_expires_at IS NOT NULL AND datetime(gaf.grace_expires_at) <= datetime('now')";
  }
  if (needsReminderOnly) {
    sql += " AND gaf.reminder_sent_at IS NULL AND gaf.notified_at IS NOT NULL AND datetime(gaf.notified_at) <= datetime('now', '-7 days') AND (gaf.grace_expires_at IS NULL OR datetime(gaf.grace_expires_at) > datetime('now'))";
  }
  sql += " ORDER BY gaf.id ASC";
  return db.prepare(sql).all(...vals) || [];
}

function markGlobalAccountFeeReminderSent(id) {
  ensureNuvionSchema();
  db.prepare(
    "UPDATE global_account_maintenance_fees SET reminder_sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(Number(id));
}

function upsertNuvionAccountDetail({
  accountId,
  detailId,
  entityId,
  assetType = "fiat",
  currency,
  chain = null,
  accountNumber = null,
  iban = null,
  routingNumber = null,
  sortCode = null,
  swiftCode = null,
  bankName = null,
  beneficiaryName = null,
  status = "pending",
  rawMeta = null,
}) {
  ensureNuvionSchema();
  const metaStr = rawMeta ? (typeof rawMeta === "string" ? rawMeta : JSON.stringify(rawMeta)) : null;
  db.prepare(`
    INSERT INTO nuvion_account_details
      (account_id, detail_id, entity_id, asset_type, currency, chain, account_number, iban,
       routing_number, sort_code, swift_code, bank_name, beneficiary_name, status, raw_meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(detail_id) DO UPDATE SET
      account_number   = COALESCE(excluded.account_number, nuvion_account_details.account_number),
      iban             = COALESCE(excluded.iban, nuvion_account_details.iban),
      routing_number   = COALESCE(excluded.routing_number, nuvion_account_details.routing_number),
      sort_code        = COALESCE(excluded.sort_code, nuvion_account_details.sort_code),
      swift_code       = COALESCE(excluded.swift_code, nuvion_account_details.swift_code),
      bank_name        = COALESCE(excluded.bank_name, nuvion_account_details.bank_name),
      beneficiary_name = COALESCE(excluded.beneficiary_name, nuvion_account_details.beneficiary_name),
      status           = CASE
                           WHEN nuvion_account_details.status = 'active' AND excluded.status = 'pending'
                             THEN nuvion_account_details.status
                           ELSE excluded.status
                         END,
      raw_meta_json    = COALESCE(excluded.raw_meta_json, nuvion_account_details.raw_meta_json),
      updated_at       = datetime('now')
  `).run(
    String(accountId), String(detailId), String(entityId), assetType, String(currency).toUpperCase(),
    chain, accountNumber, iban, routingNumber, sortCode, swiftCode, bankName, beneficiaryName, status, metaStr
  );
  return db.prepare("SELECT * FROM nuvion_account_details WHERE detail_id = ?").get(String(detailId)) || null;
}

function getNuvionAccountDetailsByEntity(entityId, currency = null, { includeClosed = false } = {}) {
  ensureNuvionSchema();
  const statusClause = includeClosed ? "" : " AND LOWER(COALESCE(status, 'active')) != 'closed'";
  if (currency) {
    return db.prepare(
      `SELECT * FROM nuvion_account_details WHERE entity_id = ? AND currency = ?${statusClause} ORDER BY id DESC`
    ).all(String(entityId), String(currency).toUpperCase()) || [];
  }
  return db.prepare(
    `SELECT * FROM nuvion_account_details WHERE entity_id = ?${statusClause} ORDER BY id DESC`
  ).all(String(entityId)) || [];
}

function saveNuvionCounterparty({
  entityId,
  counterpartyId,
  paymentDetailId,
  label = null,
  currency,
  country = null,
  scheme = null,
  paymentMethod,
  accountHolderName = null,
  summary = null,
}) {
  ensureNuvionSchema();
  const sumStr = summary ? (typeof summary === "string" ? summary : JSON.stringify(summary)) : null;
  db.prepare(`
    INSERT OR REPLACE INTO nuvion_counterparties
      (entity_id, counterparty_id, payment_detail_id, label, currency, country, scheme, payment_method, account_holder_name, summary_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(entityId), String(counterpartyId), String(paymentDetailId), label,
    String(currency).toUpperCase(), country, scheme, paymentMethod, accountHolderName, sumStr
  );
  return db.prepare("SELECT * FROM nuvion_counterparties WHERE payment_detail_id = ?").get(String(paymentDetailId)) || null;
}

function getNuvionCounterpartiesByEntity(entityId, currency = null) {
  ensureNuvionSchema();
  if (currency) {
    return db.prepare(
      "SELECT * FROM nuvion_counterparties WHERE entity_id = ? AND currency = ? ORDER BY id DESC"
    ).all(String(entityId), String(currency).toUpperCase()) || [];
  }
  return db.prepare("SELECT * FROM nuvion_counterparties WHERE entity_id = ? ORDER BY id DESC").all(String(entityId)) || [];
}

function upsertNuvionCard({ entityId, accountId, cardId, cardType = "virtual", cardName = null, currency = "USD", last4 = null, status = "active" }) {
  ensureNuvionSchema();
  db.prepare(`
    INSERT INTO nuvion_cards (entity_id, account_id, card_id, card_type, card_name, currency, last4, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(card_id) DO UPDATE SET
      account_id = excluded.account_id,
      card_name  = COALESCE(excluded.card_name, nuvion_cards.card_name),
      last4      = COALESCE(excluded.last4, nuvion_cards.last4),
      status     = excluded.status,
      updated_at = datetime('now')
  `).run(String(entityId), String(accountId), String(cardId), cardType, cardName, String(currency).toUpperCase(), last4, status);
  return db.prepare("SELECT * FROM nuvion_cards WHERE card_id = ?").get(String(cardId)) || null;
}

function getNuvionCardsByEntity(entityId) {
  ensureNuvionSchema();
  return db.prepare("SELECT * FROM nuvion_cards WHERE entity_id = ? AND status != 'deleted' ORDER BY id DESC").all(String(entityId)) || [];
}

function createNuvionJob({
  entityId,
  telegramId,
  accountType = "personal",
  jobType,
  state = "pending",
  currency = null,
  amountMinor = 0,
  marginMinor = 0,
  uniqueReference = null,
  sourceTxHash = null,
  nuvionTransferId = null,
  fxQuoteId = null,
  sessionId = null,
  cardId = null,
  payload = null,
}) {
  ensureNuvionSchema();
  const payloadStr = payload ? (typeof payload === "string" ? payload : JSON.stringify(payload)) : null;
  const info = db.prepare(`
    INSERT INTO nuvion_jobs
      (entity_id, telegram_id, account_type, job_type, state, currency, amount_minor, margin_minor,
       unique_reference, source_tx_hash, nuvion_transfer_id, fx_quote_id, session_id, card_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(entityId), Number(telegramId), accountType, jobType, state, currency,
    Math.round(Number(amountMinor) || 0), Math.round(Number(marginMinor) || 0),
    uniqueReference, sourceTxHash, nuvionTransferId, fxQuoteId, sessionId, cardId, payloadStr
  );
  return getNuvionJobById(info.lastInsertRowid);
}

function getNuvionJobById(id) {
  ensureNuvionSchema();
  const row = db.prepare("SELECT * FROM nuvion_jobs WHERE id = ?").get(id);
  if (!row) return null;
  let payload = {};
  try { payload = row.payload_json ? JSON.parse(row.payload_json) : {}; } catch (_) { }
  return { ...row, payload };
}

function updateNuvionJob(id, fields = {}) {
  ensureNuvionSchema();
  const allowed = [
    "state", "amount_minor", "margin_minor", "source_tx_hash",
    "nuvion_transfer_id", "fx_quote_id", "session_id", "card_id",
    "payload_json", "error_message", "retry_count",
  ];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(key === "payload_json" && typeof fields[key] !== "string" ? JSON.stringify(fields[key]) : fields[key]);
    }
  }
  if (!sets.length) return getNuvionJobById(id);
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE nuvion_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getNuvionJobById(id);
}

function getNuvionJobsByState(jobType, state) {
  ensureNuvionSchema();
  const rows = db.prepare(
    "SELECT * FROM nuvion_jobs WHERE job_type = ? AND state = ? ORDER BY id ASC"
  ).all(jobType, state) || [];
  return rows.map((r) => {
    let payload = {};
    try { payload = r.payload_json ? JSON.parse(r.payload_json) : {}; } catch (_) { }
    return { ...r, payload };
  });
}

function _cleanSenderName(raw) {
  if (!raw) return "";
  return String(raw)
    .replace(/[\r\n\t\x00-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

/**
 * Persist a user's preferred sender name (shown on recipient bank alerts via Paj senderName).
 * Stored separately for personal (`sender_name`) and business (`biz_sender_name`).
 */
function setUserSenderName(telegramId, senderName, accountType = "personal") {
  const clean = _cleanSenderName(senderName);
  if (!clean) throw new Error("Sender name cannot be empty.");
  const col = accountType === "business" ? "biz_sender_name" : "sender_name";
  db.prepare(`UPDATE users SET ${col} = ? WHERE telegram_id = ?`).run(clean, Number(telegramId));
  return clean;
}

/**
 * Resolve the cleanest sender name (<= 64 chars) for bank payouts & receipts:
 *  - Business: saved biz_sender_name -> approved Nuvion business legal_name -> Telegram full name -> username -> "Proxim"
 *  - Personal: saved sender_name -> approved Nuvion personal legal_name -> Telegram full name -> username -> "Proxim"
 */
function resolveSenderName(telegramId, accountType = "personal", tgFrom = null) {
  const isBiz = accountType === "business";
  let user = null;
  try {
    user = telegramId ? getUser(telegramId) : null;
  } catch (_) { }

  const saved = _cleanSenderName(isBiz ? user?.biz_sender_name : user?.sender_name);
  if (saved) return saved;

  // Check verified Nuvion legal name if available
  try {
    if (telegramId) {
      const entity = getNuvionEntityByUser(telegramId, isBiz ? "business" : "personal");
      const legal = _cleanSenderName(entity?.legal_name);
      if (legal) return legal;
    }
  } catch (_) { }

  // Telegram live profile full name (first_name + last_name)
  if (tgFrom) {
    const tgFull = _cleanSenderName([tgFrom.first_name, tgFrom.last_name].filter(Boolean).join(" "));
    if (tgFull) return tgFull;
    const tgUser = _cleanSenderName(tgFrom.username);
    if (tgUser) return tgUser;
  }

  const dbUsername = _cleanSenderName(user?.username);
  if (dbUsername) return dbUsername;

  return "Proxim";
}

module.exports = {
  db,
  resolveDbPath,
  getUser,
  getUserByTelegramId: getUser,
  recordTermsAcceptance,
  hasAcceptedTerms,
  setUserSenderName,
  resolveSenderName,
  findUserByUsername,
  syncUsername,
  getAllUsers,
  getUserByDepositAddress,
  getSystemDecryptedPrivateKey,
  getUserBySolanaAddress,
  getUserByBizSolanaAddress,
  getUserByReferralCode,
  createUserWithWallet,
  addBusinessWallet,
  setActiveContext,
  verifyPin,
  verifyPinWithStatus,
  isPinLocked,
  resetPinLockout,
  decryptPrivateKey,
  decryptBusinessPrivateKey,
  updatePin,
  setExternalWallet,
  setPhoneNumber,
  setPhoneVerified,
  blockUser,
  unblockUser,
  isBlocked,
  isApiProvisionedWallet,
  awardPoints,
  maybeAwardReferralBonus,
  redeemPointsAtomic,
  getPointsBalance,
  getPointsHistory,
  recordTransaction,
  updateTransactionStatus,
  updateTransactionByTxHash,
  getTransactions,
  getOpenYieldPosition,
  getLatestYieldPosition,
  recoverUncreditedYieldPosition,
  openYieldPosition,
  closeYieldPosition,
  createInvoice,
  getInvoiceById,
  getInvoiceByNumber,
  getInvoices,
  updateInvoiceStatus,
  markInvoicePaid,
  findMatchingOutstandingInvoice,
  sweepOverdueInvoices,
  getFinancialSummary,
  updateSolanaAddress,
  updateBizSolanaAddress,
  updatePermanentOfframpAddress,
  updateSystemEncryptedKey,
  updateBizSystemEncryptedKey,
  updateUserLastActivity,
  updateAutoEarnSetting,
  updateDepositSettlementMode,
  getIdleUsersForAutoEarn,
  getVolumeStats,
  reconcileLiveProductVolume,
  recordCctpPendingBurn,
  completeCctpPendingBurn,
  failCctpPendingBurn,
  getPendingCctpBurns,
  countPendingCctpBurns,
  recordCrosschainWithdrawal,
  getPendingCrosschainWithdrawals,
  getCrosschainWithdrawalByArcTx,
  updateCrosschainWithdrawal,
  completeCrosschainWithdrawal,
  failCrosschainWithdrawal,
  recordOnrampOrder,
  getOnrampOrderByOrderId,
  getPendingOnrampOrders,
  completeOnrampOrder,
  recordOfframpOrder,
  getOfframpOrderByOrderId,
  getPendingOfframpOrders,
  completeOfframpOrder,
  recordInboundCctpTransfer,
  updateInboundCctpTransfer,
  completeInboundCctpTransfer,
  getPendingInboundCctpTransfers,
  getRecentCctpBurnsByUser,
  getRecentInboundByUser,
  beginSettlementRun,
  finishSettlementRun,
  interruptStaleSettlementRuns,
  getRecentSettlementRuns,
  pruneSettlementRuns,
  ensureSettlementRunsSchema,
  createNearDeposit,
  updateNearDeposit,
  getNearDepositById,
  getActiveNearDeposits,
  getStaleNearDeposits,
  getSystemDecryptedPrivateKey,
  ensureApiKeysSchema,
  createApiKey,
  getApiKeyByHash,
  getApiKeyById,
  getApiKeysByTelegramId,
  updateApiKey,
  revokeApiKey,
  recordApiKeyUsage,
  registerApiKeyWallet,
  getApiKeyWallets,
  isWalletOwnedByApiKey,
  ensureSocialEscrowsSchema,
  createSocialEscrow,
  getSocialEscrowById,
  getSocialEscrowByToken,
  getPendingSocialEscrowsBySender,
  claimSocialEscrow,
  cancelSocialEscrow,
  expireStaleSocialEscrows,
  ensureBillPaymentsSchema,
  createBillPayment,
  getBillPaymentById,
  updateBillPayment,
  getUserBillPayments,
  ensureNuvionSchema,
  upsertNuvionEntity,
  getNuvionEntityByUser,
  getNuvionEntityByEntityId,
  isUserAnyKycApproved,
  getVerifiedUsersForMonthlyFee,
  recordMonthlyMaintenanceFee,
  updateNuvionEntity,
  saveNuvionKycDraft,
  getNuvionKycDraft,
  deleteNuvionKycDraft,
  upsertNuvionAccount,
  getNuvionAccountsByEntity,
  markNuvionAccountClosed,
  getBillableGlobalAccountsForMonth,
  recordGlobalAccountMaintenanceFee,
  getPastDueGlobalAccountFees,
  markGlobalAccountFeeReminderSent,
  upsertNuvionAccountDetail,
  getNuvionAccountDetailsByEntity,
  saveNuvionCounterparty,
  getNuvionCounterpartiesByEntity,
  upsertNuvionCard,
  getNuvionCardsByEntity,
  createNuvionJob,
  getNuvionJobById,
  updateNuvionJob,
  getNuvionJobsByState,
  _db: db,
  db: db,
  prepare: (...args) => db.prepare(...args),
  exec: (...args) => db.exec(...args),
};

// Automatically reconcile and sync volume on startup
try {
  reconcileLiveProductVolume();
} catch (startupErr) {
  console.warn("[db] Volume reconciliation on startup warning:", startupErr.message);
}
