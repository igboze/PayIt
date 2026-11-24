// src/app_api/actions.js
// Money actions for the mobile app. Every action is two-step:
//   1. prepare(ctx, body): validate, quote and pre-check limits. Returns the exact action that the
//      user's passkey will sign (canonical, bound by hash into the WebAuthn challenge) plus a
//      human summary for the approval sheet.
//   2. execute(ctx, action, pin, context): runs only after the passkey assertion and PIN verify.
// Execution reuses the same modules the Telegram bot and builder API use, so fees, limits and
// fraud checks stay identical across channels.

const deps = {
  get db() { return require("../db"); },
  get walletLib() { return require("../wallet"); },
  get fraudGuard() { return require("../fraud_guard"); },
  get multichain() { return require("../multichain"); },
  get paj() { return require("../paj"); },
  get fx() { return require("../fx"); },
  get nuvionPayouts() { return require("../nuvion_payouts"); },
  get airbills() { return require("../airbills"); },
  get savings() { return require("../savings"); },
  get nuvionCards() { return require("../nuvion_cards"); },
  get notify() { return require("../notify"); },
  get schedules() { return require("./schedules"); },
  get store() { return require("./store"); },
};
const overrides = {};
const dep = (name) => (name in overrides ? overrides[name] : deps[name]);
function __setTestDeps(o = {}) {
  for (const k of Object.keys(overrides)) delete overrides[k];
  Object.assign(overrides, o);
}

class ActionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (msg, code = "invalid_request") => new ActionError(400, code, msg);

// ─── helpers ──────────────────────────────────────────────────────────────────

function str(body, field, { pattern = null, max = 256, optional = false } = {}) {
  const v = body[field];
  if (v === undefined || v === null || v === "") {
    if (optional) return null;
    throw bad(`Missing field: ${field}`);
  }
  const s = String(v).trim();
  if (!s || s.length > max || (pattern && !pattern.test(s))) throw bad(`Invalid field: ${field}`);
  return s;
}

function money(body, field, { min = 0.01, max = 1_000_000 } = {}) {
  const n = Number(body[field]);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`Enter a valid ${field}.`, "invalid_amount");
  return n;
}

async function precheck(ctx, amountUsd, reference, action) {
  try {
    await dep("fraudGuard").assertOutboundAllowed({
      telegramId: ctx.telegramId, accountType: "personal", action, amountUsd, reference, record: false,
    });
  } catch (err) {
    throw new ActionError(403, "blocked", err.message);
  }
}

async function recordOutbound(ctx, amountUsd, reference, action, accountType = "personal") {
  try {
    await dep("fraudGuard").assertOutboundAllowed({
      telegramId: ctx.telegramId, accountType, action, amountUsd, reference,
    });
  } catch (err) {
    throw new ActionError(403, "blocked", err.message);
  }
}

function unlockKey(ctx, pin) {
  const db = dep("db");
  const key = db.decryptPrivateKey(pin, db.getUser(ctx.telegramId));
  if (!key) throw new ActionError(401, "pin_invalid", "Wrong PIN.");
  return key;
}

async function sendOnchain(ctx, pin, toAddress, amountUsdc, narration, type = "transfer") {
  const db = dep("db");
  const walletLib = dep("walletLib");
  const signer = walletLib.walletFromPrivateKey(unlockKey(ctx, pin));
  const amountMicro = walletLib.parseToMicro(Number(amountUsdc).toFixed(6));
  const txRes = await walletLib.sendSponsoredOrDirectTransaction(signer, toAddress, amountMicro, "0x", { waitForConfirmation: false });
  const txHash = txRes.txHash || txRes.hash;
  db.recordTransaction(ctx.telegramId, type, String(amountMicro), "completed", txHash, "personal", 18, "arc", narration || null);
  return txHash;
}

function findRecipientUser(raw) {
  const db = dep("db");
  const store = dep("store");
  const q = String(raw || "").trim();
  if (/^\+?[0-9][0-9\s-]{7,}$/.test(q)) {
    const phone = q.replace(/[\s-]/g, "");
    return store.findUserByPhone(phone.startsWith("+") ? phone : `+${phone}`);
  }
  const handle = q.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{3,32}$/.test(handle)) return null;
  return db.findUserByUsername(handle);
}

const fmt = (n) => Number(n).toFixed(2);

// ─── action definitions ───────────────────────────────────────────────────────

const ACTIONS = {
  "transfer.wallet": {
    async prepare(ctx, body) {
      const toAddress = str(body, "toAddress", { pattern: /^0x[0-9a-fA-F]{40}$/ }).toLowerCase();
      const amountUsdc = money(body, "amountUsdc");
      const narration = str(body, "narration", { optional: true, max: 100 }) || "";
      if (ctx.user.deposit_address && toAddress === String(ctx.user.deposit_address).toLowerCase()) throw bad("You can't send to your own wallet.", "self_transfer");
      await precheck(ctx, amountUsdc, toAddress, "app_transfer");
      return {
        amountUsd: amountUsdc,
        action: { toAddress, amountUsdc: amountUsdc.toFixed(6), currency: "USDC", narration },
        summary: { title: `Send $${fmt(amountUsdc)}`, lines: [["To", toAddress], ["Amount", `$${fmt(amountUsdc)}`]] },
      };
    },
    async execute(ctx, a, pin) {
      await recordOutbound(ctx, Number(a.amountUsdc), a.toAddress, "app_transfer");
      const txHash = await sendOnchain(ctx, pin, a.toAddress, a.amountUsdc, a.narration);
      return { txHash, amountUsdc: a.amountUsdc, toAddress: a.toAddress, notice: `Sent $${fmt(a.amountUsdc)}` };
    },
  },

  "transfer.user": {
    async prepare(ctx, body) {
      const recipient = findRecipientUser(str(body, "recipient", { max: 40 }));
      if (!recipient || !recipient.deposit_address) throw new ActionError(404, "recipient_not_found", "No Proxim user with that username or phone. You can send them a claim link from the bot.");
      if (Number(recipient.telegram_id) === ctx.telegramId) throw bad("You can't send to yourself.", "self_transfer");
      const amountUsdc = money(body, "amountUsdc");
      const narration = str(body, "narration", { optional: true, max: 100 }) || "";
      await precheck(ctx, amountUsdc, `user:${recipient.telegram_id}`, "app_p2p");
      const label = recipient.username ? `@${recipient.username}` : "Proxim user";
      return {
        amountUsd: amountUsdc,
        action: { recipientId: String(recipient.telegram_id), recipientLabel: label, toAddress: String(recipient.deposit_address).toLowerCase(), amountUsdc: amountUsdc.toFixed(6), narration },
        summary: { title: `Send $${fmt(amountUsdc)} to ${label}`, lines: [["To", label], ["Amount", `$${fmt(amountUsdc)}`], ["Fee", "Free"]] },
      };
    },
    async execute(ctx, a, pin) {
      const db = dep("db");
      const recipient = db.getUser(Number(a.recipientId));
      if (!recipient || String(recipient.deposit_address).toLowerCase() !== a.toAddress) throw new ActionError(409, "recipient_changed", "The recipient's account changed. Please start again.");
      await recordOutbound(ctx, Number(a.amountUsdc), `user:${a.recipientId}`, "app_p2p");
      const txHash = await sendOnchain(ctx, pin, a.toAddress, a.amountUsdc, a.narration, "p2p_send");
      try {
        db.recordTransaction(Number(a.recipientId), "p2p_receive", String(dep("walletLib").parseToMicro(Number(a.amountUsdc).toFixed(6))), "completed", txHash, "personal", 18, "arc", a.narration || null);
      } catch (_) {}
      const from = ctx.user.username ? `@${ctx.user.username}` : "a Proxim user";
      try {
        await dep("notify").notify(Number(a.recipientId), { title: "Money received", html: `💸 <b>You received $${fmt(a.amountUsdc)}</b> from ${from}.${a.narration ? `\nNote: ${String(a.narration).replace(/[<>&]/g, "")}` : ""}` });
      } catch (_) {}
      return { txHash, amountUsdc: a.amountUsdc, to: a.recipientLabel, notice: `Sent $${fmt(a.amountUsdc)} to ${a.recipientLabel}` };
    },
  },

  "payout.ngn": {
    async prepare(ctx, body) {
      const amountUsdc = money(body, "amountUsdc", { min: 1 });
      const bankCode = str(body, "bankCode", { pattern: /^[A-Za-z0-9-]{2,20}$/ });
      const accountNumber = str(body, "accountNumber", { pattern: /^\d{10}$/ });
      const accountName = str(body, "accountName", { optional: true, max: 80 }) || "";
      const narration = str(body, "narration", { optional: true, max: 60 }) || "";
      await precheck(ctx, amountUsdc, `${bankCode}:${accountNumber}`, "app_offramp_ngn");
      let rate = null;
      try { const r = await dep("paj").getRates("NGN"); rate = Number(r?.offRampRate?.rate) || null; } catch (_) {}
      if (!rate) { try { rate = Number(await dep("fx").getUsdToNgnRate()) || null; } catch (_) {} }
      const estNgn = rate ? Math.floor(amountUsdc * rate) : null;
      return {
        amountUsd: amountUsdc,
        action: { amountUsdc: amountUsdc.toFixed(6), bankCode, accountNumber, accountName, narration, quotedRate: rate },
        summary: {
          title: `Send $${fmt(amountUsdc)} to ${accountName || accountNumber}`,
          lines: [["To", `${accountName || "Account"} · ••${accountNumber.slice(-2)}`], ["They get", estNgn ? `≈ ₦${estNgn.toLocaleString("en-NG")}` : "Shown by the bank partner"], ["Rate", rate ? `$1 = ₦${rate}` : "Live rate"]],
        },
      };
    },
    async execute(ctx, a, pin) {
      const db = dep("db");
      const walletLib = dep("walletLib");
      const multichain = dep("multichain");
      const amount = Number(a.amountUsdc);
      await recordOutbound(ctx, amount, `${a.bankCode}:${a.accountNumber}`, "app_offramp_ngn");
      const senderName = db.resolveSenderName(ctx.telegramId, "personal");
      const order = await dep("paj").createOfframpPayout({
        amountUsdc: amount, bankCode: a.bankCode, accountNumber: a.accountNumber,
        accountName: a.accountName || undefined, narration: a.narration || undefined, senderName,
      });
      const fundingAddress = order.address;
      const fundingAmount = Number(order.amount || amount);
      if (!fundingAddress) throw new ActionError(502, "provider_error", "The bank partner didn't return a funding address. Nothing was sent.");
      const privateKey = unlockKey(ctx, pin);
      let txHash = null;
      let rail = "arc";
      if (multichain.isSolanaAddress(fundingAddress)) {
        rail = "solana";
        const sol = multichain.deriveSolanaFromEvmKey(privateKey);
        const tx = await multichain.sendSolanaTransfer({ keypair: sol.keypair, recipientAddress: fundingAddress, amount: fundingAmount });
        txHash = tx?.txHash || tx?.signature || null;
      } else if (walletLib.isValidAddress(fundingAddress)) {
        const signer = walletLib.walletFromPrivateKey(privateKey);
        const tx = await walletLib.sendSponsoredOrDirectTransaction(signer, fundingAddress, walletLib.parseToMicro(fundingAmount.toFixed(6)));
        txHash = tx?.txHash || null;
      } else {
        throw new ActionError(502, "provider_error", "Unsupported funding address from the bank partner. Nothing was sent.");
      }
      const orderId = order.id || order.reference || txHash;
      db.recordOfframpOrder({
        orderId, telegramId: ctx.telegramId, accountType: "personal", accountNumber: String(a.accountNumber), bankCode: String(a.bankCode),
        bankName: order.bankName || order.bank?.name || null, accountName: order.accountName || a.accountName || null,
        amountUsdc: fundingAmount, fiatAmount: order.fiatAmount || null, rate: order.rate || null, rail, txHash,
        narration: a.narration || null, senderName: senderName || null, status: "submitted",
      });
      db.recordTransaction(ctx.telegramId, "offramp", String(walletLib.parseToMicro(fundingAmount.toFixed(6))), "submitted", txHash || orderId, "personal", 18, rail, a.narration || null);
      return { orderId, txHash, rail, status: "submitted", notice: `Sending $${fmt(fundingAmount)} to ${order.accountName || a.accountName || "the bank account"}` };
    },
  },

  "payout.global": {
    async prepare(ctx, body) {
      const targetCurrency = str(body, "targetCurrency", { pattern: /^[A-Za-z]{3}$/ }).toUpperCase();
      const targetAmountMajor = money(body, "targetAmount");
      const railKey = str(body, "railKey", { optional: true, max: 40 });
      const recipientDetails = body.recipientDetails && typeof body.recipientDetails === "object" ? body.recipientDetails : null;
      if (!recipientDetails) throw bad("Recipient bank details are required.");
      const narration = str(body, "narration", { optional: true, max: 60 }) || "";
      const q = await dep("nuvionPayouts").quoteGlobalPayout({ telegramId: ctx.telegramId, accountType: "personal", railKey, targetCurrency, targetAmountMajor });
      const userUsd = Number(q?.userTotalUsd ?? q?.totalUsd ?? 0);
      await precheck(ctx, userUsd, `global:${targetCurrency}`, "app_global_payout");
      return {
        amountUsd: userUsd,
        action: { targetCurrency, targetAmountMajor: String(targetAmountMajor), railKey: railKey || q?.railKey || null, recipientDetails, narration, quotedUsd: userUsd.toFixed(2) },
        summary: { title: `Send ${targetAmountMajor} ${targetCurrency}`, lines: [["They get", `${targetAmountMajor} ${targetCurrency}`], ["From your balance", `$${fmt(userUsd)}`]] },
      };
    },
    async execute(ctx, a, pin) {
      await recordOutbound(ctx, Number(a.quotedUsd), `global:${a.targetCurrency}`, "app_global_payout");
      const res = await dep("nuvionPayouts").initiateGlobalPayout({
        telegramId: ctx.telegramId, pin, accountType: "personal", railKey: a.railKey || undefined,
        targetCurrency: a.targetCurrency, targetAmountMajor: Number(a.targetAmountMajor),
        recipientDetails: a.recipientDetails, narration: a.narration || null, bot: dep("notify").getNotifyBot(),
      });
      return { result: res, notice: `Sending ${a.targetAmountMajor} ${a.targetCurrency}` };
    },
  },

  "bill.pay": {
    async prepare(ctx, body) {
      const category = str(body, "category", { pattern: /^(airtime|data|electricity|cable|betting|internet)$/ });
      const productCode = str(body, "productCode", { max: 80 });
      const recipient = str(body, "recipient", { max: 40 });
      const providerName = str(body, "providerName", { optional: true, max: 80 }) || null;
      const amountNgn = money(body, "amountNgn", { min: 50, max: 2_000_000 });
      const billData = body.billData && typeof body.billData === "object" ? body.billData : {};
      const est = await dep("airbills").estimateBillUsdc(amountNgn);
      const usd = Number(est?.usdc ?? est?.amountUsdc ?? est ?? 0);
      await precheck(ctx, usd, `${category}:${recipient}`, "app_bill");
      return {
        amountUsd: usd,
        action: { category, productCode, providerName, recipient, amountNgn: String(amountNgn), billData, quotedUsd: usd.toFixed(2) },
        summary: { title: `Pay ₦${amountNgn.toLocaleString("en-NG")} ${category}`, lines: [["For", recipient], ["Provider", providerName || productCode], ["From your balance", `≈ $${fmt(usd)}`]] },
      };
    },
    async execute(ctx, a, pin) {
      await recordOutbound(ctx, Number(a.quotedUsd), `${a.category}:${a.recipient}`, "app_bill");
      const res = await dep("airbills").executeBillPayment({
        user: dep("db").getUser(ctx.telegramId), pin, context: "personal", productCode: a.productCode, category: a.category,
        providerName: a.providerName, recipient: a.recipient, amountNgn: Number(a.amountNgn), billData: a.billData || {},
      });
      return { result: res, notice: `Paid ₦${Number(a.amountNgn).toLocaleString("en-NG")} ${a.category}` };
    },
  },

  "savings.deposit": {
    async prepare(ctx, body) {
      const amountUsdc = money(body, "amountUsdc", { min: 1 });
      const pools = await dep("savings").getYieldPools();
      const pool = pools.find((p) => p.symbol === "USDC") || pools[0];
      if (!pool || !pool.vaultAddress) throw new ActionError(503, "unavailable", "Savings are unavailable right now.");
      return {
        amountUsd: amountUsdc,
        action: { amountUsdc: amountUsdc.toFixed(6), vaultAddress: String(pool.vaultAddress).toLowerCase() },
        summary: { title: `Save $${fmt(amountUsdc)}`, lines: [["Into", pool.name || "Dollar lending vault"], ["Amount", `$${fmt(amountUsdc)}`]] },
        context: { pool },
      };
    },
    async execute(ctx, a, pin, context) {
      const savings = dep("savings");
      const pool = context?.pool || { vaultAddress: a.vaultAddress };
      const res = await savings.depositIntoVault(unlockKey(ctx, pin), a.vaultAddress, Number(a.amountUsdc));
      if (!res || !res.success) throw new ActionError(502, "provider_error", res?.error || "The savings deposit didn't go through. Nothing was moved.");
      savings.openYieldPosition(ctx.telegramId, Number(a.amountUsdc), pool, { vaultAddress: a.vaultAddress, depositTxHash: res.txHash || res.hash || null, accountType: "personal" });
      return { txHash: res.txHash || res.hash || null, notice: `Saved $${fmt(a.amountUsdc)}` };
    },
  },

  "savings.withdraw": {
    async prepare(ctx) {
      const open = dep("db").getOpenYieldPosition(ctx.telegramId, "personal");
      if (!open) throw new ActionError(404, "no_position", "You have no savings to withdraw.");
      return { amountUsd: 0, action: { positionId: String(open.id) }, summary: { title: "Withdraw all savings", lines: [["Back to", "Your balance"]] } };
    },
    async execute(ctx, a, pin) {
      const db = dep("db");
      const open = db.getOpenYieldPosition(ctx.telegramId, "personal");
      if (!open || String(open.id) !== a.positionId) throw new ActionError(409, "changed", "Your savings changed. Please start again.");
      const userWallet = dep("walletLib").walletFromPrivateKey(unlockKey(ctx, pin));
      userWallet.telegramId = ctx.telegramId;
      const r = await dep("savings").withdrawFromVaultWithFee({ userWallet, position: open });
      return { withdrawnUsdc: r.totalUserPayout, netYieldUsdc: r.netYieldUsdc, feeUsdc: r.devFeeUsdc, txHash: r.withdrawTxHash, notice: `Withdrew $${fmt(r.totalUserPayout || 0)}` };
    },
  },

  "card.issue": {
    async prepare(ctx, body) {
      const cardType = str(body, "cardType", { pattern: /^(virtual|disposable)$/ });
      const cardName = str(body, "cardName", { optional: true, max: 40 }) || (cardType === "virtual" ? "Online shopping" : "One-time card");
      const loadAmountUsd = money(body, "loadAmountUsd", { min: 1 });
      const q = await dep("nuvionCards").quoteCardIssuance({ telegramId: ctx.telegramId, accountType: "personal", cardType, loadAmountUsd, cardName });
      const total = Number(q?.totalUsd ?? q?.userTotalUsd ?? loadAmountUsd);
      await precheck(ctx, total, `card:${cardType}`, "app_card_issue");
      return {
        amountUsd: total,
        action: { cardType, cardName, loadAmountUsd: String(loadAmountUsd), quotedUsd: total.toFixed(2) },
        summary: { title: `New ${cardType} card`, lines: [["Loaded with", `$${fmt(loadAmountUsd)}`], ["Total from balance", `$${fmt(total)}`]] },
      };
    },
    async execute(ctx, a, pin) {
      await recordOutbound(ctx, Number(a.quotedUsd), `card:${a.cardType}`, "app_card_issue");
      const res = await dep("nuvionCards").initiateCardIssuance({ telegramId: ctx.telegramId, pin, accountType: "personal", cardType: a.cardType, cardName: a.cardName, loadAmountUsd: Number(a.loadAmountUsd), bot: dep("notify").getNotifyBot() });
      return { result: res, notice: "Your card is being created" };
    },
  },

  "card.freeze": {
    noPin: true,
    async prepare(ctx, body) {
      const cardId = str(body, "cardId", { max: 80 });
      const freeze = body.freeze !== false;
      return { amountUsd: 0, action: { cardId, freeze }, summary: { title: freeze ? "Freeze card" : "Unfreeze card", lines: [["Card", cardId]] } };
    },
    async execute(ctx, a) {
      const res = await dep("nuvionCards").setCardFrozen({ telegramId: ctx.telegramId, accountType: "personal", cardId: a.cardId, freeze: a.freeze });
      return { result: res, notice: a.freeze ? "Card frozen" : "Card unfrozen" };
    },
  },

  "payroll.run": {
    async prepare(ctx, body) {
      const csvText = str(body, "csvText", { max: 200_000 });
      const plan = await dep("nuvionPayouts").parseAndQuoteGlobalPayroll({ telegramId: ctx.telegramId, csvText, accountType: "business" });
      const total = Number(plan.totalUserUsd || 0);
      const csvHash = dep("store").sha256(csvText);
      return {
        amountUsd: total,
        action: { batchId: String(plan.batchId), rows: plan.rows.length, totalUsd: total.toFixed(2), csvHash },
        summary: {
          title: `Pay ${plan.rows.length} people`,
          lines: [["People", String(plan.rows.length)], ["Total from business balance", `$${fmt(total)}`]],
          rows: plan.rows.slice(0, 50).map((r) => ({ name: r.name || r.recipientName || null, currency: r.currency || r.targetCurrency || null, amount: r.amount ?? r.targetAmountMajor ?? null })),
          parseErrors: plan.parseErrors || [],
        },
        context: { plan },
      };
    },
    async execute(ctx, a, pin, context) {
      if (!context?.plan || String(context.plan.batchId) !== a.batchId) throw new ActionError(409, "changed", "Payroll changed. Please upload it again.");
      await recordOutbound(ctx, Number(a.totalUsd), `payroll:${a.batchId}`, "app_payroll", "business");
      const res = await dep("nuvionPayouts").executeGlobalPayrollBatch({ telegramId: ctx.telegramId, pin, payrollPlan: context.plan, accountType: "business", bot: dep("notify").getNotifyBot() });
      return { result: res, notice: `Paying ${a.rows} people` };
    },
  },

  "schedule.create": {
    async prepare(ctx, body) {
      const kind = str(body, "kind", { pattern: /^(transfer\.user|transfer\.wallet)$/ });
      const frequency = str(body, "frequency", { pattern: /^(daily|weekly|monthly)$/ });
      const day = str(body, "day", { optional: true, max: 12 });
      const time = str(body, "time", { optional: true, pattern: /^([01]\d|2[0-3]):[0-5]\d$/ }) || "09:00";
      const inner = await ACTIONS[kind].prepare(ctx, body);
      const label = dep("schedules").describe({ frequency, day, time });
      return {
        amountUsd: 0, // nothing moves now; each run is checked against limits when it happens
        action: { kind, frequency, day: day || null, time, payment: inner.action },
        summary: { title: `${inner.summary.title}, ${label}`, lines: [...inner.summary.lines, ["Repeats", label]] },
      };
    },
    async execute(ctx, a) {
      const row = dep("schedules").createSchedule({ telegramId: ctx.telegramId, kind: a.kind, frequency: a.frequency, day: a.day, time: a.time, payment: a.payment, approvedDeviceId: ctx.deviceId });
      return { schedule: row, notice: "Schedule created" };
    },
  },
};

module.exports = { ACTIONS, ActionError, findRecipientUser, __setTestDeps };
