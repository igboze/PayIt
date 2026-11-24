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

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= MAX_BODY_BYTES) chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) return reject(new HttpError(413, "payload_too_large", "Request body too large."));
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
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket?.remoteAddress || "unknown";
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

function authenticate(req) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  const session = tokens.verifyAccessToken(token);
  if (!session) throw new HttpError(401, "unauthorized", "Session expired. Please sign in again.");
  const user = dep("db").getUser(session.telegramId);
  if (!user) throw new HttpError(401, "unauthorized", "Account not found.");
  return { ...session, user };
}

function publicUser(user, device) {
  let tier1 = false;
  let senderName = user.sender_name || null;
  let bizSenderName = user.biz_sender_name || null;
  try { tier1 = dep("fraudGuard").isUserTier1Approved(user.telegram_id, "personal"); } catch (_) {}
  try { senderName = dep("db").resolveSenderName(user.telegram_id, "personal"); } catch (_) {}
  if (user.business_deposit_address) {
    try { bizSenderName = dep("db").resolveSenderName(user.telegram_id, "business"); } catch (_) {}
  }
  return {
    id: String(user.telegram_id),
    username: user.username || null,
    senderName,
    savedSenderName: user.sender_name || null,
    bizSenderName,
    phone: maskPhone(user.phone_number),
    telegramLinked: Number(user.telegram_id) > 0,
    kycTier: tier1 ? 1 : 0,
    depositAddress: user.deposit_address || null,
    hasBusinessAccount: Boolean(user.business_deposit_address),
    businessDepositAddress: user.business_deposit_address || null,
    activeContext: user.active_context || "personal",
    autoEarnEnabled: Boolean(user.auto_earn_enabled),
    referralCode: user.referral_code || `ref${user.telegram_id}`,
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
  try { db.recordTermsAcceptance(userId, dep("compliance").TERMS_VERSION); } catch (_) {}

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
  } catch (_) {}
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
    } catch (_) {}
    throw new HttpError(401, "session_revoked", "Session ended for your security. Please sign in again.");
  }
  if (!rotated) throw new HttpError(401, "unauthorized", "Session expired. Please sign in again.");
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
  const accountType = url.searchParams.get("account") === "business" ? "business" : "personal";
  if (accountType === "business" && !auth.user.business_deposit_address) {
    throw new HttpError(404, "no_business_account", "No business account on this profile.");
  }
  const unified = await dep("chains").getUnifiedBalance(auth.user, accountType);
  return {
    status: 200,
    data: {
      accountType,
      totalUsdc: unified.total,
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
  const accountType = url.searchParams.get("account") || null;
  const rows = dep("db").getTransactions(auth.telegramId, limit, accountType);
  return {
    status: 200,
    data: {
      transactions: rows.map((t) => ({
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
      })),
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
    } catch (_) {}
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
  const doc = req.method === "GET" ? wellKnown(pathname) : null;
  if (!doc) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "not_found" }));
  }
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" });
  return res.end(JSON.stringify(doc));
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

  // Profile, balances, transactions & statement CSV
  ["GET", "/me", me],
  ["PATCH", "/me", (req, body) => features.updateProfile(authenticate(req), body, publicUser)],
  ["PATCH", "/profile", (req, body) => features.updateProfile(authenticate(req), body, publicUser)],
  ["POST", "/me/sender-name", (req, body) => features.updateProfile(authenticate(req), body, publicUser)],
  ["GET", "/balances", balances],
  ["GET", "/transactions", transactions],
  ["GET", "/transactions/statement.csv", (req, url) => features.exportStatementCsv(authenticate(req), url)],
  ["GET", "/devices", devices],
  ["POST", "/push/register", pushRegister],

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

  // Naira & crypto (NEAR Intents) deposits & sweep
  ["POST", "/deposits/ngn", (req, body) => features.createNgnDeposit(authenticate(req), body)],
  ["GET", "/deposits/crypto/tokens", (req, url) => features.listCryptoDepositTokens(authenticate(req), url)],
  ["POST", "/deposits/crypto/intent", (req, body) => features.createCryptoDepositIntent(authenticate(req), body)],
  ["POST", "/deposits/crypto/sweep", (req, body) => features.sweepCryptoDeposits(authenticate(req), body)],

  // Cross-chain withdrawals, bridge moves & FX swap
  ["GET", "/withdrawals/chains", (req) => { authenticate(req); return features.listWithdrawalChains(); }],
  ["GET", "/bridge/moves", (req) => features.listBridgeMoves(authenticate(req))],
  ["GET", "/swap/rates", (req) => { authenticate(req); return features.getSwapRates(); }],
  ["POST", "/swap/quote", (req, body) => features.quoteSwap(authenticate(req), body)],

  // Social gift links
  ["GET", "/gifts", (req) => features.listPendingGifts(authenticate(req))],
  ["POST", "/gifts/claim", (req, body) => features.claimGift(authenticate(req), body)],

  // Global accounts, payout corridors, recipients & hosted payment links
  ["GET", "/global/accounts", (req, url) => features.listGlobalAccounts(authenticate(req), url)],
  ["GET", "/global/corridors", (req) => { authenticate(req); return features.listGlobalCorridors(); }],
  ["GET", "/global/recipients", (req, url) => features.listGlobalRecipients(authenticate(req), url)],
  ["POST", "/global/payment-links", (req, body) => features.createGlobalPaymentLink(authenticate(req), body)],

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
  ["POST", "/kyc/submit", (req, body) => features.submitKyc(authenticate(req), body)],
  ["POST", "/kyb/submit", (req, body) => features.submitKyb(authenticate(req), body)],
  ["POST", "/kyc/refresh", (req, body) => features.refreshKycStatus(authenticate(req), body)],
  ["GET", "/savings", (req) => features.getSavingsOverview(authenticate(req))],
  ["GET", "/investments/hub", (req) => features.getInvestmentsHub(authenticate(req))],

  // Personal invoices
  ["GET", "/invoices", (req, url) => features.listPersonalInvoices(authenticate(req), url)],
  ["POST", "/invoices", (req, body) => features.createPersonalInvoice(authenticate(req), body)],

  // Business home, profile, invoices, expenses, savings goal & payment links
  ["GET", "/business/home", (req) => features.getBusinessHome(authenticate(req))],
  ["GET", "/business/overview", (req) => features.getBusinessHome(authenticate(req))],
  ["PATCH", "/business/profile", (req, body) => features.updateBusinessProfile(authenticate(req), body)],
  ["PUT", "/business/profile", (req, body) => features.updateBusinessProfile(authenticate(req), body)],
  ["GET", "/business/invoices", (req, url) => features.listBusinessInvoices(authenticate(req), url)],
  ["POST", "/business/invoices", (req, body) => features.createBusinessInvoice(authenticate(req), body)],
  ["GET", "/business/expenses", (req, url) => features.listBusinessExpenses(authenticate(req), url)],
  ["POST", "/business/expenses", (req, body) => features.logBusinessExpense(authenticate(req), body)],
  ["PUT", "/business/savings-goal", (req, body) => features.setBusinessSavingsGoal(authenticate(req), body)],
  ["GET", "/business/payment-links", (req) => features.listBusinessPaymentLinks(req, authenticate(req))],
  ["POST", "/business/payment-links", (req, body) => features.createBusinessPaymentLink(req, authenticate(req), body)],

  // Assistant (read-only + action proposals)
  ["POST", "/assistant", (req, body) => {
    const auth = authenticate(req);
    rateLimit(`assistant:${auth.telegramId}`, 30, 60 * 1000);
    return features.assistantChat(auth, body);
  }],
];

const PARAM_ROUTES = [
  ["POST", /^\/actions\/([a-z0-9._-]+)\/intent$/, (req, body, m) => actionIntent(req, body, m[1])],
  ["POST", /^\/devices\/([A-Za-z0-9_-]{16,128})\/revoke\/intent$/, (req, body, m) => deviceRevokeIntent(req, body, m[1])],
  ["POST", /^\/devices\/([A-Za-z0-9_-]{16,128})\/revoke$/, (req, body, m) => deviceRevoke(req, body, m[1])],
  ["GET", /^\/transactions\/(\d+)\/receipt$/, (req, _arg, m) => features.getTransactionReceipt(authenticate(req), m[1])],
  ["DELETE", /^\/contacts\/([^/]+)$/, (req, _arg, m) => features.deleteContact(authenticate(req), m[1])],
  ["GET", /^\/deposits\/ngn\/([^/]+)$/, (req, _arg, m) => features.getNgnDepositStatus(authenticate(req), m[1])],
  ["GET", /^\/deposits\/crypto\/(\d+)$/, (req, _arg, m) => features.getCryptoDepositStatus(authenticate(req), m[1])],
  ["POST", /^\/global\/accounts\/([A-Za-z]{3})$/, (req, body, m) => features.provisionGlobalAccount(authenticate(req), body, m[1])],
  ["GET", /^\/cards\/([^/]+)\/transactions$/, (req, url, m) => features.listCardTransactions(authenticate(req), url, m[1])],
  ["DELETE", /^\/schedules\/([^/]+)$/, (req, _arg, m) => features.updateScheduleStatus(authenticate(req), m[1], "cancelled")],
  ["POST", /^\/schedules\/([^/]+)\/cancel$/, (req, _arg, m) => features.updateScheduleStatus(authenticate(req), m[1], "cancelled")],
  ["POST", /^\/schedules\/([^/]+)\/pause$/, (req, _arg, m) => features.updateScheduleStatus(authenticate(req), m[1], "paused")],
  ["POST", /^\/schedules\/([^/]+)\/resume$/, (req, _arg, m) => features.updateScheduleStatus(authenticate(req), m[1], "active")],
  ["GET", /^\/invoices\/(\d+)$/, (req, _arg, m) => features.getPersonalInvoice(authenticate(req), m[1])],
  ["POST", /^\/invoices\/(\d+)\/mark-paid$/, (req, _arg, m) => features.markPersonalInvoicePaid(authenticate(req), m[1])],
  ["GET", /^\/business\/invoices\/(\d+)$/, (req, _arg, m) => features.getBusinessInvoice(authenticate(req), m[1])],
  ["POST", /^\/business\/invoices\/(\d+)\/mark-paid$/, (req, _arg, m) => features.markBusinessInvoicePaid(authenticate(req), m[1])],
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
    const arg = hasJsonBody ? await parseBody(req) : url;
    const result = await handler(req, arg, match);
    if (result.raw !== undefined) {
      res.writeHead(result.status, {
        "Content-Type": result.contentType || "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(result.headers || {}),
      });
      return res.end(result.raw);
    }
    return sendJson(res, result.status, result.data);
  } catch (err) {
    const status = Number(err.status || err.statusCode) || 500;
    if (status >= 500) console.error("[app_api] error:", err.message);
    const rawMsg = status >= 500 ? "Something went wrong. Please try again." : err.message;
    const message = String(rawMsg || "").replace(/nuvion/gi, "Global Neobank");
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
