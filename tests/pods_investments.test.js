// tests/pods_investments.test.js
// Tests Pods Finance Investments (Ondo Stocks, Insured & High-Yield Vaults,
// HMAC Webhook Verification, SQLite Action Store & Idempotent Notifications)

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

// Isolated temp SQLite DB
process.env.PAYIT_DB_PATH = path.join(os.tmpdir(), `test_pods_inv_${Date.now()}.db`);
require("dotenv").config();

const pods = require("../src/pods");
const podsExecutor = require("../src/pods_executor");
const podsStore = require("../src/pods_store");

test("Feature gate keeps Pods Investments hidden from general users by default", () => {
  const origEnabled = process.env.PODS_INVESTMENTS_ENABLED;
  const origAllowed = process.env.PODS_ALLOWED_TELEGRAM_IDS;
  const origKey = process.env.PODS_API_KEY;
  try {
    process.env.PODS_API_KEY = "test_key_only";
    delete process.env.PODS_INVESTMENTS_ENABLED;
    delete process.env.PODS_ALLOWED_TELEGRAM_IDS;
    assert.equal(pods.isInvestmentsEnabledForUser(123456), false);

    process.env.PODS_ALLOWED_TELEGRAM_IDS = "111,222";
    assert.equal(pods.isInvestmentsEnabledForUser(111), true);
    assert.equal(pods.isInvestmentsEnabledForUser(999), false);

    process.env.PODS_INVESTMENTS_ENABLED = "true";
    assert.equal(pods.isInvestmentsEnabledForUser(999), true);
  } finally {
    if (origEnabled === undefined) delete process.env.PODS_INVESTMENTS_ENABLED;
    else process.env.PODS_INVESTMENTS_ENABLED = origEnabled;
    if (origAllowed === undefined) delete process.env.PODS_ALLOWED_TELEGRAM_IDS;
    else process.env.PODS_ALLOWED_TELEGRAM_IDS = origAllowed;
    if (origKey === undefined) delete process.env.PODS_API_KEY;
    else process.env.PODS_API_KEY = origKey;
  }
});

test("Pods ticker normalization, strategy IDs, and EIP-7702 constants", () => {
  assert.equal(pods.normalizeTicker(" $aapl "), "AAPL");
  assert.equal(pods.normalizeTicker("NVDAon"), "NVDA");
  assert.equal(pods.toOndoStrategyId("tsla"), "Ondo-TSLA-bsc");
  assert.equal(pods.toOndoMarketSymbol("nvda"), "NVDAon");
  assert.equal(podsExecutor.SIMPLE_7702_ACCOUNT_ADDRESS, "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9");
  assert.equal(podsExecutor.toBaseUsdcUnits(50), "50000000");
});

test("Pods curated savings vaults expose transparent lock/unlock periods", () => {
  assert.ok(pods.CURATED_SAVINGS_VAULTS.length >= 5);
  const insured = pods.getSavingsVaultByShortId("insured");
  assert.equal(insured.id, "Sky-CoveredSavingsDAI-gnosis");
  assert.equal(insured.lockPeriod, "No lockup");
  const earnUsd = pods.getSavingsVaultByShortId("earnusd");
  assert.equal(earnUsd.id, "Lido-EarnUSD-ethereum");
  assert.ok(earnUsd.unlockPeriod.includes("72h"));
});

test("Pods webhook HMAC-SHA256 signature verification accepts valid & rejects invalid", () => {
  const secretHex = crypto.randomBytes(32).toString("hex");
  const secret = `whsec_${secretHex}`;
  const id = "evt_test_123";
  const ts = "1795439900";
  const rawBody = JSON.stringify({ messageType: "ACTION_UPDATE", data: { id: "act_1", status: "SUCCESS" } });

  const sig = crypto
    .createHmac("sha256", Buffer.from(secretHex, "hex"))
    .update(`${id}.${ts}.${rawBody}`)
    .digest("hex");

  assert.equal(
    pods.verifyPodsWebhookSignature(
      rawBody,
      {
        "x-deframe-webhook-id": id,
        "x-deframe-webhook-timestamp": ts,
        "x-deframe-webhook-signature": `v1,${sig}`,
      },
      secret
    ),
    true
  );

  assert.equal(
    pods.verifyPodsWebhookSignature(
      rawBody,
      {
        "x-deframe-webhook-id": id,
        "x-deframe-webhook-timestamp": ts,
        "x-deframe-webhook-signature": "v1,0000000000000000000000000000000000000000000000000000000000000000",
      },
      secret
    ),
    false
  );
});

test("podsStore tracks disclaimers, actions, and sends idempotent Telegram fill notifications", async () => {
  const tid = 99887766;
  assert.equal(podsStore.hasAcceptedInvestmentsDisclaimer(tid), false);
  podsStore.acceptInvestmentsDisclaimer(tid);
  assert.equal(podsStore.hasAcceptedInvestmentsDisclaimer(tid), true);

  podsStore.recordPodsAction({
    telegramId: tid,
    accountType: "personal",
    walletAddress: "0x1111111111111111111111111111111111111111",
    kind: "stock_buy",
    strategyId: "Ondo-NVDA-bsc",
    ticker: "NVDA",
    amountUsd: 100,
    txHash: "0xabc",
    podsActionId: "pods_act_nvda_1",
    status: "PENDING",
  });

  assert.deepEqual(podsStore.getUserTrackedStockTickers(tid, "personal"), ["NVDA"]);

  const sent = [];
  const fakeBot = {
    telegram: {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    },
  };

  // First SUCCESS update notifies user
  const res1 = await podsStore.processPodsActionUpdate(fakeBot, { id: "pods_act_nvda_1", status: "SUCCESS" });
  assert.equal(res1.notified, true);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes("NVDA Stock"));

  // Duplicate SUCCESS webhook does NOT double-notify
  const res2 = await podsStore.processPodsActionUpdate(fakeBot, { id: "pods_act_nvda_1", status: "SUCCESS" });
  assert.equal(res2.duplicate, true);
  assert.equal(sent.length, 1);
});

test("Live Pods API check (skipped if PODS_API_KEY unset): stock search, market status, and vaults", async (t) => {
  if (!pods.isConfigured()) {
    t.skip("PODS_API_KEY not configured");
    return;
  }
  const matches = await pods.searchStocks("AAPL", 5);
  assert.ok(matches.some((m) => m.ticker === "AAPL"), "Should find AAPL in live Ondo catalog");

  const status = await pods.getStockMarketStatus("AAPL");
  assert.equal(status.ticker, "AAPL");
  assert.ok(status.price > 0, "Live AAPL price should be positive");

  const vaults = await pods.getCuratedSavingsVaults(true);
  assert.equal(vaults.length, 5);
  assert.ok(vaults.every((v) => Number(v.apyPct) >= 0));
});
