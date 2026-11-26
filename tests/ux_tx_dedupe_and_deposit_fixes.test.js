const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Readable } = require("node:stream");

const tmpDb = path.join(os.tmpdir(), `payit_ux_dedupe_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = tmpDb;
process.env.NODE_ENV = "test";
process.env.APP_JWT_SECRET = "test-secret-for-ux-dedupe-tests-only-123456";
process.env.INVOICE_FORWARDING_SECRET = "test-forwarding-secret-32-chars-minimum";

const db = require("../src/db");
const store = require("../src/app_api/store");
const routes = require("../src/app_api/routes");
const tokens = require("../src/app_api/tokens");
const actions = require("../src/app_api/actions");
store.ensureAppSchema();

function makeReq(method, urlPath, { token = null, body = null, headers = {} } = {}) {
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;
  const stream = Readable.from(payload ? [payload] : []);
  stream.method = method;
  stream.url = `/api/app/v1${urlPath}`;
  stream.headers = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(payload ? { "content-type": "application/json" } : {}),
    ...headers,
  };
  stream.socket = { remoteAddress: "127.0.0.1" };
  return stream;
}

function makeRes() {
  let statusCode = 200;
  let headers = {};
  const chunks = [];
  return {
    writeHead(code, h) { statusCode = code; headers = h || {}; },
    end(data) { if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data))); },
    get status() { return statusCode; },
    get headers() { return headers; },
    json() { return JSON.parse(Buffer.concat(chunks).toString("utf8")); },
  };
}

test.after(() => {
  try { db.db.close(); } catch (_) {}
  try { fs.unlinkSync(tmpDb); } catch (_) {}
});

test("recordTransaction deduplicates offramp submitted + webhook confirmed pairs", () => {
  const tgId = 9001001;
  db.db.prepare(
    "INSERT OR REPLACE INTO users (telegram_id, username, deposit_address, encrypted_key, key_salt, key_iv, key_tag) VALUES (?, 'tester1', '0x1111111111111111111111111111111111111111', 'k', 's', 'i', 't')"
  ).run(tgId);

  const onchainHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const orderId = "PAJ-ORD-9001";
  db.recordOfframpOrder({
    orderId,
    telegramId: tgId,
    accountType: "personal",
    accountNumber: "0123456789",
    bankCode: "058",
    bankName: "GTBank",
    accountName: "ADA TEST",
    amountUsdc: 10,
    fiatAmount: 16000,
    rate: 1600,
    rail: "arc",
    txHash: onchainHash,
    narration: "Lunch",
    status: "submitted",
  });

  // 1. Action records initial submitted offramp with onchainHash
  const id1 = db.recordTransaction(tgId, "offramp", "10000000000000000000", "submitted", onchainHash, "personal", 18, "arc", "Lunch");
  // 2. Webhook fires with orderId instead of onchainHash
  const id2 = db.recordTransaction(tgId, "offramp", "10000000000000000000", "confirmed", orderId, "personal", 18, "arc", null, { orderId });
  // 3. Poller fires again with onchainHash
  const id3 = db.recordTransaction(tgId, "offramp", "10000000000000000000", "confirmed", onchainHash, "personal", 18, "arc", null, { orderId });

  assert.equal(id2, id1, "webhook should update the initial submitted row instead of inserting a second row");
  assert.equal(id3, id1, "poller should also update the same row");

  const rows = db.getTransactions(tgId, 20, "personal");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "confirmed");
  assert.equal(rows[0].narration, "Lunch", "original narration must be preserved");
});

test("GET /transactions collapses already-existing historical duplicate rows", async () => {
  const tgId = 9001002;
  db.db.prepare(
    "INSERT OR REPLACE INTO users (telegram_id, username, deposit_address, encrypted_key, key_salt, key_iv, key_tag) VALUES (?, 'tester2', '0x2222222222222222222222222222222222222222', 'k', 's', 'i', 't')"
  ).run(tgId);

  const onchainHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const orderId = "PAJ-HIST-9002";
  db.recordOfframpOrder({
    orderId,
    telegramId: tgId,
    accountType: "personal",
    accountNumber: "0987654321",
    bankCode: "044",
    bankName: "Access Bank",
    accountName: "ISRAEL IGBOZE",
    amountUsdc: 15,
    fiatAmount: 24000,
    rate: 1600,
    rail: "arc",
    txHash: onchainHash,
    narration: "Groceries",
    status: "completed",
  });

  // Simulate TWO legacy duplicate rows already sitting in SQLite
  db.db.prepare(
    "INSERT INTO transactions (telegram_id, type, amount_micro, status, tx_hash, account_type, decimals, chain, narration) VALUES (?, 'offramp', '15000000000000000000', 'submitted', ?, 'personal', 18, 'arc', 'Groceries')"
  ).run(tgId, onchainHash);
  db.db.prepare(
    "INSERT INTO transactions (telegram_id, type, amount_micro, status, tx_hash, account_type, decimals, chain, narration) VALUES (?, 'offramp', '15000000000000000000', 'confirmed', ?, 'personal', 18, 'arc', NULL)"
  ).run(tgId, orderId);

  store.upsertDevice({ deviceId: "dev_dedupe_test_01", telegramId: tgId, platform: "android", deviceName: "Test Phone" });
  const { accessToken } = tokens.issueAccessToken({ telegramId: tgId, deviceId: "dev_dedupe_test_01" });
  const req = makeReq("GET", "/transactions?limit=20&account=personal", { token: accessToken });
  const res = makeRes();
  await routes.handleAppApiRequest(req, res);

  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.transactions.length, 1, "historical duplicate offramp rows must collapse into 1");
  assert.equal(body.transactions[0].status, "confirmed");
  assert.equal(body.transactions[0].narration, "Groceries");
});

test("routes.js sanitizes developer validation errors and touches last_activity_at", async () => {
  const tgId = 9001003;
  db.db.prepare(
    "INSERT OR REPLACE INTO users (telegram_id, username, deposit_address, encrypted_key, key_salt, key_iv, key_tag, last_activity_at) VALUES (?, 'tester3', '0x3333333333333333333333333333333333333333', 'k', 's', 'i', 't', '2020-01-01 00:00:00')"
  ).run(tgId);

  store.upsertDevice({ deviceId: "dev_touch_test_01", telegramId: tgId, platform: "android", deviceName: "Test Phone" });
  const { accessToken } = tokens.issueAccessToken({ telegramId: tgId, deviceId: "dev_touch_test_01" });
  const req = makeReq("GET", "/transactions?limit=5", { token: accessToken });
  const res = makeRes();
  await routes.handleAppApiRequest(req, res);
  assert.equal(res.status, 200);

  const updated = db.db.prepare("SELECT last_activity_at FROM users WHERE telegram_id = ?").get(tgId);
  assert.notEqual(updated.last_activity_at, "2020-01-01 00:00:00", "mobile API calls must refresh last_activity_at for deposit sweeper");

  // Missing required field should NOT leak developer message "Missing or invalid field: ..."
  const badReq = makeReq("POST", "/auth/login/finish", { body: {} });
  const badRes = makeRes();
  await routes.handleAppApiRequest(badReq, badRes);
  assert.equal(badRes.status, 400);
  const errBody = badRes.json();
  assert.ok(!/Missing or invalid field/i.test(errBody.error.message), `Expected user-facing message, got: ${errBody.error.message}`);
});

test("transfer.user waits for confirmation and falls back to Solana when Arc balance is insufficient", async () => {
  const senderId = 9001004;
  const recipientId = 9001005;
  db.db.prepare(
    "INSERT OR REPLACE INTO users (telegram_id, username, deposit_address, solana_deposit_address, encrypted_key, key_salt, key_iv, key_tag) VALUES (?, 'sender_u', '0x4444444444444444444444444444444444444444', 'So11111111111111111111111111111111111111111', 'k', 's', 'i', 't')"
  ).run(senderId);
  db.db.prepare(
    "INSERT OR REPLACE INTO users (telegram_id, username, deposit_address, solana_deposit_address, encrypted_key, key_salt, key_iv, key_tag) VALUES (?, 'israel_igboze', '0x5555555555555555555555555555555555555555', 'So22222222222222222222222222222222222222222', 'k', 's', 'i', 't')"
  ).run(recipientId);

  let solanaSent = null;
  actions.__setTestDeps({
    db: {
      ...db,
      decryptPrivateKey: () => "0x" + "1".repeat(64),
    },
    walletLib: {
      walletFromPrivateKey: () => ({ address: "0x4444444444444444444444444444444444444444" }),
      parseToMicro: (s) => BigInt(Math.round(Number(s) * 1e6)) * 1_000_000_000_000n,
      getNativeBalanceMicro: async () => 0n, // $0 on Arc
      sendSponsoredOrDirectTransaction: async () => { throw new Error("should not call Arc when Arc has $0 and Solana has $5"); },
    },
    autoEarn: { ensureLiquidBalance: async () => ({ liquidated: false }) },
    fraudGuard: { assertOutboundAllowed: async () => {} },
    chains: { deriveAddress: () => "So22222222222222222222222222222222222222222" },
    multichain: {
      deriveSolanaFromEvmKey: () => ({ keypair: {}, solanaAddress: "So11111111111111111111111111111111111111111" }),
      getSplTokenBalance: async () => ({ uiAmount: 5.0 }),
      sendSolanaTransfer: async (params) => {
        solanaSent = params;
        return { success: true, txHash: "5SolanaP2PTxHash220" };
      },
    },
    notify: { notify: async () => {} },
  });

  try {
    const sender = db.getUser(senderId);
    const res = await actions.ACTIONS["transfer.user"].execute(
      { telegramId: senderId, user: sender },
      {
        accountType: "personal",
        recipientId: String(recipientId),
        recipientLabel: "@israel_igboze",
        toAddress: "0x5555555555555555555555555555555555555555",
        amountUsdc: "2.200000",
        narration: "Test $2.2",
      },
      "1234"
    );
    assert.equal(res.txHash, "5SolanaP2PTxHash220");
    assert.equal(solanaSent.amount, 2.2);
    assert.equal(solanaSent.recipientAddress, "So22222222222222222222222222222222222222222");

    const recvTxs = db.getTransactions(recipientId, 5, "personal");
    assert.equal(recvTxs.length, 1);
    assert.equal(recvTxs[0].type, "p2p_receive");
    assert.equal(recvTxs[0].chain, "solana");
  } finally {
    actions.__setTestDeps({});
  }
});

test("payout.ngn routes 1% platform fee to dev fee wallet on Arc", async () => {
  const userId = 9001006;
  db.db.prepare(
    "INSERT OR REPLACE INTO users (telegram_id, username, deposit_address, encrypted_key, key_salt, key_iv, key_tag) VALUES (?, 'payout_tester', '0x6666666666666666666666666666666666666666', 'k', 's', 'i', 't')"
  ).run(userId);

  const sentTxs = [];
  actions.__setTestDeps({
    db: { ...db, decryptPrivateKey: () => "0x" + "2".repeat(64) },
    fraudGuard: { assertOutboundAllowed: async () => {} },
    paj: {
      createOfframpPayout: async () => ({
        id: "PAJ-FEE-TEST-1",
        address: "0x7777777777777777777777777777777777777777",
        amount: 20,
        fiatAmount: 32000,
        rate: 1600,
        bankName: "GTBank",
        accountName: "TEST USER",
      }),
    },
    multichain: { isSolanaAddress: () => false },
    walletLib: {
      isValidAddress: (a) => /^0x[0-9a-fA-F]{40}$/.test(a),
      walletFromPrivateKey: () => ({ address: "0x6666666666666666666666666666666666666666", getNonce: async () => 5 }),
      parseToMicro: (s) => BigInt(Math.round(Number(s) * 1e6)) * 1_000_000_000_000n,
      getNativeBalanceMicro: async () => 50_000_000_000_000_000_000n,
      sendSponsoredOrDirectTransaction: async (_signer, to, amountMicro, _data, opts) => {
        sentTxs.push({ to: to.toLowerCase(), amountMicro: amountMicro.toString(), nonce: opts?.nonce });
        return { txHash: `0xtx_${sentTxs.length}` };
      },
    },
  });

  try {
    const user = db.getUser(userId);
    const res = await actions.ACTIONS["payout.ngn"].execute(
      { telegramId: userId, user },
      {
        accountType: "personal",
        amountUsdc: "20.000000",
        amountNgn: "32000",
        bankCode: "058",
        accountNumber: "0123456789",
        accountName: "TEST USER",
        narration: "Rent",
      },
      "1234"
    );
    assert.equal(sentTxs.length, 2, "must broadcast payout tx AND 1% dev fee tx");
    assert.equal(sentTxs[0].to, "0x7777777777777777777777777777777777777777");
    assert.equal(sentTxs[0].nonce, 5);
    assert.equal(sentTxs[1].to, "0x0ac27c77c56f5176c37ae23be3a42a130e3a9359");
    assert.equal(sentTxs[1].amountMicro, "200000000000000000"); // $0.20 (1% of $20)
    assert.equal(sentTxs[1].nonce, 6);
    assert.equal(res.feeUsdc, 0.2);
    assert.equal(res.feeTxHash, "0xtx_2");
  } finally {
    actions.__setTestDeps({});
  }
});

test("transfer.user resolves negative app-only recipient IDs without false recipient_changed error", async () => {
  const senderId = -1500000001;
  const recipientId = -1500000002;
  db.db.prepare(
    "INSERT OR REPLACE INTO users (telegram_id, username, deposit_address, encrypted_key, key_salt, key_iv, key_tag) VALUES (?, 'app_sender', '0x8888888888888888888888888888888888888888', 'k', 's', 'i', 't')"
  ).run(senderId);
  db.db.prepare(
    "INSERT OR REPLACE INTO users (telegram_id, username, deposit_address, encrypted_key, key_salt, key_iv, key_tag) VALUES (?, 'app_receiver', '0x9999999999999999999999999999999999999999', 'k', 's', 'i', 't')"
  ).run(recipientId);

  actions.__setTestDeps({
    db: { ...db, decryptPrivateKey: () => "0x" + "3".repeat(64) },
    fraudGuard: { assertOutboundAllowed: async () => {} },
    walletLib: {
      walletFromPrivateKey: () => ({ address: "0x8888888888888888888888888888888888888888" }),
      parseToMicro: (s) => BigInt(Math.round(Number(s) * 1e6)) * 1_000_000_000_000n,
      getNativeBalanceMicro: async () => 50_000_000_000_000_000_000n,
      sendSponsoredOrDirectTransaction: async () => ({ txHash: "0xapp_p2p_ok" }),
    },
    notify: { notify: async () => {} },
  });

  try {
    const sender = db.getUser(senderId);
    const prep = await actions.ACTIONS["transfer.user"].prepare(
      { telegramId: senderId, user: sender },
      { recipient: "@app_receiver", amountUsdc: 5 }
    );
    const res = await actions.ACTIONS["transfer.user"].execute(
      { telegramId: senderId, user: sender },
      prep.action,
      "1234"
    );
    assert.equal(res.txHash, "0xapp_p2p_ok");
  } finally {
    actions.__setTestDeps({});
  }
});
