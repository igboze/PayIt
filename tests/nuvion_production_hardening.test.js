// tests/nuvion_production_hardening.test.js
// 100% Offline Production Hardening & Isolation Audit Suite for Nuvion + Arc<->Base Settlement.
// Verifies EVERY KYC/KYB schema rule (X-API-Version: 2026-02-06), atomic idempotency locks,
// strict Personal vs Business & multi-user fund isolation, cross-job USC inflow matching,
// and seamless Arc (Paj) <-> Base (Nuvion) settlement — with ZERO live API calls!

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const tmpDbPath = path.join(os.tmpdir(), `test_nuvion_hardening_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = tmpDbPath;
process.env.NODE_ENV = "test";
process.env.NUVION_ENV = "sandbox";
process.env.NUVION_API_KEY = "nv_test_hardening_key";
process.env.NUVION_WEBHOOK_SECRET = "nv_wsk_hardening_secret";
process.env.NUVION_FX_MARGIN_BPS = "100";
process.env.NUVION_BETA_IDS = "888001,888002";
process.env.NUVION_PUBLIC_LAUNCH = "false";
process.env.PAJ_ARC_OFFRAMP_ENABLED = "true";

const db = require("../src/db");
const nuvion = require("../src/nuvion");
const nuvionWebhooks = require("../src/nuvion_webhooks");
const orchestrator = require("../src/nuvion_orchestrator");
const payouts = require("../src/nuvion_payouts");
const cards = require("../src/nuvion_cards");
const flowsKyc = require("../src/flows_nuvion_kyc");
const chains = require("../src/chains");
const walletLib = require("../src/wallet");
const cctpBridge = require("../src/cctp_bridge");
const convState = require("../src/conversation_state");
const evmSweeper = require("../src/evm_deposit_sweeper");
const executor = require("../agent/executor");
const offramp = require("../src/offramp");

convState.initStateTable();
orchestrator.registerOrchestratorHooks();
payouts.registerPayoutHooks();
cards.registerCardHooks();

function startStrictSpecMockServer() {
  const store = {
    entities: new Map(),
    personsByEmail: new Map(),
    documents: [],
    accounts: new Map(),
    counterparties: new Map(),
    paymentDetails: new Map(),
    transfers: new Map(),
    transfersByRef: new Map(),
    cards: new Map(),
    requests: [],
    failNextDocUploadOnce: false,
    failNextStablecoinSweepOnce: false,
    unloadDelayMs: 0,
  };

  let seq = 1;
  const ulid = (p) => `01HRD${p}${String(seq++).padStart(16, "0")}`.slice(0, 26);

  // Seed root parent USD operational account for 1% margin book-transfers
  store.accounts.set("01PARENTUSD", {
    id: "01PARENTUSD",
    entity_id: "ROOT",
    type: "operational",
    currency: "USD",
    nuvion_ban: "0099000001",
    status: "active",
    balance: { available: 0, current: 0 },
  });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : {};
      const parsed = new URL(req.url, "http://127.0.0.1");
      const pathname = parsed.pathname;
      const query = Object.fromEntries(parsed.searchParams.entries());
      store.requests.push({ method: req.method, pathname, query, body });

      const send = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      // POST /individual-entities
      if (req.method === "POST" && pathname === "/individual-entities") {
        const email = String(body.person?.email || "").toLowerCase();
        if (store.personsByEmail.has(email)) {
          return send(409, { status: "error", type: "error_duplicate_resource", message: "A record with this person already exists." });
        }
        const entityId = ulid("IND");
        const personId = ulid("PER");
        const rec = {
          entity: { id: entityId, type: "individual", status: "incomplete", name: body.name, person_id: personId },
          person: { id: personId, ...body.person },
          address: body.address,
        };
        store.entities.set(entityId, rec);
        store.personsByEmail.set(email, personId);
        return send(201, { status: "success", data: rec });
      }

      // POST /business-entities — enforces official Nuvion response shape (business_officers[0].person_id!)
      if (req.method === "POST" && pathname === "/business-entities") {
        if (Array.isArray(body.business_officers) && body.business_officers.length === 0) {
          return send(500, { status: "error", type: "error_system_internal_error", message: "Empty officers array" });
        }
        const officerInput = body.business_officers?.[0];
        let officerPersonId = officerInput?.person_id || null;
        let officerPersonObj = null;
        if (!officerPersonId && officerInput?.person) {
          const email = String(officerInput.person.email || "").toLowerCase();
          if (store.personsByEmail.has(email)) {
            return send(409, { status: "error", type: "error_duplicate_resource", message: "A record with this person already exists." });
          }
          officerPersonId = ulid("PER");
          store.personsByEmail.set(email, officerPersonId);
          officerPersonObj = { id: officerPersonId, ...officerInput.person };
        }
        const entityId = ulid("BIZ");
        const businessId = ulid("BUS");
        const rec = {
          entity: { id: entityId, type: "business", status: "incomplete", name: body.name, business_id: businessId },
          business: { id: businessId, ...body.business },
          address: body.address,
          // NOTE: Official POST /business-entities returns person_id (NOT nested person.id)!
          business_officers: [
            {
              id: ulid("OFF"),
              person_id: officerPersonId,
              job_title: officerInput?.job_title || "Director",
              is_control_person: true,
              is_beneficial_owner: true,
              ownership_percentage: officerInput?.ownership_percentage || 100,
              business_id: businessId,
            },
          ],
          _officerPerson: officerPersonObj,
        };
        store.entities.set(entityId, rec);
        return send(201, { status: "success", data: rec });
      }

      // GET /entities/{id}
      const getEnt = pathname.match(/^\/entities\/([^/]+)$/);
      if (req.method === "GET" && getEnt) {
        const rec = store.entities.get(getEnt[1]);
        if (!rec) return send(404, { status: "error", type: "error_resource_not_found" });
        if (rec.entity.type === "business") {
          return send(200, {
            status: "success",
            data: {
              ...rec,
              business_officers: rec.business_officers.map((o) => ({
                ...o,
                person: rec._officerPerson || {
                  id: o.person_id,
                  first_name: "Ada",
                  last_name: "Founder",
                  email: "ada.founder@acme.com",
                  phonenumber: "+2348091234567",
                },
              })),
            },
          });
        }
        return send(200, { status: "success", data: rec });
      }

      // POST /documents
      if (req.method === "POST" && pathname === "/documents") {
        if (store.failNextDocUploadOnce) {
          store.failNextDocUploadOnce = false;
          return send(503, { status: "error", type: "error_system_dependency_unavailable", message: "Temporary upload outage" });
        }
        const doc = { id: ulid("DOC"), ...body };
        store.documents.push(doc);
        return send(201, { status: "success", data: { document: doc } });
      }

      // POST /onboarding-submissions
      if (req.method === "POST" && pathname === "/onboarding-submissions") {
        const rec = store.entities.get(body.entity_id);
        if (!rec) return send(404, { status: "error", type: "error_resource_not_found" });
        if (rec.entity.status !== "incomplete") {
          return send(400, { status: "error", type: "error_entity_status_not_incomplete", message: "Not incomplete" });
        }
        rec.entity.status = "pending";
        return send(200, { status: "success", data: { entity: rec.entity } });
      }

      // Accounts
      if (req.method === "GET" && pathname === "/accounts") {
        const reqEnt = query.entity_id || "ROOT";
        const rows = [...store.accounts.values()].filter(
          (a) => a.entity_id === reqEnt && (!query.currency || a.currency === query.currency)
        );
        return send(200, { status: "success", data: { data: rows } });
      }
      if (req.method === "POST" && pathname === "/accounts") {
        const accId = ulid("ACC");
        const acc = {
          id: accId,
          entity_id: body.entity_id || "ROOT",
          type: body.type || "checking",
          currency: body.currency,
          display_name: body.display_name,
          nuvion_ban: `0020${String(seq).padStart(6, "0")}`,
          status: "active",
          balance: { available: 5000, current: 5000 },
        };
        store.accounts.set(accId, acc);
        return send(201, { status: "success", data: { account: acc } });
      }
      const getAcc = pathname.match(/^\/accounts\/([^/]+)$/);
      if (req.method === "GET" && getAcc) {
        const acc = store.accounts.get(getAcc[1]);
        if (!acc) return send(404, { status: "error", type: "error_resource_not_found" });
        return send(200, { status: "success", data: { account: acc } });
      }

      // Counterparties & Payment Details
      if (req.method === "POST" && pathname === "/counterparties") {
        const cp = { id: ulid("CP"), ...body };
        store.counterparties.set(cp.id, cp);
        return send(201, { status: "success", data: cp });
      }
      if (req.method === "POST" && pathname === "/payment-details") {
        const pd = { id: ulid("PD"), ...body };
        store.paymentDetails.set(pd.id, pd);
        return send(201, { status: "success", data: pd });
      }

      // Card Creation Fee & Card Creation
      const feeMatch = pathname.match(/^\/card-creation-fee\/([^/]+)$/);
      if (req.method === "GET" && feeMatch) {
        const feeMinor = store.cardCreationFeeMinor !== undefined ? store.cardCreationFeeMinor : 50;
        return send(200, { status: "success", data: { fee: feeMinor, currency: "USD" } });
      }
      if (req.method === "GET" && pathname === "/cards") {
        const rows = [...store.cards.values()].filter((c) => !query.account_id || c.account_id === query.account_id);
        return send(200, { status: "success", data: { data: rows } });
      }
      if (req.method === "POST" && (pathname === "/virtual-cards" || pathname === "/disposable-cards")) {
        const card = {
          id: ulid("CRD"),
          account_id: body.account_id,
          name: body.card_name,
          type: pathname.includes("disposable") ? "disposable" : "virtual",
          status: "active",
          last4: "4242",
        };
        store.cards.set(card.id, card);
        return send(201, { status: "success", data: card });
      }

      // FX Quotes
      if (req.method === "POST" && pathname === "/fx-quotes") {
        const from = body.from_currency;
        const to = body.to_currency;
        const rate = (from === "USC" && to === "GBP") ? 0.8 : 1.0;
        let amount_from = body.amount_from;
        let amount_to = body.amount_to;
        if (amount_to != null) {
          amount_from = Math.round(amount_to / rate);
        } else {
          amount_to = Math.round(amount_from * rate);
        }
        return send(201, {
          status: "success",
          data: { id: ulid("FXQ"), from, to, amount_from, amount_to, rate, quote: { status: "active", expires_at: Date.now() + 180000 } },
        });
      }

      // Transfers
      if (req.method === "POST" && pathname === "/transfers") {
        if (body.payment_type === "stablecoin-transfer" && store.failNextStablecoinSweepOnce) {
          store.failNextStablecoinSweepOnce = false;
          return send(503, { status: "error", type: "error_system_dependency_unavailable", message: "Transient Base RPC error" });
        }
        if (store.unloadDelayMs > 0 && String(body.unique_reference || "").startsWith("prx-cunload-")) {
          await new Promise((r) => setTimeout(r, store.unloadDelayMs));
        }
        if (body.unique_reference && store.transfersByRef.has(body.unique_reference)) {
          return send(409, { status: "error", type: "error_duplicate_resource", message: "Duplicate unique_reference" });
        }
        const tx = {
          id: ulid("TXF"),
          entity_id: body.entity_id || "ROOT",
          account_id: body.account_id,
          amount: body.amount,
          currency: body.currency,
          payment_type: body.payment_type,
          unique_reference: body.unique_reference,
          status: "successful",
        };
        store.transfers.set(tx.id, tx);
        if (body.unique_reference) store.transfersByRef.set(body.unique_reference, tx);
        return send(201, { status: "success", data: tx });
      }
      if (req.method === "GET" && pathname === "/transfers") {
        const rows = [...store.transfers.values()].filter(
          (t) => (!query.unique_reference || t.unique_reference === query.unique_reference)
        );
        return send(200, { status: "success", data: { data: rows } });
      }
      const getTx = pathname.match(/^\/transfers\/([^/]+)$/);
      if (req.method === "GET" && getTx) {
        const tx = store.transfers.get(getTx[1]);
        if (!tx) return send(404, { status: "error", type: "error_resource_not_found" });
        return send(200, { status: "success", data: tx });
      }

      return send(404, { status: "error", type: "error_resource_not_found", message: `Unhandled ${req.method} ${pathname}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, store, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// ── TEST 1: Pre-Flight KYC / KYB Production Schema Validation ────────────────

test("Hardening 1: Pre-flight KYC/KYB schema validators catch every 422/500 BEFORE touching API", async () => {
  // 1. Phone strictly 10–14 chars including '+'
  assert.equal(flowsKyc.normalizePhone("08012345678"), "+2348012345678"); // 14 chars -> OK
  assert.equal(flowsKyc.normalizePhone("+14155551234"), "+14155551234"); // 12 chars -> OK
  assert.equal(flowsKyc.normalizePhone("+234801234567890"), null, "16-char phone must be rejected locally (Nuvion max 14)");
  assert.equal(flowsKyc.normalizePhone("+12345678"), null, "9-char phone must be rejected locally (Nuvion min 10)");

  // 2. Website normalization & omission
  assert.equal(flowsKyc.normalizeWebsiteUrl("none"), null);
  assert.equal(flowsKyc.normalizeWebsiteUrl(""), null);
  assert.equal(flowsKyc.normalizeWebsiteUrl("acme.ng"), "https://acme.ng");
  assert.equal(flowsKyc.normalizeWebsiteUrl("not a url"), undefined);

  // 3. Individual schema validator catches missing NG BVN/NIN, expired ID, short line_1, invalid phone
  assert.throws(
    () => nuvion.validateIndividualEntityPayload({
      name: "Test User",
      person: {
        first_name: "Test",
        last_name: "User",
        date_of_birth: "1995-05-05",
        email: "t@example.com",
        nationality: "NG",
        gender: "m",
        phonenumber: "+2348012345678",
        // Missing BVN & NIN for NG!
      },
    }),
    (err) => err instanceof nuvion.NuvionError && err.status === 422 && /BVN/i.test(err.message)
  );

  assert.throws(
    () => nuvion.validateIndividualEntityPayload({
      name: "Expired ID User",
      person: {
        first_name: "Jane",
        last_name: "Doe",
        date_of_birth: "1995-05-05",
        email: "jane@example.com",
        nationality: "GB",
        gender: "f",
        phonenumber: "+447700900123",
      },
      address: { line_1: "10 Downing Street", city: "London", state: "London", postal_code: "SW1A", country_code: "GB" },
      identification: {
        document: {
          type: "international_passport",
          number: "P12345678",
          issue_date: "2015-01-01",
          expiry_date: "2020-01-01", // EXPIRED!
          issuing_country: "GB",
        },
      },
    }),
    (err) => err instanceof nuvion.NuvionError && err.status === 422 && /expired/i.test(err.message)
  );

  // 4. Business schema validator catches empty business_officers (prevents Nuvion 500!) & invalid website
  assert.throws(
    () => nuvion.validateBusinessEntityPayload({
      name: "Acme Ltd",
      business: {
        legal_name: "Acme Ltd",
        industry: "Technology",
        email: "ops@acme.com",
        type: "llc",
        description: "Payments",
        registration_number: "RC12345",
        incorporation_meta: { year: 2022, month: 6, country: "NG", state: "Lagos" },
      },
      business_officers: [], // Nuvion returns 500 on empty array!
    }),
    (err) => err instanceof nuvion.NuvionError && err.status === 422 && /business_officers/i.test(err.message)
  );

  // 5. uploadDocument rejects unsupported MIME type locally before HTTP
  await assert.rejects(
    () => nuvion.uploadDocument({
      entityId: "01ENT",
      key: "identity",
      description: "ID",
      fileBase64: "AAAA",
      fileType: "image/webp",
    }),
    (err) => err instanceof nuvion.NuvionError && err.status === 422 && err.type === "error_validation_value_not_supported"
  );

  // 6. Chat upload handler rejects JPEG for Business COI (requires PDF)
  const tgId = 888001;
  convState.setState(tgId, "nuvion_kyb_doc_coi", { accountType: "business" }, "business");
  const replies = [];
  await flowsKyc.handleNuvionKycMediaUpload(
    { from: { id: tgId }, reply: async (t) => replies.push(t) },
    { fileId: "bad_jpg_coi", mimeType: "image/jpeg" }
  );
  assert.ok(replies[replies.length - 1].includes("Unsupported file format"), "COI must reject JPEG and demand PDF");
  assert.equal(convState.getState(tgId).type, "nuvion_kyb_doc_coi", "Step must not advance on invalid MIME");
  convState.clearState(tgId);
});

// ── TEST 2: Business KYB Officer person_id Extraction, Personal->Business Reuse & Retry Idempotency ─

test("Hardening 2: Business KYB extracts business_officers[0].person_id, reuses Personal person_id (no 409), omits empty website, and reuses incomplete entity on retry", async () => {
  const mock = await startStrictSpecMockServer();
  process.env.NUVION_BASE_URL = mock.baseUrl;

  try {
    const tgId = 888001;
    const perWallet = walletLib.generateUserWallet();
    const bizWallet = walletLib.generateUserWallet();
    db.createUserWithWallet(tgId, "founder_user", perWallet.address, perWallet.privateKey, "1234");
    db.addBusinessWallet(tgId, bizWallet.address, bizWallet.privateKey, "1234");

    // Seed an existing Personal Nuvion entity with matching founder email (`ada.founder@acme.com`)
    const personalCreated = await nuvion.createIndividualEntity({
      name: "Ada Founder",
      person: {
        first_name: "Ada",
        last_name: "Founder",
        date_of_birth: "1992-05-10",
        email: "ada.founder@acme.com",
        nationality: "NG",
        gender: "f",
        phonenumber: "+2348091234567",
        bvn: "22233344455",
        nin: "99887766554",
      },
      address: { line_1: "14 Admiralty Way", city: "Lagos", state: "Lagos", postal_code: "106104", country_code: "NG" },
    }, { validate: true });

    db.upsertNuvionEntity({
      telegramId: tgId,
      accountType: "personal",
      entityId: personalCreated.entity.id,
      entityType: "individual",
      personId: personalCreated.person.id,
      legalName: "Ada Founder",
      email: "ada.founder@acme.com",
      status: "approved",
    });

    // Save Business KYB draft with SAME officer email + omitted website
    db.saveNuvionKycDraft(tgId, "business", "nuvion_kyb_review", {
      legal_name: "Acme Global Ltd",
      trade_name: "Acme Global",
      business_type: "llc",
      registration_number: "RC9988776",
      tax_id: "10293847-0001",
      industry: "Technology",
      incorp_year: 2023,
      incorp_month: 5,
      incorp_country: "NG",
      incorp_state: "Lagos",
      business_email: "finance@acme.com",
      business_phone: "+2348091234568",
      business_website: null, // omitted -> must NOT send fake website!
      biz_line_1: "14 Admiralty Way, Lekki",
      biz_city: "Lagos",
      biz_state: "Lagos",
      biz_postal_code: "106104",
      biz_country_code: "NG",
      officer_first_name: "Ada",
      officer_last_name: "Founder",
      officer_job_title: "CEO",
      officer_ownership: 100,
      officer_email: "ada.founder@acme.com", // matches Personal entity!
      officer_phone: "+2348091234567",
      officer_dob: "1992-05-10",
      officer_nationality: "NG",
      officer_gender: "f",
      officer_id_type: "international_passport",
      officer_id_number: "A09876543",
      officer_id_issue_date: "2022-01-01",
      officer_id_expiry_date: "2032-01-01",
      officer_bvn: "22233344455",
      officer_nin: "99887766554",
      doc_coi: { fileId: "f_coi", mimeType: "application/pdf" },
      doc_memart: { fileId: "f_memart", mimeType: "application/pdf" },
      doc_poa: { fileId: "f_biz_poa", mimeType: "application/pdf" },
      doc_officer_id: { fileId: "f_off_id", mimeType: "image/jpeg" },
      doc_officer_poa: { fileId: "f_off_poa", mimeType: "application/pdf" },
    });

    const fakeBot = { command: () => {}, action: () => {} };
    flowsKyc.registerNuvionKycFlows(fakeBot, {
      downloadTelegramFile: async (_ctx, fileId) => Buffer.from(`bytes-${fileId}`),
      backToMenu: {},
    });

    const replies = [];
    const ctx = { from: { id: tgId }, reply: async (t) => replies.push(t) };

    // Simulate transient upload failure on Attempt 1 -> entity is saved locally as `incomplete`
    mock.store.failNextDocUploadOnce = true;
    await flowsKyc.executeBusinessKybSubmission(ctx, tgId);

    const bizReqsAfter1 = mock.store.requests.filter((r) => r.method === "POST" && r.pathname === "/business-entities");
    assert.equal(bizReqsAfter1.length, 1, "Attempt 1 must create business entity once");
    assert.equal(bizReqsAfter1[0].body.business.website, undefined, "Omitted website must NOT be sent");
    assert.equal(
      bizReqsAfter1[0].body.business_officers[0].person_id,
      personalCreated.person.id,
      "Must link existing Personal person_id to prevent 409 duplicate person collision!"
    );
    assert.equal(bizReqsAfter1[0].body.business_officers[0].person, undefined);

    // Attempt 2 (Retry): MUST reuse existing `incomplete` entity (NO second POST /business-entities!)
    await flowsKyc.executeBusinessKybSubmission(ctx, tgId);
    const bizReqsAfter2 = mock.store.requests.filter((r) => r.method === "POST" && r.pathname === "/business-entities");
    assert.equal(bizReqsAfter2.length, 1, "Retry must reuse existing incomplete entity instead of calling POST /business-entities again!");

    // Verify officer docs received `link_to_identity.person_id`!
    const officerDocs = mock.store.documents.filter((d) => d.link_to_identity?.person_id === personalCreated.person.id);
    assert.equal(officerDocs.length, 2, "Both Officer ID and Officer POA MUST carry link_to_identity.person_id!");
    assert.equal(db.getNuvionEntityByUser(tgId, "business").status, "pending");
    assert.equal(db.getNuvionKycDraft(tgId, "business"), null, "Business KYB draft wiped on submission");
  } finally {
    mock.server.close();
  }
});

// ── TEST 3: Strict Fund Isolation (Personal vs Business & Multi-User) ────────

test("Hardening 3: Strict Business vs Personal fund isolation — zero silent fallback to personal wallet/key!", async () => {
  const mock = await startStrictSpecMockServer();
  process.env.NUVION_BASE_URL = mock.baseUrl;

  try {
    const tgIdNoBiz = 888002;
    const perW = walletLib.generateUserWallet();
    db.createUserWithWallet(tgIdNoBiz, "personal_only_user", perW.address, perW.privateKey, "1234");
    const user = db.getUser(tgIdNoBiz);

    // 1. db.getSystemDecryptedPrivateKey("business") MUST NOT fall back to personal system key
    assert.throws(
      () => db.getSystemDecryptedPrivateKey(user, "business"),
      /System encrypted key not configured.*business/i
    );

    // 2. payouts.getUserPrivateKey("business") MUST NOT fall back to personal encrypted key
    assert.throws(
      () => payouts.getUserPrivateKey(user, "1234", "business"),
      /Business wallet is not set up/i
    );

    // 3. chains.deriveAddress(..., { strictBusiness: true }) returns null instead of personal address
    assert.equal(chains.deriveAddress(user, "business", "arc", { strictBusiness: true }), null);
    assert.equal(chains.deriveAddress(user, "business", "base", { strictBusiness: true }), null);

    // 4. nuvionWebhooks.bootstrapApprovedEntity() for business REFUSES personal wallet fallback
    const fakeBizEntity = {
      telegram_id: tgIdNoBiz,
      account_type: "business",
      entity_id: "01BIZISOLATIONTEST00000001",
      entity_type: "business",
      legal_name: "Unprovisioned Biz",
      email: "biz@example.com",
      status: "approved",
    };
    await assert.rejects(
      () => nuvionWebhooks.bootstrapApprovedEntity(fakeBizEntity),
      /refusing personal wallet fallback/i
    );

    // 5. evmDepositSweeper aborts immediately if signer address != target deposit address!
    const otherWallet = walletLib.generateUserWallet();
    const sweepRes = await evmSweeper.processEvmDeposit(
      { chainId: 8453, to: perW.address, token: "USDC", amount: "25", txHash: "0xmismatch_test_tx" },
      null,
      { silent: true, overridePrivateKey: otherWallet.privateKey }
    );
    assert.equal(sweepRes.success, false);
    assert.match(sweepRes.error, /Wallet signer mismatch/i);
  } finally {
    mock.server.close();
  }
});

// ── TEST 4: Concurrent Payout + Card Load USC Matching & Pre-Funding Creation ─

test("Hardening 4: Concurrent $50 Payout + $20.50 Card Load on SAME entity — zero cross-job USC stealing & pre-funding row safety!", async () => {
  const mock = await startStrictSpecMockServer();
  process.env.NUVION_BASE_URL = mock.baseUrl;

  const origUnified = chains.getUnifiedBalance;
  chains.getUnifiedBalance = async () => ({
    arc: { usdc: 500, eurc: 0 },
    base: { usdc: 0 },
    gateway: { usdc: 0 },
    solana: { usdc: 0 },
    total: 500,
  });

  try {
    const tgId = 888001;
    const entity = db.getNuvionEntityByUser(tgId, "personal");
    const uscAcc = await nuvion.createAccount({ entityId: entity.entity_id, currency: "USC", displayName: "USC Bridge" });
    const selfCp = await nuvion.createCounterparty({ entityId: entity.entity_id, type: "individual", nickname: "Self", profile: { first_name: "Ada", last_name: "Founder", email: "ada.founder@acme.com" } });
    const selfPd = await nuvion.createPaymentDetail({ entityId: entity.entity_id, counterparty_id: selfCp.id, payment_method: "stablecoin-transfer", currency: "USC", blockchain_network: "BASE_MAINNET", wallet_address: db.getUser(tgId).deposit_address });
    db.updateNuvionEntity(entity.entity_id, {
      status: "approved",
      usc_account_id: uscAcc.id,
      usc_base_address: "0x555555555555555555555555555555555555BASE",
      self_counterparty_id: selfCp.id,
      self_base_payment_detail_id: selfPd.id,
    });

    // Verify job row exists in SQLite BEFORE fundingExecutor completes (proves zero <500ms Gateway race!)
    let jobExistedDuringFunding = false;
    const payoutInit = await payouts.initiateGlobalPayout({
      telegramId: tgId,
      pin: "1234",
      accountType: "personal",
      railKey: "gbp_fps",
      targetCurrency: "GBP",
      targetAmountMajor: 40, // @ 0.8 rate -> expectedUscMinor = 5000 ($50.00)
      recipientDetails: { account_holder_name: "Jane UK", sort_code: "040004", account_number: "12345678", bank_name: "Barclays" },
      fundingExecutor: async () => {
        const queued = db.getNuvionJobsByState("outbound_fiat_payout", "funding_in_transit").filter((j) => j.entity_id === entity.entity_id);
        jobExistedDuringFunding = queued.length === 1;
        return { route: "circle_gateway", txHash: "0xgw_payout_50" };
      },
    });
    assert.equal(jobExistedDuringFunding, true, "Payout job MUST be persisted BEFORE funds broadcast!");

    // Simultaneously queue a $20.00 Virtual Card (+ $0.50 fee = $20.50 = 2050 minor) on the SAME entity!
    let cardJobExistedDuringFunding = false;
    const cardInit = await cards.initiateCardIssuance({
      telegramId: tgId,
      pin: "1234",
      accountType: "personal",
      cardType: "virtual",
      cardName: "AWS Cloud Card",
      loadAmountUsd: 20,
      fundingExecutor: async () => {
        const queued = db.getNuvionJobsByState("card_issue", "funding_in_transit").filter((j) => j.entity_id === entity.entity_id);
        cardJobExistedDuringFunding = queued.length === 1;
        return { route: "circle_gateway", txHash: "0xgw_card_2050" };
      },
    });
    assert.equal(cardJobExistedDuringFunding, true, "Card job MUST be persisted BEFORE funds broadcast!");

    // Fire $20.50 USC inflow webhook — EVEN THOUGH payout handler runs first, it MUST defer to card_issue!
    const cardInflow = {
      id: "01INFLOW_CARD_2050",
      entity_id: entity.entity_id,
      account_id: uscAcc.id,
      currency: "USC",
      amount: 2050,
      applicable_fee: 0,
      status: "successful",
    };
    mock.store.transfers.set(cardInflow.id, cardInflow);
    await nuvionWebhooks.processNuvionEvent(
      { event: "inflows.completed", data: cardInflow },
      { "x-nuvion-event-id": "evt_usc_card_2050" }
    );

    assert.equal(db.getNuvionJobById(cardInit.job.id).state, "completed", "$20.50 inflow must complete ONLY the $20.50 card job!");
    assert.equal(db.getNuvionJobById(payoutInit.job.id).state, "funding_in_transit", "$50 payout job MUST NOT be stolen by $20.50 card deposit!");

    // Now fire $50.00 USC inflow webhook (omitting data.entity_id to also test entity_id DB fallback!)
    db.upsertNuvionAccount({ entityId: entity.entity_id, accountId: uscAcc.id, currency: "USC", purpose: "usc_bridge" });
    const payoutInflow = {
      id: "01INFLOW_PAYOUT_5000",
      account_id: uscAcc.id, // Intentionally omit entity_id!
      currency: "USC",
      amount: 5000,
      applicable_fee: 0,
      status: "successful",
    };
    mock.store.transfers.set(payoutInflow.id, payoutInflow);
    await nuvionWebhooks.processNuvionEvent(
      { event: "inflows.completed", data: payoutInflow },
      { "x-nuvion-event-id": "evt_usc_payout_5000" }
    );

    assert.equal(db.getNuvionJobById(payoutInit.job.id).state, "dispatched", "$50 inflow must resolve entity via account_id & dispatch payout!");
  } finally {
    chains.getUnifiedBalance = origUnified;
    mock.server.close();
  }
});

// ── TEST 5: Zero Double-Margin on Retry, Atomic Refund Lock, Cardholder Phone & Unload Double-Tap ─

test("Hardening 5: Inbound retry never double-charges 1% margin; atomic refund & card unload double-tap locks; cardholder phonenumber", async () => {
  const mock = await startStrictSpecMockServer();
  process.env.NUVION_BASE_URL = mock.baseUrl;
  orchestrator._clearParentAccountCache();

  try {
    const tgId = 888001;
    const entity = db.getNuvionEntityByUser(tgId, "personal");

    // 1. Inbound $1,000 USD deposit: Step 1 (1% margin = $10) succeeds, Step 2 transiently fails (503)
    const usdAcc = await nuvion.createAccount({ entityId: entity.entity_id, currency: "USD", displayName: "USD Rec" });
    const inflow = {
      id: "01INFLOW_USD_RETRY_TEST",
      entity_id: entity.entity_id,
      account_id: usdAcc.id,
      currency: "USD",
      amount: 100000, // $1,000.00
      applicable_fee: 0,
      payment_type: "bank-transfer",
      status: "successful",
    };

    mock.store.failNextStablecoinSweepOnce = true;
    await assert.rejects(() => orchestrator.handleInboundFiatSweep({ confirmed: inflow, entityRecord: entity }));

    // Retry sweep (as nuvion_poller would): margin book-transfer MUST NOT fire a second time!
    const retryRes = await orchestrator.handleInboundFiatSweep({ confirmed: inflow, entityRecord: entity });
    assert.equal(retryRes.swept, true);
    assert.equal(retryRes.collectedMarginMinor, 1000, "Must preserve exact $10 margin collected on attempt 1");
    assert.equal(retryRes.creditedUsd, 990, "Must sweep exact remaining $990");

    const marginCalls = mock.store.requests.filter(
      (r) => r.method === "POST" && r.pathname === "/transfers" && r.body.unique_reference === `margin-${inflow.id}`
    );
    assert.equal(marginCalls.length, 1, "1% margin transfer MUST fire strictly ONCE across retries!");

    // 2. Atomic outbound refund lock under concurrent webhook + poller race
    const failedJob = db.createNuvionJob({
      entityId: entity.entity_id,
      telegramId: tgId,
      accountType: "personal",
      jobType: "outbound_fiat_payout",
      state: "dispatched",
      currency: "GBP",
      amountMinor: 4000,
      uniqueReference: "prx-out-race-test",
      nuvionTransferId: "01TX_FAIL_RACE",
      payload: { expectedUscMinor: 5000, targetCurrency: "GBP", targetAmountMajor: 40, recipientName: "Race Test" },
    });
    const [r1, r2] = await Promise.all([
      payouts.handleOutboundPayoutFailed({ confirmed: { id: "01TX_FAIL_RACE", amount: 5000, status: "failed" }, entityRecord: entity }),
      payouts.handleOutboundPayoutFailed({ confirmed: { id: "01TX_FAIL_RACE", amount: 5000, status: "failed" }, entityRecord: entity }),
    ]);
    assert.equal([r1.refunded, r2.refunded].filter(Boolean).length, 1, "Concurrent refund handlers must refund EXACTLY ONCE!");
    assert.equal(db.getNuvionJobById(failedJob.id).state, "refunded");

    // 3. Double-tap card unload guard
    const cardAcc = await nuvion.createAccount({ entityId: entity.entity_id, currency: "USD", displayName: "Card Sub" });
    db.upsertNuvionCard({
      entityId: entity.entity_id,
      accountId: cardAcc.id,
      cardId: "01CARD_UNLOAD_LOCK",
      cardType: "virtual",
      cardName: "Unload Lock Card",
      currency: "USD",
      last4: "9999",
      status: "active",
    });
    mock.store.unloadDelayMs = 150;
    const [u1, u2] = await Promise.all([
      cards.unloadCardToMainWallet({ telegramId: tgId, accountType: "personal", cardId: "01CARD_UNLOAD_LOCK" }),
      cards.unloadCardToMainWallet({ telegramId: tgId, accountType: "personal", cardId: "01CARD_UNLOAD_LOCK" }),
    ]);
    mock.store.unloadDelayMs = 0;
    assert.equal([u1.unloaded, u2.unloaded].filter(Boolean).length, 1, "Double-tap card unload must execute EXACTLY ONCE!");
    assert.ok(u1.duplicate || u2.duplicate, "Second concurrent unload must return duplicate: true");

    // 4. resolveCardholder reads real `phonenumber` from Business `business_officers[0].person`
    const bizEntity = db.getNuvionEntityByUser(tgId, "business");
    mock.store.entities.set(bizEntity.entity_id, {
      entity: { id: bizEntity.entity_id, type: "business", status: "approved", name: bizEntity.legal_name },
      business: { id: "01BUSMOCK", legal_name: bizEntity.legal_name, email: "finance@acme.com", phonenumber: "+2348091234568" },
      business_officers: [{ id: "01OFFMOCK", person_id: bizEntity.person_id }],
      _officerPerson: {
        id: bizEntity.person_id,
        first_name: "Ada",
        last_name: "Founder",
        email: "ada.founder@acme.com",
        phonenumber: "+2348091234567",
      },
    });
    const ch = await cards.resolveCardholder(bizEntity);
    assert.equal(ch.phone_number, "+2348091234567", "Must extract real phonenumber from business_officers[0].person");
    assert.ok(!ch.email.endsWith(".local"), "Cardholder email must never use .local domain");
  } finally {
    mock.server.close();
  }
});

// ── TEST 6: Arc (Paj) <-> Base (Nuvion) On-Demand Seamless Settlement ─────────

test("Hardening 6: Nuvion Base deposit -> Paj Arc Off-Ramp auto-sweep AND Split Arc+Base -> Nuvion CCTP auto-consolidation!", async () => {
  const tgId = 888001;
  const user = db.getUser(tgId);
  const perKey = db.decryptPrivateKey("1234", user);
  const userWallet = walletLib.walletFromPrivateKey(perKey);

  const orig = {
    getNativeBalanceMicro: walletLib.getNativeBalanceMicro,
    getUsdcBalance: walletLib.getUsdcBalance,
    sweepUserDeposits: evmSweeper.sweepUserDeposits,
    requestOfframp: offramp.requestOfframp,
    sendFromWallet: walletLib.sendFromWallet,
    sendSponsoredOrDirectTransaction: walletLib.sendSponsoredOrDirectTransaction,
    getUnifiedBalance: chains.getUnifiedBalance,
    executeArcToEvmCctpBurn: cctpBridge.executeArcToEvmCctpBurn,
  };

  let arcUsdc = 0; // Fresh Nuvion deposit is STILL on Base, Arc = $0!
  let baseUsdc = 50;
  let sweepCalls = [];

  walletLib.getNativeBalanceMicro = async () => walletLib.parseToMicro(arcUsdc.toFixed(6));
  walletLib.getUsdcBalance = async (_addr, chain) => (chain === "Base" ? baseUsdc.toFixed(2) : "0");
  evmSweeper.sweepUserDeposits = async (id, _bot, opts) => {
    sweepCalls.push({ id, opts });
    arcUsdc += Math.max(0, baseUsdc - 0.05);
    baseUsdc = 0;
    return [{ success: true, amountUsdc: arcUsdc }];
  };
  offramp.requestOfframp = async () => ({
    success: true,
    reference: "paj_ord_arc_seamless",
    address: "0x1111111111111111111111111111111111111111",
    amount: 20,
    fiatAmount: 30000,
    accountName: "Test Receiver",
    rate: 1500,
    status: "pending",
  });
  walletLib.sendFromWallet = async () => "0xarc_paj_tx_ok";
  walletLib.sendSponsoredOrDirectTransaction = async () => ({ hash: "0xarc_paj_tx_ok" });

  try {
    // 6A: User received $50 via Nuvion (on Base) and immediately taps Paj Cash-Out (on Arc)
    const res = await executor.executeOfframp(
      userWallet,
      20,
      { accountNumber: "0123456789", bankCode: "044", accountName: "Test Receiver", fiatAmount: 30000 },
      tgId,
      "Cash Out",
      { accountType: "personal", rail: "arc", enableBaseAutoSweep: true, idempotencyKey: `hardening_base_to_arc_${Date.now()}` }
    );

    assert.equal(res.success, true, `Expected Paj Arc offramp to succeed via auto Base->Arc sweep, got: ${res.error}`);
    assert.equal(sweepCalls.length, 1, "Must trigger surgical on-demand Base -> Arc sweep");
    assert.equal(sweepCalls[0].opts.onlyChain, "BASE");
    assert.equal(sweepCalls[0].opts.onlyAccountType, "personal");
    assert.equal(sweepCalls[0].opts.silent, true);

    // 6B: Split Arc ($30) + Base ($30) balance -> $50 Nuvion transfer auto-consolidates Base -> Arc & runs Arc->Base CCTP!
    arcUsdc = 30;
    baseUsdc = 30;
    let cctpBurnCalled = null;
    chains.getUnifiedBalance = async () => ({
      arc: { usdc: arcUsdc, eurc: 0 },
      base: { usdc: baseUsdc },
      gateway: { usdc: 0 },
      solana: { usdc: 0 },
      total: arcUsdc + baseUsdc,
    });
    cctpBridge.executeArcToEvmCctpBurn = async (args) => {
      cctpBurnCalled = args;
      return { success: true, txHash: "0xcctp_arc_to_base_ok", messageHash: "0xmsg" };
    };

    const bridgeRes = await payouts.fundNuvionBaseBridge({
      user,
      pin: "1234",
      accountType: "personal",
      nuvionBaseAddress: "0x555555555555555555555555555555555555BASE",
      nuvionCostUsd: 50,
      marginUsd: 0.5,
    });

    assert.equal(bridgeRes.route, "arc_cctp_base", "Must auto-consolidate split Arc+Base and execute Arc->Base CCTP");
    assert.equal(bridgeRes.txHash, "0xcctp_arc_to_base_ok");
    assert.equal(cctpBurnCalled.destinationDomain, 6, "Must burn to Base CCTP domain 6");
    assert.equal(cctpBurnCalled.userWallet.address.toLowerCase(), user.deposit_address.toLowerCase(), "Must sign with user's exact Arc wallet via walletFromPrivateKey!");
  } finally {
    walletLib.getNativeBalanceMicro = orig.getNativeBalanceMicro;
    walletLib.getUsdcBalance = orig.getUsdcBalance;
    evmSweeper.sweepUserDeposits = orig.sweepUserDeposits;
    offramp.requestOfframp = orig.requestOfframp;
    walletLib.sendFromWallet = orig.sendFromWallet;
    walletLib.sendSponsoredOrDirectTransaction = orig.sendSponsoredOrDirectTransaction;
    chains.getUnifiedBalance = orig.getUnifiedBalance;
    cctpBridge.executeArcToEvmCctpBurn = orig.executeArcToEvmCctpBurn;
  }
});

const { verifyTypedData, parseUnits } = require("ethers");
const nuvionHealth = require("../src/nuvion_health");

// ── TEST 7: Zero-ETH Base Gas Architecture (EIP-3009 Signing + Relayer Gas Health) ─

test("Hardening 7: EIP-3009 Base USDC gasless TransferWithAuthorization & Base Relayer ETH health monitor", async () => {
  // 1. Cryptographically verify EIP-3009 TransferWithAuthorization signature for Base Mainnet USDC
  const generated = walletLib.generateUserWallet();
  const userWallet = walletLib.walletFromPrivateKey(generated.privateKey);
  const nuvionBaseDest = "0x5555555555555555555555555555555555555555";

  const auth = await payouts.signBaseUsdcTransferAuthorization({
    userWallet,
    toAddress: nuvionBaseDest,
    amountUsdc: 42.5,
    validForSeconds: 600,
  });

  assert.equal(auth.from.toLowerCase(), generated.address.toLowerCase());
  assert.equal(auth.to.toLowerCase(), nuvionBaseDest.toLowerCase());
  assert.equal(auth.value, 42500000n, "Base USDC must encode 6 decimals");
  assert.ok(auth.nonce.startsWith("0x") && auth.nonce.length === 66, "Nonce must be 32-byte hex");
  assert.ok(auth.validBefore > auth.validAfter);

  const recovered = verifyTypedData(
    payouts.BASE_USDC_EIP3009_DOMAIN,
    payouts.TRANSFER_WITH_AUTH_TYPES,
    {
      from: auth.from,
      to: auth.to,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
    },
    auth.signature
  );
  assert.equal(recovered.toLowerCase(), generated.address.toLowerCase(), "EIP-3009 signature must recover exact user EOA");

  // 2. Verify Base Relayer ETH gas health monitor (healthy & low-balance alert, zero private key leak)
  const origRelayerKey = process.env.RELAYER_PRIVATE_KEY;
  const relW = walletLib.generateUserWallet();
  process.env.RELAYER_PRIVATE_KEY = relW.privateKey;
  try {
    const healthy = await nuvionHealth.getBaseRelayerGasStatus({
      provider: { getBalance: async () => parseUnits("0.02", 18) },
    });
    assert.equal(healthy.configured, true);
    assert.equal(healthy.address.toLowerCase(), relW.address.toLowerCase());
    assert.equal(healthy.ethBalance, 0.02);
    assert.equal(healthy.lowBalance, false);
    assert.equal(healthy.estimatedTxs, 4000);

    const low = await nuvionHealth.getBaseRelayerGasStatus({
      provider: { getBalance: async () => parseUnits("0.001", 18) },
    });
    assert.equal(low.lowBalance, true, "0.001 ETH must trigger lowBalance warning (< 0.005 ETH)");

    const htmlCard = nuvionHealth.formatAdminHealthCard({
      launch: nuvionHealth.getLaunchModeSummary(),
      local: nuvionHealth.getLocalNuvionStats(),
      baseRelayerGas: low,
      apiReachable: true,
      rootAccountsCount: 1,
      primaryWebhook: { id: "01WH", status: "active" },
      recentLogs: { total: 1, succeeded: 1, failed: 0 },
    });
    assert.ok(htmlCard.includes("LOW 0.00100 ETH"), "Admin health card must surface low Base relayer ETH alert");
    assert.ok(!htmlCard.includes(relW.privateKey), "Private key must NEVER appear in health output");
  } finally {
    if (origRelayerKey === undefined) delete process.env.RELAYER_PRIVATE_KEY;
    else process.env.RELAYER_PRIVATE_KEY = origRelayerKey;
  }
});

// ── TEST 8: Proxim Card Issuance Fee ($0 Nuvion Live Fee) + 1% FX Spread Collection ─

test("Hardening 8: Live $0.00 Nuvion card fee + Proxim Card Fee ($1.00 Virtual / $0.50 Disposable) + 1% FX spread collection", async () => {
  const mock = await startStrictSpecMockServer();
  process.env.NUVION_BASE_URL = mock.baseUrl;
  // Simulate live production Nuvion account where GET /card-creation-fee returns { fee: 0, currency: "USD" }
  mock.store.cardCreationFeeMinor = 0;

  const tgId = 888001;
  const user = db.getUser(tgId);
  const origUnified = chains.getUnifiedBalance;
  const origSponsored = walletLib.sendSponsoredOrDirectTransaction;
  const origBurn = cctpBridge.executeArcToEvmCctpBurn;

  let arcFeeCalls = [];
  walletLib.sendSponsoredOrDirectTransaction = async (wallet, to, amountMicro) => {
    arcFeeCalls.push({ from: wallet.address, to, amountMicro: amountMicro.toString() });
    // wallet.sendSponsoredOrDirectTransaction returns { txHash, sponsored } in production!
    return { txHash: `0xarc_fee_tx_${arcFeeCalls.length}`, sponsored: true };
  };
  cctpBridge.executeArcToEvmCctpBurn = async ({ amountUsdc }) => ({
    success: true,
    txHash: `0xcctp_burn_${amountUsdc}`,
    messageHash: "0xmsg_fee_test",
  });
  chains.getUnifiedBalance = async () => ({
    arc: { usdc: 500, eurc: 0 },
    base: { usdc: 0 },
    gateway: { usdc: 0 },
    solana: { usdc: 0 },
    total: 500,
  });

  try {
    // 1. Virtual Card ($25.00 load): Nuvion fee = $0.00, Proxim Virtual Card fee = $1.00, 1% spread = $0.25
    const vQuote = await cards.quoteCardIssuance({
      telegramId: tgId,
      accountType: "personal",
      cardType: "virtual",
      loadAmountUsd: 25,
    });
    assert.equal(vQuote.nuvionCreationFeeUsd, 0, "Live production Nuvion card creation fee is $0.00");
    assert.equal(vQuote.proximCardFeeUsd, 1.0, "Proxim Virtual Card issuance fee defaults to $1.00");
    assert.equal(vQuote.creationFeeUsd, 1.0, "Total card creation fee shown to user = $1.00");
    assert.equal(vQuote.marginUsd, 0.25, "1% FX/load spread on $25 = $0.25");
    assert.equal(vQuote.nuvionNeededUsd, 25.0, "Only $25.00 goes to Nuvion's Base bridge when Nuvion fee is $0.00");
    assert.equal(vQuote.proximRevenueUsd, 1.25, "Proxim collects $1.00 card fee + $0.25 (1% spread) = $1.25");
    assert.equal(vQuote.userTotalUsd, 26.25, "User total = $25.00 load + $1.00 card fee + $0.25 (1% spread) = $26.25");

    // 2. Disposable Card ($20.00 load): Nuvion fee = $0.00, Proxim Disposable Card fee = $0.50, 1% spread = $0.20
    const dQuote = await cards.quoteCardIssuance({
      telegramId: tgId,
      accountType: "personal",
      cardType: "disposable",
      loadAmountUsd: 20,
    });
    assert.equal(dQuote.nuvionCreationFeeUsd, 0);
    assert.equal(dQuote.proximCardFeeUsd, 0.5, "Proxim Disposable Card issuance fee defaults to $0.50");
    assert.equal(dQuote.creationFeeUsd, 0.5);
    assert.equal(dQuote.marginUsd, 0.2);
    assert.equal(dQuote.nuvionNeededUsd, 20.0);
    assert.equal(dQuote.proximRevenueUsd, 0.7);
    assert.equal(dQuote.userTotalUsd, 20.7);

    // 3. Initiate Virtual Card without mock fundingExecutor -> verify fundNuvionBaseBridge sends $25.00 to Nuvion
    //    AND collects $1.25 ($1.00 card fee + $0.25 1% spread) into Proxim's fee wallet with non-null marginTxHash!
    const issued = await cards.initiateCardIssuance({
      telegramId: tgId,
      pin: "1234",
      accountType: "personal",
      cardType: "virtual",
      cardName: "Production Fee Test Card",
      loadAmountUsd: 25,
    });
    assert.equal(issued.nuvionNeededUsd, 25.0);
    assert.equal(issued.proximRevenueUsd, 1.25);
    assert.equal(issued.funding.txHash, "0xcctp_burn_25", "Only $25.00 is bridged to Nuvion Base USC address");
    assert.equal(issued.funding.marginTxHash, "0xarc_fee_tx_1", "marginTxHash MUST capture feeRes.txHash (not null)!");
    assert.equal(arcFeeCalls.length, 1, "Must transfer $1.25 ($1.00 card fee + $0.25 1% spread) to Proxim fee wallet");
    assert.equal(
      arcFeeCalls[0].amountMicro,
      walletLib.parseToMicro("1.250000").toString(),
      "Exact $1.25 collected into Proxim fee wallet"
    );
  } finally {
    chains.getUnifiedBalance = origUnified;
    walletLib.sendSponsoredOrDirectTransaction = origSponsored;
    cctpBridge.executeArcToEvmCctpBurn = origBurn;
    mock.server.close();
  }
});

test.after(() => {
  try { fs.unlinkSync(tmpDbPath); } catch (_) {}
});
