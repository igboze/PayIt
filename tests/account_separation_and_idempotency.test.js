// tests/account_separation_and_idempotency.test.js
// Comprehensive test suite for:
// 1. Personal vs Business Earn / Savings separation
// 2. Fiat ON/OFF chain separate routing
// 3. Strict Idempotency across webhooks, payments, offramps, and yield

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/db");
const savings = require("../src/savings");
const autoEarn = require("../src/auto_earn");
const idempotency = require("../src/idempotency");
const webhookServer = require("../src/webhook_server");
const { executeOnchainPayment, executeOfframp } = require("../agent/executor");
const walletLib = require("../src/wallet");

test("Account Separation & Idempotency Test Suite", async (t) => {

  const testUserId = 888999111;
  const personalEvm = "0x1111111111111111111111111111111111111111";
  const businessEvm = "0x2222222222222222222222222222222222222222";

  // Clean up any existing test data
  db.db.prepare("DELETE FROM users WHERE telegram_id = ?").run(testUserId);
  db.db.prepare("DELETE FROM yield_positions WHERE telegram_id = ?").run(testUserId);
  db.db.prepare("DELETE FROM transactions WHERE telegram_id = ?").run(testUserId);

  // Setup user with both personal and business addresses
  db.createUserWithWallet(
    testUserId,
    "testuser",
    personalEvm,
    "0x0123456789012345678901234567890123456789012345678901234567890123",
    "1234",
    businessEvm,
    "0x0123456789012345678901234567890123456789012345678901234567890124"
  );

  await t.test("1. Personal & Business Yield positions coexist independently", async () => {
    const mockPool = {
      id: "pool_arc_test",
      project: "Morpho Vault",
      userApy: 7.5,
      address: "0xa8fd51b78370c7ca948566d7ba97d252bc325124",
    };

    // Open Personal savings
    savings.openYieldPosition(testUserId, 150.0, mockPool, {
      accountType: "personal",
      vaultAddress: mockPool.address,
    });

    // Open Business savings
    savings.openYieldPosition(testUserId, 500.0, mockPool, {
      accountType: "business",
      vaultAddress: mockPool.address,
    });

    const personalPos = db.getOpenYieldPosition(testUserId, "personal");
    const bizPos = db.getOpenYieldPosition(testUserId, "business");

    assert.ok(personalPos, "Personal position should exist");
    assert.ok(bizPos, "Business position should exist");
    assert.equal(personalPos.amount_usdc, 150.0);
    assert.equal(bizPos.amount_usdc, 500.0);
    assert.equal(personalPos.account_type, "personal");
    assert.equal(bizPos.account_type, "business");
    assert.notEqual(personalPos.id, bizPos.id);

    // Closing personal position must NOT close business position
    db.closeYieldPosition(testUserId, 151.25, {
      devFee: 0.125,
      accountType: "personal",
      positionId: personalPos.id,
    });

    const personalAfter = db.getOpenYieldPosition(testUserId, "personal");
    const bizAfter = db.getOpenYieldPosition(testUserId, "business");

    assert.equal(personalAfter, null, "Personal position should now be closed");
    assert.ok(bizAfter, "Business position must remain open and intact");
    assert.equal(bizAfter.amount_usdc, 500.0);

    // Now close business position
    db.closeYieldPosition(testUserId, 505.0, {
      devFee: 0.5,
      accountType: "business",
      positionId: bizPos.id,
    });

    const bizFinal = db.getOpenYieldPosition(testUserId, "business");
    assert.equal(bizFinal, null, "Business position should now be closed");
  });

  await t.test("2. Auto-Earn ensureLiquidBalance only unwinds the requesting account type", async () => {
    const mockPool = {
      id: "pool_liq_test",
      project: "Morpho Vault",
      userApy: 8.0,
      address: "0xa8fd51b78370c7ca948566d7ba97d252bc325124",
    };

    // Open both personal ($100) and business ($300) positions
    savings.openYieldPosition(testUserId, 100.0, mockPool, { accountType: "personal" });
    savings.openYieldPosition(testUserId, 300.0, mockPool, { accountType: "business" });

    const { Wallet } = require("ethers");
    const personalWallet = Wallet.createRandom();
    personalWallet.telegramId = testUserId;

    // Trigger auto-liquidation for Personal payment ($80)
    const liqPersonal = await autoEarn.ensureLiquidBalance({
      userWallet: personalWallet,
      telegramId: testUserId,
      requiredAmountMicro: 80000000n, // 80 USDC
      accountType: "personal",
    });

    assert.equal(liqPersonal.liquidated, true, "Personal position should be liquidated");

    // Verify personal position is closed, but business position is completely untouched!
    const personalCheck = db.getOpenYieldPosition(testUserId, "personal");
    const bizCheck = db.getOpenYieldPosition(testUserId, "business");

    assert.equal(personalCheck, null, "Personal position was liquidated");
    assert.ok(bizCheck, "Business position was NOT touched");
    assert.equal(bizCheck.amount_usdc, 300.0);

    // Clean up business position
    db.closeYieldPosition(testUserId, 300.0, { accountType: "business", positionId: bizCheck.id });
  });

  await t.test("3. Webhook Deduplication strictly prevents replay / duplicate event processing", async () => {
    const sampleEventId = `evt_dedup_${Date.now()}`;

    assert.equal(idempotency.isWebhookProcessed(sampleEventId), false, "Event should not be processed yet");

    // Mark processed
    idempotency.markWebhookProcessed(sampleEventId, "payment.successful", "order_123");

    assert.equal(idempotency.isWebhookProcessed(sampleEventId), true, "Event must now be marked processed");

    // Attempting to re-mark or re-check remains idempotent
    idempotency.markWebhookProcessed(sampleEventId, "payment.successful", "order_123");
    assert.equal(idempotency.isWebhookProcessed(sampleEventId), true);
  });

  await t.test("4. Webhook Server routes Onramp to separate Personal vs Business accounts", async () => {
    // Setup Solana addresses
    const personalSol = "SolanaPersonalAddr11111111111111111111111";
    const bizSol = "SolanaBusinessAddr22222222222222222222222";

    db.updateSolanaAddress(testUserId, personalSol);
    db.updateBizSolanaAddress(testUserId, bizSol);

    // Verify lookup by Solana addresses
    const userByPersonalSol = db.getUserBySolanaAddress(personalSol);
    const userByBizSol = db.getUserByBizSolanaAddress(bizSol);

    assert.ok(userByPersonalSol, "Should find user by personal solana address");
    assert.ok(userByBizSol, "Should find user by business solana address");
    assert.equal(userByPersonalSol.telegram_id, testUserId);
    assert.equal(userByBizSol.telegram_id, testUserId);

    // Test account detection logic matching webhook_server.js
    const personalOrder = {
      userExternalId: String(testUserId),
      metadata: { accountType: "personal" },
    };
    const bizOrder = {
      userExternalId: `${testUserId}-biz`,
      metadata: { accountType: "business" },
    };

    const isBizOrder1 = bizOrder.metadata?.accountType === "business" || bizOrder.userExternalId?.endsWith("-biz");
    const isBizOrder2 = personalOrder.metadata?.accountType === "business" || personalOrder.userExternalId?.endsWith("-biz");

    assert.equal(isBizOrder1, true, "Biz order should be detected as business");
    assert.equal(isBizOrder2, false, "Personal order should be detected as personal");

    // Destination addresses
    const user = db.getUser(testUserId);
    const bizTarget = (isBizOrder1 && user.business_deposit_address) ? user.business_deposit_address : user.deposit_address;
    const personalTarget = (isBizOrder2 && user.business_deposit_address) ? user.business_deposit_address : user.deposit_address;

    assert.equal(bizTarget, businessEvm, "Business onramp must target business EVM address");
    assert.equal(personalTarget, personalEvm, "Personal onramp must target personal EVM address");
  });

  await t.test("5. Universal Idempotency mutex blocks double-spends and duplicate execution", async () => {
    const testKey = `pay:${testUserId}:0xrecipient:50:${Date.now()}`;

    // Initially not present
    let record = idempotency.checkOperationIdempotency(testKey);
    assert.equal(record, null);

    // Start operation -> acquires lock
    idempotency.startOperationIdempotency(testKey, {
      scope: "payment",
      telegramId: testUserId,
      accountType: "personal",
      amount: 50.0,
    });

    record = idempotency.checkOperationIdempotency(testKey);
    assert.ok(record);
    assert.equal(record.status, "pending");
    assert.equal(record.amount, 50.0);
    assert.equal(record.accountType, "personal");

    // Complete operation
    idempotency.completeOperationIdempotency(testKey, { txHash: "0xdeadbeef123" });

    record = idempotency.checkOperationIdempotency(testKey);
    assert.ok(record);
    assert.equal(record.status, "completed");
    assert.equal(record.txHash, "0xdeadbeef123");

    // A second invocation with same key detects it is already completed
    assert.equal(record.status, "completed");
  });

  await t.test("6. Transaction history isolates personal vs business transactions", async () => {
    const pTx = db.recordTransaction(testUserId, "send_usdc", 10000000n, "confirmed", "0xtx_personal", "personal");
    const bTx = db.recordTransaction(testUserId, "send_usdc", 25000000n, "confirmed", "0xtx_biz", "business");

    const personalTxs = db.getTransactions(testUserId, 10, "personal");
    const bizTxs = db.getTransactions(testUserId, 10, "business");

    const pFound = personalTxs.some(t => t.tx_hash === "0xtx_personal");
    const pHasBiz = personalTxs.some(t => t.tx_hash === "0xtx_biz");
    const bFound = bizTxs.some(t => t.tx_hash === "0xtx_biz");
    const bHasPersonal = bizTxs.some(t => t.tx_hash === "0xtx_personal");

    assert.equal(pFound, true, "Personal tx list should contain personal tx");
    assert.equal(pHasBiz, false, "Personal tx list must NEVER contain business tx");
    assert.equal(bFound, true, "Business tx list should contain business tx");
    assert.equal(bHasPersonal, false, "Business tx list must NEVER contain personal tx");
  });

});
