// src/app_api/integrity.js
// App integrity checks: proves a request comes from the genuine Proxim app on a real,
// unmodified device — not an emulator, a rooted phone or a script calling the API.
//
// APP_INTEGRITY_MODE = off | log | enforce   (default: log)
//   off      no checks
//   log      checks run and verdicts are recorded, but nothing is blocked
//   enforce  requests without a verified token are rejected
//
// Android: Google Play Integrity, verified server-side (needs GOOGLE_SERVICE_ACCOUNT_JSON
//          and APP_ANDROID_PACKAGE).
// iOS:     Apple App Attest verification is NOT implemented yet. APP_INTEGRITY_IOS_MODE
//          (default: log) governs iOS separately so enforce mode can be turned on for
//          Android first. Setting it to enforce rejects every iOS request until App Attest
//          verification is built.

const axios = require("axios");
const { getGoogleAccessToken, getServiceAccount } = require("./google_auth");

function getMode(platform) {
  const base = String(process.env.APP_INTEGRITY_MODE || "log").toLowerCase();
  if (platform === "ios") return String(process.env.APP_INTEGRITY_IOS_MODE || (base === "enforce" ? "log" : base)).toLowerCase();
  return base;
}

async function verifyAndroid(token) {
  const pkg = (process.env.APP_ANDROID_PACKAGE || "").trim();
  if (!pkg || !getServiceAccount()) return { verdict: "unverified", reason: "play_integrity_not_configured" };
  const accessToken = await getGoogleAccessToken("https://www.googleapis.com/auth/playintegrity");
  const res = await axios.post(
    `https://playintegrity.googleapis.com/v1/${encodeURIComponent(pkg)}:decodeIntegrityToken`,
    { integrity_token: token },
    { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
  );
  const p = res.data?.tokenPayloadExternal || {};
  const ageMs = Date.now() - Number(p.requestDetails?.timestampMillis || 0);
  const deviceVerdicts = p.deviceIntegrity?.deviceRecognitionVerdict || [];
  if (p.requestDetails?.requestPackageName !== pkg) return { verdict: "failed", reason: "wrong_package" };
  if (!(ageMs >= 0 && ageMs < 5 * 60 * 1000)) return { verdict: "failed", reason: "stale_token" };
  if (p.appIntegrity?.appRecognitionVerdict !== "PLAY_RECOGNIZED") return { verdict: "failed", reason: "app_not_recognized" };
  if (!deviceVerdicts.includes("MEETS_DEVICE_INTEGRITY")) return { verdict: "failed", reason: "device_integrity" };
  return { verdict: "verified" };
}

/**
 * Checks an integrity token. Returns { allowed, verdict, reason }.
 * `allowed` is false only in enforce mode when the token is missing, invalid or unverifiable.
 */
async function checkIntegrity({ platform, token }) {
  const plat = String(platform || "").toLowerCase();
  const mode = getMode(plat);
  if (mode === "off") return { allowed: true, verdict: "skipped" };
  if (!["ios", "android"].includes(plat)) {
    return { allowed: mode !== "enforce", verdict: "failed", reason: "unknown_platform" };
  }

  let result;
  try {
    if (!token) result = { verdict: "failed", reason: "missing_token" };
    else if (plat === "android") result = await verifyAndroid(String(token));
    else result = { verdict: "unverified", reason: "app_attest_not_implemented" };
  } catch (err) {
    result = { verdict: "unverified", reason: `verifier_error: ${err.message}` };
  }

  if (result.verdict !== "verified") {
    console.warn(`[app_integrity] ${plat} verdict=${result.verdict} reason=${result.reason} mode=${mode}`);
  }
  const allowed = mode !== "enforce" || result.verdict === "verified";
  return { allowed, ...result };
}

module.exports = { checkIntegrity, getMode };
