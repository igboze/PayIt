// src/solana_address.js
// Single source of truth for the Solana address PayIT gives to Paj (or any partner).
//
// RULE: the address must be derived from the user's CURRENT key. A stored DB column can go
// stale (for example after the custodial -> non-custodial switch). USDC sent to a stale
// address cannot be signed for by the bot, because the CCTP bridge only looks at the
// address derived from the current key.

const db = require("./db");
const walletLib = require("./wallet");
const multichain = require("./multichain");

// Old addresses are never deleted. They are archived here so stuck funds can be found and swept.
db.db.exec(`
  CREATE TABLE IF NOT EXISTS legacy_solana_addresses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id  TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'personal',
    address      TEXT NOT NULL,
    replaced_by  TEXT,
    replaced_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (telegram_id, account_type, address)
  );
`);

function readKey(user, isBiz, decryptedKey) {
  if (decryptedKey) return decryptedKey;
  const enc = isBiz ? user.biz_system_encrypted_key : user.system_encrypted_key;
  if (!enc) return null;
  try {
    return walletLib.decryptSensitiveValue(enc);
  } catch (err) {
    console.error(`[solana_address] Could not decrypt system key for TG:${user.telegram_id}:`, err.message);
    return null;
  }
}

/**
 * Pure lookup (no DB writes). Returns the Solana address derived from the user's current key,
 * or null when the key is not available (for example a legacy user who has not entered a PIN yet).
 */
function getDerivedSolanaAddress(user, { isBiz = false, decryptedKey = null } = {}) {
  if (!user) return null;
  const key = readKey(user, isBiz, decryptedKey);
  if (!key) return null;
  try {
    return multichain.deriveSolanaFromEvmKey(key).solanaAddress;
  } catch (err) {
    console.error(`[solana_address] Derivation failed for TG:${user.telegram_id}:`, err.message);
    return null;
  }
}

/**
 * Returns the address to give Paj. Always the derived address.
 * If the stored column differs, archive the old address and repair the column.
 * Returns null when no key is available. Callers must then refuse to create the order.
 */
function resolveSolanaRecipient(user, opts = {}) {
  const isBiz = Boolean(opts.isBiz);
  const derived = getDerivedSolanaAddress(user, opts);
  if (!derived) return null;

  const stored = isBiz ? user.biz_solana_deposit_address : user.solana_deposit_address;
  if (stored && stored !== derived) {
    console.error(
      `[solana_addr_mismatch] TG:${user.telegram_id} ${isBiz ? "business" : "personal"} stored=${stored} derived=${derived}. Archiving stored address.`
    );
    db.db
      .prepare(
        "INSERT OR IGNORE INTO legacy_solana_addresses (telegram_id, account_type, address, replaced_by) VALUES (?, ?, ?, ?)"
      )
      .run(String(user.telegram_id), isBiz ? "business" : "personal", stored, derived);
  }
  if (stored !== derived) {
    if (isBiz) db.updateBizSolanaAddress(user.telegram_id, derived);
    else db.updateSolanaAddress(user.telegram_id, derived);
    if (isBiz) user.biz_solana_deposit_address = derived;
    else user.solana_deposit_address = derived;
  }
  return derived;
}

/** Repair both accounts of one user. Called right after a successful PIN check. */
function reconcileUser(user) {
  if (!user) return;
  try {
    resolveSolanaRecipient(user, { isBiz: false });
    if (user.business_deposit_address) resolveSolanaRecipient(user, { isBiz: true });
  } catch (err) {
    console.warn("[solana_address] reconcileUser warning:", err.message);
  }
}

function getLegacySolanaAddresses(telegramId) {
  return db.db
    .prepare("SELECT * FROM legacy_solana_addresses WHERE telegram_id = ? ORDER BY id")
    .all(String(telegramId));
}

function getUserByLegacySolanaAddress(address) {
  if (!address) return null;
  const row = db.db
    .prepare("SELECT telegram_id FROM legacy_solana_addresses WHERE address = ? LIMIT 1")
    .get(address);
  return row ? db.getUser(row.telegram_id) : null;
}

async function alertAdmins(bot, text) {
  const ids = String(process.env.ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!bot || !bot.telegram) return;
  for (const id of ids) {
    try {
      await bot.telegram.sendMessage(id, text);
    } catch (_) {}
  }
}

module.exports = {
  getDerivedSolanaAddress,
  resolveSolanaRecipient,
  reconcileUser,
  getLegacySolanaAddresses,
  getUserByLegacySolanaAddress,
  alertAdmins,
};
