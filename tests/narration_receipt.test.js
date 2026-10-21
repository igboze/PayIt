// tests/narration_receipt.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const db = require("../src/db");
const receiptGenerator = require("../src/receipt_generator");
const webhookServer = require("../src/webhook_server");
const { classifyIntent } = require("../agent/intent_router");

test("Narration and Receipt Integration Suite", async (t) => {
  const testTgId = 88990011;

  await t.test("1. buildReceiptSvg renders Narration row cleanly for cashout and receive", () => {
    // Cashout with narration
    const cashoutSvg = receiptGenerator.buildReceiptSvg({
      type: "cashout",
      status: "COMPLETED",
      amountPrimary: "₦85,500",
      amountSecondary: "$50.00 USDC",
      reference: "PROXIM-CSH-TEST-001",
      network: "Arc · Payout Rail",
      sender: "Wallet (0x1234...abcd)",
      recipient: "GTBank · 0123456789 (John Doe)",
      narration: "Invoice 402 - Web Design",
      timestamp: "Oct 20, 2026, 08:30 PM",
    });

    assert.ok(cashoutSvg.includes("Narration"), "SVG must include Narration label");
    assert.ok(cashoutSvg.includes("Invoice 402 - Web Design"), "SVG must include custom narration text");

    // Receive (onramp deposit) with narration
    const depositSvg = receiptGenerator.buildReceiptSvg({
      type: "receive",
      status: "COMPLETED",
      amountPrimary: "$50.00 USDC",
      amountSecondary: "₦85,500 deposited",
      reference: "PROXIM-DEP-TEST-002",
      network: "Arc Network (USDC)",
      sender: "Proxim Virtual Account",
      recipient: "0x1234...abcd",
      narration: "Transfer from Freelance Client",
      timestamp: "Oct 20, 2026, 08:35 PM",
    });

    assert.ok(depositSvg.includes("Narration"), "Deposit SVG must include Narration label");
    assert.ok(depositSvg.includes("Transfer from Freelance Client"), "Deposit SVG must include narration text");
  });

  await t.test("2. generateReceiptPNG generates valid PNG buffer with narration", async () => {
    const pngPath = await receiptGenerator.generateReceiptPNG({
      type: "cashout",
      status: "COMPLETED",
      amountPrimary: "₦17,100",
      amountSecondary: "$10.00 USDC",
      reference: "PROXIM-CSH-PNG-01",
      network: "Solana · Payout Rail",
      sender: "Solana Wallet",
      recipient: "Kuda · 2001234567 (Jane Doe)",
      narration: "Dinner with Team",
      timestamp: "Oct 20, 2026, 08:40 PM",
    });

    assert.ok(typeof pngPath === "string", "Must return file path");
    assert.ok(fs.existsSync(pngPath), "Generated PNG file must exist on disk");
    const png = fs.readFileSync(pngPath);
    assert.ok(Buffer.isBuffer(png), "Must read as Buffer");
    assert.ok(png.length > 500, "PNG buffer must not be empty");
    // Verify PNG signature: 89 50 4E 47 0D 0A 1A 0A
    assert.equal(png[0], 0x89);
    assert.equal(png[1], 0x50);
    assert.equal(png[2], 0x4e);
    assert.equal(png[3], 0x47);
    fs.unlinkSync(pngPath);
  });

  await t.test("3. DB saves and retrieves narration on offramp orders", () => {
    const orderId = `test_offramp_narr_${Date.now()}`;
    db.recordOfframpOrder({
      orderId,
      telegramId: testTgId,
      accountType: "personal",
      accountNumber: "0123456789",
      bankCode: "000013",
      bankName: "GTBank",
      accountName: "John Doe",
      amountUsdc: 25,
      feeUsdc: 0.25,
      netAmountUsdc: 24.75,
      fiatAmount: 37125,
      rate: 1500,
      rail: "arc",
      status: "submitted",
      txHash: "0xtest_tx_hash",
      narration: "Payment for groceries",
    });

    const order = db.getOfframpOrderByOrderId(orderId);
    assert.ok(order, "Order should exist in DB");
    assert.equal(order.narration, "Payment for groceries", "Narration must match recorded text");
  });

  await t.test("4. DB saves and updates narration on onramp orders", () => {
    const orderId = `test_onramp_narr_${Date.now()}`;
    db.recordOnrampOrder({
      orderId,
      telegramId: testTgId,
      accountType: "personal",
      amountNgn: 50000,
      amountUsdc: 33.33,
      rate: 1500,
      status: "pending",
      virtualAccount: "1234567890",
      bankName: "Wema Bank",
      narration: "Deposit from Client X",
    });

    let order = db.getOnrampOrderByOrderId(orderId);
    assert.ok(order, "Onramp order should exist in DB");
    assert.equal(order.narration, "Deposit from Client X", "Initial onramp narration must match");

    // Complete onramp order with updated narration
    db.completeOnrampOrder(orderId, "0xdeposit_tx_hash", "Client X - Settlement memo");
    order = db.getOnrampOrderByOrderId(orderId);
    assert.equal(order.status, "completed");
    assert.equal(order.narration, "Client X - Settlement memo", "Completed onramp narration must be updated");
  });

  await t.test("5. Webhook delivery includes narration in caption and receipt for offramp", async () => {
    const offrampOrderId = `offramp_webhook_narr_${Date.now()}`;
    db.recordOfframpOrder({
      orderId: offrampOrderId,
      telegramId: testTgId,
      accountType: "personal",
      accountNumber: "0123456789",
      bankCode: "000013",
      bankName: "GTBank",
      accountName: "John Doe",
      amountUsdc: 15,
      feeUsdc: 0.15,
      netAmountUsdc: 14.85,
      fiatAmount: 22275,
      rate: 1500,
      rail: "arc",
      status: "submitted",
      txHash: "0xarc_receipt_hash",
      narration: "October Server Hosting",
    });

    const sentPhotos = [];
    const mockBot = {
      telegram: {
        sendPhoto: async (id, photo, extra) => {
          sentPhotos.push({ id, photo, extra });
          return { message_id: 301 };
        },
        sendMessage: async () => ({ message_id: 302 }),
      },
    };

    const successPayload = {
      event: "payout.successful",
      data: {
        reference: offrampOrderId,
        status: "successful",
        amount: 22275,
      },
    };

    await webhookServer.processPajEvent(successPayload, { bot: mockBot });

    assert.equal(sentPhotos.length, 1, "Must send receipt photo on successful offramp");
    const photoMsg = sentPhotos[0];
    assert.equal(photoMsg.id, testTgId);
    assert.ok(photoMsg.extra?.caption.includes("October Server Hosting"), "Caption must include narration");
    assert.ok(photoMsg.extra?.caption.includes("Narration"), "Caption must label Narration");
  });

  await t.test("6. Onramp deposit notification includes narration if provided", async () => {
    const onrampOrderId = `onramp_webhook_narr_${Date.now()}`;
    db.recordOnrampOrder({
      orderId: onrampOrderId,
      telegramId: testTgId,
      accountType: "personal",
      amountNgn: 15000,
      amountUsdc: 10,
      rate: 1500,
      status: "pending",
      virtualAccount: "9988776655",
      bankName: "Wema Bank",
    });

    const sentPhotos = [];
    const mockBot = {
      telegram: {
        sendPhoto: async (id, photo, extra) => {
          sentPhotos.push({ id, photo, extra });
          return { message_id: 401 };
        },
        sendMessage: async () => ({ message_id: 402 }),
      },
    };

    const depositPayload = {
      event: "collection.successful",
      data: {
        reference: onrampOrderId,
        amount: 15000,
        amountUsdc: 10,
        recipient: "0x1234567890123456789012345678901234567890",
        txHash: "0xsolana_deposit_mint_hash",
        narration: "Monthly Stipend from Dad",
      },
    };

    await webhookServer.processPajEvent(depositPayload, { bot: mockBot });

    assert.equal(sentPhotos.length, 1, "Must send receipt photo on onramp deposit");
    const photoMsg = sentPhotos[0];
    assert.equal(photoMsg.id, testTgId);
    assert.ok(photoMsg.extra?.caption.includes("Monthly Stipend from Dad"), "Caption must display deposit narration");
    assert.ok(photoMsg.extra?.caption.includes("Narration"), "Caption must display Narration label");
  });

  await t.test("7. Intent router extracts narration from natural language offramp", async () => {
    const intentRes = await classifyIntent("cash out $20 to GTBank 0123456789 for Project supplies");
    assert.equal(intentRes.intent, "offramp", "Should classify as offramp");
    const recipient = intentRes.params?.recipients?.[0];
    assert.ok(recipient, "Should have recipient");
    assert.equal(recipient.account_number, "0123456789");
    assert.ok(recipient.narration, "Should extract narration");
    assert.equal(recipient.narration.toLowerCase(), "project supplies");
  });
});
