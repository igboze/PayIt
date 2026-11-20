// tests/nuvion_phase3.test.js
// 100% Offline Integration Suite for Nuvion Phase 3:
// - Coverage of ALL 27 Nuvion Fiat Currencies & ALL 24+ Payout Rails (including CNY Wire, MoMo, SWIFT)
// - Official Nuvion rail min/max limit enforcement
// - End-to-End Outbound Pass-Through Payouts (Live FX Quote + 1% Margin -> Base Bridge Funding
//   -> Automatic Dispatch on USC inflows.completed -> HD Receipt PNG on outflows.completed)
// - Tier-1 NGN NIP (Naira-only receipt, Tier-0 stays Paj v2) + Saved Recipient Reuse
// - Automatic Failure Refund (outflows.failed -> USC auto-fired back to user's 0x Base wallet with fee retry)
// - Business Multi-Currency Global CSV Payroll (GBP + KES MoMo + CNY Wire + JPY SWIFT) + Idempotency
// ZERO calls are made to live https://api.nuvion.co!

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const tmpDbPath = path.join(os.tmpdir(), `test_nuvion_phase3_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = tmpDbPath;
process.env.NODE_ENV = "test";
process.env.NUVION_ENV = "sandbox";
process.env.NUVION_API_KEY = "nv_live_test_phase3_owner";
process.env.NUVION_WEBHOOK_SECRET = "nv_wsk_phase3_secret";
process.env.NUVION_FX_MARGIN_BPS = "100"; // 1.00%
process.env.NUVION_BETA_IDS = "999111222";
process.env.NUVION_PUBLIC_LAUNCH = "false";

const db = require("../src/db");
const nuvion = require("../src/nuvion");
const nuvionWebhooks = require("../src/nuvion_webhooks");
const corridors = require("../src/nuvion_corridors");
const payouts = require("../src/nuvion_payouts");
const poller = require("../src/nuvion_poller");
const chains = require("../src/chains");
const walletLib = require("../src/wallet");
const convState = require("../src/conversation_state");
convState.initStateTable();

function startPhase3MockNuvion() {
  const store = {
    accounts: new Map(),
    accountDetails: new Map(),
    counterparties: new Map(),
    paymentDetails: new Map(),
    fxQuotes: new Map(),
    transfers: new Map(),
    failFirstRefundOnce: false,
  };
  let seq = 1;
  const ulid = (p) => `01P3${p}${String(seq++).padStart(18, "0")}`.slice(0, 26);

  // Indicative 1 USC -> destination fiat rates
  const FROM_USC_RATE = {
    USD: 1.0,
    GBP: 0.78,
    EUR: 0.92,
    CAD: 1.38,
    NGN: 1450.0,
    GHS: 15.2,
    KES: 129.0,
    TZS: 2650.0,
    UGX: 3700.0,
    ZAR: 18.2,
    AED: 3.67,
    AUD: 1.54,
    NZD: 1.68,
    CHF: 0.88,
    JPY: 153.0,
    CNY: 7.24,
    HKD: 7.78,
    SGD: 1.34,
    THB: 34.5,
    PHP: 58.2,
    KRW: 1390.0,
    ILS: 3.72,
    MXN: 20.1,
    BRL: 5.75,
    SEK: 10.8,
    NOK: 11.0,
    DKK: 6.88,
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : {};
      const parsed = new URL(req.url, "http://127.0.0.1");
      const pathname = parsed.pathname;
      const query = Object.fromEntries(parsed.searchParams.entries());
      const send = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      if (req.headers.authorization !== `Bearer ${process.env.NUVION_API_KEY}`) {
        return send(401, { status: "error", type: "error_auth_credentials_invalid", message: "Invalid key" });
      }

      if (req.method === "POST" && pathname === "/accounts") {
        const id = ulid("AC");
        const acc = {
          id,
          entity_id: body.entity_id || "ROOT",
          type: body.type || "checking",
          currency: body.currency,
          display_name: body.display_name,
          nuvion_ban: `0030${String(seq).padStart(6, "0")}`,
          status: "active",
          balance: { available: 0, current: 0, overdraft_used: 0 },
          meta: body.meta || {},
        };
        store.accounts.set(id, acc);
        return send(201, { status: "success", data: { account: acc } });
      }

      if (req.method === "GET" && pathname === "/accounts") {
        const ent = query.entity_id || "ROOT";
        const rows = [...store.accounts.values()].filter(
          (a) => a.entity_id === ent && (!query.currency || a.currency === query.currency)
        );
        return send(200, { status: "success", data: { data: rows } });
      }

      if (req.method === "POST" && pathname === "/account-details") {
        const acc = store.accounts.get(body.account_id);
        const ent = body.entity_id || "ROOT";
        if (!acc || acc.entity_id !== ent) return send(404, { status: "error", type: "error_resource_not_found", message: "Account not found" });
        const id = ulid("AD");
        const isStable = Boolean(body.chain || acc.currency === "USC");
        const det = {
          id,
          entity_id: ent,
          account_id: acc.id,
          asset_type: isStable ? "stablecoin" : "fiat",
          currency: acc.currency,
          chain: body.chain || null,
          account_number: isStable ? `0x7777777777777777777777777777777777${String(seq).padStart(6, "0")}` : `9000${String(seq).padStart(6, "0")}`,
          status: "active",
          beneficiary_name: "Global Founder Ltd",
        };
        store.accountDetails.set(id, det);
        return send(201, { status: "success", data: { account_details: det } });
      }

      if (req.method === "GET" && pathname === "/account-details") {
        const ent = query.entity_id || "ROOT";
        const rows = [...store.accountDetails.values()].filter(
          (d) => d.entity_id === ent && (!query.account_id || d.account_id === query.account_id)
        );
        return send(200, { status: "success", data: { data: rows } });
      }

      if (req.method === "POST" && pathname === "/counterparties") {
        const id = ulid("CP");
        const cp = { id, entity_id: body.entity_id || "ROOT", ...body };
        store.counterparties.set(id, cp);
        return send(201, { status: "success", data: cp });
      }

      if (req.method === "POST" && pathname === "/payment-details") {
        // Validate required routing fields on real-world quirks (USD bank_address, CNY swift_bic)
        if (body.currency === "USD" && ["ach", "wire", "rtp"].includes(body.scheme) && !body.bank_address?.line1) {
          return send(422, { status: "error", type: "error_validation", message: "USD transfers require bank_address" });
        }
        if (body.currency === "CNY" && body.payment_method === "bank-transfer" && (!body.swift_bic || !body.account_number || !body.bank_name)) {
          return send(422, { status: "error", type: "error_validation", message: "CNY wire requires swift_bic, account_number, bank_name" });
        }
        const id = ulid("PD");
        const pd = { id, entity_id: body.entity_id || "ROOT", ...body };
        store.paymentDetails.set(id, pd);
        return send(201, { status: "success", data: pd });
      }

      if (req.method === "POST" && pathname === "/fx-quotes") {
        const rate = body.from_currency === "USC"
          ? (FROM_USC_RATE[body.to_currency] || 1)
          : (1 / (FROM_USC_RATE[body.from_currency] || 1));
        const id = ulid("FX");
        let amountFrom = body.amount_from;
        let amountTo = body.amount_to;
        if (amountTo && !amountFrom) {
          amountFrom = Math.ceil(amountTo / rate);
        } else if (amountFrom && !amountTo) {
          amountTo = Math.floor(amountFrom * rate);
        }
        const q = {
          id,
          from: body.from_currency,
          to: body.to_currency,
          amount_from: amountFrom,
          amount_to: amountTo,
          rate,
          quote: { status: "active", expires_at: Date.now() + 180000, valid_for: 180, used_at: null },
        };
        store.fxQuotes.set(id, q);
        return send(201, { status: "success", data: q });
      }

      if (req.method === "POST" && pathname === "/transfers") {
        const acc = store.accounts.get(body.account_id);
        if (!acc) return send(404, { status: "error", type: "error_resource_not_found", message: "Account not found" });

        if (body.payment_type === "stablecoin-transfer" && store.failFirstRefundOnce) {
          store.failFirstRefundOnce = false;
          return send(400, {
            status: "error",
            type: "error_transfer_insufficient_funds",
            message: "Insufficient funds including applicable fee",
          });
        }

        if (acc.balance.available < body.amount) {
          return send(400, {
            status: "error",
            type: "error_transfer_insufficient_funds",
            message: `Insufficient balance (${acc.balance.available} < ${body.amount})`,
          });
        }

        acc.balance.available -= body.amount;
        acc.balance.current -= body.amount;

        const id = ulid("TX");
        const tx = {
          id,
          entity_id: body.entity_id || "ROOT",
          account_id: body.account_id,
          counterparty_id: body.counterparty_id,
          payment_detail_id: body.payment_detail_id,
          amount: body.amount,
          currency: body.currency,
          unique_reference: body.unique_reference,
          payment_type: body.payment_type,
          fx_quote_id: body.fx_quote_id || null,
          narration: body.narration,
          type: "outflow",
          status: "pending",
          applicable_fee: 0,
        };
        store.transfers.set(id, tx);
        return send(201, { status: "success", data: tx });
      }

      const txMatch = pathname.match(/^\/transfers\/([^/]+)$/);
      if (req.method === "GET" && txMatch) {
        const tx = store.transfers.get(txMatch[1]);
        if (!tx) return send(404, { status: "error", type: "error_resource_not_found", message: "Transfer not found" });
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

test("Phase 3: Complete coverage of ALL 27 Nuvion Fiat Currencies, ALL 10 Receiving Currencies & Official Rail Limits", () => {
  // Exact 27 fiat currencies from docs.nuvion.co/core-concepts/accounts
  assert.equal(corridors.ALL_NUVION_FIAT_CURRENCIES.length, 27);
  assert.equal(corridors.ALL_NUVION_RECEIVING_CURRENCIES.length, 10);
  assert.ok(corridors.ALL_NUVION_RECEIVING_CURRENCIES.includes("CAD"), "CAD must be included in receiving currencies");

  // Every one of the 27 currencies must have region metadata and at least 2 payout rails
  const regionalTotal = Object.values(corridors.REGIONS).reduce((sum, r) => sum + r.currencies.length, 0);
  assert.equal(regionalTotal, 27, "All 27 Nuvion currencies must appear in regional menus");

  for (const code of corridors.ALL_NUVION_FIAT_CURRENCIES) {
    assert.ok(corridors.CURRENCY_INFO[code], `Missing CURRENCY_INFO for ${code}`);
    const rails = corridors.getRailsForCurrency(code);
    assert.ok(rails.length >= 2, `Currency ${code} must have payout rails (local + SWIFT)`);
  }

  // Verify CNY Wire rail, official limits (420 .. 35,593,243), and payload schema
  const cnyRail = corridors.getRailByKey("cny_wire");
  assert.equal(cnyRail.currency, "CNY");
  assert.equal(cnyRail.country, "CN");
  assert.equal(corridors.validateCorridorAmount("cny_wire", 300, "CNY").valid, false);
  assert.equal(corridors.validateCorridorAmount("cny_wire", 420, "CNY").valid, true);
  assert.equal(corridors.validateCorridorAmount("cny_wire", 40000000, "CNY").valid, false);

  const parsedCny = corridors.parseRecipientInputForRail(cnyRail, "Zhang Wei, SYCBCNBYXXX, 6230810325651744, SHENGJING BANK CO.,LTD");
  assert.equal(parsedCny.ok, true);
  assert.equal(parsedCny.details.bank_name, "SHENGJING BANK CO.,LTD");
  const pdCny = corridors.buildPaymentDetailPayload("01ENT", "01CP", cnyRail, parsedCny.details);
  assert.equal(pdCny.currency, "CNY");
  assert.equal(pdCny.country, "CN");
  assert.equal(pdCny.swift_bic, "SYCBCNBYXXX");
  assert.equal(pdCny.account_number, "6230810325651744");

  // Verify USD ACH requires full bank_address
  const usdAch = corridors.getRailByKey("usd_ach");
  const parsedUsd = corridors.parseRecipientInputForRail(
    usdAch,
    "Danielle Brooks, 026009593, 987654321012, Bank of America, 100 Federal Street, Boston, MA, 02110"
  );
  assert.equal(parsedUsd.ok, true);
  const pdUsd = corridors.buildPaymentDetailPayload("01ENT", "01CP", usdAch, parsedUsd.details);
  assert.equal(pdUsd.scheme, "ach");
  assert.equal(pdUsd.bank_address.line1, "100 Federal Street");
  assert.equal(pdUsd.bank_address.postal_code, "02110");

  // Verify official CAD Interac, PHP InstaPay, KES/GHS/TZS MoMo limits
  assert.equal(corridors.validateCorridorAmount("cad_interac_email", 25001, "CAD").valid, false);
  assert.equal(corridors.validateCorridorAmount("php_instapay", 50001, "PHP").valid, false);
  assert.equal(corridors.validateCorridorAmount("php_pesonet", 100000, "PHP").valid, true);
  assert.equal(corridors.validateCorridorAmount("kes_momo", 15, "KES").valid, false);
  assert.equal(corridors.validateCorridorAmount("ghs_momo", 5, "GHS").valid, true);
  assert.equal(corridors.validateCorridorAmount("tzs_momo", 999, "TZS").valid, false);
  assert.equal(corridors.isSupportedFiatCurrency("XOF"), false, "Unsupported XOF must return false");
});

test("Phase 3: End-to-End Global Payouts (CNY Wire, Tier-1 NGN NIP Naira-only, Saved Reuse, Auto-Refund on Failure, Multi-Currency CSV Payroll)", async () => {
  const mock = await startPhase3MockNuvion();
  process.env.NUVION_BASE_URL = mock.baseUrl;
  payouts.registerPayoutHooks();

  const origUnified = chains.getUnifiedBalance;
  try {
    const tgId = 999111222;
    const w = walletLib.generateUserWallet();
    const bizW = walletLib.generateUserWallet();
    db.createUserWithWallet(tgId, "global_ceo", w.address, w.privateKey, "1234");
    db.db.prepare("UPDATE users SET business_deposit_address = ? WHERE telegram_id = ?")
      .run(bizW.address, tgId);

    // Tier-0 check before Tier-1 approval -> NGN stays on Paj v2
    assert.equal(payouts.shouldUseNuvionForNgnPayout(tgId, "personal"), false);

    // Approve personal & business Tier-1 entities and bootstrap Base bridges
    const perEntId = "01P3ENT_PERSONAL_APPROVED";
    const bizEntId = "01P3ENT_BUSINESS_APPROVED";
    db.upsertNuvionEntity({
      telegramId: tgId,
      accountType: "personal",
      entityId: perEntId,
      entityType: "individual",
      legalName: "Ada Founder",
      email: "ada@global.com",
      status: "approved",
    });
    db.upsertNuvionEntity({
      telegramId: tgId,
      accountType: "business",
      entityId: bizEntId,
      entityType: "business",
      legalName: "Proxim Global Labs Ltd",
      email: "treasury@global.com",
      status: "approved",
    });

    const perEnt = await nuvionWebhooks.bootstrapApprovedEntity(db.getNuvionEntityByEntityId(perEntId));
    const bizEnt = await nuvionWebhooks.bootstrapApprovedEntity(db.getNuvionEntityByEntityId(bizEntId));

    // Tier-1 approved -> NGN NIP enabled!
    assert.equal(payouts.shouldUseNuvionForNgnPayout(tgId, "personal"), true);

    // Mock plenty of unified balance for offline funding
    chains.getUnifiedBalance = async () => ({
      arc: { usdc: 5000, eurc: 0 },
      base: { usdc: 0 },
      gateway: { usdc: 5000 },
      solana: { usdc: 0 },
      total: 10000,
    });

    const fundedCalls = [];
    const mockFundingExecutor = async ({ nuvionBaseAddress, nuvionCostUsd, marginUsd }) => {
      fundedCalls.push({ nuvionBaseAddress, nuvionCostUsd, marginUsd });
      return { route: "circle_gateway", txHash: `0xgw_mock_${Date.now()}` };
    };

    const tgAlerts = [];
    const fakeBot = {
      telegram: {
        sendPhoto: async (chatId, _photo, opts) => tgAlerts.push({ chatId, kind: "photo", text: opts.caption }),
        sendMessage: async (chatId, text) => tgAlerts.push({ chatId, kind: "text", text }),
      },
    };

    // ── 1. China CNY Wire Payout (¥3,500 CNY) ──────────────────────────────
    const cnyInit = await payouts.initiateGlobalPayout({
      telegramId: tgId,
      pin: "1234",
      accountType: "personal",
      railKey: "cny_wire",
      targetCurrency: "CNY",
      targetAmountMajor: 3500,
      recipientDetails: {
        account_holder_name: "Zhang Wei",
        swift_bic: "SYCBCNBYXXX",
        account_number: "6230810325651744",
        bank_name: "SHENGJING BANK CO.,LTD",
      },
      narration: "Shenzhen supplier batch 1",
      bot: fakeBot,
      fundingExecutor: mockFundingExecutor,
    });

    assert.equal(cnyInit.job.state, "funding_in_transit");
    assert.equal(cnyInit.quote.marginBps, 100, "1% FX margin must be applied");
    assert.ok(cnyInit.quote.marginUsd > 0 && cnyInit.quote.userTotalUsd > cnyInit.quote.nuvionCostUsd);
    assert.equal(fundedCalls[0].nuvionBaseAddress, perEnt.usc_base_address);

    // Simulate Base USC arriving on Nuvion (`inflows.completed` on USC account)
    const perUscAcc = mock.store.accounts.get(perEnt.usc_account_id);
    perUscAcc.balance.available += cnyInit.quote.nuvionCostMinor;
    perUscAcc.balance.current += cnyInit.quote.nuvionCostMinor;
    const uscInflow1 = "01P3IN_USC_CNY1";
    mock.store.transfers.set(uscInflow1, {
      id: uscInflow1,
      entity_id: perEntId,
      account_id: perEnt.usc_account_id,
      amount: cnyInit.quote.nuvionCostMinor,
      currency: "USC",
      type: "inflow",
      payment_type: "stablecoin-transfer",
      status: "successful",
      applicable_fee: 0,
    });

    await nuvionWebhooks.processNuvionEvent(
      { event: "inflows.completed", data: { id: uscInflow1, entity_id: perEntId, currency: "USC", amount: cnyInit.quote.nuvionCostMinor } },
      { "x-nuvion-event-id": "evt_p3_usc_in_cny" },
      fakeBot
    );

    const cnyJobDispatched = db.getNuvionJobById(cnyInit.job.id);
    assert.equal(cnyJobDispatched.state, "dispatched");
    assert.ok(cnyJobDispatched.nuvion_transfer_id, "Nuvion CNY transfer must be dispatched automatically");
    assert.equal(perUscAcc.balance.available, 0, "Nuvion USC account must sweep cleanly back to 0.00!");

    // Simulate `outflows.completed` -> HD Receipt PNG delivered
    const cnyTx = mock.store.transfers.get(cnyJobDispatched.nuvion_transfer_id);
    cnyTx.status = "successful";
    await nuvionWebhooks.processNuvionEvent(
      { event: "outflows.completed", data: { id: cnyTx.id, entity_id: perEntId, status: "successful" } },
      { "x-nuvion-event-id": "evt_p3_out_cny_done" },
      fakeBot
    );

    assert.equal(db.getNuvionJobById(cnyInit.job.id).state, "completed");
    assert.ok(tgAlerts.some((a) => a.text.includes("Zhang Wei") && a.text.includes("¥3,500.00")));

    // ── 2. Saved Recipient Reuse Check (second CNY send reuses counterparty!) ─
    const cpCountBefore = mock.store.counterparties.size;
    const savedReg = await payouts.ensurePayoutRecipient(perEntId, corridors.getRailByKey("cny_wire"), {
      account_holder_name: "Zhang Wei",
      swift_bic: "SYCBCNBYXXX",
      account_number: "6230810325651744",
      bank_name: "SHENGJING BANK CO.,LTD",
    });
    assert.equal(savedReg.reused, true, "Repeat recipient must reuse existing Nuvion counterparty_id");
    assert.equal(mock.store.counterparties.size, cpCountBefore);

    // ── 3. Tier-1 Nigeria NGN NIP Payout -> Naira-Only Receipt! ─────────────
    const ngnInit = await payouts.initiateGlobalPayout({
      telegramId: tgId,
      pin: "1234",
      accountType: "personal",
      railKey: "ngn_nip",
      targetCurrency: "NGN",
      targetAmountMajor: 150000,
      recipientDetails: {
        account_holder_name: "Chidinma Okafor",
        bank_code: "044",
        account_number: "0690000031",
        bank_name: "Access Bank",
      },
      narration: "Lagos rent",
      bot: fakeBot,
      fundingExecutor: mockFundingExecutor,
    });

    perUscAcc.balance.available += ngnInit.quote.nuvionCostMinor;
    perUscAcc.balance.current += ngnInit.quote.nuvionCostMinor;
    const uscInflowNgn = "01P3IN_USC_NGN1";
    mock.store.transfers.set(uscInflowNgn, {
      id: uscInflowNgn,
      entity_id: perEntId,
      account_id: perEnt.usc_account_id,
      amount: ngnInit.quote.nuvionCostMinor,
      currency: "USC",
      type: "inflow",
      payment_type: "stablecoin-transfer",
      status: "successful",
      applicable_fee: 0,
    });

    await nuvionWebhooks.processNuvionEvent(
      { event: "inflows.completed", data: { id: uscInflowNgn, entity_id: perEntId, currency: "USC" } },
      { "x-nuvion-event-id": "evt_p3_usc_in_ngn" },
      fakeBot
    );
    const ngnJob = db.getNuvionJobById(ngnInit.job.id);
    const ngnTx = mock.store.transfers.get(ngnJob.nuvion_transfer_id);
    ngnTx.status = "successful";

    await nuvionWebhooks.processNuvionEvent(
      { event: "outflows.completed", data: { id: ngnTx.id, entity_id: perEntId, status: "successful" } },
      { "x-nuvion-event-id": "evt_p3_out_ngn_done" },
      fakeBot
    );

    const ngnAlert = tgAlerts[tgAlerts.length - 1];
    assert.ok(ngnAlert.text.includes("₦150,000"), "NGN NIP receipt must display Naira amount");
    assert.ok(!ngnAlert.text.includes("Total Paid: $"), "NGN NIP receipt must stay Naira-only");

    // ── 4. Failure Auto-Refund (`outflows.failed` -> Base 0x Wallet + Fee Retry) ─
    const gbpInit = await payouts.initiateGlobalPayout({
      telegramId: tgId,
      pin: "1234",
      accountType: "personal",
      railKey: "gbp_fps",
      targetCurrency: "GBP",
      targetAmountMajor: 200,
      recipientDetails: {
        account_holder_name: "Jane Smith",
        sort_code: "040004",
        account_number: "12345678",
        bank_name: "Barclays",
      },
      bot: fakeBot,
      fundingExecutor: mockFundingExecutor,
    });

    perUscAcc.balance.available += gbpInit.quote.nuvionCostMinor;
    perUscAcc.balance.current += gbpInit.quote.nuvionCostMinor;
    const uscInflowGbp = "01P3IN_USC_GBP_FAIL";
    mock.store.transfers.set(uscInflowGbp, {
      id: uscInflowGbp,
      entity_id: perEntId,
      account_id: perEnt.usc_account_id,
      amount: gbpInit.quote.nuvionCostMinor,
      currency: "USC",
      type: "inflow",
      payment_type: "stablecoin-transfer",
      status: "successful",
      applicable_fee: 0,
    });
    await nuvionWebhooks.processNuvionEvent(
      { event: "inflows.completed", data: { id: uscInflowGbp, entity_id: perEntId, currency: "USC" } },
      { "x-nuvion-event-id": "evt_p3_usc_in_gbp" },
      fakeBot
    );

    const gbpJob = db.getNuvionJobById(gbpInit.job.id);
    const gbpTx = mock.store.transfers.get(gbpJob.nuvion_transfer_id);
    // Simulate Nuvion failing the payout and returning USC back to user's USC account!
    gbpTx.status = "failed";
    gbpTx.failure_reason = "Invalid beneficiary account";
    perUscAcc.balance.available += gbpTx.amount;
    perUscAcc.balance.current += gbpTx.amount;
    mock.store.failFirstRefundOnce = true; // Verify fee-buffer retry on refund too!

    await nuvionWebhooks.processNuvionEvent(
      { event: "outflows.failed", data: { id: gbpTx.id, entity_id: perEntId, status: "failed" } },
      { "x-nuvion-event-id": "evt_p3_out_gbp_fail" },
      fakeBot
    );

    const refundedJob = db.getNuvionJobById(gbpInit.job.id);
    assert.equal(refundedJob.state, "refunded", "Failed payout must auto-refund USC back to user Base wallet");
    assert.ok(refundedJob.payload.refundTransferId);
    const refundTx = mock.store.transfers.get(refundedJob.payload.refundTransferId);
    assert.equal(refundTx.payment_type, "stablecoin-transfer");
    assert.equal(refundTx.currency, "USC");
    const refundPd = mock.store.paymentDetails.get(refundTx.payment_detail_id);
    assert.equal(refundPd.blockchain_network, "BASE_MAINNET");
    assert.equal(refundPd.wallet_address, w.address);
    assert.ok(tgAlerts[tgAlerts.length - 1].text.includes("Transfer Refunded to Your Balance"));

    // ── 5. Business Multi-Currency CSV Payroll (GBP + KES MoMo + CNY Wire + JPY SWIFT) ─
    const csvSample = [
      "name,currency,rail,amount,country,account_number,sort_code,swift_bic,phone_number,scheme,bank_name,narration",
      "Alice UK,GBP,gbp_fps,400,GB,12345678,040004,,,,Barclays,Oct salary",
      "John Kenya,KES,kes_momo,25000,KE,,,,+254712345678,mpesa,M-Pesa,Oct salary",
      'Zhang China,CNY,cny_wire,3000,CN,6230810325651744,,SYCBCNBYXXX,,,"SHENGJING BANK CO.,LTD",Supplier bonus',
      "Kenji Japan,JPY,swift_acct,50000,JP,0123456,,BOTKJPJTXXX,,,MUFG Bank,Tokyo contractor",
    ].join("\n");

    const plan = await payouts.parseAndQuoteGlobalPayroll({
      telegramId: tgId,
      csvText: csvSample,
      accountType: "business",
    });
    assert.equal(plan.rows.length, 4);
    assert.equal(plan.parseErrors.length, 0);
    assert.ok(plan.totalMarginUsd > 0 && plan.totalUserUsd > plan.totalNuvionCostUsd);

    const execRes = await payouts.executeGlobalPayrollBatch({
      telegramId: tgId,
      pin: "1234",
      payrollPlan: plan,
      accountType: "business",
      bot: fakeBot,
      fundingExecutor: mockFundingExecutor,
    });
    assert.equal(execRes.queuedCount, 4);
    assert.equal(execRes.skippedCount, 0);

    // Re-running the EXACT same CSV batch must skip all 4 rows (deterministic idempotency!)
    const dupRes = await payouts.executeGlobalPayrollBatch({
      telegramId: tgId,
      pin: "1234",
      payrollPlan: plan,
      accountType: "business",
      bot: fakeBot,
      fundingExecutor: mockFundingExecutor,
    });
    assert.equal(dupRes.queuedCount, 0, "Duplicate CSV payroll batch must never double-pay!");
    assert.equal(dupRes.skippedCount, 4);

    // Simulate single consolidated Base USC deposit arriving for the Business entity -> dispatches ALL 4 rows!
    const bizUscAcc = mock.store.accounts.get(bizEnt.usc_account_id);
    const batchMinor = nuvion.toNuvionMinor(execRes.totalNuvionCostUsd);
    bizUscAcc.balance.available += batchMinor;
    bizUscAcc.balance.current += batchMinor;
    const batchInflowId = "01P3IN_BIZ_PAYROLL_BATCH";
    mock.store.transfers.set(batchInflowId, {
      id: batchInflowId,
      entity_id: bizEntId,
      account_id: bizEnt.usc_account_id,
      amount: batchMinor,
      currency: "USC",
      type: "inflow",
      payment_type: "stablecoin-transfer",
      status: "successful",
      applicable_fee: 0,
    });

    await nuvionWebhooks.processNuvionEvent(
      { event: "inflows.completed", data: { id: batchInflowId, entity_id: bizEntId, currency: "USC" } },
      { "x-nuvion-event-id": "evt_p3_biz_payroll_in" },
      fakeBot
    );

    for (const j of execRes.jobs) {
      const updated = db.getNuvionJobById(j.id);
      assert.equal(updated.state, "dispatched", `Payroll row ${j.currency} must be dispatched automatically`);
      assert.ok(updated.nuvion_transfer_id);
    }

    // Verify poller exports reconcilePendingPayoutsOnce cleanly
    const pollRes = await poller.reconcilePendingPayoutsOnce(fakeBot);
    assert.ok(Array.isArray(pollRes));
  } finally {
    chains.getUnifiedBalance = origUnified;
    mock.server.close();
  }
});

test.after(() => {
  try { fs.unlinkSync(tmpDbPath); } catch (_) {}
});
