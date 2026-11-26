// src/app_api/avatars.js
// Profile photos for app users. Uploads are decoded and re-encoded with sharp into a small
// square JPEG, which both shrinks them and strips anything that isn't image data (EXIF,
// location, embedded payloads). Only the owner can fetch their photo.

const { db } = require("../db");

const SIZE = 320;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
let _ready = false;

function ensureTable() {
  if (_ready) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_avatars (
      telegram_id INTEGER PRIMARY KEY,
      mime        TEXT NOT NULL,
      data        BLOB NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  _ready = true;
}

class AvatarError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Accepts base64 (optionally a data: URL) of a JPEG/PNG/WebP/HEIC photo; stores a 320px JPEG. */
async function saveAvatar(telegramId, imageBase64) {
  ensureTable();
  const raw = String(imageBase64 || "").replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "").replace(/\s+/g, "");
  if (!raw || !/^[A-Za-z0-9+/]+=*$/.test(raw)) throw new AvatarError(400, "invalid_image", "Choose a photo to upload.");
  const input = Buffer.from(raw, "base64");
  if (input.length > MAX_UPLOAD_BYTES) throw new AvatarError(413, "image_too_large", "That photo is too large. Pick one under 4 MB.");

  const sharp = require("sharp");
  let meta;
  try {
    meta = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
  } catch (_) {
    throw new AvatarError(400, "invalid_image", "That file isn't a photo we can use.");
  }
  if (!["jpeg", "png", "webp", "heif", "avif"].includes(String(meta.format))) {
    throw new AvatarError(400, "invalid_image", "Use a JPEG, PNG or HEIC photo.");
  }
  const out = await sharp(input, { limitInputPixels: 40_000_000 })
    .rotate() // respect the phone's orientation, then drop metadata
    .resize(SIZE, SIZE, { fit: "cover", position: "attention" })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  db.prepare(`
    INSERT INTO app_avatars (telegram_id, mime, data, updated_at) VALUES (?, 'image/jpeg', ?, datetime('now'))
    ON CONFLICT(telegram_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at
  `).run(Number(telegramId), out);
  return getAvatarVersion(telegramId);
}

function getAvatar(telegramId) {
  ensureTable();
  return db.prepare("SELECT mime, data, updated_at FROM app_avatars WHERE telegram_id = ?").get(Number(telegramId)) || null;
}

/** Changes whenever the photo changes, so the app can refresh its cached copy. */
function getAvatarVersion(telegramId) {
  try {
    ensureTable();
    const row = db.prepare("SELECT updated_at FROM app_avatars WHERE telegram_id = ?").get(Number(telegramId));
    return row ? String(row.updated_at) : null;
  } catch (_) {
    return null;
  }
}

function deleteAvatar(telegramId) {
  ensureTable();
  return db.prepare("DELETE FROM app_avatars WHERE telegram_id = ?").run(Number(telegramId)).changes > 0;
}

module.exports = { saveAvatar, getAvatar, getAvatarVersion, deleteAvatar, AvatarError, MAX_UPLOAD_BYTES };
