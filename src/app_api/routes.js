// src/app_api/routes.js
// Mobile app API, mounted at /api/app/v1 in src/webhook_server.js.
// Auth model (see the Mobile App design doc):
//   - sign-up: phone OTP + passkey registration + app integrity check
//   - existing Telegram users: one-time link code from the bot + passkey registration
//   - login: passkey assertion → 15-min access token + rotating, device-bound refresh token
//   - money movement: a fresh passkey assertion bound to the exact action, plus the PIN
// Every money action goes through the same fraud_guard checks and wallet code as the bot.

const crypto = require("crypto");
const store = require("./store");
const tokens = require("./tokens");
const passkeys = require("./passkeys");
const integrity = require("./integrity");
const actions = require("./actions");
const features = require("./features");
const ota = require("./ota");
const stocks = require("./stocks");

// Dependencies are resolved lazily and can be replaced in tests.
const deps = {
  get db() { return require("../db"); },
  get walletLib() { return require("../wallet"); },
  get chains() { return require("../chains"); },
  get fraudGuard() { return require("../fraud_guard"); },
  get otp() { return require("../otp"); },
  get notify() { return require("../notify").notify; },
  get compliance() { return require("../compliance"); },
};
const overrides = {};
const dep = (name) => (name in overrides ? overrides[name] : deps[name]);
function __setTestDeps(o = {}) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setTestDeps cannot be used in production.");
  }
  for (const k of Object.keys(overrides)) delete overrides[k];
  Object.assign(overrides, o);
  const subOverrides = { ...o };
  if (typeof o.notify === "function") {
    subOverrides.notify = { notify: o.notify, getNotifyBot: () => null };
  }
  actions.__setTestDeps(subOverrides);
  features.__setTestDeps(subOverrides);
}

const PREFIX = "/api/app/v1";
const MAX_BODY_BYTES = 256 * 1024;
const NEW_DEVICE_MAX_USD = Number(process.env.APP_NEW_DEVICE_MAX_USD || 100);
const WEAK_PINS = new Set(["0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999", "1234", "4321", "1122", "1212", "0123"]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ─── http helpers ─────────────────────────────────────────────────────────────

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(data));
}

// Endpoints that accept base64 photo/document uploads need a larger JSON body limit.
const LARGE_BODY_PATHS = new Map([
  ["/me/avatar", 6 * 1024 * 1024],
  ["/kyc/submit", 15 * 1024 * 1024],
  ["/kyb/submit", 25 * 1024 * 1024],
]);

function parseBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= maxBytes) chunks.push(c);
    });
    req.on("end", () => {
      if (size > maxBytes) return reject(new HttpError(413, "payload_too_large", "Request body too large."));
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch (_) {
        reject(new HttpError(400, "invalid_json", "Request body must be JSON."));
      }
    });
    req.on("error", reject);
  });
}

function clientIp(req) {
  // Never trust the leftmost X-Forwarded-For entry (trivially spoofed by attackers to bypass rate limits).
  // Prefer Cloudflare's edge header or the rightmost proxy-appended hop when running behind a reverse proxy.
  if (String(process.env.TRUST_PROXY || "true").toLowerCase() !== "false") {
    const cfIp = String(req.headers["cf-connecting-ip"] || "").trim();
    if (cfIp) return cfIp;
    const xff = String(req.headers["x-forwarded-for"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket?.remoteAddress || "unknown";
}

// ─── rate limiting (in-memory, per process) ───────────────────────────────────

const _buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const b = _buckets.get(key);
  if (!b || b.resetAt <= now) {
    _buckets.set(key, { count: 1, resetAt: now + windowMs });
  } else if (++b.count > limit) {
    throw new HttpError(429, "rate_limited", "Too many attempts. Please wait and try again.");
  }
  if (_buckets.size > 50_000) {
    for (const [k, v] of _buckets) if (v.resetAt <= now) _buckets.delete(k);
  }
}
function __resetRateLimits() {
  _buckets.clear();
}

// ─── validation ───────────────────────────────────────────────────────────────

function requireString(body, field, { pattern = null, max = 512 } = {}) {
  const v = body[field];
  if (typeof v !== "string" || !v.trim() || v.length > max || (pattern && !pattern.test(v.trim()))) {
    throw new HttpError(400, "invalid_request", `Missing or invalid field: ${field}`);
  }
  return v.trim();
}

function requireDevice(body) {
  const deviceId = requireString(body, "deviceId", { pattern: /^[A-Za-z0-9_-]{16,128}$/ });
  const platform = requireString(body, "platform", { pattern: /^(ios|android)$/ });
  const deviceName = typeof body.deviceName === "string" ? body.deviceName.slice(0, 64) : null;
  return { deviceId, platform, deviceName };
}

function normalizePhone(raw) {
  const cleaned = String(raw || "").replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(cleaned)) {
    throw new HttpError(400, "invalid_phone", "Enter your phone number in international format, e.g. +2348012345678.");
  }
  return cleaned;
}

function maskPhone(phone) {
  if (!phone) return null;
  return `${phone.slice(0, 4)}•••${phone.slice(-3)}`;
}

async function requireIntegrity(platform, body) {
  const result = await integrity.checkIntegrity({ platform, token: body.integrityToken });
  if (!result.allowed) {
    throw new HttpError(403, "integrity_failed", "This app or device could not be verified. Please use the official Proxim app.");
  }
  return result.verdict;
}

const _lastActivityTouch = new Map();
function touchMobileActivity(db, telegramId) {
  if (!telegramId || typeof db?.updateUserLastActivity !== "function") return;
  const now = Date.now();
  const prev = _lastActivityTouch.get(telegramId) || 0;
  if (now - prev < 5 * 60 * 1000) return;
  _lastActivityTouch.set(telegramId, now);
  if (_lastActivityTouch.size > 10_000) _lastActivityTouch.clear();
  try { db.updateUserLastActivity(telegramId); } catch (_) {}
}

function authenticate(req) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  const session = tokens.verifyAccessToken(token);
  if (!session) throw new HttpError(401, "unauthorized", "Session expired. Please sign in again.");
  const db = dep("db");
  const user = db.getUser(session.telegramId);
  if (!user) throw new HttpError(401, "unauthorized", "Account not found.");
  if (db.isBlocked(session.telegramId)) {
    throw new HttpError(403, "account_frozen", "Your account is frozen. Please contact support.");
  }
  touchMobileActivity(db, session.telegramId);
  const rawAcctHeader = String(req.headers["x-proxim-account"] || "").trim().toLowerCase();
  if (rawAcctHeader && rawAcctHeader !== "personal" && rawAcctHeader !== "business") {
    throw new HttpError(400, "invalid_account", "Please choose either your personal or business account.");
  }
  return { ...session, user, accountHeader: rawAcctHeader || null };
}

function resolveAccountType(auth, explicit = null) {
  const raw = explicit !== undefined && explicit !== null && explicit !== ""
    ? String(explicit).trim().toLowerCase()
    : (auth.accountHeader || (auth.user?.active_context === "business" && auth.user?.business_deposit_address ? "business" : "personal"));
  if (raw !== "personal" && raw !== "business") {
    throw new HttpError(400, "invalid_account", "Account must be 'personal' or 'business'.");
  }
  if (raw === "business" && !auth.user?.business_deposit_address) {
    throw new HttpError(404, "no_business_account", "No business account on this profile.");
  }
  return raw;
}

function getVerifiedNgnAccount(telegramId, accountType) {
  try {
    const db = dep("db");
    const entity = db.getNuvionEntityByUser?.(telegramId, accountType);
    if (!entity) return null;
    const details = db.getNuvionAccountDetailsByEntity?.(entity.entity_id) || [];
    const ngn = details.find(
      (d) =>
        String(d.currency || "").toUpperCase() === "NGN" &&
        d.account_number &&
        String(d.asset_type || "fiat").toLowerCase() === "fiat"
    );
    if (!ngn) return null;
    return {
      bankName: ngn.bank_name || null,
      accountNumber: ngn.account_number,
      beneficiaryName: ngn.beneficiary_name || null,
      status: ngn.status || "active",
    };
  } catch (_) {
    return null;
  }
}

function publicUser(user, device) {
  let personalTier1 = false;
  let businessTier1 = false;
  let senderName = user.sender_name || null;
  let bizSenderName = user.biz_sender_name || null;
  try { personalTier1 = dep("fraudGuard").isUserTier1Approved(user.telegram_id, "personal"); } catch (_) { }
  if (user.business_deposit_address) {
    try { businessTier1 = dep("fraudGuard").isUserTier1Approved(user.telegram_id, "business"); } catch (_) { }
  }
  try { senderName = dep("db").resolveSenderName(user.telegram_id, "personal"); } catch (_) { }
  if (user.business_deposit_address) {
    try { bizSenderName = dep("db").resolveSenderName(user.telegram_id, "business"); } catch (_) { }
  }
  const activeContext = user.active_context === "business" && user.business_deposit_address ? "business" : "personal";
  const activeDepositAddress = activeContext === "business" ? user.business_deposit_address : (user.deposit_address || null);
  const ngnAccount = getVerifiedNgnAccount(user.telegram_id, activeContext);
  return {
    id: String(user.telegram_id),
    username: user.username || null,
    senderName,
    savedSenderName: user.sender_name || null,
    bizSenderName,
    phone: maskPhone(user.phone_number),
    telegramLinked: Number(user.telegram_id) > 0,
    kycTier: activeContext === "business" ? (businessTier1 ? 1 : 0) : (personalTier1 ? 1 : 0),
    personalKycTier: personalTier1 ? 1 : 0,
    businessKycTier: businessTier1 ? 1 : 0,
    depositAddress: user.deposit_address || null,
    activeDepositAddress,
    ngnAccount,
    hasBusinessAccount: Boolean(user.business_deposit_address),
    businessDepositAddress: user.business_deposit_address || null,
    activeContext,
    autoEarnEnabled: Boolean(user.auto_earn_enabled),
    referralCode: user.referral_code || `ref${user.telegram_id}`,
    avatarVersion: require("./avatars").getAvatarVersion(user.telegram_id),
    deviceRestrictedUntil: store.isDeviceRestricted(device) ? device.restricted_until : null,
  };
}

async function alertNewDevice(telegramId, deviceName, platform, excludeDeviceId) {
  const html =
    `🔐 <b>New device signed in to Proxim</b>\n` +
    `Device: ${String(deviceName || platform).replace(/[<>&]/g, "")}\n\n` +
    `For 24 hours this device has lower limits. If this wasn't you, remove it in the app under Settings → Devices, or contact support now.`;
  try {
    await dep("notify")(telegramId, { title: "New device signed in", html, data: { type: "new_device", deviceId: excludeDeviceId } });
  } catch (err) {
    console.warn("[app_api] new-device alert failed:", err.message);
  }
}

// ─── handlers: sign-up ────────────────────────────────────────────────────────

async function signupStart(req, body) {
  const { deviceId, platform } = requireDevice(body);
  const phone = normalizePhone(body.phone);
  rateLimit(`signup-ip:${clientIp(req)}`, 10, 60 * 60 * 1000);
  rateLimit(`signup-phone:${phone}`, 3, 60 * 60 * 1000);
  await requireIntegrity(platform, body);

  if (store.findUserByPhone(phone)) {
    throw new HttpError(409, "phone_registered", "This phone number already has a Proxim account. Sign in instead.");
  }
  const { pinId } = await dep("otp").sendOtp(phone.replace(/^\+/, ""));
  const signupId = store.createSignup({ phone, otpPinId: pinId, deviceId, platform });
  return { status: 201, data: { signupId, otpExpiresInSec: 600 } };
}

async function signupVerifyOtp(req, body) {
  const signupId = requireString(body, "signupId", { max: 64 });
  const code = requireString(body, "code", { pattern: /^\d{4,8}$/ });
  rateLimit(`otp-ip:${clientIp(req)}`, 20, 60 * 60 * 1000);

  const signup = store.getSignup(signupId);
  if (!signup || signup.completed || Date.parse(signup.expires_at) <= Date.now()) {
    throw new HttpError(400, "signup_expired", "Sign-up expired. Please start again.");
  }
  if (Number(signup.attempts) >= 5) throw new HttpError(429, "too_many_attempts", "Too many wrong codes. Please start again.");

  if (!signup.otp_verified) {
    const ok = await dep("otp").verifyOtp(signup.otp_pin_id, code);
    if (!ok) {
      store.updateSignup(signupId, { attempts: Number(signup.attempts) + 1 });
      throw new HttpError(400, "otp_invalid", "That code is not correct.");
    }
  }
  const reservedId = signup.reserved_id ? Number(signup.reserved_id) : store.allocateAppUserId();
  store.updateSignup(signupId, { otp_verified: 1, reserved_id: reservedId });

  const { challengeId, options } = await passkeys.startRegistration({
    telegramId: reservedId,
    userName: signup.phone_number,
    displayName: "Proxim account",
    purpose: "signup",
    context: { signupId },
  });
  return { status: 200, data: { challengeId, options } };
}

async function signupFinish(req, body) {
  const signupId = requireString(body, "signupId", { max: 64 });
  const challengeId = requireString(body, "challengeId", { max: 64 });
  const pin = requireString(body, "pin", { pattern: /^\d{4}$/ });
  if (WEAK_PINS.has(pin)) throw new HttpError(400, "weak_pin", "Choose a PIN that is harder to guess.");
  if (body.acceptTerms !== true) throw new HttpError(400, "terms_required", "You must accept the Terms of Service.");
  const deviceName = typeof body.deviceName === "string" ? body.deviceName.slice(0, 64) : null;

  const signup = store.getSignup(signupId);
  if (!signup || signup.completed || !signup.otp_verified || Date.parse(signup.expires_at) <= Date.now()) {
    throw new HttpError(400, "signup_expired", "Sign-up expired. Please start again.");
  }
  const reg = await passkeys.finishRegistration({ challengeId, purpose: "signup", response: body.response });
  if (Number(reg.telegramId) !== Number(signup.reserved_id) || reg.context?.signupId !== signupId) {
    throw new HttpError(400, "challenge_invalid", "Sign-up does not match. Please start again.");
  }
  if (store.findUserByPhone(signup.phone_number)) {
    throw new HttpError(409, "phone_registered", "This phone number already has a Proxim account. Sign in instead.");
  }

  const db = dep("db");
  const userId = Number(signup.reserved_id);
  const wallet = dep("walletLib").generateUserWallet();
  db.createUserWithWallet(userId, null, wallet.address, wallet.privateKey, pin);
  store.setUserPhone(userId, signup.phone_number);
  try { db.recordTermsAcceptance(userId, dep("compliance").TERMS_VERSION); } catch (_) { }

  store.savePasskey({
    credentialId: reg.credential.id,
    telegramId: userId,
    publicKey: reg.credential.publicKey,
    counter: reg.credential.counter,
    transports: reg.credential.transports,
    deviceId: signup.device_id,
  });
  const { device } = store.upsertDevice({ deviceId: signup.device_id, telegramId: userId, platform: signup.platform, deviceName });
  store.updateSignup(signupId, { completed: 1 });

  const session = tokens.issueSession({ telegramId: userId, deviceId: signup.device_id });
  return { status: 201, data: { user: publicUser(db.getUser(userId), device), session } };
}

// ─── handlers: link an existing Telegram account ──────────────────────────────

async function linkStart(req, body) {
  const { platform } = requireDevice(body);
  const code = requireString(body, "code", { pattern: /^[A-Za-z0-9]{6,16}$/ });
  rateLimit(`link-ip:${clientIp(req)}`, 10, 15 * 60 * 1000);
  await requireIntegrity(platform, body);

  const row = store.peekLinkCode(code);
  if (!row) throw new HttpError(400, "link_code_invalid", "This link has expired. Request a new one in the Telegram bot.");
  const user = dep("db").getUser(row.telegram_id);
  if (!user) throw new HttpError(400, "link_code_invalid", "Account not found.");

  const { challengeId, options } = await passkeys.startRegistration({
    telegramId: Number(user.telegram_id),
    userName: user.username || `tg-${user.telegram_id}`,
    displayName: user.username || "Proxim account",
    purpose: "link",
  });
  return { status: 200, data: { challengeId, options } };
}

async function linkFinish(req, body) {
  const { deviceId, platform, deviceName } = requireDevice(body);
  const code = requireString(body, "code", { pattern: /^[A-Za-z0-9]{6,16}$/ });
  const challengeId = requireString(body, "challengeId", { max: 64 });
  const pin = requireString(body, "pin", { pattern: /^\d{4}$/ });
  rateLimit(`link-finish-ip:${clientIp(req)}`, 10, 15 * 60 * 1000);

  const reg = await passkeys.finishRegistration({ challengeId, purpose: "link", response: body.response });
  const pending = store.peekLinkCode(code);
  if (!pending || Number(pending.telegram_id) !== Number(reg.telegramId)) {
    throw new HttpError(400, "link_code_invalid", "This link has expired. Request a new one in the Telegram bot.");
  }
  // The PIN proves the person linking also knows the account's secret, not just its Telegram chat.
  const pinStatus = dep("db").verifyPinWithStatus(Number(pending.telegram_id), pin);
  if (!pinStatus.valid) {
    if (pinStatus.locked) throw new HttpError(423, "pin_locked", "Too many wrong PINs. Try again later.");
    throw new HttpError(401, "pin_invalid", "Wrong PIN.");
  }
  const row = store.consumeLinkCode(code);
  if (!row || Number(row.telegram_id) !== Number(reg.telegramId)) {
    throw new HttpError(400, "link_code_invalid", "This link has expired. Request a new one in the Telegram bot.");
  }
  const telegramId = Number(row.telegram_id);
  const verdict = (await integrity.checkIntegrity({ platform, token: body.integrityToken })).verdict;
  const { device, isNew, firstDevice } = store.upsertDevice({ deviceId, telegramId, platform, deviceName, integrityVerdict: verdict });
  store.savePasskey({
    credentialId: reg.credential.id,
    telegramId,
    publicKey: reg.credential.publicKey,
    counter: reg.credential.counter,
    transports: reg.credential.transports,
    deviceId,
  });

  const db = dep("db");
  const user = db.getUser(telegramId);
  try {
    await dep("notify")(telegramId, {
      title: "Mobile app linked",
      html: `📱 <b>Proxim mobile app linked</b>\nDevice: ${String(deviceName || platform).replace(/[<>&]/g, "")}\n\nIf this wasn't you, tap below to remove it immediately.`,
      telegramExtra: { reply_markup: { inline_keyboard: [[{ text: "Remove this device", callback_data: `app_revoke_${deviceId}` }]] } },
    });
  } catch (_) { }
  if (isNew && !firstDevice) await alertNewDevice(telegramId, deviceName, platform, deviceId);

  const session = tokens.issueSession({ telegramId, deviceId });
  return { status: 201, data: { user: publicUser(user, device), session } };
}

// ─── handlers: login and sessions ─────────────────────────────────────────────

async function loginStart(req, body) {
  const { platform } = requireDevice(body);
  rateLimit(`login-ip:${clientIp(req)}`, 30, 60 * 1000);
  await requireIntegrity(platform, body);
  const { challengeId, options } = await passkeys.startAuthentication({ purpose: "login" });
  return { status: 200, data: { challengeId, options } };
}

async function loginFinish(req, body) {
  const { deviceId, platform, deviceName } = requireDevice(body);
  const challengeId = requireString(body, "challengeId", { max: 64 });
  rateLimit(`login-ip:${clientIp(req)}`, 30, 60 * 1000);

  const auth = await passkeys.finishAuthentication({ challengeId, purpose: "login", response: body.response });
  const db = dep("db");
  const user = db.getUser(auth.telegramId);
  if (!user) throw new HttpError(401, "unauthorized", "Account not found.");
  if (db.isBlocked(auth.telegramId)) throw new HttpError(403, "account_frozen", "Your account is frozen. Please contact support.");

  const verdict = (await integrity.checkIntegrity({ platform, token: body.integrityToken })).verdict;
  const { device, isNew, firstDevice } = store.upsertDevice({ deviceId, telegramId: auth.telegramId, platform, deviceName, integrityVerdict: verdict });
  if (isNew && !firstDevice) await alertNewDevice(auth.telegramId, deviceName, platform, deviceId);

  const session = tokens.issueSession({ telegramId: auth.telegramId, deviceId });
  return { status: 200, data: { user: publicUser(user, device), session } };
}

async function refresh(req, body) {
  const refreshToken = requireString(body, "refreshToken", { max: 256 });
  const deviceId = requireString(body, "deviceId", { pattern: /^[A-Za-z0-9_-]{16,128}$/ });
  rateLimit(`refresh-ip:${clientIp(req)}`, 60, 60 * 1000);
  const rotated = store.rotateRefreshToken(refreshToken, deviceId);
  if (rotated?.reuse) {
    try {
      await dep("notify")(rotated.telegramId, {
        title: "Signed out for your safety",
        html: "⚠️ <b>Proxim signed you out on all devices</b>\nAn old session token was reused, which can mean it was stolen. Sign in again with your passkey.",
      });
    } catch (_) { }
    throw new HttpError(401, "session_revoked", "Session ended for your security. Please sign in again.");
  }
  if (!rotated) throw new HttpError(401, "unauthorized", "Session expired. Please sign in again.");
  if (dep("db").isBlocked(rotated.telegramId)) {
    store.revokeAllSessions(rotated.telegramId);
    throw new HttpError(403, "account_frozen", "Your account is frozen. Please contact support.");
  }
  const { accessToken, expiresIn } = tokens.issueAccessToken({ telegramId: rotated.telegramId, deviceId: rotated.deviceId });
  return { status: 200, data: { session: { accessToken, refreshToken: rotated.refreshToken, expiresIn } } };
}

async function logout(req) {
  const auth = authenticate(req);
  store.revokeDeviceSessions(auth.deviceId);
  store.setPushToken(auth.deviceId, null);
  return { status: 200, data: { success: true } };
}

// ─── handlers: account ────────────────────────────────────────────────────────

async function me(req) {
  const auth = authenticate(req);
  return { status: 200, data: { user: publicUser(auth.user, store.getDevice(auth.deviceId)) } };
}

async function balances(req, url) {
  const auth = authenticate(req);
  const accountType = resolveAccountType(auth, url.searchParams.get("account"));
  const [unified, ngnRate] = await Promise.all([
    dep("chains").getUnifiedBalance(auth.user, accountType, {
      strictBusiness: accountType === "business",
    }),
    features.getLiveUsdNgnRate(),
  ]);
  const totalNum = Number(unified.total || 0);
  return {
    status: 200,
    data: {
      accountType,
      depositAddress: accountType === "business" ? auth.user.business_deposit_address : (auth.user.deposit_address || null),
      ngnAccount: getVerifiedNgnAccount(auth.telegramId, accountType),
      totalUsdc: unified.total,
      totalNgn: ngnRate && Number.isFinite(totalNum) ? Math.round(totalNum * ngnRate) : null,
      usdToNgnRate: ngnRate,
      arc: unified.arc,
      base: unified.base || { usdc: 0 },
      gateway: unified.gateway || { usdc: 0 },
      solana: unified.solana,
      byChain: unified.byChain || null,
      pendingBridgeUsdc: unified.pendingNear,
    },
  };
}

async function transactions(req, url) {
  const auth = authenticate(req);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
  const rawAccount = url.searchParams.get("account");
  const accountType = rawAccount === "all"
    ? null
    : (rawAccount || auth.accountHeader ? resolveAccountType(auth, rawAccount) : null);
  const db = dep("db");
  // Fetch extra rows so deduplication of historical paired rows still fills `limit`.
  const fetchLimit = Math.min(limit * 2, 200);
  const rows = db.getTransactions(auth.telegramId, fetchLimit, accountType);
  const needsFallbackRate = rows.some(
    (t) => /deposit_naira|onramp/i.test(String(t.type || "")) && !t.source_amount
  );
  const liveNgnRate = needsFallbackRate ? await features.getLiveUsdNgnRate().catch(() => null) : null;

  const parseTxUsd = (t) => {
    try {
      const raw = String(t.amount_micro ?? t.amount ?? "0");
      if (!raw) return 0;
      if (/^\d+$/.test(raw)) {
        const dec = Number(t.decimals ?? 18);
        return Number(raw) / 10 ** dec;
      }
      return Number(raw) || 0;
    } catch (_) {
      return 0;
    }
  };

  // Bank payouts: show who was paid, the naira amount and where the payout stands.
  const payoutInfo = (t) => {
    if (!/offramp|payout|withdraw/i.test(String(t.type || "")) || !t.tx_hash || typeof db.getOfframpOrderByOrderId !== "function") return null;
    try {
      const o = db.getOfframpOrderByOrderId(t.tx_hash);
      if (!o || Number(o.telegram_id) !== Number(auth.telegramId)) return null;
      const s = String(o.status || "").toLowerCase();
      const payoutStatus = /complete|success|paid|settled/.test(s) ? "paid" : /fail|reject|refund|cancel|expire/.test(s) ? "failed" : "processing";
      const acct = String(o.account_number || "");
      return {
        counterparty: {
          name: o.account_name || null,
          detail: [o.bank_name, acct ? `••${acct.slice(-2)}` : null].filter(Boolean).join(" "),
        },
        fiatAmount: o.fiat_amount != null ? Number(o.fiat_amount) : null,
        fiatCurrency: "NGN",
        payoutStatus,
        payoutUpdatedAt: o.completed_at || o.updated_at || null,
      };
    } catch (_) {
      return null;
    }
  };

  // Inbound deposits: resolve whether deposit was Naira (Paj / Nuvion NGN), International Fiat (Nuvion GBP/EUR/USD/etc.), or Crypto.
  const depositInfo = (t) => {
    const typeLower = String(t.type || "").toLowerCase();
    const isDeposit = /deposit|onramp|near_deposit|evm_sweep|receive|credit/i.test(typeLower) && !/auto_earn_deposit|savings_deposit/i.test(typeLower);
    if (!isDeposit) return null;

    // 1. Direct metadata stored on the transaction row (authoritative for all new Paj & Nuvion deposits)
    if (t.deposit_channel || t.source_currency) {
      const cur = t.source_currency ? String(t.source_currency).toUpperCase() : null;
      const amt = t.source_amount != null && Number(t.source_amount) > 0 ? Number(t.source_amount) : null;
      let channel = t.deposit_channel ? String(t.deposit_channel).toLowerCase() : null;
      if (!channel) {
        if (cur === "NGN") channel = "naira";
        else if (cur && !/^(USDC|USDT|EURC|USDG|ETH|SOL|BTC|NEAR|MATIC|AVAX|BNB)$/.test(cur)) channel = "international";
        else channel = "crypto";
      }
      if (channel === "naira") {
        const fallbackNgn = !amt && liveNgnRate ? Math.round(parseTxUsd(t) * liveNgnRate) : null;
        return { depositChannel: "naira", fiatCurrency: "NGN", fiatAmount: amt || fallbackNgn };
      }
      if (channel === "international") {
        return { depositChannel: "international", fiatCurrency: cur || "USD", fiatAmount: amt || Number(parseTxUsd(t).toFixed(2)) };
      }
      return { depositChannel: "crypto", fiatCurrency: null, fiatAmount: null };
    }

    // 2. Retroactive enrichment for historical Nuvion fiat/international deposits (via nuvion_jobs)
    if (t.tx_hash && db.db && typeof db.db.prepare === "function") {
      try {
        const nj = db.db.prepare(
          "SELECT currency, amount_minor, payload_json FROM nuvion_jobs WHERE telegram_id = ? AND (nuvion_transfer_id = ? OR source_tx_hash = ?) ORDER BY id DESC LIMIT 1"
        ).get(Number(auth.telegramId), String(t.tx_hash), String(t.tx_hash));
        if (nj && nj.currency) {
          const cur = String(nj.currency).toUpperCase();
          if (cur === "USC" || cur === "USDC") {
            return { depositChannel: "crypto", fiatCurrency: null, fiatAmount: null };
          }
          let payload = {};
          try { payload = nj.payload_json ? JSON.parse(nj.payload_json) : {}; } catch (_) { }
          const major = Number(payload.grossMajor || 0) || (nj.amount_minor != null ? Number(nj.amount_minor) / 100 : null);
          return {
            depositChannel: cur === "NGN" ? "naira" : "international",
            fiatCurrency: cur,
            fiatAmount: major && Number.isFinite(major) && major > 0 ? Number(major.toFixed(2)) : null,
          };
        }
      } catch (_) { }

      // 3. Retroactive enrichment for historical Paj Naira onramp deposits (via paj_onramp_orders)
      if (/deposit_naira|onramp/i.test(typeLower)) {
        try {
          const onr = db.db.prepare(
            "SELECT fiat_amount, bank_name FROM paj_onramp_orders WHERE telegram_id = ? AND (tx_hash = ? OR order_id = ?) ORDER BY id DESC LIMIT 1"
          ).get(Number(auth.telegramId), String(t.tx_hash), String(t.tx_hash));
          if (onr && Number(onr.fiat_amount) > 0) {
            return { depositChannel: "naira", fiatCurrency: "NGN", fiatAmount: Number(onr.fiat_amount) };
          }
        } catch (_) { }
      }
    }

    // 4. Heuristic fallback for historical rows without order join
    if (/deposit_naira|onramp/i.test(typeLower)) {
      const usd = parseTxUsd(t);
      const ngn = liveNgnRate && usd > 0 ? Math.round(usd * liveNgnRate) : null;
      return { depositChannel: "naira", fiatCurrency: "NGN", fiatAmount: ngn };
    }
    if (typeLower === "deposit_fiat") {
      const m = String(t.narration || "").match(/\b(GBP|EUR|USD|CAD|AUD|KES|GHS|ZAR|TZS|UGX|AED|MXN|INR|XOF|XAF)\b/i);
      const cur = m ? m[1].toUpperCase() : "USD";
      const usd = parseTxUsd(t);
      return {
        depositChannel: "international",
        fiatCurrency: cur,
        fiatAmount: cur === "USD" && usd > 0 ? Number(usd.toFixed(2)) : null,
      };
    }
    if (/deposit_crypto|near_deposit|evm_sweep|cctp|p2p_receive|^deposit$/i.test(typeLower)) {
      return { depositChannel: "crypto", fiatCurrency: null, fiatAmount: null };
    }
    return null;
  };

  const mapped = rows.map((t) => {
    const depMeta = depositInfo(t) || {};
    const payMeta = payoutInfo(t) || {};
    let offrampOrderId = null;
    if (/offramp|payout/i.test(String(t.type || "")) && t.tx_hash && typeof db.getOfframpOrderByOrderId === "function") {
      try {
        const o = db.getOfframpOrderByOrderId(t.tx_hash);
        if (o && Number(o.telegram_id) === Number(auth.telegramId) && o.order_id) {
          offrampOrderId = String(o.order_id);
        }
      } catch (_) {}
    }
    return {
      ...depMeta,
      ...payMeta,
      id: t.id,
      type: t.type,
      status: t.status,
      amount: String(t.amount_micro ?? t.amount ?? ""),
      decimals: t.decimals ?? 18,
      chain: t.chain || "arc",
      txHash: t.tx_hash || null,
      narration: t.narration || null,
      accountType: t.account_type || "personal",
      createdAt: t.created_at || null,
      _offrampOrderId: offrampOrderId,
    };
  });

  // Deduplicate already-stored duplicate pairs (e.g., an offramp "submitted" row with on-chain txHash
  // paired with a webhook "confirmed" row with order_id, or duplicate deposit/sweep rows).
  const statusRank = (s) => {
    const lower = String(s || "").toLowerCase();
    if (/confirm|complet|paid|settle|success/.test(lower)) return 3;
    if (/fail|reject|cancel|error/.test(lower)) return 2;
    return 1;
  };
  const parseTs = (raw) => {
    if (!raw) return null;
    const s = String(raw);
    const ms = Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
    return Number.isFinite(ms) ? ms : null;
  };
  const mergePair = (primary, secondary) => {
    const best = statusRank(primary.status) >= statusRank(secondary.status) ? primary : secondary;
    const other = best === primary ? secondary : primary;
    return {
      ...other,
      ...best,
      narration: best.narration || other.narration || null,
      counterparty: best.counterparty || other.counterparty,
      fiatAmount: best.fiatAmount ?? other.fiatAmount,
      fiatCurrency: best.fiatCurrency || other.fiatCurrency,
      payoutStatus: best.payoutStatus || other.payoutStatus,
      depositChannel: best.depositChannel || other.depositChannel,
      txHash: best.txHash || other.txHash || null,
    };
  };

  const deduped = [];
  const byHashKey = new Map();
  const byOfframpOrder = new Map();

  for (const item of mapped) {
    const typeLower = String(item.type || "").toLowerCase();
    const acct = item.accountType || "personal";

    // 1. Exact duplicate by (accountType, type, txHash)
    if (item.txHash) {
      const hKey = `${acct}|${typeLower}|${String(item.txHash).toLowerCase()}`;
      const idx = byHashKey.get(hKey);
      if (idx !== undefined) {
        deduped[idx] = mergePair(deduped[idx], item);
        continue;
      }
    }

    // 2. Paired offramp rows linked to the same paj_offramp_orders.order_id
    if (item._offrampOrderId) {
      const oKey = `${acct}|offramp|${item._offrampOrderId}`;
      const idx = byOfframpOrder.get(oKey);
      if (idx !== undefined) {
        deduped[idx] = mergePair(deduped[idx], item);
        continue;
      }
    }

    // 3. Temporal duplicate for identical (accountType, type, amount) within a short window
    //    (catches historical offramp submitted+confirmed pairs without an order row, or duplicate sweep rows)
    const ts = parseTs(item.createdAt);
    const isDedupeWindowType = /^(offramp|deposit_naira|deposit_crosschain)$/.test(typeLower);
    let mergedTemporal = false;
    if (isDedupeWindowType && ts !== null && item.amount) {
      const windowMs = typeLower === "offramp" ? 15 * 60 * 1000 : 3 * 60 * 1000;
      for (let i = Math.max(0, deduped.length - 8); i < deduped.length; i++) {
        const prev = deduped[i];
        if (prev.accountType !== acct || String(prev.type || "").toLowerCase() !== typeLower) continue;
        if (prev.amount !== item.amount) continue;
        if (prev.fiatCurrency && item.fiatCurrency && prev.fiatCurrency !== item.fiatCurrency) continue;
        const prevTs = parseTs(prev.createdAt);
        if (prevTs === null || Math.abs(prevTs - ts) > windowMs) continue;
        if (typeLower === "offramp") {
          // Only collapse two offramps with different hashes when one is pending/submitted and the other is terminal
          const r1 = statusRank(prev.status);
          const r2 = statusRank(item.status);
          const bothTerminalWithDistinctHashes =
            r1 >= 3 && r2 >= 3 && prev.txHash && item.txHash && prev.txHash.toLowerCase() !== item.txHash.toLowerCase();
          if (bothTerminalWithDistinctHashes) continue;
        } else {
          // For deposits, never collapse two distinct non-synthetic tx hashes
          const isSynth = (h) => !h || /^(sweep_|0xrelay_|paj-settle-)/i.test(String(h));
          if (prev.txHash && item.txHash && prev.txHash.toLowerCase() !== item.txHash.toLowerCase() && !isSynth(prev.txHash) && !isSynth(item.txHash)) {
            continue;
          }
        }
        deduped[i] = mergePair(prev, item);
        mergedTemporal = true;
        break;
      }
    }
    if (mergedTemporal) continue;

    const newIdx = deduped.length;
    deduped.push(item);
    if (item.txHash) {
      byHashKey.set(`${acct}|${typeLower}|${String(item.txHash).toLowerCase()}`, newIdx);
    }
    if (item._offrampOrderId) {
      byOfframpOrder.set(`${acct}|offramp|${item._offrampOrderId}`, newIdx);
    }
  }

  const finalTransactions = deduped.slice(0, limit).map(({ _offrampOrderId, ...clean }) => clean);

  return {
    status: 200,
    data: {
      accountType: accountType || "all",
      transactions: finalTransactions,
    },
  };
}

async function devices(req) {
  const auth = authenticate(req);
  return {
    status: 200,
    data: {
      devices: store.listDevices(auth.telegramId).map((d) => ({
        id: d.device_id,
        platform: d.platform,
        name: d.device_name,
        current: d.device_id === auth.deviceId,
        restrictedUntil: d.restricted_until && Date.parse(d.restricted_until) > Date.now() ? d.restricted_until : null,
        addedAt: d.created_at,
        lastSeenAt: d.last_seen_at,
      })),
    },
  };
}

async function deviceRevokeIntent(req, body, targetId) {
  const auth = authenticate(req);
  const target = store.getDevice(targetId);
  if (!target || target.revoked || Number(target.telegram_id) !== auth.telegramId) {
    throw new HttpError(404, "device_not_found", "Device not found.");
  }
  const { challengeId, options } = await passkeys.startAuthentication({
    purpose: "approve",
    telegramId: auth.telegramId,
    action: { type: "device.revoke", userId: String(auth.telegramId), deviceId: String(targetId), requestedBy: auth.deviceId },
  });
  return { status: 200, data: { challengeId, options } };
}

async function deviceRevoke(req, body, targetId) {
  const auth = authenticate(req);
  const challengeId = requireString(body, "challengeId", { max: 64 });
  const approval = await passkeys.finishAuthentication({ challengeId, purpose: "approve", response: body.response, expectedTelegramId: auth.telegramId });
  if (approval.action?.type !== "device.revoke" || approval.action.deviceId !== String(targetId) || approval.action.requestedBy !== auth.deviceId) {
    throw new HttpError(400, "action_mismatch", "Approval does not match this request.");
  }
  store.revokeDevice(targetId);
  return { status: 200, data: { success: true } };
}

async function pushRegister(req, body) {
  const auth = authenticate(req);
  const pushToken = requireString(body, "pushToken", { max: 4096 });
  store.setPushToken(auth.deviceId, pushToken);
  return { status: 200, data: { success: true } };
}

// ─── handlers: actions & transfers (two-step, passkey-bound) ──────────────────

function assertDeviceAllowsAmount(deviceId, amountUsdc) {
  const device = store.getDevice(deviceId);
  if (store.isDeviceRestricted(device) && Number(amountUsdc) > NEW_DEVICE_MAX_USD) {
    throw new HttpError(
      403,
      "new_device_limit",
      `This device was added recently. Until ${device.restricted_until} transfers are limited to ${NEW_DEVICE_MAX_USD} USDC.`
    );
  }
}

async function createActionIntent(auth, type, body) {
  const def = actions.ACTIONS[type];
  if (!def) throw new HttpError(404, "unknown_action", `Unknown action: ${type}`);
  const prepared = await def.prepare(auth, body);
  const amountUsd = Number(prepared.amountUsd || 0);
  if (amountUsd > 0) assertDeviceAllowsAmount(auth.deviceId, amountUsd);

  const bound = {
    type,
    userId: String(auth.telegramId),
    deviceId: auth.deviceId,
    ...prepared.action,
  };
  const context = { ...(prepared.context || {}), _amountUsd: amountUsd };
  const { challengeId, options } = await passkeys.startAuthentication({
    purpose: "approve",
    telegramId: auth.telegramId,
    action: bound,
    context,
  });
  return {
    challengeId,
    options,
    actionType: type,
    requiresPin: !def.noPin,
    summary: prepared.summary,
    prepared,
  };
}

async function actionIntent(req, body, type) {
  const auth = authenticate(req);
  const created = await createActionIntent(auth, type, body);
  return {
    status: 200,
    data: {
      challengeId: created.challengeId,
      options: created.options,
      actionType: created.actionType,
      requiresPin: created.requiresPin,
      summary: created.summary,
    },
  };
}

async function executeConfirmedAction(req, body, { allowedTypes = null } = {}) {
  const auth = authenticate(req);
  const challengeId = requireString(body, "challengeId", { max: 64 });
  rateLimit(`action-user:${auth.telegramId}`, 30, 60 * 60 * 1000);

  const approval = await passkeys.finishAuthentication({
    challengeId,
    purpose: "approve",
    response: body.response,
    expectedTelegramId: auth.telegramId,
  });
  const a = approval.action;
  const def = a?.type ? actions.ACTIONS[a.type] : null;
  if (
    !a || !def ||
    a.userId !== String(auth.telegramId) ||
    a.deviceId !== auth.deviceId ||
    (allowedTypes && !allowedTypes.includes(a.type))
  ) {
    throw new HttpError(400, "action_mismatch", "Approval does not match this request.");
  }

  let pin = null;
  if (!def.noPin) {
    pin = requireString(body, "pin", { pattern: /^\d{4}$/ });
    const pinStatus = dep("db").verifyPinWithStatus(auth.telegramId, pin);
    if (!pinStatus.valid) {
      if (pinStatus.locked) throw new HttpError(423, "pin_locked", `Too many wrong PINs. Try again in ${Math.ceil((pinStatus.remainingSec || 0) / 60)} minutes.`);
      throw new HttpError(401, "pin_invalid", `Wrong PIN. ${pinStatus.remainingAttempts ?? ""} attempts left.`.trim());
    }
  }

  const amountUsd = Number(approval.context?._amountUsd ?? a.amountUsdc ?? a.quotedUsd ?? a.totalUsd ?? 0);
  if (amountUsd > 0) assertDeviceAllowsAmount(auth.deviceId, amountUsd);

  const result = await def.execute(auth, a, pin, approval.context || null, body);
  if (result?.notice) {
    try {
      await dep("notify")(auth.telegramId, {
        title: result.notice,
        html: `✅ <b>${String(result.notice).replace(/[<>&]/g, "")}</b>`,
        data: { type: a.type, txHash: result.txHash || null },
      });
    } catch (_) { }
  }
  return { status: 200, data: { success: true, actionType: a.type, ...result } };
}

async function actionConfirm(req, body) {
  return executeConfirmedAction(req, body);
}

async function transferIntent(req, body) {
  const auth = authenticate(req);
  const created = await createActionIntent(auth, "transfer.wallet", body);
  const a = created.prepared.action;
  return {
    status: 200,
    data: {
      challengeId: created.challengeId,
      options: created.options,
      actionType: "transfer.wallet",
      requiresPin: true,
      summary: {
        ...created.summary,
        toAddress: a.toAddress,
        amountUsdc: a.amountUsdc,
        currency: "USDC",
        chain: "arc",
        narration: a.narration,
      },
    },
  };
}

async function transferConfirm(req, body) {
  return executeConfirmedAction(req, body, { allowedTypes: ["transfer.wallet"] });
}

// ─── .well-known association files (passkeys + deep links) ────────────────────

function wellKnown(pathname) {
  if (pathname === "/.well-known/apple-app-site-association") {
    const appIds = String(process.env.APP_IOS_APP_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!appIds.length) return null;
    return {
      webcredentials: { apps: appIds },
      applinks: { details: [{ appIDs: appIds, components: [{ "/": "/pay/*" }, { "/": "/checkout/*" }, { "/": "/link/*" }] }] },
    };
  }
  if (pathname === "/.well-known/assetlinks.json") {
    const pkg = (process.env.APP_ANDROID_PACKAGE || "").trim();
    const prints = String(process.env.APP_ANDROID_CERT_SHA256 || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!pkg || !prints.length) return null;
    return [{
      relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
      target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: prints },
    }];
  }
  return null;
}

function handleWellKnown(req, res) {
  const pathname = (req.url || "").split("?")[0];
  const doc = req.method === "GET" || req.method === "HEAD" ? wellKnown(pathname) : null;
  if (!doc) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(req.method === "HEAD" ? undefined : JSON.stringify({ error: "not_found" }));
  }
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" });
  return res.end(req.method === "HEAD" ? undefined : JSON.stringify(doc));
}

// ─── router ───────────────────────────────────────────────────────────────────

const ROUTES = [
  // Auth & sessions
  ["POST", "/auth/signup/start", signupStart],
  ["POST", "/auth/signup/verify-otp", signupVerifyOtp],
  ["POST", "/auth/signup/finish", signupFinish],
  ["POST", "/auth/link/start", linkStart],
  ["POST", "/auth/link/finish", linkFinish],
  ["POST", "/auth/login/start", loginStart],
  ["POST", "/auth/login/finish", loginFinish],
  ["POST", "/auth/refresh", refresh],
  ["POST", "/auth/logout", logout],

  // Profile, accounts, balances, transactions & statement CSV
  ["GET", "/me", me],
  ["PATCH", "/me", (req, body) => features.updateProfile(authenticate(req), body, publicUser)],
  // Profile photo: upload (base64), fetch (owner only), remove.
  ["POST", "/me/avatar", async (req, body) => {
    const auth = authenticate(req);
    rateLimit(`avatar:${auth.telegramId}`, 10, 60 * 60 * 1000);
    const avatars = require("./avatars");
    try {
      const avatarVersion = await avatars.saveAvatar(auth.telegramId, body?.imageBase64);
      return { status: 200, data: { success: true, avatarVersion } };
    } catch (err) {
      if (err instanceof avatars.AvatarError) throw new HttpError(err.status, err.code, err.message);
      throw err;
    }
  }],
  ["GET", "/me/avatar", (req) => {
    const auth = authenticate(req);
    const row = require("./avatars").getAvatar(auth.telegramId);
    if (!row) throw new HttpError(404, "not_found", "No profile photo.");
    return { status: 200, raw: Buffer.from(row.data), contentType: row.mime, headers: { "Cache-Control": "private, max-age=86400" } };
  }],
  ["DELETE", "/me/avatar", (req) => {
    const auth = authenticate(req);
    require("./avatars").deleteAvatar(auth.telegramId);
    return { status: 200, data: { success: true, avatarVersion: null } };
  }],
  ["PATCH", "/profile", (req, body) => features.updateProfile(authenticate(req), body, publicUser)],
  ["POST", "/me/sender-name", (req, body) => features.updateProfile(authenticate(req), body, publicUser)],
  ["GET", "/accounts", (req) => features.listAccounts(authenticate(req))],
  ["POST", "/accounts/switch", (req, body) => features.switchAccount(authenticate(req), body, publicUser)],
  ["GET", "/balances", balances],
  ["GET", "/transactions", transactions],
  ["GET", "/transactions/statement.csv", (req, url) => features.exportStatementCsv(authenticate(req), url)],
  ["GET", "/devices", devices],
  ["POST", "/push/register", pushRegister],
  // Crash reports from the app (no auth needed: it may crash before signing in).
  ["POST", "/client-errors", (req, body) => {
    rateLimit(`client-error:${clientIp(req)}`, 30, 60 * 1000);
    const clip = (v, n) => String(v ?? "").replace(/[\r\n]+/g, " | ").slice(0, n);
    console.error(
      `[client_error] fatal=${Boolean(body?.fatal)} where=${clip(body?.where, 40)} update=${clip(body?.updateId, 40)} ` +
      `msg=${clip(body?.message, 400)} stack=${clip(body?.stack, 1200)}`
    );
    return { status: 200, data: { ok: true } };
  }],
  // In-app notification inbox (works with or without push).
  ["GET", "/notifications", (req, url) => {
    const auth = authenticate(req);
    const data = require("./inbox").listNotifications(auth.telegramId, {
      limit: url.searchParams.get("limit"),
      afterId: url.searchParams.get("after"),
    });
    return { status: 200, data };
  }],
  ["POST", "/notifications/read", (req, body) => {
    const auth = authenticate(req);
    const changed = require("./inbox").markRead(auth.telegramId, Array.isArray(body?.ids) ? body.ids : null);
    return { status: 200, data: { success: true, marked: changed } };
  }],

  // Passkey + PIN money actions (and legacy /transfers alias)
  ["POST", "/actions/confirm", actionConfirm],
  ["POST", "/transfers/intent", transferIntent],
  ["POST", "/transfers/confirm", transferConfirm],

  // Contacts & user lookup
  ["GET", "/contacts", (req, url) => features.listContacts(authenticate(req), url)],
  ["POST", "/contacts", (req, body) => features.upsertContact(authenticate(req), body)],
  ["GET", "/users/lookup", (req, url) => {
    const auth = authenticate(req);
    rateLimit(`lookup-user:${auth.telegramId}`, 30, 60 * 1000);
    return features.lookupUser(auth, url);
  }],

  // Banks & NGN rates
  ["GET", "/banks", (req, url) => features.listBanks(authenticate(req), url)],
  ["GET", "/banks/rates", (req) => { authenticate(req); return features.getBankRates(); }],
  ["POST", "/banks/resolve", (req, body) => {
    const auth = authenticate(req);
    rateLimit(`bank-resolve:${auth.telegramId}`, 20, 60 * 1000);
    return features.resolveBankAccount(auth, body);
  }],

  // Naira, card/Apple Pay & crypto (NEAR Intents) deposits & sweep
  ["POST", "/deposits/ngn", (req, body) => {
    const auth = authenticate(req);
    rateLimit(`dep-ngn:${auth.telegramId}`, 15, 60 * 60 * 1000);
    return features.createNgnDeposit(auth, body);
  }],
  ["GET", "/deposits/card", (req, url) => features.getCardDepositLink(authenticate(req), url)],
  ["GET", "/deposits/crypto/tokens", (req, url) => features.listCryptoDepositTokens(authenticate(req), url)],
  ["POST", "/deposits/crypto/intent", (req, body) => {
    const auth = authenticate(req);
    rateLimit(`dep-crypto:${auth.telegramId}`, 20, 60 * 60 * 1000);
    return features.createCryptoDepositIntent(auth, body);
  }],
  ["POST", "/deposits/crypto/sweep", (req, body) => {
    const auth = authenticate(req);
    rateLimit(`dep-sweep:${auth.telegramId}`, 10, 10 * 60 * 1000);
    return features.sweepCryptoDeposits(auth, body);
  }],

  // Cross-chain withdrawals, bridge moves & FX swap
  ["GET", "/withdrawals/chains", (req) => { authenticate(req); return features.listWithdrawalChains(); }],
  // Every chain and token NEAR Intents can deliver to, for "send as any token".
  ["GET", "/withdrawals/tokens", async (req) => {
    authenticate(req);
    const catalog = await require("../near").getAllSupportedIntentTokens();
    return {
      status: 200,
      data: {
        chains: catalog.chains,
        tokensByChain: catalog.tokensByChain,
        feeUsd: Number(process.env.CROSSCHAIN_WITHDRAWAL_FEE_USDC ?? 0.30),
      },
    };
  }],
  ["GET", "/bridge/moves", (req) => features.listBridgeMoves(authenticate(req))],
  ["GET", "/swap/rates", (req) => { authenticate(req); return features.getSwapRates(); }],
  ["POST", "/swap/quote", (req, body) => features.quoteSwap(authenticate(req), body)],

  // Social gift links
  ["GET", "/gifts", (req) => features.listPendingGifts(authenticate(req))],
  ["POST", "/gifts/claim", (req, body) => {
    const auth = authenticate(req);
    rateLimit(`gift-claim:${auth.telegramId}`, 15, 60 * 60 * 1000);
    return features.claimGift(auth, body);
  }],

  // Global accounts, payout corridors, recipients & hosted payment links
  ["GET", "/global/accounts", (req, url) => features.listGlobalAccounts(authenticate(req), url)],
  ["GET", "/global/corridors", (req) => { authenticate(req); return features.listGlobalCorridors(); }],
  ["GET", "/global/bank-codes", (req, url) => features.listGlobalBankCodes(authenticate(req), url)],
  ["GET", "/global/recipients", (req, url) => features.listGlobalRecipients(authenticate(req), url)],
  ["POST", "/global/payment-links", (req, body) => {
    const auth = authenticate(req);
    rateLimit(`global-pl:${auth.telegramId}`, 20, 60 * 60 * 1000);
    return features.createGlobalPaymentLink(auth, body);
  }],

  // Cards
  ["GET", "/cards", (req, url) => features.listCards(authenticate(req), url)],

  // Bills
  ["GET", "/bills/providers", (req, url) => features.listBillProviders(authenticate(req), url)],
  ["POST", "/bills/validate-meter", (req, body) => features.validateBillMeter(authenticate(req), body)],
  ["GET", "/bills/history", (req, url) => features.listBillHistory(authenticate(req), url)],

  // Schedules
  ["GET", "/schedules", (req) => features.listSchedules(authenticate(req))],

  // Rewards, KYC/KYB, savings & investments
  ["GET", "/rewards", (req, url) => features.getRewards(authenticate(req), url)],
  ["GET", "/kyc/status", (req) => features.getKycStatus(authenticate(req))],
  ["POST", "/kyc/submit", (req, body) => {
    const auth = authenticate(req);
    rateLimit(`kyc-sub:${auth.telegramId}`, 5, 60 * 60 * 1000);
    return features.submitKyc(auth, body);
  }],
  ["POST", "/kyb/submit", (req, body) => {
    const auth = authenticate(req);
    rateLimit(`kyb-sub:${auth.telegramId}`, 5, 60 * 60 * 1000);
    return features.submitKyb(auth, body);
  }],
  ["POST", "/kyc/refresh", (req, body) => {
    const auth = authenticate(req);
    rateLimit(`kyc-ref:${auth.telegramId}`, 20, 60 * 60 * 1000);
    return features.refreshKycStatus(auth, body);
  }],
  ["GET", "/savings", (req, url) => features.getSavingsOverview(authenticate(req), url)],
  ["GET", "/investments/hub", (req) => features.getInvestmentsHub(authenticate(req))],
  ["GET", "/stocks", (req, url) => stocks.listStocks(authenticate(req), url)],
  ["GET", "/invoices/options", (req, url) => features.getInvoicePaymentOptions(authenticate(req), url)],

  // Personal invoices
  ["GET", "/invoices", (req, url) => features.listPersonalInvoices(authenticate(req), url)],
  ["POST", "/invoices", (req, body) => {
    const auth = authenticate(req);
    rateLimit(`inv-per:${auth.telegramId}`, 30, 60 * 60 * 1000);
    return features.createPersonalInvoice(auth, body);
  }],

  // Business home, profile, invoices, expenses, savings goal & payment links
  ["GET", "/business/home", (req) => features.getBusinessHome(authenticate(req))],
  ["GET", "/business/overview", (req) => features.getBusinessHome(authenticate(req))],
  ["PATCH", "/business/profile", (req, body) => features.updateBusinessProfile(authenticate(req), body)],
  ["PUT", "/business/profile", (req, body) => features.updateBusinessProfile(authenticate(req), body)],
  ["GET", "/business/invoices", (req, url) => features.listBusinessInvoices(authenticate(req), url)],
  ["POST", "/business/invoices", (req, body) => {
    const auth = authenticate(req);
    rateLimit(`inv-biz:${auth.telegramId}`, 30, 60 * 60 * 1000);
    return features.createBusinessInvoice(auth, body);
  }],
  ["GET", "/business/expenses", (req, url) => features.listBusinessExpenses(authenticate(req), url)],
  ["POST", "/business/expenses", (req, body) => features.logBusinessExpense(authenticate(req), body)],
  ["PUT", "/business/savings-goal", (req, body) => features.setBusinessSavingsGoal(authenticate(req), body)],
  ["GET", "/business/payment-links", (req) => features.listBusinessPaymentLinks(req, authenticate(req))],
  ["POST", "/business/payment-links", (req, body) => {
    const auth = authenticate(req);
    rateLimit(`biz-pl:${auth.telegramId}`, 20, 60 * 60 * 1000);
    return features.createBusinessPaymentLink(req, auth, body);
  }],

  // Assistant (read-only + action proposals)
  ["POST", "/assistant", (req, body) => {
    const auth = authenticate(req);
    rateLimit(`assistant:${auth.telegramId}`, 30, 60 * 1000);
    return features.assistantChat(auth, body);
  }],

  // Self-hosted Expo Updates Protocol v1 (OTA mobile updates)
  ["GET", "/ota/manifest", (req, url) => ota.getManifest(req, url)],
  ["GET", "/ota/status", (req, url) => ota.getStatus(req, url)],
  ["POST", "/ota/refresh", (req, body) => {
    rateLimit(`ota-refresh:${clientIp(req)}`, 10, 60 * 1000);
    return ota.refreshOta(req, body);
  }],
];

const PARAM_ROUTES = [
  ["GET", /^\/ota\/assets\/([a-z]+)\/([A-Za-z0-9._-]+)\/([0-9a-fA-F-]+)\/([A-Za-z0-9._-]+)$/, (req, url, m) => ota.getAsset(req, url, m)],
  ["POST", /^\/actions\/([a-z0-9._-]+)\/intent$/, (req, body, m) => actionIntent(req, body, m[1])],
  ["POST", /^\/devices\/([A-Za-z0-9_-]{16,128})\/revoke\/intent$/, (req, body, m) => deviceRevokeIntent(req, body, m[1])],
  ["POST", /^\/devices\/([A-Za-z0-9_-]{16,128})\/revoke$/, (req, body, m) => deviceRevoke(req, body, m[1])],
  ["GET", /^\/transactions\/(\d+)\/receipt$/, (req, url, m) => features.getTransactionReceipt(authenticate(req), m[1], { download: url.searchParams.get("download") === "1" })],
  // A 10-minute signed link to the receipt, for builds that open it in the browser.
  ["POST", /^\/transactions\/(\d+)\/receipt-link$/, (req, _body, m) => {
    const auth = authenticate(req);
    rateLimit(`receipt-link:${auth.telegramId}`, 30, 60 * 1000);
    const txId = Number(m[1]);
    const owned = dep("db").db.prepare("SELECT id FROM transactions WHERE id = ? AND telegram_id = ?").get(txId, Number(auth.telegramId));
    if (!owned) throw new HttpError(404, "not_found", "Transaction not found.");
    const { u, e, s } = tokens.signReceiptLink(auth.telegramId, txId);
    return { status: 200, data: { path: `/receipts/${txId}?u=${u}&e=${e}&s=${encodeURIComponent(s)}`, expiresInSec: 600 } };
  }],
  ["GET", /^\/receipts\/(\d+)$/, (req, url, m) => {
    rateLimit(`receipt-open:${clientIp(req)}`, 60, 60 * 1000);
    const u = url.searchParams.get("u");
    if (!tokens.verifyReceiptLink(u, m[1], url.searchParams.get("e"), url.searchParams.get("s"))) {
      throw new HttpError(403, "link_expired", "This receipt link has expired. Open the receipt again from the app.");
    }
    const user = dep("db").getUser(Number(u));
    if (!user) throw new HttpError(404, "not_found", "Transaction not found.");
    return features.getTransactionReceipt({ telegramId: Number(u), user }, m[1], { download: true });
  }],
  ["DELETE", /^\/contacts\/([^/]+)$/, (req, _arg, m) => features.deleteContact(authenticate(req), m[1])],
  ["GET", /^\/deposits\/ngn\/([^/]+)$/, (req, _arg, m) => features.getNgnDepositStatus(authenticate(req), m[1])],
  ["GET", /^\/deposits\/crypto\/(\d+)$/, (req, _arg, m) => features.getCryptoDepositStatus(authenticate(req), m[1])],
  ["POST", /^\/global\/accounts\/([A-Za-z]{3})$/, (req, body, m) => {
    const auth = authenticate(req);
    rateLimit(`global-acct:${auth.telegramId}`, 10, 60 * 60 * 1000);
    return features.provisionGlobalAccount(auth, body, m[1]);
  }],
  ["GET", /^\/cards\/([^/]+)\/transactions$/, (req, url, m) => features.listCardTransactions(authenticate(req), url, m[1])],
  ["DELETE", /^\/schedules\/([^/]+)$/, (req, _arg, m) => features.updateScheduleStatus(authenticate(req), m[1], "cancelled")],
  ["POST", /^\/schedules\/([^/]+)\/cancel$/, (req, _arg, m) => features.updateScheduleStatus(authenticate(req), m[1], "cancelled")],
  ["POST", /^\/schedules\/([^/]+)\/pause$/, (req, _arg, m) => features.updateScheduleStatus(authenticate(req), m[1], "paused")],
  ["POST", /^\/schedules\/([^/]+)\/resume$/, (req, _arg, m) => features.updateScheduleStatus(authenticate(req), m[1], "active")],
  ["GET", /^\/stocks\/([A-Za-z0-9.-]+)\/chart$/, (req, url, m) => stocks.getStockDetailAndChart(authenticate(req), url, m[1])],
  ["GET", /^\/invoices\/(\d+)$/, (req, _arg, m) => features.getPersonalInvoice(authenticate(req), m[1])],
  ["GET", /^\/invoices\/(\d+)\/download$/, (req, url, m) => features.downloadInvoiceImage(authenticate(req), m[1], "personal", { download: url.searchParams.get("download") === "1" })],
  ["POST", /^\/invoices\/(\d+)\/download-link$/, (req, _body, m) => {
    const auth = authenticate(req);
    rateLimit(`inv-dl-link:${auth.telegramId}`, 30, 60 * 1000);
    return features.createInvoiceDownloadLink(auth, m[1], "personal");
  }],
  ["POST", /^\/invoices\/(\d+)\/mark-paid$/, (req, _arg, m) => features.markPersonalInvoicePaid(authenticate(req), m[1])],
  ["GET", /^\/business\/invoices\/(\d+)$/, (req, _arg, m) => features.getBusinessInvoice(authenticate(req), m[1])],
  ["GET", /^\/business\/invoices\/(\d+)\/download$/, (req, url, m) => features.downloadInvoiceImage(authenticate(req), m[1], "business", { download: url.searchParams.get("download") === "1" })],
  ["POST", /^\/business\/invoices\/(\d+)\/download-link$/, (req, _body, m) => {
    const auth = authenticate(req);
    rateLimit(`inv-dl-link:${auth.telegramId}`, 30, 60 * 1000);
    return features.createInvoiceDownloadLink(auth, m[1], "business");
  }],
  ["POST", /^\/business\/invoices\/(\d+)\/mark-paid$/, (req, _arg, m) => features.markBusinessInvoicePaid(authenticate(req), m[1])],
  ["GET", /^\/invoice-files\/(personal|business)\/(\d+)$/, (req, url, m) => {
    rateLimit(`inv-open:${clientIp(req)}`, 60, 60 * 1000);
    const u = url.searchParams.get("u");
    if (!tokens.verifyInvoiceLink(u, m[1], m[2], url.searchParams.get("e"), url.searchParams.get("s"))) {
      throw new HttpError(403, "link_expired", "This invoice link has expired. Open the invoice again from the app.");
    }
    const user = dep("db").getUser(Number(u));
    if (!user) throw new HttpError(404, "not_found", "Invoice not found.");
    return features.downloadInvoiceImage({ telegramId: Number(u), user }, m[2], m[1], { download: true });
  }],
  ["DELETE", /^\/business\/payment-links\/([^/]+)$/, (req, _arg, m) => features.deactivateBusinessPaymentLink(authenticate(req), m[1])],
];

async function handleAppApiRequest(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "").slice(PREFIX.length) || "/";
  try {
    store.ensureAppSchema();
    let handler = null;
    let match = null;
    for (const [m, p, h] of ROUTES) {
      if (m === req.method && p === path) { handler = h; break; }
    }
    if (!handler) {
      for (const [m, re, h] of PARAM_ROUTES) {
        if (m !== req.method) continue;
        const hit = path.match(re);
        if (hit) { handler = h; match = hit; break; }
      }
    }
    if (!handler) return sendJson(res, 404, { error: { code: "not_found", message: "Unknown endpoint." } });

    const hasJsonBody = req.method === "POST" || req.method === "PATCH" || req.method === "PUT";
    const arg = hasJsonBody ? await parseBody(req, LARGE_BODY_PATHS.get(path) || MAX_BODY_BYTES) : url;
    const result = await handler(req, arg, match);
    if (result.raw !== undefined) {
      const headers = {
        ...(result.status === 204 ? {} : { "Content-Type": result.contentType || "application/octet-stream" }),
        ...SECURITY_HEADERS,
        ...(result.headers || {}),
      };
      res.writeHead(result.status, headers);
      return res.end(result.status === 204 ? undefined : result.raw);
    }
    return sendJson(res, result.status, result.data);
  } catch (err) {
    const status = Number(err.status || err.statusCode) || 500;
    if (status >= 500) console.error("[app_api] error:", err.message);
    let rawMsg = status >= 500 ? "Something went wrong. Please try again." : String(err.message || "");
    if (/^Missing or invalid field:/i.test(rawMsg)) {
      rawMsg = "Please check the details you entered and try again.";
    } else if (/SqliteError|SQLITE_|CALL_EXCEPTION|INSUFFICIENT_FUNDS|execution reverted|JsonRpcProvider|could not coalesce|TypeError|ReferenceError|SyntaxError/i.test(rawMsg)) {
      rawMsg = /INSUFFICIENT_FUNDS|insufficient funds/i.test(rawMsg)
        ? "Your available balance is too low to complete this transaction."
        : "Something went wrong. Please try again.";
    }
    const message = rawMsg.replace(/nuvion/gi, "Global Neobank");
    return sendJson(res, status, { error: { code: err.code || "server_error", message } });
  }
}

module.exports = {
  PREFIX,
  handleAppApiRequest,
  handleWellKnown,
  __setTestDeps,
  __resetRateLimits,
};
