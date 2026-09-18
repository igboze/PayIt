// tests/earn_kit_production.test.js
// Production test suite for Circle EarnKit, Morpho Vaults, PayIT Dev Fee Routing, and Auto-Earn

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { Wallet } = require("ethers");

const db = require("../src/db");
const savings = require("../src/savings");
const autoEarn = require("../src/auto_earn");
const { classifyIntent } = require("../agent/intent_router");

describe("EarnKit & PayIT Yield System", () => {
  const testTelegramId = 987654321;
  const devFeeRecipient = "0x8888888888888888888888888888888888888888";

  before(() => {
    // Ensure test user exists in DB
    const dummyKey = Wallet.createRandom();
    const existing = db.getUser(testTelegramId);
    if (!existing) {
      db.createUserWithWallet(testTelegramId, "earntester", dummyKey.address, dummyKey.privateKey, "1234");
    }
  });

  beforeEach(() => {
    // Clean up yield positions for test user
    db.prepare("DELETE FROM yield_positions WHERE telegram_id = ?").run(testTelegramId);
    db.prepare("UPDATE users SET auto_earn_enabled = 1 WHERE telegram_id = ?").run(testTelegramId);
  });

  describe("1. Vault Discovery & EarnKit Integration", () => {
    it("discovers live Morpho vaults or returns valid ERC-4626 vault specs", async () => {
      const pools = await savings.getYieldPools();
      assert.ok(Array.isArray(pools), "Pools should be an array");
      assert.ok(pools.length > 0, "Should have at least 1 vault available");

      const top = pools[0];
      assert.ok(top.name || top.project, "Vault should have a project name");
      assert.ok(typeof top.userApy === "number", "Vault should have numeric userApy");
      assert.ok(top.vaultAddress, "Vault should have a contract address");
      assert.match(top.vaultAddress, /^0x[a-fA-F0-9]{40}$/, "Vault address must be valid EVM format");
    });
  });

  describe("2. Yield Accrual Calculation", () => {
    it("accurately computes accrued yield based on APY and elapsed time", () => {
      // Mock position opened 30 days ago at 10% APY on $1000
      const openedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const mockPosition = {
        amount_usdc: 1000,
        apy: 10.0, // 10% per year
        opened_at: openedAt,
      };

      const accrued = savings.calcAccruedYield(mockPosition);
      assert.ok(accrued > 0, "Accrued yield should be strictly positive");
      // 1000 * 0.10 * (30/365) = ~8.219 USDC
      assert.ok(accrued >= 8.0 && accrued <= 8.5, `Expected ~8.2 USDC, got ${accrued}`);
    });
  });

  describe("3. Yield Withdrawal with 10% PayIT Dev Fee", () => {
    it("calculates exact 10% dev fee upon withdrawal and routes correctly", async () => {
      // Open position in DB
      const pool = {
        project: "Steakhouse Prime USDC",
        symbol: "USDC",
        chain: "Arc",
        userApy: 12.0,
        vaultAddress: "0xBEEF000000000000000000000000000000000001",
      };
      savings.openYieldPosition(testTelegramId, 100.0, pool, {
        vaultAddress: pool.vaultAddress,
        depositTxHash: "0x" + "a".repeat(64),
      });

      const openPos = db.getOpenYieldPosition(testTelegramId);
      assert.ok(openPos, "Open position must exist");
      assert.equal(openPos.amount_usdc, 100.0);
      assert.equal(openPos.vault_address, pool.vaultAddress);

      // Artificially age position by 365 days to simulate 1 full year of yield ($12.00 on $100 @ 12%)
      const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE yield_positions SET opened_at = ? WHERE id = ?").run(oneYearAgo, openPos.id);

      const agedPos = db.getOpenYieldPosition(testTelegramId);

      // Create a test wallet for simulation
      const userWallet = Wallet.createRandom();

      // Execute withdrawal with dev fee routing
      const result = await savings.withdrawFromVaultWithFee({
        userWallet,
        position: agedPos,
        feeRecipientAddress: devFeeRecipient,
      });

      assert.ok(result.success, "Withdrawal should succeed");
      assert.equal(result.principalUsdc, 100.0, "Principal should be $100");
      assert.ok(result.grossYieldUsdc >= 11.9 && result.grossYieldUsdc <= 12.1, `Gross yield should be ~$12.00, got ${result.grossYieldUsdc}`);

      // Verify 10% fee
      const expectedFee = parseFloat((result.grossYieldUsdc * 0.10).toFixed(4));
      assert.equal(result.devFeeUsdc, expectedFee, "Dev fee must be exactly 10% of gross yield");

      // Verify net user payout (90% yield + 100% principal)
      const expectedNet = parseFloat((result.principalUsdc + (result.grossYieldUsdc - expectedFee)).toFixed(4));
      assert.equal(result.netUserAmountUsdc, expectedNet, "User should receive 100% principal + 90% net yield");

      // Verify database updated position
      const closedPos = db.prepare("SELECT * FROM yield_positions WHERE id = ?").get(agedPos.id);
      assert.equal(closedPos.status, "closed", "Position should be marked closed");
      assert.ok(closedPos.dev_fee_usdc > 0, "Dev fee should be recorded in DB");
      assert.ok(closedPos.closed_at, "closed_at should be recorded");
    });
  });

  describe("4. Auto-Earn: 2-Hour Idle Fund Allocation", () => {
    it("identifies users whose funds have sat idle for 2+ hours", () => {
      // 1. Mark user as active 10 minutes ago
      const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      db.prepare("UPDATE users SET last_activity_at = ? WHERE telegram_id = ?").run(recent, testTelegramId);

      let idleUsers = db.getIdleUsersForAutoEarn(2);
      let found = idleUsers.some(u => u.telegram_id === testTelegramId);
      assert.equal(found, false, "Active user (< 2 hours) should NOT be identified as idle");

      // 2. Mark user as active 3 hours ago
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE users SET last_activity_at = ? WHERE telegram_id = ?").run(threeHoursAgo, testTelegramId);

      idleUsers = db.getIdleUsersForAutoEarn(2);
      found = idleUsers.some(u => u.telegram_id === testTelegramId);
      assert.equal(found, true, "User idle for 3 hours should be identified for Auto-Earn");
    });

    it("respects auto_earn_enabled toggle", () => {
      // Set idle for 3 hours
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE users SET last_activity_at = ? WHERE telegram_id = ?").run(threeHoursAgo, testTelegramId);

      // Disable auto earn
      db.updateAutoEarnSetting(testTelegramId, false);
      let idleUsers = db.getIdleUsersForAutoEarn(2);
      let found = idleUsers.some(u => u.telegram_id === testTelegramId);
      assert.equal(found, false, "Disabled auto-earn user should NOT be selected");

      // Re-enable auto earn
      db.updateAutoEarnSetting(testTelegramId, true);
      idleUsers = db.getIdleUsersForAutoEarn(2);
      found = idleUsers.some(u => u.telegram_id === testTelegramId);
      assert.equal(found, true, "Re-enabled auto-earn user should be selected");
    });
  });

  describe("5. Auto-Liquidation on Payment Hook", () => {
    it("seamlessly liquidates savings when liquid balance is insufficient", async () => {
      // Simulate open auto-earn position
      const pool = {
        project: "Auto-Earn Morpho Pool",
        symbol: "USDC",
        chain: "Arc",
        userApy: 10.0,
        vaultAddress: "0x1111111111111111111111111111111111111111",
      };
      savings.openYieldPosition(testTelegramId, 50.0, pool, {
        vaultAddress: pool.vaultAddress,
        isAutoEarn: true,
      });

      const userWallet = Wallet.createRandom();

      // Liquid balance is 0, user wants to pay $30 (30,000,000 micro)
      const liqRes = await autoEarn.ensureLiquidBalance({
        userWallet,
        telegramId: testTelegramId,
        requiredAmountMicro: 30000000n,
        feeRecipientAddress: devFeeRecipient,
      });

      assert.equal(liqRes.liquidated, true, "Auto liquidation should trigger");
      assert.equal(liqRes.positionClosed, true, "Yield position should be closed");

      // Position in DB should now be closed
      const currentPos = db.getOpenYieldPosition(testTelegramId);
      assert.equal(currentPos, null, "Yield position should no longer be active");
    });
  });

  describe("6. Natural Language Intent Router for Savings", () => {
    it("classifies 'savings' / 'yield' / 'earn' into savings_view", async () => {
      const res1 = await classifyIntent("yield", testTelegramId);
      assert.equal(res1.intent, "savings_view");

      const res2 = await classifyIntent("save and earn", testTelegramId);
      assert.equal(res2.intent, "savings_view");
    });

    it("classifies 'save $50' into savings_deposit", async () => {
      const res = await classifyIntent("save $50", testTelegramId);
      assert.equal(res.intent, "savings_deposit");
      assert.equal(res.params.recipients[0].amount, 50);
    });

    it("classifies 'withdraw yield' into savings_withdraw", async () => {
      const res = await classifyIntent("withdraw yield", testTelegramId);
      assert.equal(res.intent, "savings_withdraw");
    });
  });
});
