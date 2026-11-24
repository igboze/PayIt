// src/app_api/google_auth.js
// OAuth access tokens for a Google service account (used by Play Integrity and FCM),
// signed with Node's crypto. Credentials come from GOOGLE_SERVICE_ACCOUNT_JSON
// (the full JSON key file contents) — never committed to the repo.

const crypto = require("crypto");
const axios = require("axios");

const _cache = new Map(); // scope -> { token, expiresAt }

function getServiceAccount() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.client_email || !parsed.private_key) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

async function getGoogleAccessToken(scope) {
  const sa = getServiceAccount();
  if (!sa) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not configured");
  const cached = _cache.get(scope);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
    iss: sa.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), sa.private_key).toString("base64url");
  const res = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 }
  );
  const token = res.data.access_token;
  _cache.set(scope, { token, expiresAt: Date.now() + Number(res.data.expires_in || 3600) * 1000 });
  return token;
}

module.exports = { getServiceAccount, getGoogleAccessToken };
