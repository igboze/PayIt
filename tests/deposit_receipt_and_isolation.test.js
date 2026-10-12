const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const db = require("../src/db");
const { generateReceiptPNG } = require("../src/receipt_generator");

test("Deposit Receipt & User History Isolation Test Suite", async (t) => {
  await t.test("1. generateReceiptPNG generates PNG file for deposit type", async () => {
    const receiptPath = await generateReceiptPNG({
      receiptId: "DEP-TEST-12345",
      senderName: "Base Deposit",
      senderAddress: "0x1111111111111111111111111111111111111111",
      recipientName: "Test User Account",
      recipientAddress: "0x2222222222222222222222222222222222222222",
      amountUsdc: 75.5,
      token: "USDC",
      type: "Deposit",
      timestamp: new Date().toISOString(),
      status: "Confirmed",
      txHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    });

    assert.ok(fs.existsSync(receiptPath), "Receipt PNG file should exist");
    assert.ok(fs.statSync(receiptPath).size > 0, "Receipt PNG file should not be empty");
    try { fs.unlinkSync(receiptPath); } catch {}
  });

  await t.test("2. getTransactions and getOpenYieldPosition strictly isolate by user", async () => {
    const userA = 7770001;
    const userB = 7770002;

    try { db.createUser({ telegramId: userA, depositAddress: "0xuserA" }); } catch {}
    try { db.createUser({ telegramId: userB, depositAddress: "0xuserB" }); } catch {}

    // Record transactions for User A and User B
    db.recordTransaction(userA, "send_usdc", 10000000000000000000n, "confirmed", "0xtxA1", "personal");
    db.recordTransaction(userB, "send_usdc", 20000000000000000000n, "confirmed", "0xtxB1", "personal");

    const txsA = db.getTransactions(userA);
    const txsB = db.getTransactions(userB);

    assert.ok(txsA.every((t) => String(t.telegram_id) === String(userA)), "User A transactions must belong to User A only");
    assert.ok(txsB.every((t) => String(t.telegram_id) === String(userB)), "User B transactions must belong to User B only");

    // Test invalid / missing telegram_id returns empty/null
    assert.deepEqual(db.getTransactions(null), [], "null telegram_id returns []");
    assert.deepEqual(db.getTransactions(undefined), [], "undefined telegram_id returns []");
    assert.equal(db.getOpenYieldPosition(null), null, "null telegram_id returns null yield position");
    assert.equal(db.getOpenYieldPosition(undefined), null, "undefined telegram_id returns null yield position");
  });

  await t.test("3. Orphan yield positions and test transactions are purged from database", async () => {
    const orphanYields = db.prepare("SELECT * FROM yield_positions WHERE telegram_id IN (1870013901, 1122334455)").all();
    assert.equal(orphanYields.length, 0, "All orphan test yield positions must be purged");

    const orphanTxs = db.prepare("SELECT * FROM transactions WHERE telegram_id IN (1870013901, 1122334455)").all();
    assert.equal(orphanTxs.length, 0, "All orphan test transactions must be purged");
  });
});
