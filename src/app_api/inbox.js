// src/app_api/inbox.js
// In-app notification inbox. notify() stores every message here as well as sending it by
// Telegram and push, so app users always see what happened even when push isn't set up
// or a push was missed.

const { db } = require("../db");

const KEEP_PER_USER = 200;
let _ready = false;

function ensureTable() {
  if (_ready) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_notifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      kind        TEXT,
      data_json   TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      read_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_app_notifications_user ON app_notifications(telegram_id, id);
  `);
  _ready = true;
}

function addNotification(telegramId, { title, body, data = {} }) {
  ensureTable();
  const tg = Number(telegramId);
  if (!Number.isFinite(tg)) return null;
  const res = db
    .prepare("INSERT INTO app_notifications (telegram_id, title, body, kind, data_json) VALUES (?, ?, ?, ?, ?)")
    .run(tg, String(title || "Proxim").slice(0, 120), String(body || "").slice(0, 600), data?.type ? String(data.type) : null, JSON.stringify(data || {}));
  // Keep the inbox bounded.
  db.prepare(
    "DELETE FROM app_notifications WHERE telegram_id = ? AND id NOT IN (SELECT id FROM app_notifications WHERE telegram_id = ? ORDER BY id DESC LIMIT ?)"
  ).run(tg, tg, KEEP_PER_USER);
  return Number(res.lastInsertRowid);
}

function listNotifications(telegramId, { limit = 50, afterId = 0 } = {}) {
  ensureTable();
  const tg = Number(telegramId);
  const rows = db
    .prepare("SELECT * FROM app_notifications WHERE telegram_id = ? AND id > ? ORDER BY id DESC LIMIT ?")
    .all(tg, Number(afterId) || 0, Math.min(Math.max(Number(limit) || 50, 1), 100));
  const unread = db.prepare("SELECT COUNT(*) AS n FROM app_notifications WHERE telegram_id = ? AND read_at IS NULL").get(tg)?.n || 0;
  return {
    unread: Number(unread),
    notifications: rows.map((r) => {
      let data = {};
      try { data = JSON.parse(r.data_json || "{}"); } catch (_) {}
      return { id: Number(r.id), title: r.title, body: r.body, kind: r.kind, data, createdAt: r.created_at, read: Boolean(r.read_at) };
    }),
  };
}

function markRead(telegramId, ids = null) {
  ensureTable();
  const tg = Number(telegramId);
  if (Array.isArray(ids) && ids.length) {
    const clean = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
    if (!clean.length) return 0;
    return db
      .prepare(`UPDATE app_notifications SET read_at = datetime('now') WHERE telegram_id = ? AND read_at IS NULL AND id IN (${clean.map(() => "?").join(",")})`)
      .run(tg, ...clean).changes;
  }
  return db.prepare("UPDATE app_notifications SET read_at = datetime('now') WHERE telegram_id = ? AND read_at IS NULL").run(tg).changes;
}

module.exports = { addNotification, listNotifications, markRead };
