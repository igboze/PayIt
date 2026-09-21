const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const testDbPath = path.join(__dirname, "test_sweep_solana_pin.db");
if (fs.existsSync(testDbPath)) {
  try { fs.unlinkSync(testDbPath); } catch (_) {}
}
process.env.PAYIT_DB_PATH = testDbPath;
process.env.AUTO_BRIDGE_SOLANA_TO_ARC = "false";

const db = require("../src/db");
const walletLib = require("../src/wallet");
const multichain = require("../src/multichain");
const webhookServer = require("../src/webhook_server");

test("Solana Sweep PIN Authorization & Settlement Flow", async (t) => {
  const telegramId = 888777666;
  const pin = "1234";

  const wallet = walletLib.generateUserWallet();
  db.createUserWithWallet(telegramId, "testuser", wallet.address, wallet.privateKey, pin);

  const derivedSol = multichain.deriveSolanaFromEvmKey(wallet.privateKey);

  // Set initial temporary address
  db.updateSolanaAddress(telegramId, "wr1UudCbdBs1yEXf2dVoKnceeRWcX47Hi2Wzaz66C7j");
  const user = db.getUser(telegramId);
  assert.equal(user.solana_deposit_address, "wr1UudCbdBs1yEXf2dVoKnceeRWcX47Hi2Wzaz66C7j");

  // Verify PIN
  const pinCheck = db.verifyPinWithStatus(telegramId, pin);
  assert.equal(pinCheck.valid, true);

  // Execute sweep settlement to derived Solana address
  db.updateSolanaAddress(telegramId, derivedSol.solanaAddress);
  const updatedUser = db.getUser(telegramId);
  assert.equal(updatedUser.solana_deposit_address, derivedSol.solanaAddress);

  // Mock bot to capture messages
  const sentMessages = [];
  const mockBot = {
    telegram: {
      sendMessage: async (chatId, text, opts) => {
        sentMessages.push({ chatId, text, opts });
      },
    },
  };

  await webhookServer.processPajEvent({
    event: "onramp.successful",
    data: {
      userExternalId: telegramId,
      recipient: derivedSol.solanaAddress,
      amount: 12.08,
      id: "paj_sweep_test_1",
      txHash: "paj_solana_sweep_test_1",
    },
  }, mockBot);

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Deposit Settled on Solana/);
  assert.match(sentMessages[0].text, /\$12\.08 USDC/);
  assert.doesNotMatch(sentMessages[0].text, /Bridging funds cross-chain to Arc/);
});
