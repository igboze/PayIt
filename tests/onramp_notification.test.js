// tests/onramp_notification.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/db");
const webhookServer = require("../src/webhook_server");

test("On-Ramp Notification & Order Tracking Suite", async (t) => {
  const testOrderId = `test_order_${Date.now()}`;
  const testTgId = Date.now();

  await t.test("1. recordOnrampOrder records pending order and completes it", async () => {
    db.recordOnrampOrder({
      orderId: testOrderId,
      telegramId: testTgId,
      accountType: "personal",
      fiatAmount: 50000,
      amountUsdc: 35.5,
      rate: 1408.45,
      recipientAddress: "0xTestArcAddress",
      settlementRail: "arc",
    });

    const order = db.getOnrampOrderByOrderId(testOrderId);
    assert.ok(order, "Order should be found");
    assert.equal(order.order_id, testOrderId);
    assert.equal(order.telegram_id, testTgId);
    assert.equal(order.fiat_amount, 50000);
    assert.equal(order.amount_usdc, 35.5);
    assert.equal(order.status, "pending");

    const pending = db.getPendingOnrampOrders();
    const found = pending.find((o) => o.order_id === testOrderId);
    assert.ok(found, "Order should be in pending list");

    db.completeOnrampOrder(testOrderId, "0xTestTxHash123");
    const updated = db.getOnrampOrderByOrderId(testOrderId);
    assert.equal(updated.status, "completed");
    assert.equal(updated.tx_hash, "0xTestTxHash123");
  });

  await t.test("2. sendOnrampDepositNotification sends rich message with deposit & credited amount", async () => {
    const sent = [];
    const mockBot = {
      telegram: {
        sendMessage: async (id, text, extra) => {
          sent.push({ id, text, extra });
          return { message_id: 101 };
        },
      },
    };

    await webhookServer.sendOnrampDepositNotification({
      bot: mockBot,
      telegramId: testTgId,
      fiatAmount: 75000,
      amountUsdc: 52.3,
      accountType: "personal",
      txHash: "0xArcTxHashComplete",
      orderId: testOrderId,
      rate: 1434,
      network: "Arc Mainnet",
    });

    assert.equal(sent.length, 1);
    const msg = sent[0].text;
    assert.ok(msg.includes("75,000"), "Must include Naira deposit amount");
    assert.ok(msg.includes("52.30 USDC"), "Must include USD credited amount");
    assert.ok(msg.includes("1,434"), "Must include exchange rate");
    assert.ok(msg.includes("Personal Wallet"), "Must include account label");
    assert.ok(msg.includes("Arc Mainnet"), "Must include network");
    assert.ok(msg.includes("0xArcTxHashComplete"), "Must include tx hash");
    assert.ok(sent[0].extra?.reply_markup?.inline_keyboard?.length >= 2, "Must include action buttons");
  });
});
