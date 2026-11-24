// src/app_api/store.js
// Persistence for mobile-app auth: devices, passkeys, refresh tokens, link codes,
// one-time challenges, sign-up sessions and push tokens. Uses the shared SQLite
// connection from src/db.js. Secrets (refresh tokens, link codes) are stored only
// as SHA-256 hashes.

const crypto = require("crypto");
const { db } = require("../db");

let _schemaReady = false;

function ensureAppSchema() {
  if (_schemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_devices (
      device_id         TEXT PRIMARY KEY,
      telegram_id       INTEGER NOT NULL,
      platform          TEXT NOT NULL,
      device_name       TEXT,
      integrity_verdict TEXT,
      push_token        TEXT,
      restricted_until  TEXT,
      revoked           INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_app_devices_user ON app_devices(telegram_id);

    CREATE TABLE IF NOT EXISTS passkey_credentials (
      credential_id  TEXT PRIMARY KEY,
      telegram_id    INTEGER NOT NULL,
      public_key     TEXT NOT NULL,
      counter        INTEGER NOT NULL DEFAULT 0,
      transports     TEXT,
      device_id      TEXT,
      revoked        INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkey_credentials(telegram_id);

    CREATE TABLE IF NOT EXISTS app_refresh_tokens (
      token_hash   TEXT PRIMARY KEY,
      telegram_id  INTEGER NOT NULL,
      device_id    TEXT NOT NULL,
      family_id    TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      used         INTEGER NOT NULL DEFAULT 0,
      revoked      INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_refresh_family ON app_refresh_tokens(family_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_user ON app_refresh_tokens(telegram_id);

    CREATE TABLE IF NOT EXISTS app_link_codes (
      code_hash    TEXT PRIMARY KEY,
      telegram_id  INTEGER NOT NULL,
      expires_at   TEXT NOT NULL,
      used         INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_challenges (
      challenge_id  TEXT PRIMARY KEY,
      challenge     TEXT NOT NULL,
      purpose       TEXT NOT NULL,
      telegram_id   INTEGER,
      action_hash   TEXT,
      action_json   TEXT,
      context_json  TEXT,
      expires_at    TEXT NOT NULL,
      used          INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_signups (
      signup_id     TEXT PRIMARY KEY,
      phone_number  TEXT NOT NULL,
      otp_pin_id    TEXT,
      otp_verified  INTEGER NOT NULL DEFAULT 0,
      reserved_id   INTEGER,
      device_id     TEXT NOT NULL,
      platform      TEXT NOT NULL,
      attempts      INTEGER NOT NULL DEFAULT 0,
      expires_at    TEXT NOT NULL,
      completed     INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  _schemaReady = true;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function isExpired(iso) {
  return !iso || Date.parse(iso) <= Date.now();
}

// ─── app-only user IDs ────────────────────────────────────────────────────────
// Telegram user IDs are always positive. App-only users get IDs from a reserved
// negative range so every existing telegram_id query keeps working unchanged.

function allocateAppUserId() {
  ensureAppSchema();
  for (let i = 0; i < 10; i++) {
    const candidate = -(1_000_000_000 + crypto.randomInt(0, 2 ** 31 - 1));
    const taken =
      db.prepare("SELECT 1 FROM users WHERE telegram_id = ?").get(candidate) ||
      db.prepare("SELECT 1 FROM app_signups WHERE reserved_id = ? AND completed = 0").get(candidate);
    if (!taken) return candidate;
  }
  throw new Error("Could not allocate a user ID");
}

function isAppOnlyUser(telegramId) {
  return Number(telegramId) < 0;
}

function findUserByPhone(phone) {
  return db.prepare("SELECT * FROM users WHERE phone_number = ? AND phone_verified = 1").get(String(phone)) || null;
}

function setUserPhone(telegramId, phone) {
  db.prepare("UPDATE users SET phone_number = ?, phone_verified = 1 WHERE telegram_id = ?").run(String(phone), Number(telegramId));
}

// ─── sign-up sessions ─────────────────────────────────────────────────────────

function createSignup({ phone, otpPinId, deviceId, platform }) {
  ensureAppSchema();
  const signupId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO app_signups (signup_id, phone_number, otp_pin_id, device_id, platform, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(signupId, String(phone), otpPinId || null, String(deviceId), String(platform), isoIn(15 * 60 * 1000));
  return signupId;
}

function getSignup(signupId) {
  ensureAppSchema();
  return db.prepare("SELECT * FROM app_signups WHERE signup_id = ?").get(String(signupId)) || null;
}

function updateSignup(signupId, fields) {
  const allowed = ["otp_verified", "reserved_id", "attempts", "completed"];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) throw new Error(`Invalid signup field: ${k}`);
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (!sets.length) return;
  vals.push(String(signupId));
  db.prepare(`UPDATE app_signups SET ${sets.join(", ")} WHERE signup_id = ?`).run(...vals);
}

// ─── challenges (WebAuthn registration / login / action approval) ─────────────

function createChallenge({ challenge, purpose, telegramId = null, action = null, context = null, ttlMs = 2 * 60 * 1000 }) {
  ensureAppSchema();
  const challengeId = crypto.randomUUID();
  const actionJson = action ? JSON.stringify(action) : null;
  db.prepare(`
    INSERT INTO app_challenges (challenge_id, challenge, purpose, telegram_id, action_hash, action_json, context_json, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    challengeId, String(challenge), String(purpose),
    telegramId === null ? null : Number(telegramId),
    actionJson ? sha256(actionJson) : null,
    actionJson,
    context ? JSON.stringify(context) : null,
    isoIn(ttlMs)
  );
  return challengeId;
}

/**
 * Atomically claims a challenge: returns it only if it exists, matches the purpose,
 * is unexpired and unused, and marks it used in the same step (single use).
 */
function consumeChallenge(challengeId, purpose) {
  ensureAppSchema();
  const row = db.prepare("SELECT * FROM app_challenges WHERE challenge_id = ?").get(String(challengeId));
  if (!row || row.purpose !== purpose || row.used || isExpired(row.expires_at)) return null;
  const res = db.prepare("UPDATE app_challenges SET used = 1 WHERE challenge_id = ? AND used = 0").run(String(challengeId));
  if (!res.changes) return null;
  return {
    ...row,
    action: row.action_json ? JSON.parse(row.action_json) : null,
    context: row.context_json ? JSON.parse(row.context_json) : null,
  };
}

// ─── passkeys ─────────────────────────────────────────────────────────────────

function savePasskey({ credentialId, telegramId, publicKey, counter, transports, deviceId }) {
  ensureAppSchema();
  db.prepare(`
    INSERT INTO passkey_credentials (credential_id, telegram_id, public_key, counter, transports, device_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    String(credentialId), Number(telegramId), String(publicKey), Number(counter || 0),
    transports ? JSON.stringify(transports) : null, deviceId || null
  );
}

function getPasskey(credentialId) {
  ensureAppSchema();
  const row = db.prepare("SELECT * FROM passkey_credentials WHERE credential_id = ? AND revoked = 0").get(String(credentialId));
  if (!row) return null;
  return { ...row, transports: row.transports ? JSON.parse(row.transports) : undefined };
}

function listPasskeys(telegramId) {
  ensureAppSchema();
  return db.prepare("SELECT credential_id, device_id, created_at, last_used_at FROM passkey_credentials WHERE telegram_id = ? AND revoked = 0 ORDER BY created_at DESC").all(Number(telegramId));
}

function updatePasskeyCounter(credentialId, counter) {
  db.prepare("UPDATE passkey_credentials SET counter = ?, last_used_at = datetime('now') WHERE credential_id = ?").run(Number(counter || 0), String(credentialId));
}

// ─── devices ──────────────────────────────────────────────────────────────────

const NEW_DEVICE_RESTRICTION_MS = Number(process.env.APP_NEW_DEVICE_RESTRICTION_MS || 24 * 60 * 60 * 1000);

/**
 * Registers or refreshes a device for a user. Returns { device, isNew }.
 * A device seen for the first time on this user is restricted for 24 hours, unless it is
 * the user's very first device (the account was just created or linked on it).
 */
function upsertDevice({ deviceId, telegramId, platform, deviceName = null, integrityVerdict = null }) {
  ensureAppSchema();
  const existing = db.prepare("SELECT * FROM app_devices WHERE device_id = ?").get(String(deviceId));
  if (existing && Number(existing.telegram_id) !== Number(telegramId)) {
    throw Object.assign(new Error("This device is registered to another account."), { status: 409, code: "device_owned_elsewhere" });
  }
  if (existing) {
    if (existing.revoked) {
      throw Object.assign(new Error("This device was removed from the account."), { status: 403, code: "device_revoked" });
    }
    db.prepare("UPDATE app_devices SET last_seen_at = datetime('now'), integrity_verdict = COALESCE(?, integrity_verdict), device_name = COALESCE(?, device_name) WHERE device_id = ?")
      .run(integrityVerdict, deviceName, String(deviceId));
    return { device: getDevice(deviceId), isNew: false };
  }
  const priorDevices = db.prepare("SELECT COUNT(*) AS c FROM app_devices WHERE telegram_id = ?").get(Number(telegramId)).c;
  const restrictedUntil = priorDevices > 0 ? isoIn(NEW_DEVICE_RESTRICTION_MS) : null;
  db.prepare(`
    INSERT INTO app_devices (device_id, telegram_id, platform, device_name, integrity_verdict, restricted_until)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(String(deviceId), Number(telegramId), String(platform), deviceName, integrityVerdict, restrictedUntil);
  return { device: getDevice(deviceId), isNew: true, firstDevice: priorDevices === 0 };
}

function getDevice(deviceId) {
  ensureAppSchema();
  return db.prepare("SELECT * FROM app_devices WHERE device_id = ?").get(String(deviceId)) || null;
}

function listDevices(telegramId) {
  ensureAppSchema();
  return db.prepare("SELECT device_id, platform, device_name, restricted_until, created_at, last_seen_at FROM app_devices WHERE telegram_id = ? AND revoked = 0 ORDER BY last_seen_at DESC").all(Number(telegramId));
}

function isDeviceRestricted(device) {
  return !!(device && device.restricted_until && !isExpired(device.restricted_until));
}

function revokeDevice(deviceId) {
  ensureAppSchema();
  db.prepare("UPDATE app_devices SET revoked = 1, push_token = NULL WHERE device_id = ?").run(String(deviceId));
  db.prepare("UPDATE passkey_credentials SET revoked = 1 WHERE device_id = ?").run(String(deviceId));
  db.prepare("UPDATE app_refresh_tokens SET revoked = 1 WHERE device_id = ?").run(String(deviceId));
}

function setPushToken(deviceId, pushToken) {
  ensureAppSchema();
  db.prepare("UPDATE app_devices SET push_token = ? WHERE device_id = ?").run(pushToken ? String(pushToken) : null, String(deviceId));
}

function getPushTokens(telegramId) {
  ensureAppSchema();
  return db.prepare("SELECT device_id, push_token FROM app_devices WHERE telegram_id = ? AND revoked = 0 AND push_token IS NOT NULL").all(Number(telegramId));
}

// ─── refresh tokens (rotation + reuse detection) ──────────────────────────────

const REFRESH_TTL_MS = Number(process.env.APP_REFRESH_TTL_MS || 30 * 24 * 60 * 60 * 1000);

function issueRefreshToken({ telegramId, deviceId, familyId = null }) {
  ensureAppSchema();
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare(`
    INSERT INTO app_refresh_tokens (token_hash, telegram_id, device_id, family_id, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sha256(token), Number(telegramId), String(deviceId), familyId || crypto.randomUUID(), isoIn(REFRESH_TTL_MS));
  return token;
}

/**
 * Rotates a refresh token. Returns { telegramId, deviceId, refreshToken } on success.
 * Presenting a token that was already used revokes every session the user has
 * (a stolen token is being replayed) and returns { reuse: true }.
 */
function rotateRefreshToken(token, deviceId) {
  ensureAppSchema();
  const row = db.prepare("SELECT * FROM app_refresh_tokens WHERE token_hash = ?").get(sha256(token));
  if (!row) return null;
  if (row.used) {
    revokeAllSessions(row.telegram_id);
    return { reuse: true, telegramId: row.telegram_id };
  }
  if (row.revoked || isExpired(row.expires_at) || String(row.device_id) !== String(deviceId)) return null;
  const device = getDevice(row.device_id);
  if (!device || device.revoked) return null;
  const res = db.prepare("UPDATE app_refresh_tokens SET used = 1 WHERE token_hash = ? AND used = 0").run(row.token_hash);
  if (!res.changes) {
    revokeAllSessions(row.telegram_id);
    return { reuse: true, telegramId: row.telegram_id };
  }
  const refreshToken = issueRefreshToken({ telegramId: row.telegram_id, deviceId: row.device_id, familyId: row.family_id });
  return { telegramId: row.telegram_id, deviceId: row.device_id, refreshToken };
}

function revokeDeviceSessions(deviceId) {
  ensureAppSchema();
  db.prepare("UPDATE app_refresh_tokens SET revoked = 1 WHERE device_id = ?").run(String(deviceId));
}

function revokeAllSessions(telegramId) {
  ensureAppSchema();
  db.prepare("UPDATE app_refresh_tokens SET revoked = 1 WHERE telegram_id = ?").run(Number(telegramId));
  bumpSessionEpoch(telegramId);
}

// Access tokens are stateless; bumping the epoch invalidates every one already issued.
function getSessionEpoch(telegramId) {
  ensureAppSchema();
  db.exec("CREATE TABLE IF NOT EXISTS app_session_epochs (telegram_id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0)");
  const row = db.prepare("SELECT epoch FROM app_session_epochs WHERE telegram_id = ?").get(Number(telegramId));
  return row ? Number(row.epoch) : 0;
}

function bumpSessionEpoch(telegramId) {
  getSessionEpoch(telegramId);
  db.prepare(`
    INSERT INTO app_session_epochs (telegram_id, epoch) VALUES (?, 1)
    ON CONFLICT(telegram_id) DO UPDATE SET epoch = epoch + 1
  `).run(Number(telegramId));
}

// ─── link codes (existing Telegram users) ─────────────────────────────────────

const LINK_CODE_TTL_MS = 5 * 60 * 1000;

function createLinkCode(telegramId) {
  ensureAppSchema();
  // Unambiguous alphabet: no 0/O or 1/I/L.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 10; i++) code += alphabet[crypto.randomInt(0, alphabet.length)];
  db.prepare("UPDATE app_link_codes SET used = 1 WHERE telegram_id = ? AND used = 0").run(Number(telegramId));
  db.prepare("INSERT INTO app_link_codes (code_hash, telegram_id, expires_at) VALUES (?, ?, ?)")
    .run(sha256(code), Number(telegramId), isoIn(LINK_CODE_TTL_MS));
  return { code, expiresInSec: LINK_CODE_TTL_MS / 1000 };
}

/** Looks up a valid link code without consuming it. */
function peekLinkCode(code) {
  ensureAppSchema();
  const row = db.prepare("SELECT * FROM app_link_codes WHERE code_hash = ?").get(sha256(String(code).trim().toUpperCase()));
  if (!row || row.used || isExpired(row.expires_at)) return null;
  return row;
}

function consumeLinkCode(code) {
  ensureAppSchema();
  const hash = sha256(String(code).trim().toUpperCase());
  const row = db.prepare("SELECT * FROM app_link_codes WHERE code_hash = ?").get(hash);
  if (!row || row.used || isExpired(row.expires_at)) return null;
  const res = db.prepare("UPDATE app_link_codes SET used = 1 WHERE code_hash = ? AND used = 0").run(hash);
  return res.changes ? row : null;
}

module.exports = {
  ensureAppSchema,
  sha256,
  allocateAppUserId,
  isAppOnlyUser,
  findUserByPhone,
  setUserPhone,
  createSignup,
  getSignup,
  updateSignup,
  createChallenge,
  consumeChallenge,
  savePasskey,
  getPasskey,
  listPasskeys,
  updatePasskeyCounter,
  upsertDevice,
  getDevice,
  listDevices,
  isDeviceRestricted,
  revokeDevice,
  setPushToken,
  getPushTokens,
  issueRefreshToken,
  rotateRefreshToken,
  revokeDeviceSessions,
  revokeAllSessions,
  getSessionEpoch,
  bumpSessionEpoch,
  createLinkCode,
  peekLinkCode,
  consumeLinkCode,
};
