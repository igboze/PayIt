"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const testDbPath = path.join(__dirname, `test_p2p_flow_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = testDbPath;

const db = require("../src/db");
const walletLib = require("../src/wallet");
const convState = require("../src/conversation_state");
const socialTransfers = require("../src/social_transfers");

test.before(() => {
  db.ensureSocialEscrowsSchema();
  convState.initStateTable();
});

test.after(() => {
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch (_) {}
});

test("P2P Telegram Flow: Menu verification in bot.js", () => {
  const botCode = fs.readFileSync(path.join(__dirname, "../bot.js"), "utf8");

  // Verify menu button
  assert.ok(
    botCode.includes('btnSuccess("✈️ Send to Telegram User (@username)", "action_send_telegram_user")'),
    "Must include Telegram P2P button in send menu"
  );

  // Verify action handler
  assert.ok(
    botCode.includes('bot.action("action_send_telegram_user"'),
    "Must have action_send_telegram_user registered"
  );

  // Verify quick amounts & cancellation actions
  assert.ok(
    botCode.includes('bot.action(/^p2p_amt_(\\d+(?:\\.\\d+)?|max)$/'),
    "Must have quick amount callback handler"
  );
  assert.ok(
    botCode.includes('bot.action(/^action_cancel_escrow_([a-zA-Z0-9_]+)$/'),
    "Must have escrow cancel callback handler"
  );

  // Verify /send slash command with @username
  assert.ok(
    botCode.includes('const parsed = socialTransfers.parseTransferInstruction(text)'),
    "Must parse social transfer in slash command /send"
  );

  // Verify /start claim handling
  assert.ok(
    botCode.includes('releaseEscrowToRecipient'),
    "Must handle claim release in bot.start"
  );
});

test("P2P Telegram Flow: Full Registered User Send & Notification Lifecycle", async () => {
  const senderId = 777001;
  const recipientId = 777002;
  const senderPin = "1234";
  const recipientPin = "4321";

  const senderWallet = walletLib.generateUserWallet();
  const recipientWallet = walletLib.generateUserWallet();

  db.createUserWithWallet(senderId, "alice_sender", senderWallet.address, senderWallet.privateKey, senderPin);
  db.createUserWithWallet(recipientId, "bob_recipient", recipientWallet.address, recipientWallet.privateKey, recipientPin);

  const senderUser = db.getUser(senderId);
  const recipientUser = db.getUser(recipientId);

  assert.ok(senderUser, "Sender should exist in DB");
  assert.ok(recipientUser, "Recipient should exist in DB");

  // 1. Prepare social transfer for registered user
  const prep = socialTransfers.prepareSocialTransfer({
    senderUser,
    targetUsername: "bob_recipient",
    amountUsdc: 25.5,
  });

  assert.equal(prep.isRegistered, true);
  assert.equal(prep.targetAddress, recipientWallet.address);
  assert.equal(prep.amountUsdc, 25.5);

  // 2. Simulate conversation state flow
  convState.setState(senderId, "await_p2p_amount", {
    targetUsername: "bob_recipient",
    isRegistered: true,
    targetAddress: recipientWallet.address,
  }, "personal");

  const state1 = convState.getState(senderId);
  assert.equal(state1.type, "await_p2p_amount");

  convState.setState(senderId, "confirm_p2p_send", {
    targetUsername: "bob_recipient",
    isRegistered: true,
    targetAddress: recipientWallet.address,
    amountUsdc: 25.5,
  }, "personal");

  const state2 = convState.getState(senderId);
  assert.equal(state2.type, "confirm_p2p_send");
  assert.equal(state2.data.amountUsdc, 25.5);

  // Verify PIN validation
  assert.equal(db.verifyPin(senderId, "1234"), true);
  assert.equal(db.verifyPin(senderId, "0000"), false);
});

test("P2P Telegram Flow: Unregistered User Viral Escrow Lifecycle & Claim on /start", async () => {
  const senderId = 888001;
  const senderPin = "5555";
  const senderWallet = walletLib.generateUserWallet();

  db.createUserWithWallet(senderId, "charlie_sender", senderWallet.address, senderWallet.privateKey, senderPin);
  const senderUser = db.getUser(senderId);

  // Target does not exist yet
  const prep = socialTransfers.prepareSocialTransfer({
    senderUser,
    targetUsername: "unregistered_dave",
    amountUsdc: 15.0,
  });

  assert.equal(prep.isRegistered, false);
  assert.equal(prep.targetAddress, null);

  // Create gift escrow
  const gift = socialTransfers.createGiftEscrow({
    senderId,
    senderAccountType: "personal",
    targetUsername: "unregistered_dave",
    amountUsdc: 15.0,
    expiresHours: 48,
  });

  assert.ok(gift.claimToken);
  assert.ok(gift.claimUrl.includes(`claim_${gift.claimToken}`));
  assert.ok(gift.shareUrl.includes("t.me/share/url"));

  // Check DB record
  const escrowRow = db.getSocialEscrowByToken(gift.claimToken);
  assert.equal(escrowRow.status, "pending");
  assert.equal(Number(escrowRow.amount_usdc), 15.0);
  assert.equal(escrowRow.target_handle, "unregistered_dave");

  // Recipient Dave now registers and sets PIN
  const daveId = 888002;
  const daveWallet = walletLib.generateUserWallet();
  const davePin = "9876";

  // Simulate onboarding PIN step with pending claim token
  db.createUserWithWallet(daveId, "unregistered_dave", daveWallet.address, daveWallet.privateKey, davePin);
  const daveUser = db.getUser(daveId);
  assert.ok(daveUser);

  // Release escrow to Dave's new address
  const claimRes = await socialTransfers.releaseEscrowToRecipient({
    claimToken: gift.claimToken,
    claimantTelegramId: daveId,
    recipientAddress: daveWallet.address,
  });

  assert.equal(claimRes.success, true);
  assert.equal(claimRes.escrow.status, "claimed");
  assert.equal(Number(claimRes.escrow.claimed_by_telegram_id), daveId);

  // Verify cannot double-claim
  await assert.rejects(
    async () => {
      await socialTransfers.releaseEscrowToRecipient({
        claimToken: gift.claimToken,
        claimantTelegramId: daveId,
        recipientAddress: daveWallet.address,
      });
    },
    /already been claimed/
  );
});

test("P2P Telegram Flow: Escrow Cancellation and Refund to Sender", async () => {
  const senderId = 999001;
  const senderPin = "1111";
  const senderWallet = walletLib.generateUserWallet();

  db.createUserWithWallet(senderId, "emma_sender", senderWallet.address, senderWallet.privateKey, senderPin);

  const gift = socialTransfers.createGiftEscrow({
    senderId,
    senderAccountType: "personal",
    targetUsername: "ghost_user",
    amountUsdc: 50.0,
  });

  const escrowBefore = db.getSocialEscrowByToken(gift.claimToken);
  assert.equal(escrowBefore.status, "pending");

  // Refund
  const refundRes = await socialTransfers.refundEscrowToSender({
    claimToken: gift.claimToken,
    senderId,
    senderAddress: senderWallet.address,
  });

  assert.equal(refundRes.success, true);
  assert.equal(refundRes.escrow.status, "cancelled");

  // Cannot claim after cancellation
  await assert.rejects(
    async () => {
      await socialTransfers.releaseEscrowToRecipient({
        claimToken: gift.claimToken,
        claimantTelegramId: 999999,
        recipientAddress: "0x1234567890123456789012345678901234567890",
      });
    },
    /already been claimed/
  );
});

test("P2P Telegram Flow: Debug regressions (parsing, token extraction, t.me links, username sync, UX)", () => {
  // 1. Extended natural language & slash commands
  assert.deepEqual(socialTransfers.parseTransferInstruction("/send @chidi 25"), { username: "chidi", amount: 25 });
  assert.deepEqual(socialTransfers.parseTransferInstruction("/pay @chidi $10"), { username: "chidi", amount: 10 });
  assert.deepEqual(socialTransfers.parseTransferInstruction("/send $25 to @chidi"), { username: "chidi", amount: 25 });
  assert.deepEqual(socialTransfers.parseTransferInstruction("send 10 usdc to @alice"), { username: "alice", amount: 10 });
  assert.deepEqual(socialTransfers.parseTransferInstruction("tip @bob $5"), { username: "bob", amount: 5 });
  assert.deepEqual(socialTransfers.parseTransferInstruction("send to @alice"), { username: "alice", amount: null });
  assert.deepEqual(socialTransfers.parseTransferInstruction("gift @dave 15 dollars"), { username: "dave", amount: 15 });

  // 2. extractClaimToken preserves clm_ prefix in both formats
  assert.equal(socialTransfers.extractClaimToken("claim_clm_abcdef123456"), "clm_abcdef123456");
  assert.equal(socialTransfers.extractClaimToken("clm_abcdef123456"), "clm_abcdef123456");
  assert.equal(socialTransfers.extractClaimToken("ref_12345"), null);

  // 3. normalizeTelegramHandle supports t.me URLs & @handles
  assert.equal(socialTransfers.normalizeTelegramHandle("@Chidi"), "chidi");
  assert.equal(socialTransfers.normalizeTelegramHandle("https://t.me/Chidi_Dev/"), "chidi_dev");
  assert.equal(socialTransfers.normalizeTelegramHandle("t.me/alice?start=1"), "alice");
  assert.equal(socialTransfers.normalizeTelegramHandle("a"), null);

  // 4. buildGiftShareLinks does not duplicate claimUrl in shareText
  const links = socialTransfers.buildGiftShareLinks({
    targetUsername: "chidi",
    amountUsdc: 12.5,
    claimToken: "clm_test123",
  });
  assert.ok(links.claimUrl.includes("start=claim_clm_test123"));
  assert.ok(!links.shareText.includes(links.claimUrl), "shareText must not duplicate claimUrl");

  // 5. db.syncUsername updates handle so findUserByUsername finds renamed user
  const syncUserId = 999555;
  const syncWallet = walletLib.generateUserWallet();
  db.createUserWithWallet(syncUserId, "old_handle", syncWallet.address, syncWallet.privateKey, "1234");
  assert.ok(db.findUserByUsername("old_handle"));
  db.syncUsername(syncUserId, "new_handle");
  assert.equal(db.findUserByUsername("old_handle"), null);
  assert.ok(db.findUserByUsername("new_handle"));

  // 6. bot.js uses parsed.username (not broken parsed.targetUsername) and includes UX handlers
  const botCode = fs.readFileSync(path.join(__dirname, "../bot.js"), "utf8");
  assert.ok(!botCode.includes("parsed.targetUsername"), "Must not use broken parsed.targetUsername property");
  assert.ok(!botCode.includes("socialInstruction.targetUsername"), "Must not use broken socialInstruction.targetUsername property");
  assert.ok(botCode.includes('bot.action("action_pending_social_gifts"'), "Must include Pending Gifts management");
  assert.ok(botCode.includes('bot.command("pay"'), "Must register /pay command");
  assert.ok(botCode.includes("replyInsufficientP2PBalance"), "Must include vault-aware insufficient balance helper");
  assert.ok(botCode.includes("socialTransfers.extractClaimToken"), "Must use extractClaimToken in bot.start");
});
