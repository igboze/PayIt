// tests/nuvion_phase4.test.js
// 100% Offline Integration Suite for Nuvion Phase 4 (Virtual & Disposable USD Cards):
// - Safe card expiration <= 24 months
// - Live GET /card-creation-fee check + Load-to-Spend dedicated USD sub-accounts
// - Anti-duplicate non-idempotent card creation lock
// - ZERO PAN (number) or CVV stored anywhere in SQLite (nuvion_cards / nuvion_jobs)
// - Disposable 1-time USD card: spend -> auto-deactivated -> leftover cents auto-swept to Base 0x!
// - Business Team Virtual USD card: custom cardholder, Top Up, PIN-gated Reveal, Freeze/Unfreeze,
//   Transactions, Decline & Refund alerts, Explicit Unload, and Delete + Auto-Unload!
// ZERO calls are made to live https://api.nuvion.co!

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const tmpDbPath = path.join(os.tmpdir(), `test_nuvion_phase4_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = tmpDbPath;
process.env.NODE_ENV = "test";
process.env.NUVION_ENV = "sandbox";
process.env.NUVION_API_KEY = "nv_live_test_phase4_owner";
process.env.NUVION_WEBHOOK_SECRET = "nv_wsk_phase4_secret";
process.env.NUVION_FX_MARGIN_BPS = "100"; // 1.00%
process.env.NUVION_BETA_IDS = "777444111";
process.env.NUVION_PUBLIC_LAUNCH = "false";

const db = require("../src/db");
const nuvion = require("../src/nuvion");
const nuvionWebhooks = require("../src/nuvion_webhooks");
const cardsLib = require("../src/nuvion_cards");
const chains = require("../src/chains");
const walletLib = require("../src/wallet");
const convState = require("../src/conversation_state");
convState.initStateTable();

function startPhase4MockNuvion() {
  const store = {
    accounts: new Map(),
    accountDetails: new Map(),
    counterparties: new Map(),
    paymentDetails: new Map(),
    fxQuotes: new Map(),
    transfers: new Map(),
    cards: new Map(),
    cardTransactions: new Map(),
    cardCreationFeeMinor: 50, // $0.50 USD creation fee
  };
  let seq = 1;
  const ulid = (p) => `01P4${p}${String(seq++).padStart(18, "0")}`.slice(0, 26);

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

      // Entities (for cardholder fallback)
      const entMatch = pathname.match(/^\/entities\/([^/]+)$/);
      if (req.method === "GET" && entMatch) {
        return send(200, {
          status: "success",
          data: {
            entity: { id: entMatch[1], status: "approved" },
            person: { first_name: "Ada", last_name: "Founder", email: "ada@cards.com", phone_number: "+2348011112222" },
          },
        });
      }

      // Accounts
      if (req.method === "POST" && pathname === "/accounts") {
        const id = ulid("AC");
        const acc = {
          id,
          entity_id: body.entity_id || "ROOT",
          type: body.type || "checking",
          currency: body.currency,
          display_name: body.display_name,
          nuvion_ban: `0040${String(seq).padStart(6, "0")}`,
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

      const accMatch = pathname.match(/^\/accounts\/([^/]+)$/);
      if (req.method === "GET" && accMatch) {
        const acc = store.accounts.get(accMatch[1]);
        if (!acc) return send(404, { status: "error", type: "error_resource_not_found", message: "Account not found" });
        return send(200, { status: "success", data: { account: acc } });
      }

      // Account Details
      if (req.method === "POST" && pathname === "/account-details") {
        const acc = store.accounts.get(body.account_id);
        const ent = body.entity_id || "ROOT";
        if (!acc || acc.entity_id !== ent) return send(404, { status: "error", type: "error_resource_not_found", message: "Account not found" });
        const id = ulid("AD");
        const det = {
          id,
          entity_id: ent,
          account_id: acc.id,
          asset_type: body.chain ? "stablecoin" : "fiat",
          currency: acc.currency,
          chain: body.chain || null,
          account_number: body.chain ? `0x8888888888888888888888888888888888${String(seq).padStart(6, "0")}` : `9100${String(seq).padStart(6, "0")}`,
          status: "active",
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

      // Counterparties & Payment Details
      if (req.method === "POST" && pathname === "/counterparties") {
        const id = ulid("CP");
        const cp = { id, entity_id: body.entity_id || "ROOT", ...body };
        store.counterparties.set(id, cp);
        return send(201, { status: "success", data: cp });
      }

      if (req.method === "POST" && pathname === "/payment-details") {
        const id = ulid("PD");
        const pd = { id, entity_id: body.entity_id || "ROOT", ...body };
        store.paymentDetails.set(id, pd);
        return send(201, { status: "success", data: pd });
      }

      // FX Quotes (1:1 USC <-> USD)
      if (req.method === "POST" && pathname === "/fx-quotes") {
        const id = ulid("FX");
        const amt = body.amount_from || body.amount_to || 0;
        const q = {
          id,
          from: body.from_currency,
          to: body.to_currency,
          amount_from: amt,
          amount_to: amt,
          rate: 1.0,
          quote: { status: "active", expires_at: Date.now() + 180000, valid_for: 180 },
        };
        store.fxQuotes.set(id, q);
        return send(201, { status: "success", data: q });
      }

      // Transfers
      if (req.method === "POST" && pathname === "/transfers") {
        const acc = store.accounts.get(body.account_id);
        if (!acc) return send(404, { status: "error", type: "error_resource_not_found", message: "Account not found" });
        if (acc.balance.available < body.amount) {
          return send(400, { status: "error", type: "error_transfer_insufficient_funds", message: "Insufficient funds" });
        }
        acc.balance.available -= body.amount;
        acc.balance.current -= body.amount;

        // Instant book-transfer credit to matching nuvion_ban
        if (body.payment_type === "book-transfer") {
          const pd = store.paymentDetails.get(body.payment_detail_id);
          if (pd?.account_number) {
            for (const target of store.accounts.values()) {
              if (target.nuvion_ban === pd.account_number) {
                target.balance.available += body.amount;
                target.balance.current += body.amount;
              }
            }
          }
        }

        const id = ulid("TX");
        const tx = {
          id,
          entity_id: body.entity_id || "ROOT",
          account_id: body.account_id,
          counterparty_id: body.counterparty_id,
          payment_detail_id: body.payment_detail_id,
          amount: body.amount,
          currency: body.currency,
          payment_type: body.payment_type,
          unique_reference: body.unique_reference,
          narration: body.narration,
          status: body.payment_type === "book-transfer" ? "successful" : "pending",
          applicable_fee: 0,
        };
        store.transfers.set(id, tx);
        return send(201, { status: "success", data: tx });
      }

      const txMatch = pathname.match(/^\/transfers\/([^/]+)$/);
      if (req.method === "GET" && txMatch) {
        const tx = store.transfers.get(txMatch[1]);
        if (!tx) return send(404, { status: "error", type: "error_resource_not_found", message: "Not found" });
        return send(200, { status: "success", data: tx });
      }

      // Card Creation Fee
      const feeMatch = pathname.match(/^\/card-creation-fee\/([^/]+)$/);
      if (req.method === "GET" && feeMatch) {
        if (!query.currency) {
          return send(422, { status: "error", type: "error_validation_required_field_missing", message: "currency required" });
        }
        return send(200, { status: "success", data: { fee: store.cardCreationFeeMinor, currency: query.currency } });
      }

      // Create Disposable or Virtual Card (non-idempotent!)
      if (req.method === "POST" && (pathname === "/disposable-cards" || pathname === "/virtual-cards")) {
        const acc = store.accounts.get(body.account_id);
        if (!acc || acc.entity_id !== (body.entity_id || "ROOT")) {
          return send(404, { status: "error", type: "error_resource_not_found", message: "Account not found" });
        }
        if (acc.currency !== body.currency) {
          return send(400, { status: "error", type: "error_operation_invalid_for_state", message: "Currency mismatch" });
        }
        if (acc.balance.available < store.cardCreationFeeMinor) {
          return send(400, { status: "error", type: "error_card_creation_fee_required", message: "Cannot cover card creation fee" });
        }
        // Debit creation fee from card USD sub-account
        acc.balance.available -= store.cardCreationFeeMinor;
        acc.balance.current -= store.cardCreationFeeMinor;

        const id = ulid("CD");
        const isDisp = pathname === "/disposable-cards";
        const pan = isDisp ? "4111111111119876" : "4222222222225432";
        const cvv = isDisp ? "789" : "321";
        const card = {
          id,
          entity_id: body.entity_id || "ROOT",
          account_id: body.account_id,
          name: body.card_name,
          type: isDisp ? "disposable" : "virtual",
          status: "active",
          currency: body.currency,
          number: pan,
          cvv,
          expiration_month: body.expiration_month,
          expiration_year: body.expiration_year,
          first_name: body.cardholder?.first_name,
          last_name: body.cardholder?.last_name,
          billing: {
            address_line_1: "350 Fifth Avenue",
            city: "New York",
            state: "NY",
            postal_code: "10001",
          },
          created: Date.now(),
        };
        store.cards.set(id, card);
        return send(201, { status: "success", data: card });
      }

      // List Cards
      if (req.method === "GET" && pathname === "/cards") {
        const ent = query.entity_id || "ROOT";
        const rows = [...store.cards.values()].filter(
          (c) => c.entity_id === ent && c.status !== "deleted" && (!query.account_id || c.account_id === query.account_id)
        );
        return send(200, { status: "success", data: { data: rows } });
      }

      // Get Card Details / Freeze / Unfreeze / Delete
      const cdFreezeMatch = pathname.match(/^\/card-details\/([^/]+)\/(freeze|unfreeze)$/);
      if (req.method === "PATCH" && cdFreezeMatch) {
        const card = store.cards.get(cdFreezeMatch[1]);
        if (!card) return send(404, { status: "error", type: "error_resource_not_found", message: "Card not found" });
        card.status = cdFreezeMatch[2] === "freeze" ? "blocked" : "active";
        return send(200, { status: "success", data: card });
      }

      const cdMatch = pathname.match(/^\/card-details\/([^/]+)$/);
      if (cdMatch) {
        const card = store.cards.get(cdMatch[1]);
        if (!card) return send(404, { status: "error", type: "error_resource_not_found", message: "Card not found" });
        if (req.method === "GET") return send(200, { status: "success", data: card });
        if (req.method === "DELETE") {
          card.status = "deleted";
          return send(200, { status: "success", data: { id: card.id, status: "deleted" } });
        }
      }

      const ctxMatch = pathname.match(/^\/card-transactions\/([^/]+)$/);
      if (req.method === "GET" && ctxMatch) {
        const list = store.cardTransactions.get(ctxMatch[1]) || [];
        return send(200, { status: "success", data: { data: list } });
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

test("Phase 4: Safe expiration (<= 24 months) & End-to-End Disposable + Business Team Virtual USD Cards", async () => {
  // 1. Verify safe expiration never exceeds 24 months
  const now = new Date(Date.UTC(2026, 10, 20)); // Nov 2026
  const exp = cardsLib.getSafeCardExpiration(now);
  assert.equal(exp.expirationMonth, "09");
  assert.equal(exp.expirationYear, "28"); // 22 months ahead (strictly <= 24 months!)

  const mock = await startPhase4MockNuvion();
  process.env.NUVION_BASE_URL = mock.baseUrl;
  cardsLib.registerCardHooks();

  const origUnified = chains.getUnifiedBalance;
  try {
    const tgId = 777444111;
    const w = walletLib.generateUserWallet();
    const bizW = walletLib.generateUserWallet();
    db.createUserWithWallet(tgId, "card_founder", w.address, w.privateKey, "1234");
    db.addBusinessWallet(tgId, bizW.address, bizW.privateKey, "1234");

    const perEntId = "01P4ENT_PERSONAL_CARDS";
    const bizEntId = "01P4ENT_BUSINESS_CARDS";
    db.upsertNuvionEntity({
      telegramId: tgId,
      accountType: "personal",
      entityId: perEntId,
      entityType: "individual",
      legalName: "Ada Founder",
      email: "ada@cards.com",
      status: "approved",
    });
    db.upsertNuvionEntity({
      telegramId: tgId,
      accountType: "business",
      entityId: bizEntId,
      entityType: "business",
      legalName: "Proxim Tech Ltd",
      email: "finance@proxim.tech",
      status: "approved",
    });

    const perEnt = await nuvionWebhooks.bootstrapApprovedEntity(db.getNuvionEntityByEntityId(perEntId));
    const bizEnt = await nuvionWebhooks.bootstrapApprovedEntity(db.getNuvionEntityByEntityId(bizEntId));

    chains.getUnifiedBalance = async () => ({
      arc: { usdc: 1000, eurc: 0 },
      base: { usdc: 0 },
      gateway: { usdc: 1000 },
      solana: { usdc: 0 },
      total: 2000,
    });

    const mockFunding = async ({ nuvionBaseAddress, nuvionCostUsd }) => ({
      route: "circle_gateway",
      txHash: `0xgw_card_${Date.now()}_${nuvionCostUsd}_${nuvionBaseAddress.slice(-4)}`,
    });

    const tgMessages = [];
    const fakeBot = {
      telegram: {
        sendMessage: async (chatId, text) => tgMessages.push({ chatId, text }),
      },
    };

    // ── A. Disposable 1-Time USD Card ($20 load + $0.50 live creation fee + 1% spread) ──
    const dispInit = await cardsLib.initiateCardIssuance({
      telegramId: tgId,
      pin: "1234",
      accountType: "personal",
      cardType: "disposable",
      cardName: "One-Time SaaS Trial",
      loadAmountUsd: 20,
      bot: fakeBot,
      fundingExecutor: mockFunding,
    });

    assert.equal(dispInit.nuvionCreationFeeUsd, 0.5, "Must read live $0.50 Nuvion card creation fee");
    assert.equal(dispInit.proximCardFeeUsd, 0.5, "Must include $0.50 Proxim disposable card fee");
    assert.equal(dispInit.creationFeeUsd, 1.0, "Total card creation fee = $0.50 Nuvion + $0.50 Proxim = $1.00");
    assert.equal(dispInit.loadAmountUsd, 20);
    assert.equal(dispInit.marginUsd, 0.2, "1% spread on $20 load = $0.20");
    assert.equal(dispInit.proximRevenueUsd, 0.7, "Proxim collects $0.50 card fee + $0.20 1% spread = $0.70");
    assert.equal(dispInit.nuvionNeededUsd, 20.5, "Only $20 load + $0.50 Nuvion fee goes to Nuvion bridge");
    assert.equal(dispInit.userTotalUsd, 21.2);

    // Anti-duplicate lock MUST reject a duplicate concurrent card issuance request!
    await assert.rejects(
      () => cardsLib.initiateCardIssuance({
        telegramId: tgId,
        pin: "1234",
        accountType: "personal",
        cardType: "disposable",
        cardName: "One-Time SaaS Trial",
        loadAmountUsd: 20,
        fundingExecutor: mockFunding,
      }),
      /already being issued/i
    );

    // Simulate $20.50 USC arriving on user's Nuvion USC Base bridge -> books into Card USD sub-acct -> issues card!
    const perUscAcc = mock.store.accounts.get(perEnt.usc_account_id);
    const dispBridgeMinor = nuvion.toNuvionMinor(20.5);
    perUscAcc.balance.available += dispBridgeMinor;
    perUscAcc.balance.current += dispBridgeMinor;
    const uscIn1 = "01P4IN_USC_DISP1";
    mock.store.transfers.set(uscIn1, {
      id: uscIn1,
      entity_id: perEntId,
      account_id: perEnt.usc_account_id,
      amount: dispBridgeMinor,
      currency: "USC",
      type: "inflow",
      status: "successful",
      applicable_fee: 0,
    });

    await nuvionWebhooks.processNuvionEvent(
      { event: "inflows.completed", data: { id: uscIn1, entity_id: perEntId, currency: "USC" } },
      { "x-nuvion-event-id": "evt_p4_disp_in" },
      fakeBot
    );

    assert.equal(perUscAcc.balance.available, 0, "USC bridge must drain back to 0.00");
    const dispSubAcc = mock.store.accounts.get(dispInit.cardAccountId);
    assert.equal(dispSubAcc.balance.available, 2000, "Card USD sub-account must hold exact $20.00 spend cap after $0.50 fee");

    const perCards = db.getNuvionCardsByEntity(perEntId);
    assert.equal(perCards.length, 1);
    const dispCard = perCards[0];
    assert.equal(dispCard.last4, "9876");
    assert.equal(dispCard.card_type, "disposable");

    // SECURITY ASSERTION: Raw PAN and CVV must NEVER exist anywhere in SQLite!
    const rawCardRowStr = JSON.stringify(dispCard);
    const rawJobRowStr = JSON.stringify(db.getNuvionJobById(dispInit.job.id));
    assert.ok(!rawCardRowStr.includes("4111111111119876"), "PAN must NEVER be stored in nuvion_cards");
    assert.ok(!rawCardRowStr.includes("789"), "CVV must NEVER be stored in nuvion_cards");
    assert.ok(!rawJobRowStr.includes("4111111111119876"), "PAN must NEVER be stored in nuvion_jobs");

    // Simulate $14.25 merchant purchase on Disposable Card -> deactivates + auto-sweeps $5.75 leftover to Base 0x!
    dispSubAcc.balance.available -= 1425;
    dispSubAcc.balance.current -= 1425;
    const spendTxId = "01P4TX_DISP_SPEND";
    mock.store.transfers.set(spendTxId, {
      id: spendTxId,
      entity_id: perEntId,
      account_id: dispSubAcc.id,
      card_id: dispCard.card_id,
      amount: 1425,
      currency: "USD",
      type: "outflow",
      payment_type: "card-debit",
      status: "successful",
      recipient: { name: "OPENAI *CHATGPT" },
    });

    await nuvionWebhooks.processNuvionEvent(
      { event: "outflows.completed", data: { id: spendTxId, entity_id: perEntId, account_id: dispSubAcc.id, card_id: dispCard.card_id, payment_type: "card-debit", amount: 1425 } },
      { "x-nuvion-event-id": "evt_p4_disp_spend" },
      fakeBot
    );

    const dispCardAfter = db.getNuvionCardsByEntity(perEntId).find((c) => c.card_id === dispCard.card_id);
    assert.equal(dispCardAfter.status, "deactivated", "Disposable card must flip to deactivated after 1st spend");
    assert.equal(dispSubAcc.balance.available, 0, "Disposable card leftover $5.75 must auto-sweep down to 0.00!");

    const sweepTx = [...mock.store.transfers.values()].find(
      (t) => t.account_id === dispSubAcc.id && t.payment_type === "stablecoin-transfer" && t.amount === 575
    );
    assert.ok(sweepTx, "Leftover $5.75 (575 minor) must fire via stablecoin-transfer to Base 0x wallet");
    const sweepPd = mock.store.paymentDetails.get(sweepTx.payment_detail_id);
    assert.equal(sweepPd.blockchain_network, "BASE_MAINNET");
    assert.equal(sweepPd.wallet_address, w.address);
    assert.ok(tgMessages[tgMessages.length - 1].text.includes("$5.75") && tgMessages[tgMessages.length - 1].text.includes("OPENAI"));

    // ── B. Business Team Reusable Virtual USD Card (Top Up, PIN Reveal, Freeze/Unfreeze, Decline/Refund, Delete & Unload) ──
    const teamInit = await cardsLib.initiateCardIssuance({
      telegramId: tgId,
      pin: "1234",
      accountType: "business",
      cardType: "virtual",
      cardName: "Marketing Ads Card",
      loadAmountUsd: 50,
      cardholderOverrides: {
        first_name: "Amara",
        last_name: "Obi",
        email: "amara@proxim.tech",
        phone_number: "+2348099998888",
      },
      bot: fakeBot,
      fundingExecutor: mockFunding,
    });

    const bizUscAcc = mock.store.accounts.get(bizEnt.usc_account_id);
    bizUscAcc.balance.available += 5050;
    bizUscAcc.balance.current += 5050;
    mock.store.transfers.set("01P4IN_BIZ_CARD1", {
      id: "01P4IN_BIZ_CARD1",
      entity_id: bizEntId,
      account_id: bizEnt.usc_account_id,
      amount: 5050,
      currency: "USC",
      type: "inflow",
      status: "successful",
      applicable_fee: 0,
    });
    await nuvionWebhooks.processNuvionEvent(
      { event: "inflows.completed", data: { id: "01P4IN_BIZ_CARD1", entity_id: bizEntId, currency: "USC" } },
      { "x-nuvion-event-id": "evt_p4_team_issue" },
      fakeBot
    );

    const bizCardsRes = await cardsLib.getUserCardsWithBalances(tgId, "business");
    assert.equal(bizCardsRes.cards.length, 1);
    assert.equal(bizCardsRes.totalCardBalanceUsd, 50);
    const teamCard = bizCardsRes.cards[0];
    assert.equal(teamCard.last4, "5432");

    // Top Up +$30.00 onto Business Team Card
    await cardsLib.initiateCardTopUp({
      telegramId: tgId,
      pin: "1234",
      accountType: "business",
      cardId: teamCard.card_id,
      loadAmountUsd: 30,
      bot: fakeBot,
      fundingExecutor: mockFunding,
    });
    bizUscAcc.balance.available += 3000;
    bizUscAcc.balance.current += 3000;
    mock.store.transfers.set("01P4IN_BIZ_TOPUP", {
      id: "01P4IN_BIZ_TOPUP",
      entity_id: bizEntId,
      account_id: bizEnt.usc_account_id,
      amount: 3000,
      currency: "USC",
      type: "inflow",
      status: "successful",
      applicable_fee: 0,
    });
    await nuvionWebhooks.processNuvionEvent(
      { event: "inflows.completed", data: { id: "01P4IN_BIZ_TOPUP", entity_id: bizEntId, currency: "USC" } },
      { "x-nuvion-event-id": "evt_p4_team_topup" },
      fakeBot
    );
    const afterTopup = await cardsLib.getUserCardsWithBalances(tgId, "business");
    assert.equal(afterTopup.totalCardBalanceUsd, 80, "Card balance must be $50 + $30 = $80.00");

    // PIN-Gated Reveal Details: rejects wrong PIN, returns ephemeral PAN/CVV on right PIN
    await assert.rejects(
      () => cardsLib.revealCardDetailsWithPin({ telegramId: tgId, pin: "9999", accountType: "business", cardId: teamCard.card_id }),
      /Incorrect PIN/i
    );
    const revealed = await cardsLib.revealCardDetailsWithPin({
      telegramId: tgId,
      pin: "1234",
      accountType: "business",
      cardId: teamCard.card_id,
    });
    assert.equal(revealed.number, "4222222222225432");
    assert.equal(revealed.cvv, "321");
    assert.equal(revealed.cardholderName, "Amara Obi");
    assert.equal(revealed.availableUsd, 80);

    // Freeze & Unfreeze
    const frozen = await cardsLib.setCardFrozen({ telegramId: tgId, accountType: "business", cardId: teamCard.card_id, freeze: true });
    assert.equal(frozen.status, "blocked");
    const unfrozen = await cardsLib.setCardFrozen({ telegramId: tgId, accountType: "business", cardId: teamCard.card_id, freeze: false });
    assert.equal(unfrozen.status, "active");

    // Card Transactions + Decline Alert + Refund Alert
    mock.store.cardTransactions.set(teamCard.card_id, [
      { id: "tx1", amount: 1200, payment_type: "card-debit", status: "successful", recipient: { name: "META ADS" } },
    ]);
    const txs = await cardsLib.fetchCardTransactions({ telegramId: tgId, accountType: "business", cardId: teamCard.card_id });
    assert.equal(txs.length, 1);

    mock.store.transfers.set("01P4TX_DEC", {
      id: "01P4TX_DEC",
      entity_id: bizEntId,
      account_id: teamCard.account_id,
      card_id: teamCard.card_id,
      amount: 9900,
      payment_type: "card-debit",
      status: "failed",
      recipient: { name: "AWS CLOUD" },
    });
    await nuvionWebhooks.processNuvionEvent(
      { event: "outflows.failed", data: { id: "01P4TX_DEC", entity_id: bizEntId, account_id: teamCard.account_id, card_id: teamCard.card_id, payment_type: "card-debit", amount: 9900 } },
      { "x-nuvion-event-id": "evt_p4_decline" },
      fakeBot
    );
    assert.ok(tgMessages[tgMessages.length - 1].text.includes("Card Charge Declined"));

    mock.store.transfers.set("01P4TX_REF", {
      id: "01P4TX_REF",
      entity_id: bizEntId,
      account_id: teamCard.account_id,
      card_id: teamCard.card_id,
      amount: 1200,
      payment_type: "card-credit-refund",
      status: "successful",
      recipient: { name: "META ADS" },
    });
    await nuvionWebhooks.processNuvionEvent(
      { event: "outflows.refunded", data: { id: "01P4TX_REF", entity_id: bizEntId, account_id: teamCard.account_id, card_id: teamCard.card_id, payment_type: "card-credit-refund", amount: 1200 } },
      { "x-nuvion-event-id": "evt_p4_refund" },
      fakeBot
    );
    assert.ok(tgMessages[tgMessages.length - 1].text.includes("Card Refund Received"));

    // Delete Card & Auto-Unload remaining $80.00 straight back to Business Base 0x wallet!
    const delRes = await cardsLib.deleteCardAndUnload({
      telegramId: tgId,
      accountType: "business",
      cardId: teamCard.card_id,
      bot: fakeBot,
    });
    assert.equal(delRes.deleted, true);
    assert.equal(delRes.unloadedUsd, 80, "Deleting card must auto-unload remaining $80 back to Business Base 0x wallet");
    assert.equal(mock.store.accounts.get(teamCard.account_id).balance.available, 0);
    assert.equal(db.getNuvionCardsByEntity(bizEntId).length, 0);
  } finally {
    chains.getUnifiedBalance = origUnified;
    mock.server.close();
  }
});

test.after(() => {
  try { fs.unlinkSync(tmpDbPath); } catch (_) {}
});
