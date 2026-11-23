// tests/invoice_channels.test.js
// Verifies NGN/USD currency selection, Paj NGN-only channel, NEAR Intents exact-amount
// crypto checkout channel, Both channel, and ready-to-forward client copy text.

const assert = require("assert");
const fs = require("fs");
const sharp = require("sharp");

const {
  generateInvoicePNG,
  buildClientInvoiceCopyText,
} = require("../src/invoice_generator");
const invoiceHd = require("../src/invoice_hd");
const nearLib = require("../src/near");
const nuvionOrchestrator = require("../src/nuvion_orchestrator");

async function run() {
  console.log("=== Testing Invoice Channels (NGN/USD, Paj, NEAR Intents, Copy Text) ===");

  // 1. Naira-only invoice PNG (no crypto box, NGN formatted)
  const ngnPng = await generateInvoicePNG({
    invoiceNumber: "INV-NGN-01",
    clientName: "Lagos Digital Ltd",
    items: [
      { description: "UI/UX Redesign", quantity: 1, unitPrice: 150000 },
      { description: "Frontend Implementation", quantity: 1, unitPrice: 250000 },
    ],
    dueDate: "2026-12-15",
    businessName: "Proxim Studio",
    walletAddress: null,
    cryptoPaymentDetails: null,
    issueDate: "2026-11-23",
    currency: "NGN",
    fiatDetails: {
      bankName: "Wema Bank PLC",
      accountNumber: "0123456789",
      accountName: "Proxim / Lagos Digital Ltd",
      fiatAmount: 400000,
    },
  });
  assert.ok(fs.existsSync(ngnPng), "NGN-only invoice PNG should exist");
  const ngnMeta = await sharp(ngnPng).metadata();
  assert.strictEqual(ngnMeta.width, 2280, "3x Retina width should be 2280px");
  assert.ok(ngnMeta.height > 1000, "PNG height should be valid");
  fs.unlinkSync(ngnPng);
  console.log("  ✓ NGN-only invoice PNG rendered cleanly at 2280px Retina");

  // 2. NEAR Intents exact-amount crypto-only invoice PNG (no fiat box)
  const cryptoPng = await generateInvoicePNG({
    invoiceNumber: "INV-SOL-01",
    clientName: "Global Ventures Inc",
    items: [
      { description: "Smart Contract Audit", quantity: 1, unitPrice: 2500 },
    ],
    dueDate: "2026-12-01",
    businessName: "Audit Labs",
    walletAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    cryptoPaymentDetails: {
      chainId: "sol_usdc",
      chainLabel: "Solana",
      tokenSymbol: "USDC",
      exactAmount: 2500,
      depositAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      depositMemo: "inv-sol-01",
      viaNearIntents: true,
    },
    issueDate: "2026-11-23",
    currency: "USD",
    fiatDetails: null,
  });
  assert.ok(fs.existsSync(cryptoPng), "Crypto-only NEAR Intents invoice PNG should exist");
  const cryptoMeta = await sharp(cryptoPng).metadata();
  assert.strictEqual(cryptoMeta.width, 2280, "3x Retina width should be 2280px");
  fs.unlinkSync(cryptoPng);
  console.log("  ✓ NEAR Intents crypto-only invoice PNG rendered cleanly with QR & memo");

  // 3. Client copy text for NGN-only invoice
  const ngnCopy = buildClientInvoiceCopyText({
    invoiceNumber: "INV-NGN-01",
    businessName: "Proxim Studio",
    clientName: "Lagos Digital Ltd",
    currency: "NGN",
    totalNgn: 400000,
    totalUsdc: 288.03,
    dueDate: "2026-12-15",
    fiatDetails: {
      bankName: "Wema Bank PLC",
      accountNumber: "0123456789",
      accountName: "Proxim / Lagos Digital Ltd",
      fiatAmount: 400000,
    },
    cryptoPaymentDetails: null,
    walletAddress: null,
  });
  assert.ok(ngnCopy.includes("₦400,000.00"), "NGN copy text should display ₦ amount");
  assert.ok(ngnCopy.includes("<code>0123456789</code>"), "NGN copy text should have tap-to-copy account number");
  assert.ok(!ngnCopy.includes("Pay via Crypto"), "NGN-only copy text should not include crypto section");
  console.log("  ✓ NGN-only client copy text formatted cleanly");

  // 4. Client copy text for NEAR Intents crypto-only invoice
  const cryptoCopy = buildClientInvoiceCopyText({
    invoiceNumber: "INV-SOL-01",
    businessName: "Audit Labs",
    clientName: "Global Ventures Inc",
    currency: "USD",
    totalUsdc: 2500,
    dueDate: "2026-12-01",
    fiatDetails: null,
    cryptoPaymentDetails: {
      chainLabel: "Solana",
      tokenSymbol: "USDC",
      exactAmount: 2500,
      depositAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      depositMemo: "inv-sol-01",
      viaNearIntents: true,
    },
  });
  assert.ok(cryptoCopy.includes("$2,500.00 USD"), "USD copy text should show $ amount");
  assert.ok(cryptoCopy.includes("Solana"), "Crypto copy text should show Solana network");
  assert.ok(cryptoCopy.includes("<code>7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU</code>"), "Crypto copy text should have tap-to-copy deposit address");
  assert.ok(cryptoCopy.includes("<code>inv-sol-01</code>"), "Crypto copy text should include memo");
  assert.ok(!cryptoCopy.includes("Nigerian Bank Transfer"), "Crypto-only copy text should not include NGN bank section");
  console.log("  ✓ NEAR Intents crypto-only client copy text formatted cleanly");

  // 5. provisionInvoiceCryptoIntent with stubbed nearLib.createSolanaDeposit
  const origCreateSol = nearLib.createSolanaDeposit;
  try {
    nearLib.createSolanaDeposit = async (params) => ({
      id: 99,
      deposit_address: "So11111111111111111111111111111111111111112",
      deposit_memo: null,
      deadline: "2026-11-24T00:00:00Z",
      amount_token: params.amount,
    });
    const intent = await invoiceHd.provisionInvoiceCryptoIntent({
      telegramId: 12345,
      accountType: "business",
      cryptoChain: "sol_usdc",
      totalUsdc: 125.5,
      mainWalletAddress: "0x1111111111111111111111111111111111111111",
      decryptedPrivateKey: "0x" + "11".repeat(32),
      fallbackArcAddress: "0x2222222222222222222222222222222222222222",
    });
    assert.strictEqual(intent.viaNearIntents, true);
    assert.strictEqual(intent.chainLabel, "Solana");
    assert.strictEqual(intent.tokenSymbol, "USDC");
    assert.strictEqual(intent.exactAmount, 125.5);
    assert.strictEqual(intent.depositAddress, "So11111111111111111111111111111111111111112");
    console.log("  ✓ provisionInvoiceCryptoIntent provisions exact-amount NEAR Intents checkout");
  } finally {
    nearLib.createSolanaDeposit = origCreateSol;
  }

  // 6. Tier-1 Verified Global Bank Account (USD ACH/Wire + EUR SEPA IBAN) PNG & Copy Text
  const origProvision = nuvionOrchestrator.provisionGlobalReceivingAccount;
  try {
    nuvionOrchestrator.provisionGlobalReceivingAccount = async (_tid, _acctType, cur) => ({
      entity: { legal_name: "Acme Global LLC" },
      detail: cur === "EUR"
        ? {
            detail_id: "det_eur_1",
            currency: "EUR",
            bank_name: "Banking Circle S.A.",
            iban: "LU280019400644750000",
            swift_code: "BCIRLULL",
            beneficiary_name: "Acme Global LLC",
            status: "active",
          }
        : {
            detail_id: "det_usd_1",
            currency: "USD",
            bank_name: "Lead Bank",
            account_number: "9876543210",
            routing_number: "101019644",
            swift_code: "LEADUS44",
            beneficiary_name: "Acme Global LLC",
            status: "active",
          },
      isPending: false,
      cached: true,
    });

    const usdBank = await invoiceHd.provisionNuvionBankForInvoice({
      telegramId: 12345,
      accountType: "business",
      bankCurrency: "USD",
      totalUsdc: 1200,
      totalNgn: 1666500,
    });
    assert.strictEqual(usdBank.pending, false);
    assert.strictEqual(usdBank.provider, "global_bank");
    assert.strictEqual(usdBank.accountNumber, "9876543210");
    assert.strictEqual(usdBank.routingNumber, "101019644");

    const usdBankPng = await generateInvoicePNG({
      invoiceNumber: "INV-T1-USD",
      clientName: "Stripe Enterprise",
      items: [{ description: "Platform Retainer", quantity: 1, unitPrice: 1200 }],
      dueDate: "2026-12-20",
      businessName: "Acme Global LLC",
      walletAddress: null,
      cryptoPaymentDetails: null,
      issueDate: "2026-11-23",
      currency: "USD",
      fiatDetails: usdBank,
    });
    assert.ok(fs.existsSync(usdBankPng), "Tier-1 USD Global Bank PNG should render");
    fs.unlinkSync(usdBankPng);

    const usdBankCopy = buildClientInvoiceCopyText({
      invoiceNumber: "INV-T1-USD",
      businessName: "Acme Global LLC",
      clientName: "Stripe Enterprise",
      currency: "USD",
      totalUsdc: 1200,
      dueDate: "2026-12-20",
      fiatDetails: usdBank,
    });
    assert.ok(usdBankCopy.includes("<code>9876543210</code>"), "USD bank copy should include account number");
    assert.ok(usdBankCopy.includes("<code>101019644</code>"), "USD bank copy should include routing number");
    assert.ok(usdBankCopy.includes("Lead Bank"), "USD bank copy should include bank name");
    assert.ok(!usdBankCopy.includes("Nuvion"), "Client copy text should never leak vendor name");

    const eurBank = await invoiceHd.provisionNuvionBankForInvoice({
      telegramId: 12345,
      accountType: "business",
      bankCurrency: "EUR",
      totalUsdc: 850,
    });
    assert.strictEqual(eurBank.iban, "LU280019400644750000");
    assert.strictEqual(eurBank.swiftCode, "BCIRLULL");

    const bothPng = await generateInvoicePNG({
      invoiceNumber: "INV-T1-BOTH",
      clientName: "Berlin GmbH",
      items: [{ description: "API Consulting", quantity: 1, unitPrice: 850 }],
      businessName: "Acme Global LLC",
      walletAddress: "So11111111111111111111111111111111111111112",
      cryptoPaymentDetails: {
        chainLabel: "Solana",
        tokenSymbol: "USDC",
        exactAmount: 850,
        depositAddress: "So11111111111111111111111111111111111111112",
        viaNearIntents: true,
      },
      issueDate: "2026-11-23",
      currency: "USD",
      fiatDetails: eurBank,
    });
    assert.ok(fs.existsSync(bothPng), "Tier-1 EUR Global Bank + NEAR Intents PNG should render");
    fs.unlinkSync(bothPng);
    console.log("  ✓ Tier-1 Global Bank (USD ACH/Wire + EUR SEPA IBAN) + NEAR Intents PNG & copy text verified");
  } finally {
    nuvionOrchestrator.provisionGlobalReceivingAccount = origProvision;
  }

  console.log("=== All Invoice Channel Tests Passed! ===");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
