// tests/app_api_new_features.test.js
// Verifies:
//   1. Deposit currency tracking & display metadata (Paj NGN, Nuvion NGN, Nuvion international GBP/EUR, Crypto)
//   2. Savings pool selection, Auto-Save highest-APY selection, and 10% platform fee calculation & routing
//   3. Pods Finance Stocks API (logos, live market open/closed clock, chart + entry vs present, buy/sell prepare)
//   4. Invoice payment options (Nuvion fiat + NEAR Intents crypto) & downloadable PNG invoice endpoints

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxim-new-feat-"));
process.env.PAYIT_DB_PATH = path.join(tmpDir, "test.db");
process.env.APP_JWT_SECRET = "test-jwt-secret-must-be-at-least-32-chars-long-0001";
process.env.INVOICE_FORWARDING_SECRET = "test-invoice-forwarding-secret-32chars-0001";
process.env.NODE_ENV = "test";
process.env.PAYIT_TEST_MODE = "true";

const db = require("../src/db");
const walletLib = require("../src/wallet");
const savings = require("../src/savings");
const autoEarn = require("../src/auto_earn");
const routes = require("../src/app_api/routes");
const features = require("../src/app_api/features");
const actions = require("../src/app_api/actions");
const stocks = require("../src/app_api/stocks");
const store = require("../src/app_api/store");
const tokens = require("../src/app_api/tokens");
const podsStore = require("../src/pods_store");
const invoiceDb = require("../src/invoice_db");

const TG_ID = 778899001;
const OTHER_TG_ID = 778899002;
const PIN = "4829";
let server;
let baseUrl;
let accessToken;

function reqJson(method, p, body = null, token = accessToken) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + p);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const ct = String(res.headers["content-type"] || "");
          let json = null;
          if (ct.includes("application/json")) {
            try { json = JSON.parse(buf.toString("utf8")); } catch (_) {}
          }
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: buf });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test.before(async () => {
  store.ensureAppSchema();
  invoiceDb.initInvoiceTables();
  const { Wallet } = require("ethers");
  const w1 = Wallet.createRandom();
  const w2 = Wallet.createRandom();
  db.createUserWithWallet(TG_ID, "alice_feat", w1.address, w1.privateKey, PIN);
  db.createUserWithWallet(OTHER_TG_ID, "bob_feat", w2.address, w2.privateKey, PIN);

  const deviceId = "dev_test_features_000001";
  store.upsertDevice({ deviceId, telegramId: TG_ID, platform: "android", deviceName: "Pixel Test" });
  accessToken = tokens.issueAccessToken({ telegramId: TG_ID, deviceId }).accessToken;

  server = http.createServer((req, res) => routes.handleAppApiRequest(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  actions.__setTestDeps({});
  features.__setTestDeps({});
  stocks.__setTestDeps({});
  if (server) await new Promise((r) => server.close(r));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test("1. Deposit currency tracking: Paj NGN, Nuvion international GBP/EUR, and Crypto display metadata", async () => {
  const amt100 = walletLib.parseToMicro("100.000000");
  // Paj Naira deposit
  db.recordTransaction(TG_ID, "deposit_naira", amt100, "confirmed", "0xpaj_ngn_1", "personal", 18, "arc", "Wema bank funding", {
    sourceCurrency: "NGN",
    sourceAmount: 155000,
    depositChannel: "naira",
  });
  // Nuvion international GBP deposit
  db.recordTransaction(TG_ID, "deposit_fiat", amt100, "confirmed", "nuv_gbp_1", "personal", 18, "base", "GBP deposit", {
    sourceCurrency: "GBP",
    sourceAmount: 78.5,
    depositChannel: "international",
  });
  // Nuvion Naira deposit
  db.recordTransaction(TG_ID, "deposit_naira", amt100, "confirmed", "nuv_ngn_1", "personal", 18, "base", "NGN deposit", {
    sourceCurrency: "NGN",
    sourceAmount: 158000,
    depositChannel: "naira",
  });
  // Crypto deposit
  db.recordTransaction(TG_ID, "deposit_crypto", amt100, "confirmed", "0xcrypto_1", "personal", 18, "base", "Base USDC deposit", {
    sourceCurrency: "USDC",
    sourceAmount: 100,
    depositChannel: "crypto",
  });

  const res = await reqJson("GET", "/api/app/v1/transactions?limit=10");
  assert.equal(res.status, 200);
  const txs = res.body.transactions;
  const pajNgn = txs.find((t) => t.txHash === "0xpaj_ngn_1");
  const nuvGbp = txs.find((t) => t.txHash === "nuv_gbp_1");
  const nuvNgn = txs.find((t) => t.txHash === "nuv_ngn_1");
  const cryptoTx = txs.find((t) => t.txHash === "0xcrypto_1");

  assert.equal(pajNgn.depositChannel, "naira");
  assert.equal(pajNgn.fiatCurrency, "NGN");
  assert.equal(pajNgn.fiatAmount, 155000);

  assert.equal(nuvGbp.depositChannel, "international");
  assert.equal(nuvGbp.fiatCurrency, "GBP");
  assert.equal(nuvGbp.fiatAmount, 78.5);

  assert.equal(nuvNgn.depositChannel, "naira");
  assert.equal(nuvNgn.fiatCurrency, "NGN");
  assert.equal(nuvNgn.fiatAmount, 158000);

  assert.equal(cryptoTx.depositChannel, "crypto");
  assert.equal(cryptoTx.fiatCurrency, null);
});

test("2. Savings: user picks vault before deposit, Auto-Save selects highest APY, and 10% platform fee is applied", async () => {
  const mockPools = [
    {
      symbol: "USDC",
      project: "Flowmark USDC Turbo",
      vaultAddress: "0xbd69ce1b1027e932158aa96a873a91c41cb729f9",
      rawApy: 4.8,
      userApy: 4.32,
      payitApy: 0.48,
      totalDeposits: "500000",
    },
    {
      symbol: "USDC",
      project: "Steakhouse Prime USDC",
      vaultAddress: "0xa8fd51b78370c7ca948566d7ba97d252bc325124",
      rawApy: 6.0,
      userApy: 5.4,
      payitApy: 0.6,
      totalDeposits: "1200000",
    },
    {
      symbol: "EURC",
      project: "Gauntlet EURC Prime",
      vaultAddress: "0x85894c0b83e564bb44854bda5991b05ccf88831e",
      rawApy: 7.0,
      userApy: 6.3,
      payitApy: 0.7,
      totalDeposits: "300000",
    },
  ];

  // Auto-Save MUST pick the highest-APY USDC pool (Steakhouse 5.4%, NOT Flowmark 4.32% and NOT EURC)
  const autoChoice = autoEarn.selectHighestApyPool(mockPools);
  assert.equal(autoChoice.vaultAddress, "0xa8fd51b78370c7ca948566d7ba97d252bc325124");

  // 10% platform fee breakdown verification
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const breakdown = savings.calcYieldBreakdown({
    amount_usdc: 1000,
    apy: 6.0,
    user_apy: 5.4,
    payit_fee_apy: 0.6,
    opened_at: oneYearAgo,
  });
  assert.equal(breakdown.feePct, 10);
  assert.ok(Math.abs(breakdown.grossYield - 60) < 0.2, `gross=${breakdown.grossYield}`);
  assert.ok(Math.abs(breakdown.devFee - 6) < 0.05, `fee=${breakdown.devFee}`);
  assert.ok(Math.abs(breakdown.netYield - 54) < 0.2, `net=${breakdown.netYield}`);

  // Also test on-chain redeemed profit fee calculation (e.g. $20 real vault profit -> $2 platform fee, $18 net)
  const realBreakdown = savings.calcYieldBreakdown({ amount_usdc: 1000, apy: 6.0, opened_at: new Date().toISOString() }, 20);
  assert.equal(realBreakdown.grossYield, 20);
  assert.equal(realBreakdown.devFee, 2);
  assert.equal(realBreakdown.netYield, 18);

  // GET /savings lists pools sorted by APY with isHighestApy & platformFeePct=10
  features.__setTestDeps({
    savings: { ...savings, getYieldPools: async () => mockPools },
  });
  const savRes = await reqJson("GET", "/api/app/v1/savings");
  assert.equal(savRes.status, 200);
  assert.equal(savRes.body.platformFeePct, 10);
  const topPool = savRes.body.pools.find((p) => p.isHighestApy);
  assert.equal(topPool.vaultAddress, "0xa8fd51b78370c7ca948566d7ba97d252bc325124");

  // savings.deposit respects the exact vaultAddress chosen by the user (e.g. Flowmark, NOT default Steakhouse)
  actions.__setTestDeps({
    savings: { ...savings, getYieldPools: async () => mockPools },
  });
  const user = db.getUser(TG_ID);
  const prepared = await actions.ACTIONS["savings.deposit"].prepare(
    { telegramId: TG_ID, user },
    { amountUsdc: 50, vaultAddress: "0xbd69ce1b1027e932158aa96a873a91c41cb729f9" }
  );
  assert.equal(prepared.action.vaultAddress, "0xbd69ce1b1027e932158aa96a873a91c41cb729f9");
  assert.equal(prepared.action.vaultName, "Flowmark USDC Turbo");
  // UI summary displays the net APY cleanly (4.32%) without showing a separate 10% platform fee line
  assert.ok(prepared.summary.lines.some(([k, v]) => /apy/i.test(k) && /4\.32%/.test(v)));
  assert.ok(!prepared.summary.lines.some(([k]) => /platform fee/i.test(k)));

  // Rejects unknown vault address
  await assert.rejects(
    () => actions.ACTIONS["savings.deposit"].prepare({ telegramId: TG_ID, user }, { amountUsdc: 50, vaultAddress: "0x0000000000000000000000000000000000000bad" }),
    (err) => err.code === "invalid_vault"
  );
});

test("3. Pods Stocks API: official logos, market open/closed clock, and bought vs present position", async () => {
  const user = db.getUser(TG_ID);
  podsStore.recordPodsAction({
    telegramId: TG_ID,
    accountType: "personal",
    walletAddress: user.deposit_address,
    kind: "stock_buy",
    strategyId: "Ondo-AAPL-bsc",
    ticker: "AAPL",
    amountUsd: 100,
    txHash: "0xstock_buy_aapl_1",
    podsActionId: "pods_act_aapl_1",
    status: "SUCCESS",
    meta: { priceAtOrder: 200.0 },
  });

  stocks.__setTestDeps({
    pods: {
      MIN_STOCK_BUY_USD: 10,
      POPULAR_STOCKS: [{ ticker: "AAPL", name: "Apple Inc." }, { ticker: "NVDA", name: "NVIDIA Corp." }],
      isConfigured: () => true,
      isInvestmentsEnabledForUser: () => true,
      normalizeTicker: (t) => String(t).toUpperCase(),
      toOndoStrategyId: (t) => `Ondo-${String(t).toUpperCase()}-bsc`,
      searchStocks: async () => [
        { id: "Ondo-AAPL-bsc", ticker: "AAPL", name: "Apple Inc.", network: "bsc", paused: false },
        { id: "Ondo-NVDA-bsc", ticker: "NVDA", name: "NVIDIA Corp.", network: "bsc", paused: false },
      ],
      getStockMarketStatus: async (tk) => ({
        ticker: tk,
        isOpen: true,
        marketStatus: "open",
        nextOpen: null,
        nextClose: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
        tradable: true,
        paused: false,
        price: 250.0,
        priceChangePct24h: 2.45,
      }),
      getStrategyPosition: async () => ({
        currentPosition: 0.5,
        currentPositionUsd: 125.0,
        avgPurchasePrice: 200.0,
        profit: 25.0,
      }),
    },
    features: { getLiveUsdNgnRate: async () => 1500 },
  });

  const listRes = await reqJson("GET", "/api/app/v1/stocks");
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.market.isOpen, true);
  assert.equal(listRes.body.market.label, "Market Open");
  assert.ok(listRes.body.market.hoursLabel.includes("9:30 AM"));
  const aapl = listRes.body.stocks.find((s) => s.ticker === "AAPL");
  assert.ok(aapl.logoUrl.includes("AAPL"));
  assert.ok(aapl.fallbackLogoUrl.includes("apple.com"));
  assert.equal(listRes.body.portfolio.holdings.length, 1);
  assert.equal(listRes.body.portfolio.holdings[0].avgBuyPrice, 200);
  assert.equal(listRes.body.portfolio.holdings[0].currentValueUsd, 125);
  assert.equal(listRes.body.portfolio.holdings[0].pnlUsd, 25);

  const detailRes = await reqJson("GET", "/api/app/v1/stocks/AAPL/chart?range=1M");
  assert.equal(detailRes.status, 200);
  assert.equal(detailRes.body.stock.ticker, "AAPL");
  assert.equal(detailRes.body.position.avgBuyPrice, 200);
  assert.equal(detailRes.body.position.currentPrice, 250);
  assert.equal(detailRes.body.position.purchases.length, 1);
  assert.equal(detailRes.body.market.isOpen, true);
});

test("4. Invoices: payment options (Nuvion fiat + NEAR Intents crypto) & downloadable PNG", async () => {
  features.__setTestDeps({
    near: {
      getTokenLogoUrl: (s) => `https://cdn.example/${s}.png`,
      getAllSupportedIntentTokens: async () => ({
        chains: [{ key: "sol", name: "Solana", short: "SOL", isEvm: false, priority: 1, logoUrl: null, tokenCount: 1 }],
        tokensByChain: {
          sol: [{ symbol: "USDC", name: "USD Coin", assetId: "nep141:sol-usdc", decimals: 6, blockchain: "sol", priceUsd: 1 }],
        },
      }),
    },
  });

  const optsRes = await reqJson("GET", "/api/app/v1/invoices/options");
  assert.equal(optsRes.status, 200);
  assert.ok(optsRes.body.fiatCurrencies.some((f) => f.currency === "NGN"));
  assert.ok(optsRes.body.fiatCurrencies.some((f) => f.currency === "GBP"));
  assert.ok(optsRes.body.cryptoChains.some((c) => c.key === "sol"));

  // Create a personal invoice in DB and verify both direct PNG download and signed download-link work!
  const user = db.getUser(TG_ID);
  const invId = invoiceDb.createInvoice(TG_ID, {
    invoiceNumber: "INV-TEST-001",
    clientName: "Acme Corp",
    clientEmail: "billing@acme.test",
    items: [{ description: "Product design", quantity: 1, unitPrice: 250 }],
    totalUsdc: 250,
    dueDate: "2026-12-15",
    notes: "Thanks for your business",
    walletAddress: user.deposit_address,
    pngPath: null,
  });

  // Direct authenticated download generates & streams real PNG bytes
  const dlRes = await reqJson("GET", `/api/app/v1/invoices/${invId}/download`);
  assert.equal(dlRes.status, 200);
  assert.ok(String(dlRes.headers["content-type"]).includes("image/png"));
  // PNG magic header bytes: 89 50 4E 47
  assert.equal(dlRes.raw[0], 0x89);
  assert.equal(dlRes.raw[1], 0x50);
  assert.equal(dlRes.raw[2], 0x4e);
  assert.equal(dlRes.raw[3], 0x47);

  // Signed download link works without Authorization header
  const linkRes = await reqJson("POST", `/api/app/v1/invoices/${invId}/download-link`, {});
  assert.equal(linkRes.status, 200);
  assert.ok(linkRes.body.path.startsWith(`/invoice-files/personal/${invId}?`));

  const signedRes = await reqJson("GET", `/api/app/v1${linkRes.body.path}`, null, null);
  assert.equal(signedRes.status, 200);
  assert.equal(signedRes.raw[0], 0x89);

  // Tampered signature must be rejected (403)
  const badRes = await reqJson("GET", `/api/app/v1${linkRes.body.path}tampered`, null, null);
  assert.equal(badRes.status, 403);
});

test("5. Global corridors: all 27 currencies with distinct currency-specific bank fields (no US default or * wildcard)", async () => {
  features.__setTestDeps({});
  const res = await reqJson("GET", "/api/app/v1/global/corridors");
  assert.equal(res.status, 200);
  const { corridors, rails } = res.body;
  assert.ok(Array.isArray(corridors) && corridors.length >= 25, `corridors=${corridors?.length}`);
  assert.ok(!rails.some((r) => r.currency === "*"), "wildcard '*' currency must never be exposed");

  const gbp = corridors.find((c) => c.currency === "GBP");
  const eur = corridors.find((c) => c.currency === "EUR");
  const usd = corridors.find((c) => c.currency === "USD");
  const cad = corridors.find((c) => c.currency === "CAD");
  const ghs = corridors.find((c) => c.currency === "GHS");
  const jpy = corridors.find((c) => c.currency === "JPY");
  assert.ok(gbp && eur && usd && cad && ghs && jpy);

  // GBP primary rail uses Sort Code + UK 8-digit Account Number (NOT US routing number)
  const gbpFields = gbp.rails[0].requiredFields.map((f) => f.key);
  assert.ok(gbpFields.includes("sort_code"));
  assert.ok(!gbpFields.includes("routing_number"));

  // EUR primary rail uses SEPA IBAN + SWIFT/BIC
  const eurFields = eur.rails[0].requiredFields.map((f) => f.key);
  assert.ok(eurFields.includes("iban"));
  assert.ok(eurFields.includes("swift_bic"));

  // USD primary rail uses ABA Routing Number + US Bank Address
  const usdFields = usd.rails[0].requiredFields.map((f) => f.key);
  assert.ok(usdFields.includes("routing_number"));
  assert.ok(usdFields.includes("bank_address_line1"));

  // CAD offers Interac Email (just name + email) as well as bank EFT
  const cadEmailRail = cad.rails.find((r) => r.railKey === "cad_interac_email");
  assert.deepEqual(cadEmailRail.requiredFields.map((f) => f.key), ["account_holder_name", "email"]);

  // GHS Mobile Money rail carries selectable network options
  const ghsMomo = ghs.rails.find((r) => r.railKey === "ghs_momo");
  const schemeField = ghsMomo.requiredFields.find((f) => f.key === "scheme");
  assert.ok(Array.isArray(schemeField.options) && schemeField.options.includes("mtn"));

  // SWIFT-only currency JPY has SWIFT rails available
  assert.ok(jpy.rails.length >= 2);
});
