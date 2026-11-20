// tests/nuvion_phase2.test.js
// 100% Offline Integration Suite for Nuvion Phase 2:
// - Unified Balance across Arc + Base + Circle Gateway + Solana (src/chains.js)
// - Bidirectional Circle Gateway BurnIntent (Arc <-> Base) (src/gateway.js)
// - Named Global Receiving Accounts (USD, GBP, EUR, NGN) (src/nuvion_orchestrator.js)
// - Zero-Custody Inbound Auto-Sweep: 1% FX Margin Book-Transfer -> FX Quote -> BASE_MAINNET USC -> Invoice Paid -> HD Receipt
// - Fee-buffer retry on 400 error_transfer_insufficient_funds
// - Hosted Payment Links (GBP Open Banking, KES M-Pesa, CAD Interac) + 3-min Interac PATCH poller
// ZERO calls are made to live https://api.nuvion.co!

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { Wallet } = require("ethers");

const tmpDbPath = path.join(os.tmpdir(), `test_nuvion_phase2_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = tmpDbPath;
process.env.NODE_ENV = "test";
process.env.NUVION_ENV = "sandbox";
process.env.NUVION_API_KEY = "nv_live_test_phase2_owner";
process.env.NUVION_WEBHOOK_SECRET = "nv_wsk_phase2_secret";
process.env.NUVION_FX_MARGIN_BPS = "100"; // 1.00%
process.env.NUVION_BETA_IDS = "888111222";
process.env.NUVION_PUBLIC_LAUNCH = "false";

const db = require("../src/db");
const invoiceDb = require("../src/invoice_db");
const nuvion = require("../src/nuvion");
const nuvionWebhooks = require("../src/nuvion_webhooks");
const orchestrator = require("../src/nuvion_orchestrator");
const poller = require("../src/nuvion_poller");
const chains = require("../src/chains");
const gateway = require("../src/gateway");
const walletLib = require("../src/wallet");
const multichain = require("../src/multichain");
const tokens = require("../src/tokens");
const convState = require("../src/conversation_state");
convState.initStateTable();

function startPhase2MockNuvion() {
  const store = {
    entities: new Map(),
    accounts: new Map(),
    accountDetails: new Map(),
    counterparties: new Map(),
    paymentDetails: new Map(),
    fxQuotes: new Map(),
    transfers: new Map(),
    fundingSessions: new Map(),
    failFirstStablecoinOutflowOnce: false,
  };
  let seq = 1;
  const ulid = (p) => `01P2${p}${String(seq++).padStart(18, "0")}`.slice(0, 26);

  // FX rates to USC (2-decimal minor to 2-decimal minor ratio)
  const TO_USC_RATE = { GBP: 1.28, EUR: 1.09, USD: 1.0, CAD: 0.72, NGN: 0.000689655, KES: 0.0077 };

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

      // Accounts
      if (req.method === "POST" && pathname === "/accounts") {
        const id = ulid("AC");
        const acc = {
          id,
          entity_id: body.entity_id || "ROOT",
          type: body.type || "checking",
          currency: body.currency,
          display_name: body.display_name,
          nuvion_ban: `0020${String(seq).padStart(6, "0")}`,
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
        return send(200, { status: "success", data: { data: rows, meta: { pagination: { has_next: false } } } });
      }

      // Account Details
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
          account_number: isStable ? "0x555555555555555555555555555555555555BASE" : `8000${String(seq).padStart(6, "0")}`,
          iban: acc.currency === "GBP" ? "GB00NUVN04000480000001" : acc.currency === "EUR" ? "DE89370400440532013000" : null,
          routing_number: acc.currency === "USD" ? "026009593" : null,
          beneficiary_name: "Founder Global Ltd",
          status: "active",
          issuer: {
            name: isStable ? "BASE_MAINNET" : `${acc.currency} Partner Bank`,
            code: acc.currency === "GBP" ? "040004" : "BANK",
            scheme: acc.currency === "GBP" ? "sort_code" : "nuvion",
            meta: {
              bank_name: isStable ? "BASE_MAINNET" : `${acc.currency} Partner Bank`,
              sort_code: acc.currency === "GBP" ? "040004" : null,
              swift_code: acc.currency === "GBP" ? "NUVNGB22XXX" : null,
            },
          },
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

      const detMatch = pathname.match(/^\/account-details\/([^/]+)$/);
      if (req.method === "GET" && detMatch) {
        const det = store.accountDetails.get(detMatch[1]);
        if (!det) return send(404, { status: "error", type: "error_resource_not_found", message: "Not found" });
        return send(200, { status: "success", data: { account_detail: det } });
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

      // FX Quotes
      if (req.method === "POST" && pathname === "/fx-quotes") {
        const id = ulid("FX");
        const rate = TO_USC_RATE[body.from_currency] || 1;
        const amountFrom = body.amount_from || Math.round((body.amount_to || 1000) / rate);
        const amountTo = body.amount_to || Math.floor(amountFrom * rate);
        const q = {
          id,
          from: body.from_currency,
          to: body.to_currency,
          amount_from: amountFrom,
          amount_to: amountTo,
          rate,
          quote: { status: "active", expires_at: Date.now() + 180000, valid_for: 180, used_at: null, used_in_payment_id: null },
        };
        store.fxQuotes.set(id, q);
        return send(201, { status: "success", data: q });
      }

      // Transfers
      if (req.method === "POST" && pathname === "/transfers") {
        const acc = store.accounts.get(body.account_id);
        if (!acc) return send(404, { status: "error", type: "error_resource_not_found", message: "Account not found" });

        // Simulate rail fee causing insufficient funds once when requested by test
        if (body.payment_type === "stablecoin-transfer" && store.failFirstStablecoinOutflowOnce) {
          store.failFirstStablecoinOutflowOnce = false;
          return send(400, {
            status: "error",
            type: "error_transfer_insufficient_funds",
            message: "You don't have enough funds for this transfer including applicable fee.",
          });
        }

        if (acc.balance.available < body.amount) {
          return send(400, {
            status: "error",
            type: "error_transfer_insufficient_funds",
            message: `Insufficient balance: ${acc.balance.available}`,
          });
        }

        // Debit source account
        acc.balance.available -= body.amount;
        acc.balance.current -= body.amount;

        // If book-transfer, credit matching target nuvion_ban immediately
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

        if (body.fx_quote_id && store.fxQuotes.has(body.fx_quote_id)) {
          store.fxQuotes.get(body.fx_quote_id).quote.status = "used";
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
          unique_reference: body.unique_reference,
          payment_type: body.payment_type,
          fx_quote_id: body.fx_quote_id || null,
          narration: body.narration,
          type: "outflow",
          status: body.payment_type === "book-transfer" ? "successful" : "pending",
          applicable_fee: 0,
        };
        store.transfers.set(id, tx);
        return send(201, { status: "success", data: tx });
      }

      if (req.method === "GET" && pathname === "/transfers") {
        const ent = query.entity_id || "ROOT";
        const rows = [...store.transfers.values()].filter(
          (t) =>
            t.entity_id === ent &&
            (!query.type || t.type === query.type) &&
            (!query.payment_type || t.payment_type === query.payment_type) &&
            (!query.unique_reference || t.unique_reference === query.unique_reference)
        );
        return send(200, { status: "success", data: { data: rows } });
      }

      const txMatch = pathname.match(/^\/transfers\/([^/]+)$/);
      if (req.method === "GET" && txMatch) {
        const tx = store.transfers.get(txMatch[1]);
        if (!tx) return send(404, { status: "error", type: "error_resource_not_found", message: "Transfer not found" });
        return send(200, { status: "success", data: tx });
      }

      // Funding sessions
      if (req.method === "POST" && pathname === "/funding-sessions") {
        const id = ulid("FS");
        const sess = {
          id,
          entity_id: body.entity_id || "ROOT",
          account_id: body.account_id,
          amount: body.amount,
          currency: body.currency,
          unique_reference: body.unique_reference,
          status: "awaiting_user",
          funding_type: body.funding_type || "open-banking",
          checkout_url: (!body.funding_type || body.funding_type === "open-banking") ? `https://app.nuvion.dev/checkout/${id}` : undefined,
          reference_number: body.funding_type === "interac" ? `CA${String(seq).padStart(10, "0")}` : undefined,
          meta: body.meta || {},
        };
        store.fundingSessions.set(id, sess);
        return send(201, { status: "success", data: sess });
      }

      const fsMatch = pathname.match(/^\/funding-sessions\/([^/]+)$/);
      if (fsMatch) {
        const sess = store.fundingSessions.get(fsMatch[1]);
        if (!sess) return send(404, { status: "error", type: "error_resource_not_found", message: "Session not found" });
        if (req.method === "PATCH") {
          if (sess.status === "awaiting_user") sess.status = "processing";
          else if (sess.status === "processing") {
            sess.status = "settled";
            // Credit account + record settled inflow transfer
            const acc = store.accounts.get(sess.account_id);
            if (acc) {
              acc.balance.available += sess.amount;
              acc.balance.current += sess.amount;
            }
            const inflowId = ulid("IN");
            store.transfers.set(inflowId, {
              id: inflowId,
              entity_id: sess.entity_id,
              account_id: sess.account_id,
              amount: sess.amount,
              currency: sess.currency,
              unique_reference: sess.unique_reference,
              type: "inflow",
              payment_type: "funding-session",
              status: "successful",
              applicable_fee: 0,
              narration: "Interac settled deposit",
              meta: { funding_session_id: sess.id, funding_type: "interac" },
            });
          } else {
            return send(400, { status: "error", type: "error_funding_request_not_pending", message: "Final state" });
          }
          return send(201, { status: "success", data: sess });
        }
        if (req.method === "GET") return send(200, { status: "success", data: sess });
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

test("Phase 2: Unified Balance sums Arc + Base + Circle Gateway + Solana seamlessly", async () => {
  const orig = {
    getNativeBalanceMicro: walletLib.getNativeBalanceMicro,
    getUsdcBalance: walletLib.getUsdcBalance,
    getSplTokenBalance: multichain.getSplTokenBalance,
    getEurcBalance: tokens.getEurcBalance,
    getUnifiedGatewayUsdc: gateway.getUnifiedGatewayUsdc,
  };
  process.env.ENABLE_BASE_BALANCE_READ = "true";

  try {
    walletLib.getNativeBalanceMicro = async () => walletLib.parseToMicro("100");
    walletLib.getUsdcBalance = async () => "45.50";
    gateway.getUnifiedGatewayUsdc = async () => 25.00;
    multichain.getSplTokenBalance = async () => ({ uiAmount: 10.25 });
    tokens.getEurcBalance = async () => 0n;

    const user = {
      telegram_id: 888111222,
      deposit_address: "0x1111111111111111111111111111111111111111",
      solana_deposit_address: "SolTestAddr1111111111111111111111111111111",
    };

    // Base address matches Arc 0x address identically
    assert.equal(chains.deriveAddress(user, "personal", "base"), user.deposit_address);

    const bal = await chains.getUnifiedBalance(user, "personal");
    assert.equal(bal.arc.usdc, 100);
    assert.equal(bal.base.usdc, 45.5);
    assert.equal(bal.gateway.usdc, 25);
    assert.equal(bal.solana.usdc, 10.25);
    assert.equal(bal.total, 180.75, "Unified total must combine Arc + Base + Circle Gateway + Solana");
  } finally {
    delete process.env.ENABLE_BASE_BALANCE_READ;
    walletLib.getNativeBalanceMicro = orig.getNativeBalanceMicro;
    walletLib.getUsdcBalance = orig.getUsdcBalance;
    multichain.getSplTokenBalance = orig.getSplTokenBalance;
    tokens.getEurcBalance = orig.getEurcBalance;
    gateway.getUnifiedGatewayUsdc = orig.getUnifiedGatewayUsdc;
  }
});

test("Phase 2: Bidirectional Circle Gateway signs valid EIP-712 BurnIntents (Arc <-> Base)", async () => {
  const signer = Wallet.createRandom();
  const recipient = Wallet.createRandom().address;

  const arcToBase = await gateway.buildSignedBurnIntentBidirectional(signer, {
    sourceChain: "Arc",
    destinationChain: "Base",
    amountUsdc: 50,
    recipientAddress: recipient,
  });
  assert.equal(arcToBase.burnIntent.spec.sourceDomain, gateway.ARC_DOMAIN_ID);
  assert.equal(arcToBase.burnIntent.spec.destinationDomain, 6);
  assert.ok(arcToBase.signature.startsWith("0x") && arcToBase.signature.length > 100);

  const baseToArc = await gateway.buildSignedBurnIntentBidirectional(signer, {
    sourceChain: "Base",
    destinationChain: "Arc",
    amountUsdc: 25.5,
    recipientAddress: recipient,
  });
  assert.equal(baseToArc.burnIntent.spec.sourceDomain, 6);
  assert.equal(baseToArc.burnIntent.spec.destinationDomain, gateway.ARC_DOMAIN_ID);
});

test("Phase 2: Global Receiving Accounts + Inbound 1% FX Margin Auto-Sweep to Base 0x + Invoice Paid + Naira-Only Receipt", async () => {
  const mock = await startPhase2MockNuvion();
  process.env.NUVION_BASE_URL = mock.baseUrl;
  orchestrator._clearParentAccountCache();
  orchestrator.registerOrchestratorHooks();

  try {
    const tgId = 888111222;
    const w = walletLib.generateUserWallet();
    db.createUserWithWallet(tgId, "global_founder", w.address, w.privateKey, "1234");

    const entityId = "01P2ENT_APPROVED_FOUNDER01";
    db.upsertNuvionEntity({
      telegramId: tgId,
      accountType: "personal",
      entityId,
      entityType: "individual",
      legalName: "Founder Global Ltd",
      email: "founder@global.com",
      status: "approved",
    });

    // Bootstrap Base bridge (USC account + Self-Counterparty on BASE_MAINNET -> w.address)
    await nuvionWebhooks.bootstrapApprovedEntity(db.getNuvionEntityByEntityId(entityId));

    // 1. Provision permanent named GBP & NGN receiving accounts
    const gbpRes = await orchestrator.provisionGlobalReceivingAccount(tgId, "personal", "GBP");
    assert.equal(gbpRes.isPending, false);
    assert.equal(gbpRes.detail.currency, "GBP");
    assert.equal(gbpRes.detail.iban, "GB00NUVN04000480000001");
    assert.equal(gbpRes.detail.sort_code, "040004");

    // Second call returns cached permanent detail without calling POST again
    const gbpCached = await orchestrator.provisionGlobalReceivingAccount(tgId, "personal", "GBP");
    assert.equal(gbpCached.cached, true);
    assert.equal(gbpCached.detail.detail_id, gbpRes.detail.detail_id);

    const ngnRes = await orchestrator.provisionGlobalReceivingAccount(tgId, "personal", "NGN");
    assert.equal(ngnRes.detail.currency, "NGN");

    // 2. Create an unpaid invoice that matches the incoming GBP payment narration
    const invRowId = invoiceDb.createInvoice(tgId, {
      invoiceNumber: "INV-GLOB-01",
      clientName: "UK Client Ltd",
      items: [{ description: "Consulting", amount: 630 }],
      totalUsdc: 630,
      walletAddress: w.address,
    });

    // 3. Simulate £500.00 (50000 minor) arriving into user's Nuvion GBP account
    const gbpAcc = mock.store.accounts.get(gbpRes.account.account_id);
    gbpAcc.balance.available = 50000;
    gbpAcc.balance.current = 50000;
    const inflowId = "01P2INFLOW_GBP_500";
    mock.store.transfers.set(inflowId, {
      id: inflowId,
      entity_id: entityId,
      account_id: gbpAcc.id,
      amount: 50000,
      currency: "GBP",
      type: "inflow",
      payment_type: "bank-transfer",
      status: "successful",
      applicable_fee: 0,
      narration: "Payment for INV-GLOB-01",
    });

    const tgAlerts = [];
    const fakeBot = {
      telegram: {
        sendPhoto: async (chatId, _photo, opts) => tgAlerts.push({ chatId, kind: "photo", caption: opts.caption }),
        sendMessage: async (chatId, text) => tgAlerts.push({ chatId, kind: "text", caption: text }),
      },
    };

    // Fire webhook inflows.completed -> confirm state -> 1% margin book-transfer -> FX quote -> Base USC sweep!
    await nuvionWebhooks.processNuvionEvent(
      { event: "inflows.completed", data: { id: inflowId, entity_id: entityId, account_id: gbpAcc.id, currency: "GBP", amount: 50000 } },
      { "x-nuvion-event-id": "evt_gbp_500_in" },
      fakeBot
    );

    // Zero idle balance left in user's Nuvion GBP account!
    assert.equal(gbpAcc.balance.available, 0, "User Nuvion GBP balance must sweep down to 0.00!");

    // Proxim Root Parent operational GBP account received exact 1% FX margin (£5.00 = 500 minor)!
    const parentGbp = [...mock.store.accounts.values()].find((a) => a.entity_id === "ROOT" && a.currency === "GBP");
    assert.ok(parentGbp, "Parent operational GBP account must be created for FX margin");
    assert.equal(parentGbp.balance.available, 500, "Parent must collect exact 1% FX margin (500 minor = £5.00)");

    // Outbound stablecoin-transfer fired on BASE_MAINNET straight to user's own 0x EOA
    const stableTx = [...mock.store.transfers.values()].find((t) => t.payment_type === "stablecoin-transfer" && t.currency === "GBP");
    assert.ok(stableTx, "Must fire stablecoin-transfer to Base");
    assert.equal(stableTx.amount, 49500, "Remaining £495.00 (49500 minor) must be converted and fired to user wallet");
    const targetPd = mock.store.paymentDetails.get(stableTx.payment_detail_id);
    assert.equal(targetPd.blockchain_network, "BASE_MAINNET");
    assert.equal(targetPd.wallet_address, w.address);

    // Linked invoice automatically marked PAID!
    const invAfter = invoiceDb.getInvoice(invRowId);
    assert.equal(invAfter.status, "paid", "Linked invoice INV-GLOB-01 must auto-mark paid");

    // User received HD receipt photo alert
    assert.ok(tgAlerts.some((a) => a.chatId === tgId && a.caption.includes("£500.00") && a.caption.includes("INV-GLOB-01")));

    // 4. Simulate ₦100,000 NGN deposit + test fee-buffer retry on 400 error_transfer_insufficient_funds!
    const ngnAcc = mock.store.accounts.get(ngnRes.account.account_id);
    ngnAcc.balance.available = 10000000; // ₦100,000.00
    ngnAcc.balance.current = 10000000;
    mock.store.failFirstStablecoinOutflowOnce = true;

    const ngnInflowId = "01P2INFLOW_NGN_100K";
    mock.store.transfers.set(ngnInflowId, {
      id: ngnInflowId,
      entity_id: entityId,
      account_id: ngnAcc.id,
      amount: 10000000,
      currency: "NGN",
      type: "inflow",
      payment_type: "bank-transfer",
      status: "successful",
      applicable_fee: 0,
      narration: "Lagos client transfer",
    });

    await nuvionWebhooks.processNuvionEvent(
      { event: "inflows.completed", data: { id: ngnInflowId, entity_id: entityId, account_id: ngnAcc.id, currency: "NGN", amount: 10000000 } },
      { "x-nuvion-event-id": "evt_ngn_100k_in" },
      fakeBot
    );

    const parentNgn = [...mock.store.accounts.values()].find((a) => a.entity_id === "ROOT" && a.currency === "NGN");
    assert.equal(parentNgn.balance.available, 100000, "Parent must collect 1% NGN margin (₦1,000 = 100000 kobo)");

    // Verify Naira-only display on NGN deposit alert (no $ USD shown!)
    const ngnAlert = tgAlerts[tgAlerts.length - 1];
    assert.ok(ngnAlert.caption.includes("₦100,000"), "NGN alert must show Naira amount");
    assert.ok(!ngnAlert.caption.includes("Credited to Balance: $"), "NGN deposit alert must stay Naira-only");

    // 5. Hosted Payment Links (Open Banking GBP, M-Pesa KES, Interac CAD + 3-min PATCH poller -> auto-sweep!)
    const obRes = await orchestrator.createHostedPaymentLink({
      telegramId: tgId,
      accountType: "personal",
      currency: "GBP",
      amountMajor: 120,
      fundingType: "open-banking",
      narration: "Design sprint",
    });
    assert.ok(obRes.session.checkout_url.includes("https://app.nuvion.dev/checkout/"));

    const momoRes = await orchestrator.createHostedPaymentLink({
      telegramId: tgId,
      accountType: "personal",
      currency: "KES",
      amountMajor: 5000,
      fundingType: "momo",
      msisdn: "254712345678",
      momoChannel: "KE-SAFARICOM-C2B",
      narration: "Nairobi payment",
    });
    assert.equal(momoRes.session.currency, "KES");

    const interacRes = await orchestrator.createHostedPaymentLink({
      telegramId: tgId,
      accountType: "personal",
      currency: "CAD",
      amountMajor: 200,
      fundingType: "interac",
      payerName: "Élodie Tremblay!", // Tests ASCII sanitization!
      payerEmail: "elodie@canada.ca",
      narration: "Logo!",
    });
    assert.ok(interacRes.session.reference_number.startsWith("CA"));

    // Poll 1: awaiting_user -> processing
    const p1 = await poller.pollInteracSessionsOnce(fakeBot);
    assert.equal(p1[0].status, "processing");

    // Poll 2: processing -> settled -> reconciles inflow -> 1% CAD margin + Base USC sweep!
    const p2 = await poller.pollInteracSessionsOnce(fakeBot);
    assert.equal(p2[0].status, "settled");
    const cadAcc = [...mock.store.accounts.values()].find((a) => a.entity_id === entityId && a.currency === "CAD");
    assert.equal(cadAcc.balance.available, 0, "Settled CAD Interac funds must auto-sweep down to 0.00!");
    const parentCad = [...mock.store.accounts.values()].find((a) => a.entity_id === "ROOT" && a.currency === "CAD");
    assert.equal(parentCad.balance.available, 200, "Parent must collect 1% CAD margin (CA$2.00 = 200 cents)");
  } finally {
    mock.server.close();
  }
});

test.after(() => {
  try { fs.unlinkSync(tmpDbPath); } catch (_) {}
});
