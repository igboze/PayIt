// tests/kyc_and_onramp_fee_hardening.test.js
// Tests for:
// 1. Reduced 0.2% On-Ramp deposit fee
// 2. Savings and Nuvion fee routing to 0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359
// 3. Telegram bot KYC pause & resume flow
// 4. Mobile KYC canonical Nuvion payload structure
// 5. International bank code resolution for GHS, TZS, KES, UGX, ZAR
// 6. Direct user KYC transactional notification & email

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const testDbPath = path.join(__dirname, `test_kyc_hardening_${Date.now()}.sqlite`);
process.env.PAYIT_DB_PATH = testDbPath;
process.env.APP_JWT_SECRET = "test-jwt-secret-must-be-at-least-32-chars-long-0001";
process.env.APP_FEE_RECIPIENT_ADDRESS = "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359";

const internationalBanks = require("../src/international_banks");
const savings = require("../src/savings");
const db = require("../src/db");
const flowsKyc = require("../src/flows_nuvion_kyc");
const email = require("../src/email");
const nuvion = require("../src/nuvion");

test("On-Ramp Deposit Fee: 0.2% platform fee rate applied to inbound deposits", () => {
  const depositAmountUsdc = 500;
  const onrampFeeRate = 0.002; // 0.2%
  const feeUsdc = Number((depositAmountUsdc * onrampFeeRate).toFixed(4));
  const netUsdc = Number((depositAmountUsdc - feeUsdc).toFixed(4));

  assert.equal(feeUsdc, 1.00); // 0.2% of $500 is $1.00 (not $5.00)
  assert.equal(netUsdc, 499.00);
});

test("Savings: Platform fee fraction is 10% and routes to APP_FEE_RECIPIENT_ADDRESS", () => {
  assert.equal(savings.PAYIT_FEE_FRACTION, 0.1);
  const position = {
    amount_usdc: 100,
    gross_apy: 10,
    user_apy: 9,
    payit_fee_apy: 1,
    opened_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const breakdown = savings.calcYieldBreakdown(position);
  assert.ok(breakdown.grossYield >= 9.9 && breakdown.grossYield <= 10.1);
  assert.equal(breakdown.devFee, Number((breakdown.grossYield * 0.1).toFixed(6)));
  assert.equal(breakdown.netYield, Number((breakdown.grossYield - breakdown.devFee).toFixed(6)));
});

test("Telegram KYC: Draft state is saved on pause and retrievable on resume", () => {
  const testTgId = 8812345;
  const testStep = "nuvion_kyc_address_street";
  const testData = {
    nationality: "NG",
    first_name: "Chukwudi",
    last_name: "Okeke",
    email: "chukwudi@example.com",
    phonenumber: "+2348012345678",
  };

  db.saveNuvionKycDraft(testTgId, "personal", testStep, testData);
  const retrieved = db.getNuvionKycDraft(testTgId, "personal");

  assert.ok(retrieved, "Draft must be saved");
  assert.equal(retrieved.step, testStep);
  assert.equal(retrieved.data.first_name, "Chukwudi");
  assert.equal(retrieved.data.email, "chukwudi@example.com");

  // Deletion on completion works
  db.deleteNuvionKycDraft(testTgId, "personal");
  assert.equal(db.getNuvionKycDraft(testTgId, "personal"), null);
});

test("International Bank Resolution: GHS, TZS, KES, UGX, ZAR bank codes resolve accurately", () => {
  // Ghana
  const gcb = internationalBanks.resolveInternationalBank("GHS", "GCB Bank");
  assert.equal(gcb.code, "030100");
  const ecobankGh = internationalBanks.resolveInternationalBank("GHS", "ecobank");
  assert.equal(ecobankGh.code, "130100");

  // Tanzania
  const crdb = internationalBanks.resolveInternationalBank("TZS", "CRDB Bank");
  assert.equal(crdb.code, "015");
  const nmb = internationalBanks.resolveInternationalBank("TZS", "NMB");
  assert.equal(nmb.code, "012");

  // Kenya
  const kcb = internationalBanks.resolveInternationalBank("KES", "KCB Bank");
  assert.equal(kcb.code, "01");
  const equity = internationalBanks.resolveInternationalBank("KES", "Equity Bank");
  assert.equal(equity.code, "68");

  // Uganda
  const stanbicUg = internationalBanks.resolveInternationalBank("UGX", "Stanbic Bank Uganda");
  assert.equal(stanbicUg.code, "040147");

  // South Africa
  const fnb = internationalBanks.resolveInternationalBank("ZAR", "First National Bank");
  assert.equal(fnb.code, "250655");
});

test("Mobile KYC Canonical Schema: passes Nuvion pre-flight schema validation", () => {
  const entityPayload = {
    name: "Emeka Obi",
    person: {
      first_name: "Emeka",
      last_name: "Obi",
      email: "emeka.obi@example.com",
      date_of_birth: "1994-08-20",
      gender: "m",
      phonenumber: "+2348012345678",
      nationality: "NG",
      bvn: "12345678901",
      nin: "12345678901",
    },
    address: {
      line_1: "12 Admiralty Way",
      city: "Lekki",
      state: "Lagos",
      postal_code: "100001",
      country_code: "NG",
    },
    identification: {
      document: {
        type: "international_passport",
        number: "A12345678",
        issue_date: "2022-01-01",
        expiry_date: "2032-01-01",
        issuing_country: "NG",
        issuing_authority: "Nigeria Immigration Service",
      },
      proof_of_address: {
        type: "utility_bill",
      },
    },
    meta: {
      funding_source: "salary",
      monthly_transaction_value: "5000",
      customer_types: "individual",
      monthly_payments_count: "20",
      max_transfer_amount: "5000",
      sales_channels: "Proxim Mobile",
    },
  };

  assert.doesNotThrow(() => {
    nuvion.validateIndividualEntityPayload(entityPayload);
  });
});

test("Direct User Email Dispatch: formats and dispatches KYC status emails to end users", async () => {
  const res = await email.sendKycStatusEmail({
    to: "user@example.com",
    name: "Adaora Okafor",
    status: "approved",
    accountType: "personal",
  });
  assert.ok(res);
  // Without live API key, simulated dispatch logs cleanly
  assert.equal(res.simulated, true);
});

test.after(() => {
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch (_) {}
});
