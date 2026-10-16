const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

test("Admin PIN Reset script resets PIN, clears lockout, and unblocks user", (t) => {
  const tmpDbPath = path.join(__dirname, `test_admin_reset_${Date.now()}.db`);
  process.env.PAYIT_DB_PATH = tmpDbPath;
  process.env.INVOICE_FORWARDING_SECRET = "test-secret-key-32-bytes-long-1234";

  // Require fresh modules with the test env
  const db = require("../src/db");
  const walletLib = require("../src/wallet");

  const testId = 987654321;
  const username = "reset_test_user";
  const { Wallet } = require("ethers");
  const dummyWallet = Wallet.createRandom();
  const oldPin = "1111";
  const newPin = "9999";

  // Create user
  db.createUserWithWallet(testId, username, dummyWallet.address, dummyWallet.privateKey, oldPin);

  // Simulate failed attempts & block
  for (let i = 0; i < 5; i++) {
    db.verifyPinWithStatus(testId, "0000");
  }
  db.blockUser(testId, "Too many PIN attempts");

  assert.equal(db.verifyPin(testId, oldPin), false, "Account should be locked/invalid");

  // Run admin reset script via child_process
  const scriptPath = path.join(__dirname, "..", "scripts", "admin-reset-pin.js");
  const output = execFileSync(process.execPath, [scriptPath, "--user", String(testId), "--pin", newPin], {
    env: { ...process.env, PAYIT_DB_PATH: tmpDbPath },
    encoding: "utf8",
  });

  assert.ok(output.includes("SUCCESS: PIN has been reset and verified!"));

  // Verify new PIN works
  assert.equal(db.verifyPin(testId, newPin), true, "New PIN must verify successfully");
  assert.equal(db.isBlocked(testId), false, "User must be unblocked");

  // Clean up
  try {
    fs.unlinkSync(tmpDbPath);
  } catch {}
});
