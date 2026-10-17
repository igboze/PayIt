// tests/offramp_failure_and_receipt.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/db");
const webhookServer = require("../src/webhook_server");

test("Offramp Failure & Receipt Isolation Suite", async (t) => {
  const testTgId = Date.now();

  await t.test("1. Failed offramp webhook marks order and transaction as failed without generating receipt", async () => {
    const offrampOrderId = `offramp_fail_test_${Date.now()}`;
    const txId = db.recordTransaction(testTgId, "offramp", 50000000n, "submitted", "0xsolana_test_tx", "personal", 18, "solana");
    
    db.recordOfframpOrder({
      orderId: offrampOrderId,
      telegramId: testTgId,
      accountType: "personal",
      accountNumber: "0123456789",
      bankCode: "000013",
      bankName: "GTBank",
      accountName: "John Doe",
      amountUsdc: 50,
      feeUsdc: 0.5,
      netAmountUsdc: 49.5,
      fiatAmount: 74250,
      rate: 1500,
      rail: "solana",
      status: "submitted",
      txHash: "0xsolana_test_tx",
    });

    const sentMessages = [];
    const sentPhotos = [];
    const mockBot = {
      telegram: {
        sendMessage: async (id, text, extra) => {
          sentMessages.push({ id, text, extra });
          return { message_id: 201 };
        },
        sendPhoto: async (id, photo, extra) => {
          sentPhotos.push({ id, photo, extra });
          return { message_id: 202 };
        },
      },
    };

    // Simulate Paj failure webhook for this offramp order
    const failurePayload = {
      event: "payout.failed",
      data: {
        reference: offrampOrderId,
        status: "failed",
        failureReason: "Beneficiary bank unavailable",
      },
    };

    await webhookServer.processPajEvent(failurePayload, { bot: mockBot });

    // Check DB status
    const order = db.getOfframpOrderByOrderId(offrampOrderId);
    assert.equal(order.status, "failed", "Offramp order must be marked as failed");

    // Check that NO receipt photo was sent
    assert.equal(sentPhotos.length, 0, "No receipt PNG should ever be sent for a failed offramp");

    // Check that failure message was sent to user
    assert.ok(sentMessages.length >= 1, "User must receive a failure notification message");
    const failMsg = sentMessages[0].text;
    assert.ok(failMsg.includes("Failed") || failMsg.includes("Declined"), "Notification must explain cash out failure");
    assert.ok(failMsg.includes("Beneficiary bank unavailable") || failMsg.includes("declined"), "Must mention reason");
  });

  await t.test("2. Offramp crypto receipt webhook (order.successful) does NOT trigger onramp deposit receipt", async () => {
    const offrampOrderId = `offramp_crypto_recv_${Date.now()}`;
    db.recordOfframpOrder({
      orderId: offrampOrderId,
      telegramId: testTgId,
      accountType: "personal",
      accountNumber: "0123456789",
      bankCode: "000013",
      bankName: "GTBank",
      accountName: "Jane Doe",
      amountUsdc: 25,
      feeUsdc: 0.25,
      netAmountUsdc: 24.75,
      fiatAmount: 37125,
      rate: 1500,
      rail: "solana",
      status: "submitted",
      txHash: "0xsol_crypto_tx",
    });

    const sentMessages = [];
    const sentPhotos = [];
    const mockBot = {
      telegram: {
        sendMessage: async (id, text, extra) => {
          sentMessages.push({ id, text, extra });
          return { message_id: 301 };
        },
        sendPhoto: async (id, photo, extra) => {
          sentPhotos.push({ id, photo, extra });
          return { message_id: 302 };
        },
      },
    };

    // When Paj detects the crypto funding for an offramp order, it may emit an order-level event
    const cryptoReceivedPayload = {
      event: "order.successful",
      data: {
        reference: offrampOrderId,
        status: "processing",
        currency: "USDC",
      },
    };

    await webhookServer.processPajEvent(cryptoReceivedPayload, { bot: mockBot });

    // Verify it was NOT treated as an onramp deposit!
    assert.equal(sentPhotos.length, 0, "Must NOT generate onramp receipt photo for offramp order");
    // Verify no messages claiming a deposit arrived
    for (const m of sentMessages) {
      assert.ok(!m.text.includes("Deposit Confirmed"), "Must NOT claim an on-ramp deposit occurred");
    }
  });

  await t.test("3. Successful fiat payout webhook completes order and generates confirmed receipt", async () => {
    const offrampOrderId = `offramp_success_test_${Date.now()}`;
    db.recordOfframpOrder({
      orderId: offrampOrderId,
      telegramId: testTgId,
      accountType: "personal",
      accountNumber: "0123456789",
      bankCode: "000013",
      bankName: "GTBank",
      accountName: "John Doe",
      amountUsdc: 10,
      feeUsdc: 0.1,
      netAmountUsdc: 9.9,
      fiatAmount: 14850,
      rate: 1500,
      rail: "solana",
      status: "submitted",
      txHash: "0xsol_success_tx",
    });

    const sentMessages = [];
    const sentPhotos = [];
    const mockBot = {
      telegram: {
        sendMessage: async (id, text, extra) => {
          sentMessages.push({ id, text, extra });
          return { message_id: 401 };
        },
        sendPhoto: async (id, photo, extra) => {
          sentPhotos.push({ id, photo, extra });
          return { message_id: 402 };
        },
      },
    };

    const successPayload = {
      event: "offramp.successful",
      data: {
        reference: offrampOrderId,
        status: "successful",
        fiatAmount: 14850,
        amount: 9.9,
      },
    };

    await webhookServer.processPajEvent(successPayload, { bot: mockBot });

    const order = db.getOfframpOrderByOrderId(offrampOrderId);
    assert.equal(order.status, "completed", "Order must be marked completed");
    assert.equal(sentPhotos.length, 1, "Must generate exactly 1 receipt photo upon confirmed bank payout");
    assert.ok(sentPhotos[0].extra?.caption?.includes("Cash Out Delivered"), "Receipt caption must confirm delivery");
  });

  await t.test("4. Multi-stage webhook lifecycle for same order does not block final settlement receipt", async () => {
    const multiStageOrderId = `offramp_multistage_${Date.now()}`;
    db.recordOfframpOrder({
      orderId: multiStageOrderId,
      telegramId: testTgId,
      accountType: "personal",
      accountNumber: "9135937824",
      bankCode: "000013",
      bankName: "GTBank",
      accountName: "EMILY ELIZABETH OMAJARI",
      amountUsdc: 7,
      feeUsdc: 0.07,
      netAmountUsdc: 6.93,
      fiatAmount: 9350.09,
      rate: 1349.22,
      rail: "arc",
      status: "submitted",
      txHash: "0xarc_funding_tx",
    });

    const sentPhotos = [];
    const mockBot = {
      telegram: {
        sendMessage: async () => ({ message_id: 501 }),
        sendPhoto: async (id, photo, extra) => {
          sentPhotos.push({ id, photo, extra });
          return { message_id: 502 };
        },
      },
    };

    // Stage 1: Initial crypto received webhook (order.successful / processing)
    const stage1Payload = {
      event: "order.successful",
      data: {
        reference: multiStageOrderId,
        status: "processing",
        amount: 6.93,
      },
    };
    await webhookServer.processPajEvent(stage1Payload, { bot: mockBot });
    assert.equal(sentPhotos.length, 0, "Stage 1 must not prematurely send delivery receipt");

    // Stage 2: Final fiat payout webhook (offramp.successful / completed)
    const stage2Payload = {
      event: "offramp.successful",
      data: {
        reference: multiStageOrderId,
        status: "completed",
        fiatAmount: 9350.09,
        amount: 6.93,
      },
    };
    await webhookServer.processPajEvent(stage2Payload, { bot: mockBot });

    assert.equal(sentPhotos.length, 1, "Stage 2 must not be dropped as duplicate and must generate receipt!");
    assert.ok(sentPhotos[0].extra?.caption?.includes("9,350.09") || sentPhotos[0].extra?.caption?.includes("Cash Out Delivered"), "Receipt caption must confirm delivery");

    // Stage 3: Real duplicate of stage 2 must be ignored
    await webhookServer.processPajEvent(stage2Payload, { bot: mockBot });
    assert.equal(sentPhotos.length, 1, "Exact duplicate of Stage 2 should be dropped by idempotency");
  });

  await t.test("5. Webhook matches pending offramp by account number if order ID was unmapped", async () => {
    const unmappedOrderId = `offramp_unmapped_${Date.now()}`;
    const testAccountNum = "9988776655";
    db.recordOfframpOrder({
      orderId: unmappedOrderId,
      telegramId: testTgId,
      accountType: "personal",
      accountNumber: testAccountNum,
      bankCode: "000013",
      bankName: "Access Bank",
      accountName: "Test Account",
      amountUsdc: 15,
      feeUsdc: 0.15,
      netAmountUsdc: 14.85,
      fiatAmount: 20000,
      rate: 1346,
      rail: "arc",
      status: "submitted",
    });

    const sentPhotos = [];
    const mockBot = {
      telegram: {
        sendMessage: async () => ({ message_id: 601 }),
        sendPhoto: async (id, photo, extra) => {
          sentPhotos.push({ id, photo, extra });
          return { message_id: 602 };
        },
      },
    };

    // Webhook arrives with provider's internal ID instead of unmappedOrderId, but has matching account number
    const providerPayload = {
      event: "payout.successful",
      data: {
        id: `paj_live_${Date.now()}`,
        status: "paid",
        accountNumber: testAccountNum,
        fiatAmount: 20000,
        amount: 14.85,
      },
    };

    await webhookServer.processPajEvent(providerPayload, { bot: mockBot });

    const order = db.getOfframpOrderByOrderId(unmappedOrderId);
    assert.equal(order.status, "completed", "Order matched by account number must be marked completed");
    assert.equal(sentPhotos.length, 1, "Receipt must be delivered to matched user");
  });

  await t.test("6. sendSponsoredOrDirectTransaction passes options.nonce to sendDirectFromWallet", async () => {
    const walletLib = require("../src/wallet");
    let passedOptions = null;
    const origSendDirect = walletLib.sendDirectFromWallet;

    // Verify options.nonce makes it through
    const dummySigner = {
      address: "0x1111111111111111111111111111111111111111",
      sendTransaction: async (txReq) => {
        passedOptions = txReq;
        return { hash: "0xtest_tx_hash", wait: async () => ({ status: 1 }) };
      },
    };

    const res = await walletLib.sendSponsoredOrDirectTransaction(
      dummySigner,
      "0x2222222222222222222222222222222222222222",
      1000n,
      "0x",
      { nonce: 42, skipWait: true }
    );

    assert.equal(res.txHash, "0xtest_tx_hash");
    assert.equal(passedOptions.nonce, 42, "options.nonce must be forwarded to signer transaction request");
  });
});

