// src/app_api/tokens.js
// Short-lived access tokens (JWT, HS256) for the mobile app. Implemented with Node's
// crypto to avoid an extra dependency. Each token carries the user's session epoch:
// bumping the epoch (see store.revokeAllSessions) invalidates every token already issued.

const crypto = require("crypto");
const store = require("./store");

const ACCESS_TTL_SEC = Number(process.env.APP_ACCESS_TTL_SEC || 15 * 60);
const ISSUER = "proxim-app";

function getSecret() {
  const secret = (process.env.APP_JWT_SECRET || "").trim();
  if (secret.length < 32) {
    throw new Error("APP_JWT_SECRET must be set to a random value of at least 32 characters.");
  }
  return secret;
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function sign(data) {
  return crypto.createHmac("sha256", getSecret()).update(data).digest("base64url");
}

function issueAccessToken({ telegramId, deviceId }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({
    iss: ISSUER,
    sub: String(telegramId),
    did: String(deviceId),
    ep: store.getSessionEpoch(telegramId),
    iat: now,
    exp: now + ACCESS_TTL_SEC,
  });
  return { accessToken: `${header}.${payload}.${sign(`${header}.${payload}`)}`, expiresIn: ACCESS_TTL_SEC };
}

/** Returns { telegramId, deviceId } or null if the token is invalid, expired or revoked. */
function verifyAccessToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let claims;
  try {
    const head = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    if (head.alg !== "HS256") return null;
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (_) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== ISSUER || !claims.exp || claims.exp <= now) return null;
  const telegramId = Number(claims.sub);
  if (!Number.isSafeInteger(telegramId)) return null;
  if (Number(claims.ep) !== store.getSessionEpoch(telegramId)) return null;
  const device = store.getDevice(claims.did);
  if (!device || device.revoked || Number(device.telegram_id) !== telegramId) return null;
  return { telegramId, deviceId: String(claims.did) };
}

function issueSession({ telegramId, deviceId }) {
  const { accessToken, expiresIn } = issueAccessToken({ telegramId, deviceId });
  const refreshToken = store.issueRefreshToken({ telegramId, deviceId });
  return { accessToken, refreshToken, expiresIn };
}

// Short-lived signed receipt links, so a receipt can open in a browser (no auth header)
// on app builds that can't download and share the file themselves.
function receiptSig(telegramId, txId, exp) {
  return sign(`receipt:${Number(telegramId)}:${Number(txId)}:${Number(exp)}`);
}

function signReceiptLink(telegramId, txId, ttlSec = 10 * 60) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return { u: String(Number(telegramId)), e: String(exp), s: receiptSig(telegramId, txId, exp) };
}

function verifyReceiptLink(u, txId, e, s) {
  const exp = Number(e);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000) || !/^-?\d+$/.test(String(u || ""))) return false;
  const want = Buffer.from(receiptSig(u, txId, exp));
  const got = Buffer.from(String(s || ""));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// Short-lived signed invoice PNG links for one-tap download/share in browser or native share sheet.
function invoiceSig(telegramId, scope, invoiceId, exp) {
  return sign(`invoice:${Number(telegramId)}:${String(scope)}:${Number(invoiceId)}:${Number(exp)}`);
}

function signInvoiceLink(telegramId, scope, invoiceId, ttlSec = 10 * 60) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return { u: String(Number(telegramId)), e: String(exp), s: invoiceSig(telegramId, scope, invoiceId, exp) };
}

function verifyInvoiceLink(u, scope, invoiceId, e, s) {
  const exp = Number(e);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000) || !/^-?\d+$/.test(String(u || ""))) return false;
  if (scope !== "personal" && scope !== "business") return false;
  const want = Buffer.from(invoiceSig(u, scope, invoiceId, exp));
  const got = Buffer.from(String(s || ""));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

module.exports = {
  issueAccessToken,
  verifyAccessToken,
  issueSession,
  getSecret,
  signReceiptLink,
  verifyReceiptLink,
  signInvoiceLink,
  verifyInvoiceLink,
};
