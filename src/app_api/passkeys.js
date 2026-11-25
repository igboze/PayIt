// src/app_api/passkeys.js
// WebAuthn (passkey) registration, login and action approval, on top of
// @simplewebauthn/server. The relying-party domain comes from the environment so the
// final Proxim domain can be set without code changes:
//   APP_RP_ID        e.g. proxim.app            (must be the domain serving /.well-known files)
//   APP_RP_NAME      e.g. Proxim
//   APP_ORIGINS      comma-separated expected origins, e.g.
//                    https://proxim.app,android:apk-key-hash:<base64url SHA-256 of signing cert>

const crypto = require("crypto");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const store = require("./store");

function getRpConfig() {
  const rpID = (process.env.APP_RP_ID || "").trim();
  if (!rpID) throw new Error("APP_RP_ID is not configured");
  const origins = new Set(
    (process.env.APP_ORIGINS || `https://${rpID}`)
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean)
  );
  // Automatically include android:apk-key-hash:<base64url> for every cert fingerprint
  // configured in APP_ANDROID_CERT_SHA256 so Android Credential Manager origins always match.
  const androidPrints = String(process.env.APP_ANDROID_CERT_SHA256 || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const fp of androidPrints) {
    const hex = fp.replace(/:/g, "");
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      origins.add(`android:apk-key-hash:${Buffer.from(hex, "hex").toString("base64url")}`);
    }
  }
  return { rpID, rpName: (process.env.APP_RP_NAME || "Proxim").trim(), origins: [...origins] };
}

function userIdBytes(telegramId) {
  return new TextEncoder().encode(`proxim:${telegramId}`);
}

// ─── registration ─────────────────────────────────────────────────────────────

async function startRegistration({ telegramId, userName, displayName, purpose, context = null }) {
  const { rpID, rpName } = getRpConfig();
  const existing = store.listPasskeys(telegramId);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: userIdBytes(telegramId),
    userName: String(userName || `user-${Math.abs(telegramId)}`),
    userDisplayName: String(displayName || userName || "Proxim user"),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credential_id })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    timeout: 120000,
  });
  const challengeId = store.createChallenge({
    challenge: options.challenge,
    purpose,
    telegramId,
    context,
    ttlMs: 5 * 60 * 1000,
  });
  return { challengeId, options };
}

async function finishRegistration({ challengeId, purpose, response }) {
  const row = store.consumeChallenge(challengeId, purpose);
  if (!row) throw Object.assign(new Error("Registration expired. Please start again."), { status: 400, code: "challenge_invalid" });
  const { rpID, origins } = getRpConfig();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch (err) {
    console.warn("[app_api:passkey] registration verify failed:", err?.message || err);
    throw Object.assign(new Error("Passkey could not be verified."), { status: 400, code: "passkey_invalid", cause: err });
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw Object.assign(new Error("Passkey could not be verified."), { status: 400, code: "passkey_invalid" });
  }
  const cred = verification.registrationInfo.credential;
  return {
    telegramId: row.telegram_id,
    context: row.context,
    credential: {
      id: cred.id,
      publicKey: Buffer.from(cred.publicKey).toString("base64url"),
      counter: cred.counter || 0,
      transports: cred.transports || response?.response?.transports || undefined,
    },
  };
}

// ─── authentication (login and action approval) ───────────────────────────────

/** Canonical JSON (sorted keys) so the same action always hashes the same way. */
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Starts a passkey assertion. For purpose "login" any of the user's discoverable passkeys may
 * answer. For an action approval (purpose "approve"), the challenge is derived from the exact
 * action plus a random nonce, so the signature approves only that action.
 */
async function startAuthentication({ purpose, telegramId = null, action = null, context = null, ttlMs = 2 * 60 * 1000 }) {
  const { rpID } = getRpConfig();
  let challenge;
  let boundAction = null;
  if (action) {
    boundAction = { ...action, nonce: crypto.randomBytes(16).toString("hex") };
    challenge = crypto.createHash("sha256").update(canonicalize(boundAction)).digest();
  }
  const allow = telegramId !== null
    ? store.listPasskeys(telegramId).map((c) => ({ id: c.credential_id }))
    : undefined;
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: allow,
    challenge,
    timeout: 120000,
  });
  const challengeId = store.createChallenge({
    challenge: options.challenge,
    purpose,
    telegramId,
    action: boundAction,
    context,
    ttlMs,
  });
  return { challengeId, options };
}

async function finishAuthentication({ challengeId, purpose, response, expectedTelegramId = null }) {
  const row = store.consumeChallenge(challengeId, purpose);
  if (!row) throw Object.assign(new Error("Approval expired. Please try again."), { status: 400, code: "challenge_invalid" });
  const credentialId = response?.id || response?.rawId;
  const passkey = credentialId ? store.getPasskey(credentialId) : null;
  if (!passkey) throw Object.assign(new Error("Unknown passkey."), { status: 401, code: "passkey_unknown" });
  const ownerId = Number(passkey.telegram_id);
  if (row.telegram_id !== null && row.telegram_id !== undefined && Number(row.telegram_id) !== ownerId) {
    throw Object.assign(new Error("This passkey does not belong to this account."), { status: 403, code: "passkey_mismatch" });
  }
  if (expectedTelegramId !== null && Number(expectedTelegramId) !== ownerId) {
    throw Object.assign(new Error("This passkey does not belong to this account."), { status: 403, code: "passkey_mismatch" });
  }
  // A bound approval challenge must be exactly the hash of the stored action.
  if (row.action) {
    const expected = crypto.createHash("sha256").update(canonicalize(row.action)).digest("base64url");
    if (expected !== row.challenge) {
      throw Object.assign(new Error("Approval does not match the requested action."), { status: 400, code: "action_mismatch" });
    }
  }
  const { rpID, origins } = getRpConfig();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: passkey.credential_id,
        publicKey: new Uint8Array(Buffer.from(passkey.public_key, "base64url")),
        counter: Number(passkey.counter || 0),
        transports: passkey.transports,
      },
    });
  } catch (err) {
    console.warn("[app_api:passkey] auth verify failed:", err?.message || err);
    throw Object.assign(new Error("Passkey could not be verified."), { status: 401, code: "passkey_invalid", cause: err });
  }
  if (!verification.verified) {
    throw Object.assign(new Error("Passkey could not be verified."), { status: 401, code: "passkey_invalid" });
  }
  store.updatePasskeyCounter(passkey.credential_id, verification.authenticationInfo?.newCounter);
  return { telegramId: ownerId, credentialId: passkey.credential_id, action: row.action, context: row.context };
}

module.exports = {
  getRpConfig,
  canonicalize,
  startRegistration,
  finishRegistration,
  startAuthentication,
  finishAuthentication,
};
