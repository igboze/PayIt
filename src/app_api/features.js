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
  get receiptGenerator() { return require("../receipt_generator"); },
  get socialTransfers() { return require("../social_transfers"); },
  get swap() { return require("../swap"); },
  get flowsMultichain() { return require("../flows_multichain"); },
  get pods() { return require("../pods"); },
  get notify() { return require("../notify"); },
  get solanaAddress() { return require("../solana_address"); },
  get onramp() { return require("../onramp"); },
};

const overrides = {};
const dep = (name) => (name in overrides ? overrides[name] : deps[name]);
function __setTestDeps(o = {}) {
  for (const k of Object.keys(overrides)) delete overrides[k];
  Object.assign(overrides, o);
  _banksCache = { rows: null, fetchedAt: 0 };
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
  } catch (_) {}
  try {
    const derived = dep("chains").deriveAddress?.(user, accountType, "solana", { strictBusiness: isBiz });
    if (derived) return derived;
  } catch (_) {}
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

function formatGlobalAccount(d) {
  return {
    id: d.detail_id || d.id || null,
    accountId: d.account_id || null,
    currency: d.currency,
    bankName: d.bank_name || null,
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
  const accountType = resolveAccountType(auth, body?.accountType);
  const hasAutoEarn = typeof body?.autoEarnEnabled === "boolean";
  const activeContext = optStr(body, "activeContext", { pattern: /^(personal|business)$/ });

  if (!senderName && !bizSenderName && !hasAutoEarn && !activeContext) {
    throw bad("Provide senderName, bizSenderName, autoEarnEnabled, or activeContext to update.");
  }
  try {
    if (senderName) db.setUserSenderName(auth.telegramId, senderName, accountType);
    if (bizSenderName) db.setUserSenderName(auth.telegramId, bizSenderName, "business");
    if (hasAutoEarn) db.updateAutoEarnSetting(auth.telegramId, body.autoEarnEnabled);
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
  try { perBal = await chains.getUnifiedBalance(auth.user, "personal", { strictBusiness: false }); } catch (_) {}
  if (auth.user.business_deposit_address) {
    try { bizBal = await chains.getUnifiedBalance(auth.user, "business", { strictBusiness: true }); } catch (_) {}
  }

  const accounts = [
    {
      accountType: "personal",
      active: activeContext === "personal",
      depositAddress: auth.user.deposit_address || null,
      solanaAddress: getStrictAccountSolanaAddress(auth.user, "personal"),
      kycStatus: perEnt?.status || "not_started",
      kycTier: String(perEnt?.status || "").toLowerCase() === "approved" ? 1 : 0,
      balance: perBal ? { totalUsdc: perBal.total, arc: perBal.arc, base: perBal.base || { usdc: 0 }, gateway: perBal.gateway || { usdc: 0 }, solana: perBal.solana, pendingBridgeUsdc: perBal.pendingNear } : null,
    },
  ];

  if (auth.user.business_deposit_address) {
    let bizProfileRow = null;
    try { bizProfileRow = dep("bizProfile").getBizProfile(auth.telegramId); } catch (_) {}
    accounts.push({
      accountType: "business",
      active: activeContext === "business",
      businessName: bizProfileRow?.business_name || null,
      depositAddress: auth.user.business_deposit_address,
      solanaAddress: getStrictAccountSolanaAddress(auth.user, "business"),
      kycStatus: bizEnt?.status || "not_started",
      kycTier: String(bizEnt?.status || "").toLowerCase() === "approved" ? 1 : 0,
      balance: bizBal ? { totalUsdc: bizBal.total, arc: bizBal.arc, base: bizBal.base || { usdc: 0 }, gateway: bizBal.gateway || { usdc: 0 }, solana: bizBal.solana, pendingBridgeUsdc: bizBal.pendingNear } : null,
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
  try { dep("solanaAddress").reconcileUser(updated); } catch (_) {}

  const chains = dep("chains");
  let balance = null;
  let otherBalanceUsdc = 0;
  try {
    const u = await chains.getUnifiedBalance(updated, target, { strictBusiness: target === "business" });
    balance = { totalUsdc: u.total, arc: u.arc, base: u.base || { usdc: 0 }, gateway: u.gateway || { usdc: 0 }, solana: u.solana, byChain: u.byChain || null, pendingBridgeUsdc: u.pendingNear };
  } catch (_) {}
  if (updated.business_deposit_address) {
    const other = target === "business" ? "personal" : "business";
    try {
      const o = await chains.getUnifiedBalance(updated, other, { strictBusiness: other === "business" });
      otherBalanceUsdc = Number(o?.total || 0);
    } catch (_) {}
  }

  const ent = db.getNuvionEntityByUser(auth.telegramId, target);
  let pendingInvoiceCount = 0;
  if (target === "business") {
    try { pendingInvoiceCount = Number(dep("bizDb").getPendingInvoiceCount(auth.telegramId) || 0); } catch (_) {}
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
    } catch (_) {}
  }

  if (!banks || !banks.length) {
    banks = country === "NG" ? fallbackBankList() : [];
  }
  const filtered = q
    ? banks.filter((b) => b.name.toLowerCase().includes(q) || b.code.includes(q))
    : banks;

  return { status: 200, data: { country, banks: filtered } };
}

async function getBankRates() {
  let onRampRate = null;
  let offRampRate = null;
  try {
    const r = await dep("paj").getRates("NGN");
    onRampRate = Number(r?.onRampRate?.rate || r?.onRampRate?.rawRate || 0) || null;
    offRampRate = Number(r?.offRampRate?.rate || 0) || null;
  } catch (_) {}
  if (!offRampRate) {
    try { offRampRate = Number(await dep("fx").getUsdToNgnRate()) || null; } catch (_) {}
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
  } catch (_) {}

  if (!/^[A-Za-z0-9-]{2,20}$/.test(bankCode)) {
    throw bad("Could not recognize that bank. Pick a bank from the list.");
  }

  const paj = dep("paj");
  let accountName = null;
  let resolvedBankName = bankName;

  // 1. Check Paj's directory search first
  if (typeof paj.searchBankAccount === "function") {
    try {
      const found = await paj.searchBankAccount({ accountNumber, bankCode });
      const items = Array.isArray(found) ? found : (found?.data ? (Array.isArray(found.data) ? found.data : [found.data]) : [found]);
      const match = items.find((item) => item && item.accountName && (!item.bank?.code || String(item.bank.code).padStart(6, "0") === String(bankCode).padStart(6, "0")));
      if (match?.accountName) {
        accountName = String(match.accountName).trim();
        resolvedBankName = resolvedBankName || match.bank?.name || match.bankName || null;
      }
    } catch (_) {}
  }

  // 2. Fallback to NIBSS verification via Paj permanent bank account registration (idempotent)
  if (!accountName && typeof paj.registerPermanentBankAccount === "function") {
    try {
      const reg = await paj.registerPermanentBankAccount(bankCode, accountNumber);
      const data = reg?.data || reg;
      if (data?.accountName) {
        accountName = String(data.accountName).trim();
        resolvedBankName = resolvedBankName || data.bank?.name || data.bankName || null;
      }
    } catch (err) {
      const msg = String(err.message || "").toLowerCase();
      if (msg.includes("invalid") || msg.includes("not found") || msg.includes("could not")) {
        throw new FeatureError(404, "account_not_found", "Could not verify that bank account. Check the bank and account number.");
      }
      throw new FeatureError(502, "provider_error", "Bank name check is temporarily unavailable. Please try again.");
    }
  }

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
    } catch (_) {}
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
  const local = dep("db").getOnrampOrderByOrderId?.(id) || null;
  if (local && Number(local.telegram_id) !== auth.telegramId) {
    throw new FeatureError(404, "not_found", "Deposit order not found.");
  }
  const live = await dep("paj").getOnrampOrder(id);
  if (!live && !local) throw new FeatureError(404, "not_found", "Deposit order not found.");
  return {
    status: 200,
    data: {
      orderId: id,
      status: live?.status || local?.status || "pending",
      order: live || local,
    },
  };
}

async function listCryptoDepositTokens(auth, url = null) {
  const accountType = resolveAccountType(auth, url?.searchParams?.get("account"));
  const near = dep("near");
  const evmAddr = getStrictAccountArcAddress(auth.user, accountType);
  const solAddr = getStrictAccountSolanaAddress(auth.user, accountType);
  const [nearTokens, solanaTokens, robinhoodTokens, starknetTokens] = await Promise.all([
    Promise.resolve(near.getSupportedNearTokens()).catch(() => []),
    Promise.resolve(near.getSupportedSolanaTokens()).catch(() => []),
    Promise.resolve(near.getSupportedRobinhoodTokens()).catch(() => []),
    Promise.resolve(near.getSupportedStarknetTokens()).catch(() => []),
  ]);
  return {
    status: 200,
    data: {
      accountType,
      directAddresses: {
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
      intents: {
        near: nearTokens,
        solana: solanaTokens,
        robinhood: robinhoodTokens,
        starknet: starknetTokens,
      },
    },
  };
}

async function createCryptoDepositIntent(auth, body) {
  const chain = reqStr(body, "chain", { pattern: /^(near|solana|robinhood|starknet)$/i }).toLowerCase();
  const symbol = reqStr(body, "symbol", { max: 24 }).toUpperCase();
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

  if (chain === "near") {
    token = await near.resolveNearToken(symbol);
    if (!token) throw bad(`Unsupported NEAR token: ${symbol}`);
    if (!refundTo) {
      try {
        const sysKey = db.getSystemDecryptedPrivateKey(auth.user, accountType);
        if (sysKey && typeof near.deriveNearAddress === "function") {
          refundTo = near.deriveNearAddress(sysKey)?.nearAddress || null;
        }
      } catch (_) {}
    }
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
  } else if (chain === "solana") {
    token = await near.resolveSolanaToken(symbol);
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
  } else if (chain === "robinhood") {
    token = await near.resolveRobinhoodToken(symbol);
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
    token = await near.resolveStarknetToken(symbol);
    if (!token) throw bad(`Unsupported Starknet token: ${symbol}`);
    row = await near.createStarknetDeposit({
      telegramId: auth.telegramId,
      accountType,
      originAsset: token.assetId,
      originSymbol: token.symbol,
      originDecimals: token.decimals,
      amount,
      recipientAddress,
      refundTo: refundTo || recipientAddress,
    });
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
    try { liveStatus = await dep("near").getExecutionStatus(row.deposit_address, row.deposit_memo); } catch (_) {}
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
  return {
    status: 200,
    data: {
      accountType,
      kycStatus: entity.status || "pending",
      supportedCurrencies,
      accounts: details.map(formatGlobalAccount),
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
    return {
      status: res.cached ? 200 : 201,
      data: {
        accountType,
        account: formatGlobalAccount(res.detail),
        isPending: Boolean(res.isPending),
        cached: Boolean(res.cached),
      },
    };
  } catch (err) {
    const msg = String(err.message || "Could not open global account.").replace(/nuvion/gi, "Global Neobank");
    throw new FeatureError(400, "provision_failed", msg);
  }
}

async function listGlobalCorridors() {
  const c = dep("nuvionCorridors");
  const rails = Object.values(c.PAYOUT_RAILS || {}).map((r) => ({
    railKey: r.key,
    currency: r.currency,
    country: r.country,
    label: r.label,
    paymentMethod: r.paymentMethod,
    settlement: r.settlement,
    minAmount: r.minAmount || null,
    maxAmount: r.maxAmount || null,
    requiredFields: r.fields || [],
  }));
  return {
    status: 200,
    data: {
      currencies: c.ALL_NUVION_FIAT_CURRENCIES || [],
      receivingCurrencies: c.ALL_NUVION_RECEIVING_CURRENCIES || [],
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
  } catch (_) {}

  return {
    status: 200,
    data: {
      pointsBalance,
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

async function getKycStatus(auth) {
  const db = dep("db");
  const fg = dep("fraudGuard");
  const personal = db.getNuvionEntityByUser(auth.telegramId, "personal");
  const business = db.getNuvionEntityByUser(auth.telegramId, "business");
  const personalApproved = String(personal?.status || "").toLowerCase() === "approved";
  const businessApproved = String(business?.status || "").toLowerCase() === "approved";
  const cfg = fg.getVelocityConfig ? fg.getVelocityConfig() : {
    tier0HourlyLimitUsd: 300,
    tier0DailyLimitUsd: 500,
    tier1HourlyLimitUsd: 10000,
    tier1DailyLimitUsd: 25000,
    tier1BizDailyLimitUsd: 100000,
  };
  const stats = fg.getUserOutboundStats ? fg.getUserOutboundStats(auth.telegramId) : { usd1h: 0, usd24h: 0 };

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
  try { pools = await savings.getYieldPools(); } catch (_) {}
  const accruedYieldUsdc = open && typeof savings.calcAccruedYield === "function" ? Number(savings.calcAccruedYield(open) || 0) : 0;
  return {
    status: 200,
    data: {
      accountType,
      position: open ? {
        id: open.id,
        principalUsdc: Number(open.amount_usdc || 0),
        accruedYieldUsdc,
        apy: Number(open.apy || 0),
        symbol: open.symbol || "USDC",
        vaultAddress: open.vault_address || null,
        openedAt: open.opened_at || open.created_at || null,
      } : null,
      pools: (Array.isArray(pools) ? pools : []).map((p) => ({
        name: p.name || p.project || "Dollar lending vault",
        symbol: p.symbol || "USDC",
        apy: Number(p.apy || 0),
        tvlUsd: Number(p.tvlUsd || 0),
        vaultAddress: p.vaultAddress || null,
      })),
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
    } catch (_) {}
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
        updatedAt: saved.updated_at || null,
      },
    },
  };
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
  const nuvionBankCurrency = (optStr(body, "globalBankCurrency", { pattern: /^[A-Za-z]{3}$/ }) || "USD").toUpperCase();
  const cryptoChain = optStr(body, "cryptoChain", { max: 32 }) || "arc";

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
  } catch (_) {}

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
          dueDate,
          notes,
        },
      });
      const row = created?.invoiceId ? bizDb.getBizInvoice(created.invoiceId) : null;
      return {
        status: 201,
        data: {
          invoice: row ? formatBizInvoice(row) : {
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
            cryptoIntent: created?.cryptoIntent || null,
          },
          paymentDetails: {
            paymentAddress: created?.paymentAddress || walletAddress,
            fiat: created?.fiatDetails || null,
            crypto: created?.cryptoIntent || null,
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
  const message = reqStr(body, "message", { max: 1000 });
  const accountType = resolveAccountType(auth, body?.accountType);
  const router = dep("intentRouter");
  const classified = await router.classifyIntent(message, auth.telegramId, {
    address: getStrictAccountArcAddress(auth.user, accountType),
    active_context: accountType,
  });

  const intent = classified?.intent || "unknown";
  const params = classified?.params || {};
  const missingQuestion = typeof router.getMissingQuestion === "function" ? router.getMissingQuestion(classified) : null;
  const confirmationText = typeof router.buildConfirmationText === "function"
    ? router.buildConfirmationText(classified, params.recipients || [])
    : null;

  let reply = classified?.raw_summary || "I can help check balances, contacts, bills, savings, invoices, or prepare a payment for your approval.";
  let data = null;
  let suggestedAction = null;

  // Read-only intents can be answered directly
  if (intent === "balance") {
    try {
      const u = await dep("chains").getUnifiedBalance(auth.user, accountType, { strictBusiness: accountType === "business" });
      data = { accountType, totalUsdc: u.total, arc: u.arc, base: u.base || { usdc: 0 }, gateway: u.gateway || { usdc: 0 }, solana: u.solana, pendingBridgeUsdc: u.pendingNear };
      reply = `Your ${accountType} balance is $${Number(u.total || 0).toFixed(2)}.`;
    } catch (_) {
      reply = "Could not load your live balance right now.";
    }
  } else if (intent === "history") {
    const rows = dep("db").getTransactions(auth.telegramId, 5, accountType);
    data = { accountType, count: rows.length, transactions: rows.map((t) => ({ id: t.id, type: t.type, status: t.status, createdAt: t.created_at })) };
    reply = rows.length ? `Found ${rows.length} recent transaction${rows.length === 1 ? "" : "s"}.` : "You have no transactions yet.";
  } else if (intent === "list_payees") {
    const pb = dep("payeeBook");
    if (typeof pb.initPayeeTable === "function") pb.initPayeeTable();
    const rows = pb.getAllPayees(auth.telegramId);
    data = { contacts: rows.map(formatContact) };
    reply = rows.length ? `You have ${rows.length} saved contact${rows.length === 1 ? "" : "s"}.` : "You have no saved contacts yet.";
  } else if (intent === "invoice_list") {
    const rows = dep("bizDb").getBizInvoices(auth.telegramId, 10);
    data = { invoices: rows.map(formatBizInvoice) };
    reply = rows.length ? `You have ${rows.length} business invoice${rows.length === 1 ? "" : "s"}.` : "You have no invoices yet.";
  } else if (intent === "savings_view") {
    const open = dep("db").getOpenYieldPosition(auth.telegramId, accountType);
    const accrued = open && typeof dep("savings").calcAccruedYield === "function" ? Number(dep("savings").calcAccruedYield(open) || 0) : 0;
    data = open ? { principalUsdc: Number(open.amount_usdc || 0), accruedYieldUsdc: accrued, apy: Number(open.apy || 0) } : null;
    reply = open
      ? `You have $${Number(open.amount_usdc || 0).toFixed(2)} in savings (+$${accrued.toFixed(4)} earned).`
      : "You don't have an active savings deposit yet.";
  } else if (intent === "referral") {
    const points = dep("db").getPointsBalance(auth.telegramId);
    const code = auth.user.referral_code || `ref${auth.telegramId}`;
    data = { pointsBalance: points, referralCode: code };
    reply = `You have ${points} reward points. Share code ${code} to earn more.`;
  } else if (intent === "cash_flow") {
    const inc = Number(dep("bizDb").getMonthIncome(auth.telegramId) || 0);
    const exp = Number(dep("bizDb").getMonthExpenses(auth.telegramId) || 0);
    data = { monthIncomeUsd: inc, monthExpensesUsd: exp, netCashFlowUsd: Number((inc - exp).toFixed(2)) };
    reply = `This month: $${inc.toFixed(2)} in, $${exp.toFixed(2)} out (net $${(inc - exp).toFixed(2)}).`;
  } else if (intent === "help") {
    reply = "Ask me to check your balance, view recent transactions, list contacts or invoices, save to yield, cash out to Naira, or send USDC to a contact or wallet.";
  }

  // Actionable money intents ONLY produce a suggestedAction for the passkey + PIN approval flow
  let r0 = params?.recipients?.[0] || null;
  if (r0 && r0.name_or_address && !r0.wallet_address && !r0.account_number) {
    try {
      const pb = dep("payeeBook");
      if (typeof pb.initPayeeTable === "function") pb.initPayeeTable();
      const matched = pb.resolvePayee(auth.telegramId, r0.name_or_address);
      if (matched && !Array.isArray(matched)) {
        r0 = {
          ...r0,
          name_or_address: matched.name || r0.name_or_address,
          wallet_address: matched.wallet_address || null,
          bank_name: r0.bank_name || matched.bank_name || null,
          account_number: r0.account_number || matched.account_number || null,
          account_name: r0.account_name || matched.account_name || null,
        };
      }
    } catch (_) {}
  }
  if (intent === "transfer" && r0 && Number(r0.amount) > 0) {
    const addr = r0.wallet_address || (/^0x[0-9a-fA-F]{40}$/.test(String(r0.name_or_address || "")) ? r0.name_or_address : null);
    if (addr) {
      suggestedAction = {
        type: "transfer.wallet",
        payload: { accountType, toAddress: addr.toLowerCase(), amountUsdc: Number(r0.amount), narration: r0.description || "" },
      };
      reply = `Ready to send $${Number(r0.amount).toFixed(2)} to ${r0.name_or_address || addr}. Review and approve with your passkey and PIN.`;
    } else if (r0.name_or_address) {
      const userMatch = dep("actions").findRecipientUser(r0.name_or_address);
      if (userMatch && userMatch.deposit_address) {
        suggestedAction = {
          type: "transfer.user",
          payload: { accountType, recipient: r0.name_or_address, amountUsdc: Number(r0.amount), narration: r0.description || "" },
        };
        reply = `Ready to send $${Number(r0.amount).toFixed(2)} to ${userMatch.username ? `@${userMatch.username}` : "Proxim user"}. Review and approve with your passkey and PIN.`;
      }
    }
  } else if (intent === "offramp" && r0 && Number(r0.amount) > 0 && r0.account_number && r0.bank_name) {
    let bankCode = null;
    try {
      const b = await dep("bankResolver").resolveBankCode(r0.bank_name);
      bankCode = b?.bankCode || null;
    } catch (_) {}
    if (bankCode && (!r0.currency || String(r0.currency).toUpperCase() === "USDC" || String(r0.currency).toUpperCase() === "USD")) {
      suggestedAction = {
        type: "payout.ngn",
        payload: {
          accountType,
          amountUsdc: Number(r0.amount),
          bankCode,
          accountNumber: r0.account_number,
          accountName: r0.account_name || "",
          narration: r0.narration || r0.description || "",
        },
      };
      reply = `Ready to send $${Number(r0.amount).toFixed(2)} to ${r0.bank_name} ${r0.account_number}. Review and approve with your passkey and PIN.`;
    }
  } else if (intent === "savings_deposit" && r0 && Number(r0.amount) > 0) {
    suggestedAction = {
      type: "savings.deposit",
      payload: { accountType, amountUsdc: Number(r0.amount) },
    };
    reply = `Ready to deposit $${Number(r0.amount).toFixed(2)} into savings. Approve with your passkey and PIN.`;
  } else if (intent === "savings_withdraw") {
    suggestedAction = { type: "savings.withdraw", payload: { accountType } };
    reply = "Ready to withdraw your savings back to your balance. Approve with your passkey and PIN.";
  } else if (intent === "scheduled" && r0 && Number(r0.amount) > 0 && params?.schedule?.frequency) {
    const addr = r0.wallet_address || (/^0x[0-9a-fA-F]{40}$/.test(String(r0.name_or_address || "")) ? r0.name_or_address : null);
    if (addr && /^(daily|weekly|monthly)$/.test(String(params.schedule.frequency).toLowerCase())) {
      suggestedAction = {
        type: "schedule.create",
        payload: {
          accountType,
          kind: "transfer.wallet",
          toAddress: addr.toLowerCase(),
          amountUsdc: Number(r0.amount),
          frequency: String(params.schedule.frequency).toLowerCase(),
          day: params.schedule.day || undefined,
          time: params.schedule.time || "09:00",
        },
      };
      reply = "Ready to set up your recurring payment. Approve with your passkey and PIN.";
    }
  }

  if (missingQuestion && !suggestedAction) {
    reply = missingQuestion;
  }

  return {
    status: 200,
    data: {
      intent,
      confidence: classified?.confidence || "low",
      summary: classified?.raw_summary || null,
      reply,
      missingQuestion,
      confirmationText,
      suggestedAction,
      params,
      data,
    },
  };
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
    try { return dep("walletLib").formatMicro(BigInt(str)); } catch (_) {}
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
  const rates = await dep("swap").getFxRates();
  return { status: 200, data: { rates } };
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
        try { summary = c.summary_json ? JSON.parse(c.summary_json) : {}; } catch (_) {}
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
  const dateOfBirth = reqStr(body, "dateOfBirth", { max: 20 });
  if (!body?.address || typeof body.address !== "object") throw bad("address object is required.");
  if (!body?.idDocument || typeof body.idDocument !== "object") throw bad("idDocument object is required.");

  let entityRes;
  try {
    entityRes = await dep("nuvion").createIndividualEntity({
      nationality: countryCode,
      firstName,
      lastName,
      middleName: optStr(body, "middleName", { max: 80 }) || undefined,
      email,
      phoneNumber,
      dateOfBirth,
      gender: optStr(body, "gender", { pattern: /^(male|female)$/i })?.toLowerCase() || "male",
      address: body.address,
      idDocument: body.idDocument,
    });
  } catch (err) {
    throw new FeatureError(Number(err.status || err.statusCode) || 400, "kyc_error", String(err.message || "Could not submit verification.").replace(/nuvion/gi, "Global Neobank"));
  }
  dep("db").upsertNuvionEntity({
    telegramId: auth.telegramId,
    accountType: "personal",
    entityId: entityRes.id,
    entityType: "individual",
    status: entityRes.status || "pending",
    legalName: `${firstName} ${lastName}`.trim(),
    countryCode,
  });
  return { status: 201, data: { status: entityRes.status || "pending", tier: String(entityRes.status || "").toLowerCase() === "approved" ? 1 : 0 } };
}

async function submitKyb(auth, body) {
  const compliance = dep("compliance");
  const countryCode = compliance.normalizeCountryCode(body?.incorporationCountry || body?.countryCode);
  if (!/^[A-Z]{2}$/.test(countryCode)) throw bad("Valid 2-letter ISO incorporationCountry is required.");
  if (compliance.isSanctionedCountry(countryCode)) {
    throw new FeatureError(403, "jurisdiction_unsupported", `Jurisdiction ${countryCode} is not supported due to compliance restrictions.`);
  }
  const legalName = reqStr(body, "legalName", { max: 120 });
  const registrationNumber = reqStr(body, "registrationNumber", { max: 64 });
  const email = reqStr(body, "email", { max: 120 });
  const phoneNumber = reqStr(body, "phoneNumber", { max: 32 });
  if (!body?.address || typeof body.address !== "object") throw bad("address object is required.");
  if (!body?.officer || typeof body.officer !== "object") throw bad("officer object is required.");

  let entityRes;
  try {
    entityRes = await dep("nuvion").createBusinessEntity({
      legalName,
      tradeName: optStr(body, "tradeName", { max: 120 }) || legalName,
      registrationNumber,
      taxId: optStr(body, "taxId", { max: 64 }) || registrationNumber,
      incorporationCountry: countryCode,
      incorporationState: optStr(body, "incorporationState", { max: 80 }) || body.address.state || "",
      incorporationYear: Number(body?.incorporationYear || 2022),
      incorporationMonth: Number(body?.incorporationMonth || 1),
      email,
      phoneNumber,
      website: optStr(body, "website", { max: 200 }) || undefined,
      industry: optStr(body, "industry", { max: 80 }) || "Financial Technology",
      entityType: optStr(body, "businessType", { max: 40 }) || "llc",
      address: body.address,
      officer: body.officer,
    });
  } catch (err) {
    throw new FeatureError(Number(err.status || err.statusCode) || 400, "kyb_error", String(err.message || "Could not submit business verification.").replace(/nuvion/gi, "Global Neobank"));
  }
  dep("db").upsertNuvionEntity({
    telegramId: auth.telegramId,
    accountType: "business",
    entityId: entityRes.id,
    entityType: "business",
    status: entityRes.status || "pending",
    legalName,
    countryCode,
  });
  return { status: 201, data: { status: entityRes.status || "pending", tier: String(entityRes.status || "").toLowerCase() === "approved" ? 1 : 0 } };
}

async function refreshKycStatus(auth, body) {
  const accountType = resolveAccountType(auth, body?.accountType);
  const db = dep("db");
  const entity = db.getNuvionEntityByUser(auth.telegramId, accountType);
  if (!entity) return getKycStatus(auth);
  try {
    const live = await dep("nuvion").getEntity(entity.entity_id);
    if (live?.status) {
      db.updateNuvionEntity(entity.entity_id, {
        status: live.status,
        rejection_reason: live.rejection_reason || live.status_reason || null,
      });
    }
  } catch (_) {}
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
  const nuvionBankCurrency = (optStr(body, "globalBankCurrency", { pattern: /^[A-Za-z]{3}$/ }) || "USD").toUpperCase();
  const cryptoChain = optStr(body, "cryptoChain", { max: 32 }) || "arc";

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
  try { sysKey = db.getSystemDecryptedPrivateKey(auth.user, "personal"); } catch (_) {}

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
          dueDate,
          notes,
        },
      });
      const row = created?.invoiceId ? idb.getInvoice(created.invoiceId) : null;
      return {
        status: 201,
        data: {
          invoice: row ? formatPersonalInvoice(row) : { id: created?.invoiceId || null, invoiceNumber, clientName, items, totalUsdc: created?.totalUsdc ?? totalAmount, status: "unpaid" },
          paymentDetails: { paymentAddress: created?.paymentAddress || walletAddress, fiat: created?.fiatDetails || null, crypto: created?.cryptoIntent || null },
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

async function getTransactionReceipt(auth, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw bad("Invalid transaction ID.");
  const db = dep("db");
  const tx = db.db.prepare("SELECT * FROM transactions WHERE id = ? AND telegram_id = ?").get(id, Number(auth.telegramId));
  if (!tx) throw new FeatureError(404, "not_found", "Transaction not found.");
  const amountNum = Number(formatAmountForCsv(tx.amount_micro ?? tx.amount ?? "0", tx.decimals ?? 18)) || 0;
  const acctType = tx.account_type || "personal";
  const outPath = await dep("receiptGenerator").generateReceiptPNG({
    receiptId: `TX-${tx.id}`,
    senderName: db.resolveSenderName(auth.telegramId, acctType),
    senderAddress: acctType === "business" ? (auth.user.business_deposit_address || auth.user.deposit_address) : auth.user.deposit_address,
    recipientName: tx.narration || tx.type || "Transaction",
    recipientAddress: tx.tx_hash || "",
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
  try { fs.unlinkSync(outPath); } catch (_) {}
  return {
    status: 200,
    raw: png,
    contentType: "image/png",
    headers: { "Content-Disposition": `inline; filename="proxim-receipt-${tx.id}.png"` },
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
  submitKyc,
  submitKyb,
  refreshKycStatus,
  getSavingsOverview,
  getBusinessHome,
  updateBusinessProfile,
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
