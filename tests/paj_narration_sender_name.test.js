// tests/paj_narration_sender_name.test.js
// Verifies Paj v2 Offramp `narration` (<= 100 chars) and `senderName` (<= 64 chars) integration:
// - Official Paj payload fields (narration + senderName, no deprecated description, no TG:<id> leak)
// - Order creation timing fix (executor creates fresh final Paj order when narration/senderName changed)
// - Personal vs Business sender name persistence & resolution cascade
// - Free-text narration protection in conversation_flow.js ("Invoice 1042", "Pay rent" not hijacked)
// - Delivered webhook receipt includes actual senderName & narration

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const tmpDbPath = path.join(os.tmpdir(), `test_paj_sender_narr_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = tmpDbPath;
process.env.NODE_ENV = "test";
process.env.PAJ_ARC_OFFRAMP_ENABLED = "true";

const db = require("../src/db");
const paj = require("../src/paj");
const offramp = require("../src/offramp");
const walletLib = require("../src/wallet");
const webhookServer = require("../src/webhook_server");
const { executeOfframp } = require("../agent/executor");
const { shouldReprocessConversationState } = require("../src/conversation_flow");

test("1. paj.createOfframpOrder sends official narration (<=100) & senderName (<=64) and drops deprecated description", async () => {
  const origClient = paj._getClient;
  const payloads = [];
  paj._getClient = () => ({
    post: async (endpoint, payload) => {
      payloads.push({ endpoint, payload });
      return { data: { id: "paj_ord_1", address: "0x1111111111111111111111111111111111111111", amount: 20, fiatAmount: 30000, status: "INIT" } };
    },
  });

  try {
    const longNarr = "Invoice #1042 — " + "A".repeat(140);
    const longSender = "Acme Global Holdings " + "B".repeat(80);

    await paj.createOfframpOrder({
      accountNumber: "0025635480",
      bankCode: "000016",
      fiatAmount: 50000,
      narration: longNarr,
      senderName: longSender,
      customerId: "cus_verified_123",
      bvn: "22222222222", // must be omitted when customerId is present
    });

    assert.equal(payloads.length, 1);
    const body = payloads[0].payload;
    assert.equal(body.description, undefined, "Deprecated description field must NOT be sent");
    assert.equal(body.narration.length, 100, "narration must be truncated to max 100 chars");
    assert.ok(body.narration.startsWith("Invoice #1042"));
    assert.equal(body.senderName.length, 64, "senderName must be truncated to max 64 chars");
    assert.ok(body.senderName.startsWith("Acme Global Holdings"));
    assert.equal(body.customerId, "cus_verified_123");
    assert.equal(body.bvn, undefined, "Must never send both customerId and bvn");

    // Default narration when omitted uses clean senderName fallback (never TG:<id>)
    await paj.createOfframpPayout({
      accountNumber: "0025635480",
      bankCode: "000016",
      amountUsdc: 15,
      senderName: "Chidi Okafor",
    });
    const payoutBody = payloads[1].payload;
    assert.equal(payoutBody.senderName, "Chidi Okafor");
    assert.equal(payoutBody.narration, "Payment from Chidi Okafor");
    assert.equal(payoutBody.description, undefined);
  } finally {
    paj._getClient = origClient;
  }
});

test("2. offramp.requestOfframp forwards narration & senderName cleanly without leaking TG IDs", async () => {
  const origClient = paj._getClient;
  let captured = null;
  paj._getClient = () => ({
    post: async (_ep, payload) => {
      captured = payload;
      return { data: { id: "paj_ord_2", address: "0x2222222222222222222222222222222222222222", amount: 10, fiatAmount: 15000, status: "INIT" } };
    },
  });

  try {
    const res = await offramp.requestOfframp(777888, walletLib.parseToMicro("10"), {
      accountNumber: "0123456789",
      bankCode: "000013",
      senderName: "Ada Lovelace",
    });
    assert.equal(res.success, true);
    assert.equal(captured.senderName, "Ada Lovelace");
    assert.equal(captured.narration, "Payment from Ada Lovelace");
    assert.ok(!captured.narration.includes("TG:"), "Bank statement narration must never leak internal TG ID");
  } finally {
    paj._getClient = origClient;
  }
});

test("3. db.setUserSenderName & db.resolveSenderName isolate Personal vs Business & follow cascade", () => {
  const tgId = 555666777;
  const w = walletLib.generateUserWallet();
  db.createUserWithWallet(tgId, "ada_handle", w.address, w.privateKey, "1234");

  // Fallback to Telegram full name when no saved sender name yet
  assert.equal(
    db.resolveSenderName(tgId, "personal", { first_name: "Ada", last_name: "Okafor", username: "ada_handle" }),
    "Ada Okafor"
  );

  // Fallback to DB username when no live tgFrom
  assert.equal(db.resolveSenderName(tgId, "personal"), "ada_handle");

  // Persist separate Personal and Business sender names
  db.setUserSenderName(tgId, "Adaeze Okafor", "personal");
  db.setUserSenderName(tgId, "Proxim Studio Ltd", "business");

  assert.equal(db.resolveSenderName(tgId, "personal", { first_name: "Other" }), "Adaeze Okafor");
  assert.equal(db.resolveSenderName(tgId, "business", { first_name: "Other" }), "Proxim Studio Ltd");
});

test("4. executeOfframp opens fresh final Paj order with user narration + senderName instead of stale pre-validation order", async () => {
  const tgId = 555666778;
  const w = walletLib.generateUserWallet();
  db.createUserWithWallet(tgId, "founder_tx", w.address, w.privateKey, "1234");
  db.setUserSenderName(tgId, "Igboze Ventures", "business");

  const origClient = paj._getClient;
  const origGetBal = walletLib.getNativeBalanceMicro;
  const origSend = walletLib.sendFromWallet;

  const pajCalls = [];
  const fundedTargets = [];

  paj._getClient = () => ({
    post: async (_ep, payload) => {
      pajCalls.push(payload);
      return {
        data: {
          id: "fresh_order_with_narration",
          address: "0x9999999999999999999999999999999999999999",
          amount: 10,
          fiatAmount: 15000,
          accountName: "JOHN DOE",
          rate: 1500,
          status: "INIT",
        },
      };
    },
  });
  walletLib.getNativeBalanceMicro = async () => walletLib.parseToMicro("100");
  walletLib.sendFromWallet = async (_wallet, to) => {
    fundedTargets.push(to);
    return `0xtx_${fundedTargets.length}`;
  };

  try {
    const signer = walletLib.walletFromPrivateKey(w.privateKey);
    const res = await executeOfframp(
      signer,
      10,
      {
        accountNumber: "0123456789",
        bankCode: "000013",
        bankName: "GTBank",
        accountName: "JOHN DOE",
        // Stale pre-validation order from before user typed narration!
        orderId: "stale_prevalidation_order",
        orderAddress: "0x1111111111111111111111111111111111111111",
        orderMatchesFinalMeta: false,
        fiatAmount: 15000,
        narration: "Invoice 1042 - Design Milestone",
        senderName: "Igboze Ventures",
      },
      tgId,
      "Invoice 1042",
      {
        accountType: "business",
        rail: "arc",
        narration: "Invoice 1042 - Design Milestone",
        senderName: "Igboze Ventures",
      }
    );

    assert.equal(res.success, true);
    assert.equal(pajCalls.length, 1, "Must open a fresh final Paj order when narration/senderName changed");
    assert.equal(pajCalls[0].narration, "Invoice 1042 - Design Milestone");
    assert.equal(pajCalls[0].senderName, "Igboze Ventures");
    assert.equal(pajCalls[0].description, undefined);
    assert.equal(
      fundedTargets[0],
      "0x9999999999999999999999999999999999999999",
      "Must fund the NEW order's address (never the stale pre-validation address!)"
    );

    const saved = db.getOfframpOrderByOrderId("fresh_order_with_narration");
    assert.ok(saved, "Final order must be recorded in paj_offramp_orders");
    assert.equal(saved.narration, "Invoice 1042 - Design Milestone");
    assert.equal(saved.sender_name, "Igboze Ventures");

    // Verify delivered webhook receipt includes BOTH Sender Name & Narration!
    const sentPhotos = [];
    const mockBot = {
      telegram: {
        sendPhoto: async (chatId, _photo, opts) => {
          sentPhotos.push({ chatId, caption: opts.caption });
          return { message_id: 1 };
        },
        sendMessage: async () => ({ message_id: 2 }),
      },
    };
    await webhookServer.processPajEvent(
      { event: "payout.successful", data: { reference: "fresh_order_with_narration", status: "successful", amount: 15000 } },
      { bot: mockBot }
    );
    assert.equal(sentPhotos.length, 1);
    assert.ok(sentPhotos[0].caption.includes("Igboze Ventures"), "Delivered caption must display Sender Name");
    assert.ok(sentPhotos[0].caption.includes("Invoice 1042 - Design Milestone"), "Delivered caption must display Narration");
  } finally {
    paj._getClient = origClient;
    walletLib.getNativeBalanceMicro = origGetBal;
    walletLib.sendFromWallet = origSend;
  }
});

test("5. conversation_flow allows natural free-text narrations & sender names without hijacking cash-out", () => {
  assert.equal(shouldReprocessConversationState("await_withdraw_narration", "Invoice 1042"), false);
  assert.equal(shouldReprocessConversationState("await_withdraw_narration", "Pay rent for October"), false);
  assert.equal(shouldReprocessConversationState("await_withdraw_narration", "Send money for groceries"), false);
  assert.equal(shouldReprocessConversationState("await_withdraw_narration", "/cancel"), true);
  assert.equal(shouldReprocessConversationState("await_withdraw_sender_name", "PayMaster Ventures Ltd"), false);
  assert.equal(shouldReprocessConversationState("await_withdraw_sender_name", "/menu"), true);
});

test.after(() => {
  try { fs.unlinkSync(tmpDbPath); } catch (_) {}
});
