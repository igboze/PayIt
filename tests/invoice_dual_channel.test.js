const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Wallet } = require("ethers");

const invoiceHd = require("../src/invoice_hd");
const invoiceDb = require("../src/invoice_db");
const bizDb = require("../src/biz_db");
const db = require("../src/db");
const webhookServer = require("../src/webhook_server");
const cctpBridge = require("../src/cctp_bridge");

test("Dual-Channel Invoice: Personal invoice creates dedicated on-chain address, dynamic fiat account, and QR card", async () => {
  const testTelegramId = 777111222;
  const masterWallet = Wallet.createRandom();

  // Seed user in DB
  const user = {
    telegram_id: testTelegramId,
    username: "TestMerchant",
    deposit_address: masterWallet.address,
    solana_deposit_address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  };

  const invNumber = `INV-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const invoiceData = {
    invoiceNumber: invNumber,
    clientName: "David Adeleke",
    clientEmail: "david@example.com",
    items: [
      { description: "Product Design & Architecture", quantity: 1, unitPrice: 200, total: 200 },
      { description: "API Integration", quantity: 1, unitPrice: 50, total: 50 },
    ],
    totalUsdc: 250,
    dueDate: "2026-10-01",
    notes: "Payment due within 14 days",
    issueDate: "2026-09-18",
  };

  const result = await invoiceHd.createCompleteInvoice({
    telegramId: testTelegramId,
    decryptedPrivateKey: masterWallet.privateKey,
    user,
    invoiceData,
    businessName: "David Studios",
  });

  assert.ok(result.invoiceId, "Invoice ID must be returned");
  assert.equal(result.invoiceNumber, invNumber);
  assert.ok(result.paymentAddress, "Dedicated payment address must be generated");
  assert.notEqual(result.paymentAddress, masterWallet.address, "Dedicated payment address must be different from master wallet");
  assert.equal(result.mainWalletAddress, masterWallet.address, "Settlement destination must be merchant's main wallet");
  assert.ok(result.pngPath, "Invoice PNG card must be generated");
  assert.ok(fs.existsSync(result.pngPath), "Invoice PNG file must exist on disk");

  // Verify DB record
  const savedInvoice = invoiceDb.getInvoice(result.invoiceId);
  assert.ok(savedInvoice);
  assert.equal(savedInvoice.invoice_number, invNumber);
  assert.equal(savedInvoice.wallet_address, masterWallet.address);
  assert.equal(savedInvoice.payment_address, result.paymentAddress);
  assert.equal(savedInvoice.status, "unpaid");

  // Verify fiat details attached
  if (result.fiatDetails) {
    assert.ok(result.fiatDetails.accountNumber);
    assert.ok(result.fiatDetails.bankName);
    assert.ok(result.fiatDetails.fiatAmount > 0);
    assert.equal(savedInvoice.fiat_account_number, result.fiatDetails.accountNumber);
  }
});

test("Dual-Channel Invoice: Business invoice creates dedicated on-chain address and settles to SME business deposit address", async () => {
  const testBizId = 888222333;
  const bizMasterWallet = Wallet.createRandom();
  const mainBizDepositAddress = "0x1111222233334444555566667777888899990000";

  const user = {
    telegram_id: testBizId,
    username: "TechCorpGlobal",
    deposit_address: bizMasterWallet.address,
    business_deposit_address: mainBizDepositAddress,
    solana_deposit_address: "4Nd1mBQtrMJVYVfKf2PJy9NZmcCcFiSm3b5UzxbJM4TJ",
  };

  const profile = {
    business_name: "TechCorp Global Ltd",
    business_email: "billing@techcorp.io",
    phone: "+2348012345678",
    address: "Victoria Island, Lagos",
  };

  const bizInvNumber = `BIZ-${Date.now().toString().slice(-4)}${Math.floor(Math.random() * 100)}`;
  const invoiceData = {
    invoiceNumber: bizInvNumber,
    clientName: "Zenith Holdings",
    clientEmail: "procurement@zenith.com",
    items: [{ description: "Enterprise Cloud License", quantity: 1, unitPrice: 1200, total: 1200 }],
    totalUsdc: 1200,
    dueDate: "2026-10-15",
    notes: "Net 30 payment terms",
    issueDate: "2026-09-18",
  };

  const result = await invoiceHd.createCompleteBizInvoice({
    telegramId: testBizId,
    decryptedBizKey: bizMasterWallet.privateKey,
    user,
    invoiceData,
    profile,
  });

  assert.ok(result.invoiceId);
  assert.equal(result.invoiceNumber, bizInvNumber);
  assert.ok(result.paymentAddress);
  assert.notEqual(result.paymentAddress, mainBizDepositAddress);

  // Verify saved in biz_invoices
  const savedBizInvoice = bizDb.getBizInvoice(result.invoiceId);
  assert.ok(savedBizInvoice);
  assert.equal(savedBizInvoice.wallet_address, mainBizDepositAddress);
  assert.equal(savedBizInvoice.payment_address, result.paymentAddress);
  assert.equal(savedBizInvoice.status, "unpaid");
});

test("Dual-Channel Invoice: Paj Webhook auto-settles fiat payment to merchant's main account", async () => {
  const merchantId = 999000000 + Math.floor(Math.random() * 900000);
  const invNumber = `INV-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const mainWallet = Wallet.createRandom();

  // Create user in DB
  const merchantUser = db.createUserWithWallet(
    merchantId,
    `Merchant_${merchantId}`,
    mainWallet.address,
    mainWallet.privateKey,
    "1234"
  );

  // Create invoice in DB
  const invoiceId = invoiceDb.createInvoiceWithHDAddress(merchantId, {
    invoiceNumber: invNumber,
    clientName: "Aliko Dangote",
    clientEmail: "aliko@dangote.com",
    items: [{ description: "Consulting", quantity: 1, unitPrice: 100, total: 100 }],
    totalUsdc: 100,
    walletAddress: mainWallet.address,
    paymentAddress: "0xDedicatedOnChainInvoicePaymentAddress9903",
    pngPath: "/tmp/inv-9903.png",
    derivationIndex: 3,
    expectedAmountMicro: "100000000000000000000",
  });

  const dynamicFiatOrderId = `paj_fiat_order_${merchantId}_${Date.now()}`;
  invoiceDb.updateInvoiceFiatDetails(invoiceId, {
    fiatAccountNumber: "0123456789",
    fiatBankName: "Wema Bank PLC",
    fiatAccountName: "PayIT / Aliko Dangote",
    fiatAmount: 138875,
    fiatOrderId: dynamicFiatOrderId,
    fiatRate: 1388.75,
  });

  const messagesSent = [];
  const mockBot = {
    telegram: {
      sendMessage: async (id, text) => {
        messagesSent.push({ id, text });
        return { message_id: 101 };
      },
    },
  };

  // Simulate Paj Webhook arriving with userExternalId = "INV-9903"
  const webhookPayload = {
    event: "onramp.successful",
    data: {
      id: dynamicFiatOrderId,
      userExternalId: invNumber,
      amount: 100,
      fiatAmount: 138875,
      recipient: merchantUser.solana_deposit_address,
      txHash: `5wK...solanaTxInvoice${merchantId}`,
    },
  };

  await webhookServer.processPajEvent(webhookPayload, mockBot);

  // 1. Verify invoice marked paid
  const updatedInvoice = invoiceDb.getInvoice(invoiceId);
  assert.equal(updatedInvoice.status, "paid", "Invoice must be marked as paid");
  assert.equal(updatedInvoice.paid_tx_hash, `5wK...solanaTxInvoice${merchantId}`);

  // 2. Verify notifications sent to merchant
  assert.ok(messagesSent.length >= 1, "Merchant must be notified via Telegram");
  const notification = messagesSent[0].text;
  assert.ok(notification.includes(invNumber), "Notification must mention invoice number");
  assert.ok(notification.includes("Aliko Dangote"), "Notification must mention client name");
});
