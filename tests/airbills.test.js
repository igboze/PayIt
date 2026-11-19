"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Keypair } = require("@solana/web3.js");

const testDbPath = path.join(__dirname, `test_airbills_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = testDbPath;

const db = require("../src/db");
const airbills = require("../src/airbills");

test.before(() => {
  db.ensureBillPaymentsSchema();
});

test.after(() => {
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch (_) {}
});

test("Airbills: supports all 6 product codes and Nigerian phone/network helpers", () => {
  assert.equal(airbills.PRODUCTS.AIRTIME.code, "100");
  assert.equal(airbills.PRODUCTS.ELECTRICITY.code, "101");
  assert.equal(airbills.PRODUCTS.DATA.code, "102");
  assert.equal(airbills.PRODUCTS.BETTING.code, "103");
  assert.equal(airbills.PRODUCTS.CABLE.code, "104");
  assert.equal(airbills.PRODUCTS.TRANSPORT.code, "105");

  assert.equal(airbills.getNetworkName("01"), "MTN");
  assert.equal(airbills.getNetworkName("02"), "Glo");
  assert.equal(airbills.getNetworkName("03"), "9mobile");
  assert.equal(airbills.getNetworkName("04"), "Airtel");

  assert.equal(airbills.normalizeNigerianPhone("+234 801 234 5678"), "08012345678");
  assert.equal(airbills.isValidNigerianPhone("08012345678"), true);
  assert.equal(airbills.isValidNigerianPhone("2349012345678"), true);
  assert.equal(airbills.isValidNigerianPhone("12345"), false);
});

test("Airbills: extractMeterToken handles multiple response shapes", () => {
  assert.equal(airbills.extractMeterToken({ data: { token: "1234-5678-9012" } }), "1234-5678-9012");
  assert.equal(airbills.extractMeterToken({ data: { meterToken: "9999-8888" } }), "9999-8888");
  assert.equal(airbills.extractMeterToken({ data: { purchased_code: "4444-3333" } }), "4444-3333");
  assert.equal(airbills.extractMeterToken({ data: {} }), null);
});

test("Airbills: ensureUserSolanaActivated skips when ATA and SOL already exist", async () => {
  const userKeypair = Keypair.generate();
  const mockConn = {
    getAccountInfo: async () => ({ lamports: 2039280, data: Buffer.alloc(165) }),
    getBalance: async () => 1_000_000,
  };

  const res = await airbills.ensureUserSolanaActivated(userKeypair.publicKey, {
    connection: mockConn,
  });

  assert.equal(res.alreadyReady, true);
  assert.equal(res.activated, false);
  assert.ok(res.ataAddress);
});

test("Airbills: ensureUserSolanaActivated throws cleanly if activation needed and SOLANA_FEE_PAYER_KEY missing", async () => {
  const userKeypair = Keypair.generate();
  const prevKey = process.env.SOLANA_FEE_PAYER_KEY;
  delete process.env.SOLANA_FEE_PAYER_KEY;

  const mockConn = {
    getAccountInfo: async () => null, // ATA missing
    getBalance: async () => 0,         // SOL missing
  };

  try {
    await assert.rejects(
      async () => {
        await airbills.ensureUserSolanaActivated(userKeypair.publicKey, {
          connection: mockConn,
          feePayerKey: "",
        });
      },
      /SOLANA_FEE_PAYER_KEY/
    );
  } finally {
    if (prevKey !== undefined) process.env.SOLANA_FEE_PAYER_KEY = prevKey;
  }
});

test("Airbills DB: create, update (with meter token), and list user bill payments", () => {
  const tgId = 555001;
  const created = db.createBillPayment({
    telegramId: tgId,
    accountType: "personal",
    productCode: "101",
    category: "electricity",
    providerName: "IKEDC",
    recipient: "45012345678",
    amountNgn: 5000,
    amountUsdc: 3.35,
    status: "pending",
  });

  assert.ok(created.id);
  assert.equal(created.status, "pending");
  assert.equal(created.product_code, "101");

  const updated = db.updateBillPayment(created.id, {
    status: "successful",
    airbills_tx_id: "ab_tx_12345",
    solana_tx_sig: "5sigExampleSolana",
    meter_token: "1234-5678-9012-3456-7890",
  });

  assert.equal(updated.status, "successful");
  assert.equal(updated.meter_token, "1234-5678-9012-3456-7890");
  assert.equal(updated.airbills_tx_id, "ab_tx_12345");

  const history = db.getUserBillPayments(tgId, 5);
  assert.equal(history.length, 1);
  assert.equal(history[0].meter_token, "1234-5678-9012-3456-7890");
});

test("Airbills Wiring: bot.js and flows_bills.js expose all 6 bill categories", () => {
  const botCode = fs.readFileSync(path.join(__dirname, "../bot.js"), "utf8");
  const flowCode = fs.readFileSync(path.join(__dirname, "../src/flows_bills.js"), "utf8");

  assert.ok(botCode.includes('require("./src/flows_bills")'), "bot.js must import flows_bills");
  assert.ok(botCode.includes('"action_bills_menu"'), "Send menu must include Pay Bills button");
  assert.ok(botCode.includes("billsFlow.handleBillsTextState"), "bot.js must delegate bill_* states");

  for (const action of [
    "bill_start_airtime",
    "bill_start_data",
    "bill_start_electricity",
    "bill_start_cable",
    "bill_start_betting",
    "bill_start_transport",
    "bill_history",
  ]) {
    assert.ok(flowCode.includes(`"${action}"`), `flows_bills.js must handle ${action}`);
  }
});
