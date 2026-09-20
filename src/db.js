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
      } catch {}
    }
  } catch (err) {}
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
    db.exec("ALTER TABLE users ADD COLUMN auto_earn_enabled INTEGER DEFAULT 1");
  }
  if (!columns.includes("last_activity_at")) {
    db.exec("ALTER TABLE users ADD COLUMN last_activity_at TEXT");
    db.exec("UPDATE users SET last_activity_at = datetime('now') WHERE last_activity_at IS NULL");
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
}

function ensureTransactionsSchema() {
  const info = db.prepare("PRAGMA table_info(transactions)").all();
  const cols = info.map(c => c.name);
  if (!cols.includes("tx_hash")) db.exec("ALTER TABLE transactions ADD COLUMN tx_hash TEXT");
  if (!cols.includes("account_type")) db.exec("ALTER TABLE transactions ADD COLUMN account_type TEXT DEFAULT 'personal'");
  if (!cols.includes("amount_micro")) db.exec("ALTER TABLE transactions ADD COLUMN amount_micro TEXT");
  if (!cols.includes("status")) db.exec("ALTER TABLE transactions ADD COLUMN status TEXT DEFAULT 'pending'");
  if (!cols.includes("type")) db.exec("ALTER TABLE transactions ADD COLUMN type TEXT DEFAULT 'general'");
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

ensureUserSchema();
ensureYieldPositionsSchema();
ensureTransactionsSchema();
ensureCctpPendingSchema();

// ─── User helpers ─────────────────────────────────────────────────────────────

function getUser(telegramId) {
  return db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId) || null;
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
        } catch {}
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
      system_encrypted_key, biz_system_encrypted_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    bizSystemEncryptedKey
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

function awardPoints(telegramId, points, action, details = null, options = {}) {
  if (!Number.isInteger(points) || points === 0) return;
  const normalized = Number(points);
  if (normalized > 0 && !options.skipReferral) {
    maybeAwardReferralBonus(telegramId, options.notify);
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

function maybeAwardReferralBonus(telegramId, notify = null) {
  const row = db.prepare(
    "SELECT referrer_telegram_id, referred_on_first_point FROM users WHERE telegram_id = ?"
  ).get(telegramId);
  if (!row?.referrer_telegram_id || row.referred_on_first_point === 1) return;
  if (row.referrer_telegram_id === telegramId) return;

  const referrer = getUser(row.referrer_telegram_id);
  if (!referrer) return;

  db.prepare(
    "UPDATE users SET referred_on_first_point = 1 WHERE telegram_id = ?"
  ).run(telegramId);

  awardPoints(referrer.telegram_id, REFERRAL_BONUS_POINTS, "referral_bonus", `Referral: ${telegramId}`, {
    skipReferral: true,
    notify,
  });
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

function recordTransaction(telegramId, type, amountMicro, status, txHash, accountType = "personal") {
  const result = db.prepare(
    "INSERT INTO transactions (telegram_id, type, amount_micro, status, tx_hash, account_type) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(telegramId, type, amountMicro.toString(), status, txHash || null, accountType);
  return result.lastInsertRowid;
}

function updateTransactionStatus(txId, status, txHash = null) {
  if (txHash) {
    db.prepare("UPDATE transactions SET status = ?, tx_hash = ? WHERE id = ?").run(status, txHash, txId);
  } else {
    db.prepare("UPDATE transactions SET status = ? WHERE id = ?").run(status, txId);
  }
}

function getTransactions(telegramId, limit = 10, accountType = null) {
  if (accountType) {
    return db.prepare(
      "SELECT * FROM transactions WHERE telegram_id = ? AND account_type = ? ORDER BY id DESC LIMIT ?"
    ).all(telegramId, accountType, limit);
  }
  return db.prepare(
    "SELECT * FROM transactions WHERE telegram_id = ? ORDER BY id DESC LIMIT ?"
  ).all(telegramId, limit);
}

// ─── Yield positions ──────────────────────────────────────────────────────────

function getOpenYieldPosition(telegramId, accountType = null) {
  if (accountType) {
    return db.prepare(
      "SELECT * FROM yield_positions WHERE telegram_id = ? AND account_type = ? AND status = 'active' ORDER BY id DESC LIMIT 1"
    ).get(telegramId, accountType) || null;
  }
  return db.prepare(
    "SELECT * FROM yield_positions WHERE telegram_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1"
  ).get(telegramId) || null;
}

function openYieldPosition(telegramId, amountUsdc, pool, options = {}) {
  const vaultAddress = pool.vaultAddress || pool.address || null;
  const isAutoEarn = options.isAutoEarn ? 1 : 0;
  const depositTxHash = options.depositTxHash || null;
  const accountType = options.accountType || "personal";
  const apy = pool.userApy ?? pool.apy ?? 0;
  const project = pool.project || "Arc Morpho Vault";
  const symbol = pool.symbol || "USDC";
  const chain = pool.chain || "arc";

  db.prepare(`
    INSERT INTO yield_positions (
      telegram_id, amount_usdc, apy, project, symbol, chain, vault_address, is_auto_earn, deposit_tx_hash, account_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    telegramId,
    amountUsdc,
    apy,
    project,
    symbol,
    chain,
    vaultAddress,
    isAutoEarn,
    depositTxHash,
    accountType
  );
}

function closeYieldPosition(telegramId, payout, options = {}) {
  const devFee = options.devFee || 0;
  const withdrawTxHash = options.withdrawTxHash || null;
  const feeTxHash = options.feeTxHash || null;
  const positionId = options.positionId || null;
  const accountType = options.accountType || null;

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
    return;
  }

  if (accountType) {
    db.prepare(`
      UPDATE yield_positions SET
        status = 'closed',
        closed_at = datetime('now'),
        payout = ?,
        dev_fee_usdc = ?,
        withdraw_tx_hash = ?,
        fee_tx_hash = ?
      WHERE telegram_id = ? AND account_type = ? AND status = 'active'
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
  } catch {}
}

function updateAutoEarnSetting(telegramId, enabled) {
  db.prepare("UPDATE users SET auto_earn_enabled = ? WHERE telegram_id = ?").run(enabled ? 1 : 0, telegramId);
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
  const enc = (accountType === "business" && user.biz_system_encrypted_key)
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
  const NORMALIZE_AMOUNT = "CASE WHEN CAST(amount_micro AS REAL) > 0 AND CAST(amount_micro AS REAL) < 1e13 THEN CAST(amount_micro AS REAL) * 1e12 ELSE CAST(amount_micro AS REAL) END";

  function sumForTypes(types, since) {
    const placeholders = types.map(() => "?").join(", ");
    const sinceClause = since ? `AND datetime(created_at) >= datetime('now', '${since}')` : "";
    const row = db.prepare(`
      SELECT COALESCE(SUM(${NORMALIZE_AMOUNT}), 0) AS total,
             COUNT(*) AS count
      FROM transactions
      WHERE type IN (${placeholders}) AND status IN ${VALID_STATUSES}
      ${sinceClause}
    `).get(...types);
    return { count: row.count, usdc: row.total / MICRO };
  }

  function txBreakdown(types) {
    return {
      today:    sumForTypes(types, "-1 day"),
      week:     sumForTypes(types, "-7 days"),
      month:    sumForTypes(types, "-30 days"),
      allTime:  sumForTypes(types, null),
    };
  }

  const onramp   = txBreakdown(["deposit_naira", "onramp", "paj_onramp"]);
  const crypto   = txBreakdown(["deposit_crosschain", "crypto_deposit"]);
  const offramp  = txBreakdown(["offramp", "offramp_request", "payout"]);
  const sends    = txBreakdown(["send_usdc", "send_eurc", "autopay", "payment"]);
  const savings  = txBreakdown(["yield_deposit", "yield_withdraw", "auto_earn_liquidate", "auto_earn_deposit"]);
  const invoices = txBreakdown(["invoice_payment", "invoice"]);
  const swaps    = txBreakdown(["swap_usdc_eurc", "swap_eurc_usdc"]);

  // All-time totals across every confirmed tx (any type)
  const totalAllRow = db.prepare(`
    SELECT COALESCE(SUM(${NORMALIZE_AMOUNT}), 0) AS total, COUNT(*) AS count
    FROM transactions WHERE status IN ${VALID_STATUSES}
  `).get();

  // User growth
  const usersRow = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN datetime(created_at) >= datetime('now', '-1 day')  THEN 1 ELSE 0 END), 0) AS today,
      COALESCE(SUM(CASE WHEN datetime(created_at) >= datetime('now', '-7 days') THEN 1 ELSE 0 END), 0) AS week,
      COALESCE(SUM(CASE WHEN datetime(created_at) >= datetime('now', '-30 days') THEN 1 ELSE 0 END), 0) AS month
    FROM users
  `).get();

  const users = {
    total: usersRow?.total ?? 0,
    today: usersRow?.today ?? 0,
    week: usersRow?.week ?? 0,
    month: usersRow?.month ?? 0,
  };

  // Top 5 users by volume (all-time)
  const topUsers = db.prepare(`
    SELECT t.telegram_id,
           u.username,
           COALESCE(SUM(${NORMALIZE_AMOUNT}), 0) AS vol,
           COUNT(*) AS tx_count
    FROM transactions t
    LEFT JOIN users u ON u.telegram_id = t.telegram_id
    WHERE t.status IN ${VALID_STATUSES}
    GROUP BY t.telegram_id
    ORDER BY vol DESC LIMIT 5
  `).all().map(r => ({
    telegram_id: r.telegram_id,
    username: r.username ? `@${r.username}` : `user_${r.telegram_id}`,
    usdc: r.vol / MICRO,
    tx_count: r.tx_count,
  }));

  return {
    onramp,
    crypto,
    offramp,
    sends,
    savings,
    invoices,
    swaps,
    totalAll: { count: totalAllRow.count, usdc: totalAllRow.total / MICRO },
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

  try {
    // 1. Rescale legacy 6-decimal amounts in transactions (< 1e13)
    const lowRows = db.prepare(
      "SELECT id, amount_micro FROM transactions WHERE CAST(amount_micro AS REAL) > 0 AND CAST(amount_micro AS REAL) < 1e13"
    ).all();
    for (const row of lowRows) {
      try {
        const scaled = (BigInt(row.amount_micro) * 1_000_000_000_000n).toString();
        db.prepare("UPDATE transactions SET amount_micro = ? WHERE id = ?").run(scaled, row.id);
        fixedScale++;
      } catch {}
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
    } catch {}

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
    } catch {}

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
    } catch {}

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
    } catch {}
  } catch (scanErr) {
    console.warn("[db:reconcileLiveProductVolume] Error during live scan:", scanErr.message);
  }

  return { fixedScale, backfilledInvoices, backfilledPayments, backfilledYield, backfilledOnramp };
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

module.exports = {
  db,
  resolveDbPath,
  getUser,
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
  awardPoints,
  getPointsBalance,
  getPointsHistory,
  recordTransaction,
  updateTransactionStatus,
  getTransactions,
  getOpenYieldPosition,
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
  getIdleUsersForAutoEarn,
  getVolumeStats,
  reconcileLiveProductVolume,
  recordCctpPendingBurn,
  completeCctpPendingBurn,
  failCctpPendingBurn,
  getPendingCctpBurns,
  countPendingCctpBurns,
  _db: db,
  prepare: (...args) => db.prepare(...args),
  exec: (...args) => db.exec(...args),
};

// Automatically reconcile and sync volume on startup
try {
  reconcileLiveProductVolume();
} catch (startupErr) {
  console.warn("[db] Volume reconciliation on startup warning:", startupErr.message);
}