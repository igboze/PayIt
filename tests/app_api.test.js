// tests/app_api.test.js
// End-to-end tests for the mobile app API (/api/app/v1): passkey sign-up, Telegram
// linking, login, sessions, new-device rules and passkey-bound transfers.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const tmpDb = path.join(os.tmpdir(), `app_api_test_${process.pid}_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = tmpDb;
process.env.INVOICE_FORWARDING_SECRET = "app-api-test-secret-not-real-0000";
process.env.APP_JWT_SECRET = "app-api-test-jwt-secret-not-real-0123456789";
process.env.APP_RP_ID = "proxim.test";
process.env.APP_ORIGINS = "https://proxim.test";
process.env.APP_INTEGRITY_MODE = "log";

const db = require("../src/db");
const realWallet = require("../src/wallet");
const store = require("../src/app_api/store");
const routes = require("../src/app_api/routes");
const { SoftAuthenticator } = require("./helpers/soft_authenticator");

const sent = [];
const notifications = [];
let fraudBlock = null;

routes.__setTestDeps({
  otp: {
    sendOtp: async () => ({ pinId: "pin-1" }),
    verifyOtp: async (_pinId, code) => code === "4821",
  },
  notify: async (telegramId, msg) => { notifications.push({ telegramId, ...msg }); return { telegram: true, push: 0 }; },
  chains: {
    getUnifiedBalance: async () => ({ total: "12.5", arc: { usdc: "12.5", eurc: "0" }, solana: { usdc: "0" }, pendingNear: "0" }),
  },
  fraudGuard: {
    isUserTier1Approved: () => false,
    assertOutboundAllowed: async () => { if (fraudBlock) throw new Error(fraudBlock); },
  },
  walletLib: {
    ...realWallet,
    sendSponsoredOrDirectTransaction: async (signer, to, amountMicro) => {
      sent.push({ from: signer.address, to, amountMicro: String(amountMicro) });
      return { txHash: `0x${String(sent.length).padStart(64, "0")}`, sponsored: true };
    },
  },
});

let server;
let base;

test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith("/.well-known/")) return routes.handleWellKnown(req, res);
    return routes.handleAppApiRequest(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
});

test.beforeEach(() => routes.__resetRateLimits());

async function call(method, p, body, token) {
  const res = await fetch(`${base}${p.startsWith("/.well-known") ? p : `/api/app/v1${p}`}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}

const deviceA = "device-aaaaaaaaaaaaaaaa";
const deviceB = "device-bbbbbbbbbbbbbbbb";
const recipient = "0x1111111111111111111111111111111111111111";

async function signUp(auth, phone, deviceId) {
  const start = await call("POST", "/auth/signup/start", { phone, deviceId, platform: "android" });
  assert.equal(start.status, 201, JSON.stringify(start.body));
  const verify = await call("POST", "/auth/signup/verify-otp", { signupId: start.body.signupId, code: "4821" });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  const response = auth.register(verify.body.options);
  const finish = await call("POST", "/auth/signup/finish", {
    signupId: start.body.signupId, challengeId: verify.body.challengeId, response,
    pin: "4826", acceptTerms: true, deviceName: "Pixel 9",
  });
  assert.equal(finish.status, 201, JSON.stringify(finish.body));
  return finish.body;
}

test("sign-up with phone OTP and a passkey creates an app-only account", async () => {
  const auth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const result = await signUp(auth, "+2348011111111", deviceA);

  assert.ok(Number(result.user.id) < 0, "app-only users get negative IDs");
  assert.equal(result.user.telegramLinked, false);
  assert.equal(result.user.phone, "+234•••111");
  assert.equal(result.user.deviceRestrictedUntil, null, "the first device is not restricted");
  assert.ok(result.session.accessToken && result.session.refreshToken);

  const me = await call("GET", "/me", null, result.session.accessToken);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, result.user.id);
  const bal = await call("GET", "/balances", null, result.session.accessToken);
  assert.equal(bal.body.totalUsdc, "12.5");

  // The same phone cannot register twice.
  const dup = await call("POST", "/auth/signup/start", { phone: "+2348011111111", deviceId: deviceB, platform: "android" });
  assert.equal(dup.status, 409);
});

test("wrong OTP is rejected and limited to five attempts", async () => {
  const start = await call("POST", "/auth/signup/start", { phone: "+2348022222222", deviceId: "device-cccccccccccccccc", platform: "ios" });
  for (let i = 0; i < 5; i++) {
    const bad = await call("POST", "/auth/signup/verify-otp", { signupId: start.body.signupId, code: "0000" });
    assert.equal(bad.status, 400);
  }
  const locked = await call("POST", "/auth/signup/verify-otp", { signupId: start.body.signupId, code: "4821" });
  assert.equal(locked.status, 429);
});

test("login, new-device restriction, refresh rotation and reuse detection", async () => {
  const auth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const signed = await signUp(auth, "+2348033333333", "device-dddddddddddddddd");
  notifications.length = 0;

  // Sign in on a second device with the (synced) passkey.
  const ls = await call("POST", "/auth/login/start", { deviceId: "device-eeeeeeeeeeeeeeee", platform: "ios" });
  const lf = await call("POST", "/auth/login/finish", {
    challengeId: ls.body.challengeId, response: auth.assert(ls.body.options),
    deviceId: "device-eeeeeeeeeeeeeeee", platform: "ios", deviceName: "iPhone",
  });
  assert.equal(lf.status, 200, JSON.stringify(lf.body));
  assert.equal(lf.body.user.id, signed.user.id);
  assert.ok(lf.body.user.deviceRestrictedUntil, "a second device is restricted for 24h");
  assert.ok(notifications.some((n) => n.title === "New device signed in"), "user is alerted");

  // Replaying the same login challenge fails (single use).
  const replay = await call("POST", "/auth/login/finish", {
    challengeId: ls.body.challengeId, response: auth.assert(ls.body.options),
    deviceId: "device-eeeeeeeeeeeeeeee", platform: "ios",
  });
  assert.equal(replay.status, 400);

  // Refresh rotates the token.
  const r1 = await call("POST", "/auth/refresh", { refreshToken: lf.body.session.refreshToken, deviceId: "device-eeeeeeeeeeeeeeee" });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.session.refreshToken, lf.body.session.refreshToken);

  // Re-using the old refresh token signs the user out everywhere.
  const reuse = await call("POST", "/auth/refresh", { refreshToken: lf.body.session.refreshToken, deviceId: "device-eeeeeeeeeeeeeeee" });
  assert.equal(reuse.status, 401);
  assert.equal(reuse.body.error.code, "session_revoked");
  const after = await call("GET", "/me", null, r1.body.session.accessToken);
  assert.equal(after.status, 401, "access tokens issued before the revocation stop working");
  const afterOther = await call("GET", "/me", null, signed.session.accessToken);
  assert.equal(afterOther.status, 401, "other devices are signed out too");
});

test("transfer needs a passkey approval bound to the exact action plus the PIN", async () => {
  const auth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const s = await signUp(auth, "+2348044444444", "device-ffffffffffffffff");
  const token = s.session.accessToken;
  sent.length = 0;

  const intent = await call("POST", "/transfers/intent", { toAddress: recipient, amountUsdc: 2.5, narration: "rent" }, token);
  assert.equal(intent.status, 200, JSON.stringify(intent.body));
  assert.equal(intent.body.summary.amountUsdc, "2.500000");

  // Wrong PIN: rejected, nothing sent.
  const wrongPin = await call("POST", "/transfers/confirm", { challengeId: intent.body.challengeId, response: auth.assert(intent.body.options), pin: "9999" }, token);
  assert.equal(wrongPin.status, 401);
  assert.equal(sent.length, 0);

  // The challenge was consumed by that attempt; a fresh intent is needed.
  const intent2 = await call("POST", "/transfers/intent", { toAddress: recipient, amountUsdc: 2.5 }, token);
  const ok = await call("POST", "/transfers/confirm", { challengeId: intent2.body.challengeId, response: auth.assert(intent2.body.options), pin: "4826" }, token);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, recipient);
  assert.equal(sent[0].amountMicro, realWallet.parseToMicro("2.500000").toString());
  const txs = await call("GET", "/transactions", null, token);
  assert.equal(txs.body.transactions[0].txHash, ok.body.txHash);

  // A signature over one challenge cannot confirm another transfer.
  const intent3 = await call("POST", "/transfers/intent", { toAddress: recipient, amountUsdc: 99 }, token);
  const intent4 = await call("POST", "/transfers/intent", { toAddress: recipient, amountUsdc: 1 }, token);
  const swapped = await call("POST", "/transfers/confirm", { challengeId: intent3.body.challengeId, response: auth.assert(intent4.body.options), pin: "4826" }, token);
  assert.equal(swapped.status, 401);
  assert.equal(sent.length, 1);

  // fraud_guard blocks are respected.
  fraudBlock = "Daily limit reached";
  const blocked = await call("POST", "/transfers/intent", { toAddress: recipient, amountUsdc: 1 }, token);
  fraudBlock = null;
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.message, "Daily limit reached");
});

test("another user's passkey cannot approve a transfer", async () => {
  const alice = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const mallory = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const a = await signUp(alice, "+2348055555555", "device-gggggggggggggggg");
  await signUp(mallory, "+2348066666666", "device-hhhhhhhhhhhhhhhh");
  sent.length = 0;
  const intent = await call("POST", "/transfers/intent", { toAddress: recipient, amountUsdc: 1 }, a.session.accessToken);
  // Mallory's authenticator holds only her own credential.
  const res = await call("POST", "/transfers/confirm", { challengeId: intent.body.challengeId, response: mallory.assert(intent.body.options), pin: "4826" }, a.session.accessToken);
  assert.equal(res.status, 403);
  assert.equal(sent.length, 0);
});

test("a passkey signed for a different origin (phishing site) is rejected", async () => {
  const auth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const s = await signUp(auth, "+2348077777777", "device-iiiiiiiiiiiiiiii");
  const ls = await call("POST", "/auth/login/start", { deviceId: "device-iiiiiiiiiiiiiiii", platform: "android" });
  const res = await call("POST", "/auth/login/finish", {
    challengeId: ls.body.challengeId,
    response: auth.assert(ls.body.options, undefined, { origin: "https://proxim-login.evil" }),
    deviceId: "device-iiiiiiiiiiiiiiii", platform: "android",
  });
  assert.equal(res.status, 401);
  assert.ok(s.user.id);
});

test("new devices are limited to small transfers for 24 hours", async () => {
  const auth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  await signUp(auth, "+2348088888888", "device-jjjjjjjjjjjjjjjj");
  const ls = await call("POST", "/auth/login/start", { deviceId: "device-kkkkkkkkkkkkkkkk", platform: "android" });
  const lf = await call("POST", "/auth/login/finish", {
    challengeId: ls.body.challengeId, response: auth.assert(ls.body.options),
    deviceId: "device-kkkkkkkkkkkkkkkk", platform: "android",
  });
  const big = await call("POST", "/transfers/intent", { toAddress: recipient, amountUsdc: 500 }, lf.body.session.accessToken);
  assert.equal(big.status, 403);
  assert.equal(big.body.error.code, "new_device_limit");
  const small = await call("POST", "/transfers/intent", { toAddress: recipient, amountUsdc: 20 }, lf.body.session.accessToken);
  assert.equal(small.status, 200);
});

test("an existing Telegram user links the app with a one-time code and their PIN", async () => {
  const tgId = 777000111;
  const w = realWallet.generateUserWallet();
  db.createUserWithWallet(tgId, "tg_user", w.address, w.privateKey, "5937");
  const { code } = store.createLinkCode(tgId);
  const auth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });

  const ls = await call("POST", "/auth/link/start", { code, deviceId: "device-llllllllllllllll", platform: "ios" });
  assert.equal(ls.status, 200, JSON.stringify(ls.body));
  const response = auth.register(ls.body.options);

  // Wrong PIN: rejected, and the code is not burned.
  const bad = await call("POST", "/auth/link/finish", { code, challengeId: ls.body.challengeId, response, pin: "1357", deviceId: "device-llllllllllllllll", platform: "ios" });
  assert.equal(bad.status, 401);

  const ls2 = await call("POST", "/auth/link/start", { code, deviceId: "device-llllllllllllllll", platform: "ios" });
  const response2 = auth.register(ls2.body.options);
  const ok = await call("POST", "/auth/link/finish", { code, challengeId: ls2.body.challengeId, response: response2, pin: "5937", deviceId: "device-llllllllllllllll", platform: "ios", deviceName: "iPhone" });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.user.id, String(tgId));
  assert.equal(ok.body.user.telegramLinked, true);

  // The code works once.
  const again = await call("POST", "/auth/link/start", { code, deviceId: "device-mmmmmmmmmmmmmmmm", platform: "ios" });
  assert.equal(again.status, 400);
});

test("device revocation needs a passkey approval and ends that device's session", async () => {
  const auth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const s = await signUp(auth, "+2348099999999", "device-nnnnnnnnnnnnnnnn");
  const ls = await call("POST", "/auth/login/start", { deviceId: "device-oooooooooooooooo", platform: "android" });
  const lf = await call("POST", "/auth/login/finish", { challengeId: ls.body.challengeId, response: auth.assert(ls.body.options), deviceId: "device-oooooooooooooooo", platform: "android" });

  const list = await call("GET", "/devices", null, s.session.accessToken);
  assert.equal(list.body.devices.length, 2);

  const noApproval = await call("POST", "/devices/device-oooooooooooooooo/revoke", { challengeId: "nope" }, s.session.accessToken);
  assert.equal(noApproval.status, 400);

  const intent = await call("POST", "/devices/device-oooooooooooooooo/revoke/intent", {}, s.session.accessToken);
  const done = await call("POST", "/devices/device-oooooooooooooooo/revoke", { challengeId: intent.body.challengeId, response: auth.assert(intent.body.options) }, s.session.accessToken);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const revokedMe = await call("GET", "/me", null, lf.body.session.accessToken);
  assert.equal(revokedMe.status, 401);
});

test("integrity enforce mode rejects requests without a verified token", async () => {
  process.env.APP_INTEGRITY_MODE = "enforce";
  try {
    const res = await call("POST", "/auth/login/start", { deviceId: "device-pppppppppppppppp", platform: "android" });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "integrity_failed");
  } finally {
    process.env.APP_INTEGRITY_MODE = "log";
  }
});

test(".well-known association files are served only when configured", async () => {
  const none = await call("GET", "/.well-known/assetlinks.json");
  assert.equal(none.status, 404);
  process.env.APP_ANDROID_PACKAGE = "app.proxim.mobile";
  process.env.APP_ANDROID_CERT_SHA256 = "AA:BB:CC";
  process.env.APP_IOS_APP_IDS = "TEAMID.app.proxim.mobile";
  try {
    const android = await call("GET", "/.well-known/assetlinks.json");
    assert.equal(android.status, 200);
    assert.equal(android.body[0].target.package_name, "app.proxim.mobile");
    const ios = await call("GET", "/.well-known/apple-app-site-association");
    assert.deepEqual(ios.body.webcredentials.apps, ["TEAMID.app.proxim.mobile"]);
  } finally {
    delete process.env.APP_ANDROID_PACKAGE;
    delete process.env.APP_ANDROID_CERT_SHA256;
    delete process.env.APP_IOS_APP_IDS;
  }
});

test("unauthenticated and malformed requests are refused", async () => {
  assert.equal((await call("GET", "/me")).status, 401);
  assert.equal((await call("GET", "/me", null, "a.b.c")).status, 401);
  assert.equal((await call("POST", "/auth/signup/start", { phone: "08012345678", deviceId: deviceA, platform: "android" })).status, 400);
  assert.equal((await call("POST", "/auth/signup/start", { phone: "+2348012345678", deviceId: "short", platform: "android" })).status, 400);
  assert.equal((await call("GET", "/nope")).status, 404);
});
