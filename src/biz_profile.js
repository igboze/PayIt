// src/biz_profile.js
// Business profile — collected during Business account onboarding and used
// by the invoice generator so every invoice carries real business branding.
//
// Fields:
//   business_name     — appears as invoice sender / header
//   business_email    — appears in invoice footer
//   phone             — optional, invoice footer
//   address           — optional, invoice footer
//   logo_path         — local path to resized PNG logo (80x80)
//   default_due_days  — e.g. 14 → "Due in 14 days" becomes the default
//   currency_display  — "USDC" (default) — future: allow EURC
//   created_at / updated_at

let _db = null;
function getDb() {
  if (!_db) _db = require("./db").db;
  return _db;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

function initBizProfileTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS biz_profile (
      telegram_id       INTEGER PRIMARY KEY,
      business_name     TEXT    NOT NULL,
      business_email    TEXT,
      phone             TEXT,
      address           TEXT,
      logo_path         TEXT,
      default_due_days  INTEGER NOT NULL DEFAULT 14,
      currency_display  TEXT    NOT NULL DEFAULT 'USDC',
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Create or fully replace a business profile.
 */
function upsertBizProfile(telegramId, {
  businessName,
  businessEmail = null,
  phone         = null,
  address       = null,
  logoPath      = null,
  defaultDueDays = 14,
  currencyDisplay = "USDC",
}) {
  getDb().prepare(`
    INSERT INTO biz_profile
      (telegram_id, business_name, business_email, phone, address, logo_path, default_due_days, currency_display, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(telegram_id) DO UPDATE SET
      business_name    = excluded.business_name,
      business_email   = excluded.business_email,
      phone            = excluded.phone,
      address          = excluded.address,
      logo_path        = COALESCE(excluded.logo_path, logo_path),
      default_due_days = excluded.default_due_days,
      currency_display = excluded.currency_display,
      updated_at       = datetime('now')
  `).run(
    Number(telegramId),
    businessName,
    businessEmail,
    phone,
    address,
    logoPath,
    defaultDueDays,
    currencyDisplay
  );
}

/**
 * Update a single field in the business profile.
 * fieldName must be one of the allowed column names (whitelist checked).
 */
const ALLOWED_FIELDS = new Set([
  "business_name", "business_email", "phone",
  "address", "logo_path", "default_due_days", "currency_display",
]);

function updateBizProfileField(telegramId, fieldName, value) {
  if (!ALLOWED_FIELDS.has(fieldName)) {
    throw new Error(`[biz_profile] Invalid field: ${fieldName}`);
  }
  getDb().prepare(`
    UPDATE biz_profile
    SET ${fieldName} = ?, updated_at = datetime('now')
    WHERE telegram_id = ?
  `).run(value, Number(telegramId));
}

/**
 * Retrieve the business profile for a user.
 * Returns null if no profile has been created yet.
 */
function getBizProfile(telegramId) {
  return getDb()
    .prepare("SELECT * FROM biz_profile WHERE telegram_id = ?")
    .get(Number(telegramId)) || null;
}

/**
 * Check whether a business profile exists.
 */
function hasBizProfile(telegramId) {
  const row = getDb()
    .prepare("SELECT telegram_id FROM biz_profile WHERE telegram_id = ?")
    .get(Number(telegramId));
  return !!row;
}

/**
 * Delete a business profile (e.g. account reset).
 */
function deleteBizProfile(telegramId) {
  getDb()
    .prepare("DELETE FROM biz_profile WHERE telegram_id = ?")
    .run(Number(telegramId));
}

// ─── Logo helpers ─────────────────────────────────────────────────────────────
// Logo images are downloaded from Telegram, resized to 80x80 PNG via sharp,
// and stored at data/logos/<telegramId>.png.
// The path returned here is what gets stored in logo_path.

const path = require("path");
const fs   = require("fs");

function logoStoragePath(telegramId) {
  const dir = path.join(__dirname, "../data/logos");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${telegramId}.png`);
}

/**
 * Resize an image buffer to 80x80 PNG and save to the logo storage path.
 * Returns the saved file path.
 *
 * @param {number} telegramId
 * @param {Buffer} imageBuffer  - raw image data downloaded from Telegram
 */
async function saveLogo(telegramId, imageBuffer) {
  const sharp  = require("sharp");
  const outPath = logoStoragePath(telegramId);
  await sharp(imageBuffer)
    .resize(80, 80, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png()
    .toFile(outPath);
  return outPath;
}

/**
 * Read logo as base64 data URI for SVG embedding.
 * Returns null if no logo is stored.
 */
function getLogoDataUri(telegramId) {
  const p = logoStoragePath(telegramId);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

module.exports = {
  initBizProfileTable,
  upsertBizProfile,
  updateBizProfileField,
  getBizProfile,
  hasBizProfile,
  deleteBizProfile,
  saveLogo,
  getLogoDataUri,
  logoStoragePath,
};
