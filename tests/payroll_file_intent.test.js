// tests/payroll_file_intent.test.js
// Production-grade validation of PayIT's Multi-Rail Payroll Intent & Idempotency System

const test = require("node:test");
const assert = require("node:assert/strict");
const { mapSpreadsheetRows, buildLocalPaymentPlan, formatFilePreview } = require("../agent/file_parser");
const { resolveBankCode } = require("../src/bank_resolver");
const { isSolanaAddress, deriveSolanaFromEvmKey } = require("../src/multichain");
const idempotency = require("../src/idempotency");
const { executePlan } = require("../agent/executor");
const db = require("../src/db");
const walletLib = require("../src/wallet");

test("Bank Resolver: accurately resolves Nigerian banks and neobanks to 6-digit NIBSS codes", async () => {
  const gtb = await resolveBankCode("GTBank");
  assert.equal(gtb.bankCode, "000013");

  const access = await resolveBankCode("Access Bank");
  assert.equal(access.bankCode, "000014");

  const zenith = await resolveBankCode("Zenith Bank");
  assert.equal(zenith.bankCode, "000015");

  const kuda = await resolveBankCode("Kuda");
  assert.equal(kuda.bankCode, "090267");

  const opay = await resolveBankCode("OPay");
  assert.equal(opay.bankCode, "100004");

  const moniepoint = await resolveBankCode("Moniepoint MFB");
  assert.equal(moniepoint.bankCode, "090405");

  const palmpay = await resolveBankCode("PalmPay");
  assert.equal(palmpay.bankCode, "100033");

  // Numeric code padding
  const numeric = await resolveBankCode("14");
  assert.equal(numeric.bankCode, "000014");
});

test("Multichain: correctly distinguishes Arc EVM 0x and Solana Base58 addresses", () => {
  const evmAddress = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
  const solanaAddress = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const invalidAddress = "not_an_address_123";

  assert.equal(isSolanaAddress(evmAddress), false);
  assert.equal(isSolanaAddress(solanaAddress), true);
  assert.equal(isSolanaAddress(invalidAddress), false);

  // Key derivation test
  const derived = deriveSolanaFromEvmKey("0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a074712d8");
  assert.ok(isSolanaAddress(derived.solanaAddress));
  assert.ok(derived.keypair);
});

test("File Parser: maps mixed multi-rail payroll rows (NGN, Arc EVM, Solana)", () => {
  const rawRows = [
    {
      "Employee Name": "Tunde Bakare",
      "Salary": "150,000",
      "Currency": "NGN",
      "Payment Rail": "Bank Transfer",
      "Bank": "GTBank",
      "Account Number": "0123456789",
      "Role": "Lead Engineer",
    },
    {
      "Employee Name": "Satoshi Nakamoto",
      "Salary": "350",
      "Currency": "USDC",
      "Payment Rail": "On-Chain",
      "Destination": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      "Role": "Architect",
    },
    {
      "Employee Name": "Anatoly Yakovenko",
      "Salary": "275",
      "Currency": "USDC",
      "Payment Rail": "Solana",
      "Destination": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      "Role": "Systems Dev",
    },
    {
      "Employee Name": "Elena Rostova",
      "Salary": "120",
      "Currency": "EURC",
      "Payment Rail": "Arc EVM",
      "Destination": "0x1111111111111111111111111111111111111111",
      "Role": "EU Operations",
    },
  ];

  const mapped = mapSpreadsheetRows(rawRows);
  assert.ok(mapped, "Expected successful mapping");
  assert.equal(mapped.length, 4);

  // 1. Tunde (NGN via Bank)
  assert.equal(mapped[0].name, "Tunde Bakare");
  assert.equal(mapped[0].amount, 150000);
  assert.equal(mapped[0].currency, "NGN");
  assert.equal(mapped[0].chain, "fiat");
  assert.equal(mapped[0].method, "fiat_offramp");
  assert.equal(mapped[0].account_number, "0123456789");

  // 2. Satoshi (USDC via Arc EVM)
  assert.equal(mapped[1].name, "Satoshi Nakamoto");
  assert.equal(mapped[1].amount, 350);
  assert.equal(mapped[1].currency, "USDC");
  assert.equal(mapped[1].chain, "arc");
  assert.equal(mapped[1].method, "onchain_evm");
  assert.equal(mapped[1].wallet_address, "0x742d35Cc6634C0532925a3b844Bc454e4438f44e");

  // 3. Anatoly (USDC via Solana)
  assert.equal(mapped[2].name, "Anatoly Yakovenko");
  assert.equal(mapped[2].amount, 275);
  assert.equal(mapped[2].currency, "USDC");
  assert.equal(mapped[2].chain, "solana");
  assert.equal(mapped[2].method, "onchain_solana");
  assert.equal(mapped[2].wallet_address, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");

  // 4. Elena (EURC via Arc EVM)
  assert.equal(mapped[3].name, "Elena Rostova");
  assert.equal(mapped[3].amount, 120);
  assert.equal(mapped[3].currency, "EURC");
  assert.equal(mapped[3].chain, "arc");
  assert.equal(mapped[3].method, "onchain_evm");

  // Test preview formatting
  const preview = formatFilePreview({ type: "payroll", rows: mapped, total: 4, currency: "MIXED" });
  assert.ok(preview.includes("Multi-Rail Payroll"));
  assert.ok(preview.includes("Bank (NGN)"));
  assert.ok(preview.includes("Arc EVM"));
  assert.ok(preview.includes("Solana"));
});

test("Idempotency Ledger: guarantees deterministic keys and prevents double spending", () => {
  const batchId = "test_batch_001";
  idempotency.clearBatch(batchId);

  const itemA = {
    to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    amount: 100,
    currency: "USDC",
    method: "onchain_evm",
  };

  const key1 = idempotency.generateIdempotencyKey(batchId, 0, itemA);
  const key2 = idempotency.generateIdempotencyKey(batchId, 0, itemA);
  assert.equal(key1, key2, "Idempotency keys must be deterministic");

  // Initial check: must be null
  assert.equal(idempotency.checkIdempotency(key1), null);

  // Start payment
  idempotency.startIdempotency(key1, {
    batchId,
    rowIndex: 0,
    recipient: itemA.to,
    amount: itemA.amount,
    currency: itemA.currency,
    method: itemA.method,
  });

  const check1 = idempotency.checkIdempotency(key1);
  assert.ok(check1);
  assert.equal(check1.status, "pending");

  // Complete payment
  idempotency.completeIdempotency(key1, { txHash: "0xabcdef123456" });
  const check2 = idempotency.checkIdempotency(key1);
  assert.equal(check2.status, "completed");
  assert.equal(check2.txHash, "0xabcdef123456");

  // Batch status check
  const status = idempotency.getBatchStatus(batchId);
  assert.equal(status.total, 1);
  assert.equal(status.completed, 1);
  assert.equal(status.pending, 0);
  assert.equal(status.failed, 0);

  idempotency.clearBatch(batchId);
});

test("Executor: enforces idempotency guards on repeated execution", async () => {
  const testBatchId = `idemp_exec_test_${Date.now()}`;
  const testKey = `test_key_${Date.now()}`;

  // Pre-seed an idempotency record as already completed
  idempotency.startIdempotency(testKey, {
    batchId: testBatchId,
    rowIndex: 0,
    recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    amount: 50,
    currency: "USDC",
    method: "onchain_evm",
  });
  idempotency.completeIdempotency(testKey, { txHash: "0x9876543210fedcba" });

  const plan = {
    batchId: testBatchId,
    payments: [
      {
        to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        amount: 50,
        currency: "USDC",
        label: "Salary payout",
        idempotency_key: testKey,
      },
    ],
  };

  // Mock user record
  const mockUserId = Math.floor(Math.random() * 10000000) + 1000000;
  const pin = "1234";
  const { address, privateKey } = walletLib.generateUserWallet();
  db.createUserWithWallet(mockUserId, "test_payroll_user", address, privateKey, pin);
  const user = db.getUser(mockUserId);

  // Run execution
  const results = await executePlan(plan, pin, user, "personal");

  assert.equal(results.length, 1);
  assert.equal(results[0].success, true);
  assert.equal(results[0].alreadyExecuted, true);
  assert.equal(results[0].idempotent, true);
  assert.equal(results[0].txHash, "0x9876543210fedcba");

  // Clean up
  idempotency.clearBatch(testBatchId);
});

test("Payroll Plan: buildLocalPaymentPlan generates unique deterministic idempotency keys and multi-rail breakdown", () => {
  const rows = [
    { name: "Adaeze", amount: 200000, currency: "NGN", bank_name: "Access Bank", account_number: "0987654321" },
    { name: "Chidi", amount: 150, currency: "USDC", wallet_address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", chain: "arc" },
    { name: "Zainab", amount: 300, currency: "USDC", wallet_address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", chain: "solana" },
  ];

  const batchId = "batch_payroll_unique_123";
  const plan = buildLocalPaymentPlan(rows, "Pay all staff immediately", { batchId });

  assert.equal(plan.batchId, batchId);
  assert.equal(plan.payments.length, 3);

  // Adaeze - NGN fiat offramp
  assert.equal(plan.payments[0].method, "fiat_offramp");
  assert.equal(plan.payments[0].currency, "NGN");
  assert.equal(plan.payments[0].to, "__offramp__");
  assert.ok(plan.payments[0].idempotency_key);

  // Chidi - Arc EVM
  assert.equal(plan.payments[1].method, "onchain_evm");
  assert.equal(plan.payments[1].chain, "arc");
  assert.equal(plan.payments[1].to, "0x742d35Cc6634C0532925a3b844Bc454e4438f44e");
  assert.ok(plan.payments[1].idempotency_key);

  // Zainab - Solana
  assert.equal(plan.payments[2].method, "onchain_solana");
  assert.equal(plan.payments[2].chain, "solana");
  assert.equal(plan.payments[2].to, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  assert.ok(plan.payments[2].idempotency_key);

  // Idempotency keys must be distinct for each row
  assert.notEqual(plan.payments[0].idempotency_key, plan.payments[1].idempotency_key);
  assert.notEqual(plan.payments[1].idempotency_key, plan.payments[2].idempotency_key);
});
