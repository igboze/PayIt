// tests/app_api_parity.test.js
// Telegram Bot <-> Mobile App API full feature-parity tests.
// Exercises every feature live on the Telegram bot using REAL core modules wherever possible
// (real DB, real wallet encryption/PIN change, real social_transfers, real invoice_db, real biz_db,
// real receipt_generator PNG rendering, real compliance checks, real flows_multichain validation,
// real near address derivation, real chains address derivation).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const tmpDb = path.join(os.tmpdir(), `app_api_parity_test_${process.pid}_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = tmpDb;
process.env.INVOICE_FORWARDING_SECRET = "app-api-parity-secret-not-real-0000";
process.env.APP_JWT_SECRET = "app-api-parity-jwt-secret-not-real-0123456789";
process.env.APP_RP_ID = "proxim.test";
process.env.APP_ORIGINS = "https://proxim.test";
process.env.APP_INTEGRITY_MODE = "log";

const db = require("../src/db");
const realWallet = require("../src/wallet");
const realChains = require("../src/chains");
const realNear = require("../src/near");
const routes = require("../src/app_api/routes");
const { SoftAuthenticator } = require("./helpers/soft_authenticator");

const log = {
  sentOnchain: [],
  ccw: [],
  moves: [],
  swaps: [],
  cardTopups: [],
  cardUnloads: [],
  cardDeletes: [],
  cardReveals: [],
  globalPayouts: [],
  hostedLinks: [],
  sweeps: [],
  notifications: [],
  pajOnramps: [],
  balanceCalls: [],
};

let pajArcFail = false;
let pajArcEnabled = true;

routes.__setTestDeps({
  otp: {
    sendOtp: async () => ({ pinId: "pin-p" }),
    verifyOtp: async (_pinId, code) => code === "4821",
  },
  notify: async (telegramId, msg) => {
    log.notifications.push({ telegramId, ...msg });
    return { telegram: true, push: 0 };
  },
  paj: {
    RAILS: {
      arc: { chain: "ARC", mint: "0xarcusdc" },
      solana: { chain: "SOLANA", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
    },
    isArcOnrampEnabled: () => pajArcEnabled,
    createOnrampOrder: async (params) => {
      if (pajArcFail && params.chain === "ARC") throw new Error("Arc rail temporarily unavailable");
      log.pajOnramps.push(params);
      return {
        id: `onramp_${log.pajOnramps.length}`,
        status: "pending",
        amount: Number((params.fiatAmount / 1550).toFixed(2)),
        fiatAmount: params.fiatAmount,
        rate: 1550,
        bank: "Providus Bank",
        accountNumber: `901234567${log.pajOnramps.length}`,
        accountName: "PROXIM TEST",
      };
    },
  },
  chains: {
    ...realChains,
    getUnifiedBalance: async (_user, accountType, opts) => {
      log.balanceCalls.push({ accountType, opts });
      return {
        total: accountType === "business" ? 900 : 350,
        arc: { usdc: accountType === "business" ? 800 : 200, eurc: 25 },
        base: { usdc: 100 },
        gateway: { usdc: 50 },
        solana: { usdc: 0 },
        byChain: { arc: accountType === "business" ? 800 : 200, base: 100, gateway: 50, solana: 0 },
        pendingNear: 0,
      };
    },
  },
  fraudGuard: {
    isUserTier1Approved: (tgId, acct) => {
      const ent = db.getNuvionEntityByUser(tgId, acct || "personal");
      return String(ent?.status || "").toLowerCase() === "approved";
    },
    getVelocityConfig: () => ({ tier0HourlyLimitUsd: 300, tier0DailyLimitUsd: 500, tier1HourlyLimitUsd: 10000, tier1DailyLimitUsd: 25000, tier1BizDailyLimitUsd: 100000 }),
    getUserOutboundStats: () => ({ usd1h: 0, usd24h: 0 }),
    assertOutboundAllowed: async () => {},
  },
  walletLib: {
    ...realWallet,
    sendSponsoredOrDirectTransaction: async (signer, to, amountMicro) => {
      log.sentOnchain.push({ from: signer.address, to, amountMicro: String(amountMicro) });
      return { txHash: `0x${String(log.sentOnchain.length).padStart(64, "e")}`, sponsored: true };
    },
  },
  executor: {
    executeCrossChainWithdrawal: async (_wallet, opts) => {
      log.ccw.push(opts);
      return { success: true, engine: opts.destinationChain === "bitcoin" ? "NEAR_INTENTS" : "CCTP", amount: opts.amountUsdc, txHash: "0x" + "f".repeat(64) };
    },
    moveFundsBetweenChains: async (_wallet, opts) => {
      log.moves.push(opts);
      return { success: true, fromChain: opts.direction === "arc_to_solana" ? "arc" : "solana", amount: opts.amountUsdc, txHash: "0x" + "9".repeat(64) };
    },
  },
  swap: {
    getFxRates: async () => ({ USDC_EURC: 0.92, EURC_USDC: 1.08 }),
    getSwapQuote: async (tokenIn, tokenOut, amountMicro) => ({
      tokenIn,
      tokenOut,
      amountOut: (Number(realWallet.formatMicro(amountMicro)) * 0.91).toFixed(4),
      protocolFee: "0.5000",
    }),
    executeSwap: async (_pk, tokenIn, tokenOut, amountMicro) => {
      log.swaps.push({ tokenIn, tokenOut, amountMicro: String(amountMicro) });
      return { txHash: "0x" + "8".repeat(64) };
    },
  },
  evmSweeper: {
    sweepUserDeposits: async (tgId, _bot, opts) => {
      log.sweeps.push({ tgId, opts });
      return [{ chain: "BASE", sweptUsdc: 45, txHash: "0x" + "7".repeat(64) }];
    },
  },
  near: {
    ...realNear,
    resolveNearToken: async (s) => s === "NEAR" ? { symbol: "NEAR", assetId: "nep141:wrap.near", decimals: 24 } : null,
    createNearDeposit: async ({ telegramId, originAsset, originSymbol, amount, recipientAddress, refundTo }) => {
      const id = db.createNearDeposit({ telegramId, originAsset, originSymbol, amountToken: amount, amountUsdc: 20, recipientAddress, refundTo, status: "pending" });
      db.updateNearDeposit(id, { deposit_address: "auto-refund-test.near", deposit_memo: "m1", amount_out: "19.8", status: "pending" });
      return db.getNearDepositById(id);
    },
  },
  nuvion: {
    createIndividualEntity: async (payload) => ({ id: "ent_kyc_live_1", status: "pending", legalName: `${payload.firstName} ${payload.lastName}` }),
    createBusinessEntity: async (payload) => ({ id: "ent_kyb_live_1", status: "pending", legalName: payload.legalName }),
    getEntity: async (entityId) => ({ id: entityId, status: "approved" }),
  },
  nuvionOrchestrator: {
    createHostedPaymentLink: async (params) => {
      log.hostedLinks.push(params);
      return { session: { id: "fs_123", hosted_url: "https://pay.global.example/fs_123", status: "pending" }, job: { id: 1 } };
    },
  },
  nuvionPayouts: {
    quoteGlobalPayout: async ({ targetCurrency, targetAmountMajor, railKey }) => ({
      rail: { key: railKey || `${targetCurrency.toLowerCase()}_local`, label: `${targetCurrency} Local` },
      userTotalUsd: Number((targetAmountMajor * 1.25).toFixed(2)),
    }),
    initiateGlobalPayout: async (params) => {
      log.globalPayouts.push(params);
      return { uniqueReference: "gp_saved_1", status: "processing" };
    },
  },
  nuvionCards: {
    quoteCardTopUp: async ({ loadAmountUsd }) => ({ totalUsd: loadAmountUsd }),
    initiateCardTopUp: async (p) => { log.cardTopups.push(p); return { jobId: "topup_1" }; },
    unloadCardToMainWallet: async (p) => { log.cardUnloads.push(p); return { unloaded: true, unloadedUsd: 15 }; },
    deleteCardAndUnload: async (p) => { log.cardDeletes.push(p); return { deleted: true, unloadedUsd: 10 }; },
    revealCardDetailsWithPin: async (p) => {
      log.cardReveals.push(p);
      return { cardId: p.cardId, pan: "4111222233334444", cvv: "789", expiryMonth: "12", expiryYear: "2029" };
    },
  },
  invoiceHd: {
    createCompleteInvoice: async ({ telegramId, invoiceData, user }) => {
      const invoiceDb = require("../src/invoice_db");
      const id = invoiceDb.createInvoice(telegramId, {
        invoiceNumber: invoiceData.invoiceNumber,
        clientName: invoiceData.clientName,
        clientEmail: invoiceData.clientEmail,
        items: invoiceData.items,
        totalUsdc: invoiceData.totalUsdc,
        dueDate: invoiceData.dueDate,
        notes: invoiceData.notes,
        walletAddress: user.deposit_address,
        pngPath: null,
      });
      return { invoiceId: id, totalUsdc: invoiceData.totalUsdc, paymentAddress: "0x9999999999999999999999999999999999999999" };
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
  server?.close();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
});

test.beforeEach(() => routes.__resetRateLimits());

async function call(method, p, body, token, extraHeaders = {}) {
  const res = await fetch(`${base}/api/app/v1${p}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString("utf8")); } catch (_) {}
  return { status: res.status, body: json, buf, headers: res.headers };
}

async function signUp(auth, phone, deviceId, pin = "4826") {
  const start = await call("POST", "/auth/signup/start", { phone, deviceId, platform: "ios" });
  const verify = await call("POST", "/auth/signup/verify-otp", { signupId: start.body.signupId, code: "4821" });
  const finish = await call("POST", "/auth/signup/finish", {
    signupId: start.body.signupId,
    challengeId: verify.body.challengeId,
    response: auth.register(verify.body.options),
    pin,
    acceptTerms: true,
    deviceName: "iPhone 16",
  });
  assert.equal(finish.status, 201, JSON.stringify(finish.body));
  return finish.body;
}

async function approve(auth, token, type, payload, pin = "4826", extraConfirm = {}) {
  const intent = await call("POST", `/actions/${type}/intent`, payload, token);
  assert.equal(intent.status, 200, `${type} intent failed: ${JSON.stringify(intent.body)}`);
  const confirmBody = {
    challengeId: intent.body.challengeId,
    response: auth.assert(intent.body.options),
    ...extraConfirm,
  };
  if (pin !== null) confirmBody.pin = pin;
  const confirm = await call("POST", "/actions/confirm", confirmBody, token);
  return { intent, confirm };
}

test("unified balances, cross-chain withdrawals, bridge moves, EVM sweep, NEAR auto-refund & FX swap", async () => {
  const auth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const u = await signUp(auth, "+2348091000001", "dev-parity-000000001");
  const token = u.session.accessToken;

  // Unified balance includes base, gateway, arc (USDC + EURC), solana, byChain
  const bal = await call("GET", "/balances", null, token);
  assert.equal(bal.status, 200);
  assert.equal(bal.body.totalUsdc, 350);
  assert.equal(bal.body.base.usdc, 100);
  assert.equal(bal.body.gateway.usdc, 50);
  assert.equal(bal.body.arc.eurc, 25);

  // Direct deposit tokens list covers all 9 direct EVM/Solana chains
  const depTokens = await call("GET", "/deposits/crypto/tokens", null, token);
  assert.equal(depTokens.status, 200);
  assert.ok(depTokens.body.directAddresses.base);
  assert.ok(depTokens.body.directAddresses.arbitrum);
  assert.ok(depTokens.body.directAddresses.robinhood);
  assert.ok(depTokens.body.directAddresses.solana);

  // NEAR deposit auto-derives refundTo from system key without requiring caller to supply it
  const nearDep = await call("POST", "/deposits/crypto/intent", { chain: "near", symbol: "NEAR", amount: 5 }, token);
  assert.equal(nearDep.status, 201, JSON.stringify(nearDep.body));
  assert.ok(nearDep.body.refundTo && nearDep.body.refundTo.length === 64, "auto-derived NEAR implicit address");

  // Manual EVM deposit sweep (/sweep parity)
  const sweep = await call("POST", "/deposits/crypto/sweep", { chain: "BASE" }, token);
  assert.equal(sweep.status, 200);
  assert.equal(sweep.body.swept[0].sweptUsdc, 45);

  // External withdrawal chains list + cross-chain withdrawal (Base & Bitcoin)
  const chainsRes = await call("GET", "/withdrawals/chains", null, token);
  assert.equal(chainsRes.status, 200);
  assert.equal(chainsRes.body.chains.length, 10);

  const badAddr = await call("POST", "/actions/withdraw.crypto/intent", {
    destinationChain: "bitcoin", destinationAddress: "not-a-btc-address", amountUsdc: 25,
  }, token);
  assert.equal(badAddr.status, 400);

  const ccw = await approve(auth, token, "withdraw.crypto", {
    destinationChain: "base",
    destinationAddress: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    amountUsdc: 25,
  });
  assert.equal(ccw.confirm.status, 200, JSON.stringify(ccw.confirm.body));
  assert.equal(log.ccw.length, 1);

  // Arc <-> Solana bridge move + status
  const move = await approve(auth, token, "bridge.move", { direction: "arc_to_solana", amountUsdc: 15 });
  assert.equal(move.confirm.status, 200, JSON.stringify(move.confirm.body));
  assert.equal(log.moves.length, 1);

  const moves = await call("GET", "/bridge/moves", null, token);
  assert.equal(moves.status, 200);
  assert.ok(Array.isArray(moves.body.arcToSolana));

  // USDC <-> EURC FX swap rates, quote, and execution
  const rates = await call("GET", "/swap/rates", null, token);
  assert.equal(rates.status, 200);
  assert.equal(rates.body.rates.USDC_EURC, 0.92);

  const quote = await call("POST", "/swap/quote", { tokenIn: "USDC", tokenOut: "EURC", amountIn: 50 }, token);
  assert.equal(quote.status, 200);
  assert.equal(quote.body.quote.amountOut, "45.5000");

  const sw = await approve(auth, token, "swap.execute", { tokenIn: "USDC", tokenOut: "EURC", amountIn: 50 });
  assert.equal(sw.confirm.status, 200, JSON.stringify(sw.confirm.body));
  assert.equal(log.swaps.length, 1);
});

test("full cards lifecycle, social gift links (create, claim, cancel), KYC/KYB submit+refresh, global recipients & payment links", async () => {
  const aliceAuth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const bobAuth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const alice = await signUp(aliceAuth, "+2348091000010", "dev-parity-000000010");
  const bob = await signUp(bobAuth, "+2348091000011", "dev-parity-000000011");
  const uidA = Number(alice.user.id);
  const tokenA = alice.session.accessToken;
  const tokenB = bob.session.accessToken;
  db.syncUsername(Number(bob.user.id), "bob_gift");

  // Full card lifecycle: topup, reveal (no notification leak!), unload, delete
  log.notifications.length = 0;
  const topup = await approve(aliceAuth, tokenA, "card.topup", { cardId: "card_1", loadAmountUsd: 20 });
  assert.equal(topup.confirm.status, 200, JSON.stringify(topup.confirm.body));
  assert.equal(log.cardTopups.length, 1);

  const reveal = await approve(aliceAuth, tokenA, "card.reveal", { cardId: "card_1" });
  assert.equal(reveal.confirm.status, 200, JSON.stringify(reveal.confirm.body));
  assert.equal(reveal.confirm.body.card.pan, "4111222233334444");
  assert.ok(!log.notifications.some((n) => JSON.stringify(n).includes("4111222233334444")), "PAN must never be pushed to notifications");

  const unload = await approve(aliceAuth, tokenA, "card.unload", { cardId: "card_1", amountUsd: 15 }, null);
  assert.equal(unload.confirm.status, 200, JSON.stringify(unload.confirm.body));
  assert.equal(log.cardUnloads.length, 1);

  const del = await approve(aliceAuth, tokenA, "card.delete", { cardId: "card_1" }, null);
  assert.equal(del.confirm.status, 200, JSON.stringify(del.confirm.body));
  assert.equal(log.cardDeletes.length, 1);

  // Social gift link: create -> list -> claim by @bob_gift -> plus create & cancel
  const gift1 = await approve(aliceAuth, tokenA, "gift.create", { targetUsername: "@bob_gift", amountUsdc: 10 });
  assert.equal(gift1.confirm.status, 200, JSON.stringify(gift1.confirm.body));
  const claimToken1 = gift1.confirm.body.claimToken;
  assert.ok(claimToken1.startsWith("clm_"));

  const pendingList = await call("GET", "/gifts", null, tokenA);
  assert.equal(pendingList.status, 200);
  assert.equal(pendingList.body.gifts.length, 1);

  const claimed = await call("POST", "/gifts/claim", { claimToken: claimToken1 }, tokenB);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.success, true);

  const gift2 = await approve(aliceAuth, tokenA, "gift.create", { targetUsername: "@unclaimed_user", amountUsdc: 5 });
  const cancelled = await approve(aliceAuth, tokenA, "gift.cancel", { claimToken: gift2.confirm.body.claimToken }, null);
  assert.equal(cancelled.confirm.status, 200, JSON.stringify(cancelled.confirm.body));

  // KYC submit (blocks sanctioned country!) + KYB submit + refresh to approved
  const sanctioned = await call("POST", "/kyc/submit", {
    countryCode: "KP", firstName: "A", lastName: "B", email: "a@b.com", phoneNumber: "+2348091000010",
    dateOfBirth: "1995-01-01", address: { line1: "1 St" }, idDocument: { type: "national_id", number: "123" },
  }, tokenA);
  assert.equal(sanctioned.status, 403);

  const kycSub = await call("POST", "/kyc/submit", {
    countryCode: "NG", firstName: "Adaora", lastName: "Okafor", email: "ada@proxim.app", phoneNumber: "+2348091000010",
    dateOfBirth: "1995-05-05", gender: "female", address: { line1: "10 Lekki Way", city: "Lagos", state: "LA", country: "NG" },
    idDocument: { type: "national_id", number: "12345678901" },
  }, tokenA);
  assert.equal(kycSub.status, 201, JSON.stringify(kycSub.body));
  assert.equal(kycSub.body.status, "pending");

  const kycRef = await call("POST", "/kyc/refresh", { accountType: "personal" }, tokenA);
  assert.equal(kycRef.status, 200);
  assert.equal(kycRef.body.personal.tier, 1);
  assert.equal(kycRef.body.personal.status, "approved");

  // Saved global recipient + payout.global reusing savedCounterpartyId (and auto-filling railKey from q.rail.key!)
  db.saveNuvionCounterparty({
    entityId: "ent_kyc_live_1",
    counterpartyId: "cp_uk_1",
    paymentDetailId: "pd_uk_1",
    label: "Jane Doe (GBP · Faster Payments)",
    currency: "GBP",
    scheme: "gbp_faster_payments",
    paymentMethod: "bank",
    accountHolderName: "Jane Doe",
    summary: { railKey: "gbp_faster_payments", bankName: "Monzo", accountTail: "5678" },
  });
  const recips = await call("GET", "/global/recipients?currency=GBP", null, tokenA);
  assert.equal(recips.status, 200);
  assert.equal(recips.body.recipients.length, 1);

  const savedPayout = await approve(aliceAuth, tokenA, "payout.global", {
    targetCurrency: "GBP", targetAmount: 40, savedCounterpartyId: "cp_uk_1",
  });
  assert.equal(savedPayout.confirm.status, 200, JSON.stringify(savedPayout.confirm.body));
  assert.equal(log.globalPayouts[0].railKey, "gbp_faster_payments");
  assert.equal(log.globalPayouts[0].savedCounterparty.counterparty_id, "cp_uk_1");

  // Global hosted payment link (Open Banking GBP)
  const gpl = await call("POST", "/global/payment-links", {
    currency: "GBP", amount: 120, fundingType: "open-banking", narration: "Consulting",
  }, tokenA);
  assert.equal(gpl.status, 201, JSON.stringify(gpl.body));
  assert.equal(gpl.body.paymentUrl, "https://pay.global.example/fs_123");
});

test("business setup, account switch, expenses, savings goal, personal+biz invoices, PIN change, auto-earn, rewards redeem, bills history, PNG receipt & investments gate", async () => {
  const auth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const u = await signUp(auth, "+2348091000020", "dev-parity-000000020", "4826");
  const uid = Number(u.user.id);
  const token = u.session.accessToken;

  // 1) business.setup via passkey + PIN
  const bizSetup = await approve(auth, token, "business.setup", { businessName: "Naija Craft Co", businessEmail: "hi@craft.ng" }, "4826");
  assert.equal(bizSetup.confirm.status, 200, JSON.stringify(bizSetup.confirm.body));
  assert.ok(bizSetup.confirm.body.businessDepositAddress.startsWith("0x"));

  // 2) Switch active context + toggle Auto-Earn on PATCH /me
  const sw = await call("PATCH", "/me", { activeContext: "business", autoEarnEnabled: true }, token);
  assert.equal(sw.status, 200, JSON.stringify(sw.body));
  assert.equal(sw.body.user.activeContext, "business");
  assert.equal(sw.body.user.autoEarnEnabled, true);

  // 3) Send transfer FROM business wallet (accountType: "business")
  const bizTx = await approve(auth, token, "transfer.wallet", {
    accountType: "business",
    toAddress: "0x1234567890123456789012345678901234567890",
    amountUsdc: 25,
    narration: "supplier",
  }, "4826");
  assert.equal(bizTx.confirm.status, 200, JSON.stringify(bizTx.confirm.body));
  assert.equal(bizTx.confirm.body.accountType, "business");

  // 4) Business expenses & savings goal
  const exp = await call("POST", "/business/expenses", { amount: 45, currency: "USDC", description: "AWS hosting bill" }, token);
  assert.equal(exp.status, 201, JSON.stringify(exp.body));
  assert.equal(exp.body.expense.category, "Software");
  const expList = await call("GET", "/business/expenses", null, token);
  assert.equal(expList.body.expenses.length, 1);

  const goal = await call("PUT", "/business/savings-goal", { percentage: 15, label: "Tax Reserve" }, token);
  assert.equal(goal.status, 200);
  assert.equal(goal.body.savingsGoal.percentage, 15);

  // 5) Personal invoice create + list + mark-paid
  const pInv = await call("POST", "/invoices", { clientName: "Femi", amount: 120, notes: "Logo work" }, token);
  assert.equal(pInv.status, 201, JSON.stringify(pInv.body));
  assert.equal(pInv.body.invoice.invoiceNumber, "INV-0001");
  const pPaid = await call("POST", `/invoices/${pInv.body.invoice.id}/mark-paid`, {}, token);
  assert.equal(pPaid.status, 200);
  assert.equal(pPaid.body.invoice.status, "paid");

  // 6) PIN change (re-encrypts BOTH personal and business keys; old PIN stops working, new PIN works!)
  const pinChg = await approve(auth, token, "pin.change", {}, "4826", { newPin: "7391" });
  assert.equal(pinChg.confirm.status, 200, JSON.stringify(pinChg.confirm.body));
  assert.equal(db.verifyPin(uid, "4826"), false);
  assert.equal(db.verifyPin(uid, "7391"), true);
  assert.ok(db.decryptPrivateKey("7391", db.getUser(uid)), "personal key decrypted with new PIN");
  assert.ok(db.decryptBusinessPrivateKey("7391", db.getUser(uid)), "business key decrypted with new PIN");

  // 7) Rewards redemption (uses new PIN 7391!)
  db.awardPoints(uid, 500, "referral", "Friend signed up");
  const redeem = await approve(auth, token, "rewards.redeem", { points: 200, rewardType: "airtime", recipient: "08012345678" }, "7391");
  assert.equal(redeem.confirm.status, 200, JSON.stringify(redeem.confirm.body));
  assert.equal(redeem.confirm.body.remainingPoints, 300);

  // 8) Bills history
  const billHist = await call("GET", "/bills/history", null, token);
  assert.equal(billHist.status, 200);
  assert.ok(Array.isArray(billHist.body.bills));

  // 9) Real PNG receipt rendering via src/receipt_generator.js
  const txs = await call("GET", "/transactions", null, token);
  assert.ok(txs.body.transactions.length >= 1);
  const receipt = await call("GET", `/transactions/${txs.body.transactions[0].id}/receipt`, null, token);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.headers.get("content-type"), "image/png");
  // PNG magic header: 89 50 4E 47
  assert.equal(receipt.buf[0], 0x89);
  assert.equal(receipt.buf[1], 0x50);
  assert.equal(receipt.buf[2], 0x4e);
  assert.equal(receipt.buf[3], 0x47);

  // 10) Investments hub respects hidden-by-default feature gate (same as Telegram bot)
  const invHub = await call("GET", "/investments/hub", null, token);
  assert.equal(invHub.status, 200);
  assert.equal(invHub.body.enabled, false);
});

test("Personal <-> Business account switching and strict deposit/transfer wallet isolation", async () => {
  const auth = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const u = await signUp(auth, "+2348091000099", "dev-switch-000000099", "4826");
  const uid = Number(u.user.id);
  const token = u.session.accessToken;
  const personalArc = u.user.depositAddress.toLowerCase();

  // Switching to business before setup returns 404 no_business_account
  const noBiz = await call("POST", "/accounts/switch", { accountType: "business" }, token);
  assert.equal(noBiz.status, 404);
  assert.equal(noBiz.body.error.code, "no_business_account");

  // Create business wallet via passkey + PIN
  const bizSetup = await approve(auth, token, "business.setup", { businessName: "Lagos Studio Ltd" }, "4826");
  assert.equal(bizSetup.confirm.status, 200);
  const businessArc = bizSetup.confirm.body.businessDepositAddress.toLowerCase();
  assert.notEqual(businessArc, personalArc);

  // GET /accounts lists both accounts with completely distinct Arc & Solana addresses
  const accts = await call("GET", "/accounts", null, token);
  assert.equal(accts.status, 200);
  assert.equal(accts.body.accounts.length, 2);
  const perAcct = accts.body.accounts.find((a) => a.accountType === "personal");
  const bizAcct = accts.body.accounts.find((a) => a.accountType === "business");
  assert.ok(perAcct.solanaAddress && bizAcct.solanaAddress);
  assert.notEqual(perAcct.solanaAddress, bizAcct.solanaAddress, "Personal and Business Solana addresses must never collide");

  // POST /accounts/switch -> business updates active_context, returns strict business balance & personal hint
  log.balanceCalls.length = 0;
  const swBiz = await call("POST", "/accounts/switch", { accountType: "business" }, token);
  assert.equal(swBiz.status, 200, JSON.stringify(swBiz.body));
  assert.equal(swBiz.body.activeContext, "business");
  assert.equal(swBiz.body.user.activeDepositAddress.toLowerCase(), businessArc);
  assert.equal(swBiz.body.account.balance.totalUsdc, 900);
  assert.equal(swBiz.body.account.otherAccountBalanceUsdc, 350);
  assert.ok(log.balanceCalls.some((c) => c.accountType === "business" && c.opts?.strictBusiness === true));

  // Without passing ?account=, GET /balances honors switched activeContext=business with strictBusiness=true
  const balAuto = await call("GET", "/balances", null, token);
  assert.equal(balAuto.status, 200);
  assert.equal(balAuto.body.accountType, "business");
  assert.equal(balAuto.body.depositAddress.toLowerCase(), businessArc);
  assert.equal(balAuto.body.totalUsdc, 900);

  // Naira deposit while in Business mode routes to Business wallet with `-biz` externalId & metadata
  log.pajOnramps.length = 0;
  pajArcEnabled = true;
  pajArcFail = false;
  const bizNgn = await call("POST", "/deposits/ngn", { amountNgn: 100000 }, token);
  assert.equal(bizNgn.status, 201, JSON.stringify(bizNgn.body));
  assert.equal(bizNgn.body.accountType, "business");
  assert.equal(bizNgn.body.depositAddress.toLowerCase(), businessArc);
  assert.equal(log.pajOnramps[0].userExternalId, `${uid}-biz`);
  assert.equal(log.pajOnramps[0].metadata.accountType, "business");

  // If Arc rail fails on Business NGN deposit, fallback goes to BUSINESS Solana address (never Personal!)
  pajArcFail = true;
  const bizNgnSol = await call("POST", "/deposits/ngn", { amountNgn: 50000 }, token);
  pajArcFail = false;
  assert.equal(bizNgnSol.status, 201, JSON.stringify(bizNgnSol.body));
  assert.equal(bizNgnSol.body.settlementRail, "solana");
  assert.equal(bizNgnSol.body.depositAddress, bizAcct.solanaAddress);
  assert.notEqual(bizNgnSol.body.depositAddress, perAcct.solanaAddress);

  // Per-screen X-Proxim-Account header overrides saved activeContext (prevents cross-device switch races!)
  const pinnedPersonalNgn = await call("POST", "/deposits/ngn", { amountNgn: 20000 }, token, { "X-Proxim-Account": "personal" });
  assert.equal(pinnedPersonalNgn.status, 201, JSON.stringify(pinnedPersonalNgn.body));
  assert.equal(pinnedPersonalNgn.body.accountType, "personal");
  assert.equal(pinnedPersonalNgn.body.depositAddress.toLowerCase(), personalArc);
  assert.equal(log.pajOnramps[log.pajOnramps.length - 1].userExternalId, String(uid));

  // Crypto deposit tokens, NEAR intent & Card/Apple Pay deposit link all isolate Business vs Personal
  const bizTokens = await call("GET", "/deposits/crypto/tokens", null, token);
  assert.equal(bizTokens.body.accountType, "business");
  assert.equal(bizTokens.body.directAddresses.arc.toLowerCase(), businessArc);
  assert.equal(bizTokens.body.directAddresses.solana, bizAcct.solanaAddress);

  const bizNear = await call("POST", "/deposits/crypto/intent", { chain: "near", symbol: "NEAR", amount: 3 }, token);
  assert.equal(bizNear.status, 201);
  assert.equal(bizNear.body.accountType, "business");
  assert.equal(bizNear.body.recipientAddress.toLowerCase(), businessArc);

  const perNear = await call("POST", "/deposits/crypto/intent", { chain: "near", symbol: "NEAR", amount: 3 }, token, { "X-Proxim-Account": "personal" });
  assert.equal(perNear.status, 201);
  assert.equal(perNear.body.accountType, "personal");
  assert.equal(perNear.body.recipientAddress.toLowerCase(), personalArc);
  assert.notEqual(bizNear.body.refundTo, perNear.body.refundTo, "Personal and Business NEAR refund addresses must be distinct");

  const bizCardDep = await call("GET", "/deposits/card", null, token);
  assert.equal(bizCardDep.status, 200);
  assert.equal(bizCardDep.body.accountType, "business");
  assert.equal(bizCardDep.body.walletAddress.toLowerCase(), businessArc);
  assert.ok(bizCardDep.body.onrampUrl.includes(bizSetup.confirm.body.businessDepositAddress));

  // Mid-approval switch safety: prepare transfer while in Business, switch to Personal BEFORE confirm ->
  // MUST still spend strictly from the Business wallet approved in the passkey sheet!
  log.sentOnchain.length = 0;
  const intent = await call("POST", "/actions/transfer.wallet/intent", {
    toAddress: "0x1234567890123456789012345678901234567890",
    amountUsdc: 10,
  }, token);
  assert.equal(intent.status, 200);
  assert.ok(intent.body.summary.lines.some(([k, v]) => k === "Account" && v === "Business"));

  // Switch activeContext to personal right before confirming!
  const swPer = await call("POST", "/accounts/switch", { accountType: "personal" }, token);
  assert.equal(swPer.status, 200);
  assert.equal(swPer.body.activeContext, "personal");

  const confirm = await call("POST", "/actions/confirm", {
    challengeId: intent.body.challengeId,
    response: auth.assert(intent.body.options),
    pin: "4826",
  }, token);
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  assert.equal(confirm.body.accountType, "business");
  assert.equal(log.sentOnchain[0].from.toLowerCase(), businessArc, "must debit the approved Business wallet even if user switched to Personal mid-approval");

  // After switching back to Personal, a new deposit/balance goes strictly to Personal
  const balAfter = await call("GET", "/balances", null, token);
  assert.equal(balAfter.body.accountType, "personal");
  assert.equal(balAfter.body.depositAddress.toLowerCase(), personalArc);
});

test("security hardening: frozen accounts, NGN order IDOR, XFF spoofing, no dummy KYB/KYC defaults, headers & production lock", async () => {
  const authA = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const authB = new SoftAuthenticator({ rpId: "proxim.test", origin: "https://proxim.test" });
  const userA = await signUp(authA, "+2348091000081", "dev-sec-a-0000000081");
  const userB = await signUp(authB, "+2348091000082", "dev-sec-b-0000000082");
  const tokenA = userA.session.accessToken;
  const tokenB = userB.session.accessToken;

  // 1) Security headers present on every response
  const me = await call("GET", "/me", null, tokenA);
  assert.equal(me.status, 200);
  assert.equal(me.headers.get("x-frame-options"), "DENY");
  assert.equal(me.headers.get("referrer-policy"), "no-referrer");
  assert.equal(me.headers.get("content-security-policy"), "default-src 'none'");
  assert.match(me.headers.get("strict-transport-security"), /max-age=/);

  // 2) IDOR protection on GET /deposits/ngn/:orderId — unowned/other-user order returns 404 before touching Paj
  const ngnA = await call("POST", "/deposits/ngn", { amountNgn: 15000 }, tokenA);
  assert.equal(ngnA.status, 201);
  const idorB = await call("GET", `/deposits/ngn/${ngnA.body.orderId}`, null, tokenB);
  assert.equal(idorB.status, 404);
  const unownedOrder = await call("GET", "/deposits/ngn/external_foreign_order_999", null, tokenB);
  assert.equal(unownedOrder.status, 404);

  // 3) No fabricated compliance defaults: KYC requires gender; KYB requires real incorporationYear/Month/industry/businessType
  const kycMissingGender = await call("POST", "/kyc/submit", {
    countryCode: "NG", firstName: "Ada", lastName: "Okafor", email: "ada@proxim.app", phoneNumber: "+2348091000081",
    dateOfBirth: "1995-05-05", address: { line1: "1 St" }, idDocument: { type: "national_id", number: "123" },
  }, tokenA);
  assert.equal(kycMissingGender.status, 400);

  const kybMissingFields = await call("POST", "/kyb/submit", {
    incorporationCountry: "NG", legalName: "Craft Ltd", registrationNumber: "RC123", email: "hi@craft.ng",
    phoneNumber: "+2348091000081", address: { line1: "1 St" }, officer: { firstName: "Ada" },
  }, tokenA);
  assert.equal(kybMissingFields.status, 400);

  // 4) Frozen/blocked accounts are immediately denied on BOTH active access tokens AND refresh tokens
  db.blockUser(Number(userA.user.id), "Fraud freeze test");
  const blockedMe = await call("GET", "/me", null, tokenA);
  assert.equal(blockedMe.status, 403);
  assert.equal(blockedMe.body.error.code, "account_frozen");
  const blockedRefresh = await call("POST", "/auth/refresh", {
    refreshToken: userA.session.refreshToken,
    deviceId: "dev-sec-a-0000000081",
  });
  assert.equal(blockedRefresh.status, 403);
  assert.equal(blockedRefresh.body.error.code, "account_frozen");
  db.unblockUser(Number(userA.user.id));

  // 5) X-Forwarded-For leftmost IP spoofing cannot bypass IP rate limits
  routes.__resetRateLimits();
  for (let i = 0; i < 10; i++) {
    await call("POST", "/auth/signup/start", { phone: `+23480999900${String(i).padStart(2, "0")}`, deviceId: `dev-xff-0000000000${String(i).padStart(2, "0")}`, platform: "android" }, null, {
      "X-Forwarded-For": `10.0.0.${i + 1}, 203.0.113.55`,
    });
  }
  const blockedXff = await call("POST", "/auth/signup/start", { phone: "+2348099990099", deviceId: "dev-xff-000000000099", platform: "android" }, null, {
    "X-Forwarded-For": "198.51.100.99, 203.0.113.55",
  });
  assert.equal(blockedXff.status, 429, "spoofing leftmost XFF IP must not evade proxy-appended IP rate limit");

  // 6) __setTestDeps refuses to run in production
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => routes.__setTestDeps({}), /cannot be used in production/);
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
  }
});
