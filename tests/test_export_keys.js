// tests/test_export_keys.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// Use test DB
const TEST_DB = path.join(__dirname, "test_export_keys.db");
process.env.PAYIT_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) {
  try { fs.unlinkSync(TEST_DB); } catch (_) {}
}

const db = require("../src/db");
const walletLib = require("../src/wallet");
const multichain = require("../src/multichain");

test("Export Keys & Solana Address Derivation Suite", async (t) => {
  const testTgId = 88997766;
  const pin = "4321";

  // 1. Create User
  const w = walletLib.generateUserWallet();
  const u = db.createUserWithWallet(
    testTgId,
    "key_test_user",
    w.address,
    w.privateKey,
    pin
  );

  assert.ok(u, "User created successfully");
  assert.ok(u.system_encrypted_key, "System encrypted key generated");

  // 2. Derive Solana address from EVM key
  const solDerived = multichain.deriveSolanaFromEvmKey(w.privateKey);
  assert.ok(solDerived.solanaAddress, "Solana address derived");
  assert.ok(solDerived.secretKeyBase58, "Solana Base58 secret key derived");

  // 3. Test PIN decryption
  const decryptedEvmKey = db.decryptPrivateKey(pin, u);
  assert.strictEqual(decryptedEvmKey, w.privateKey, "EVM private key decrypted with valid PIN");

  // 4. Update & retrieve Solana deposit address
  db.updateSolanaAddress(testTgId, solDerived.solanaAddress);
  const updatedUser = db.getUser(testTgId);
  assert.strictEqual(updatedUser.solana_deposit_address, solDerived.solanaAddress, "Solana deposit address stored in DB");
});
