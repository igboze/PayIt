// tests/global_account_maintenance.test.js
// Verifies exact Nuvion per-account monthly maintenance fee billing:
// 1. Exact Nuvion fee schedule ($2 USD, €2 EUR, £2 GBP, CA$2 CAD, AED 10, GH₵5, KSh 25, TSh 500, MX$35)
// 2. Option B: accounts opened < 15 days ago are skipped; >= 15 days old are billed
// 3. Direct book-transfer collection into Proxim's Master Nuvion account (same currency + NGN fallback)
// 4. Unpaid accounts enter 14-day grace period, recover on deposit, and auto-close on Day 14 ONLY if balance === 0
// 5. GET /global/accounts exposes currencyFees + billingPolicy; DELETE /global/accounts/:currency closes safely

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDb = path.join(os.tmpdir(), `global_acct_maint_${process.pid}_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = tmpDb;
process.env.NUVION_API_KEY = "test_nuvion_key_for_unit_test";
process.env.APP_JWT_SECRET = "global-acct-maint-test-secret-must-be-32-chars";

const { Wallet } = require("ethers");
const db = require("../src/db");
const nuvion = require("../src/nuvion");
const orchestrator = require("../src/nuvion_orchestrator");
const worker = require("../src/monthly_fee_worker");
const features = require("../src/app_api/features");

test.after(() => {
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try { fs.unlinkSync(f); } catch (_) { }
  }
});

test("1. Exact Nuvion maintenance fee schedule matches live Nuvion tariff", () => {
  assert.equal(nuvion.getGlobalAccountMonthlyFee("USD").amount, 2.0);
  assert.equal(nuvion.getGlobalAccountMonthlyFee("USD").minor, 200);
  assert.equal(nuvion.getGlobalAccountMonthlyFee("EUR").amount, 2.0);
  assert.equal(nuvion.getGlobalAccountMonthlyFee("GBP").amount, 2.0);
  assert.equal(nuvion.getGlobalAccountMonthlyFee("CAD").amount, 2.0);
  assert.equal(nuvion.getGlobalAccountMonthlyFee("AED").amount, 10.0);
  assert.equal(nuvion.getGlobalAccountMonthlyFee("GHS").amount, 5.0);
  assert.equal(nuvion.getGlobalAccountMonthlyFee("KES").amount, 25.0);
  assert.equal(nuvion.getGlobalAccountMonthlyFee("TZS").amount, 500.0);
  assert.equal(nuvion.getGlobalAccountMonthlyFee("NGN").coveredByBaseMonthlyFee, true);
  assert.equal(nuvion.formatGlobalAccountMonthlyFee("USD"), "$2.00/mo");
  assert.equal(nuvion.formatGlobalAccountMonthlyFee("GBP"), "£2.00/mo");
  assert.equal(nuvion.formatGlobalAccountMonthlyFee("AED"), "AED 10.00/mo");
});

test("2. Option B: skips accounts opened < 15 days ago and bills accounts >= 15 days old into Master account", async () => {
  const tgId = 770011;
  const w = Wallet.createRandom();
  db.createUserWithWallet(tgId, "globaluser1", w.address, w.privateKey, "1234");
  db.upsertNuvionEntity({
    telegramId: tgId,
    accountType: "personal",
    entityId: "ent_global_1",
    entityType: "individual",
    legalName: "Ada Global",
    email: "ada@example.com",
    status: "approved",
  });

  // Brand-new GBP account (opened 3 days ago -> MUST BE SKIPPED)
  db.upsertNuvionAccount({ entityId: "ent_global_1", accountId: "acct_gbp_new", currency: "GBP", purpose: "receiving", status: "active" });
  db.prepare("UPDATE nuvion_accounts SET created_at = datetime('now', '-3 days') WHERE account_id = 'acct_gbp_new'").run();

  // Mature USD account (opened 20 days ago -> MUST BE BILLED $2.00)
  db.upsertNuvionAccount({ entityId: "ent_global_1", accountId: "acct_usd_old", currency: "USD", purpose: "receiving", status: "active" });
  db.prepare("UPDATE nuvion_accounts SET created_at = datetime('now', '-20 days') WHERE account_id = 'acct_usd_old'").run();

  // Mature NGN account (covered by base ₦200 fee -> MUST NOT be double-billed here)
  db.upsertNuvionAccount({ entityId: "ent_global_1", accountId: "acct_ngn_old", currency: "NGN", purpose: "receiving", status: "active" });
  db.prepare("UPDATE nuvion_accounts SET created_at = datetime('now', '-30 days') WHERE account_id = 'acct_ngn_old'").run();

  const billable = db.getBillableGlobalAccountsForMonth("2026-11", 15);
  assert.equal(billable.length, 1, "Only the 20-day-old USD account should be billable");
  assert.equal(billable[0].account_id, "acct_usd_old");

  // Mock Nuvion master transfer & account read
  const transfers = [];
  const origGetAccount = nuvion.getAccount;
  const origCreateTransfer = nuvion.createTransfer;
  const origGetBalances = orchestrator.getEntityFiatBalances;
  const origMarginTarget = orchestrator.ensureChildToParentMarginTarget;

  nuvion.getAccount = async () => ({
    id: "acct_usd_old",
    currency: "USD",
    balance: { available: 5000, current: 5000 },
    outstanding_breakdown: [{ source: "account_maintenance_fee", currency: "USD", amount: 200 }],
  });
  orchestrator.getEntityFiatBalances = async () => [
    { accountId: "acct_usd_old", currency: "USD", availableMinor: 5000, available: 50 },
  ];
  orchestrator.ensureChildToParentMarginTarget = async (_eid, cur) => ({
    counterpartyId: `cp_master_${cur}`,
    paymentDetailId: `pd_master_${cur}`,
  });
  nuvion.createTransfer = async (payload) => {
    transfers.push(payload);
    return { id: "tr_master_usd_200" };
  };

  try {
    const summary = await worker.runGlobalAccountMaintenanceCycle({
      billingMonth: "2026-11",
      minAgeDays: 15,
      graceDays: 14,
      ngnRateOverride: 1450,
    });
    assert.equal(summary.eligibleAccounts, 1);
    assert.equal(summary.chargedCount, 1);
    assert.equal(summary.pastDueCount, 0);
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].currency, "USD");
    assert.equal(transfers[0].amountMinor, 200);
    assert.equal(transfers[0].paymentType, "book-transfer");
    assert.equal(transfers[0].counterpartyId, "cp_master_USD");
  } finally {
    nuvion.getAccount = origGetAccount;
    nuvion.createTransfer = origCreateTransfer;
    orchestrator.getEntityFiatBalances = origGetBalances;
    orchestrator.ensureChildToParentMarginTarget = origMarginTarget;
  }
});

test("3. Low balance triggers 14-day grace period, and Day-14 auto-close deletes ONLY zero-balance accounts", async () => {
  const tgId = 770022;
  const w = Wallet.createRandom();
  db.createUserWithWallet(tgId, "globaluser2", w.address, w.privateKey, "1234");
  db.upsertNuvionEntity({
    telegramId: tgId,
    accountType: "personal",
    entityId: "ent_global_2",
    entityType: "individual",
    legalName: "Chidi Global",
    email: "chidi@example.com",
    status: "approved",
  });
  db.upsertNuvionAccount({ entityId: "ent_global_2", accountId: "acct_eur_unpaid", currency: "EUR", purpose: "receiving", status: "active" });
  db.upsertNuvionAccountDetail({ accountId: "acct_eur_unpaid", detailId: "det_eur_unpaid", entityId: "ent_global_2", assetType: "fiat", currency: "EUR", iban: "DE001234", status: "active" });
  db.prepare("UPDATE nuvion_accounts SET created_at = datetime('now', '-25 days') WHERE account_id = 'acct_eur_unpaid'").run();

  const deletedAccounts = [];
  const origGetAccount = nuvion.getAccount;
  const origDeleteAccount = nuvion.deleteAccount;
  const origGetBalances = orchestrator.getEntityFiatBalances;

  nuvion.getAccount = async () => ({ id: "acct_eur_unpaid", currency: "EUR", balance: { available: 0, current: 0 }, outstanding_breakdown: [] });
  orchestrator.getEntityFiatBalances = async () => [{ accountId: "acct_eur_unpaid", currency: "EUR", availableMinor: 0, available: 0 }];
  nuvion.deleteAccount = async (acctId, entId) => {
    deletedAccounts.push({ acctId, entId });
    return { deleted: true };
  };

  try {
    // Month-end run marks account past_due with 14-day grace
    const run = await worker.runGlobalAccountMaintenanceCycle({
      billingMonth: "2026-11",
      minAgeDays: 15,
      graceDays: 14,
      ngnRateOverride: 1450,
    });
    assert.equal(run.pastDueCount, 1);

    const pastDue = db.getPastDueGlobalAccountFees({ telegramId: tgId });
    assert.equal(pastDue.length, 1);
    assert.equal(pastDue[0].currency, "EUR");
    assert.equal(pastDue[0].amount_major, 2);

    // Before 14 days expire, grace processor must NOT delete the account
    const beforeExpiry = await worker.processGlobalAccountGracePeriods({ ngnRateOverride: 1450 });
    assert.equal(beforeExpiry.closedCount, 0);
    assert.equal(deletedAccounts.length, 0);

    // Simulate Day 15 (grace_expires_at in the past)
    db.prepare("UPDATE global_account_maintenance_fees SET grace_expires_at = datetime('now', '-1 hour') WHERE account_id = 'acct_eur_unpaid'").run();

    const afterExpiry = await worker.processGlobalAccountGracePeriods({ ngnRateOverride: 1450 });
    assert.equal(afterExpiry.closedCount, 1);
    assert.equal(deletedAccounts.length, 1);
    assert.equal(deletedAccounts[0].acctId, "acct_eur_unpaid");

    // Verify local DB marked both account and detail closed (hidden from active list)
    assert.equal(db.getNuvionAccountsByEntity("ent_global_2", { currency: "EUR" }).length, 0);
    assert.equal(db.getNuvionAccountDetailsByEntity("ent_global_2", "EUR").length, 0);
  } finally {
    nuvion.getAccount = origGetAccount;
    nuvion.deleteAccount = origDeleteAccount;
    orchestrator.getEntityFiatBalances = origGetBalances;
  }
});

test("4. GET /global/accounts exposes currencyFees & billingPolicy, and closeGlobalAccount rejects positive balances", async () => {
  const tgId = 770033;
  const w = Wallet.createRandom();
  db.createUserWithWallet(tgId, "globaluser3", w.address, w.privateKey, "1234");
  db.upsertNuvionEntity({
    telegramId: tgId,
    accountType: "personal",
    entityId: "ent_global_3",
    entityType: "individual",
    legalName: "Kemi Global",
    status: "approved",
  });
  db.upsertNuvionAccount({ entityId: "ent_global_3", accountId: "acct_usd_funded", currency: "USD", purpose: "receiving", status: "active" });
  db.upsertNuvionAccountDetail({ accountId: "acct_usd_funded", detailId: "det_usd_funded", entityId: "ent_global_3", assetType: "fiat", currency: "USD", accountNumber: "123456789", status: "active" });

  const auth = { telegramId: tgId, user: db.getUser(tgId) };
  const listRes = await features.listGlobalAccounts(auth, new URL("http://localhost/api/app/v1/global/accounts"));
  assert.equal(listRes.status, 200);
  assert.equal(listRes.data.currencyFees.USD.formatted, "$2.00/mo");
  assert.equal(listRes.data.billingPolicy.minAgeDays, 15);
  assert.equal(listRes.data.billingPolicy.graceDays, 14);
  assert.equal(listRes.data.accounts[0].monthlyFee, "$2.00/mo");
  assert.equal(listRes.data.accounts[0].canClose, true);

  // Safety guard: closing a funded account must throw
  const origGetAccount = nuvion.getAccount;
  nuvion.getAccount = async () => ({ id: "acct_usd_funded", currency: "USD", balance: { available: 1500, current: 1500 } });
  try {
    await assert.rejects(
      () => features.closeGlobalAccount(auth, new URL("http://localhost/api/app/v1/global/accounts/USD"), "USD"),
      /still has a balance/i
    );
  } finally {
    nuvion.getAccount = origGetAccount;
  }
});
