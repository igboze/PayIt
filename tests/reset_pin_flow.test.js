const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { Wallet } = require("ethers");

test("User-facing PIN reset flow without entering old PIN", async () => {
  const tmpDbPath = path.join(__dirname, `test_user_reset_flow_${Date.now()}.db`);
  process.env.PAYIT_DB_PATH = tmpDbPath;
  process.env.INVOICE_FORWARDING_SECRET = "test-secret-32-chars-long-123456";

  const db = require("../src/db");
  const walletLib = require("../src/wallet");

  const userId = 555444333;
  const username = "mathew_test";
  const dummyPersonal = Wallet.createRandom();
  const dummyBiz = Wallet.createRandom();
  const initialPin = "1111";
  const newPin = "7890";

  // Create user with personal and business wallet
  db.createUserWithWallet(
    userId,
    username,
    dummyPersonal.address,
    dummyPersonal.privateKey,
    initialPin,
    dummyBiz.address,
    dummyBiz.privateKey
  );

  // Initial check
  assert.equal(db.verifyPin(userId, initialPin), true);

  // Lock account due to failed attempts
  for (let i = 0; i < 5; i++) {
    db.verifyPinWithStatus(userId, "0000");
  }
  db.blockUser(userId, "Locked from failed PIN attempts");
  assert.equal(db.verifyPin(userId, initialPin), false, "User should be locked out");
  assert.equal(db.isBlocked(userId), true, "User should be marked blocked");

  // Perform Reset without entering old PIN:
  const user = db.getUser(userId);
  const personalPk = db.getSystemDecryptedPrivateKey(user, "personal");
  const bizPk = db.getSystemDecryptedPrivateKey(user, "business");

  assert.equal(personalPk.toLowerCase(), dummyPersonal.privateKey.toLowerCase());
  assert.equal(bizPk.toLowerCase(), dummyBiz.privateKey.toLowerCase());

  // Update PIN to new PIN, reset lockout, unblock
  db.updatePin(userId, newPin, personalPk, bizPk);
  db.resetPinLockout(userId);
  db.unblockUser(userId);

  // Verify new PIN works immediately and unlocks both personal & business wallets
  assert.equal(db.verifyPin(userId, newPin), true, "New PIN must verify");
  assert.equal(db.verifyPin(userId, initialPin), false, "Old PIN must no longer verify");
  assert.equal(db.isBlocked(userId), false, "User must no longer be blocked");

  const reDecryptedPersonal = db.decryptPrivateKey(newPin, db.getUser(userId));
  const reDecryptedBiz = db.decryptBusinessPrivateKey(newPin, db.getUser(userId));
  assert.equal(reDecryptedPersonal.toLowerCase(), dummyPersonal.privateKey.toLowerCase());
  assert.equal(reDecryptedBiz.toLowerCase(), dummyBiz.privateKey.toLowerCase());

  // Clean up
  try {
    fs.unlinkSync(tmpDbPath);
  } catch {}
});
