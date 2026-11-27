// src/app_api/google_auth.js
// Zero-dependency cryptographic Google ID Token (OIDC / RS256) verifier using Node's native crypto
// and Google's live JWKS endpoint (https://www.googleapis.com/oauth2/v3/certs).

const crypto = require("crypto");

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const VALID_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

let _jwksCache = { keys: null, expiresAt: 0 };
let _testVerifier = null;

function __setTestVerifier(fn) {
  _testVerifier = typeof fn === "function" ? fn : null;
}

function getAllowedGoogleClientIds() {
  const raw = [
    process.env.GOOGLE_WEB_CLIENT_ID || "",
    process.env.GOOGLE_IOS_CLIENT_ID || "",
    process.env.GOOGLE_ANDROID_CLIENT_ID || "",
    process.env.GOOGLE_CLIENT_IDS || "",
  ]
    .join(",")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(raw)];
}

function getPrimaryGoogleWebClientId() {
  const explicit = String(process.env.GOOGLE_WEB_CLIENT_ID || "").trim();
  if (explicit) return explicit;
  const all = getAllowedGoogleClientIds();
  return all[0] || null;
}

function base64UrlToBuffer(str) {
  const normalized = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, "base64");
}

async function fetchGoogleJwks(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _jwksCache.keys && now < _jwksCache.expiresAt) {
    return _jwksCache.keys;
  }
  const res = await fetch(GOOGLE_JWKS_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`Google JWKS fetch failed (HTTP ${res.status})`);
  }
  const body = await res.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  if (!keys.length) {
    throw new Error("Google JWKS returned no signing keys");
  }
  const cacheControl = String(res.headers.get("cache-control") || "");
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const ttlMs = maxAgeMatch ? Math.max(60, Math.min(86400, Number(maxAgeMatch[1]))) * 1000 : 3600 * 1000;
  _jwksCache = { keys, expiresAt: now + ttlMs };
  return keys;
}

/**
 * Cryptographically verifies a Google OIDC ID Token and returns normalized identity fields.
 * Throws an Error with `.code` if invalid, expired, unverified email, or wrong audience.
 */
async function verifyGoogleIdToken(idToken, { allowedClientIds = null } = {}) {
  if (_testVerifier) {
    return _testVerifier(idToken, { allowedClientIds });
  }

  const raw = String(idToken || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3) {
    const err = new Error("Invalid Google sign-in token format.");
    err.code = "google_token_invalid";
    throw err;
  }

  const audiences = Array.isArray(allowedClientIds) && allowedClientIds.length
    ? allowedClientIds
    : getAllowedGoogleClientIds();
  if (!audiences.length) {
    const err = new Error("Google Sign-In is not configured on this server yet.");
    err.code = "google_not_configured";
    throw err;
  }

  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlToBuffer(parts[0]).toString("utf8"));
    payload = JSON.parse(base64UrlToBuffer(parts[1]).toString("utf8"));
  } catch (_) {
    const err = new Error("Malformed Google sign-in token.");
    err.code = "google_token_invalid";
    throw err;
  }

  if (header?.alg !== "RS256" || !header?.kid) {
    const err = new Error("Unsupported Google token algorithm.");
    err.code = "google_token_invalid";
    throw err;
  }

  // Lookup Google signing key by kid (refresh cache once on miss for key rotation)
  let keys = await fetchGoogleJwks(false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await fetchGoogleJwks(true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) {
    const err = new Error("Google signing key not found.");
    err.code = "google_token_invalid";
    throw err;
  }

  // Verify RS256 cryptographic signature
  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
  const signature = base64UrlToBuffer(parts[2]);
  const sigOk = crypto.verify("RSA-SHA256", signingInput, publicKey, signature);
  if (!sigOk) {
    const err = new Error("Google token signature verification failed.");
    err.code = "google_token_invalid";
    throw err;
  }

  // Validate claims
  const nowSec = Math.floor(Date.now() / 1000);
  if (!VALID_ISSUERS.has(String(payload.iss || ""))) {
    const err = new Error("Invalid Google token issuer.");
    err.code = "google_token_invalid";
    throw err;
  }
  if (!audiences.includes(String(payload.aud || ""))) {
    const err = new Error("Google token audience does not match this app.");
    err.code = "google_token_invalid";
    throw err;
  }
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) < nowSec - 60) {
    const err = new Error("Google sign-in session expired. Please try again.");
    err.code = "google_token_expired";
    throw err;
  }

  const email = String(payload.email || "").trim().toLowerCase();
  const emailVerified = payload.email_verified === true || payload.email_verified === "true";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !emailVerified) {
    const err = new Error("Your Google account must have a verified email address.");
    err.code = "google_email_unverified";
    throw err;
  }

  const sub = String(payload.sub || "").trim();
  if (!sub) {
    const err = new Error("Google token missing subject identifier.");
    err.code = "google_token_invalid";
    throw err;
  }

  const name = typeof payload.name === "string"
    ? payload.name.replace(/[<>&]/g, "").trim().slice(0, 80)
    : null;

  return {
    sub,
    email,
    name: name || null,
    picture: typeof payload.picture === "string" ? payload.picture : null,
  };
}

module.exports = {
  verifyGoogleIdToken,
  getAllowedGoogleClientIds,
  getPrimaryGoogleWebClientId,
  __setTestVerifier,
};
