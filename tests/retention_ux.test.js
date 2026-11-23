// tests/retention_ux.test.js
// Tests Two-Tier comparison cards, first-transaction welcome bonus (+20 pts) + JIT Tier-1 nudge,
// 1-tap monthly bill reminders, and weekly Auto-Earn yield nudges.

const test = require("node:test");
const assert = require("node:assert/strict");

const retention = require("../src/retention");
const db = require("../src/db");
const walletLib = require("../src/wallet");

test("buildTierComparisonHtml clearly shows Tier 0 (No KYC) vs Tier 1 (KYC/KYB)", () => {
  const personalHtml = retention.buildTierComparisonHtml(false, "");
  assert.ok(personalHtml.includes("Tier 0 — Ready Now (No KYC Needed)"));
  assert.ok(personalHtml.includes("$300/hr · $500/day"));
  assert.ok(personalHtml.includes("Tier 1 — Personal KYC"));
  assert.ok(personalHtml.includes("$25,000/day"));

  const bizHtml = retention.buildTierComparisonHtml(true, "approved");
  assert.ok(bizHtml.includes("Tier 1 Global Verified"));
  assert.ok(bizHtml.includes("Team USD Cards"));
  assert.ok(bizHtml.includes("$100,000/day"));
});

test("handleFirstQualifyingTransaction awards +20 pts welcome bonus once and sends JIT Tier-1 nudge", async () => {
  const tgId = 888777661;
  db._db.prepare("DELETE FROM user_retention_events WHERE telegram_id = ?").run(tgId);
  db._db.prepare("DELETE FROM points_history WHERE telegram_id = ?").run(tgId);
  db._db.prepare("DELETE FROM users WHERE telegram_id = ?").run(tgId);

  const w = walletLib.generateUserWallet();
  db.createUserWithWallet(tgId, "retention_test_user", w.address, w.privateKey, "1234");

  const sent = [];
  const mockBot = {
    telegram: {
      sendMessage: async (chatId, text, opts) => {
        sent.push({ chatId, text, opts });
        return { message_id: 1 };
      },
    },
  };

  try {
    // Non-qualifying free invoice action must not award bonus
    const invRes = await retention.handleFirstQualifyingTransaction({
      telegramId: tgId,
      action: "invoice",
      bot: mockBot,
    });
    assert.equal(invRes.awarded, false);

    // First real transaction awards +20 pts and sends JIT Tier-1 nudge
    const first = await retention.handleFirstQualifyingTransaction({
      telegramId: tgId,
      action: "cashout",
      amountUsd: 10,
      context: "personal",
      bot: mockBot,
    });
    assert.equal(first.awarded, true);
    assert.equal(first.points, 20);
    assert.equal(db.getPointsBalance(tgId), 20);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes("First Transaction Bonus Unlocked"));
    assert.ok(sent[0].text.includes("Unlock named USD, GBP"));

    // Second call must be idempotent (no duplicate bonus)
    const second = await retention.handleFirstQualifyingTransaction({
      telegramId: tgId,
      action: "sendout",
      amountUsd: 15,
      context: "personal",
      bot: mockBot,
    });
    assert.equal(second.awarded, false);
    assert.equal(db.getPointsBalance(tgId), 20);
  } finally {
    db._db.prepare("DELETE FROM user_retention_events WHERE telegram_id = ?").run(tgId);
    db._db.prepare("DELETE FROM points_history WHERE telegram_id = ?").run(tgId);
    db._db.prepare("DELETE FROM users WHERE telegram_id = ?").run(tgId);
  }
});

test("Bill reminders schedule and deliver when due without duplicates", async () => {
  const tgId = 888777662;
  db._db.prepare("DELETE FROM bill_reminders WHERE telegram_id = ?").run(tgId);

  const sent = [];
  const mockBot = {
    telegram: {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
        return { message_id: 1 };
      },
    },
  };

  try {
    const rec = retention.scheduleBillReminder({
      telegramId: tgId,
      category: "electricity",
      providerName: "IKEDC",
      recipient: "45012345678",
      amountNgn: 5000,
      days: 30,
    });
    assert.ok(rec.id > 0);

    // Backdate remind_at to simulate 30 days elapsed
    db._db.prepare("UPDATE bill_reminders SET remind_at = datetime('now', '-1 minute') WHERE id = ?").run(rec.id);

    const run1 = await retention.processDueBillReminders(mockBot);
    assert.equal(run1.sent, 1);
    assert.ok(sent[0].text.includes("IKEDC"));
    assert.ok(sent[0].text.includes("5,000"));

    // Second run must not re-send
    const run2 = await retention.processDueBillReminders(mockBot);
    assert.equal(run2.sent, 0);
  } finally {
    db._db.prepare("DELETE FROM bill_reminders WHERE telegram_id = ?").run(tgId);
  }
});
