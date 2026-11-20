// tests/nuvion_phase1.test.js
// 100% Offline Unit & Integration Suite for Nuvion Phase 1:
// - Core client (src/nuvion.js): headers, 2-decimal minor units, 1% FX margin, child entity_id scoping, 409 recovery
// - Database tables & CRUD (src/db.js): nuvion_entities, drafts, accounts, details, counterparties, cards, jobs
// - Webhook server & HMAC-SHA256 verification (src/nuvion_webhooks.js + src/webhook_server.js)
// - Automatic Base (BASE_MAINNET / base) pass-through bridge bootstrap on entities.updated -> approved
// - Step-by-step Telegram Personal KYC chat wizard (src/flows_nuvion_kyc.js) + NUVION_BETA_IDS gate
// ZERO calls are made to live https://api.nuvion.co!

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// Isolate SQLite DB before requiring project modules
const tmpDbPath = path.join(os.tmpdir(), `test_nuvion_phase1_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = tmpDbPath;
process.env.NODE_ENV = "test";
process.env.NUVION_ENV = "sandbox";
process.env.NUVION_API_KEY = "nv_live_test_owner_key_offline";
process.env.NUVION_WEBHOOK_SECRET = "nv_wsk_test_secret_1234567890";
process.env.NUVION_FX_MARGIN_BPS = "100";
process.env.NUVION_BETA_IDS = "777000111";
process.env.NUVION_PUBLIC_LAUNCH = "false";

const db = require("../src/db");
const nuvion = require("../src/nuvion");
const nuvionWebhooks = require("../src/nuvion_webhooks");
const flowsNuvionKyc = require("../src/flows_nuvion_kyc");
const webhookServer = require("../src/webhook_server");
const convState = require("../src/conversation_state");
const walletLib = require("../src/wallet");
convState.initStateTable();

// ── Local Mock Nuvion HTTP Server (2026-02-06 spec) ───────────────────────────

function startMockNuvionServer() {
  const store = {
    entities: new Map(),
    documents: [],
    accounts: new Map(),
    accountDetails: new Map(),
    counterparties: new Map(),
    paymentDetails: new Map(),
    fxQuotes: new Map(),
    transfers: new Map(),
    fundingSessions: new Map(),
    requests: [],
  };

  let idSeq = 1;
  const ulid = (prefix) => `01MOCK${prefix}${String(idSeq++).padStart(16, "0")}`.slice(0, 26);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : {};
      const parsed = new URL(req.url, "http://127.0.0.1");
      const pathname = parsed.pathname;
      const query = Object.fromEntries(parsed.searchParams.entries());

      store.requests.push({ method: req.method, pathname, query, body, headers: req.headers });

      const send = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json", "X-Request-ID": `req_${idSeq++}` });
        res.end(JSON.stringify(obj));
      };

      // Check auth header
      if (req.headers.authorization !== `Bearer ${process.env.NUVION_API_KEY}`) {
        return send(401, { status: "error", type: "error_auth_credentials_invalid", message: "Invalid key" });
      }
      if (req.headers["x-api-version"] !== "2026-02-06") {
        return send(400, { status: "error", type: "error_auth_api_version_not_supported", message: "Wrong version" });
      }

      // POST /individual-entities
      if (req.method === "POST" && pathname === "/individual-entities") {
        const email = String(body.person?.email || "").toLowerCase();
        for (const ent of store.entities.values()) {
          if ((ent.person?.email || "").toLowerCase() === email) {
            return send(409, { status: "error", type: "error_duplicate_resource", message: "Email already exists" });
          }
        }
        const entityId = ulid("ENT");
        const personId = ulid("PER");
        const record = {
          entity: { id: entityId, type: "individual", status: "incomplete", name: body.name, person_id: personId, is_root: false },
          person: { id: personId, ...body.person },
          address: body.address,
        };
        store.entities.set(entityId, record);
        return send(201, { status: "success", data: record });
      }

      // GET /entities
      if (req.method === "GET" && pathname === "/entities") {
        const nameFilter = (query.name || "").toLowerCase();
        const rows = [...store.entities.values()]
          .map((e) => e.entity)
          .filter((e) => (!query.type || e.type === query.type) && (!nameFilter || e.name.toLowerCase().includes(nameFilter)));
        return send(200, { status: "success", data: { data: rows, meta: { pagination: { has_next: false } } } });
      }

      // GET /entities/{id}
      const getEnt = pathname.match(/^\/entities\/([^/]+)$/);
      if (req.method === "GET" && getEnt) {
        const found = store.entities.get(getEnt[1]);
        if (!found) return send(404, { status: "error", type: "error_resource_not_found", message: "Entity not found" });
        return send(200, { status: "success", data: found });
      }

      // POST /documents
      if (req.method === "POST" && pathname === "/documents") {
        const doc = { id: ulid("DOC"), ...body };
        store.documents.push(doc);
        return send(201, { status: "success", data: doc });
      }

      // POST /onboarding-submissions
      if (req.method === "POST" && pathname === "/onboarding-submissions") {
        const found = store.entities.get(body.entity_id);
        if (!found) return send(404, { status: "error", type: "error_resource_not_found", message: "Entity not found" });
        found.entity.status = "pending";
        return send(201, { status: "success", data: { entity_id: body.entity_id, status: "pending" } });
      }

      // POST /accounts
      if (req.method === "POST" && pathname === "/accounts") {
        const accId = ulid("ACC");
        const acc = {
          id: accId,
          entity_id: body.entity_id || "ROOT",
          type: body.type || "checking",
          currency: body.currency,
          display_name: body.display_name,
          nuvion_ban: `0010${String(idSeq).padStart(6, "0")}`,
          status: "active",
          balance: { available: 0, current: 0, overdraft_used: 0 },
        };
        store.accounts.set(accId, acc);
        return send(201, { status: "success", data: { account: acc } });
      }

      // GET /accounts
      if (req.method === "GET" && pathname === "/accounts") {
        const reqEntity = query.entity_id || "ROOT";
        const rows = [...store.accounts.values()].filter(
          (a) => a.entity_id === reqEntity && (!query.currency || a.currency === query.currency)
        );
        return send(200, { status: "success", data: { data: rows, meta: { pagination: { has_next: false } } } });
      }

      // GET /accounts/{id}
      const getAcc = pathname.match(/^\/accounts\/([^/]+)$/);
      if (req.method === "GET" && getAcc) {
        const acc = store.accounts.get(getAcc[1]);
        const reqEntity = query.entity_id || "ROOT";
        if (!acc || acc.entity_id !== reqEntity) {
          return send(404, { status: "error", type: "error_resource_not_found", message: "Account not found" });
        }
        return send(200, { status: "success", data: { account: acc } });
      }

      // POST /account-details
      if (req.method === "POST" && pathname === "/account-details") {
        const acc = store.accounts.get(body.account_id);
        const reqEntity = body.entity_id || "ROOT";
        if (!acc || acc.entity_id !== reqEntity) {
          return send(404, { status: "error", type: "error_resource_not_found", message: "Account not found" });
        }
        const detailId = ulid("DET");
        const isStable = body.chain || acc.currency === "USC" || acc.currency === "UST";
        const detail = {
          id: detailId,
          entity_id: reqEntity,
          account_id: acc.id,
          asset_type: isStable ? "stablecoin" : "fiat",
          currency: acc.currency,
          chain: body.chain || null,
          account_number: isStable ? "0x444444444444444444444444444444444444BASE" : "0098765432",
          beneficiary_name: "Test User",
          status: isStable ? "active" : "pending",
          issuer: { name: isStable ? "BASE_MAINNET" : "Mock Bank", code: "040004", meta: { routing_number: "026009593" } },
        };
        store.accountDetails.set(detailId, detail);
        return send(201, { status: "success", data: { account_details: detail } });
      }

      // GET /account-details
      if (req.method === "GET" && pathname === "/account-details") {
        const reqEntity = query.entity_id || "ROOT";
        const rows = [...store.accountDetails.values()].filter(
          (d) => d.entity_id === reqEntity && (!query.account_id || d.account_id === query.account_id)
        );
        return send(200, { status: "success", data: { data: rows, meta: { pagination: { has_next: false } } } });
      }

      // GET /account-details/{id} — Nuvion singular `account_detail` quirk!
      const getDet = pathname.match(/^\/account-details\/([^/]+)$/);
      if (req.method === "GET" && getDet) {
        const det = store.accountDetails.get(getDet[1]);
        const reqEntity = query.entity_id || "ROOT";
        if (!det || det.entity_id !== reqEntity) {
          return send(404, { status: "error", type: "error_resource_not_found", message: "Account detail not found" });
        }
        return send(200, { status: "success", data: { account_detail: det } });
      }

      // POST /counterparties
      if (req.method === "POST" && pathname === "/counterparties") {
        const cpId = ulid("CP");
        const cp = { id: cpId, entity_id: body.entity_id || "ROOT", type: body.type, nickname: body.nickname, profile: body.profile };
        store.counterparties.set(cpId, cp);
        return send(201, { status: "success", data: cp });
      }

      // POST /payment-details
      if (req.method === "POST" && pathname === "/payment-details") {
        const pdId = ulid("PD");
        const pd = { id: pdId, ...body };
        store.paymentDetails.set(pdId, pd);
        return send(201, { status: "success", data: pd });
      }

      // POST /fx-quotes
      if (req.method === "POST" && pathname === "/fx-quotes") {
        const qId = ulid("FX");
        const quote = {
          id: qId,
          from: body.from_currency,
          to: body.to_currency,
          amount_from: body.amount_from || 10000,
          amount_to: body.amount_to || 14500000,
          rate: 1450,
          quote: { status: "active", expires_at: Date.now() + 180000, valid_for: 180, used_at: null, used_in_payment_id: null },
        };
        store.fxQuotes.set(qId, quote);
        return send(201, { status: "success", data: quote });
      }

      // PATCH & GET /funding-sessions/{id} (test Interac terminal fallback)
      const fsMatch = pathname.match(/^\/funding-sessions\/([^/]+)$/);
      if (fsMatch) {
        const sess = store.fundingSessions.get(fsMatch[1]);
        if (!sess) return send(404, { status: "error", type: "error_resource_not_found", message: "Not found" });
        if (req.method === "PATCH") {
          if (sess.status === "settled" || sess.status === "failed") {
            return send(400, { status: "error", type: "error_funding_request_not_pending", message: "Session already final" });
          }
          sess.status = "processing";
          return send(201, { status: "success", data: sess });
        }
        if (req.method === "GET") {
          return send(200, { status: "success", data: sess });
        }
      }

      return send(404, { status: "error", type: "error_resource_not_found", message: `Unhandled mock route ${req.method} ${pathname}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, store, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function signNuvionPayload(rawBody, secret, timestamp = new Date().toISOString()) {
  const sig = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return {
    "x-nuvion-event-id": `evt_${crypto.randomBytes(8).toString("hex")}`,
    "x-nuvion-event-timestamp": timestamp,
    "x-nuvion-event-signature": sig,
  };
}

test("Nuvion Phase 1: Minor units, 1% FX margin, and Beta Gate", () => {
  assert.equal(nuvion.toNuvionMinor(100), 10000);
  assert.equal(nuvion.toNuvionMinor(12.34), 1234);
  assert.equal(nuvion.fromNuvionMinor(1234), 12.34);

  // 1% (100 bps) FX margin
  assert.equal(nuvion.getFxMarginBps(), 100);
  assert.equal(nuvion.calcMarginMinor(100000), 1000); // 1% of 1000.00 = 10.00

  // Beta Gate
  assert.equal(nuvion.isUserAllowedNuvion(777000111), true, "Beta user ID must be allowed");
  assert.equal(nuvion.isUserAllowedNuvion(111222333), false, "Regular non-beta user must be gated off");

  // Phone normalization & validators
  assert.equal(flowsNuvionKyc.normalizePhone("08012345678"), "+2348012345678");
  assert.equal(flowsNuvionKyc.normalizePhone("+447700900123"), "+447700900123");
  assert.equal(flowsNuvionKyc.isAdultDob("1992-05-10"), true);
  assert.equal(flowsNuvionKyc.isAdultDob("2020-01-01"), false);
  assert.equal(flowsNuvionKyc.maskSecret("22233344455"), "*******4455");
});

test("Nuvion Phase 1: Client headers, child entity_id scoping, 409 recovery, and API quirks", async () => {
  const mock = await startMockNuvionServer();
  process.env.NUVION_BASE_URL = mock.baseUrl;

  try {
    // 1. Create individual entity
    const created = await nuvion.createIndividualEntity({
      name: "Ada Obi",
      person: { first_name: "Ada", last_name: "Obi", email: "ada.obi@example.com", nationality: "NG" },
      address: { line_1: "10 Lekki Way", city: "Lagos", state: "Lagos", postal_code: "106104", country_code: "NG" },
    });
    const entityId = created.entity.id;
    assert.ok(entityId.startsWith("01MOCK"));

    // Verify pinned API version header was sent
    const lastReq = mock.store.requests[mock.store.requests.length - 1];
    assert.equal(lastReq.headers["x-api-version"], "2026-02-06");

    // 2. Duplicate email returns 409 and recoverEntityByName finds it cleanly
    await assert.rejects(
      () => nuvion.createIndividualEntity({ name: "Ada Obi", person: { first_name: "Ada", last_name: "Obi", email: "ADA.OBI@example.com" } }),
      (err) => err instanceof nuvion.NuvionError && err.status === 409 && err.type === "error_duplicate_resource"
    );
    const recovered = await nuvion.recoverEntityByName({ name: "Ada Obi", type: "individual", email: "ada.obi@example.com" });
    assert.equal(recovered.entity.id, entityId);

    // 3. Child entity_id scoping enforced on POST & GET
    const acc = await nuvion.createAccount({ entityId, currency: "USD", displayName: "Ada USD" });
    assert.equal(acc.entity_id, entityId);

    // Calling getAccount WITHOUT entityId fails 404 (matches real Nuvion behavior!)
    await assert.rejects(
      () => nuvion.getAccount(acc.id),
      (err) => err instanceof nuvion.NuvionError && err.status === 404
    );
    // Calling getAccount WITH entityId succeeds!
    const fetchedAcc = await nuvion.getAccount(acc.id, entityId);
    assert.equal(fetchedAcc.id, acc.id);

    // 4. Account details singular `account_detail` quirk + list limit=100
    const createdDet = await nuvion.createAccountDetails({ accountId: acc.id, entityId });
    const fetchedDet = await nuvion.getAccountDetails(createdDet.id, entityId);
    assert.equal(fetchedDet.id, createdDet.id);
    await nuvion.listAccountDetails({ accountId: acc.id, entityId });
    const listDetReq = mock.store.requests[mock.store.requests.length - 1];
    assert.equal(listDetReq.query.limit, "100");
    assert.equal(listDetReq.query.entity_id, entityId);

    // 5. FX quote validation & creation
    await assert.rejects(() => nuvion.createFxQuote({ fromCurrency: "USD", toCurrency: "USD", amountFrom: 1000 }));
    await assert.rejects(() => nuvion.createFxQuote({ fromCurrency: "USD", toCurrency: "NGN", amountFrom: 1000, amountTo: 1000 }));
    const fxq = await nuvion.createFxQuote({ entityId, fromCurrency: "USC", toCurrency: "NGN", amountTo: 5000000 });
    assert.equal(fxq.from, "USC");
    assert.equal(fxq.to, "NGN");

    // 6. Interac PATCH fallback to GET when already settled
    mock.store.fundingSessions.set("01INTERACSETTLED", { id: "01INTERACSETTLED", status: "settled", amount: 10000 });
    const sess = await nuvion.refreshInteracSession("01INTERACSETTLED", entityId);
    assert.equal(sess.status, "settled");
  } finally {
    mock.server.close();
  }
});

test("Nuvion Phase 1: HMAC Webhook Verification, Immediate 200 OK, and Base Bridge Bootstrap", async () => {
  const mock = await startMockNuvionServer();
  process.env.NUVION_BASE_URL = mock.baseUrl;

  try {
    // Provision real Proxim user in isolated DB
    const tgId = 777000111;
    const generated = walletLib.generateUserWallet();
    db.createUserWithWallet(tgId, "beta_founder", generated.address, generated.privateKey, "1234");

    // Create entity on mock Nuvion + record locally as pending
    const created = await nuvion.createIndividualEntity({
      name: "Beta Founder",
      person: { first_name: "Beta", last_name: "Founder", email: "beta.founder@example.com", nationality: "NG" },
      address: { line_1: "1 Victoria Island", city: "Lagos", state: "Lagos", postal_code: "101241", country_code: "NG" },
    });
    const entityId = created.entity.id;
    db.upsertNuvionEntity({
      telegramId: tgId,
      accountType: "personal",
      entityId,
      entityType: "individual",
      personId: created.person.id,
      legalName: "Beta Founder",
      email: "beta.founder@example.com",
      status: "pending",
    });

    // Flip entity to approved on mock server (simulates compliance approval)
    mock.store.entities.get(entityId).entity.status = "approved";

    const sentTelegramMessages = [];
    const fakeBot = {
      telegram: {
        sendMessage: async (chatId, text) => {
          sentTelegramMessages.push({ chatId, text });
        },
      },
    };

    // 1. Mount webhook server on ephemeral port & test /webhook/nuvion HTTP security
    const whServer = webhookServer.createWebhookServer({ bot: fakeBot });
    await new Promise((r) => whServer.listen(0, "127.0.0.1", r));
    const whPort = whServer.address().port;

    try {
      const eventPayload = JSON.stringify({
        event: "entities.updated",
        data: { id: entityId, type: "individual", status: "approved", name: "Beta Founder" },
      });

      // 1A. Tampered / invalid signature must be rejected with 401
      const badRes = await fetch(`http://127.0.0.1:${whPort}/webhook/nuvion`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-nuvion-event-id": "evt_bad_sig",
          "x-nuvion-event-timestamp": new Date().toISOString(),
          "x-nuvion-event-signature": "0000000000000000000000000000000000000000000000000000000000000000",
        },
        body: eventPayload,
      });
      assert.equal(badRes.status, 401, "Invalid HMAC signature must return 401");

      // 1B. Valid HMAC signature returns immediate 200 OK & bootstraps Base bridge
      const validHeaders = signNuvionPayload(eventPayload, process.env.NUVION_WEBHOOK_SECRET);
      const okRes = await fetch(`http://127.0.0.1:${whPort}/webhook/nuvion`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...validHeaders },
        body: eventPayload,
      });
      assert.equal(okRes.status, 200, "Valid HMAC webhook must return immediate 200 OK");

      // Wait briefly for setImmediate async webhook processing
      await new Promise((r) => setTimeout(r, 250));

      const updated = db.getNuvionEntityByEntityId(entityId);
      assert.equal(updated.status, "approved");
      assert.ok(updated.usc_account_id, "Must provision Nuvion USC bridge account");
      assert.equal(updated.usc_base_address, "0x444444444444444444444444444444444444BASE", "Must provision Base deposit address");
      assert.ok(updated.self_counterparty_id, "Must create self-counterparty");
      assert.ok(updated.self_base_payment_detail_id, "Must register user 0x address on BASE_MAINNET");

      // Verify Base self payment detail points to user's own 0x EOA (NEVER Circle GatewayWallet!)
      const selfPd = mock.store.paymentDetails.get(updated.self_base_payment_detail_id);
      assert.equal(selfPd.blockchain_network, "BASE_MAINNET");
      assert.equal(selfPd.wallet_address, generated.address);
      assert.notEqual(selfPd.wallet_address.toLowerCase(), nuvionWebhooks.CIRCLE_GATEWAY_WALLET_ADDRESS.toLowerCase());

      // Verify user got Telegram approval message
      assert.ok(sentTelegramMessages.some((m) => m.chatId === tgId && m.text.includes("Tier-1 Verification Approved")));

      // 1C. Duplicate delivery of same x-nuvion-event-id is ignored
      const dupRes = await nuvionWebhooks.processNuvionEvent(JSON.parse(eventPayload), validHeaders, fakeBot);
      assert.equal(dupRes.duplicate, true);

      // 1D. Test webhook delivery ({ webhook_id }) handled cleanly
      const testEvtRes = await nuvionWebhooks.processNuvionEvent(
        { event: "inflows.completed", data: { webhook_id: "01TESTWH" } },
        {},
        fakeBot
      );
      assert.equal(testEvtRes.testEvent, true);

      // 1E. account_details.updated (fiat active) saves coordinates and alerts user
      const usdAcc = await nuvion.createAccount({ entityId, currency: "USD", displayName: "Beta USD" });
      const usdDet = await nuvion.createAccountDetails({ accountId: usdAcc.id, entityId });
      mock.store.accountDetails.get(usdDet.id).status = "active";

      const detEvt = await nuvionWebhooks.processNuvionEvent(
        { event: "account_details.updated", data: { id: usdDet.id, entity_id: entityId, account_id: usdAcc.id, status: "active" } },
        { "x-nuvion-event-id": "evt_usd_det_active" },
        fakeBot
      );
      assert.equal(detEvt.status, "active");
      const cachedDetails = db.getNuvionAccountDetailsByEntity(entityId, "USD");
      assert.equal(cachedDetails.length, 1);
      assert.equal(cachedDetails[0].routing_number, "026009593");
      assert.ok(sentTelegramMessages.some((m) => m.chatId === tgId && m.text.includes("USD Bank Account Is Ready")));
    } finally {
      whServer.close();
    }
  } finally {
    mock.server.close();
  }
});

test("Nuvion Phase 1: Step-by-Step Telegram Personal KYC Chat Wizard (End-to-End)", async () => {
  const mock = await startMockNuvionServer();
  process.env.NUVION_BASE_URL = mock.baseUrl;

  try {
    const betaUserId = 777000111;
    const actions = new Map();
    const commands = new Map();
    const fakeBot = {
      command: (names, fn) => {
        for (const n of Array.isArray(names) ? names : [names]) commands.set(n, fn);
      },
      action: (pattern, fn) => actions.set(pattern, fn),
    };

    let deletedCount = 0;
    flowsNuvionKyc.registerNuvionKycFlows(fakeBot, {
      requireUser: (ctx) => db.getUser(ctx.from.id),
      getContext: () => "personal",
      deleteSensitiveMessage: async () => { deletedCount++; },
      downloadTelegramFile: async (_ctx, fileId) => Buffer.from(`fake-bytes-${fileId}`),
      backToMenu: {},
    });

    const replies = [];
    const makeCtx = (userId, match = null) => ({
      from: { id: userId },
      match,
      answerCbQuery: async () => {},
      reply: async (text, extra) => { replies.push({ userId, text, extra }); },
    });

    const triggerAction = async (userId, actionData) => {
      for (const [pat, fn] of actions.entries()) {
        if (typeof pat === "string" && pat === actionData) return fn(makeCtx(userId));
        if (pat instanceof RegExp) {
          const m = actionData.match(pat);
          if (m) return fn(makeCtx(userId, m));
        }
      }
      throw new Error(`No handler for action ${actionData}`);
    };

    // 1. Non-beta user is blocked by Beta Gate
    const nonBetaId = 555666777;
    const w2 = walletLib.generateUserWallet();
    db.createUserWithWallet(nonBetaId, "regular_user", w2.address, w2.privateKey, "1234");
    await commands.get("global")(makeCtx(nonBetaId));
    assert.ok(replies[replies.length - 1].text.includes("private beta"));

    // 2. Beta user runs full step-by-step KYC chat wizard (Nigerian user -> collects BVN & NIN)
    // Clear existing entity from previous test for clean wizard run
    db.prepare("DELETE FROM nuvion_entities WHERE telegram_id = ?").run(betaUserId);

    await triggerAction(betaUserId, "nuvion_kyc_start");
    const sendText = async (txt) => {
      const st = convState.getState(betaUserId);
      const handled = await flowsNuvionKyc.handleNuvionKycTextState(makeCtx(betaUserId), st, txt, betaUserId);
      assert.equal(handled, true, `Expected state ${st?.type} to handle text "${txt}"`);
    };

    await sendText("Chinedu Okafor");
    await sendText("chinedu.wizard@example.com");
    await sendText("08099887766");
    await sendText("1993-08-20");
    await triggerAction(betaUserId, "nuvion_kyc_set_gender_m");
    await triggerAction(betaUserId, "nuvion_kyc_set_nat_NG");
    await sendText("14 Admiralty Way, Lekki Phase 1");
    await sendText("Lagos, Lagos, 106104");
    await sendText("22233344455"); // BVN (auto-deleted)
    await sendText("99887766554"); // NIN (auto-deleted)
    await triggerAction(betaUserId, "nuvion_kyc_set_idtype_international_passport");
    await sendText("A09876543"); // ID number (auto-deleted)
    await sendText("2022-01-10, 2032-01-09");
    await triggerAction(betaUserId, "nuvion_kyc_set_auth_NIS");

    // Upload ID Front & Proof of Address directly in chat
    assert.equal(await flowsNuvionKyc.handleNuvionKycMediaUpload(makeCtx(betaUserId), { fileId: "tg_id_front_1", mimeType: "image/jpeg" }), true);
    assert.equal(await flowsNuvionKyc.handleNuvionKycMediaUpload(makeCtx(betaUserId), { fileId: "tg_poa_1", mimeType: "application/pdf" }), true);

    // Review screen masks secrets & sensitive chat messages were auto-deleted (BVN + NIN + ID# + 2 uploads = 5)
    assert.ok(replies[replies.length - 1].text.includes("*******4455"), "Review screen must mask BVN");
    assert.equal(deletedCount, 5, "All 5 sensitive inputs/uploads must be auto-deleted from Telegram chat");

    // Submit to mock Nuvion server
    await triggerAction(betaUserId, "nuvion_kyc_submit");

    // Verify entity created, 2 documents uploaded, submitted for review, and draft wiped!
    const storedEntity = db.getNuvionEntityByUser(betaUserId, "personal");
    assert.equal(storedEntity.status, "pending");
    assert.equal(storedEntity.email, "chinedu.wizard@example.com");
    assert.equal(mock.store.documents.length, 2, "Must upload identity + proof_of_address docs");
    assert.equal(db.getNuvionKycDraft(betaUserId, "personal"), null, "Sensitive KYC draft must be wiped immediately after submit");
  } finally {
    mock.server.close();
  }
});

test.after(() => {
  try { fs.unlinkSync(tmpDbPath); } catch (_) {}
});
