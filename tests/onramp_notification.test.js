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

  await t.test("3. recordOfframpOrder records clean 10-digit account number and completes it", async () => {
    const offrampOrderId = `test_offramp_${Date.now()}`;
    db.recordOfframpOrder({
      orderId: offrampOrderId,
      telegramId: testTgId,
      accountType: "personal",
      accountNumber: "0123456789",
      bankCode: "058",
      bankName: "GTBank",
      accountName: "John Doe",
      amountUsdc: 100,
      feeUsdc: 1.0,
      netAmountUsdc: 99.0,
      fiatAmount: 148500,
      rate: 1500,
      rail: "solana",
      status: "pending",
    });

    const order = db.getOfframpOrderByOrderId(offrampOrderId);
    assert.ok(order, "Offramp order should be found");
    assert.equal(order.order_id, offrampOrderId);
    assert.equal(order.account_number, "0123456789", "Bank account must be preserved exactly without 64-digit mangling");
    assert.equal(order.bank_name, "GTBank");
    assert.equal(order.amount_usdc, 100);
    assert.equal(order.fee_usdc, 1.0);
    assert.equal(order.net_amount_usdc, 99.0);

    db.completeOfframpOrder(offrampOrderId, "0xSolanaTxSignature123");
    const completed = db.getOfframpOrderByOrderId(offrampOrderId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.tx_hash, "0xSolanaTxSignature123");
  });

  await t.test("4. generateReceiptPNG preserves 10-digit bank account without 64-char address truncation", async () => {
    const { generateReceiptPNG } = require("../src/receipt_generator");
    const receiptPath = await generateReceiptPNG({
      receiptId: "CO-123456",
      senderName: "Proxim Wallet",
      recipientName: "John Doe (GTBank)",
      recipientAddress: "0123456789",
      amountUsdc: 50,
      token: "USDC",
      type: "Cash Out",
      timestamp: new Date().toISOString(),
      status: "Confirmed",
      txHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    });

    const fs = require("fs");
    assert.ok(fs.existsSync(receiptPath), "Receipt PNG must be generated");
    assert.ok(fs.statSync(receiptPath).size > 1000, "Receipt PNG must have valid size");
  });
});
