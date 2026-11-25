// tests/app_api_features.test.js
// Comprehensive end-to-end tests for Phase 2 Mobile App API (/api/app/v1/*):
//   - All passkey + PIN money actions (/actions/:type/intent, /actions/confirm, /transfers/*)
//   - Persistent DB schedules (runner, date math, double-pay prevention, 3-failure auto-pause)
//   - All non-money endpoints (profile, contacts, user lookup, banks, NGN & crypto NEAR deposits,
//     global accounts, cards, bill providers, schedules, rewards, KYC status, savings, business
//     home/invoices/payment links, assistant, statement CSV)

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const tmpDb = path.join(os.tmpdir(), `app_api_features_test_${process.pid}_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = tmpDb;
process.env.INVOICE_FORWARDING_SECRET = "app-api-features-secret-not-real-0000";
process.env.APP_JWT_SECRET = "app-api-features-jwt-secret-not-real-0123456789";
process.env.APP_RP_ID = "proxim.test";
process.env.APP_ORIGINS = "https://proxim.test";
process.env.APP_INTEGRITY_MODE = "log";

const db = require("../src/db");
const realWallet = require("../src/wallet");
const routes = require("../src/app_api/routes");
const schedules = require("../src/app_api/schedules");
const { SoftAuthenticator } = require("./helpers/soft_authenticator");

const calls = {
  sentOnchain: [],
  sentSolana: [],
  notifications: [],
  pajOfframp: [],
  globalPayouts: [],
  bills: [],
  savingsDeposits: [],
  savingsWithdraws: [],
  cardsIssued: [],
  cardsFrozen: [],
  payrolls: [],
  invoicesCreated: [],
};
let fraudBlock = null;

routes.__setTestDeps({
  otp: {
    sendOtp: async () => ({ pinId: "pin-f" }),
    verifyOtp: async (_pinId, code) => code === "4821",
  },
  notify: async (telegramId, msg) => {
    calls.notifications.push({ telegramId, ...msg });
    return { telegram: true, push: 0 };
  },
  chains: {
    getUnifiedBalance: async (_user, accountType) => ({
      total: accountType === "business" ? "2450.00" : "512.75",
      arc: { usdc: accountType === "business" ? "2450.00" : "512.75", eurc: "0" },
      solana: { usdc: "0" },
      pendingNear: "0",
    }),
  },
  fraudGuard: {
    isUserTier1Approved: (tgId, acct) => {
      const ent = db.getNuvionEntityByUser(tgId, acct || "personal");
      return String(ent?.status || "").toLowerCase() === "approved";
    },
    getVelocityConfig: () => ({
      tier0HourlyLimitUsd: 300,
      tier0DailyLimitUsd: 500,
      tier1HourlyLimitUsd: 10000,
      tier1DailyLimitUsd: 25000,
      tier1BizDailyLimitUsd: 100000,
    }),
    getUserOutboundStats: () => ({ txCount10m: 1, usd10m: 25, txCount1h: 2, usd1h: 40, txCount24h: 3, usd24h: 120 }),
    assertOutboundAllowed: async () => { if (fraudBlock) throw new Error(fraudBlock); },
  },
  walletLib: {
    ...realWallet,
    sendSponsoredOrDirectTransaction: async (signer, to, amountMicro) => {
      calls.sentOnchain.push({ from: signer.address, to, amountMicro: String(amountMicro) });
      return { txHash: `0x${String(calls.sentOnchain.length).padStart(64, "a")}`, sponsored: true };
    },
  },
  multichain: {
    isSolanaAddress: (addr) => typeof addr === "string" && !addr.startsWith("0x") && addr.length >= 32,
    deriveSolanaFromEvmKey: () => ({ address: "So1anaDerivedAddr11111111111111111111111111", keypair: { pub: "sol" } }),
    sendSolanaTransfer: async (p) => {
      calls.sentSolana.push(p);
      return { txHash: `solsig_${calls.sentSolana.length}` };
    },
  },
  paj: {
    isArcOnrampEnabled: () => true,
    getRates: async () => ({ onRampRate: { rate: 1580 }, offRampRate: { rate: 1550 } }),
    getBanks: async () => [
      { code: "000013", name: "GTBank", country: "NG", logo: "https://cdn.example/gtb.png" },
      { code: "090267", name: "Kuda Bank", country: "NG", logo: "https://cdn.example/kuda.png" },
    ],
    searchBankAccount: async ({ accountNumber, bankCode }) => {
      if (accountNumber === "0123456789" && bankCode === "000013") {
        return [{ accountName: "ADAORA OKAFOR", bank: { code: "000013", name: "GTBank" } }];
      }
      return [];
    },
    registerPermanentBankAccount: async (bankCode, accountNumber) => {
      if (accountNumber === "9999999999") throw new Error("Invalid account number");
      return { accountName: "CHUKWUMA EZE", bank: { code: bankCode, name: "Kuda Bank" } };
    },
    createOnrampOrder: async (params) => ({
      id: "onramp_ord_123",
      status: "pending",
      amount: Number((params.fiatAmount / 1580).toFixed(2)),
      fiatAmount: params.fiatAmount,
      rate: 1580,
      bank: "Providus Bank",
      accountNumber: "9012345678",
      accountName: "PROXIM / TEST USER",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }),
    getOnrampOrder: async (id) => id === "onramp_ord_123" ? { id, status: "completed", fiatAmount: 50000 } : null,
    createOfframpPayout: async (params) => {
      calls.pajOfframp.push(params);
      const amtUsdc = params.fiatAmount ? Number((params.fiatAmount / 1550).toFixed(6)) : params.amountUsdc;
      const fiatAmt = params.fiatAmount ? Math.round(params.fiatAmount) : Math.round(params.amountUsdc * 1550);
      return {
        id: `paj_off_${calls.pajOfframp.length}`,
        address: params.bankCode === "090267"
          ? "So1anaPajFundingAddr1111111111111111111111"
          : "0x2222222222222222222222222222222222222222",
        amount: amtUsdc,
        fiatAmount: fiatAmt,
        rate: 1550,
        accountName: params.accountName || "ADAORA OKAFOR",
        bankName: "GTBank",
      };
    },
  },
  fx: {
    getUsdToNgnRate: async () => 1550,
  },
  near: {
    getSupportedNearTokens: async () => [{ symbol: "NEAR", assetId: "nep141:wrap.near", decimals: 24 }],
    getSupportedSolanaTokens: async () => [{ symbol: "SOL", assetId: "nep141:sol.omft.near", decimals: 9 }],
    getSupportedRobinhoodTokens: async () => [{ symbol: "USDG", assetId: "nep141:usdg.omft.near", decimals: 6 }],
    getSupportedStarknetTokens: async () => [{ symbol: "STRK", assetId: "nep141:strk.omft.near", decimals: 18 }],
    resolveNearToken: async (s) => s === "NEAR" ? { symbol: "NEAR", assetId: "nep141:wrap.near", decimals: 24 } : null,
    resolveSolanaToken: async (s) => s === "SOL" ? { symbol: "SOL", assetId: "nep141:sol.omft.near", decimals: 9 } : null,
    resolveRobinhoodToken: async (s) => s === "USDG" ? { symbol: "USDG", assetId: "nep141:usdg.omft.near", decimals: 6 } : null,
    resolveStarknetToken: async (s) => s === "STRK" ? { symbol: "STRK", assetId: "nep141:strk.omft.near", decimals: 18 } : null,
    createNearDeposit: async ({ telegramId, originAsset, originSymbol, amount, recipientAddress, refundTo }) => {
      const id = db.createNearDeposit({
        telegramId,
        originAsset,
        originSymbol,
        amountToken: amount,
        amountUsdc: 18.5,
        recipientAddress,
        refundTo,
        status: "pending",
      });
      db.updateNearDeposit(id, {
        deposit_address: "near-deposit-addr.near",
        deposit_memo: "memo-42",
        amount_out: "18.50",
        deadline: new Date(Date.now() + 3600_000).toISOString(),
        status: "pending",
      });
      return db.getNearDepositById(id);
    },
    createStarknetDeposit: async ({ telegramId, originAsset, originSymbol, amount, recipientAddress, refundTo }) => {
      const id = db.createNearDeposit({
        telegramId,
        originAsset,
        originSymbol,
        amountToken: amount,
        amountUsdc: 49.25,
        recipientAddress,
        refundTo,
        status: "pending",
      });
      db.updateNearDeposit(id, {
        deposit_address: "0x0123starknetdeposit",
        deposit_memo: null,
        amount_out: "49.25",
        deadline: new Date(Date.now() + 3600_000).toISOString(),
        status: "pending",
      });
      return db.getNearDepositById(id);
    },
    getExecutionStatus: async () => ({ status: "PENDING_DEPOSIT" }),
  },
  nuvionOrchestrator: {
    provisionGlobalReceivingAccount: async (telegramId, accountType, currency) => {
      const entity = db.getNuvionEntityByUser(telegramId, accountType);
      const detail = db.upsertNuvionAccountDetail({
        accountId: `acc_${currency.toLowerCase()}`,
        detailId: `det_${currency.toLowerCase()}_1`,
        entityId: entity.entity_id,
        assetType: "fiat",
        currency,
        accountNumber: "8844221100",
        routingNumber: "021000021",
        bankName: "Community Federal Savings Bank",
        beneficiaryName: entity.legal_name || "Adaora Okafor",
        status: "active",
      });
      return { entity, detail, isPending: false, cached: false };
    },
  },
  nuvionPayouts: {
    quoteGlobalPayout: async ({ targetCurrency, targetAmountMajor, railKey }) => ({
      railKey: railKey || `${targetCurrency.toLowerCase()}_local`,
      userTotalUsd: Number((targetAmountMajor * 1.28).toFixed(2)),
    }),
    initiateGlobalPayout: async (params) => {
      calls.globalPayouts.push(params);
      return { uniqueReference: "gp_ref_1", status: "processing" };
    },
    parseAndQuoteGlobalPayroll: async ({ csvText }) => {
      const lines = csvText.trim().split(/\r?\n/).slice(1);
      return {
        batchId: "batch_99",
        totalUserUsd: lines.length * 100,
        rows: lines.map((l, i) => ({ name: `Staff ${i + 1}`, currency: "GBP", amount: 80 })),
        parseErrors: [],
      };
    },
    executeGlobalPayrollBatch: async (params) => {
      calls.payrolls.push(params);
      return { batchId: params.payrollPlan.batchId, submitted: params.payrollPlan.rows.length };
    },
  },
  nuvionCards: {
    quoteCardIssuance: async ({ loadAmountUsd }) => ({ totalUsd: loadAmountUsd + 3 }),
    initiateCardIssuance: async (params) => {
      calls.cardsIssued.push(params);
      return { jobId: "card_job_1", status: "provisioning" };
    },
    setCardFrozen: async (params) => {
      calls.cardsFrozen.push(params);
      return { cardId: params.cardId, frozen: params.freeze };
    },
    getUserCardsWithBalances: async () => [
      { cardId: "card_abc", name: "Online shopping", last4: "4242", balanceUsd: 48.5, status: "active" },
    ],
    fetchCardTransactions: async ({ cardId }) => [
      { id: "ctx_1", cardId, merchant: "Stripe", amountUsd: 12.0, status: "settled" },
    ],
  },
  airbills: {
    PRODUCTS: {
      AIRTIME: { code: "100", category: "airtime", label: "Airtime", minNgn: 50, maxNgn: 50000 },
      ELECTRICITY: { code: "101", category: "electricity", label: "Electricity", minNgn: 2000, maxNgn: 500000 },
    },
    NETWORKS: [{ id: "01", name: "MTN" }, { id: "04", name: "Airtel" }],
    listDataPlans: async () => [{ prodId: "mtn-1gb", prodAmount: 500, description: "MTN 1GB 30 Days", networkId: "01", network: "MTN" }],
    listElectricityProviders: async () => [{ electId: "ikedc", name: "Ikeja Electric", prodId: "101" }],
    listCablePackages: async () => [{ prodId: "dstv-compact", prodAmount: 15700, description: "DStv Compact", provider: "DStv" }],
    listBettingPlatforms: async () => [{ prodId: "bet9ja", name: "Bet9ja" }],
    listTransportServices: async () => [{ prodId: "cowry", prodAmount: 1000, name: "Cowry Card" }],
    validateMeter: async (meterNo, electId) => ({ customerName: "ADAORA OKAFOR", meterNo, electId }),
    estimateBillUsdc: async (amountNgn) => ({ usdc: Number((amountNgn / 1550).toFixed(2)) }),
    executeBillPayment: async (params) => {
      calls.bills.push(params);
      return { success: true, airbillsTxId: "ab_1", amountUsdc: 3.23 };
    },
  },
  savings: {
    getYieldPools: async () => [{ name: "Arc Dollar Vault", symbol: "USDC", apy: 5.4, tvlUsd: 1200000, vaultAddress: "0x3333333333333333333333333333333333333333" }],
    depositIntoVault: async (_key, vaultAddress, amountUsdc) => {
      calls.savingsDeposits.push({ vaultAddress, amountUsdc });
      return { success: true, txHash: "0x" + "b".repeat(64) };
    },
    openYieldPosition: (telegramId, amountUsdc, pool, opts) => {
      db.openYieldPosition(telegramId, amountUsdc, pool, opts);
    },
    calcAccruedYield: () => 0.42,
    withdrawFromVaultWithFee: async ({ position }) => {
      calls.savingsWithdraws.push(position);
      db.closeYieldPosition(position.id, "0x" + "c".repeat(64), Number(position.amount_usdc) + 0.42);
      return { totalUserPayout: Number(position.amount_usdc) + 0.42, netYieldUsdc: 0.42, devFeeUsdc: 0.05, withdrawTxHash: "0x" + "c".repeat(64) };
    },
  },
  invoiceHd: {
    createCompleteBizInvoice: async ({ telegramId, invoiceData, user }) => {
      calls.invoicesCreated.push({ telegramId, invoiceData });
      const bizDb = require("../src/biz_db");
      const id = bizDb.createBizInvoice(telegramId, {
        invoiceNumber: invoiceData.invoiceNumber,
        clientName: invoiceData.clientName,
        clientEmail: invoiceData.clientEmail,
        items: invoiceData.items,
        totalUsdc: invoiceData.totalUsdc,
        dueDate: invoiceData.dueDate,
        notes: invoiceData.notes,
        walletAddress: user.business_deposit_address || user.deposit_address,
        pngPath: null,
      });
      return {
        invoiceId: id,
        totalUsdc: invoiceData.totalUsdc,
        paymentAddress: "0x4444444444444444444444444444444444444444",
        fiatDetails: { bankName: "Providus Bank", accountNumber: "9088776655", amountNgn: 790000 },
        cryptoIntent: null,
      };
    },
  },
});

let server;
let base;

test.before(async () => {
  server = http.createServer((req, res) => routes.handleAppApiRequest(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  schedules.stopScheduleRunner();
  server?.close();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
});

test.beforeEach(() => routes.__resetRateLimits());

async function call(method, p, body, token) {
  const res = await fetch(`${base}/api/app/v1${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, body: json, text, headers: res.headers };
}

async function signUp(auth, phone, deviceId, pin = "4826") {
  const start = await call("POST", "/auth/signup/start", { phone, deviceId, platform: "android" });
  assert.equal(start.status, 201, JSON.stringify(start.body));
  const verify = await call("POST", "/auth/signup/verify-otp", { signupId: start.body.signupId, code: "4821" });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  const finish = await call("POST", "/auth/signup/finish", {
    signupId: start.body.signupId,
    challengeId: verify.body.challengeId,
    response: auth.register(verify.body.options),
    pin,
    acceptTerms: true,
    deviceName: "Pixel 9",
  });
  assert.equal(finish.status, 201, JSON.stringify(finish.body));
  return finish.body;
}

async function approveAction(auth, token, type, payload, pin = "4826") {
  const intent = await call("POST", `/actions/${type}/intent`, payload, token);
  assert.equal(intent.status, 200, `${type} intent failed: ${JSON.stringify(intent.body)}`);
  const confirmPayload = {
    challengeId: intent.body.challengeId,
    response: auth.assert(intent.body.options),
  };
  if (pin !== null) confirmPayload.pin = pin;
  const confirm = await call("POST", "/actions/confirm", confirmPayload, token);
  return { intent, confirm };
}

// ─── 1. Money actions via /actions/:type/intent + /actions/confirm ────────────

test("money actions: transfer.user, payout.ngn, payout.global, bill.pay, savings, cards, payroll, schedule.create", async () => {
  const aliceAuth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const bobAuth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const alice = await signUp(aliceAuth, "+2348010000001", "dev-alice-0000000001");
  const bob = await signUp(bobAuth, "+2348010000002", "dev-bob-000000000002");
  db.syncUsername(Number(bob.user.id), "bob_proxim");
  const token = alice.session.accessToken;

  // Unknown action type -> 404
  const unknown = await call("POST", "/actions/does.not.exist/intent", {}, token);
  assert.equal(unknown.status, 404);

  // 1) transfer.user by @username -> sends on-chain & notifies recipient
  calls.notifications.length = 0;
  const p2p = await approveAction(aliceAuth, token, "transfer.user", { recipient: "@bob_proxim", amountUsdc: 15, narration: "dinner" });
  assert.equal(p2p.confirm.status, 200, JSON.stringify(p2p.confirm.body));
  assert.equal(p2p.confirm.body.actionType, "transfer.user");
  assert.equal(p2p.confirm.body.to, "@bob_proxim");
  assert.ok(calls.notifications.some((n) => Number(n.telegramId) === Number(bob.user.id) && n.title === "Money received"));

  // Cannot confirm a non-transfer.wallet challenge on /transfers/confirm
  const p2pIntent = await call("POST", "/actions/transfer.user/intent", { recipient: "+2348010000002", amountUsdc: 5 }, token);
  const wrongEndpoint = await call("POST", "/transfers/confirm", {
    challengeId: p2pIntent.body.challengeId,
    response: aliceAuth.assert(p2pIntent.body.options),
    pin: "4826",
  }, token);
  assert.equal(wrongEndpoint.status, 400);
  assert.equal(wrongEndpoint.body.error.code, "action_mismatch");

  // 2) payout.ngn (Arc rail + Solana rail)
  const ngnArc = await approveAction(aliceAuth, token, "payout.ngn", {
    amountUsdc: 20, bankCode: "000013", accountNumber: "0123456789", accountName: "ADAORA OKAFOR", narration: "rent",
  });
  assert.equal(ngnArc.confirm.status, 200, JSON.stringify(ngnArc.confirm.body));
  assert.equal(ngnArc.confirm.body.rail, "arc");

  const ngnSol = await approveAction(aliceAuth, token, "payout.ngn", {
    amountUsdc: 10, bankCode: "090267", accountNumber: "0123456789",
  });
  assert.equal(ngnSol.confirm.status, 200, JSON.stringify(ngnSol.confirm.body));
  assert.equal(ngnSol.confirm.body.rail, "solana");
  assert.equal(calls.sentSolana.length, 1);

  // 3) payout.global
  const gp = await approveAction(aliceAuth, token, "payout.global", {
    targetCurrency: "GBP", targetAmount: 50, railKey: "gbp_faster_payments",
    recipientDetails: { name: "Jane Doe", sortCode: "04-00-04", accountNumber: "12345678" },
  });
  assert.equal(gp.confirm.status, 200, JSON.stringify(gp.confirm.body));
  assert.equal(calls.globalPayouts.length, 1);

  // 4) bill.pay
  const bill = await approveAction(aliceAuth, token, "bill.pay", {
    category: "electricity", productCode: "101", providerName: "Ikeja Electric", recipient: "45012345678", amountNgn: 5000,
  });
  assert.equal(bill.confirm.status, 200, JSON.stringify(bill.confirm.body));
  assert.equal(calls.bills.length, 1);

  // 5) savings.deposit (uses context { pool }) -> GET /savings -> savings.withdraw
  const savDep = await approveAction(aliceAuth, token, "savings.deposit", { amountUsdc: 50 });
  assert.equal(savDep.confirm.status, 200, JSON.stringify(savDep.confirm.body));
  assert.equal(calls.savingsDeposits.length, 1);

  const savView = await call("GET", "/savings", null, token);
  assert.equal(savView.status, 200);
  assert.equal(savView.body.position.principalUsdc, 50);
  assert.equal(savView.body.position.accruedYieldUsdc, 0.42);

  const savWd = await approveAction(aliceAuth, token, "savings.withdraw", {});
  assert.equal(savWd.confirm.status, 200, JSON.stringify(savWd.confirm.body));
  assert.equal(savWd.confirm.body.withdrawnUsdc, 50.42);

  // 6) card.issue (needs PIN) & card.freeze (noPin: true -> succeeds WITHOUT PIN)
  const cardIss = await approveAction(aliceAuth, token, "card.issue", { cardType: "virtual", cardName: "Subscriptions", loadAmountUsd: 25 });
  assert.equal(cardIss.confirm.status, 200, JSON.stringify(cardIss.confirm.body));
  assert.equal(calls.cardsIssued.length, 1);

  const cardFrz = await approveAction(aliceAuth, token, "card.freeze", { cardId: "card_abc", freeze: true }, null);
  assert.equal(cardFrz.intent.body.requiresPin, false);
  assert.equal(cardFrz.confirm.status, 200, JSON.stringify(cardFrz.confirm.body));
  assert.equal(cardFrz.confirm.body.notice, "Card frozen");

  // 7) payroll.run with > 64KB CSV payload (tests 256KB body limit + context { plan })
  const bigRows = ["name,currency,amount,account"];
  for (let i = 0; i < 1200; i++) {
    bigRows.push(`Employee Number ${i} With A Long Legal Name Here,GBP,80,1234567890-040004`);
  }
  const bigCsv = bigRows.join("\n");
  assert.ok(bigCsv.length > 64 * 1024, "CSV should exceed the old 64KB limit");
  const payroll = await approveAction(aliceAuth, token, "payroll.run", { csvText: bigCsv });
  assert.equal(payroll.confirm.status, 200, JSON.stringify(payroll.confirm.body));
  assert.equal(calls.payrolls.length, 1);
  assert.equal(calls.payrolls[0].payrollPlan.rows.length, 1200);

  // 8) schedule.create -> list -> pause -> resume -> cancel
  const sched = await approveAction(aliceAuth, token, "schedule.create", {
    kind: "transfer.wallet",
    toAddress: "0x5555555555555555555555555555555555555555",
    amountUsdc: 12,
    frequency: "weekly",
    day: "friday",
    time: "08:30",
  });
  assert.equal(sched.confirm.status, 200, JSON.stringify(sched.confirm.body));
  const schedId = sched.confirm.body.schedule.id;

  const schedList = await call("GET", "/schedules", null, token);
  assert.equal(schedList.status, 200);
  assert.equal(schedList.body.schedules.length, 1);
  assert.equal(schedList.body.schedules[0].description, "every Friday at 08:30");

  const paused = await call("POST", `/schedules/${schedId}/pause`, {}, token);
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal(paused.body.schedule.status, "paused");

  const resumed = await call("POST", `/schedules/${schedId}/resume`, {}, token);
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.schedule.status, "active");

  // Bob cannot cancel Alice's schedule
  const bobDel = await call("DELETE", `/schedules/${schedId}`, null, bob.session.accessToken);
  assert.equal(bobDel.status, 404);

  const cancelled = await call("DELETE", `/schedules/${schedId}`, null, token);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.schedule.status, "cancelled");

  // Cancelled schedule cannot be resumed
  const badResume = await call("POST", `/schedules/${schedId}/resume`, {}, token);
  assert.equal(badResume.status, 409);
});

// ─── 2. Persistent schedule runner (claim, no double pay, 3-failure auto-pause) ─

test("persistent schedule runner executes due schedules once and auto-pauses after 3 failures", async () => {
  // Date math check
  const nextDec = schedules.computeNextRun({ frequency: "monthly", day: "1", time: "09:00" }, new Date("2026-11-15T10:00:00Z"));
  assert.equal(nextDec.toISOString(), "2026-12-01T09:00:00.000Z");

  const auth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const u = await signUp(auth, "+2348010000010", "dev-sched-0000000001");
  const uid = Number(u.user.id);

  let runSends = [];
  let shouldFail = false;
  const schedNotifs = [];
  schedules.__setTestDeps({
    fraudGuard: { assertOutboundAllowed: async () => {} },
    walletLib: {
      ...realWallet,
      sendSponsoredOrDirectTransaction: async (signer, to, amountMicro) => {
        if (shouldFail) throw new Error("Simulated RPC failure");
        runSends.push({ from: signer.address, to, amountMicro: String(amountMicro) });
        return { txHash: `0x${String(runSends.length).padStart(64, "d")}` };
      },
    },
    notify: {
      notify: async (tgId, msg) => { schedNotifs.push({ tgId, ...msg }); },
    },
  });

  const row = schedules.createSchedule({
    telegramId: uid,
    kind: "transfer.wallet",
    frequency: "daily",
    time: "09:00",
    payment: { toAddress: "0x6666666666666666666666666666666666666666", amountUsdc: "7.500000", narration: "allowance" },
    approvedDeviceId: "dev-sched-0000000001",
  });

  // Make it due now
  const past = new Date(Date.now() - 60_000).toISOString();
  db.db.prepare("UPDATE app_schedules SET next_run_at = ? WHERE id = ?").run(past, row.id);

  // Run twice back-to-back -> must only pay once
  await schedules.runDue(new Date());
  await schedules.runDue(new Date());
  assert.equal(runSends.length, 1);
  assert.match(schedules.getSchedule(uid, row.id).lastResult, /^sent 0x/);

  // Simulate 3 failures -> auto-pauses and notifies user
  shouldFail = true;
  for (let i = 0; i < 3; i++) {
    db.db.prepare("UPDATE app_schedules SET next_run_at = ? WHERE id = ?").run(past, row.id);
    await schedules.runDue(new Date());
  }
  const afterFail = schedules.getSchedule(uid, row.id);
  assert.equal(afterFail.status, "paused");
  assert.ok(schedNotifs.some((n) => n.html && n.html.includes("paused this schedule after 3 failures")));
  schedules.__setTestDeps({});
});

test("scheduled NGN bank payout: approved once, runs with the system key, funds the Paj order", async () => {
  const auth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const u = await signUp(auth, "+2348010000011", "dev-sched-0000000002");
  const uid = Number(u.user.id);
  const token = u.session.accessToken;

  // 1) The app creates the schedule with the same fields as a one-off payout.ngn.
  const sched = await approveAction(auth, token, "schedule.create", {
    kind: "payout.ngn", amountUsdc: 25, bankCode: "058", accountNumber: "0123456742",
    accountName: "ADA OKAFOR", narration: "rent", frequency: "monthly", day: "1", time: "09:00",
  });
  assert.equal(sched.confirm.status, 200, JSON.stringify(sched.confirm.body));
  const created = sched.confirm.body.schedule;
  assert.equal(created.kind, "payout.ngn");
  assert.equal(created.to, "ADA OKAFOR · ••42");
  assert.equal(created.description, "monthly on day 1 at 09:00");
  const stored = JSON.parse(db.db.prepare("SELECT payment_json FROM app_schedules WHERE id = ?").get(created.id).payment_json);
  assert.equal(stored.quotedRate, undefined, "a stale rate must not be stored");

  // A malformed bank account is rejected before anything is stored.
  const bad = await call("POST", "/actions/schedule.create/intent", {
    kind: "payout.ngn", amountUsdc: 25, bankCode: "058", accountNumber: "12345", frequency: "daily",
  }, token);
  assert.equal(bad.status, 400);

  // 2) The runner opens a Paj order and funds it once.
  const pajOrders = [];
  const funded = [];
  const recorded = [];
  let orderAmount = null;
  schedules.__setTestDeps({
    fraudGuard: { assertOutboundAllowed: async () => {} },
    paj: { createOfframpPayout: async (p) => { pajOrders.push(p); return { id: `paj_sched_${pajOrders.length}`, address: "0x8888888888888888888888888888888888888888", amount: orderAmount ?? p.amountUsdc, accountName: "ADA OKAFOR" }; } },
    multichain: { isSolanaAddress: () => false },
    walletLib: {
      ...realWallet,
      sendSponsoredOrDirectTransaction: async (signer, to, amountMicro) => {
        funded.push({ from: signer.address, to, amountMicro: String(amountMicro) });
        return { txHash: `0x${String(funded.length).padStart(64, "e")}` };
      },
    },
    db: new Proxy(db, { get: (t, k) => (k === "recordOfframpOrder" ? (o) => { recorded.push(o); return t.recordOfframpOrder(o); } : t[k]) }),
    notify: { notify: async () => {} },
  });
  const past = new Date(Date.now() - 60_000).toISOString();
  db.db.prepare("UPDATE app_schedules SET next_run_at = ? WHERE id = ?").run(past, created.id);
  await schedules.runDue(new Date());
  await schedules.runDue(new Date());
  assert.equal(pajOrders.length, 1, "must only pay once");
  assert.equal(pajOrders[0].bankCode, "058");
  assert.equal(pajOrders[0].accountNumber, "0123456742");
  assert.equal(pajOrders[0].amountUsdc, 25);
  assert.equal(funded.length, 1);
  assert.equal(funded[0].to, "0x8888888888888888888888888888888888888888");
  assert.equal(funded[0].amountMicro, String(realWallet.parseToMicro("25.000000")));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].orderId, "paj_sched_1");
  assert.equal(recorded[0].telegramId, uid);
  assert.match(schedules.getSchedule(uid, created.id).lastResult, /^sent 0x/);

  // 3) If the partner asks for more than the user approved, nothing is sent.
  orderAmount = 40;
  db.db.prepare("UPDATE app_schedules SET next_run_at = ? WHERE id = ?").run(past, created.id);
  await schedules.runDue(new Date());
  assert.equal(funded.length, 1);
  assert.match(schedules.getSchedule(uid, created.id).lastResult, /different amount/);
  schedules.__setTestDeps({});
});

// ─── 3. Non-money endpoints: profile, contacts, lookup, banks, deposits, global, cards, bills, rewards, KYC, business, assistant, CSV ─

test("profile, contacts, user lookup, banks, deposits, global accounts, cards, bills, rewards & KYC", async () => {
  const authA = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const authB = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const userA = await signUp(authA, "+2348020000001", "dev-feat-a-000000001");
  const userB = await signUp(authB, "+2348020000002", "dev-feat-b-000000002");
  db.syncUsername(Number(userB.user.id), "chidi_pay");
  const token = userA.session.accessToken;
  const uidA = Number(userA.user.id);

  // Profile & sender name
  const patched = await call("PATCH", "/me", { senderName: "Adaora Okafor" }, token);
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.user.senderName, "Adaora Okafor");

  // Contacts CRUD
  const c1 = await call("POST", "/contacts", {
    name: "Emeka",
    walletAddress: "0x7777777777777777777777777777777777777777",
    bankName: "GTBank",
    accountNumber: "0123456789",
    accountName: "EMEKA OKONKWO",
  }, token);
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  const cList = await call("GET", "/contacts?q=eme", null, token);
  assert.equal(cList.status, 200);
  assert.equal(cList.body.contacts.length, 1);
  assert.equal(cList.body.contacts[0].name, "Emeka");

  // User lookup (by username and by phone; never leaks raw phone)
  const lookHandle = await call("GET", "/users/lookup?q=@chidi_pay", null, token);
  assert.equal(lookHandle.status, 200);
  assert.equal(lookHandle.body.user.username, "chidi_pay");
  assert.equal(lookHandle.body.user.phone, undefined);
  const lookPhone = await call("GET", "/users/lookup?q=%2B2348020000002", null, token);
  assert.equal(lookPhone.status, 200);
  assert.equal(lookPhone.body.user.id, userB.user.id);

  // Banks list, rates, account-name check
  const banks = await call("GET", "/banks?q=gt", null, token);
  assert.equal(banks.status, 200);
  assert.equal(banks.body.banks.length, 1);
  assert.equal(banks.body.banks[0].code, "000013");

  const rates = await call("GET", "/banks/rates", null, token);
  assert.equal(rates.status, 200);
  assert.equal(rates.body.offRampRate, 1550);

  const resolved = await call("POST", "/banks/resolve", { bankCode: "000013", accountNumber: "0123456789" }, token);
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.accountName, "ADAORA OKAFOR");

  const badAcct = await call("POST", "/banks/resolve", { bankCode: "090267", accountNumber: "9999999999" }, token);
  assert.equal(badAcct.status, 404);

  // Naira deposit & status
  const ngnDep = await call("POST", "/deposits/ngn", { amountNgn: 50000 }, token);
  assert.equal(ngnDep.status, 201, JSON.stringify(ngnDep.body));
  assert.equal(ngnDep.body.virtualAccount.accountNumber, "9012345678");
  const ngnStat = await call("GET", `/deposits/ngn/${ngnDep.body.orderId}`, null, token);
  assert.equal(ngnStat.status, 200);
  assert.equal(ngnStat.body.status, "completed");

  // Crypto deposits (NEAR Intents)
  const tokens = await call("GET", "/deposits/crypto/tokens", null, token);
  assert.equal(tokens.status, 200);
  assert.ok(tokens.body.directAddresses.arc);
  assert.equal(tokens.body.intents.near[0].symbol, "NEAR");

  const nearDep = await call("POST", "/deposits/crypto/intent", {
    chain: "near", symbol: "NEAR", amount: 5, refundTo: "adaora.near",
  }, token);
  assert.equal(nearDep.status, 201, JSON.stringify(nearDep.body));
  assert.equal(nearDep.body.depositAddress, "near-deposit-addr.near");
  assert.equal(nearDep.body.depositMemo, "memo-42");

  const depCheck = await call("GET", `/deposits/crypto/${nearDep.body.depositId}`, null, token);
  assert.equal(depCheck.status, 200);
  assert.equal(depCheck.body.liveStatus.status, "PENDING_DEPOSIT");
  const depOtherUser = await call("GET", `/deposits/crypto/${nearDep.body.depositId}`, null, userB.session.accessToken);
  assert.equal(depOtherUser.status, 404);

  // Global accounts (blocked before KYC, works after Tier-1 approval; branding never leaks Nuvion)
  const kycBefore = await call("GET", "/kyc/status", null, token);
  assert.equal(kycBefore.status, 200);
  assert.equal(kycBefore.body.personal.tier, 0);
  assert.equal(kycBefore.body.limits.dailyUsd, 500);

  const blockedAcct = await call("POST", "/global/accounts/USD", {}, token);
  assert.equal(blockedAcct.status, 403);
  assert.equal(blockedAcct.body.error.code, "kyc_required");
  assert.ok(!/nuvion/i.test(blockedAcct.body.error.message), "must not expose internal provider name");

  // Approve Tier-1 entity and open USD global account
  db.upsertNuvionEntity({
    telegramId: uidA, accountType: "personal", entityId: "ent_ada_1",
    entityType: "individual", status: "approved", legalName: "Adaora Okafor", countryCode: "NG",
  });
  const kycAfter = await call("GET", "/kyc/status", null, token);
  assert.equal(kycAfter.body.personal.tier, 1);
  assert.equal(kycAfter.body.limits.dailyUsd, 25000);

  const usdAcct = await call("POST", "/global/accounts/USD", {}, token);
  assert.equal(usdAcct.status, 201, JSON.stringify(usdAcct.body));
  assert.equal(usdAcct.body.account.accountNumber, "8844221100");
  const acctsList = await call("GET", "/global/accounts", null, token);
  assert.equal(acctsList.status, 200);
  assert.equal(acctsList.body.accounts.length, 1);

  const corridors = await call("GET", "/global/corridors", null, token);
  assert.equal(corridors.status, 200);
  assert.ok(corridors.body.currencies.length >= 20);

  // Cards list & card transactions
  const cards = await call("GET", "/cards", null, token);
  assert.equal(cards.status, 200);
  assert.equal(cards.body.cards[0].last4, "4242");
  const cardTxs = await call("GET", "/cards/card_abc/transactions", null, token);
  assert.equal(cardTxs.status, 200);
  assert.equal(cardTxs.body.transactions[0].merchant, "Stripe");

  // Bill providers & meter validation
  const billCats = await call("GET", "/bills/providers", null, token);
  assert.equal(billCats.status, 200);
  assert.ok(billCats.body.categories.length >= 2);
  const elec = await call("GET", "/bills/providers?category=electricity", null, token);
  assert.equal(elec.status, 200);
  assert.equal(elec.body.providers[0].electId, "ikedc");
  const meter = await call("POST", "/bills/validate-meter", { meterNo: "45012345678", electId: "ikedc" }, token);
  assert.equal(meter.status, 200);
  assert.equal(meter.body.details.customerName, "ADAORA OKAFOR");

  // Rewards
  db.awardPoints(uidA, 150, "first_tx", "Welcome bonus");
  const rewards = await call("GET", "/rewards", null, token);
  assert.equal(rewards.status, 200);
  assert.equal(rewards.body.pointsBalance, 150);
  assert.ok(rewards.body.referralCode);
  assert.equal(rewards.body.history.length, 1);

  // Delete contact
  const delContact = await call("DELETE", "/contacts/Emeka", null, token);
  assert.equal(delContact.status, 200);
});

test("business home, profile, invoices, payment links, assistant, and statement CSV", async () => {
  const auth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const u = await signUp(auth, "+2348030000001", "dev-biz-000000000001");
  const uid = Number(u.user.id);
  const token = u.session.accessToken;

  // Add a business wallet on the account
  const bizWallet = realWallet.generateUserWallet();
  db.addBusinessWallet(uid, bizWallet.address, bizWallet.privateKey, "4826");

  // Update business profile
  const prof = await call("PATCH", "/business/profile", {
    businessName: "Adaora Studio Ltd",
    businessEmail: "billing@adaora.studio",
    defaultDueDays: 7,
  }, token);
  assert.equal(prof.status, 200, JSON.stringify(prof.body));
  assert.equal(prof.body.profile.businessName, "Adaora Studio Ltd");

  // Create & fetch business invoice
  const inv = await call("POST", "/business/invoices", {
    clientName: "Acme Corp",
    clientEmail: "ap@acme.com",
    items: [{ description: "Brand Design", quantity: 1, unitPrice: 500 }],
    dueDate: "2026-12-15",
  }, token);
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.invoice.invoiceNumber, "BIZ-0001");
  assert.equal(inv.body.invoice.totalUsdc, 500);

  const invList = await call("GET", "/business/invoices", null, token);
  assert.equal(invList.status, 200);
  assert.equal(invList.body.invoices.length, 1);

  const invOne = await call("GET", `/business/invoices/${inv.body.invoice.id}`, null, token);
  assert.equal(invOne.status, 200);
  assert.equal(invOne.body.invoice.clientName, "Acme Corp");

  // Business home aggregates
  const home = await call("GET", "/business/home", null, token);
  assert.equal(home.status, 200, JSON.stringify(home.body));
  assert.equal(home.body.enabled, true);
  assert.equal(home.body.balance.totalUsdc, "2450.00");
  assert.equal(home.body.summary.pendingInvoiceCount, 1);
  assert.equal(home.body.summary.pendingInvoiceTotalUsd, 500);

  // Payment links: create, list, deactivate
  const pl = await call("POST", "/business/payment-links", {
    title: "Consulting Retainer",
    amount: 250,
    currency: "USD",
    slug: "adaora-retainer",
    channels: ["ngn_bank", "crypto"],
  }, token);
  assert.equal(pl.status, 201, JSON.stringify(pl.body));
  assert.equal(pl.body.paymentLink.slug, "adaora-retainer");

  const plList = await call("GET", "/business/payment-links", null, token);
  assert.equal(plList.status, 200);
  assert.equal(plList.body.paymentLinks.length, 1);

  const plDel = await call("DELETE", `/business/payment-links/${pl.body.paymentLink.linkId}`, null, token);
  assert.equal(plDel.status, 200);

  // Assistant: read-only balance + contact-resolved transfer suggestion (never executes!)
  await call("POST", "/contacts", {
    name: "Tunde",
    walletAddress: "0x8888888888888888888888888888888888888888",
  }, token);

  const aBal = await call("POST", "/assistant", { message: "balance" }, token);
  assert.equal(aBal.status, 200);
  assert.equal(aBal.body.intent, "balance");
  // db.addBusinessWallet sets active_context='business', so assistant honors active business context
  assert.equal(aBal.body.data.totalUsdc, "2450.00");
  const aBalPer = await call("POST", "/assistant", { message: "balance", accountType: "personal" }, token);
  assert.equal(aBalPer.status, 200);
  assert.equal(aBalPer.body.data.totalUsdc, "512.75");

  const sendsBefore = calls.sentOnchain.length;
  const aSend = await call("POST", "/assistant", { message: "send $30 to Tunde" }, token);
  assert.equal(aSend.status, 200);
  assert.equal(aSend.body.intent, "transfer");
  assert.equal(aSend.body.suggestedAction.type, "transfer.wallet");
  assert.equal(aSend.body.suggestedAction.payload.toAddress, "0x8888888888888888888888888888888888888888");
  assert.equal(aSend.body.suggestedAction.payload.amountUsdc, 30);
  assert.equal(calls.sentOnchain.length, sendsBefore, "assistant must NEVER move money on its own");

  const aSave = await call("POST", "/assistant", { message: "save $40" }, token);
  assert.equal(aSave.status, 200);
  assert.equal(aSave.body.suggestedAction.type, "savings.deposit");
  assert.equal(aSave.body.suggestedAction.payload.amountUsdc, 40);

  // Statement CSV export (verifies header, formatted USDC, and formula injection escaping)
  db.recordTransaction(uid, "transfer", String(realWallet.parseToMicro("12.500000")), "completed", "0xtx1", "personal", 18, "arc", "=SUM(A1:A2), note");
  const csvRes = await call("GET", "/transactions/statement.csv", null, token);
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get("content-type"), /text\/csv/);
  assert.match(csvRes.headers.get("content-disposition"), /proxim-statement\.csv/);
  const lines = csvRes.text.trim().split(/\r?\n/);
  assert.equal(lines[0], "id,created_at,account_type,type,status,amount,amount_raw,decimals,chain,tx_hash,narration");
  assert.ok(lines[1].includes("12.5"), `expected formatted amount 12.5 in: ${lines[1]}`);
  assert.ok(lines[1].includes("\"'=SUM(A1:A2), note\""), `expected CSV formula-escaped narration in: ${lines[1]}`);
});

test("naira-denominated send flows: payout.ngn, transfer.user, and gift.create accept amountNgn", async () => {
  const senderAuth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const recvAuth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const sender = await signUp(senderAuth, "+2348040000001", "dev-ngn-send-0000001");
  const recv = await signUp(recvAuth, "+2348040000002", "dev-ngn-recv-0000002");
  db.syncUsername(Number(recv.user.id), "chidi_ngn");
  const token = sender.session.accessToken;

  // 1) payout.ngn using amountNgn -> passes fiatAmount directly to Paj and displays Naira in summary
  calls.pajOfframp.length = 0;
  const ngnPayout = await approveAction(senderAuth, token, "payout.ngn", {
    amountNgn: 31000,
    bankCode: "000013",
    accountNumber: "0123456789",
    accountName: "ADAORA OKAFOR",
    narration: "school fees",
  });
  assert.equal(ngnPayout.confirm.status, 200, JSON.stringify(ngnPayout.confirm.body));
  assert.match(ngnPayout.intent.body.summary.title, /₦31,000/);
  assert.ok(
    ngnPayout.intent.body.summary.lines.some(([k, v]) => k === "From your balance" && v.includes("$20.00")),
    `expected USD balance line in ${JSON.stringify(ngnPayout.intent.body.summary.lines)}`
  );
  assert.equal(calls.pajOfframp.length, 1);
  assert.equal(calls.pajOfframp[0].fiatAmount, 31000);
  assert.equal(calls.pajOfframp[0].amountUsdc, undefined);
  assert.equal(ngnPayout.confirm.body.amountNgn, 31000);
  assert.match(ngnPayout.confirm.body.notice, /₦31,000/);

  // 2) transfer.user using amountNgn -> converts at live offRampRate (1550) to $10.00 USDC
  const p2pNgn = await approveAction(senderAuth, token, "transfer.user", {
    recipient: "@chidi_ngn",
    amountNgn: 15500,
    narration: "lunch",
  });
  assert.equal(p2pNgn.confirm.status, 200, JSON.stringify(p2pNgn.confirm.body));
  assert.match(p2pNgn.intent.body.summary.title, /₦15,500/);
  assert.equal(Number(p2pNgn.confirm.body.amountUsdc), 10);
  assert.equal(p2pNgn.confirm.body.amountNgn, 15500);
  assert.match(p2pNgn.confirm.body.notice, /₦15,500/);

  // 3) gift.create enforces $1 minimum when amountNgn is too small, and succeeds for ₦3,100 ($2)
  const smallGift = await call("POST", "/actions/gift.create/intent", {
    targetUsername: "@new_friend_ngn",
    amountNgn: 500,
  }, token);
  assert.equal(smallGift.status, 400);
  assert.equal(smallGift.body.error.code, "invalid_amount");

  const giftNgn = await approveAction(senderAuth, token, "gift.create", {
    targetUsername: "@new_friend_ngn",
    amountNgn: 3100,
  });
  assert.equal(giftNgn.confirm.status, 200, JSON.stringify(giftNgn.confirm.body));
  assert.match(giftNgn.intent.body.summary.title, /₦3,100/);
  assert.equal(giftNgn.confirm.body.amountNgn, 3100);
  assert.match(giftNgn.confirm.body.notice, /₦3,100/);
});
