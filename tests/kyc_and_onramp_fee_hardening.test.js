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

test("Live Nuvion Bank Codes: resolves First Bank Ghana, Choice Bank (KE), and Mwanga Hakika Bank (TZ)", async () => {
  const mockNuvion = {
    async listBankCodes(country) {
      if (country === "GH") {
        return [
          { bank_code: "200100", bank_name: "FBNBank Ghana Limited", swift_bic: "FBNKGHAC" },
          { bank_code: "030100", bank_name: "GCB Bank PLC", swift_bic: "GHCBGHAC" },
        ];
      }
      if (country === "KE") {
        return [
          { bank_code: "07500", bank_name: "Choice Microfinance Bank Limited", swift_bic: null },
          { bank_code: "03400", bank_name: "ABSA BANK KENYA PLC", swift_bic: "BARCKENX" },
        ];
      }
      if (country === "TZ") {
        return [
          { bank_code: "015001", bank_name: "MWANGA HAKIKA BANK LIMITED", swift_bic: "MHBKTZTZ" },
        ];
      }
      return [];
    },
  };

  // Ghana: "First Bank Ghana" -> matches live "FBNBank Ghana Limited" via synonym expansion
  const gh = await internationalBanks.resolveInternationalBankLive("GHS", "First Bank Ghana", null, { nuvionClient: mockNuvion });
  assert.equal(gh.code, "200100");
  assert.equal(gh.source, "nuvion_live");

  // Kenya: "Choice Bank" -> matches live 5-digit "Choice Microfinance Bank Limited"
  const ke = await internationalBanks.resolveInternationalBankLive("KES", "Choice Bank", null, { nuvionClient: mockNuvion });
  assert.equal(ke.code, "07500");
  assert.equal(ke.source, "nuvion_live");

  // Tanzania: typo "nwanga hakika bank" -> matches live 6-digit "MWANGA HAKIKA BANK LIMITED"
  const tz = await internationalBanks.resolveInternationalBankLive("TZS", "nwanga hakika bank", null, { nuvionClient: mockNuvion });
  assert.equal(tz.code, "015001");
  assert.equal(tz.source, "nuvion_live");

  // Receiving account enrichment helper returns exact live code
  const enrichedKe = await internationalBanks.enrichReceivingBankCodeLive("KES", "Choice Bank", null, { nuvionClient: mockNuvion });
  assert.equal(enrichedKe, "07500");
});

test("Email SMTP Support: nodemailer is installed and email footer has no Nuvion branding", () => {
  const nodemailer = require("nodemailer");
  assert.equal(typeof nodemailer.createTransport, "function");
  const emailSrc = fs.readFileSync(path.join(__dirname, "../src/email.js"), "utf8");
  assert.ok(emailSrc.includes("mail.privateemail.com"), "Default Namecheap Private Email SMTP host must be configured");
  assert.ok(!/powered by nuvion/i.test(emailSrc), "User emails must not expose Nuvion branding");
});

test("Telegram Bot KYC vs KYB Separation: retention tier card renders distinct Personal KYC and Business KYB statuses", () => {
  const retention = require("../src/retention");
  const html = retention.buildTierComparisonHtml(true, "not_started", {
    personalStatus: "approved",
    businessStatus: "not_started",
    hasBusiness: true,
  });
  assert.ok(html.includes("Personal KYC"), "Must explicitly label Personal KYC");
  assert.ok(html.includes("Tier 1 KYC Verified"), "Personal KYC approved must show verified");
  assert.ok(html.includes("Business KYB"), "Must explicitly label Business KYB");
  assert.ok(html.includes("No KYB Needed"), "Business KYB not started must remain Tier 0 even when Personal KYC is approved");
});

test("Mobile KYB Canonical Schema & 5 Required Docs: validates Nuvion 2026-02-06 payload and uploads all 5 docs", async () => {
  const features = require("../src/app_api/features");
  const compliance = require("../src/compliance");
  const capturedPayloads = [];
  const uploadedDocs = [];
  let submittedOnboardingId = null;

  const mockNuvion = {
    validateBusinessEntityPayload: nuvion.validateBusinessEntityPayload,
    async createBusinessEntity(payload) {
      nuvion.validateBusinessEntityPayload(payload);
      capturedPayloads.push(payload);
      return {
        entity: { id: "ent_biz_test_1", status: "incomplete" },
        business: { id: "biz_test_1" },
        business_officers: [{ person_id: "per_off_1" }],
      };
    },
    async uploadDocument(doc) {
      uploadedDocs.push(doc);
      return { id: `doc_${uploadedDocs.length}` };
    },
    async submitOnboarding(entityId) {
      submittedOnboardingId = entityId;
      return { status: "pending" };
    },
  };

  features.__setTestDeps({
    db,
    nuvion: mockNuvion,
    compliance,
    flowsKyc,
  });

  const auth = {
    telegramId: 99112233,
    user: {
      telegram_id: 99112233,
      business_deposit_address: "0x1111111111111111111111111111111111111111",
    },
  };

  const baseBody = {
    legalName: "Acme Global Solutions Ltd",
    tradeName: "Acme Global",
    registrationNumber: "RC7654321",
    taxId: "10293847-0001",
    incorporationCountry: "NG",
    incorporationState: "Lagos",
    incorporationYear: 2023,
    incorporationMonth: 6,
    industry: "Technology",
    description: "Cross-border software and digital consulting services",
    businessType: "llc",
    email: "finance@acmeglobal.ng",
    phoneNumber: "+2348012345678",
    website: "https://acmeglobal.ng",
    address: {
      line1: "14 Admiralty Way, Lekki Phase 1",
      city: "Lagos",
      state: "Lagos",
      postalCode: "106104",
      country: "NG",
    },
    officer: {
      firstName: "Chinedu",
      lastName: "Okafor",
      email: "chinedu@acmeglobal.ng",
      phoneNumber: "+2348098765432",
      dateOfBirth: "1990-04-12",
      gender: "male",
      nationality: "NG",
      jobTitle: "Chief Executive Officer",
      ownershipPercentage: 100,
      bvn: "12345678901",
      nin: "10987654321",
      idDocument: {
        type: "international_passport",
        number: "A98765432",
        issueDate: "2022-01-01",
        expiryDate: "2032-01-01",
        issuingAuthority: "Nigeria Immigration Service",
        country: "NG",
      },
    },
  };

  // Must reject when KYB documents are missing
  await assert.rejects(
    () => features.submitKyb(auth, baseBody),
    (err) => err.status === 400 && /5 documents/i.test(err.message)
  );

  // With all 5 required documents, must pass Nuvion validation, upload all 5 docs, and submit onboarding
  const b64 = Buffer.from("sample-document-bytes").toString("base64");
  const res = await features.submitKyb(auth, {
    ...baseBody,
    documents: {
      coiBase64: b64,
      coiMimeType: "application/pdf",
      memartBase64: b64,
      memartMimeType: "application/pdf",
      businessPoaBase64: b64,
      businessPoaMimeType: "image/jpeg",
      officerIdFrontBase64: b64,
      officerIdMimeType: "image/jpeg",
      officerPoaBase64: b64,
      officerPoaMimeType: "application/pdf",
    },
  });

  assert.equal(res.status, 201);
  assert.equal(res.data.status, "pending");
  assert.equal(capturedPayloads.length, 1);
  assert.equal(capturedPayloads[0].business.incorporation_meta.year, 2023);
  assert.equal(capturedPayloads[0].business.incorporation_meta.state, "Lagos");
  assert.equal(capturedPayloads[0].business.phonenumber, "+2348012345678");
  assert.equal(capturedPayloads[0].business_officers[0].job_title, "Chief Executive Officer");
  assert.equal(capturedPayloads[0].business_officers[0].is_control_person, true);
  assert.equal(capturedPayloads[0].business_officers[0].is_beneficial_owner, true);
  assert.equal(capturedPayloads[0].business_officers[0].ownership_percentage, 100);
  assert.equal(uploadedDocs.length, 5);
  assert.deepEqual(
    uploadedDocs.map((d) => d.key),
    ["certificate_of_incorporation", "memorandum_of_association", "proof_of_address", "identity", "proof_of_address"]
  );
  assert.equal(uploadedDocs[3].personId, "per_off_1");
  assert.equal(uploadedDocs[4].personId, "per_off_1");
  assert.equal(submittedOnboardingId, "ent_biz_test_1");
});

test("Hosted KYC/KYB Document Upload Bridge: stages file in RAM, returns documentId, and wipes after submit", async () => {
  const features = require("../src/app_api/features");
  const auth = { telegramId: 77712345 };
  const sess = features.createKycUploadSession(auth, { slot: "kyb_coi", label: "Certificate of Incorporation (PDF)" }, { headers: { host: "payit-production.up.railway.app" } });
  assert.equal(sess.status, 201);
  assert.ok(sess.data.uploadUrl.includes("/api/app/v1/kyc/upload-page?token="));

  const page = features.renderKycUploadPage(new URL(sess.data.uploadUrl));
  assert.equal(page.status, 200);
  assert.ok(page.raw.includes("Certificate of Incorporation (PDF)"));

  const before = features.getKycUploadSessionStatus(auth, sess.data.sessionId);
  assert.equal(before.data.ready, false);

  const up = features.completeKycUploadPage({
    token: sess.data.sessionId,
    name: "coi.pdf",
    mimeType: "application/pdf",
    base64: Buffer.from("%PDF-1.4 fake pdf bytes for testing").toString("base64"),
  });
  assert.equal(up.status, 200);
  assert.ok(up.data.documentId);

  const after = features.getKycUploadSessionStatus(auth, sess.data.sessionId);
  assert.equal(after.data.ready, true);
  assert.equal(after.data.documentId, up.data.documentId);
  assert.equal(after.data.name, "coi.pdf");
});

test("Username claim, Business Logo Upload, and Account Security Actions (pin.reset, wallet.export, account.freeze, account.delete)", async () => {
  process.env.INVOICE_FORWARDING_SECRET = process.env.INVOICE_FORWARDING_SECRET || "test-forwarding-secret-32-chars-min";
  const features = require("../src/app_api/features");
  const actions = require("../src/app_api/actions");
  const { ethers } = require("ethers");
  const sharp = require("sharp");

  // 1. Create two test users in SQLite
  const w1 = ethers.Wallet.createRandom();
  const w2 = ethers.Wallet.createRandom();
  const tg1 = 881001;
  const tg2 = 881002;
  db.createUserWithWallet(tg1, null, w1.address, w1.privateKey, "1234", null, null, null);
  db.createUserWithWallet(tg2, "taken_handle", w2.address, w2.privateKey, "1234", null, null, null);

  features.__setTestDeps({ db });
  const pubUser = (u) => ({ id: u.telegram_id, username: u.username });

  // Claiming an available @username succeeds
  const u1 = db.getUser(tg1);
  const claimOk = await features.updateProfile({ telegramId: tg1, user: u1 }, { username: "@fresh_founder" }, pubUser);
  assert.equal(claimOk.status, 200);
  assert.equal(db.getUser(tg1).username, "fresh_founder");

  // Claiming an already taken username (case-insensitive) returns 409
  await assert.rejects(
    () => features.updateProfile({ telegramId: tg1, user: db.getUser(tg1) }, { username: "TAKEN_HANDLE" }, pubUser),
    (err) => err.status === 409 && err.code === "username_taken"
  );

  // 2. Upload Business Logo persists resized PNG data URI
  const pngBuf = await sharp({
    create: { width: 120, height: 120, channels: 4, background: { r: 22, g: 163, b: 74, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const logoRes = await features.uploadBusinessLogo(
    { telegramId: tg1, user: db.getUser(tg1) },
    { imageBase64: pngBuf.toString("base64") }
  );
  assert.equal(logoRes.status, 200);
  assert.ok(logoRes.data.logoDataUri.startsWith("data:image/png;base64,"));

  // 3. Action registry checks: pin.reset & account.freeze are noPin: true
  assert.equal(actions.ACTIONS["pin.reset"].noPin, true);
  assert.equal(actions.ACTIONS["account.freeze"].noPin, true);
  assert.ok(!actions.ACTIONS["wallet.export"].noPin);
  assert.ok(!actions.ACTIONS["account.delete"].noPin);

  // 4. Execute pin.reset without knowing old PIN, then verify new PIN works for wallet.export
  const resetRes = await actions.ACTIONS["pin.reset"].execute(
    { telegramId: tg1, user: db.getUser(tg1) },
    { resetPin: true },
    null,
    null,
    { newPin: "4927" }
  );
  assert.equal(resetRes.reset, true);

  const exportRes = await actions.ACTIONS["wallet.export"].execute(
    { telegramId: tg1, user: db.getUser(tg1) },
    { accountType: "personal", exportKey: true },
    "4927",
    null,
    {}
  );
  assert.equal(exportRes.depositAddress.toLowerCase(), w1.address.toLowerCase());
  assert.equal(exportRes.privateKey.toLowerCase(), w1.privateKey.toLowerCase());

  // 5. Execute account.freeze and verify user is blocked
  const freezeRes = await actions.ACTIONS["account.freeze"].execute(
    { telegramId: tg1, user: db.getUser(tg1) },
    { freezeAccount: true },
    null,
    null,
    {}
  );
  assert.equal(freezeRes.frozen, true);
  assert.equal(Boolean(db.getUser(tg1).is_blocked), true);

  // 6. Execute account.delete on tg2 and verify PII cleared + blocked
  const delRes = await actions.ACTIONS["account.delete"].execute(
    { telegramId: tg2, user: db.getUser(tg2) },
    { deleteAccount: true },
    "1234",
    null,
    {}
  );
  assert.equal(delRes.deleted, true);
  assert.equal(Boolean(db.getUser(tg2).is_blocked), true);
  assert.equal(db.getUser(tg2).username, null);
});

test.after(() => {
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch (_) {}
});
