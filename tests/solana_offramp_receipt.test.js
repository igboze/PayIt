// tests/solana_offramp_receipt.test.js
// Tests steady Solana deposit PNG receipt generation and waitForCompletion consolidation for Paj off-ramp

const test = require("node:test");
const assert = require("node:assert/strict");

const cctpBridge = require("../src/cctp_bridge");

test("sendSolanaDepositReceipt generates PNG receipt and sends photo with Solana details", async () => {
  const photos = [];
  const messages = [];
  const mockBot = {
    telegram: {
      sendPhoto: async (chatId, sourceObj, opts) => {
        photos.push({ chatId, source: sourceObj?.source, caption: opts?.caption });
        return { message_id: 1 };
      },
      sendMessage: async (chatId, text) => {
        messages.push({ chatId, text });
        return { message_id: 2 };
      },
    },
  };

  const receiptPath = await cctpBridge.sendSolanaDepositReceipt({
    bot: mockBot,
    telegramId: 123456789,
    solanaAddress: "So1anaSteadyAddr1111111111111111111111111111",
    arcAddress: "0x1111111111111111111111111111111111111111",
    amountUsdc: 12.5,
    txHash: "5SolanaTxHash1234567890",
    user: { first_name: "Israel" },
    bridgedToArc: false,
  });

  assert.ok(receiptPath, "Must generate a receipt PNG path");
  assert.equal(photos.length, 1, "Must send deposit receipt photo to user");
  assert.ok(photos[0].caption.includes("Solana Deposit Received"), "Caption must identify Solana deposit");
  assert.ok(photos[0].caption.includes("$12.50 USDC"), "Caption must include deposited USDC amount");
  assert.ok(photos[0].caption.includes("So1anaSteadyAddr1111111111111111111111111111"));
});
