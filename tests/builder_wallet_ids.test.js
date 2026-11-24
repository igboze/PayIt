// tests/builder_wallet_ids.test.js
// Builder API wallets must never take a Telegram user's ID: new wallets get IDs from the
// reserved negative range, numeric external IDs are labels (not database keys), and a
// Telegram account whose ID collides with an older builder wallet is blocked in the bot.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const tmpDb = path.join(os.tmpdir(), `builder_ids_${process.pid}_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = tmpDb;
process.env.INVOICE_FORWARDING_SECRET = "builder-ids-test-secret-not-real-00";

const db = require("../src/db");
const apiKeys = require("../src/api_keys");
const apiRoutes = require("../src/api_routes");
const walletLib = require("../src/wallet");

let server;
let base;
let key;

test.before(async () => {
  key = apiKeys.generateApiKey({ telegramId: 555000111, appName: "ID test app", features: ["all"] });
  server = http.createServer((req, res) => apiRoutes.handleApiRequest(req, res, null));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
});

async function createWallet(body) {
  const res = await fetch(`${base}/api/v1/wallets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.secretKey}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("new builder wallets get IDs outside the Telegram ID range", async () => {
  const r = await createWallet({ externalId: "customer-42" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(Number(r.body.userId) < 0, `expected a negative ID, got ${r.body.userId}`);
  assert.equal(db.isApiProvisionedWallet(r.body.userId), true, "the wallet is registered to the API key");
  assert.equal(db.getUser(Number(r.body.userId)).username, "customer-42");
});

test("a numeric userId is a label, never the account's database ID", async () => {
  const futureTelegramId = 7123456789;
  const first = await createWallet({ userId: futureTelegramId });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.notEqual(Number(first.body.userId), futureTelegramId);
  assert.equal(db.getUser(futureTelegramId), null, "no row may be created under a Telegram user's ID");

  // Calling again with the same external ID returns the same wallet, not a duplicate.
  const second = await createWallet({ userId: futureTelegramId });
  assert.equal(second.body.userId, first.body.userId);
});

test("an API key cannot claim an existing Telegram user's wallet by ID", async () => {
  const tgId = 6200000001;
  const w = walletLib.generateUserWallet();
  db.createUserWithWallet(tgId, "real_tg_user", w.address, w.privateKey, "4826");
  const r = await createWallet({ userId: tgId });
  assert.equal(r.status, 409, JSON.stringify(r.body));
});

test("the bot can detect a Telegram ID that collides with an older builder wallet", () => {
  const legacyId = 812345678; // older builder wallets used random IDs in 100M–900M
  const w = walletLib.generateUserWallet();
  db.createUserWithWallet(legacyId, "builder_legacy", w.address, w.privateKey, "4826");
  db.registerApiKeyWallet("legacy-key", legacyId);
  assert.equal(db.isApiProvisionedWallet(legacyId), true);
  assert.equal(db.isApiProvisionedWallet(6200000001), false);
});
