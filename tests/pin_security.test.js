// tests/pin_security.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Setup isolated test database
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "payit-pin-security-"));
process.env.PAYIT_DB_PATH = path.join(tempDir, "payit.db");

const db = require("../src/db");
const walletLib = require("../src/wallet");

test("PIN Security: tracks failed attempts and enforces lockout", () => {
  const telegramId = 999111;
  const testPin = "1234";
  const wrongPin = "9999";

  // Create a user with a known encrypted PIN
  const wallet = walletLib.generateUserWallet();
  db.createUserWithWallet(telegramId, "testuser", wallet.address, wallet.privateKey, testPin);

  // Initial state: not locked
  let lock = db.isPinLocked(telegramId);
  assert.equal(lock.locked, false);

  // Verify wrong PIN 4 times — not locked yet
  for (let i = 1; i <= 4; i++) {
    const status = db.verifyPinWithStatus(telegramId, wrongPin);
    assert.equal(status.valid, false);
    assert.equal(status.locked, false);
    assert.equal(status.remainingAttempts, 5 - i);
  }

  // 5th failed attempt triggers lockout
  const status5 = db.verifyPinWithStatus(telegramId, wrongPin);
  assert.equal(status5.valid, false);
  assert.equal(status5.locked, true);
  assert.equal(status5.remainingAttempts, 0);
  assert.ok(status5.remainingSec > 800); // 15 mins = 900s

  // While locked, even correct PIN is rejected
  const lockedAttempt = db.verifyPinWithStatus(telegramId, testPin);
  assert.equal(lockedAttempt.valid, false);
  assert.equal(lockedAttempt.locked, true);
  assert.equal(db.verifyPin(telegramId, testPin), false);

  // Reset lockout manually (admin or test helper)
  db.resetPinLockout(telegramId);
  assert.equal(db.isPinLocked(telegramId).locked, false);

  // Correct PIN now succeeds and resets attempts
  const successStatus = db.verifyPinWithStatus(telegramId, testPin);
  assert.equal(successStatus.valid, true);
  assert.equal(successStatus.locked, false);
  assert.equal(successStatus.remainingAttempts, 5);
});
