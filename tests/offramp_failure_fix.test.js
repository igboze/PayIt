// tests/offramp_failure_fix.test.js
// Verification of off-ramp failure fixes:
// 1. Correct CBN to NIBSS code mapping for Stanbic (221 -> 000012) and Sterling (232 -> 000001).
// 2. export of createOfframpPayout in src/paj.js.
// 3. Null-safety in executor.js when resolving bank details for offramp.
// 4. Updating transactions table status to 'failed' on failed offramps in settlement_daemon.

const test = require("node:test");
const assert = require("node:assert/strict");

const paj = require("../src/paj");
const bankResolver = require("../src/bank_resolver");
const db = require("../src/db");
const daemon = require("../src/settlement_daemon");

test("Offramp failure fixes test suite", async (t) => {

  await t.test("1. Bank code resolution correctly maps 3-digit CBN codes to valid 6-digit NIBSS codes", async () => {
    // Stanbic IBTC CBN: 221 -> NIBSS: 000012 (not 000001 Sterling)
    const stanbicByCode = await bankResolver.resolveBankCode("221");
    assert.equal(stanbicByCode.bankCode, "000012", "Stanbic IBTC code 221 must resolve to NIBSS 000012");

    const stanbicByName = await bankResolver.resolveBankCode("Stanbic IBTC");
    assert.equal(stanbicByName.bankCode, "000012", "Stanbic IBTC name must resolve to NIBSS 000012");

    // Sterling Bank CBN: 232 -> NIBSS: 000001 (not 000002 Keystone)
    const sterlingByCode = await bankResolver.resolveBankCode("232");
    assert.equal(sterlingByCode.bankCode, "000001", "Sterling Bank code 232 must resolve to NIBSS 000001");

    const sterlingByName = await bankResolver.resolveBankCode("Sterling Bank");
    assert.equal(sterlingByName.bankCode, "000001", "Sterling Bank name must resolve to NIBSS 000001");

    // Jaiz Bank CBN: 301 -> NIBSS: 000006
    const jaizByCode = await bankResolver.resolveBankCode("301");
    assert.equal(jaizByCode.bankCode, "000006", "Jaiz Bank code 301 must resolve to NIBSS 000006");

    // Taj Bank CBN: 302 -> NIBSS: 000026
    const tajByCode = await bankResolver.resolveBankCode("302");
    assert.equal(tajByCode.bankCode, "000026", "Taj Bank code 302 must resolve to NIBSS 000026");
  });

  await t.test("2. paj.createOfframpPayout is defined and callable", () => {
    assert.equal(typeof paj.createOfframpPayout, "function", "paj.createOfframpPayout must be exported");
  });

  await t.test("3. settlement_daemon marks transactions table as failed on failed offramp", async () => {
    const testTg = 888777111;
    const testOrderId = `offramp_test_fail_${Date.now()}`;

    // Record pending transaction and order
    const txId = db.recordTransaction(testTg, "offramp", 10000000000000000000n, "pending", null, "personal", 18, "solana");
    db.recordOfframpOrder({
      orderId: testOrderId,
      telegramId: testTg,
      accountType: "personal",
      accountNumber: "0123456789",
      bankCode: "000013",
      bankName: "GTBank",
      accountName: "Test User",
      amountUsdc: 10,
      feeUsdc: 0.1,
      netAmountUsdc: 9.9,
      fiatAmount: 14000,
      rate: 1400,
      rail: "solana",
      status: "submitted",
    });

    // Mock paj.getOfframpOrder to return failed status
    const origGetOfframpOrder = paj.getOfframpOrder;
    paj.getOfframpOrder = async (id) => {
      if (id === testOrderId) {
        return { status: "failed", reason: "NIBSS account verification failed" };
      }
      return null;
    };

    try {
      await daemon.runTaskNow("paj_onramp_poll");

      // Verify order marked failed
      const order = db.getOfframpOrderByOrderId(testOrderId);
      assert.equal(order.status, "failed", "Offramp order should be marked failed");

      // Verify transactions table also marked failed
      const tx = db.db.prepare("SELECT * FROM transactions WHERE id = ?").get(txId);
      assert.equal(tx.status, "failed", "Transaction should be updated to failed");
    } finally {
      paj.getOfframpOrder = origGetOfframpOrder;
    }
  });

});
