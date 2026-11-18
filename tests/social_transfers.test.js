// tests/social_transfers.test.js
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const testDbPath = path.join(__dirname, `test_social_transfers_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = testDbPath;

const db = require("../src/db");
const socialTransfers = require("../src/social_transfers");

describe("Social Transfers & Viral P2P Escrow Test Suite", () => {
  before(() => {
    db.ensureSocialEscrowsSchema();
    const mockKey = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    db.createUserWithWallet(1001, "sender_alice", "0x1111111111111111111111111111111111111111", mockKey, "1234");
    db.createUserWithWallet(1002, "recipient_bob", "0x2222222222222222222222222222222222222222", mockKey, "1234");
  });

  after(() => {
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    } catch (_) {}
  });

  test("1. parseTransferInstruction: accurately extracts username and amount", () => {
    const t1 = socialTransfers.parseTransferInstruction("/send @recipient_bob 25");
    assert.deepEqual(t1, { username: "recipient_bob", amount: 25 });

    const t2 = socialTransfers.parseTransferInstruction("/send recipient_bob $10.50");
    assert.deepEqual(t2, { username: "recipient_bob", amount: 10.50 });

    const t3 = socialTransfers.parseTransferInstruction("send $15 to @chidi");
    assert.deepEqual(t3, { username: "chidi", amount: 15 });

    const t4 = socialTransfers.parseTransferInstruction("pay @dave 50");
    assert.deepEqual(t4, { username: "dave", amount: 50 });

    const t5 = socialTransfers.parseTransferInstruction("/send @recipient_bob");
    assert.deepEqual(t5, { username: "recipient_bob", amount: null });

    const invalid = socialTransfers.parseTransferInstruction("hello there");
    assert.equal(invalid, null);
  });

  test("2. prepareSocialTransfer: identifies registered user vs unregistered recipient", () => {
    const sender = db.getUser(1001);

    // Self-transfer check
    assert.throws(
      () => socialTransfers.prepareSocialTransfer({ senderUser: sender, targetUsername: "sender_alice" }),
      /cannot send money to yourself/i
    );

    // Registered user check
    const reg = socialTransfers.prepareSocialTransfer({
      senderUser: sender,
      targetUsername: "@recipient_bob",
      amountUsdc: 20,
    });
    assert.equal(reg.isRegistered, true);
    assert.equal(reg.targetUsername, "recipient_bob");
    assert.equal(reg.targetAddress, "0x2222222222222222222222222222222222222222");

    // Unregistered user check
    const unreg = socialTransfers.prepareSocialTransfer({
      senderUser: sender,
      targetUsername: "@new_user_david",
      amountUsdc: 15,
    });
    assert.equal(unreg.isRegistered, false);
    assert.equal(unreg.targetUsername, "new_user_david");
    assert.equal(unreg.targetAddress, null);
  });

  test("3. createGiftEscrow & claimSocialEscrow lifecycle", () => {
    const gift = socialTransfers.createGiftEscrow({
      senderId: 1001,
      senderAccountType: "personal",
      targetUsername: "new_friend",
      amountUsdc: 12.50,
      expiresHours: 48,
    });

    assert.ok(gift.claimToken.startsWith("clm_"));
    assert.ok(gift.claimUrl.includes(gift.claimToken));
    assert.ok(gift.shareUrl.includes("t.me/share/url"));

    const stored = db.getSocialEscrowByToken(gift.claimToken);
    assert.equal(stored.sender_id, 1001);
    assert.equal(stored.target_handle, "new_friend");
    assert.equal(stored.amount_usdc, 12.50);
    assert.equal(stored.status, "pending");

    // Claimant claims
    const claimRes = db.claimSocialEscrow(gift.claimToken, 1003);
    assert.equal(claimRes.success, true);
    assert.equal(claimRes.escrow.status, "claimed");
    assert.equal(claimRes.escrow.claimed_by_telegram_id, 1003);

    // Repeat claim rejected
    const repeat = db.claimSocialEscrow(gift.claimToken, 1004);
    assert.equal(repeat.success, false);
    assert.equal(repeat.reason, "invalid_or_claimed");
  });

  test("4. cancelSocialEscrow: sender can cancel pending gift before it is claimed", () => {
    const gift = socialTransfers.createGiftEscrow({
      senderId: 1001,
      senderAccountType: "personal",
      targetUsername: "unresponsive_friend",
      amountUsdc: 5.00,
    });

    // Unauthorized non-sender cannot cancel
    const badCancel = db.cancelSocialEscrow(gift.claimToken, 9999);
    assert.equal(badCancel.success, false);
    assert.equal(badCancel.reason, "unauthorized");

    // Sender successfully cancels
    const cancelRes = db.cancelSocialEscrow(gift.claimToken, 1001);
    assert.equal(cancelRes.success, true);
    assert.equal(cancelRes.escrow.status, "cancelled");

    // Cancelled link cannot be claimed
    const claimAttempt = db.claimSocialEscrow(gift.claimToken, 1002);
    assert.equal(claimAttempt.success, false);
  });
});
