const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/db");
const walletLib = require("../src/wallet");
const cctpBridge = require("../src/cctp_bridge");

test("Onramp PIN Auth Suite: user without system_encrypted_key returns auth_required", async () => {
  const testTgId = 88812345;
  const pin = "1234";

  // Create a user without system_encrypted_key (simulating legacy user)
  const wallet = walletLib.generateUserWallet();
  const enc = walletLib.encryptPrivateKey(wallet.privateKey, pin);

  // Clean up if exists
  db.db.prepare("DELETE FROM users WHERE telegram_id = ?").run(testTgId);

  db.db.prepare(`
    INSERT INTO users (
      telegram_id, username, deposit_address, encrypted_key,
      key_salt, key_iv, key_tag, system_encrypted_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    testTgId,
    "legacy_tester",
    wallet.address,
    enc.encryptedKey,
    enc.salt,
    enc.iv,
    enc.tag
  );

  const u = db.getUser(testTgId);
  assert.equal(u.system_encrypted_key, null, "system_encrypted_key must initially be NULL");

  // Call autoBridgeSolanaToArc without private key -> should return auth_required
  const bridgeRes = await cctpBridge.autoBridgeSolanaToArc({
    telegramId: testTgId,
    amountUsdc: 12.08,
    recipientArcAddress: wallet.address,
  });

  assert.equal(bridgeRes.success, false);
  assert.equal(bridgeRes.status, "auth_required");
  assert.equal(bridgeRes.needsPin, true);

  // Now verify PIN via verifyPinWithStatus -> should backfill system_encrypted_key
  const pinRes = db.verifyPinWithStatus(testTgId, pin);
  assert.equal(pinRes.valid, true);

  const uAfterPin = db.getUser(testTgId);
  assert.ok(uAfterPin.system_encrypted_key, "system_encrypted_key must be backfilled after PIN verification");

  // Decrypt using system key to verify correctness
  const decryptedPk = db.getSystemDecryptedPrivateKey(uAfterPin);
  assert.equal(decryptedPk.toLowerCase(), wallet.privateKey.toLowerCase());

  // Clean up
  db.db.prepare("DELETE FROM users WHERE telegram_id = ?").run(testTgId);
});
