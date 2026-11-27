// src/app_api/features.js
// Non-money endpoints for the Proxim mobile app API (/api/app/v1/*).
// Every handler expects an already-authenticated `auth` object ({ telegramId, deviceId, user })
// and delegates to the same core modules used by the Telegram bot and builder API.

const deps = {
  get db() { return require("../db"); },
  get walletLib() { return require("../wallet"); },
  get chains() { return require("../chains"); },
  get fraudGuard() { return require("../fraud_guard"); },
  get payeeBook() { return require("../payee_book"); },
  get paj() { return require("../paj"); },
  get bankResolver() { return require("../bank_resolver"); },
  get fx() { return require("../fx"); },
  get near() { return require("../near"); },
  get multichain() { return require("../multichain"); },
  get nuvionOrchestrator() { return require("../nuvion_orchestrator"); },
  get nuvionCorridors() { return require("../nuvion_corridors"); },
  get nuvionCards() { return require("../nuvion_cards"); },
  get airbills() { return require("../airbills"); },
  get savings() { return require("../savings"); },
  get schedules() { return require("./schedules"); },
  get bizDb() { return require("../biz_db"); },
  get bizProfile() { return require("../biz_profile"); },
  get invoiceHd() { return require("../invoice_hd"); },
  get merchantCheckout() { return require("../merchant_checkout"); },
  get intentRouter() { return require("../../agent/intent_router"); },
  get actions() { return require("./actions"); },
  get store() { return require("./store"); },
  get evmSweeper() { return require("../evm_deposit_sweeper"); },
  get nuvion() { return require("../nuvion"); },
  get compliance() { return require("../compliance"); },
  get invoiceDb() { return require("../invoice_db"); },
  get invoiceGenerator() { return require("../invoice_generator"); },
  get tokens() { return require("./tokens"); },
  get receiptGenerator() { return require("../receipt_generator"); },
  get socialTransfers() { return require("../social_transfers"); },
  get swap() { return require("../swap"); },
  get flowsMultichain() { return require("../flows_multichain"); },
  get pods() { return require("../pods"); },
  get notify() { return require("../notify"); },
  get solanaAddress() { return require("../solana_address"); },
  get onramp() { return require("../onramp"); },
  get flowsKyc() { return require("../flows_nuvion_kyc"); },
  get internationalBanks() { return require("../international_banks"); },
};

const overrides = {};
const dep = (name) => (name in overrides ? overrides[name] : deps[name]);
let _fxRateCache = { rate: null, fetchedAt: 0 };

function __setTestDeps(o = {}) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setTestDeps cannot be used in production.");
  }
  for (const k of Object.keys(overrides)) delete overrides[k];
  Object.assign(overrides, o);
  _banksCache = { rows: null, fetchedAt: 0 };
  _fxRateCache = { rate: null, fetchedAt: 0 };
  accountNameCache.clear();
  accountNameInflight.clear();
}

async function getLiveUsdNgnRate() {
  if (_fxRateCache.rate && Date.now() - _fxRateCache.fetchedAt < 60_000) {
    return _fxRateCache.rate;
  }
  const fetchRate = async () => {
    let rate = null;
    try {
      const r = await dep("paj").getRates("NGN");
      rate = Number(r?.offRampRate?.rate || r?.onRampRate?.rate || 0) || null;
    } catch (_) { }
    if (!rate) {
      try {
        rate = Number(await dep("fx").getUsdToNgnRate()) || null;
      } catch (_) { }
    }
    return rate && Number.isFinite(rate) && rate > 0 ? rate : null;
  };
  try {
    const rate = await Promise.race([
      fetchRate(),
      new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
    if (rate) {
      _fxRateCache = { rate, fetchedAt: Date.now() };
      return rate;
    }
  } catch (_) { }
  return _fxRateCache.rate || null;
}

class FeatureError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bad = (msg, code = "invalid_request") => new FeatureError(400, code, msg);

function reqStr(body, field, { pattern = null, max = 256 } = {}) {
  const v = body?.[field];
  if (typeof v !== "string" || !v.trim() || v.trim().length > max || (pattern && !pattern.test(v.trim()))) {
    throw bad(`Missing or invalid field: ${field}`);
  }
  return v.trim();
}

function optStr(body, field, { pattern = null, max = 256 } = {}) {
  const v = body?.[field];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw bad(`Invalid field: ${field}`);
  const s = v.trim();
  if (!s) return null;
  if (s.length > max || (pattern && !pattern.test(s))) throw bad(`Invalid field: ${field}`);
  return s;
}

/**
 * Single source of truth for resolving Personal vs Business account context on the mobile API.
 * Precedence:
 *   1. Explicit query/body parameter (`account` / `accountType`)
 *   2. `X-Proxim-Account` HTTP header (sent per-screen by the mobile app to prevent cross-device switch races)
 *   3. Saved `user.active_context` (only `"business"` if a business wallet actually exists)
 * Never silently falls back to Personal when `"business"` is requested or active without a business wallet.
 */
function resolveAccountType(auth, explicit = null) {
  const raw = explicit !== undefined && explicit !== null && explicit !== ""
    ? String(explicit).trim().toLowerCase()
    : (auth.accountHeader || (auth.user?.active_context === "business" && auth.user?.business_deposit_address ? "business" : "personal"));
  if (raw !== "personal" && raw !== "business") {
    throw bad("Account must be 'personal' or 'business'.", "invalid_account");
  }
  if (raw === "business" && !auth.user?.business_deposit_address) {
    throw new FeatureError(404, "no_business_account", "No business account on this profile.");
  }
  return raw;
}

function getStrictAccountArcAddress(user, accountType) {
  if (accountType === "business") return user?.business_deposit_address || null;
  return user?.deposit_address || null;
}

function getStrictAccountSolanaAddress(user, accountType) {
  const isBiz = accountType === "business";
  try {
    const resolved = dep("solanaAddress").resolveSolanaRecipient(user, { isBiz });
    if (resolved) return resolved;
  } catch (_) { }
  try {
    const derived = dep("chains").deriveAddress?.(user, accountType, "solana", { strictBusiness: isBiz });
    if (derived) return derived;
  } catch (_) { }
  return (isBiz ? user?.biz_solana_deposit_address : user?.solana_deposit_address) || null;
}

function getBaseUrl(req) {
  const envBase = (process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || "").trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = String(req?.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}` : "";
}

function formatContact(p) {
  return {
    id: p.id,
    name: p.name,
    walletAddress: p.wallet_address || null,
    bankName: p.bank_name || null,
    accountNumber: p.account_number || null,
    accountName: p.account_name || null,
    notes: p.notes || null,
    createdAt: p.created_at || null,
  };
}

function formatGlobalAccount(d, liveBankCode = null) {
  const bankCode = d.bank_code || liveBankCode || dep("internationalBanks")?.enrichReceivingBankCode(d.currency, d.bank_name) || null;
  return {
    id: d.detail_id || d.id || null,
    accountId: d.account_id || null,
    currency: d.currency,
    bankName: d.bank_name || null,
    bankCode,
    beneficiaryName: d.beneficiary_name || null,
    accountNumber: d.account_number || null,
    routingNumber: d.routing_number || null,
    sortCode: d.sort_code || null,
    iban: d.iban || null,
    swiftCode: d.swift_code || null,
    status: d.status || "pending",
  };
}

function formatBizInvoice(row) {
  let items = [];
  if (Array.isArray(row.items)) items = row.items;
  else if (typeof row.items_json === "string") {
    try { items = JSON.parse(row.items_json); } catch (_) { items = []; }
  }
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    clientName: row.client_name,
    clientEmail: row.client_email || null,
    items,
    totalUsdc: Number(row.total_usdc || 0),
    dueDate: row.due_date || null,
    notes: row.notes || null,
    status: row.status || "unpaid",
    walletAddress: row.wallet_address || null,
    paymentAddress: row.payment_address || null,
    fiatBankName: row.fiat_bank_name || null,
    fiatAccountNumber: row.fiat_account_number || null,
    fiatAccountName: row.fiat_account_name || null,
    fiatAmount: row.fiat_amount != null ? Number(row.fiat_amount) : null,
    fiatOrderId: row.fiat_order_id || null,
    paidTxHash: row.paid_tx_hash || null,
    createdAt: row.created_at || null,
    paidAt: row.paid_at || null,
  };
}

// ─── 1. Profile & sender name ─────────────────────────────────────────────────

async function updateProfile(auth, body, publicUserFn) {
  const db = dep("db");
  const senderName = optStr(body, "senderName", { max: 64 });
  const bizSenderName = optStr(body, "bizSenderName", { max: 64 });
  const rawUsername = typeof body?.username === "string" ? body.username.trim().replace(/^@+/, "") : "";
  const accountType = resolveAccountType(auth, body?.accountType);
  const hasAutoEarn = typeof body?.autoEarnEnabled === "boolean";
  const depositSettlementMode = optStr(body, "depositSettlementMode", { pattern: /^(local|usdc)$/i });
  const activeContext = optStr(body, "activeContext", { pattern: /^(personal|business)$/ });

  if (!senderName && !bizSenderName && !rawUsername && !hasAutoEarn && !depositSettlementMode && !activeContext) {
    throw bad("Provide senderName, bizSenderName, username, autoEarnEnabled, depositSettlementMode, or activeContext to update.");
  }
  try {
    if (rawUsername) {
      if (!/^[a-zA-Z0-9_]{3,32}$/.test(rawUsername)) {
        throw bad("Username must be 3–32 letters, numbers, or underscores.");
      }
      const existingHolder = db.db
        .prepare("SELECT telegram_id FROM users WHERE LOWER(username) = LOWER(?) AND telegram_id != ? LIMIT 1")
        .get(rawUsername, Number(auth.telegramId));
      if (existingHolder) {
        throw new FeatureError(409, "username_taken", `Username @${rawUsername} is already taken. Try another one.`);
      }
      db.syncUsername(auth.telegramId, rawUsername);
    }
    if (senderName) db.setUserSenderName(auth.telegramId, senderName, accountType);
    if (bizSenderName) db.setUserSenderName(auth.telegramId, bizSenderName, "business");
    if (hasAutoEarn) db.updateAutoEarnSetting(auth.telegramId, body.autoEarnEnabled);
    if (depositSettlementMode) db.updateDepositSettlementMode(auth.telegramId, depositSettlementMode.toLowerCase());
    if (activeContext) {
      if (activeContext === "business" && !auth.user.business_deposit_address) {
        throw new FeatureError(404, "no_business_account", "Set up a business account before switching to it.");
      }
      db.setActiveContext(auth.telegramId, activeContext);
    }
  } catch (err) {
    if (err instanceof FeatureError) throw err;
    throw bad(err.message, "invalid_profile_update");
  }
  const updated = db.getUser(auth.telegramId);
  return {
    status: 200,
    data: { user: publicUserFn(updated, dep("store").getDevice(auth.deviceId)) },
  };
}

async function listAccounts(auth) {
  const db = dep("db");
  const chains = dep("chains");
  const activeContext = auth.user.active_context === "business" && auth.user.business_deposit_address ? "business" : "personal";
  const perEnt = db.getNuvionEntityByUser(auth.telegramId, "personal");
  const bizEnt = auth.user.business_deposit_address ? db.getNuvionEntityByUser(auth.telegramId, "business") : null;

  let perBal = null;
  let bizBal = null;
  const [perRes, bizRes, ngnRate] = await Promise.all([
    chains.getUnifiedBalance(auth.user, "personal", { strictBusiness: false }).catch(() => null),
    auth.user.business_deposit_address
      ? chains.getUnifiedBalance(auth.user, "business", { strictBusiness: true }).catch(() => null)
      : Promise.resolve(null),
    getLiveUsdNgnRate(),
  ]);
  perBal = perRes;
  bizBal = bizRes;
  const withNgn = (bal) => {
    if (!bal) return null;
    const totalNum = Number(bal.total || 0);
    return {
      totalUsdc: bal.total,
      totalNgn: ngnRate && Number.isFinite(totalNum) ? Math.round(totalNum * ngnRate) : null,
      usdToNgnRate: ngnRate,
      arc: bal.arc,
      base: bal.base || { usdc: 0 },
      gateway: bal.gateway || { usdc: 0 },
      solana: bal.solana,
      pendingBridgeUsdc: bal.pendingNear,
    };
  };

  const accounts = [
    {
      accountType: "personal",
      active: activeContext === "personal",
      depositAddress: auth.user.deposit_address || null,
      solanaAddress: getStrictAccountSolanaAddress(auth.user, "personal"),
      kycStatus: perEnt?.status || "not_started",
      kycTier: String(perEnt?.status || "").toLowerCase() === "approved" ? 1 : 0,
      balance: withNgn(perBal),
    },
  ];

  if (auth.user.business_deposit_address) {
    let bizProfileRow = null;
    try { bizProfileRow = dep("bizProfile").getBizProfile(auth.telegramId); } catch (_) { }
    accounts.push({
      accountType: "business",
      active: activeContext === "business",
      businessName: bizProfileRow?.business_name || null,
      depositAddress: auth.user.business_deposit_address,
      solanaAddress: getStrictAccountSolanaAddress(auth.user, "business"),
      kycStatus: bizEnt?.status || "not_started",
      kycTier: String(bizEnt?.status || "").toLowerCase() === "approved" ? 1 : 0,
      balance: withNgn(bizBal),
    });
  }

  return {
    status: 200,
    data: {
      activeContext,
      hasBusinessAccount: Boolean(auth.user.business_deposit_address),
      accounts,
    },
  };
}

async function switchAccount(auth, body, publicUserFn) {
  const target = reqStr(body, "accountType", { pattern: /^(personal|business)$/i }).toLowerCase();
  const db = dep("db");
  if (target === "business" && !auth.user.business_deposit_address) {
    throw new FeatureError(404, "no_business_account", "Set up a business account before switching to it.");
  }
  db.setActiveContext(auth.telegramId, target);
  const updated = db.getUser(auth.telegramId);
  try { dep("solanaAddress").reconcileUser(updated); } catch (_) { }

  const chains = dep("chains");
  let balance = null;
  let otherBalanceUsdc = null;
  const [uRes, ngnRate] = await Promise.all([
    chains.getUnifiedBalance(updated, target, { strictBusiness: target === "business" }).catch(() => null),
    getLiveUsdNgnRate(),
  ]);
  if (uRes) {
    const totalNum = Number(uRes.total || 0);
    balance = {
      totalUsdc: uRes.total,
      totalNgn: ngnRate && Number.isFinite(totalNum) ? Math.round(totalNum * ngnRate) : null,
      usdToNgnRate: ngnRate,
      arc: uRes.arc,
      base: uRes.base || { usdc: 0 },
      gateway: uRes.gateway || { usdc: 0 },
      solana: uRes.solana,
      byChain: uRes.byChain || null,
      pendingBridgeUsdc: uRes.pendingNear,
    };
  }
  if (updated.business_deposit_address) {
    const other = target === "business" ? "personal" : "business";
    try {
      const o = await chains.getUnifiedBalance(updated, other, { strictBusiness: other === "business" });
      if (o && Number.isFinite(Number(o.total))) otherBalanceUsdc = Number(o.total);
    } catch (_) { }
  }

  const ent = db.getNuvionEntityByUser(auth.telegramId, target);
  let pendingInvoiceCount = 0;
  if (target === "business") {
    try { pendingInvoiceCount = Number(dep("bizDb").getPendingInvoiceCount(auth.telegramId) || 0); } catch (_) { }
  }

  return {
    status: 200,
    data: {
      activeContext: target,
      user: publicUserFn(updated, dep("store").getDevice(auth.deviceId)),
      account: {
        accountType: target,
        depositAddress: getStrictAccountArcAddress(updated, target),
        solanaAddress: getStrictAccountSolanaAddress(updated, target),
        kycStatus: ent?.status || "not_started",
        kycTier: String(ent?.status || "").toLowerCase() === "approved" ? 1 : 0,
        balance,
        otherAccountBalanceUsdc: otherBalanceUsdc,
        pendingInvoiceCount,
      },
    },
  };
}

// ─── 2. Contacts (payee book) ─────────────────────────────────────────────────

async function listContacts(auth, url) {
  const pb = dep("payeeBook");
  if (typeof pb.initPayeeTable === "function") pb.initPayeeTable();
  const q = (url.searchParams.get("q") || "").trim();
  const rows = q ? pb.searchPayees(auth.telegramId, q) : pb.getAllPayees(auth.telegramId);
  return { status: 200, data: { contacts: rows.map(formatContact) } };
}

async function upsertContact(auth, body) {
  const pb = dep("payeeBook");
  if (typeof pb.initPayeeTable === "function") pb.initPayeeTable();
  const name = reqStr(body, "name", { max: 64 });
  const walletAddress = optStr(body, "walletAddress", { pattern: /^0x[0-9a-fA-F]{40}$/ });
  const accountNumber = optStr(body, "accountNumber", { pattern: /^\d{10}$/ });
  const bankName = optStr(body, "bankName", { max: 80 });
  const accountName = optStr(body, "accountName", { max: 80 });
  const notes = optStr(body, "notes", { max: 200 });
  if (!walletAddress && !accountNumber) {
    throw bad("A contact needs a wallet address or a 10-digit bank account number.");
  }
  pb.upsertPayee(auth.telegramId, {
    name,
    walletAddress: walletAddress ? walletAddress.toLowerCase() : null,
    bankName,
    accountNumber,
    accountName,
    notes,
  });
  const saved = pb.getPayeeByName(auth.telegramId, name);
  return { status: 201, data: { contact: saved ? formatContact(saved) : { name, walletAddress, bankName, accountNumber, accountName, notes } } };
}

async function deleteContact(auth, rawName) {
  const pb = dep("payeeBook");
  if (typeof pb.initPayeeTable === "function") pb.initPayeeTable();
  const name = decodeURIComponent(String(rawName || "")).trim();
  if (!name) throw bad("Contact name is required.");
  const existing = pb.getPayeeByName(auth.telegramId, name);
  if (!existing) throw new FeatureError(404, "contact_not_found", "Contact not found.");
  pb.deletePayee(auth.telegramId, existing.name);
  return { status: 200, data: { success: true } };
}

// ─── 3. User lookup ───────────────────────────────────────────────────────────

async function lookupUser(auth, url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q || q.length > 40) throw bad("Enter a username or phone number to look up.");
  const recipient = dep("actions").findRecipientUser(q);
  if (!recipient || !recipient.deposit_address) {
    throw new FeatureError(404, "user_not_found", "No Proxim user with that username or phone.");
  }
  return {
    status: 200,
    data: {
      user: {
        id: String(recipient.telegram_id),
        username: recipient.username || null,
        displayName: recipient.sender_name || (recipient.username ? `@${recipient.username}` : "Proxim user"),
        isSelf: Number(recipient.telegram_id) === auth.telegramId,
      },
    },
  };
}

// ─── 4. Bank list & account-name check ────────────────────────────────────────

let _banksCache = { rows: null, fetchedAt: 0 };
const BANKS_CACHE_MS = 30 * 60 * 1000;

function fallbackBankList() {
  const br = dep("bankResolver");
  const known = br?.KNOWN_BANKS || {};
  return Object.entries(known).map(([code, aliases]) => ({
    code,
    name: String(Array.isArray(aliases) ? aliases[0] : code)
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    country: "NG",
    logo: null,
  }));
}

async function listBanks(auth, url) {
  const country = (url.searchParams.get("country") || "NG").toUpperCase();
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  let banks = null;
  let source = "live";

  if (country === "NG" && _banksCache.rows && Date.now() - _banksCache.fetchedAt < BANKS_CACHE_MS) {
    banks = _banksCache.rows;
  } else {
    try {
      const live = await dep("paj").getBanks({ country });
      if (Array.isArray(live) && live.length > 0) {
        banks = live.map((b) => ({
          code: String(b.code || "").trim(),
          name: String(b.name || "").trim(),
          country: b.country || country,
          logo: b.logo || null,
        })).filter((b) => b.code && b.name);
        if (country === "NG") _banksCache = { rows: banks, fetchedAt: Date.now() };
      }
    } catch (_) { }
  }

  if (!banks || !banks.length) {
    banks = country === "NG" ? fallbackBankList() : [];
    source = "directory";
  }
  const filtered = q
    ? banks.filter((b) => b.name.toLowerCase().includes(q) || b.code.includes(q))
    : banks;

  return { status: 200, data: { country, source, banks: filtered } };
}

async function getBankRates() {
  let onRampRate = null;
  let offRampRate = null;
  try {
    const r = await dep("paj").getRates("NGN");
    onRampRate = Number(r?.onRampRate?.rate || r?.onRampRate?.rawRate || 0) || null;
    offRampRate = Number(r?.offRampRate?.rate || 0) || null;
  } catch (_) { }
  if (!offRampRate) {
    try { offRampRate = Number(await dep("fx").getUsdToNgnRate()) || null; } catch (_) { }
  }
  if (!onRampRate && !offRampRate) {
    throw new FeatureError(503, "rate_unavailable", "Live NGN exchange rates are temporarily unavailable. Please try again.");
  }
  return {
    status: 200,
    data: {
      currency: "NGN",
      onRampRate,
      offRampRate,
      updatedAt: new Date().toISOString(),
    },
  };
}

// Verified account names are cached so a repeat check is instant, and concurrent checks
// of the same account share one lookup.
const ACCOUNT_NAME_TTL_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_NAME_MAX = 5000;
const accountNameCache = new Map(); // key -> { accountName, bankName, at }
const accountNameInflight = new Map(); // key -> Promise

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Account name for a Nigerian bank account. Paj's directory search (fast, only knows
 * accounts registered before) and its NIBSS check (slower, works for any account) run at
 * the same time; the first one with a name wins.
 */
async function lookupBankAccountName(paj, bankCode, accountNumber) {
  const key = `${String(bankCode).padStart(6, "0")}:${accountNumber}`;
  const hit = accountNameCache.get(key);
  if (hit && Date.now() - hit.at < ACCOUNT_NAME_TTL_MS) return hit;
  if (accountNameInflight.has(key)) return accountNameInflight.get(key);

  const sameBank = (code) => !code || String(code).padStart(6, "0") === String(bankCode).padStart(6, "0");

  const search = typeof paj.searchBankAccount === "function"
    ? withTimeout(paj.searchBankAccount({ accountNumber, bankCode }), 6000)
      .then((res) => {
        const items = Array.isArray(res) ? res : (res?.data ? (Array.isArray(res.data) ? res.data : [res.data]) : [res]);
        const match = items.find((item) => item && item.accountName && sameBank(item.bank?.code));
        return match ? { accountName: String(match.accountName).trim(), bankName: match.bank?.name || match.bankName || null } : null;
      })
      .catch(() => null)
    : Promise.resolve(null);

  let registerError = null;
  const register = typeof paj.registerPermanentBankAccount === "function"
    ? withTimeout(paj.registerPermanentBankAccount(bankCode, accountNumber), 15000)
      .then((reg) => {
        const data = reg?.data || reg;
        return data?.accountName ? { accountName: String(data.accountName).trim(), bankName: data.bank?.name || data.bankName || null } : null;
      })
      .catch((err) => { registerError = err; return null; })
    : Promise.resolve(null);

  const job = new Promise((resolve) => {
    let pending = 2;
    const settle = (result) => {
      if (result) resolve(result);
      else if (--pending === 0) resolve(null);
    };
    search.then(settle);
    register.then(settle);
  }).then((result) => {
    if (result) {
      if (accountNameCache.size >= ACCOUNT_NAME_MAX) accountNameCache.delete(accountNameCache.keys().next().value);
      accountNameCache.set(key, { ...result, at: Date.now() });
      return result;
    }
    if (registerError) {
      const msg = String(registerError.message || "").toLowerCase();
      if (msg.includes("invalid") || msg.includes("not found") || msg.includes("could not")) {
        throw new FeatureError(404, "account_not_found", "Could not verify that bank account. Check the bank and account number.");
      }
      throw new FeatureError(502, "provider_error", "Bank name check is temporarily unavailable. Please try again.");
    }
    return null;
  }).finally(() => accountNameInflight.delete(key));

  accountNameInflight.set(key, job);
  return job;
}

async function resolveBankAccount(auth, body) {
  const accountNumber = reqStr(body, "accountNumber", { pattern: /^\d{10}$/ });
  const rawBank = optStr(body, "bankCode", { max: 40 }) || optStr(body, "bankName", { max: 80 });
  if (!rawBank) throw bad("bankCode or bankName is required.");

  let bankCode = rawBank;
  let bankName = optStr(body, "bankName", { max: 80 }) || null;
  try {
    const resolved = await dep("bankResolver").resolveBankCode(rawBank);
    if (resolved?.bankCode) {
      bankCode = resolved.bankCode;
      bankName = bankName || resolved.bankName;
    }
  } catch (_) { }

  if (!/^[A-Za-z0-9-]{2,20}$/.test(bankCode)) {
    throw bad("Could not recognize that bank. Pick a bank from the list.");
  }

  const found = await lookupBankAccountName(dep("paj"), bankCode, accountNumber);
  const accountName = found?.accountName || null;
  const resolvedBankName = bankName || found?.bankName || null;

  if (!accountName) {
    throw new FeatureError(404, "account_not_found", "Could not verify that bank account. Check the bank and account number.");
  }

  return {
    status: 200,
    data: {
      bankCode,
      bankName: resolvedBankName,
      accountNumber,
      accountName,
      verified: true,
    },
  };
}

// ─── 5. Naira & crypto deposits (NEAR Intents + direct) ───────────────────────

async function createNgnDeposit(auth, body) {
  const amountNgn = Number(body?.amountNgn);
  if (!Number.isFinite(amountNgn) || amountNgn < 500 || amountNgn > 50_000_000) {
    throw bad("Enter a Naira amount between ₦500 and ₦50,000,000.", "invalid_amount");
  }
  const accountType = resolveAccountType(auth, body?.accountType);
  const isBiz = accountType === "business";

  const paj = dep("paj");
  const db = dep("db");
  const arcAddr = getStrictAccountArcAddress(auth.user, accountType);
  const solAddr = dep("solanaAddress").resolveSolanaRecipient(auth.user, { isBiz });
  const externalId = isBiz ? `${auth.telegramId}-biz` : String(auth.telegramId);
  const webhookURL = process.env.PAJ_WEBHOOK_URL || (process.env.WEBHOOK_URL ? `${process.env.WEBHOOK_URL.replace(/\/$/, "")}/webhook/paj` : undefined);
  const useArc = typeof paj.isArcOnrampEnabled === "function" ? paj.isArcOnrampEnabled() : false;

  let order = null;
  let recipient = null;
  let settlementRail = "solana";

  if (useArc && arcAddr) {
    try {
      order = await paj.createOnrampOrder({
        fiatAmount: Math.round(amountNgn),
        currency: "NGN",
        recipient: arcAddr,
        mint: paj.RAILS?.arc?.mint,
        chain: paj.RAILS?.arc?.chain,
        webhookURL,
        userExternalId: externalId,
        businessUSDCFee: 0,
        metadata: { accountType, rail: "arc" },
      });
      recipient = arcAddr;
      settlementRail = "arc";
    } catch (arcErr) {
      if (!solAddr) throw arcErr;
      console.warn(`[app_api:onramp] Arc rail failed for ${externalId} (${arcErr.message}), falling back to Solana rail`);
    }
  }

  if (!order) {
    if (!solAddr) {
      throw new FeatureError(
        409,
        "wallet_verification_required",
        "Complete one PIN-confirmed action to verify your wallet before creating a Naira deposit account."
      );
    }
    order = await paj.createOnrampOrder({
      fiatAmount: Math.round(amountNgn),
      currency: "NGN",
      recipient: solAddr,
      mint: paj.RAILS?.solana?.mint,
      chain: paj.RAILS?.solana?.chain,
      webhookURL,
      userExternalId: externalId,
      businessUSDCFee: 0,
      metadata: { accountType, rail: "solana" },
    });
    recipient = solAddr;
    settlementRail = "solana";
  }

  const orderId = order?.id || order?.reference || null;
  const virtualAccount = {
    bankName: order?.bank || order?.bankName || order?.paymentDetails?.bankName || null,
    accountNumber: order?.accountNumber || order?.paymentDetails?.accountNumber || null,
    accountName: order?.accountName || order?.paymentDetails?.accountName || null,
    amountNgn: Number(order?.fiatAmount || Math.round(amountNgn)),
    expiresAt: order?.expiresAt || null,
  };

  if (orderId && typeof db.recordOnrampOrder === "function") {
    try {
      db.recordOnrampOrder({
        orderId,
        telegramId: auth.telegramId,
        accountType,
        fiatAmount: virtualAccount.amountNgn,
        amountUsdc: Number(order?.amount || 0),
        rate: Number(order?.rate || 0) || null,
        recipientAddress: recipient,
        virtualAccount: virtualAccount.accountNumber,
        settlementRail,
      });
    } catch (_) { }
  }

  return {
    status: 201,
    data: {
      accountType,
      depositAddress: recipient,
      settlementRail,
      orderId,
      status: order?.status || "pending",
      estimatedUsdc: order?.amount ?? null,
      rate: order?.rate ?? null,
      virtualAccount,
    },
  };
}

async function getCardDepositLink(auth, url) {
  const accountType = resolveAccountType(auth, url?.searchParams?.get("account"));
  const walletAddress = getStrictAccountArcAddress(auth.user, accountType);
  if (!walletAddress) throw new FeatureError(404, "wallet_missing", "Deposit wallet not found.");
  const details = dep("onramp").getOnrampDetails(walletAddress);
  return { status: 200, data: { accountType, ...details } };
}

async function getNgnDepositStatus(auth, orderId) {
  const id = decodeURIComponent(String(orderId || "")).trim();
  if (!id) throw bad("Order ID is required.");
  // Strict ownership check BEFORE querying Paj — prevents IDOR enumeration of other users' orders.
  const db = dep("db");
  const local = db.getOnrampOrderByOrderId?.(id) || null;
  if (!local || Number(local.telegram_id) !== auth.telegramId) {
    throw new FeatureError(404, "not_found", "Deposit order not found.");
  }
  let live = null;
  try { live = await dep("paj").getOnrampOrder(id); } catch (_) { }
  const liveStatus = String(live?.status || local.status || "pending").toLowerCase();
  const isCompletedNow = liveStatus === "completed" || liveStatus === "paid" || liveStatus === "settled";
  let feeTxHash = null;

  // Idempotent 0.2% on-ramp fee collection if webhook hasn't already settled this order
  if (isCompletedNow && String(local.status || "").toLowerCase() !== "completed") {
    let claimed = false;
    try {
      const upd = db.db?.prepare?.(
        "UPDATE paj_onramp_orders SET status = 'completed', completed_at = COALESCE(completed_at, datetime('now')) WHERE order_id = ? AND status != 'completed'"
      ).run(id);
      claimed = Boolean(upd && upd.changes > 0);
    } catch (_) {
      claimed = false;
    }
    if (claimed) {
      const amountUsdc = Number(live?.amount || local.amount_usdc || 0);
      const onrampFeeRate = Number(process.env.ONRAMP_PLATFORM_FEE_RATE ?? 0.002);
      const feeUsdc = Number((amountUsdc * onrampFeeRate).toFixed(4));
      const acctType = local.account_type || "personal";
      const rail = String(local.settlement_rail || live?.rail || "arc").toLowerCase();
      if (feeUsdc >= 0.0001) {
        try {
          const user = db.getUser(auth.telegramId);
          const rawKey = user && typeof db.getSystemDecryptedPrivateKey === "function"
            ? db.getSystemDecryptedPrivateKey(user, acctType)
            : null;
          if (rawKey) {
            const walletLib = dep("walletLib");
            if (rail === "solana") {
              const mc = dep("multichain");
              const solData = mc.deriveSolanaFromEvmKey(rawKey);
              let solFeeRecipient = process.env.SOLANA_FEE_RECIPIENT || null;
              if (!solFeeRecipient && process.env.DEPLOYER_PRIVATE_KEY) {
                try { solFeeRecipient = mc.deriveSolanaFromEvmKey(process.env.DEPLOYER_PRIVATE_KEY).solanaAddress; } catch (_) { }
              }
              if (!solFeeRecipient) solFeeRecipient = "4BPnUzFDibVcWQ5zzixGodRUHwqDxHYpUPdPYus3Bn56";
              if (mc.isSolanaAddress(solFeeRecipient) && solData.solanaAddress !== solFeeRecipient) {
                const feeSol = await mc.sendSolanaTransfer({ keypair: solData.keypair, recipientAddress: solFeeRecipient, amount: feeUsdc });
                if (feeSol && feeSol.success !== false) feeTxHash = feeSol.txHash || feeSol.signature || null;
              }
            } else {
              const feeRecipient =
                process.env.APP_FEE_RECIPIENT_ADDRESS ||
                process.env.PAYIT_DEV_FEE_ADDRESS ||
                process.env.FEE_RECIPIENT_ADDRESS ||
                "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359";
              const signer = walletLib.walletFromPrivateKey(rawKey);
              if (walletLib.isValidAddress(feeRecipient) && String(signer.address || "").toLowerCase() !== feeRecipient.toLowerCase()) {
                const feeMicro = walletLib.parseToMicro(feeUsdc.toFixed(6));
                const feeTx = await walletLib.sendSponsoredOrDirectTransaction(signer, feeRecipient, feeMicro, "0x", { waitForConfirmation: true });
                feeTxHash = feeTx?.txHash || feeTx?.hash || null;
              }
            }
          }
        } catch (feeErr) {
          console.warn("[app_api:onramp_status_fee_note]", feeErr.message);
        }
      }
    }
  }

  return {
    status: 200,
    data: {
      orderId: id,
      accountType: local.account_type || "personal",
      status: live?.status || local.status || "pending",
      ...(feeTxHash ? { feeTxHash } : {}),
      order: live || local,
    },
  };
}

async function listCryptoDepositTokens(auth, url = null) {
  const accountType = resolveAccountType(auth, url?.searchParams?.get("account"));
  const near = dep("near");
  const evmAddr = getStrictAccountArcAddress(auth.user, accountType);
  const solAddr = getStrictAccountSolanaAddress(auth.user, accountType);
  const [nearTokens, solanaTokens, robinhoodTokens, starknetTokens, allCatalog] = await Promise.all([
    Promise.resolve(near.getSupportedNearTokens()).catch(() => []),
    Promise.resolve(near.getSupportedSolanaTokens()).catch(() => []),
    Promise.resolve(near.getSupportedRobinhoodTokens()).catch(() => []),
    Promise.resolve(near.getSupportedStarknetTokens()).catch(() => []),
    typeof near.getAllSupportedIntentTokens === "function"
      ? Promise.resolve(near.getAllSupportedIntentTokens()).catch(() => ({ chains: [], tokensByChain: {} }))
      : Promise.resolve({ chains: [], tokensByChain: {} }),
  ]);
  const addLogos = (arr) =>
    (Array.isArray(arr) ? arr : []).map((t) => ({
      ...t,
      logoUrl: t.logoUrl || (typeof near.getTokenLogoUrl === "function" ? near.getTokenLogoUrl(t.symbol) : null),
    }));
  return {
    status: 200,
    data: {
      accountType,
      directAddresses: {
        evm: evmAddr || null,
        arc: evmAddr || null,
        base: evmAddr || null,
        arbitrum: evmAddr || null,
        optimism: evmAddr || null,
        polygon: evmAddr || null,
        avalanche: evmAddr || null,
        ethereum: evmAddr || null,
        robinhood: evmAddr || null,
        solana: solAddr || null,
      },
      chains: allCatalog?.chains || [],
      tokensByChain: allCatalog?.tokensByChain || {},
      intents: {
        near: addLogos(nearTokens),
        solana: addLogos(solanaTokens),
        robinhood: addLogos(robinhoodTokens),
        starknet: addLogos(starknetTokens),
      },
    },
  };
}

async function createCryptoDepositIntent(auth, body) {
  const rawChain = reqStr(body, "chain", { pattern: /^[A-Za-z0-9_-]{2,24}$/ }).toLowerCase();
  const symbol = reqStr(body, "symbol", { max: 32 }).toUpperCase();
  const assetId = optStr(body, "assetId", { max: 180 });
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    throw bad("Enter a valid deposit amount.", "invalid_amount");
  }
  const accountType = resolveAccountType(auth, body?.accountType);
  const recipientAddress = getStrictAccountArcAddress(auth.user, accountType);
  if (!recipientAddress) throw new FeatureError(404, "wallet_missing", "Wallet not found for this account.");

  const near = dep("near");
  const db = dep("db");
  let refundTo = optStr(body, "refundTo", { max: 128 });
  let token = null;
  let row = null;
  const chain = typeof near.normalizeIntentChainKey === "function" ? near.normalizeIntentChainKey(rawChain) : rawChain;

  const deriveNearRefund = () => {
    try {
      const sysKey = db.getSystemDecryptedPrivateKey(auth.user, accountType);
      if (sysKey && typeof near.deriveNearAddress === "function") {
        return near.deriveNearAddress(sysKey)?.nearAddress || null;
      }
    } catch (_) { }
    return null;
  };

  if (chain === "near") {
    token = await near.resolveNearToken(assetId || symbol);
    if (!token) throw bad(`Unsupported NEAR token: ${symbol}`);
    if (!refundTo) refundTo = deriveNearRefund();
    if (!refundTo) throw bad("refundTo (your NEAR refund address) is required for NEAR deposits.");
    row = await near.createNearDeposit({
      telegramId: auth.telegramId,
      accountType,
      originAsset: token.assetId,
      originSymbol: token.symbol,
      originDecimals: token.decimals,
      amount,
      amountUsdc: amount,
      recipientAddress,
      refundTo,
    });
  } else if (chain === "sol" || rawChain === "solana") {
    token = await near.resolveSolanaToken(assetId || symbol);
    if (!token && typeof near.resolveIntentToken === "function") {
      token = await near.resolveIntentToken({ chain: "sol", symbol, assetId });
    }
    if (!token) throw bad(`Unsupported Solana token: ${symbol}`);
    if (!refundTo) refundTo = getStrictAccountSolanaAddress(auth.user, accountType);
    if (!refundTo) throw bad("refundTo (your Solana refund address) is required for Solana deposits.");
    row = await near.createSolanaDeposit({
      telegramId: auth.telegramId,
      accountType,
      originAsset: token.assetId,
      originSymbol: token.symbol,
      originDecimals: token.decimals,
      amount,
      recipientAddress,
      refundTo,
    });
  } else if (chain === "hood" || rawChain === "robinhood") {
    token = await near.resolveRobinhoodToken(assetId || symbol);
    if (!token) throw bad(`Unsupported Robinhood Chain token: ${symbol}`);
    row = await near.createRobinhoodDeposit({
      telegramId: auth.telegramId,
      accountType,
      originAsset: token.assetId,
      originSymbol: token.symbol,
      originDecimals: token.decimals,
      amount,
      recipientAddress,
      refundTo: refundTo || recipientAddress,
    });
  } else if (chain === "starknet") {
    token = await near.resolveStarknetToken(assetId || symbol);
    if (!token) throw bad(`Unsupported Starknet token: ${symbol}`);
    let starkRefund = refundTo;
    if (!starkRefund) {
      try {
        const sysKey = db.getSystemDecryptedPrivateKey(auth.user, accountType);
        if (sysKey && typeof near.deriveStarknetAddress === "function") {
          starkRefund = near.deriveStarknetAddress(sysKey)?.starknetAddress || null;
        }
      } catch (_) { }
    }
    row = await near.createStarknetDeposit({
      telegramId: auth.telegramId,
      accountType,
      originAsset: token.assetId,
      originSymbol: token.symbol,
      originDecimals: token.decimals,
      amount,
      recipientAddress,
      refundTo: starkRefund || recipientAddress,
    });
  } else if (typeof near.resolveIntentToken === "function" && typeof near.createUniversalCryptoDeposit === "function") {
    token = await near.resolveIntentToken({ chain, symbol, assetId });
    if (!token) throw bad(`Unsupported token ${symbol} on ${rawChain}.`);
    const meta = typeof near.getChainMeta === "function" ? near.getChainMeta(chain) : { isEvm: false, name: rawChain };
    let refundType = "ORIGIN_CHAIN";
    if (!refundTo) {
      if (meta.isEvm) {
        refundTo = recipientAddress;
      } else {
        // Non-EVM origin chains (BTC, Tron, TON, Sui, XRP, DOGE, LTC, Cardano, Stellar, Aptos, Zcash, etc.):
        // use self-custodial NEAR Intents balance refund so deposits work immediately without requiring a separate refund wallet.
        refundTo = deriveNearRefund();
        refundType = "INTENTS";
      }
    }
    if (!refundTo) {
      throw bad(`Enter your ${meta.name} refund address (refundTo) to continue.`);
    }
    row = await near.createUniversalCryptoDeposit({
      telegramId: auth.telegramId,
      accountType,
      originAsset: token.assetId,
      originSymbol: token.symbol,
      originDecimals: token.decimals,
      amount,
      recipientAddress,
      refundTo,
      refundType,
    });
  } else {
    throw bad(`Unsupported chain: ${rawChain}`);
  }

  return {
    status: 201,
    data: {
      accountType,
      recipientAddress,
      depositId: row.id,
      chain,
      symbol: token.symbol,
      amount,
      depositAddress: row.deposit_address,
      depositMemo: row.deposit_memo || null,
      refundTo: refundTo || recipientAddress,
      estimatedAmountOutUsdc: row.amount_out || null,
      deadline: row.deadline || null,
      status: row.status || "pending",
      instructions: `Send exactly ${amount} ${token.symbol} on ${chain} to ${row.deposit_address}`,
    },
  };
}

async function getCryptoDepositStatus(auth, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw bad("Invalid deposit ID.");
  const row = dep("db").getNearDepositById(id);
  if (!row || Number(row.telegram_id) !== auth.telegramId) {
    throw new FeatureError(404, "not_found", "Deposit not found.");
  }
  let liveStatus = null;
  if (row.deposit_address) {
    try { liveStatus = await dep("near").getExecutionStatus(row.deposit_address, row.deposit_memo); } catch (_) { }
  }
  return { status: 200, data: { deposit: row, liveStatus } };
}

// ─── 6. Global accounts & payout corridors ────────────────────────────────────

async function listGlobalAccounts(auth, url) {
  const accountType = resolveAccountType(auth, url.searchParams.get("account"));
  const db = dep("db");
  const corridors = dep("nuvionCorridors");
  const entity = db.getNuvionEntityByUser(auth.telegramId, accountType);
  const supportedCurrencies = corridors?.ALL_NUVION_RECEIVING_CURRENCIES || ["USD", "GBP", "EUR", "NGN", "AED", "KES", "GHS", "TZS", "MXN", "CAD"];

  if (!entity) {
    return {
      status: 200,
      data: { accountType, kycStatus: "not_started", supportedCurrencies, accounts: [] },
    };
  }
  const details = db.getNuvionAccountDetailsByEntity(entity.entity_id).filter((d) => d.asset_type === "fiat");
  const intlBanks = dep("internationalBanks");
  const accounts = await Promise.all(
    details.map(async (d) => {
      let liveCode = null;
      if (!d.bank_code && d.bank_name && intlBanks && typeof intlBanks.enrichReceivingBankCodeLive === "function") {
        try {
          liveCode = await intlBanks.enrichReceivingBankCodeLive(d.currency, d.bank_name);
        } catch (_) { }
      }
      return formatGlobalAccount(d, liveCode);
    })
  );
  return {
    status: 200,
    data: {
      accountType,
      kycStatus: entity.status || "pending",
      supportedCurrencies,
      accounts,
    },
  };
}

async function provisionGlobalAccount(auth, body, rawCurrency) {
  const currency = String(rawCurrency || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw bad("Invalid currency code.");
  const accountType = resolveAccountType(auth, body?.accountType);
  const entity = dep("db").getNuvionEntityByUser(auth.telegramId, accountType);
  if (!entity || String(entity.status || "").toLowerCase() !== "approved") {
    throw new FeatureError(403, "kyc_required", "Complete ID verification to open Global Neobank accounts.");
  }
  try {
    const res = await dep("nuvionOrchestrator").provisionGlobalReceivingAccount(auth.telegramId, accountType, currency);
    const intlBanks = dep("internationalBanks");
    let liveCode = null;
    if (res.detail && !res.detail.bank_code && res.detail.bank_name && intlBanks && typeof intlBanks.enrichReceivingBankCodeLive === "function") {
      try {
        liveCode = await intlBanks.enrichReceivingBankCodeLive(res.detail.currency, res.detail.bank_name);
      } catch (_) { }
    }
    return {
      status: res.cached ? 200 : 201,
      data: {
        accountType,
        account: formatGlobalAccount(res.detail, liveCode),
        isPending: Boolean(res.isPending),
        cached: Boolean(res.cached),
      },
    };
  } catch (err) {
    const msg = String(err.message || "Could not open global account.").replace(/nuvion/gi, "Global Neobank");
    throw new FeatureError(400, "provision_failed", msg);
  }
}

function buildGlobalFieldSpec(fieldKey, rail) {
  const cur = String(rail.currency || "").toUpperCase();
  const base = {
    account_holder_name: { label: "Recipient full name", placeholder: "e.g. Jane Smith", keyboardType: "default" },
    account_number: { label: "Account number", placeholder: "Recipient bank account number", keyboardType: "number-pad" },
    routing_number: { label: "Routing number (ABA 9 digits)", placeholder: "e.g. 021000021", keyboardType: "number-pad" },
    sort_code: { label: "Sort code (6 digits)", placeholder: "e.g. 040004", keyboardType: "number-pad" },
    iban: { label: "IBAN", placeholder: "e.g. DE89370400440532013000", keyboardType: "default", autoCapitalize: "characters" },
    swift_bic: { label: "SWIFT / BIC code", placeholder: "e.g. COBADEFFXXX", keyboardType: "default", autoCapitalize: "characters" },
    bank_code: { label: "Bank code", placeholder: "Local bank code", keyboardType: "default" },
    branch_code: { label: "Branch code", placeholder: "e.g. 000", keyboardType: "number-pad" },
    bank_name: { label: "Bank name", placeholder: "e.g. Barclays", keyboardType: "default" },
    bank_institution_number: { label: "Institution number (3 digits)", placeholder: "e.g. 003", keyboardType: "number-pad" },
    transit_number: { label: "Transit number (5 digits)", placeholder: "e.g. 12345", keyboardType: "number-pad" },
    email: { label: "Interac email address", placeholder: "name@example.com", keyboardType: "email-address", autoCapitalize: "none" },
    phone_number: { label: "Mobile money phone number", placeholder: "Include country code (e.g. +233...)", keyboardType: "phone-pad" },
    scheme: { label: "Mobile money network", placeholder: "Select network", keyboardType: "default" },
    country: { label: "Recipient bank country (2-letter ISO)", placeholder: `e.g. ${rail.country || "CH"}`, keyboardType: "default", autoCapitalize: "characters" },
    bank_address_line1: { label: "Bank street address", placeholder: "e.g. 270 Park Ave", keyboardType: "default" },
    bank_address_city: { label: "Bank city", placeholder: "e.g. New York", keyboardType: "default" },
    bank_address_state: { label: "Bank state (2-letter code)", placeholder: "e.g. NY", keyboardType: "default", autoCapitalize: "characters" },
    bank_address_postal_code: { label: "Bank postal / ZIP code", placeholder: "e.g. 10017", keyboardType: "default" },
  }[fieldKey] || { label: fieldKey.replace(/_/g, " "), placeholder: "", keyboardType: "default" };

  const spec = { key: fieldKey, ...base };
  // Currency-specific precision labels & placeholders
  if (fieldKey === "account_number") {
    if (cur === "GBP") { spec.label = "UK Account number (8 digits)"; spec.placeholder = "e.g. 12345678"; }
    else if (cur === "MXN") { spec.label = "CLABE number (18 digits)"; spec.placeholder = "e.g. 002180000123456789"; }
    else if (cur === "NGN") { spec.label = "NUBAN Account number (10 digits)"; spec.placeholder = "e.g. 0690000031"; }
    else if (cur === "CNY") { spec.label = "Chinese bank account / card number"; spec.placeholder = "e.g. 6230810325651744"; }
    else if (cur === "USD") { spec.label = "US Account number"; spec.placeholder = "e.g. 987654321012"; }
    else if (cur === "CAD") { spec.label = "Canadian Account number"; spec.placeholder = "e.g. 7891234"; }
  } else if (fieldKey === "bank_code") {
    if (cur === "AUD") { spec.label = "BSB Bank code (first 3 digits)"; spec.placeholder = "e.g. 062"; spec.keyboardType = "number-pad"; }
    else if (cur === "HKD") { spec.label = "Bank code (3 digits)"; spec.placeholder = "e.g. 004"; spec.keyboardType = "number-pad"; }
    else if (cur === "ZAR") { spec.label = "Universal branch code (6 digits)"; spec.placeholder = "e.g. 250655"; spec.keyboardType = "number-pad"; }
    else if (cur === "PHP") { spec.label = "Bank code / BIC"; spec.placeholder = "e.g. BNORPHMM"; }
    else if (cur === "UGX") { spec.label = "Bank code (6 digits)"; spec.placeholder = "e.g. 040147"; spec.keyboardType = "number-pad"; }
  } else if (fieldKey === "branch_code") {
    if (cur === "AUD") { spec.label = "BSB Branch code (last 3 digits)"; spec.placeholder = "e.g. 000"; }
    else if (cur === "HKD") { spec.label = "Branch code (3 digits)"; spec.placeholder = "e.g. 123"; }
  } else if (fieldKey === "iban") {
    if (cur === "AED") { spec.label = "UAE IBAN (23 characters)"; spec.placeholder = "e.g. AE070331234567890123456"; }
    else if (cur === "EUR") { spec.label = "SEPA IBAN"; spec.placeholder = "e.g. DE89370400440532013000"; }
  } else if (fieldKey === "phone_number") {
    if (cur === "GHS") spec.placeholder = "e.g. +233241234567";
    else if (cur === "KES") spec.placeholder = "e.g. +254712345678";
    else if (cur === "TZS") spec.placeholder = "e.g. +255754123456";
  } else if (fieldKey === "scheme" && Array.isArray(rail.schemeOptions)) {
    spec.options = rail.schemeOptions;
  } else if (fieldKey === "bank_name") {
    const bankExamples = {
      GBP: "e.g. Barclays, Monzo, Lloyds",
      EUR: "e.g. Commerzbank, ING, BNP Paribas",
      USD: "e.g. JPMorgan Chase, Bank of America",
      CAD: "e.g. Royal Bank of Canada, TD",
      AUD: "e.g. Commonwealth Bank, ANZ",
      AED: "e.g. Emirates NBD, ADCB",
      SGD: "e.g. DBS Bank, OCBC",
      CNY: "e.g. Bank of China, ICBC",
      KES: "e.g. KCB Bank, Equity Bank",
      GHS: "e.g. GCB Bank, Ecobank Ghana",
      ZAR: "e.g. FNB, Standard Bank",
    };
    if (bankExamples[cur]) spec.placeholder = bankExamples[cur];
  }
  return spec;
}

const POPULAR_GLOBAL_ORDER = [
  "GBP", "EUR", "USD", "CAD", "AUD", "AED", "KES", "GHS",
  "ZAR", "CNY", "SGD", "HKD", "PHP", "MXN", "TZS", "UGX",
  "CHF", "JPY", "NZD", "BRL", "KRW", "THB", "ILS", "SEK", "NOK", "DKK", "NGN",
];

async function listGlobalCorridors() {
  const c = dep("nuvionCorridors");
  const allCurrencies = Array.isArray(c.ALL_NUVION_FIAT_CURRENCIES) ? c.ALL_NUVION_FIAT_CURRENCIES : [];
  const infoMap = c.CURRENCY_INFO || {};
  const orderedCurrencies = [
    ...POPULAR_GLOBAL_ORDER.filter((code) => allCurrencies.includes(code)),
    ...allCurrencies.filter((code) => !POPULAR_GLOBAL_ORDER.includes(code)),
  ];

  const formatRail = (r, currencyOverride = null) => {
    const cur = String(currencyOverride || r.currency || "").toUpperCase();
    const info = infoMap[cur] || {};
    const effective = {
      ...r,
      currency: cur,
      country: r.country || info.defaultCountry || null,
    };
    const fields = Array.isArray(effective.fields) ? effective.fields : [];
    return {
      railKey: effective.key,
      currency: cur,
      currencyName: info.name || cur,
      country: effective.country,
      label: effective.label,
      paymentMethod: effective.paymentMethod,
      settlement: effective.settlement,
      minAmount: effective.minAmount || null,
      maxAmount: effective.maxAmount || null,
      schemeOptions: effective.schemeOptions || null,
      promptHint: effective.promptHint || null,
      example: effective.example || null,
      requiredFields: fields.map((f) => buildGlobalFieldSpec(f, effective)),
    };
  };

  // Grouped corridors: 1 entry per currency across ALL 27 supported currencies, with local + SWIFT rails.
  const corridors = orderedCurrencies.map((code) => {
    const info = infoMap[code] || {};
    const currencyRails = typeof c.getRailsForCurrency === "function"
      ? c.getRailsForCurrency(code).map((r) => formatRail(r, code))
      : Object.values(c.PAYOUT_RAILS || {})
        .filter((r) => r.currency === code)
        .map((r) => formatRail(r, code));
    return {
      currency: code,
      name: info.name || code,
      symbol: info.symbol || `${code} `,
      country: info.defaultCountry || code.slice(0, 2),
      region: info.region || "other",
      rails: currencyRails,
    };
  }).filter((cor) => cor.rails.length > 0);

  // Backward-compatible flat rails array (concrete currencies only; no "*" wildcards).
  const rails = corridors.flatMap((cor) => cor.rails);

  return {
    status: 200,
    data: {
      currencies: orderedCurrencies,
      receivingCurrencies: c.ALL_NUVION_RECEIVING_CURRENCIES || [],
      corridors,
      rails,
    },
  };
}

// ─── 7. Cards list & card transactions ────────────────────────────────────────

async function listCards(auth, url) {
  const accountType = resolveAccountType(auth, url.searchParams.get("account"));
  try {
    const cards = await dep("nuvionCards").getUserCardsWithBalances(auth.telegramId, accountType);
    return { status: 200, data: { accountType, cards: Array.isArray(cards) ? cards : [] } };
  } catch (err) {
    if (String(err.message || "").toLowerCase().includes("not found") || String(err.message || "").toLowerCase().includes("entity")) {
      return { status: 200, data: { accountType, cards: [] } };
    }
    throw new FeatureError(502, "provider_error", "Could not load cards right now.");
  }
}

async function listCardTransactions(auth, url, rawCardId) {
  const cardId = decodeURIComponent(String(rawCardId || "")).trim();
  if (!cardId) throw bad("Card ID is required.");
  const accountType = resolveAccountType(auth, url.searchParams.get("account"));
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
  const transactions = await dep("nuvionCards").fetchCardTransactions({
    telegramId: auth.telegramId,
    accountType,
    cardId,
    limit,
  });
  return { status: 200, data: { accountType, cardId, transactions: Array.isArray(transactions) ? transactions : [] } };
}

// ─── 8. Bill providers & meter validation ─────────────────────────────────────

async function listBillProviders(auth, url) {
  const airbills = dep("airbills");
  const category = (url.searchParams.get("category") || "").trim().toLowerCase();
  if (!category) {
    return {
      status: 200,
      data: {
        categories: Object.values(airbills.PRODUCTS || {}),
        networks: airbills.NETWORKS || [],
      },
    };
  }
  if (category === "airtime") {
    return { status: 200, data: { category, providers: airbills.NETWORKS || [] } };
  }
  if (category === "data" || category === "internet") {
    const networkId = (url.searchParams.get("networkId") || "").trim() || null;
    const providers = await airbills.listDataPlans(networkId);
    return { status: 200, data: { category, providers } };
  }
  if (category === "electricity") {
    const providers = await airbills.listElectricityProviders();
    return { status: 200, data: { category, providers } };
  }
  if (category === "cable") {
    const provider = (url.searchParams.get("provider") || "").trim() || null;
    const providers = await airbills.listCablePackages(provider);
    return { status: 200, data: { category, providers } };
  }
  if (category === "betting") {
    const providers = await airbills.listBettingPlatforms();
    return { status: 200, data: { category, providers } };
  }
  if (category === "transport") {
    const providers = await airbills.listTransportServices();
    return { status: 200, data: { category, providers } };
  }
  throw bad("Unknown bill category.");
}

async function validateBillMeter(auth, body) {
  const meterNo = reqStr(body, "meterNo", { max: 40 });
  const electId = reqStr(body, "electId", { max: 40 });
  const details = await dep("airbills").validateMeter(meterNo, electId);
  return { status: 200, data: { valid: true, details } };
}

// ─── 9. Schedules list, cancel, pause, resume ─────────────────────────────────

async function listSchedules(auth) {
  const rows = dep("schedules").listSchedules(auth.telegramId);
  return { status: 200, data: { schedules: rows } };
}

async function updateScheduleStatus(auth, rawId, status) {
  const id = Number(decodeURIComponent(String(rawId || "")).trim());
  if (!Number.isInteger(id) || id <= 0) throw bad("Schedule ID is required.");
  const schedules = dep("schedules");
  const existing = schedules.getSchedule(auth.telegramId, id);
  if (!existing) {
    throw new FeatureError(404, "schedule_not_found", "Schedule not found.");
  }
  if (existing.status === "cancelled" && status !== "cancelled") {
    throw new FeatureError(409, "schedule_cancelled", "A cancelled schedule cannot be resumed. Create a new one instead.");
  }
  schedules.setStatus(auth.telegramId, id, status);
  const updated = schedules.getSchedule(auth.telegramId, id);
  return { status: 200, data: { success: true, schedule: updated } };
}

// ─── 10. Rewards ──────────────────────────────────────────────────────────────

async function getRewards(auth, url) {
  const db = dep("db");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
  const pointsBalance = db.getPointsBalance(auth.telegramId);
  const history = db.getPointsHistory(auth.telegramId, limit) || [];
  const referralCode = auth.user.referral_code || `ref${auth.telegramId}`;
  const botUsername = (process.env.BOT_USERNAME || "ProximPayBot").replace(/^@/, "");
  const referralLink = `https://t.me/${botUsername}?start=${encodeURIComponent(referralCode)}`;
  let referredCount = 0;
  try {
    const row = db.db.prepare("SELECT COUNT(*) AS c FROM users WHERE referrer_telegram_id = ?").get(Number(auth.telegramId));
    referredCount = Number(row?.c || 0);
  } catch (_) { }

  return {
    status: 200,
    data: {
      pointsBalance,
      pointsPerUsd: 20,
      minRedeemPoints: 20,
      redeemValueUsd: Number((pointsBalance / 20).toFixed(2)),
      referralCode,
      referralLink,
      referredCount,
      history: history.map((h) => ({
        id: h.id,
        points: Number(h.points || 0),
        action: h.action,
        details: h.details || null,
        createdAt: h.created_at || null,
      })),
    },
  };
}

// ─── 11. ID verification (KYC / KYB) status ───────────────────────────────────

async function syncLiveEntityAndNotify(entity, accountType) {
  if (!entity?.entity_id) return entity;
  const db = dep("db");
  const nuvion = dep("nuvion");
  if (!nuvion || typeof nuvion.getEntity !== "function" || (typeof nuvion.isNuvionConfigured === "function" && !nuvion.isNuvionConfigured())) {
    return entity;
  }
  const prevStatus = String(entity.status || "").toLowerCase();
  try {
    const liveWrapper = await Promise.race([
      nuvion.getEntity(entity.entity_id),
      new Promise((_, reject) => setTimeout(() => reject(new Error("kyc_status_timeout")), 4000)),
    ]);
    const liveEntity = liveWrapper?.entity || liveWrapper || null;
    const latestStatus = String(liveEntity?.status || "").toLowerCase();
    if (!latestStatus) return entity;

    const rejectionReason = liveEntity?.rejection_reason || liveEntity?.status_reason || null;
    let updated = db.updateNuvionEntity(entity.entity_id, {
      status: latestStatus,
      risk_level: liveEntity?.risk_level || entity.risk_level || null,
      rejection_reason: latestStatus === "approved" ? null : rejectionReason,
    }) || entity;

    if (latestStatus === "approved" && prevStatus !== "approved") {
      try {
        const nuvionWebhooks = require("../nuvion_webhooks");
        updated = await nuvionWebhooks.bootstrapApprovedEntity(updated, { liveEntity: liveWrapper });
      } catch (bootErr) {
        console.warn(`[app_api:kyc_sync] Bootstrap note for ${entity.entity_id}:`, bootErr.message);
      }

      const idempotency = require("../idempotency");
      const emailMod = require("../email");
      const to = emailMod.resolveUserEmail(updated.telegram_id, updated, liveWrapper || liveEntity);
      if (to && idempotency.tryClaimWebhookEvent(`email_kyc_approved:${updated.entity_id}`, "email_kyc_approved", updated.entity_id)) {
        emailMod.sendKycStatusEmail({
          to,
          name: updated.legal_name,
          status: "approved",
          accountType: updated.account_type || accountType || "personal",
        }).then((r) => {
          if (!r?.sent) console.warn(`[app_api:kyc_approved_email] Not delivered to ${to}:`, r?.reason, r?.error || "");
        }).catch((e) => console.warn("[app_api:kyc_approved_email]", e.message));
      }
      try {
        const acctLabel = (updated.account_type || accountType) === "business" ? "Business Account" : "Personal Account";
        await require("../notify").notify(updated.telegram_id, {
          title: "Verification Approved — Choose Deposit Currency",
          html: `🎉 <b>Your ${acctLabel} Is Now VERIFIED!</b>\nNamed global accounts and Virtual USD Cards are unlocked. Open Proxim to choose whether deposits stay in local currency or auto-convert to USD.`,
          data: { type: "kyc_approved", entityId: updated.entity_id },
        });
      } catch (_) { }
    }
    return updated;
  } catch (_) {
    return entity;
  }
}

async function getKycStatus(auth) {
  const db = dep("db");
  const fg = dep("fraudGuard");
  let personal = db.getNuvionEntityByUser(auth.telegramId, "personal");
  let business = db.getNuvionEntityByUser(auth.telegramId, "business");

  // Auto-sync live status for pending/incomplete entities so Mobile KYC/KYB never stays stuck if a webhook was missed
  if (personal && ["pending", "incomplete", "in_review", "under_review"].includes(String(personal.status || "").toLowerCase())) {
    personal = await syncLiveEntityAndNotify(personal, "personal");
  }
  if (business && ["pending", "incomplete", "in_review", "under_review"].includes(String(business.status || "").toLowerCase())) {
    business = await syncLiveEntityAndNotify(business, "business");
  }

  const personalApproved = String(personal?.status || "").toLowerCase() === "approved";
  const businessApproved = String(business?.status || "").toLowerCase() === "approved";
  const cfg = fg.getVelocityConfig();
  const stats = fg.getUserOutboundStats(auth.telegramId);

  return {
    status: 200,
    data: {
      personal: {
        tier: personalApproved ? 1 : 0,
        status: personal?.status || "not_started",
        legalName: personal?.legal_name || null,
        countryCode: personal?.country_code || null,
        rejectionReason: personal?.rejection_reason || null,
        updatedAt: personal?.updated_at || null,
      },
      business: {
        tier: businessApproved ? 1 : 0,
        status: business?.status || "not_started",
        legalName: business?.legal_name || null,
        countryCode: business?.country_code || null,
        rejectionReason: business?.rejection_reason || null,
        updatedAt: business?.updated_at || null,
      },
      limits: {
        hourlyUsd: personalApproved ? cfg.tier1HourlyLimitUsd : cfg.tier0HourlyLimitUsd,
        dailyUsd: personalApproved ? cfg.tier1DailyLimitUsd : cfg.tier0DailyLimitUsd,
        businessDailyUsd: businessApproved ? cfg.tier1BizDailyLimitUsd : cfg.tier0DailyLimitUsd,
        usedHourlyUsd: Number(stats.usd1h || 0),
        usedDailyUsd: Number(stats.usd24h || 0),
      },
    },
  };
}

// ─── 12. Savings read-only overview ───────────────────────────────────────────

async function getSavingsOverview(auth, url = null) {
  const db = dep("db");
  const savings = dep("savings");
  const accountType = resolveAccountType(auth, url?.searchParams?.get("account"));
  const open = db.getOpenYieldPosition(auth.telegramId, accountType);
  let pools = [];
  try { pools = await savings.getYieldPools(); } catch (_) { }
  const sortedPools = [...(Array.isArray(pools) ? pools : [])].sort(
    (a, b) => Number(b.userApy ?? b.rawApy ?? b.apy ?? 0) - Number(a.userApy ?? a.rawApy ?? a.apy ?? 0)
  );
  const topUsdcPool = sortedPools.find((p) => String(p.symbol || "USDC").toUpperCase() === "USDC") || sortedPools[0] || null;
  const topVaultAddr = topUsdcPool?.vaultAddress ? String(topUsdcPool.vaultAddress).toLowerCase() : null;

  const feeFraction = Number(savings.PAYIT_FEE_FRACTION ?? 0.1);
  const feePct = Math.round(feeFraction * 100);
  const breakdown = open && typeof savings.calcYieldBreakdown === "function"
    ? savings.calcYieldBreakdown(open)
    : (() => {
      const gross = open && typeof savings.calcAccruedYield === "function" ? Number(savings.calcAccruedYield(open) || 0) : 0;
      const fee = Number((gross * feeFraction).toFixed(6));
      return { grossYield: gross, devFee: fee, netYield: Number(Math.max(0, gross - fee).toFixed(6)), feePct };
    })();

  // The user's own rate (after Proxim's fee) at the time they saved. Older positions only
  // stored the vault's gross rate, so derive the user's share for those.
  const apyAtDeposit = open
    ? (open.user_apy != null && Number(open.user_apy) > 0 ? Number(open.user_apy) : Number(open.apy || 0) * (1 - feeFraction))
    : 0;
  const livePool = open && sortedPools.length > 0
    ? sortedPools.find((p) => String(p.vaultAddress || "").toLowerCase() === String(open.vault_address || "").toLowerCase()) || null
    : null;

  return {
    status: 200,
    data: {
      accountType,
      autoEarnEnabled: Boolean(auth.user?.auto_earn_enabled),
      platformFeePct: feePct,
      position: open ? {
        id: open.id,
        vaultName: open.project || livePool?.project || livePool?.name || "Dollar Savings",
        principalUsdc: Number(open.amount_usdc || 0),
        accruedYieldUsdc: breakdown.netYield,
        grossYieldUsdc: breakdown.grossYield,
        platformFeeUsdc: breakdown.devFee,
        apy: Number(apyAtDeposit.toFixed(2)),
        apyAtDeposit: Number(apyAtDeposit.toFixed(2)),
        currentApy: livePool ? Number(Number(livePool.userApy ?? livePool.apy ?? 0).toFixed(2)) : null,
        isAutoEarn: Boolean(open.is_auto_earn),
        symbol: open.symbol || "USDC",
        vaultAddress: open.vault_address || null,
        openedAt: open.opened_at || open.created_at || null,
      } : null,
      pools: sortedPools.map((p) => {
        const userApy = Number(p.userApy ?? p.rawApy ?? p.apy ?? 0);
        const rawApy = Number(p.rawApy ?? p.apy ?? userApy);
        const vAddr = p.vaultAddress || null;
        return {
          name: p.name || p.project || "Dollar lending vault",
          symbol: p.symbol || "USDC",
          apy: userApy,
          rawApy,
          platformFeePct: feePct,
          isHighestApy: Boolean(vAddr && topVaultAddr && String(vAddr).toLowerCase() === topVaultAddr),
          tvlUsd: Number(p.totalDeposits ?? p.tvlUsd ?? 0),
          vaultAddress: vAddr,
        };
      }),
    },
  };
}

// ─── 13. Business home, profile, invoices & payment links ─────────────────────

async function getBusinessHome(auth) {
  const bizDb = dep("bizDb");
  const bizProfile = dep("bizProfile");
  if (typeof bizDb.initBizTables === "function") bizDb.initBizTables();
  if (typeof bizProfile.initBizProfileTable === "function") bizProfile.initBizProfileTable();

  const profile = bizProfile.getBizProfile(auth.telegramId);
  const enabled = Boolean(auth.user.business_deposit_address);
  let balance = null;
  if (enabled) {
    try {
      const u = await dep("chains").getUnifiedBalance(auth.user, "business", { strictBusiness: true });
      balance = { totalUsdc: u.total, arc: u.arc, base: u.base || { usdc: 0 }, gateway: u.gateway || { usdc: 0 }, solana: u.solana, pendingBridgeUsdc: u.pendingNear };
    } catch (_) { }
  }

  const monthIncomeUsd = Number(bizDb.getMonthIncome(auth.telegramId) || 0);
  const monthExpensesUsd = Number(bizDb.getMonthExpenses(auth.telegramId) || 0);
  const monthInvoiceCount = Number(bizDb.getMonthInvoiceCount(auth.telegramId) || 0);
  const pendingInvoiceCount = Number(bizDb.getPendingInvoiceCount(auth.telegramId) || 0);
  const pendingInvoiceTotalUsd = Number(bizDb.getPendingInvoiceTotal(auth.telegramId) || 0);
  const recentClients = bizDb.getRecentClients(auth.telegramId, 5) || [];
  const topClient = bizDb.getTopClient(auth.telegramId) || null;
  const expenseBreakdown = bizDb.getExpenseBreakdown(auth.telegramId) || [];
  const savingsGoal = bizDb.getSavingsGoal(auth.telegramId) || null;
  const savingsBalanceUsd = Number(bizDb.getBizSavingsBalance(auth.telegramId) || 0);

  return {
    status: 200,
    data: {
      enabled,
      depositAddress: auth.user.business_deposit_address || null,
      profile: profile ? {
        businessName: profile.business_name,
        businessEmail: profile.business_email || null,
        phone: profile.phone || null,
        address: profile.address || null,
        defaultDueDays: Number(profile.default_due_days || 14),
        currencyDisplay: profile.currency_display || "USDC",
        logoDataUri: typeof bizProfile.getLogoDataUri === "function" ? bizProfile.getLogoDataUri(auth.telegramId) : null,
        updatedAt: profile.updated_at || null,
      } : null,
      balance,
      summary: {
        monthIncomeUsd,
        monthExpensesUsd,
        netCashFlowUsd: Number((monthIncomeUsd - monthExpensesUsd).toFixed(2)),
        monthInvoiceCount,
        pendingInvoiceCount,
        pendingInvoiceTotalUsd,
        topClient,
        recentClients,
        expenseBreakdown,
        savingsGoal,
        savingsBalanceUsd,
      },
    },
  };
}

async function updateBusinessProfile(auth, body) {
  const bizProfile = dep("bizProfile");
  if (typeof bizProfile.initBizProfileTable === "function") bizProfile.initBizProfileTable();
  const businessName = reqStr(body, "businessName", { max: 80 });
  const businessEmail = optStr(body, "businessEmail", { max: 120 });
  const phone = optStr(body, "phone", { max: 32 });
  const address = optStr(body, "address", { max: 200 });
  const defaultDueDays = body?.defaultDueDays != null ? Math.min(Math.max(Math.round(Number(body.defaultDueDays)), 1), 365) : 14;
  const currencyDisplay = optStr(body, "currencyDisplay", { pattern: /^(USDC|EURC|USD|NGN)$/i }) || "USDC";

  bizProfile.upsertBizProfile(auth.telegramId, {
    businessName,
    businessEmail,
    phone,
    address,
    defaultDueDays,
    currencyDisplay: currencyDisplay.toUpperCase(),
  });
  const saved = bizProfile.getBizProfile(auth.telegramId);
  return {
    status: 200,
    data: {
      profile: {
        businessName: saved.business_name,
        businessEmail: saved.business_email || null,
        phone: saved.phone || null,
        address: saved.address || null,
        defaultDueDays: Number(saved.default_due_days || 14),
        currencyDisplay: saved.currency_display || "USDC",
        logoDataUri: typeof bizProfile.getLogoDataUri === "function" ? bizProfile.getLogoDataUri(auth.telegramId) : null,
        updatedAt: saved.updated_at || null,
      },
    },
  };
}

async function uploadBusinessLogo(auth, body) {
  const bizProfile = dep("bizProfile");
  if (typeof bizProfile.initBizProfileTable === "function") bizProfile.initBizProfileTable();
  const raw = stripBase64DataUrl(body?.imageBase64 || body?.base64);
  if (!raw || raw.length < 32) throw bad("Please select a valid image for your business logo.");
  if (raw.length > Math.ceil(5 * 1024 * 1024 * 1.37)) throw bad("Logo image is too large (max 5 MB).");
  const existing = bizProfile.getBizProfile(auth.telegramId);
  if (!existing) {
    bizProfile.upsertBizProfile(auth.telegramId, {
      businessName: auth.user?.biz_sender_name || "Proxim Business",
    });
  }
  const buf = Buffer.from(raw, "base64");
  await bizProfile.saveLogo(auth.telegramId, buf);
  const logoDataUri = typeof bizProfile.getLogoDataUri === "function" ? bizProfile.getLogoDataUri(auth.telegramId) : null;
  return { status: 200, data: { ok: true, logoDataUri } };
}

async function listBusinessInvoices(auth, url) {
  const bizDb = dep("bizDb");
  if (typeof bizDb.initBizTables === "function") bizDb.initBizTables();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
  const rows = bizDb.getBizInvoices(auth.telegramId, limit);
  return { status: 200, data: { invoices: rows.map(formatBizInvoice) } };
}

async function getBusinessInvoice(auth, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw bad("Invalid invoice ID.");
  const bizDb = dep("bizDb");
  const row = bizDb.getBizInvoice(id);
  if (!row || Number(row.telegram_id) !== auth.telegramId) {
    throw new FeatureError(404, "invoice_not_found", "Invoice not found.");
  }
  return { status: 200, data: { invoice: formatBizInvoice(row) } };
}

async function createBusinessInvoice(auth, body) {
  const bizDb = dep("bizDb");
  const bizProfile = dep("bizProfile");
  const db = dep("db");
  if (typeof bizDb.initBizTables === "function") bizDb.initBizTables();
  if (typeof bizProfile.initBizProfileTable === "function") bizProfile.initBizProfileTable();

  const clientName = reqStr(body, "clientName", { max: 100 });
  const clientEmail = optStr(body, "clientEmail", { max: 120 });
  const notes = optStr(body, "notes", { max: 300 });
  const dueDate = optStr(body, "dueDate", { max: 32 });
  const paymentChannel = optStr(body, "paymentChannel", { pattern: /^(ngn_bank|nuvion_bank|crypto_intent|both|both_nuvion)$/ }) || "both";
  const invoiceCurrency = (optStr(body, "currency", { pattern: /^[A-Za-z]{3}$/ }) || "USD").toUpperCase();
  const nuvionBankCurrency = (optStr(body, "globalBankCurrency", { pattern: /^[A-Za-z]{3}$/ }) || optStr(body, "nuvionBankCurrency", { pattern: /^[A-Za-z]{3}$/ }) || (paymentChannel === "nuvion_bank" || paymentChannel === "both_nuvion" ? invoiceCurrency : "USD")).toUpperCase();
  const cryptoChain = optStr(body, "cryptoChain", { max: 48 }) || "arc";
  const cryptoAssetId = optStr(body, "cryptoAssetId", { max: 180 }) || null;
  const cryptoSymbol = optStr(body, "cryptoSymbol", { max: 24 }) || null;
  const cryptoBlockchain = optStr(body, "cryptoBlockchain", { max: 32 }) || null;

  let items = [];
  if (Array.isArray(body?.items) && body.items.length > 0) {
    items = body.items.slice(0, 30).map((it) => {
      const desc = String(it?.description || "").trim().slice(0, 120);
      const qty = Number(it?.quantity ?? 1);
      const price = Number(it?.unitPrice ?? it?.amount ?? 0);
      if (!desc || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) {
        throw bad("Each invoice item needs description, positive quantity, and positive unitPrice.");
      }
      return { description: desc, quantity: qty, unitPrice: price };
    });
  } else {
    const total = Number(body?.totalUsdc ?? body?.amount);
    if (!Number.isFinite(total) || total <= 0 || total > 1_000_000) {
      throw bad("Provide invoice items or a positive amount.", "invalid_amount");
    }
    items = [{ description: notes || `Invoice for ${clientName}`, quantity: 1, unitPrice: total }];
  }

  const totalAmount = Number(items.reduce((s, i) => s + i.quantity * i.unitPrice, 0).toFixed(2));
  const invoiceNumber = bizDb.getNextBizInvoiceNumber(auth.telegramId);
  const profile = bizProfile.getBizProfile(auth.telegramId);
  const walletAddress = auth.user.business_deposit_address || auth.user.deposit_address;
  if (!walletAddress) throw new FeatureError(400, "wallet_missing", "Account wallet not found.");

  // Full HD + payment channel invoice when system business key is available
  let decryptedBizKey = null;
  try {
    decryptedBizKey = db.getSystemDecryptedPrivateKey(auth.user, auth.user.business_deposit_address ? "business" : "personal");
  } catch (_) { }

  if (decryptedBizKey && typeof dep("invoiceHd").createCompleteBizInvoice === "function") {
    try {
      const created = await dep("invoiceHd").createCompleteBizInvoice({
        telegramId: auth.telegramId,
        decryptedBizKey,
        user: auth.user,
        profile,
        invoiceData: {
          invoiceNumber,
          clientName,
          clientEmail,
          items,
          totalUsdc: invoiceCurrency === "NGN" ? null : totalAmount,
          totalNgn: invoiceCurrency === "NGN" ? totalAmount : null,
          invoiceCurrency,
          paymentChannel,
          nuvionBankCurrency,
          cryptoChain,
          cryptoAssetId,
          cryptoSymbol,
          cryptoBlockchain,
          dueDate,
          notes,
        },
      });
      const row = created?.invoiceId ? bizDb.getBizInvoice(created.invoiceId) : null;
      return {
        status: 201,
        data: {
          invoice: row ? { ...formatBizInvoice(row), hasImage: true, paymentChannel, fiatCurrency: created?.fiatDetails?.currency || (paymentChannel === "ngn_bank" || paymentChannel === "both" ? "NGN" : nuvionBankCurrency), cryptoChain: created?.cryptoPaymentDetails?.chainLabel || cryptoChain } : {
            id: created?.invoiceId || null,
            invoiceNumber,
            clientName,
            clientEmail,
            items,
            totalUsdc: created?.totalUsdc ?? totalAmount,
            dueDate,
            notes,
            status: "unpaid",
            paymentAddress: created?.paymentAddress || walletAddress,
            fiatDetails: created?.fiatDetails || null,
            cryptoIntent: created?.cryptoPaymentDetails || created?.cryptoIntent || null,
            hasImage: Boolean(created?.pngPath),
          },
          paymentDetails: {
            paymentAddress: created?.cryptoPaymentDetails?.depositAddress || created?.paymentAddress || walletAddress,
            fiat: created?.fiatDetails || null,
            crypto: created?.cryptoPaymentDetails || created?.cryptoIntent || null,
            fiatPendingCurrency: created?.fiatPendingCurrency || null,
            clientCopyText: created?.clientCopyText || null,
            pngAvailable: Boolean(created?.pngPath),
          },
        },
      };
    } catch (err) {
      // Fall through to lightweight DB invoice only if HD rendering fails unexpectedly? No — report real errors if explicitly stubbed/configured,
      // except when invoice_hd cannot render because INVOICE_FORWARDING_SECRET is absent.
      if (!String(err.message || "").includes("INVOICE_FORWARDING_SECRET")) throw err;
    }
  }

  const invoiceId = bizDb.createBizInvoice(auth.telegramId, {
    invoiceNumber,
    clientName,
    clientEmail,
    items,
    totalUsdc: totalAmount,
    dueDate,
    notes,
    walletAddress,
    pngPath: null,
  });
  const saved = bizDb.getBizInvoice(invoiceId);
  return {
    status: 201,
    data: {
      invoice: formatBizInvoice(saved),
      paymentDetails: { paymentAddress: walletAddress, fiat: null, crypto: null },
    },
  };
}

function appMerchantKeyId(telegramId) {
  return `app_merchant_${telegramId}`;
}

async function listBusinessPaymentLinks(req, auth) {
  const baseUrl = getBaseUrl(req);
  const mc = dep("merchantCheckout");
  const rows = dep("db").db
    .prepare("SELECT * FROM payment_links WHERE merchant_telegram_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(Number(auth.telegramId));

  // If test mocked listPaymentLinks, also respect that if DB had none
  if (!rows.length && typeof mc.listPaymentLinks === "function") {
    const viaMc = mc.listPaymentLinks(appMerchantKeyId(auth.telegramId), baseUrl);
    return { status: 200, data: { paymentLinks: viaMc } };
  }

  const paymentLinks = rows.map((r) => ({
    linkId: r.link_id,
    slug: r.slug,
    url: baseUrl ? `${baseUrl}/pay/${r.slug}` : `/pay/${r.slug}`,
    title: r.title,
    description: r.description || null,
    amount: r.amount != null ? Number(r.amount) : null,
    currency: r.currency || "USD",
    channels: (() => { try { return JSON.parse(r.channels_json || "[]"); } catch (_) { return []; } })(),
    cryptoChain: r.crypto_chain || "sol_usdc",
    active: Boolean(r.active),
    createdAt: r.created_at || null,
  }));
  return { status: 200, data: { paymentLinks } };
}

async function createBusinessPaymentLink(req, auth, body) {
  const title = reqStr(body, "title", { max: 100 });
  const description = optStr(body, "description", { max: 240 });
  const slug = optStr(body, "slug", { max: 48 });
  const currency = (optStr(body, "currency", { pattern: /^[A-Za-z]{3}$/ }) || "USD").toUpperCase();
  const amount = body?.amount !== undefined && body?.amount !== null && body?.amount !== "" ? Number(body.amount) : null;
  if (amount !== null && (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000)) {
    throw bad("amount must be a positive number.", "invalid_amount");
  }
  const channels = Array.isArray(body?.channels) ? body.channels : ["ngn_bank", "crypto"];
  const cryptoChain = optStr(body, "cryptoChain", { max: 32 }) || "sol_usdc";
  const successUrl = optStr(body, "successUrl", { max: 300 });
  const cancelUrl = optStr(body, "cancelUrl", { max: 300 });
  const accountType = auth.user.business_deposit_address ? "business" : "personal";

  try {
    const link = dep("merchantCheckout").createPaymentLink({
      apiKey: { key_id: appMerchantKeyId(auth.telegramId), telegram_id: auth.telegramId, webhook_url: null },
      title,
      description,
      amount,
      currency,
      slug,
      channels,
      cryptoChain,
      successUrl,
      cancelUrl,
      accountType,
      baseUrl: getBaseUrl(req),
    });
    return { status: 201, data: { paymentLink: link } };
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE")) {
      throw new FeatureError(409, "slug_taken", "That payment link slug is already taken.");
    }
    throw new FeatureError(err.statusCode || 400, "payment_link_error", err.message);
  }
}

async function deactivateBusinessPaymentLink(auth, rawLinkId) {
  const linkId = decodeURIComponent(String(rawLinkId || "")).trim();
  if (!linkId) throw bad("Link ID is required.");
  dep("merchantCheckout"); // ensure payment_links schema exists
  const res = dep("db").db
    .prepare("UPDATE payment_links SET active = 0 WHERE link_id = ? AND merchant_telegram_id = ?")
    .run(linkId, Number(auth.telegramId));
  if (!res.changes) throw new FeatureError(404, "not_found", "Payment link not found.");
  return { status: 200, data: { success: true } };
}

// ─── 14. The assistant (read-only + action proposals, never moves money) ──────

async function assistantChat(auth, body) {
  const assistant = require("./assistant");
  return assistant.handleAssistantChat(auth, body, {
    db: dep("db"),
    chains: dep("chains"),
    savings: dep("savings"),
    payeeBook: dep("payeeBook"),
    bizDb: dep("bizDb"),
    intentRouter: dep("intentRouter"),
    actions: dep("actions"),
    bankResolver: dep("bankResolver"),
    fraudGuard: dep("fraudGuard") || require("../fraud_guard"),
    aiProvider: dep("aiProvider") || require("../../agent/ai_provider"),
    helpers: {
      reqStr,
      resolveAccountType,
      getStrictAccountArcAddress,
      formatContact,
      formatBizInvoice,
    },
  });
}

// ─── 15. Statement CSV export ─────────────────────────────────────────────────

function csvCell(val) {
  let s = val === null || val === undefined ? "" : String(val);
  // Prevent CSV formula injection in Excel / Google Sheets
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatAmountForCsv(raw, decimals) {
  const d = Number.isFinite(Number(decimals)) ? Number(decimals) : 18;
  const str = String(raw ?? "").trim();
  if (!str) return "0";
  if (d === 18 && /^\d+$/.test(str)) {
    try { return dep("walletLib").formatMicro(BigInt(str)); } catch (_) { }
  }
  const n = Number(str);
  if (!Number.isFinite(n)) return str;
  if (d > 0 && /^\d+$/.test(str)) {
    return (n / 10 ** d).toFixed(Math.min(d, 6)).replace(/\.?0+$/, "") || "0";
  }
  return String(n);
}

async function exportStatementCsv(auth, url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 500), 1), 2000);
  const rawAccount = url.searchParams.get("account");
  const accountType = rawAccount === "all"
    ? null
    : (rawAccount || auth.accountHeader ? resolveAccountType(auth, rawAccount) : null);
  const fromRaw = (url.searchParams.get("from") || "").trim();
  const toRaw = (url.searchParams.get("to") || "").trim();
  const fromMs = fromRaw ? Date.parse(fromRaw) : null;
  const toMs = toRaw ? Date.parse(toRaw.length === 10 ? `${toRaw}T23:59:59.999Z` : toRaw) : null;
  if (fromRaw && Number.isNaN(fromMs)) throw bad("Invalid 'from' date.");
  if (toRaw && Number.isNaN(toMs)) throw bad("Invalid 'to' date.");

  let rows = dep("db").getTransactions(auth.telegramId, limit, accountType);
  if (fromMs !== null || toMs !== null) {
    rows = rows.filter((t) => {
      const ts = t.created_at ? Date.parse(t.created_at.includes("T") ? t.created_at : `${t.created_at.replace(" ", "T")}Z`) : NaN;
      if (Number.isNaN(ts)) return false;
      if (fromMs !== null && ts < fromMs) return false;
      if (toMs !== null && ts > toMs) return false;
      return true;
    });
  }

  const header = ["id", "created_at", "account_type", "type", "status", "amount", "amount_raw", "decimals", "chain", "tx_hash", "narration"];
  const lines = [header.join(",")];
  for (const t of rows) {
    const rawAmt = t.amount_micro ?? t.amount ?? "";
    const decimals = t.decimals ?? 18;
    lines.push([
      t.id,
      t.created_at || "",
      t.account_type || "personal",
      t.type || "",
      t.status || "",
      formatAmountForCsv(rawAmt, decimals),
      rawAmt,
      decimals,
      t.chain || "arc",
      t.tx_hash || "",
      t.narration || "",
    ].map(csvCell).join(","));
  }

  const filename = `proxim-statement${accountType ? `-${accountType}` : ""}.csv`;
  return {
    status: 200,
    raw: `${lines.join("\r\n")}\r\n`,
    contentType: "text/csv; charset=utf-8",
    headers: {
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  };
}

// ─── 16. Cross-chain withdrawals, chain moves, EVM sweep & FX swap ────────────

async function listWithdrawalChains() {
  const chainsMap = dep("flowsMultichain").CCW_CHAINS || {};
  const feeUsd = Number(process.env.CROSSCHAIN_WITHDRAWAL_FEE_USDC ?? 0.30);
  return {
    status: 200,
    data: {
      feeUsd,
      chains: Object.entries(chainsMap).map(([key, c]) => ({
        key,
        name: c.name,
        label: c.label,
        token: c.token,
        engine: c.engine,
        example: c.example,
      })),
    },
  };
}

async function listBridgeMoves(auth) {
  const db = dep("db");
  const burns = db.getRecentCctpBurnsByUser ? db.getRecentCctpBurnsByUser(auth.telegramId, 10) : [];
  const inbounds = db.getRecentInboundByUser ? db.getRecentInboundByUser(auth.telegramId, 10) : [];
  return {
    status: 200,
    data: {
      arcToSolana: burns.map((b) => ({
        id: b.id,
        amountUsdc: Number(b.amount_usdc || 0),
        status: b.status,
        arcTxHash: b.arc_tx_hash || null,
        solanaTxSig: b.solana_tx_sig || null,
        createdAt: b.created_at || null,
      })),
      solanaToArc: inbounds.map((t) => ({
        id: t.id,
        amountUsdc: Number(t.amount_usdc || 0),
        status: t.status,
        solanaTxSig: t.solana_tx_sig || null,
        arcTxHash: t.arc_tx_hash || null,
        createdAt: t.created_at || null,
      })),
    },
  };
}

async function sweepCryptoDeposits(auth, body) {
  const onlyAccountType = optStr(body, "accountType", { pattern: /^(personal|business)$/ });
  const onlyChain = optStr(body, "chain", { max: 32 });
  const results = await dep("evmSweeper").sweepUserDeposits(
    auth.telegramId,
    dep("notify").getNotifyBot?.() || null,
    { onlyAccountType: onlyAccountType || undefined, onlyChain: onlyChain || undefined }
  );
  return { status: 200, data: { swept: Array.isArray(results) ? results : [] } };
}

async function getSwapRates() {
  const swap = dep("swap");
  if (typeof swap.getUsdcEurcPairRate === "function") {
    const info = await swap.getUsdcEurcPairRate();
    return {
      status: 200,
      data: {
        pair: {
          usdcUsd: info.usdcUsd,
          eurcUsd: info.eurcUsd,
          usdcToEurc: info.usdcToEurc,
          eurcToUsdc: info.eurcToUsdc,
          feePct: info.feePct,
          updatedAt: info.updatedAt,
        },
        rates: info.rawRates || {},
      },
    };
  }
  const rates = await swap.getFxRates();
  return { status: 200, data: { pair: null, rates } };
}

async function quoteSwap(auth, body) {
  const tokenIn = reqStr(body, "tokenIn", { pattern: /^(USDC|EURC)$/i }).toUpperCase();
  const tokenOut = reqStr(body, "tokenOut", { pattern: /^(USDC|EURC)$/i }).toUpperCase();
  if (tokenIn === tokenOut) throw bad("Choose two different currencies to swap.");
  const amountIn = Number(body?.amountIn);
  if (!Number.isFinite(amountIn) || amountIn < 1 || amountIn > 1_000_000) {
    throw bad("Enter a valid swap amount (minimum 1).", "invalid_amount");
  }
  const amountMicro = dep("walletLib").parseToMicro(amountIn.toFixed(6));
  const quote = await dep("swap").getSwapQuote(tokenIn, tokenOut, amountMicro);
  return { status: 200, data: { quote } };
}

// ─── 17. Social gift links (list & claim) ─────────────────────────────────────

async function listPendingGifts(auth) {
  const rows = dep("db").getPendingSocialEscrowsBySender(auth.telegramId) || [];
  return {
    status: 200,
    data: {
      gifts: rows.map((g) => ({
        id: g.id,
        claimToken: g.claim_token,
        targetHandle: g.target_handle,
        amountUsdc: Number(g.amount_usdc || 0),
        status: g.status,
        expiresAt: g.expires_at || null,
        createdAt: g.created_at || null,
      })),
    },
  };
}

async function claimGift(auth, body) {
  const st = dep("socialTransfers");
  const raw = reqStr(body, "claimToken", { max: 128 });
  const claimToken = st.extractClaimToken(raw) || raw;
  try {
    const res = await st.releaseEscrowToRecipient({
      claimToken,
      claimantTelegramId: auth.telegramId,
      claimantUsername: auth.user.username || null,
      recipientAddress: auth.user.deposit_address,
    });
    return { status: 200, data: { success: true, txHash: res.txHash, escrow: res.escrow } };
  } catch (err) {
    throw new FeatureError(400, "claim_failed", err.message);
  }
}

// ─── 18. Global payout recipients, hosted payment links & KYC/KYB submit ──────

async function listGlobalBankCodes(_auth, url) {
  const currency = String(url.searchParams.get("currency") || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw bad("Invalid currency code.");
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const intlBanks = dep("internationalBanks");
  const list = intlBanks && typeof intlBanks.getLiveBanksForCurrency === "function"
    ? await intlBanks.getLiveBanksForCurrency(currency)
    : [];
  const filtered = q
    ? list.filter((b) =>
      String(b.name || "").toLowerCase().includes(q) ||
      String(b.code || "").toLowerCase().includes(q) ||
      String(b.swiftBic || "").toLowerCase().includes(q)
    )
    : list;
  return {
    status: 200,
    data: {
      currency,
      banks: filtered.slice(0, 60).map((b) => ({
        code: b.bankCode || b.code || "",
        name: b.name,
        swiftBic: b.swiftBic || null,
        institutionNumber: b.institutionNumber || null,
      })),
    },
  };
}

async function listGlobalRecipients(auth, url) {
  const accountType = resolveAccountType(auth, url.searchParams.get("account"));
  const currency = (url.searchParams.get("currency") || "").trim().toUpperCase() || null;
  const db = dep("db");
  const entity = db.getNuvionEntityByUser(auth.telegramId, accountType);
  if (!entity) return { status: 200, data: { recipients: [] } };
  const rows = db.getNuvionCounterpartiesByEntity(entity.entity_id, currency) || [];
  const filtered = rows.filter((c) => {
    try {
      const s = c.summary_json ? JSON.parse(c.summary_json) : {};
      return !s.isSelf && !s.isPlatformMargin && !String(c.label || "").startsWith("__proxim_");
    } catch (_) { return true; }
  });
  return {
    status: 200,
    data: {
      recipients: filtered.map((c) => {
        let summary = {};
        try { summary = c.summary_json ? JSON.parse(c.summary_json) : {}; } catch (_) { }
        return {
          id: c.id,
          counterpartyId: c.counterparty_id,
          label: c.label,
          currency: c.currency,
          accountHolderName: c.account_holder_name || null,
          railKey: summary.railKey || c.scheme || null,
          bankName: summary.bankName || null,
          accountTail: summary.accountTail || null,
        };
      }),
    },
  };
}

async function createGlobalPaymentLink(auth, body) {
  const accountType = resolveAccountType(auth, body?.accountType);
  const currency = reqStr(body, "currency", { pattern: /^[A-Za-z]{3}$/ }).toUpperCase();
  const amountMajor = Number(body?.amount);
  if (!Number.isFinite(amountMajor) || amountMajor <= 0) throw bad("Enter a positive payment amount.", "invalid_amount");
  const fundingType = reqStr(body, "fundingType", { pattern: /^(open-banking|interac|momo)$/ });
  const entity = dep("db").getNuvionEntityByUser(auth.telegramId, accountType);
  if (!entity || String(entity.status || "").toLowerCase() !== "approved") {
    throw new FeatureError(403, "kyc_required", "Complete ID verification to create Global Neobank payment links.");
  }
  try {
    const res = await dep("nuvionOrchestrator").createHostedPaymentLink({
      telegramId: auth.telegramId,
      accountType,
      currency,
      amountMajor,
      fundingType,
      payerName: optStr(body, "payerName", { max: 80 }),
      payerEmail: optStr(body, "payerEmail", { max: 120 }),
      msisdn: optStr(body, "msisdn", { max: 32 }),
      momoChannel: optStr(body, "momoChannel", { max: 40 }),
      narration: optStr(body, "narration", { max: 80 }),
    });
    return {
      status: 201,
      data: {
        sessionId: res?.session?.id || null,
        paymentUrl: res?.session?.hosted_url || res?.session?.checkout_url || res?.session?.url || null,
        status: res?.session?.status || "pending",
        session: res?.session || null,
      },
    };
  } catch (err) {
    throw new FeatureError(400, "payment_link_error", String(err.message || "Could not create payment link.").replace(/nuvion/gi, "Global Neobank"));
  }
}

function stripBase64DataUrl(val) {
  const s = String(val || "").trim();
  const m = s.match(/^data:[^;]+;base64,(.+)$/i);
  return m ? m[1] : s;
}

/**
 * Inspect magic bytes first (reliable even when Android sends application/octet-stream or ""),
 * then fall back to explicit MIME and filename extension.
 */
function detectDocumentMime(buffer, rawMime = "", fileName = "") {
  if (Buffer.isBuffer(buffer) && buffer.length >= 4) {
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
      return "application/pdf"; // %PDF
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "image/jpeg";
    }
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return "image/png";
    }
    if (buffer.length >= 12 && buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") {
      return "image/webp";
    }
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; // DOCX (ZIP)
    }
    if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
      return "application/msword"; // Legacy DOC (OLE2)
    }
  }
  const m = String(rawMime || "").trim().toLowerCase();
  if (m === "image/jpg") return "image/jpeg";
  if (m && m !== "application/octet-stream" && m !== "*/*" && !m.endsWith("/*")) {
    return m;
  }
  const n = String(fileName || "").trim().toLowerCase();
  if (n.endsWith(".pdf")) return "application/pdf";
  if (n.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (n.endsWith(".doc")) return "application/msword";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".webp")) return "image/webp";
  return m || "application/octet-stream";
}

/**
 * Pure-Node minimal single-page PDF wrapper around a raw JPEG buffer.
 * Lets users upload a clear photo of a Certificate of Incorporation when Nuvion requires PDF.
 */
function wrapJpegBufferAsPdf(jpegBuf, width = 1200, height = 1600) {
  const w = Math.max(100, Math.round(width || 1200));
  const h = Math.max(100, Math.round(height || 1600));
  // Scale to fit A4-like points (max 595 x 842)
  const scale = Math.min(595 / w, 842 / h, 1);
  const pw = Math.round(w * scale);
  const ph = Math.round(h * scale);

  const chunks = [];
  const offsets = [0];
  let byteLen = 0;
  const push = (val) => {
    const b = Buffer.isBuffer(val) ? val : Buffer.from(val, "latin1");
    chunks.push(b);
    byteLen += b.length;
  };
  const startObj = (num) => {
    offsets[num] = byteLen;
    push(`${num} 0 obj\n`);
  };

  push("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n");
  startObj(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  startObj(2);
  push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  startObj(3);
  push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
  startObj(4);
  push(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBuf.length} >>\nstream\n`);
  push(jpegBuf);
  push("\nendstream\nendobj\n");
  const contentStream = `q\n${pw} 0 0 ${ph} 0 0 cm\n/Im0 Do\nQ\n`;
  startObj(5);
  push(`<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream\nendobj\n`);

  const xrefPos = byteLen;
  push("xref\n0 6\n0000000000 65535 f \n");
  for (let i = 1; i <= 5; i++) {
    push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

/**
 * Normalize an uploaded document buffer for Nuvion:
 * - Detects real MIME from magic bytes / filename (fixes Android application/octet-stream)
 * - Converts WEBP/HEIC/oversized images to JPEG via sharp
 * - If requirePdf=true and user uploaded a JPG/PNG photo (e.g. CAC cert), wraps it into a valid PDF!
 */
async function normalizeDocumentForNuvion(rawBase64, rawMime = "", fileName = "", { requirePdf = false } = {}) {
  const cleanB64 = stripBase64DataUrl(rawBase64);
  const buf = Buffer.from(cleanB64, "base64");
  let mime = detectDocumentMime(buf, rawMime, fileName);

  const isConvertibleImage = mime.startsWith("image/") && (mime !== "image/jpeg" && mime !== "image/png" || requirePdf || buf.length > 3.5 * 1024 * 1024);
  if (isConvertibleImage) {
    try {
      const sharp = require("sharp");
      const meta = await sharp(buf).rotate().metadata();
      const resized = await sharp(buf)
        .rotate()
        .resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true })
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .jpeg({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      if (requirePdf) {
        const pdfBuf = wrapJpegBufferAsPdf(resized.data, resized.info?.width || meta?.width, resized.info?.height || meta?.height);
        return { base64: pdfBuf.toString("base64"), mimeType: "application/pdf" };
      }
      return { base64: resized.data.toString("base64"), mimeType: "image/jpeg" };
    } catch (_) {
      // Fall through if buffer isn't a real decodable image (e.g. synthetic test fixture bytes)
    }
  }

  return { base64: cleanB64, mimeType: mime === "image/jpg" ? "image/jpeg" : mime };
}

// ─── 18b. Hosted KYC/KYB document upload bridge (works on any APK via browser) ─

const crypto = require("node:crypto");

const KYC_UPLOAD_SLOT_CONFIG = {
  kyc_front: {
    label: "Government ID (Front)",
    accept: "image/*,application/pdf,.pdf,.jpg,.jpeg,.png",
    mimes: new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp"]),
    hint: "Upload a clear photo or PDF of the front of your Passport, National ID, or Driver's License.",
  },
  kyc_back: {
    label: "Government ID (Back)",
    accept: "image/*,application/pdf,.pdf,.jpg,.jpeg,.png",
    mimes: new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp"]),
    hint: "Upload a clear photo or PDF of the back of your ID (optional for passports).",
  },
  kyc_poa: {
    label: "Proof of Address",
    accept: "image/*,application/pdf,.pdf,.jpg,.jpeg,.png",
    mimes: new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp"]),
    hint: "Utility bill, bank statement, or government letter dated within the last 3 months (PDF, JPG, or PNG).",
  },
  kyb_coi: {
    label: "Certificate of Incorporation (PDF or Photo)",
    accept: "*/*",
    mimes: new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp"]),
    requirePdf: true,
    hint: "Upload your company's official Certificate of Incorporation as a PDF (or clear photo — we'll convert it to PDF automatically).",
  },
  kyb_memart: {
    label: "Memorandum & Articles of Association",
    accept: "*/*",
    mimes: new Set([
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp",
    ]),
    requirePdf: true,
    hint: "Upload your Memorandum & Articles of Association (PDF, DOC, DOCX, or clear photo).",
  },
  kyb_biz_poa: {
    label: "Business Proof of Address",
    accept: "image/*,application/pdf,.pdf,.jpg,.jpeg,.png",
    mimes: new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp"]),
    hint: "Company utility bill or bank statement dated within the last 3 months (PDF, JPG, or PNG).",
  },
  kyb_officer_id_front: {
    label: "Officer Government ID (Front)",
    accept: "image/*,application/pdf,.pdf,.jpg,.jpeg,.png",
    mimes: new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp"]),
    hint: "Clear photo or PDF of the controlling director/owner's valid government ID.",
  },
  kyb_officer_id_back: {
    label: "Officer Government ID (Back)",
    accept: "image/*,application/pdf,.pdf,.jpg,.jpeg,.png",
    mimes: new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp"]),
    hint: "Clear photo or PDF of the back of the officer's government ID (optional for passports).",
  },
  kyb_officer_poa: {
    label: "Officer Proof of Address",
    accept: "image/*,application/pdf,.pdf,.jpg,.jpeg,.png",
    mimes: new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp"]),
    hint: "Personal utility bill or bank statement (< 3 months) for the controlling director/owner (PDF, JPG, or PNG).",
  },
};

const KYC_UPLOAD_TTL_MS = 15 * 60 * 1000; // 15 minutes in RAM only
const kycUploadSessions = new Map(); // sessionId -> { sessionId, telegramId, slot, label, createdAt, documentId, base64, mimeType, name }

function pruneKycUploadSessions() {
  const cutoff = Date.now() - KYC_UPLOAD_TTL_MS;
  for (const [id, sess] of kycUploadSessions.entries()) {
    if (!sess || sess.createdAt < cutoff) kycUploadSessions.delete(id);
  }
  while (kycUploadSessions.size > 250) {
    const oldest = kycUploadSessions.keys().next().value;
    if (!oldest) break;
    kycUploadSessions.delete(oldest);
  }
}

function escapeHtmlBasic(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createKycUploadSession(auth, body, req) {
  pruneKycUploadSessions();
  const slot = String(body?.slot || "").trim();
  const cfg = KYC_UPLOAD_SLOT_CONFIG[slot];
  if (!cfg) throw bad("Invalid verification document slot.");

  const sessionId = crypto.randomBytes(24).toString("base64url");
  const label = optStr(body, "label", { max: 120 }) || cfg.label;
  kycUploadSessions.set(sessionId, {
    sessionId,
    telegramId: Number(auth.telegramId),
    slot,
    label,
    createdAt: Date.now(),
    documentId: null,
    base64: null,
    mimeType: null,
    name: null,
  });

  const proto = String(req?.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim() || "https";
  const host = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "").split(",")[0].trim();
  const envBase = String(process.env.APP_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  const origin = envBase || (host ? `${proto}://${host}` : "https://payit-production.up.railway.app");
  const uploadUrl = `${origin}/api/app/v1/kyc/upload-page?token=${encodeURIComponent(sessionId)}`;

  return {
    status: 201,
    data: {
      sessionId,
      slot,
      uploadUrl,
      expiresInSec: Math.round(KYC_UPLOAD_TTL_MS / 1000),
    },
  };
}

function getKycUploadSessionStatus(auth, sessionId) {
  pruneKycUploadSessions();
  const sess = kycUploadSessions.get(String(sessionId || "").trim());
  if (!sess || Number(sess.telegramId) !== Number(auth.telegramId)) {
    throw new FeatureError(404, "upload_session_expired", "Upload session expired. Tap the document button again.");
  }
  return {
    status: 200,
    data: {
      ready: Boolean(sess.documentId && sess.base64),
      slot: sess.slot,
      documentId: sess.documentId,
      name: sess.name,
      mimeType: sess.mimeType,
    },
  };
}

function listKycUploadSessions(auth) {
  pruneKycUploadSessions();
  const bySlot = new Map();
  for (const sess of kycUploadSessions.values()) {
    if (Number(sess.telegramId) !== Number(auth.telegramId)) continue;
    if (!sess.documentId || !sess.base64) continue;
    const prev = bySlot.get(sess.slot);
    if (!prev || sess.createdAt >= prev.createdAt) {
      bySlot.set(sess.slot, sess);
    }
  }
  return {
    status: 200,
    data: {
      documents: [...bySlot.values()].map((s) => ({
        slot: s.slot,
        documentId: s.documentId,
        name: s.name,
        mimeType: s.mimeType,
      })),
    },
  };
}

function renderKycUploadPage(url) {
  pruneKycUploadSessions();
  const token = String(url?.searchParams?.get("token") || "").trim();
  const sess = kycUploadSessions.get(token);
  const cspHeader = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data: blob:";

  if (!sess) {
    const expiredHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proxim Document Upload</title><style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#F5F1E8;color:#13110C;margin:0;padding:24px;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#fff;border:1px solid #DCD3C1;border-radius:18px;padding:24px;max-width:440px;width:100%;text-align:center}h1{font-size:20px;margin:0 0 10px;color:#002018}p{color:#5C5546;font-size:14px;line-height:1.5}</style></head><body><div class="card"><h1>Upload Link Expired</h1><p>Please return to the Proxim app and tap the document button again to get a fresh secure upload link.</p></div></body></html>`;
    return { status: 410, raw: expiredHtml, contentType: "text/html; charset=utf-8", headers: { "Content-Security-Policy": cspHeader } };
  }

  const cfg = KYC_UPLOAD_SLOT_CONFIG[sess.slot];
  const safeTitle = escapeHtmlBasic(sess.label || cfg.label);
  const safeHint = escapeHtmlBasic(cfg.hint);
  const safeAccept = escapeHtmlBasic(cfg.accept);
  const safeTokenJson = JSON.stringify(token);
  const safeAllowedJson = JSON.stringify([...cfg.mimes]);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Proxim · ${safeTitle}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #F5F1E8; color: #13110C; margin: 0; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: #FFFFFF; border: 1px solid #DCD3C1; border-bottom: 3px solid #CFC5B0; border-radius: 20px; padding: 24px; max-width: 460px; width: 100%; box-shadow: 0 8px 24px rgba(0,32,24,0.08); }
  .badge { display: inline-block; background: #002018; color: #E0A82E; font-size: 11px; font-weight: 700; letter-spacing: 0.7px; text-transform: uppercase; padding: 5px 10px; border-radius: 999px; margin-bottom: 12px; }
  h1 { font-size: 20px; margin: 0 0 8px; color: #002018; }
  p { font-size: 14px; color: #5C5546; line-height: 1.5; margin: 0 0 18px; }
  .drop { display: block; border: 2px dashed #BDB29C; background: #FAF7F0; border-radius: 14px; padding: 22px 16px; text-align: center; cursor: pointer; margin-bottom: 14px; }
  .drop strong { display: block; color: #002018; font-size: 15px; margin-bottom: 4px; }
  .drop span { color: #776F5F; font-size: 12px; }
  input[type=file] { display: none; }
  .btn { width: 100%; background: #E0A82E; color: #002018; border: none; border-bottom: 3px solid #8A6410; border-radius: 14px; padding: 14px; font-size: 16px; font-weight: 800; cursor: pointer; text-decoration: none; display: inline-block; text-align: center; }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn-dark { background: #002018; color: #FFFFFF; border-bottom-color: #00140F; margin-top: 10px; }
  .msg { margin-top: 14px; padding: 12px 14px; border-radius: 12px; font-size: 13px; display: none; line-height: 1.45; }
  .err { background: #FBE1DC; color: #A32816; border: 1px solid #F0B6AB; }
  .ok { background: #E5F6EC; color: #005C30; border: 1px solid #A8DEC0; }
  .foot { margin-top: 16px; font-size: 11px; color: #776F5F; text-align: center; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">Proxim Secure Verification</div>
    <h1>${safeTitle}</h1>
    <p>${safeHint}</p>
    <label class="drop" for="fileInput" id="dropBox">
      <strong id="fileLabel">Tap here to pick a file or take a photo</strong>
      <span>Max 6 MB · Encrypted &amp; auto-deleted after verification</span>
      <input id="fileInput" type="file" accept="${safeAccept}" />
    </label>
    <button id="uploadBtn" class="btn" disabled>Upload Document</button>
    <div id="errBox" class="msg err"></div>
    <div id="okBox" class="msg ok">
      <strong>Document attached!</strong><br/>
      Return to the Proxim app — your file will appear automatically on the verification form.
      <a class="btn btn-dark" href="proxim://kyc-uploaded">Return to Proxim App</a>
    </div>
    <div class="foot">Encrypted in transit · Stored in temporary memory only for this session</div>
  </div>
<script>
(function() {
  const TOKEN = ${safeTokenJson};
  const ALLOWED = new Set(${safeAllowedJson});
  const input = document.getElementById("fileInput");
  const label = document.getElementById("fileLabel");
  const btn = document.getElementById("uploadBtn");
  const errBox = document.getElementById("errBox");
  const okBox = document.getElementById("okBox");
  let chosen = null;

  function showErr(t) { errBox.textContent = t; errBox.style.display = "block"; okBox.style.display = "none"; }
  function inferMime(f) {
    const m = (f.type || "").toLowerCase();
    if (m === "image/jpg") return "image/jpeg";
    if (m && m !== "application/octet-stream" && m !== "*/*") return m;
    const n = (f.name || "").toLowerCase();
    if (n.endsWith(".pdf")) return "application/pdf";
    if (n.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (n.endsWith(".doc")) return "application/msword";
    if (n.endsWith(".png")) return "image/png";
    if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
    if (n.endsWith(".webp")) return "image/webp";
    if (n.endsWith(".heic") || n.endsWith(".heif")) return "image/heic";
    return "application/octet-stream";
  }
  function readBase64(file, mime) {
    return new Promise((resolve, reject) => {
      const needsCanvas = mime.startsWith("image/") && (file.size > 1200000 || (mime !== "image/jpeg" && mime !== "image/png"));
      if (needsCanvas) {
        const img = new Image();
        const objUrl = URL.createObjectURL(file);
        img.onload = () => {
          try {
            const maxDim = 1800;
            let w = img.width, h = img.height;
            if (w > maxDim || h > maxDim) {
              const s = Math.min(maxDim / w, maxDim / h);
              w = Math.round(w * s); h = Math.round(h * s);
            }
            const c = document.createElement("canvas");
            c.width = w; c.height = h;
            c.getContext("2d").drawImage(img, 0, 0, w, h);
            const dataUrl = c.toDataURL("image/jpeg", 0.78);
            URL.revokeObjectURL(objUrl);
            resolve({ base64: dataUrl.split(",")[1], mimeType: "image/jpeg" });
          } catch (e) { URL.revokeObjectURL(objUrl); reject(e); }
        };
        img.onerror = () => {
          URL.revokeObjectURL(objUrl);
          // Fallback to raw FileReader so server-side sharp/magic-byte normalizer can handle it
          const reader = new FileReader();
          reader.onload = () => {
            const res = String(reader.result || "");
            const idx = res.indexOf(",");
            resolve({ base64: idx >= 0 ? res.slice(idx + 1) : res, mimeType: mime });
          };
          reader.onerror = () => reject(new Error("Could not read selected file."));
          reader.readAsDataURL(file);
        };
        img.src = objUrl;
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const res = String(reader.result || "");
        const idx = res.indexOf(",");
        resolve({ base64: idx >= 0 ? res.slice(idx + 1) : res, mimeType: mime });
      };
      reader.onerror = () => reject(new Error("Could not read selected file."));
      reader.readAsDataURL(file);
    });
  }

  input.addEventListener("change", () => {
    errBox.style.display = "none";
    okBox.style.display = "none";
    const f = input.files && input.files[0];
    if (!f) { chosen = null; btn.disabled = true; return; }
    const mime = inferMime(f);
    const isImage = mime.startsWith("image/");
    if (!ALLOWED.has(mime) && !isImage && mime !== "application/octet-stream") {
      chosen = null; btn.disabled = true;
      showErr("Unsupported file type (" + (mime || f.name) + "). Please pick a PDF, DOC/DOCX, JPG, or PNG file.");
      return;
    }
    if (f.size > 6.5 * 1024 * 1024 && !isImage) {
      chosen = null; btn.disabled = true;
      showErr("File is larger than 6 MB. Please upload a smaller file.");
      return;
    }
    chosen = { file: f, mime };
    label.textContent = "Selected: " + f.name;
    btn.disabled = false;
  });

  btn.addEventListener("click", async () => {
    if (!chosen) return;
    btn.disabled = true;
    btn.textContent = "Uploading securely...";
    errBox.style.display = "none";
    try {
      const encoded = await readBase64(chosen.file, chosen.mime);
      const resp = await fetch("/api/app/v1/kyc/upload-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: TOKEN,
          name: chosen.file.name || "document",
          mimeType: encoded.mimeType,
          base64: encoded.base64
        })
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error((json.error && json.error.message) || "Upload failed. Please try again.");
      btn.style.display = "none";
      okBox.style.display = "block";
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Upload Document";
      showErr(e && e.message ? e.message : "Could not upload document.");
    }
  });
})();
</script>
</body>
</html>`;

  return {
    status: 200,
    raw: html,
    contentType: "text/html; charset=utf-8",
    headers: { "Content-Security-Policy": cspHeader },
  };
}

async function completeKycUploadPage(body) {
  pruneKycUploadSessions();
  const token = String(body?.token || "").trim();
  const sess = kycUploadSessions.get(token);
  if (!sess) {
    throw new FeatureError(410, "upload_session_expired", "Upload link expired. Please return to Proxim and try again.");
  }
  const cfg = KYC_UPLOAD_SLOT_CONFIG[sess.slot];
  const rawBase64 = stripBase64DataUrl(body?.base64);
  if (!rawBase64 || rawBase64.length < 16) throw bad("Uploaded document is empty.");
  if (rawBase64.length > Math.ceil(6.5 * 1024 * 1024 * 1.37)) {
    throw bad("Uploaded document is too large (max 6 MB).");
  }
  const name = String(body?.name || `${sess.slot}`).trim().slice(0, 120);
  const normalized = await normalizeDocumentForNuvion(rawBase64, body?.mimeType || "", name, {
    requirePdf: Boolean(cfg.requirePdf),
  });
  const mimeType = normalized.mimeType;
  if (!cfg.mimes.has(mimeType)) {
    throw bad(`Unsupported file type (${mimeType}) for ${cfg.label}.`);
  }
  const documentId = `doc_${crypto.randomBytes(16).toString("base64url")}`;
  sess.documentId = documentId;
  sess.base64 = normalized.base64;
  sess.mimeType = mimeType;
  sess.name = name;
  sess.createdAt = Date.now(); // refresh 15m TTL from upload time
  return {
    status: 200,
    data: { ok: true, documentId, name, mimeType },
  };
}

function resolveSubmittedDocument(telegramId, rawBase64, rawMime, documentId, fallbackMime) {
  if (rawBase64 && String(rawBase64).trim()) {
    return {
      base64: stripBase64DataUrl(rawBase64),
      mimeType: String(rawMime || fallbackMime).trim().toLowerCase(),
      sessionIdToClear: null,
    };
  }
  if (documentId && String(documentId).trim()) {
    pruneKycUploadSessions();
    const targetId = String(documentId).trim();
    for (const [sid, sess] of kycUploadSessions.entries()) {
      if (sess.documentId === targetId && Number(sess.telegramId) === Number(telegramId) && sess.base64) {
        return {
          base64: sess.base64,
          mimeType: String(sess.mimeType || rawMime || fallbackMime).trim().toLowerCase(),
          sessionIdToClear: sid,
        };
      }
    }
    throw bad("One of your uploaded documents expired. Please re-attach it and submit again.");
  }
  return null;
}

async function submitKyc(auth, body) {
  const compliance = dep("compliance");
  const countryCode = compliance.normalizeCountryCode(body?.countryCode || body?.nationality || body?.country_code);
  if (!/^[A-Z]{2}$/.test(countryCode)) throw bad("Valid 2-letter ISO countryCode is required.");
  if (compliance.isSanctionedCountry(countryCode)) {
    throw new FeatureError(403, "jurisdiction_unsupported", `Jurisdiction ${countryCode} is not supported due to compliance restrictions.`);
  }
  const firstName = reqStr(body, "firstName", { max: 80 });
  const lastName = reqStr(body, "lastName", { max: 80 });
  const email = reqStr(body, "email", { max: 120 });
  const phoneNumber = reqStr(body, "phoneNumber", { max: 32 });
  const dateOfBirth = reqStr(body, "dateOfBirth", { pattern: /^\d{4}-\d{2}-\d{2}$/, max: 20 });
  const gender = reqStr(body, "gender", { pattern: /^(male|female|m|f)$/i }).toLowerCase();
  if (!body?.address || typeof body.address !== "object") throw bad("address object is required.");
  if (!body?.idDocument || typeof body.idDocument !== "object") throw bad("idDocument object is required.");

  const rawDoc = body.idDocument || {};
  const rawAddr = body.address || {};
  const idNumberStr = String(rawDoc.number || "").trim();
  if (!idNumberStr) throw bad("idDocument.number is required.");
  const addrLine1 = String(rawAddr.line1 || rawAddr.line_1 || rawAddr.street || "").trim();
  if (!addrLine1) throw bad("address.line1 is required.");

  const fullName = `${firstName} ${lastName}`.trim();
  const cleanPhone = dep("flowsKyc")?.normalizePhone?.(phoneNumber, countryCode) || phoneNumber;
  const ninVal = optStr(body, "nin", { max: 11 }) || (countryCode === "NG" ? optStr(body, "bvn", { max: 11 }) : "");
  const bvnVal = optStr(body, "bvn", { max: 11 });
  const ssnVal = optStr(body, "ssn", { max: 15 });

  const normalizeDocType = (t) => {
    const s = String(t || "").toLowerCase();
    if (s.includes("pass")) return "international_passport";
    if (s.includes("driv") || s.includes("dl")) return "drivers_license";
    return "national_id";
  };
  const docType = normalizeDocType(rawDoc.type);

  const entityPayload = {
    name: fullName,
    person: {
      first_name: firstName,
      last_name: lastName,
      middle_name: optStr(body, "middleName", { max: 80 }) || undefined,
      email,
      date_of_birth: dateOfBirth,
      gender: gender.startsWith("f") ? "f" : "m",
      phonenumber: cleanPhone,
      nationality: countryCode,
      ...(bvnVal ? { bvn: bvnVal } : {}),
      ...(ninVal ? { nin: ninVal } : {}),
      ...(ssnVal ? { ssn: ssnVal } : {}),
    },
    address: {
      line_1: addrLine1,
      city: String(rawAddr.city || "").trim() || undefined,
      state: String(rawAddr.state || "").trim() || undefined,
      postal_code: String(rawAddr.postalCode || rawAddr.postal_code || "").trim() || undefined,
      country_code: countryCode,
    },
    identification: {
      document: {
        type: docType,
        number: idNumberStr,
        ...(rawDoc.issueDate || rawDoc.issue_date ? { issue_date: String(rawDoc.issueDate || rawDoc.issue_date).trim() } : {}),
        ...(rawDoc.expiryDate || rawDoc.expiry_date ? { expiry_date: String(rawDoc.expiryDate || rawDoc.expiry_date).trim() } : {}),
        issuing_country: rawDoc.country || rawDoc.issuing_country || countryCode,
        issuing_authority: rawDoc.issuingAuthority || rawDoc.issuing_authority || "Government Authority",
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

  const docs = body.documents && typeof body.documents === "object" ? body.documents : null;
  let resolvedFront = resolveSubmittedDocument(auth.telegramId, docs?.idFrontBase64, docs?.idFrontMimeType, docs?.idFrontDocumentId, "image/jpeg");
  let resolvedBack = resolveSubmittedDocument(auth.telegramId, docs?.idBackBase64, docs?.idBackMimeType, docs?.idBackDocumentId, "image/jpeg");
  let resolvedPoa = resolveSubmittedDocument(auth.telegramId, docs?.proofOfAddressBase64, docs?.proofOfAddressMimeType, docs?.proofOfAddressDocumentId, "image/jpeg");
  if (!resolvedFront || !resolvedPoa) {
    throw bad("Please upload both your Government ID (front) and Proof of Address document.");
  }
  resolvedFront = { ...resolvedFront, ...(await normalizeDocumentForNuvion(resolvedFront.base64, resolvedFront.mimeType, "id_front")) };
  if (resolvedBack) {
    resolvedBack = { ...resolvedBack, ...(await normalizeDocumentForNuvion(resolvedBack.base64, resolvedBack.mimeType, "id_back")) };
  }
  resolvedPoa = { ...resolvedPoa, ...(await normalizeDocumentForNuvion(resolvedPoa.base64, resolvedPoa.mimeType, "poa")) };
  const allowedKycMimes = new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg"]);
  const idFrontMime = resolvedFront.mimeType;
  const poaMime = resolvedPoa.mimeType;
  if (!allowedKycMimes.has(idFrontMime)) {
    throw bad("Government ID must be a JPG, PNG, or PDF file.");
  }
  if (!allowedKycMimes.has(poaMime)) {
    throw bad("Proof of Address must be a JPG, PNG, or PDF file.");
  }

  const nuvion = dep("nuvion");
  const db = dep("db");
  const existingLocal = db.getNuvionEntityByUser(auth.telegramId, "personal");
  let entityId = existingLocal?.entity_id || null;
  let personId = existingLocal?.person_id || null;
  let entityStatus = String(existingLocal?.status || "").toLowerCase();

  try {
    if (!entityId || entityStatus !== "incomplete") {
      let created;
      try {
        created = await nuvion.createIndividualEntity(entityPayload);
      } catch (createErr) {
        if (createErr?.status === 409 && createErr?.type === "error_duplicate_resource" && typeof nuvion.recoverEntityByName === "function") {
          created = await nuvion.recoverEntityByName({ name: fullName, type: "individual", email });
          if (!created) throw createErr;
        } else {
          throw createErr;
        }
      }
      const entityObj = created?.entity || created;
      entityId = entityObj?.id || created?.id;
      personId = created?.person?.id || entityObj?.person_id || personId || null;
      entityStatus = String(entityObj?.status || created?.status || "incomplete").toLowerCase();
    }

    if (typeof nuvion.uploadDocument === "function") {
      await nuvion.uploadDocument({
        entityId,
        key: "identity",
        description: `${docType} for ${fullName}`,
        fileBase64: resolvedFront.base64,
        fileBackBase64: resolvedBack ? resolvedBack.base64 : null,
        fileType: idFrontMime,
        personId,
      });
      await nuvion.uploadDocument({
        entityId,
        key: "proof_of_address",
        description: `Proof of address for ${fullName}`,
        fileBase64: resolvedPoa.base64,
        fileType: poaMime,
        personId,
      });
    }
    if (entityStatus === "incomplete" && typeof nuvion.submitOnboarding === "function") {
      const subRes = await nuvion.submitOnboarding(entityId);
      const subObj = subRes?.entity || subRes || {};
      entityStatus = String(subObj.status || "pending").toLowerCase();
    }
    [resolvedFront, resolvedBack, resolvedPoa].forEach((r) => {
      if (r?.sessionIdToClear) kycUploadSessions.delete(r.sessionIdToClear);
    });
  } catch (err) {
    throw new FeatureError(Number(err.status || err.statusCode) || 400, "kyc_error", String(err.message || "Could not submit verification.").replace(/nuvion/gi, "Global Neobank"));
  }

  const savedPersonal = db.upsertNuvionEntity({
    telegramId: auth.telegramId,
    accountType: "personal",
    entityId,
    entityType: "individual",
    personId,
    status: entityStatus || "pending",
    legalName: fullName,
    email,
    countryCode,
  });
  if (entityStatus === "approved") {
    try { await require("../nuvion_webhooks").bootstrapApprovedEntity(savedPersonal); } catch (_) { }
  }
  try {
    const emailMod = require("../email");
    const statusToSend = entityStatus === "approved" ? "approved" : "pending";
    if (statusToSend === "approved") {
      require("../idempotency").tryClaimWebhookEvent(`email_kyc_approved:${entityId}`, "email_kyc_approved", entityId);
    }
    emailMod.sendKycStatusEmail({
      to: email,
      name: fullName,
      status: statusToSend,
      accountType: "personal",
    }).then((r) => {
      if (!r?.sent) console.warn(`[app_api:submitKyc_email] Not delivered to ${email}:`, r?.reason, r?.error || "");
    }).catch(() => { });
  } catch (_) { }
  return { status: 201, data: { status: entityStatus || "pending", tier: entityStatus === "approved" ? 1 : 0 } };
}

async function submitKyb(auth, body) {
  const compliance = dep("compliance");
  const flowsKyc = dep("flowsKyc");
  const countryCode = compliance.normalizeCountryCode(body?.incorporationCountry || body?.countryCode);
  if (!/^[A-Z]{2}$/.test(countryCode)) throw bad("Valid 2-letter ISO incorporationCountry is required.");
  if (compliance.isSanctionedCountry(countryCode)) {
    throw new FeatureError(403, "jurisdiction_unsupported", `Jurisdiction ${countryCode} is not supported due to compliance restrictions.`);
  }
  const legalName = reqStr(body, "legalName", { max: 255 });
  const tradeName = optStr(body, "tradeName", { max: 255 }) || legalName;
  const registrationNumber = reqStr(body, "registrationNumber", { max: 255 });
  const taxId = optStr(body, "taxId", { max: 64 }) || registrationNumber;
  const email = reqStr(body, "email", { max: 120 }).toLowerCase();
  const rawPhoneNumber = reqStr(body, "phoneNumber", { max: 32 });
  const phoneNumber = flowsKyc?.normalizePhone?.(rawPhoneNumber, countryCode) || rawPhoneNumber;
  const industry = reqStr(body, "industry", { max: 100 });
  const businessType = reqStr(body, "businessType", { pattern: /^(llc|corporation|sole_proprietorship|partnership)$/i }).toLowerCase();
  const description = optStr(body, "description", { max: 1000 }) || `${legalName} operating in ${industry}`;

  const currentYear = new Date().getUTCFullYear();
  const incorporationYear = Math.round(Number(body?.incorporationYear));
  const incorporationMonth = Math.round(Number(body?.incorporationMonth));
  if (!Number.isInteger(incorporationYear) || incorporationYear < 1900 || incorporationYear > currentYear) {
    throw bad(`incorporationYear must be a valid year between 1900 and ${currentYear}.`);
  }
  if (!Number.isInteger(incorporationMonth) || incorporationMonth < 1 || incorporationMonth > 12) {
    throw bad("incorporationMonth must be an integer between 1 and 12.");
  }

  if (!body?.address || typeof body.address !== "object") throw bad("Business address object is required.");
  if (!body?.officer || typeof body.officer !== "object") throw bad("Controlling officer / beneficial owner details are required.");

  if (!auth.user?.business_deposit_address) {
    throw new FeatureError(404, "no_business_account", "Create a Business Account first before submitting Business KYB verification.");
  }

  const rawAddr = body.address || {};
  const addrLine1 = String(rawAddr.line1 || rawAddr.line_1 || rawAddr.street || "").trim();
  const addrCity = String(rawAddr.city || "").trim();
  const addrState = String(rawAddr.state || "").trim();
  const addrPostal = String(rawAddr.postalCode || rawAddr.postal_code || "").trim();
  const addrCountry = compliance.normalizeCountryCode(rawAddr.country || rawAddr.country_code || countryCode);
  if (addrLine1.length < 4) throw bad("Business street address (at least 4 characters) is required.");
  if (!addrCity || !addrState || !addrPostal) throw bad("Business city, state/region, and postal code are required.");

  const incorporationState = optStr(body, "incorporationState", { max: 100 }) || addrState;
  const rawWebsite = optStr(body, "website", { max: 200 });
  const cleanWebsite = rawWebsite && typeof flowsKyc?.normalizeWebsiteUrl === "function"
    ? flowsKyc.normalizeWebsiteUrl(rawWebsite)
    : rawWebsite || null;
  if (rawWebsite && cleanWebsite === undefined) {
    throw bad("Business website must be a valid URL starting with https:// (or leave blank).");
  }

  const bizAddress = {
    line_1: addrLine1,
    city: addrCity,
    state: addrState,
    postal_code: addrPostal,
    country_code: /^[A-Z]{2}$/.test(addrCountry) ? addrCountry : countryCode,
  };

  let operatingAddress = { ...bizAddress };
  if (body.operatingAddress && typeof body.operatingAddress === "object") {
    const op = body.operatingAddress;
    const opLine1 = String(op.line1 || op.line_1 || op.street || "").trim();
    if (opLine1.length >= 4) {
      operatingAddress = {
        line_1: opLine1,
        city: String(op.city || addrCity).trim(),
        state: String(op.state || addrState).trim(),
        postal_code: String(op.postalCode || op.postal_code || addrPostal).trim(),
        country_code: compliance.normalizeCountryCode(op.country || op.country_code || bizAddress.country_code) || bizAddress.country_code,
      };
    }
  }

  const rawOfficer = body.officer || {};
  const officerFirst = String(rawOfficer.firstName || rawOfficer.first_name || "").trim();
  const officerLast = String(rawOfficer.lastName || rawOfficer.last_name || "").trim();
  if (!officerFirst || !officerLast) throw bad("Officer first name and last name are required.");
  const officerEmail = String(rawOfficer.email || "").trim().toLowerCase() || email;
  const officerDob = String(rawOfficer.dateOfBirth || rawOfficer.dob || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(officerDob)) throw bad("Officer date of birth (YYYY-MM-DD) is required.");
  const officerNationality = compliance.normalizeCountryCode(rawOfficer.nationality || countryCode);
  const officerGender = String(rawOfficer.gender || "m").trim().toLowerCase().startsWith("f") ? "f" : "m";
  const officerPhoneRaw = String(rawOfficer.phoneNumber || rawOfficer.phone || phoneNumber).trim();
  const officerPhone = flowsKyc?.normalizePhone?.(officerPhoneRaw, officerNationality) || officerPhoneRaw;
  const officerJobTitle = String(rawOfficer.jobTitle || rawOfficer.job_title || rawOfficer.title || "Director").trim().slice(0, 100);
  const officerOwnership = Number(rawOfficer.ownershipPercentage ?? rawOfficer.ownership_percentage ?? 100);
  if (!Number.isFinite(officerOwnership) || officerOwnership < 0 || officerOwnership > 100) {
    throw bad("Officer ownership percentage must be between 0 and 100.");
  }
  const isControlPerson = rawOfficer.isControlPerson !== undefined ? Boolean(rawOfficer.isControlPerson) : true;
  const isBeneficialOwner = rawOfficer.isBeneficialOwner !== undefined ? Boolean(rawOfficer.isBeneficialOwner) : officerOwnership >= 25;

  const officerIdDoc = rawOfficer.idDocument && typeof rawOfficer.idDocument === "object" ? rawOfficer.idDocument : {};
  const officerIdNumber = String(officerIdDoc.number || rawOfficer.idNumber || "").trim();
  const officerIdTypeRaw = String(officerIdDoc.type || rawOfficer.idType || "international_passport").toLowerCase();
  const officerIdType = officerIdTypeRaw.includes("driv")
    ? "drivers_license"
    : officerIdTypeRaw.includes("nat")
      ? "national_id"
      : "international_passport";
  const officerIdIssue = String(officerIdDoc.issueDate || officerIdDoc.issue_date || rawOfficer.issueDate || "").trim();
  const officerIdExpiry = String(officerIdDoc.expiryDate || officerIdDoc.expiry_date || rawOfficer.expiryDate || "").trim();
  const officerIdAuthority = String(officerIdDoc.issuingAuthority || officerIdDoc.issuing_authority || rawOfficer.issuingAuthority || "Government Authority").trim();
  const officerIdCountry = compliance.normalizeCountryCode(officerIdDoc.country || officerIdDoc.issuing_country || rawOfficer.issuingCountry || officerNationality);
  const officerBvn = String(rawOfficer.bvn || "").trim();
  const officerNin = String(rawOfficer.nin || "").trim();
  const officerSsn = String(rawOfficer.ssn || "").trim();

  // Required KYB documents (all 5 per Nuvion X-API-Version: 2026-02-06 — direct base64 or hosted upload documentId)
  const docs = body.documents && typeof body.documents === "object" ? body.documents : null;
  let resolvedCoi = resolveSubmittedDocument(auth.telegramId, docs?.coiBase64, docs?.coiMimeType, docs?.coiDocumentId, "application/pdf");
  let resolvedMemart = resolveSubmittedDocument(auth.telegramId, docs?.memartBase64, docs?.memartMimeType, docs?.memartDocumentId, "application/pdf");
  let resolvedBizPoa = resolveSubmittedDocument(auth.telegramId, docs?.businessPoaBase64, docs?.businessPoaMimeType, docs?.businessPoaDocumentId, "application/pdf");
  let resolvedOffIdFront = resolveSubmittedDocument(auth.telegramId, docs?.officerIdFrontBase64, docs?.officerIdMimeType, docs?.officerIdFrontDocumentId, "image/jpeg");
  let resolvedOffIdBack = resolveSubmittedDocument(auth.telegramId, docs?.officerIdBackBase64, docs?.officerIdBackMimeType, docs?.officerIdBackDocumentId, "image/jpeg");
  let resolvedOffPoa = resolveSubmittedDocument(auth.telegramId, docs?.officerPoaBase64, docs?.officerPoaMimeType, docs?.officerPoaDocumentId, "image/jpeg");
  if (
    !resolvedCoi ||
    !resolvedMemart ||
    !resolvedBizPoa ||
    !resolvedOffIdFront ||
    !resolvedOffPoa
  ) {
    throw bad(
      "Business KYB requires all 5 documents: Certificate of Incorporation (PDF or Photo), Memorandum & Articles of Association (PDF/DOCX), Business Proof of Address, Officer Government ID, and Officer Proof of Address."
    );
  }
  // Auto-normalize formats: e.g. convert JPG/PNG photos of COI/MemArt into valid single-page PDFs & fix Android octet-stream
  resolvedCoi = { ...resolvedCoi, ...(await normalizeDocumentForNuvion(resolvedCoi.base64, resolvedCoi.mimeType, "coi", { requirePdf: true })) };
  resolvedMemart = {
    ...resolvedMemart,
    ...(await normalizeDocumentForNuvion(resolvedMemart.base64, resolvedMemart.mimeType, "memart", {
      requirePdf: String(resolvedMemart.mimeType || "").startsWith("image/"),
    })),
  };
  resolvedBizPoa = { ...resolvedBizPoa, ...(await normalizeDocumentForNuvion(resolvedBizPoa.base64, resolvedBizPoa.mimeType, "biz_poa")) };
  resolvedOffIdFront = { ...resolvedOffIdFront, ...(await normalizeDocumentForNuvion(resolvedOffIdFront.base64, resolvedOffIdFront.mimeType, "officer_id")) };
  if (resolvedOffIdBack) {
    resolvedOffIdBack = { ...resolvedOffIdBack, ...(await normalizeDocumentForNuvion(resolvedOffIdBack.base64, resolvedOffIdBack.mimeType, "officer_id_back")) };
  }
  resolvedOffPoa = { ...resolvedOffPoa, ...(await normalizeDocumentForNuvion(resolvedOffPoa.base64, resolvedOffPoa.mimeType, "officer_poa")) };
  const coiMime = resolvedCoi.mimeType;
  const memartMime = resolvedMemart.mimeType;
  const bizPoaMime = resolvedBizPoa.mimeType;
  const officerIdMime = resolvedOffIdFront.mimeType;
  const officerPoaMime = resolvedOffPoa.mimeType;

  const allowedPdfOnly = new Set(["application/pdf"]);
  const allowedMemart = new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]);
  const allowedImgOrPdf = new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg"]);

  if (!allowedPdfOnly.has(coiMime)) {
    throw bad("Certificate of Incorporation must be a PDF file.");
  }
  if (!allowedMemart.has(memartMime)) {
    throw bad("Memorandum & Articles of Association must be a PDF, DOC, or DOCX file.");
  }
  if (!allowedImgOrPdf.has(bizPoaMime)) {
    throw bad("Business Proof of Address must be a PDF, JPG, or PNG file.");
  }
  if (!allowedImgOrPdf.has(officerIdMime)) {
    throw bad("Officer Government ID must be a PDF, JPG, or PNG file.");
  }
  if (!allowedImgOrPdf.has(officerPoaMime)) {
    throw bad("Officer Proof of Address must be a PDF, JPG, or PNG file.");
  }

  const db = dep("db");
  const nuvion = dep("nuvion");
  const existingPersonal = db.getNuvionEntityByUser(auth.telegramId, "personal");
  const canReusePersonalPersonId = Boolean(
    existingPersonal?.person_id &&
    existingPersonal?.email &&
    String(existingPersonal.email).trim().toLowerCase() === officerEmail
  );

  let officerEntry;
  if (canReusePersonalPersonId) {
    officerEntry = {
      job_title: officerJobTitle,
      is_control_person: isControlPerson,
      is_beneficial_owner: isBeneficialOwner,
      ownership_percentage: officerOwnership,
      person_id: existingPersonal.person_id,
    };
  } else {
    let officerAddress = { ...bizAddress };
    if (rawOfficer.address && typeof rawOfficer.address === "object") {
      const oa = rawOfficer.address;
      const oaLine1 = String(oa.line1 || oa.line_1 || oa.street || "").trim();
      if (oaLine1.length >= 4) {
        officerAddress = {
          line_1: oaLine1,
          city: String(oa.city || addrCity).trim(),
          state: String(oa.state || addrState).trim(),
          postal_code: String(oa.postalCode || oa.postal_code || addrPostal).trim(),
          country_code: compliance.normalizeCountryCode(oa.country || oa.country_code || officerNationality) || officerNationality,
        };
      }
    }

    if ((officerNationality === "NG" || officerAddress.country_code === "NG") && (officerBvn.length !== 11 || officerNin.length !== 11)) {
      throw bad("Nigerian directors/owners require both an 11-digit BVN and 11-digit NIN.");
    }
    if ((officerNationality === "US" || officerAddress.country_code === "US") && !/^\d{9,}$/.test(officerSsn.replace(/-/g, ""))) {
      throw bad("U.S. directors/owners require a valid 9-digit SSN.");
    }
    if (!officerIdNumber) {
      throw bad("Officer Government ID number is required.");
    }

    const officerPerson = {
      first_name: officerFirst,
      last_name: officerLast,
      email: officerEmail,
      phonenumber: officerPhone,
      date_of_birth: officerDob,
      gender: officerGender,
      nationality: officerNationality,
      ...(officerBvn ? { bvn: officerBvn } : {}),
      ...(officerNin ? { nin: officerNin } : {}),
      ...(officerSsn ? { ssn: officerSsn } : {}),
      address: officerAddress,
      identification: {
        document: {
          type: officerIdType,
          number: officerIdNumber,
          ...(officerIdIssue ? { issue_date: officerIdIssue } : {}),
          ...(officerIdExpiry ? { expiry_date: officerIdExpiry } : {}),
          issuing_country: officerIdCountry,
          issuing_authority: officerIdAuthority,
        },
        proof_of_address: { type: "utility_bill" },
      },
    };

    officerEntry = {
      job_title: officerJobTitle,
      is_control_person: isControlPerson,
      is_beneficial_owner: isBeneficialOwner,
      ownership_percentage: officerOwnership,
      person: officerPerson,
    };
  }

  const businessObj = {
    legal_name: legalName,
    trade_name: tradeName,
    industry,
    email,
    type: businessType,
    description,
    registration_number: registrationNumber,
    phonenumber: phoneNumber,
    incorporation_meta: {
      year: incorporationYear,
      month: incorporationMonth,
      country: countryCode,
      state: incorporationState,
    },
    ...(cleanWebsite ? { website: cleanWebsite } : {}),
  };

  const entityPayload = {
    name: legalName,
    business: businessObj,
    address: bizAddress,
    operating_address: operatingAddress,
    business_officers: [officerEntry],
    meta: {
      registration_number: registrationNumber,
      tax_id: taxId,
      annual_turnover: optStr(body, "annualTurnover", { max: 40 }) || "100K",
      monthly_transaction_value: optStr(body, "monthlyTransactionValue", { max: 40 }) || "25K",
      monthly_payments_count: optStr(body, "monthlyPaymentsCount", { max: 20 }) || "50",
      max_transfer_amount: optStr(body, "maxTransferAmount", { max: 40 }) || "10K",
      customer_types: optStr(body, "customerTypes", { max: 80 }) || "Business",
      sales_channels: optStr(body, "salesChannels", { max: 80 }) || "Direct",
      funding_source: optStr(body, "fundingSource", { max: 80 }) || "Business revenue",
    },
  };

  const existingLocal = db.getNuvionEntityByUser(auth.telegramId, "business");
  let entityId = existingLocal?.entity_id || null;
  let businessId = existingLocal?.business_id || null;
  let officerPersonId = existingLocal?.person_id || (canReusePersonalPersonId ? existingPersonal.person_id : null);
  let entityStatus = String(existingLocal?.status || "").toLowerCase();

  try {
    if (typeof nuvion.validateBusinessEntityPayload === "function") {
      nuvion.validateBusinessEntityPayload(entityPayload);
    }

    if (!entityId || entityStatus !== "incomplete") {
      let entityRes;
      try {
        entityRes = await nuvion.createBusinessEntity(entityPayload);
      } catch (createErr) {
        if (createErr?.status === 409 && createErr?.type === "error_duplicate_resource" && typeof nuvion.recoverEntityByName === "function") {
          entityRes = await nuvion.recoverEntityByName({ name: legalName, type: "business", email });
          if (!entityRes) throw createErr;
        } else {
          throw createErr;
        }
      }
      const entityObj = entityRes?.entity || entityRes;
      entityId = entityObj?.id || entityRes?.id;
      businessId = entityRes?.business?.id || entityObj?.business_id || businessId || null;
      officerPersonId =
        entityRes?.business_officers?.[0]?.person_id ||
        entityRes?.business_officers?.[0]?.person?.id ||
        entityRes?.officers?.[0]?.person_id ||
        entityRes?.officers?.[0]?.person?.id ||
        officerPersonId ||
        null;
      entityStatus = String(entityObj?.status || entityRes?.status || "incomplete").toLowerCase();
    }

    if (!officerPersonId && typeof nuvion.getEntity === "function") {
      try {
        const live = await nuvion.getEntity(entityId);
        officerPersonId =
          live?.business_officers?.[0]?.person_id ||
          live?.business_officers?.[0]?.person?.id ||
          live?.officers?.[0]?.person_id ||
          null;
      } catch (_) { }
    }

    if (typeof nuvion.uploadDocument === "function") {
      await nuvion.uploadDocument({
        entityId,
        key: "certificate_of_incorporation",
        description: `Certificate of Incorporation for ${legalName}`,
        fileBase64: resolvedCoi.base64,
        fileType: coiMime,
      });
      await nuvion.uploadDocument({
        entityId,
        key: "memorandum_of_association",
        description: `Memorandum & Articles of Association for ${legalName}`,
        fileBase64: resolvedMemart.base64,
        fileType: memartMime,
      });
      await nuvion.uploadDocument({
        entityId,
        key: "proof_of_address",
        description: `Business Proof of Address for ${legalName}`,
        fileBase64: resolvedBizPoa.base64,
        fileType: bizPoaMime,
      });
      await nuvion.uploadDocument({
        entityId,
        key: "identity",
        description: `Officer ID for ${officerFirst} ${officerLast}`,
        fileBase64: resolvedOffIdFront.base64,
        fileBackBase64: resolvedOffIdBack ? resolvedOffIdBack.base64 : null,
        fileType: officerIdMime,
        personId: officerPersonId,
      });
      await nuvion.uploadDocument({
        entityId,
        key: "proof_of_address",
        description: `Officer Proof of Address for ${officerFirst} ${officerLast}`,
        fileBase64: resolvedOffPoa.base64,
        fileType: officerPoaMime,
        personId: officerPersonId,
      });
    }

    if (entityStatus === "incomplete" && typeof nuvion.submitOnboarding === "function") {
      const subRes = await nuvion.submitOnboarding(entityId);
      const subObj = subRes?.entity || subRes || {};
      entityStatus = String(subObj.status || "pending").toLowerCase();
    }
    [resolvedCoi, resolvedMemart, resolvedBizPoa, resolvedOffIdFront, resolvedOffIdBack, resolvedOffPoa].forEach((r) => {
      if (r?.sessionIdToClear) kycUploadSessions.delete(r.sessionIdToClear);
    });
  } catch (err) {
    throw new FeatureError(Number(err.status || err.statusCode) || 400, "kyb_error", String(err.message || "Could not submit business verification.").replace(/nuvion/gi, "Global Neobank"));
  }

  const savedBiz = db.upsertNuvionEntity({
    telegramId: auth.telegramId,
    accountType: "business",
    entityId,
    entityType: "business",
    personId: officerPersonId,
    businessId,
    status: entityStatus || "pending",
    legalName,
    email,
    countryCode,
  });
  if (entityStatus === "approved") {
    try { await require("../nuvion_webhooks").bootstrapApprovedEntity(savedBiz); } catch (_) { }
  }
  try {
    const emailMod = require("../email");
    const statusToSend = entityStatus === "approved" ? "approved" : "pending";
    if (statusToSend === "approved") {
      require("../idempotency").tryClaimWebhookEvent(`email_kyc_approved:${entityId}`, "email_kyc_approved", entityId);
    }
    emailMod.sendKycStatusEmail({
      to: email,
      name: legalName,
      status: statusToSend,
      accountType: "business",
    }).then((r) => {
      if (!r?.sent) console.warn(`[app_api:submitKyb_email] Not delivered to ${email}:`, r?.reason, r?.error || "");
    }).catch(() => { });
  } catch (_) { }
  return { status: 201, data: { status: entityStatus || "pending", tier: entityStatus === "approved" ? 1 : 0 } };
}

async function refreshKycStatus(auth, body) {
  const accountType = resolveAccountType(auth, body?.accountType);
  const db = dep("db");
  const entity = db.getNuvionEntityByUser(auth.telegramId, accountType);
  if (!entity) return getKycStatus(auth);
  await syncLiveEntityAndNotify(entity, accountType);
  return getKycStatus(auth);
}

// ─── 19. Bill history, personal invoices, business expenses & receipts ────────

async function listBillHistory(auth, url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
  const rows = dep("db").getUserBillPayments(auth.telegramId, limit) || [];
  return {
    status: 200,
    data: {
      bills: rows.map((b) => ({
        id: b.id,
        category: b.category,
        providerName: b.provider_name || null,
        recipient: b.recipient,
        amountNgn: Number(b.amount_ngn || 0),
        amountUsdc: Number(b.amount_usdc || 0),
        status: b.status,
        meterToken: b.meter_token || null,
        txHash: b.solana_tx_sig || null,
        createdAt: b.created_at || null,
      })),
    },
  };
}

function formatPersonalInvoice(row) {
  let items = [];
  if (typeof row.items_json === "string") {
    try { items = JSON.parse(row.items_json); } catch (_) { items = []; }
  }
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    clientName: row.client_name,
    clientEmail: row.client_email || null,
    items,
    totalUsdc: Number(row.total_usdc ?? row.total ?? 0),
    dueDate: row.due_date || null,
    notes: row.notes || null,
    status: row.status || "unpaid",
    walletAddress: row.wallet_address || null,
    paymentAddress: row.payment_address || null,
    fiatBankName: row.fiat_bank_name || null,
    fiatAccountNumber: row.fiat_account_number || null,
    fiatAccountName: row.fiat_account_name || null,
    fiatAmount: row.fiat_amount != null ? Number(row.fiat_amount) : null,
    paidTxHash: row.paid_tx_hash || null,
    createdAt: row.created_at || null,
    paidAt: row.paid_at || null,
  };
}

async function listPersonalInvoices(auth, url) {
  const idb = dep("invoiceDb");
  if (typeof idb.initInvoiceTables === "function") idb.initInvoiceTables();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
  const rows = idb.getUserInvoices(auth.telegramId, limit) || [];
  return { status: 200, data: { invoices: rows.map(formatPersonalInvoice) } };
}

async function getPersonalInvoice(auth, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw bad("Invalid invoice ID.");
  const row = dep("invoiceDb").getInvoice(id);
  if (!row || Number(row.telegram_id) !== auth.telegramId) {
    throw new FeatureError(404, "invoice_not_found", "Invoice not found.");
  }
  return { status: 200, data: { invoice: formatPersonalInvoice(row) } };
}

async function createPersonalInvoice(auth, body) {
  const idb = dep("invoiceDb");
  const db = dep("db");
  if (typeof idb.initInvoiceTables === "function") idb.initInvoiceTables();

  const clientName = reqStr(body, "clientName", { max: 100 });
  const clientEmail = optStr(body, "clientEmail", { max: 120 });
  const notes = optStr(body, "notes", { max: 300 });
  const dueDate = optStr(body, "dueDate", { max: 32 });
  const paymentChannel = optStr(body, "paymentChannel", { pattern: /^(ngn_bank|nuvion_bank|crypto_intent|both|both_nuvion)$/ }) || "both";
  const invoiceCurrency = (optStr(body, "currency", { pattern: /^[A-Za-z]{3}$/ }) || "USD").toUpperCase();
  const nuvionBankCurrency = (optStr(body, "globalBankCurrency", { pattern: /^[A-Za-z]{3}$/ }) || optStr(body, "nuvionBankCurrency", { pattern: /^[A-Za-z]{3}$/ }) || (paymentChannel === "nuvion_bank" || paymentChannel === "both_nuvion" ? invoiceCurrency : "USD")).toUpperCase();
  const cryptoChain = optStr(body, "cryptoChain", { max: 48 }) || "arc";
  const cryptoAssetId = optStr(body, "cryptoAssetId", { max: 180 }) || null;
  const cryptoSymbol = optStr(body, "cryptoSymbol", { max: 24 }) || null;
  const cryptoBlockchain = optStr(body, "cryptoBlockchain", { max: 32 }) || null;

  let items = [];
  if (Array.isArray(body?.items) && body.items.length > 0) {
    items = body.items.slice(0, 30).map((it) => {
      const desc = String(it?.description || "").trim().slice(0, 120);
      const qty = Number(it?.quantity ?? 1);
      const price = Number(it?.unitPrice ?? it?.amount ?? 0);
      if (!desc || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) {
        throw bad("Each invoice item needs description, positive quantity, and positive unitPrice.");
      }
      return { description: desc, quantity: qty, unitPrice: price };
    });
  } else {
    const total = Number(body?.totalUsdc ?? body?.amount);
    if (!Number.isFinite(total) || total <= 0 || total > 1_000_000) throw bad("Provide invoice items or a positive amount.", "invalid_amount");
    items = [{ description: notes || `Invoice for ${clientName}`, quantity: 1, unitPrice: total }];
  }

  const totalAmount = Number(items.reduce((s, i) => s + i.quantity * i.unitPrice, 0).toFixed(2));
  const invoiceNumber = idb.getNextInvoiceNumber(auth.telegramId);
  const walletAddress = auth.user.deposit_address;
  let sysKey = null;
  try { sysKey = db.getSystemDecryptedPrivateKey(auth.user, "personal"); } catch (_) { }

  if (sysKey && typeof dep("invoiceHd").createCompleteInvoice === "function") {
    try {
      const created = await dep("invoiceHd").createCompleteInvoice({
        telegramId: auth.telegramId,
        decryptedPrivateKey: sysKey,
        user: auth.user,
        businessName: db.resolveSenderName(auth.telegramId, "personal"),
        invoiceData: {
          invoiceNumber,
          clientName,
          clientEmail,
          items,
          totalUsdc: invoiceCurrency === "NGN" ? null : totalAmount,
          totalNgn: invoiceCurrency === "NGN" ? totalAmount : null,
          invoiceCurrency,
          paymentChannel,
          nuvionBankCurrency,
          cryptoChain,
          cryptoAssetId,
          cryptoSymbol,
          cryptoBlockchain,
          dueDate,
          notes,
        },
      });
      const row = created?.invoiceId ? idb.getInvoice(created.invoiceId) : null;
      return {
        status: 201,
        data: {
          invoice: row ? { ...formatPersonalInvoice(row), hasImage: true, paymentChannel, fiatCurrency: created?.fiatDetails?.currency || (paymentChannel === "ngn_bank" || paymentChannel === "both" ? "NGN" : nuvionBankCurrency), cryptoChain: created?.cryptoPaymentDetails?.chainLabel || cryptoChain } : { id: created?.invoiceId || null, invoiceNumber, clientName, items, totalUsdc: created?.totalUsdc ?? totalAmount, status: "unpaid", hasImage: Boolean(created?.pngPath) },
          paymentDetails: {
            paymentAddress: created?.cryptoPaymentDetails?.depositAddress || created?.paymentAddress || walletAddress,
            fiat: created?.fiatDetails || null,
            crypto: created?.cryptoPaymentDetails || created?.cryptoIntent || null,
            fiatPendingCurrency: created?.fiatPendingCurrency || null,
            clientCopyText: created?.clientCopyText || null,
            pngAvailable: Boolean(created?.pngPath),
          },
        },
      };
    } catch (err) {
      if (!String(err.message || "").includes("INVOICE_FORWARDING_SECRET")) throw err;
    }
  }

  const id = idb.createInvoice(auth.telegramId, { invoiceNumber, clientName, clientEmail, items, totalUsdc: totalAmount, dueDate, notes, walletAddress, pngPath: null });
  return { status: 201, data: { invoice: formatPersonalInvoice(idb.getInvoice(id)), paymentDetails: { paymentAddress: walletAddress, fiat: null, crypto: null } } };
}

async function markPersonalInvoicePaid(auth, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw bad("Invalid invoice ID.");
  const idb = dep("invoiceDb");
  const row = idb.getInvoice(id);
  if (!row || Number(row.telegram_id) !== auth.telegramId) throw new FeatureError(404, "invoice_not_found", "Invoice not found.");
  idb.markInvoicePaid(id);
  return { status: 200, data: { success: true, invoice: formatPersonalInvoice(idb.getInvoice(id)) } };
}

async function markBusinessInvoicePaid(auth, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw bad("Invalid invoice ID.");
  const bizDb = dep("bizDb");
  const row = bizDb.getBizInvoice(id);
  if (!row || Number(row.telegram_id) !== auth.telegramId) throw new FeatureError(404, "invoice_not_found", "Invoice not found.");
  bizDb.markBizInvoicePaid(id);
  return { status: 200, data: { success: true, invoice: formatBizInvoice(bizDb.getBizInvoice(id)) } };
}

/**
 * Available payment methods when creating an invoice on mobile (identical to the Telegram bot):
 * - All Global Neobank (Nuvion) fiat receiving currencies + instant Naira bank account
 * - All live NEAR Intents chains & tokens + direct Arc USDC
 */
async function getInvoicePaymentOptions(auth, url) {
  const accountType = resolveAccountType(auth, url?.searchParams?.get("account"));
  const db = dep("db");
  const corridors = dep("nuvionCorridors");
  const near = dep("near");
  const entity = db.getNuvionEntityByUser(auth.telegramId, accountType);
  const globalBankEnabled = Boolean(entity && String(entity.status || "").toLowerCase() === "approved");
  const existingDetails = entity
    ? (db.getNuvionAccountDetailsByEntity(entity.entity_id) || []).filter((d) => d.asset_type === "fiat")
    : [];
  const provisionedSet = new Set(existingDetails.map((d) => String(d.currency || "").toUpperCase()));

  const labels = {
    NGN: "Nigerian Naira",
    USD: "US Dollar",
    GBP: "British Pound",
    EUR: "Euro",
    CAD: "Canadian Dollar",
    AUD: "Australian Dollar",
    AED: "UAE Dirham",
    KES: "Kenyan Shilling",
    GHS: "Ghanaian Cedi",
    TZS: "Tanzanian Shilling",
    ZAR: "South African Rand",
    MXN: "Mexican Peso",
  };
  const allFiat = corridors?.ALL_NUVION_RECEIVING_CURRENCIES || ["USD", "GBP", "EUR", "NGN", "AED", "KES", "GHS", "TZS", "MXN", "CAD"];
  const orderedFiat = ["NGN", ...allFiat.filter((c) => c !== "NGN")];
  const fiatCurrencies = orderedFiat.map((cur) => {
    const code = String(cur).toUpperCase();
    const isNgn = code === "NGN";
    return {
      currency: code,
      label: labels[code] || code,
      provider: isNgn && !globalBankEnabled ? "naira_instant" : "global_bank",
      provisioned: isNgn ? true : provisionedSet.has(code),
    };
  });

  let cryptoCatalog = { chains: [], tokensByChain: {} };
  if (typeof near.getAllSupportedIntentTokens === "function") {
    try {
      cryptoCatalog = await near.getAllSupportedIntentTokens();
    } catch (_) { }
  }

  const arcChain = {
    key: "arc",
    name: "Direct USDC",
    short: "USDC",
    isEvm: true,
    priority: 0,
    logoUrl: typeof near.getTokenLogoUrl === "function" ? near.getTokenLogoUrl("USDC") : null,
    tokenCount: 1,
  };
  const arcTokens = [
    {
      symbol: "USDC",
      name: "USD Coin (Direct)",
      assetId: "arc:usdc",
      decimals: 6,
      blockchain: "arc",
      priceUsd: 1,
      logoUrl: typeof near.getTokenLogoUrl === "function" ? near.getTokenLogoUrl("USDC") : null,
    },
  ];
  const cryptoChains = [arcChain, ...(Array.isArray(cryptoCatalog?.chains) ? cryptoCatalog.chains : [])];
  const cryptoTokensByChain = {
    arc: arcTokens,
    ...(cryptoCatalog?.tokensByChain || {}),
  };

  return {
    status: 200,
    data: {
      accountType,
      globalBankEnabled,
      fiatCurrencies,
      cryptoChains,
      cryptoTokensByChain,
    },
  };
}

function loadOwnedInvoice(auth, rawId, scope) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw bad("Invalid invoice ID.");
  if (scope === "business") {
    const bizDb = dep("bizDb");
    if (typeof bizDb.initBizTables === "function") bizDb.initBizTables();
    const row = bizDb.getBizInvoice(id);
    if (!row || Number(row.telegram_id) !== Number(auth.telegramId)) {
      throw new FeatureError(404, "invoice_not_found", "Invoice not found.");
    }
    return row;
  }
  const idb = dep("invoiceDb");
  if (typeof idb.initInvoiceTables === "function") idb.initInvoiceTables();
  const row = idb.getInvoice(id);
  const ownerId = row ? Number(row.owner_telegram_id ?? row.telegram_id) : null;
  if (!row || ownerId !== Number(auth.telegramId)) {
    throw new FeatureError(404, "invoice_not_found", "Invoice not found.");
  }
  return row;
}

async function createInvoiceDownloadLink(auth, rawId, scope = "personal") {
  const row = loadOwnedInvoice(auth, rawId, scope);
  const { u, e, s } = dep("tokens").signInvoiceLink(auth.telegramId, scope, row.id);
  return {
    status: 200,
    data: {
      path: `/invoice-files/${scope}/${row.id}?u=${u}&e=${e}&s=${encodeURIComponent(s)}`,
      expiresInSec: 600,
    },
  };
}

async function downloadInvoiceImage(auth, rawId, scope = "personal", opts = {}) {
  const fs = require("fs");
  const row = loadOwnedInvoice(auth, rawId, scope);
  const filename = `proxim-invoice-${String(row.invoice_number || row.id).replace(/[^A-Za-z0-9._-]/g, "_")}.png`;
  const disposition = `${opts.download ? "attachment" : "inline"}; filename="${filename}"`;

  // 1. Serve cached PNG from disk if present
  if (row.png_path && fs.existsSync(row.png_path)) {
    try {
      const png = fs.readFileSync(row.png_path);
      if (png && png.length > 100) {
        return {
          status: 200,
          raw: png,
          contentType: "image/png",
          headers: { "Content-Disposition": disposition },
        };
      }
    } catch (_) { }
  }

  // 2. Otherwise regenerate the crisp branded PNG on demand from the saved invoice record
  let items = [];
  try { items = JSON.parse(row.items_json || "[]"); } catch (_) { items = []; }
  if (!Array.isArray(items) || !items.length) {
    items = [{ description: row.notes || `Invoice for ${row.client_name}`, quantity: 1, unitPrice: Number(row.total_usdc || 0) }];
  }
  const db = dep("db");
  const bizProfile = dep("bizProfile");
  let profile = null;
  try {
    if (scope === "business" && typeof bizProfile.getBizProfile === "function") {
      profile = bizProfile.getBizProfile(auth.telegramId);
    }
  } catch (_) { }
  const senderDisplayName = scope === "business"
    ? (profile?.business_name || db.resolveSenderName(auth.telegramId, "business"))
    : db.resolveSenderName(auth.telegramId, "personal");
  const fiatDetails = row.fiat_account_number
    ? {
      bankName: row.fiat_bank_name || "Partner Bank",
      accountNumber: row.fiat_account_number,
      accountName: row.fiat_account_name || senderDisplayName,
      fiatAmount: Number(row.fiat_amount || 0) || null,
      currency: Number(row.fiat_rate || 0) > 10 ? "NGN" : "USD",
    }
    : null;
  let logoDataUri = null;
  try { logoDataUri = typeof bizProfile.getLogoDataUri === "function" ? bizProfile.getLogoDataUri(auth.telegramId) : null; } catch (_) { }

  const outPath = await dep("invoiceGenerator").generateInvoicePNG({
    invoiceNumber: row.invoice_number,
    clientName: row.client_name,
    clientEmail: row.client_email || null,
    items,
    dueDate: row.due_date || null,
    notes: row.notes || null,
    businessName: senderDisplayName,
    businessEmail: profile?.business_email || null,
    businessPhone: profile?.phone || null,
    businessAddress: profile?.address || null,
    logoDataUri,
    walletAddress: row.payment_address || row.wallet_address || null,
    nearAddress: row.near_address || null,
    issueDate: row.created_at ? String(row.created_at).slice(0, 10) : new Date().toISOString().slice(0, 10),
    currency: "USD",
    fiatDetails,
  });

  const png = fs.readFileSync(outPath);
  try { fs.unlinkSync(outPath); } catch (_) { }
  return {
    status: 200,
    raw: png,
    contentType: "image/png",
    headers: { "Content-Disposition": disposition },
  };
}

async function listBusinessExpenses(auth, url) {
  const bizDb = dep("bizDb");
  if (typeof bizDb.initBizTables === "function") bizDb.initBizTables();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 200);
  const rows = dep("db").db
    .prepare("SELECT * FROM biz_expenses WHERE telegram_id = ? ORDER BY id DESC LIMIT ?")
    .all(Number(auth.telegramId), limit);
  return {
    status: 200,
    data: {
      expenses: rows.map((e) => ({
        id: e.id,
        amount: Number(e.amount || 0),
        currency: e.currency || "USDC",
        category: e.category || "General",
        description: e.description,
        loggedAt: e.logged_at || null,
      })),
    },
  };
}

async function logBusinessExpense(auth, body) {
  const bizDb = dep("bizDb");
  if (typeof bizDb.initBizTables === "function") bizDb.initBizTables();
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) throw bad("Enter a positive expense amount.", "invalid_amount");
  const currency = (optStr(body, "currency", { pattern: /^(USDC|USD|NGN|EURC|GBP|EUR)$/i }) || "USDC").toUpperCase();
  const description = reqStr(body, "description", { max: 200 });
  bizDb.logExpense(auth.telegramId, amount, currency, description);
  const latest = dep("db").db
    .prepare("SELECT * FROM biz_expenses WHERE telegram_id = ? ORDER BY id DESC LIMIT 1")
    .get(Number(auth.telegramId));
  return {
    status: 201,
    data: {
      expense: latest ? { id: latest.id, amount: Number(latest.amount), currency: latest.currency, category: latest.category, description: latest.description, loggedAt: latest.logged_at } : { amount, currency, description },
    },
  };
}

async function setBusinessSavingsGoal(auth, body) {
  const bizDb = dep("bizDb");
  if (typeof bizDb.initBizTables === "function") bizDb.initBizTables();
  const percentage = Math.round(Number(body?.percentage));
  if (!Number.isInteger(percentage) || percentage < 0 || percentage > 90) {
    throw bad("Savings goal percentage must be between 0 and 90.");
  }
  const label = optStr(body, "label", { max: 60 }) || "Business Savings";
  bizDb.setSavingsGoal(auth.telegramId, percentage, label);
  return { status: 200, data: { savingsGoal: bizDb.getSavingsGoal(auth.telegramId) } };
}

async function getTransactionReceipt(auth, rawId, opts = {}) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw bad("Invalid transaction ID.");
  const db = dep("db");
  const tx = db.db.prepare("SELECT * FROM transactions WHERE id = ? AND telegram_id = ?").get(id, Number(auth.telegramId));
  if (!tx) throw new FeatureError(404, "not_found", "Transaction not found.");
  const amountNum = Number(formatAmountForCsv(tx.amount_micro ?? tx.amount ?? "0", tx.decimals ?? 18)) || 0;
  const acctType = tx.account_type || "personal";
  // Bank payouts: name the account that was paid, like the bot's payout receipts.
  let payout = null;
  if (/offramp|payout|withdraw/i.test(String(tx.type || "")) && tx.tx_hash && typeof db.getOfframpOrderByOrderId === "function") {
    try {
      const o = db.getOfframpOrderByOrderId(tx.tx_hash);
      if (o && Number(o.telegram_id) === Number(auth.telegramId)) payout = o;
    } catch (_) { }
  }
  const outPath = await dep("receiptGenerator").generateReceiptPNG({
    receiptId: `TX-${tx.id}`,
    senderName: db.resolveSenderName(auth.telegramId, acctType),
    senderAddress: acctType === "business" ? (auth.user.business_deposit_address || auth.user.deposit_address) : auth.user.deposit_address,
    recipientName: payout?.account_name || tx.narration || tx.type || "Transaction",
    recipientAddress: payout ? [payout.bank_name, payout.account_number].filter(Boolean).join(" · ") : (tx.tx_hash || ""),
    amountUsdc: amountNum,
    token: "USDC",
    type: tx.type || "Transfer",
    timestamp: tx.created_at || new Date().toISOString(),
    status: tx.status || "Completed",
    txHash: tx.tx_hash || null,
    narration: tx.narration || null,
  });
  const fs = require("fs");
  const png = fs.readFileSync(outPath);
  try { fs.unlinkSync(outPath); } catch (_) { }
  return {
    status: 200,
    raw: png,
    contentType: "image/png",
    headers: { "Content-Disposition": `${opts.download ? "attachment" : "inline"}; filename="proxim-receipt-${tx.id}.png"` },
  };
}

async function getInvestmentsHub(auth) {
  const pods = dep("pods");
  const enabled = typeof pods.isInvestmentsEnabledForUser === "function"
    ? Boolean(pods.isInvestmentsEnabledForUser(auth.telegramId))
    : false;
  if (!enabled) {
    return { status: 200, data: { enabled: false } };
  }
  return {
    status: 200,
    data: {
      enabled: true,
      popularStocks: pods.POPULAR_STOCKS || [],
      savingsVaults: pods.CURATED_SAVINGS_VAULTS || [],
    },
  };
}

module.exports = {
  FeatureError,
  updateProfile,
  listAccounts,
  switchAccount,
  listContacts,
  upsertContact,
  deleteContact,
  lookupUser,
  listBanks,
  getBankRates,
  getLiveUsdNgnRate,
  resolveBankAccount,
  createNgnDeposit,
  getCardDepositLink,
  getNgnDepositStatus,
  listCryptoDepositTokens,
  createCryptoDepositIntent,
  getCryptoDepositStatus,
  listGlobalAccounts,
  provisionGlobalAccount,
  listGlobalCorridors,
  listGlobalBankCodes,
  listGlobalRecipients,
  createGlobalPaymentLink,
  listCards,
  listCardTransactions,
  listBillProviders,
  validateBillMeter,
  listBillHistory,
  listSchedules,
  updateScheduleStatus,
  getRewards,
  getKycStatus,
  createKycUploadSession,
  getKycUploadSessionStatus,
  listKycUploadSessions,
  renderKycUploadPage,
  completeKycUploadPage,
  detectDocumentMime,
  wrapJpegBufferAsPdf,
  normalizeDocumentForNuvion,
  submitKyc,
  submitKyb,
  refreshKycStatus,
  getSavingsOverview,
  getBusinessHome,
  updateBusinessProfile,
  uploadBusinessLogo,
  listBusinessInvoices,
  getBusinessInvoice,
  createBusinessInvoice,
  markBusinessInvoicePaid,
  listBusinessExpenses,
  logBusinessExpense,
  setBusinessSavingsGoal,
  listBusinessPaymentLinks,
  createBusinessPaymentLink,
  deactivateBusinessPaymentLink,
  listPersonalInvoices,
  getPersonalInvoice,
  createPersonalInvoice,
  markPersonalInvoicePaid,
  getInvoicePaymentOptions,
  createInvoiceDownloadLink,
  downloadInvoiceImage,
  listWithdrawalChains,
  listBridgeMoves,
  sweepCryptoDeposits,
  getSwapRates,
  quoteSwap,
  listPendingGifts,
  claimGift,
  getTransactionReceipt,
  getInvestmentsHub,
  assistantChat,
  exportStatementCsv,
  __setTestDeps,
};
