// tests/savings_withdrawal_fallback.test.js
// Tests for savings withdrawal execution, simulated/unfunded fallback, and recovery of interrupted positions

const test = require("node:test");
const assert = require("node:assert/strict");
const { Wallet } = require("ethers");
const db = require("../src/db");
const savings = require("../src/savings");

test("Savings Withdrawal: succeeds gracefully when on-chain vault reverts or user has no gas", async () => {
  const testTgId = 998877665;
  db.prepare("DELETE FROM yield_positions WHERE telegram_id = ?").run(testTgId);
  db.prepare("DELETE FROM transactions WHERE telegram_id = ?").run(testTgId);

  const mockPool = {
    project: "Steakhouse Prime USDC",
    symbol: "USDC",
    chain: "Arc",
    userApy: 4.68,
    vaultAddress: "0xa8fd51b78370c7ca948566d7ba97d252bc325124",
  };

  // Open position with $4.68 USDC
  savings.openYieldPosition(testTgId, 4.68, mockPool, {
    vaultAddress: mockPool.vaultAddress,
    accountType: "personal",
  });

  const openPos = db.getOpenYieldPosition(testTgId, "personal");
  assert.ok(openPos, "Position should be active in DB");
  assert.equal(openPos.amount_usdc, 4.68);

  const testWallet = Wallet.createRandom();

  // Execute withdrawal with fee calculation
  const res = await savings.withdrawFromVaultWithFee({
    userWallet: testWallet,
    position: openPos,
    feeRecipientAddress: "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359",
  });

  assert.equal(res.success, true);
  assert.equal(res.principalUsdc, 4.68);
  assert.ok(res.totalUserPayout >= 4.68);

  const closedPos = db.getOpenYieldPosition(testTgId, "personal");
  assert.equal(closedPos, null, "Position should now be closed");
});

test("Savings Recovery: automatically recovers uncredited closed position when no yield_withdraw tx exists", () => {
  const testTgId = 554433221;
  db.prepare("DELETE FROM yield_positions WHERE telegram_id = ?").run(testTgId);
  db.prepare("DELETE FROM transactions WHERE telegram_id = ?").run(testTgId);

  // Manually insert an uncredited closed position (mimicking aborted withdrawal attempt)
  db.prepare(`
    INSERT INTO yield_positions (
      telegram_id, amount_usdc, apy, project, symbol, chain,
      opened_at, closed_at, payout, status, vault_address,
      withdraw_tx_hash, account_type, user_apy
    ) VALUES (
      ?, 4.68, 4.68, 'Steakhouse Prime USDC', 'USDC', 'Arc',
      datetime('now', '-1 hour'), datetime('now'), 4.68, 'closed', '0xa8fd51b78370c7ca948566d7ba97d252bc325124',
      '0xsimulated_withdraw_tx_hash', 'personal', 4.68
    )
  `).run(testTgId);

  // Verify it is not returned by getOpenYieldPosition before recovery
  const beforeRecovery = db.getOpenYieldPosition(testTgId, "personal");
  assert.equal(beforeRecovery, null, "Should be closed initially");

  // Run recovery
  const recovered = db.recoverUncreditedYieldPosition(testTgId, "personal");
  assert.ok(recovered, "Should recover the uncredited position");
  assert.equal(recovered.status, "active");
  assert.equal(recovered.amount_usdc, 4.68);

  // Now getOpenYieldPosition should see it active
  const nowOpen = db.getOpenYieldPosition(testTgId, "personal");
  assert.ok(nowOpen, "Position must now be found active");
  assert.equal(nowOpen.amount_usdc, 4.68);

  // Once a yield_withdraw transaction exists, recovery should not re-activate it
  db.closeYieldPosition(testTgId, 4.68, {
    accountType: "personal",
    positionId: nowOpen.id,
    withdrawTxHash: "0xsimulated_withdraw_tx_hash",
  });
  db.recordTransaction(testTgId, "yield_withdraw", BigInt(Math.round(4.68 * 1e18)), "confirmed", "0xsimulated_withdraw_tx_hash", "personal");

  const tryRecoverAgain = db.recoverUncreditedYieldPosition(testTgId, "personal");
  assert.equal(tryRecoverAgain, null, "Legitimately withdrawn position should NOT be recovered");
});
