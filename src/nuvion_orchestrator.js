// src/nuvion_orchestrator.js
// Nuvion Phase 2 Orchestrator:
// - Named Global Receiving Accounts (USD, GBP, EUR, NGN, AED, KES, GHS, TZS, MXN)
// - Hosted Payment Links (Open Banking GBP/EUR, Interac CAD, Mobile Money KES/TZS)
// - Zero-Custody Inbound Fiat Auto-Sweep Engine:
//   Inbound Fiat -> 1% FX Margin (free book-transfer to Parent) -> FX Quote (FIAT -> USC)
//   -> stablecoin-transfer on BASE_MAINNET straight to User's 0x Wallet -> HD Receipt PNG!

const crypto = require("node:crypto");
const fs = require("node:fs");
const nuvion = require("./nuvion");
const nuvionWebhooks = require("./nuvion_webhooks");
const db = require("./db");
const idempotency = require("./idempotency");
const invoiceDb = require("./invoice_db");
const walletLib = require("./wallet");
const apiRoutes = require("./api_routes");
const fraudGuard = require("./fraud_guard");
const internationalBanks = require("./international_banks");
const { generateReceiptPNG } = require("./receipt_generator");

const CURRENCY_META = {
  USD: { symbol: "$", flag: "🇺🇸", label: "US Dollar (USD)", railHint: "ACH, Wire, RTP" },
  GBP: { symbol: "£", flag: "🇬🇧", label: "British Pound (GBP)", railHint: "Faster Payments & IBAN" },
  EUR: { symbol: "€", flag: "🇪🇺", label: "Euro (EUR)", railHint: "SEPA IBAN" },
  NGN: { symbol: "₦", flag: "🇳🇬", label: "Nigerian Naira (NGN)", railHint: "Permanent NUBAN (NIP)" },
  AED: { symbol: "AED ", flag: "🇦🇪", label: "UAE Dirham (AED)", railHint: "UAE Local IBAN" },
  KES: { symbol: "KSh ", flag: "🇰🇪", label: "Kenyan Shilling (KES)", railHint: "Bank & M-Pesa" },
  GHS: { symbol: "GH₵", flag: "🇬🇭", label: "Ghanaian Cedi (GHS)", railHint: "Bank Transfer" },
  TZS: { symbol: "TSh ", flag: "🇹🇿", label: "Tanzanian Shilling (TZS)", railHint: "Bank & Mobile Money" },
  MXN: { symbol: "MX$", flag: "🇲🇽", label: "Mexican Peso (MXN)", railHint: "CLABE" },
  CAD: { symbol: "CA$", flag: "🇨🇦", label: "Canadian Dollar (CAD)", railHint: "Interac e-Transfer" },
};

const STABLECOIN_CODES = new Set(["USC", "UST", "RLD"]);

// Cache of Root Parent operational accounts per currency so we don't query Nuvion on every deposit
const _parentOpAccounts = new Map();
const _fiatBalanceCache = new Map(); // entityId -> { fetchedAt, balances }
const FIAT_BALANCE_CACHE_TTL_MS = 15_000;
let _hooksRegistered = false;

function invalidateEntityFiatBalanceCache(entityId) {
  if (!entityId) return;
  _fiatBalanceCache.delete(String(entityId));
}

/**
 * Fetch live non-zero local fiat balances held inside a verified user's Nuvion checking accounts.
 * Excludes stablecoins (USC/UST/RLD). Safe against network hiccups (never throws).
 */
async function getEntityFiatBalances(telegramId, accountType = "personal", { forceRefresh = false } = {}) {
  try {
    if (!nuvion.isNuvionConfigured()) return [];
    const entity = db.getNuvionEntityByUser(telegramId, accountType);
    if (!entity || String(entity.status || "").toLowerCase() !== "approved") return [];

    const cacheKey = String(entity.entity_id);
    if (!forceRefresh) {
      const cached = _fiatBalanceCache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < FIAT_BALANCE_CACHE_TTL_MS) {
        return cached.balances;
      }
    }

    const listed = await Promise.race([
      nuvion.listAccounts({ entityId: entity.entity_id, limit: 50 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("fiat_balance_timeout")), 5000)),
    ]);
    const rows = Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : [];
    const byCurrency = new Map();

    for (const acc of rows) {
      const code = String(acc?.currency || "").toUpperCase();
      if (!code || STABLECOIN_CODES.has(code)) continue;
      if (acc?.status && String(acc.status).toLowerCase() === "closed") continue;
      const availableMinor = Math.max(0, Math.round(Number(acc?.balance?.available ?? 0)));
      const pendingMinor = Math.max(0, Math.round(Number(acc?.balance?.pending ?? 0)));
      const meta = CURRENCY_META[code] || { symbol: `${code} `, flag: "🌍", label: code };
      const existing = byCurrency.get(code);
      if (!existing || availableMinor > existing.availableMinor) {
        byCurrency.set(code, {
          currency: code,
          accountId: acc.id,
          availableMinor,
          available: nuvion.fromNuvionMinor(availableMinor),
          pendingMinor,
          pending: nuvion.fromNuvionMinor(pendingMinor),
          symbol: meta.symbol,
          flag: meta.flag,
          name: meta.label || code,
        });
      }
    }

    const balances = [...byCurrency.values()]
      .filter((b) => b.availableMinor > 0 || b.pendingMinor > 0)
      .sort((a, b) => {
        if (a.currency === "NGN") return -1;
        if (b.currency === "NGN") return 1;
        return b.availableMinor - a.availableMinor;
      });

    _fiatBalanceCache.set(cacheKey, { fetchedAt: Date.now(), balances });
    return balances;
  } catch (err) {
    console.warn(`[nuvion_orchestrator] getEntityFiatBalances(${telegramId}, ${accountType}) note:`, err.message);
    return [];
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatFiatAmount(currency, majorAmount) {
  const code = String(currency || "USD").toUpperCase();
  const sym = CURRENCY_META[code]?.symbol || `${code} `;
  const n = Number(majorAmount) || 0;
  if (code === "NGN") {
    return `₦${Math.round(n).toLocaleString("en-NG")}`;
  }
  return `${sym}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getBotTelegram(bot) {
  if (!bot) return null;
  if (bot.telegram && typeof bot.telegram.sendMessage === "function") return bot.telegram;
  if (bot.bot?.telegram && typeof bot.bot.telegram.sendMessage === "function") return bot.bot.telegram;
  return null;
}

function sanitizeInteracName(name) {
  // Per docs.nuvion.co/guides/accept-with-interac: letters A-Z, digits, spaces, hyphens, full stops, apostrophes only
  return String(name || "Customer")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9\s\-'.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Customer";
}

function sanitizeInteracNarration(narration, fallbackRef) {
  // Per docs: 5 to 200 chars of letters, digits, spaces and # . , ' @ $
  let clean = String(narration || `Payment ${fallbackRef}`)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9\s#.,'@$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length < 5) clean = `Payment ${fallbackRef}`.slice(0, 60);
  return clean.slice(0, 200);
}

// ── 1. Provision Named Global Receiving Account Details ───────────────────────

/**
 * Idempotently ensure an approved Tier-1 entity has a Nuvion checking account
 * and permanent named banking coordinates for `currency` (USD, GBP, EUR, NGN, AED, KES, GHS, TZS, MXN).
 */
async function provisionGlobalReceivingAccount(telegramId, accountType = "personal", currency = "USD") {
  const code = String(currency || "").toUpperCase();
  if (!nuvion.SUPPORTED_FIAT_RECEIVING_CURRENCIES.includes(code)) {
    throw new Error(`Currency ${code} does not support direct bank account details.`);
  }

  const entity = db.getNuvionEntityByUser(telegramId, accountType);
  if (!entity || String(entity.status).toLowerCase() !== "approved") {
    throw new Error("Tier-1 verification must be approved before creating global bank accounts.");
  }
  const entityId = entity.entity_id;

  // 1. Check cached details first (account details are permanent!)
  const existingDetails = db.getNuvionAccountDetailsByEntity(entityId, code).filter((d) => d.asset_type === "fiat");
  if (existingDetails.length > 0) {
    // Prefer a detail that is already active and has a number; rows are newest-first, so a newer
    // pending row must not hide an older active one.
    const usable = existingDetails.find((d) => nuvion.isAccountDetailReady(d));
    if (usable) {
      return { entity, detail: usable, isPending: false, cached: true };
    }
    const first = existingDetails[0];
    const deadResult = (detail) => ({
      entity, detail, isPending: false, isInactive: true,
      statusReason: nuvion.getAccountDetailStatusReason(detail), cached: false,
    });
    // If still pending locally, refresh live from Nuvion once
    try {
      const live = await nuvion.getAccountDetails(first.detail_id, entityId);
      if (!live || typeof live !== "object" || !(live.id || live.account_number || live.iban || live.status)) {
        console.warn(`[nuvion_orchestrator] Account detail ${first.detail_id} refresh returned no usable fields.`);
        return { entity, detail: first, isPending: !nuvion.isAccountDetailReady(first), cached: true };
      }
      const updated = saveDetailFromApi({ ...live, id: live.id || first.detail_id }, entityId, first.account_id, code);
      console.log(
        `[nuvion_orchestrator] Account detail ${first.detail_id} refreshed: currency=${code} liveStatus=${live.status} ` +
        `hasNumber=${!!(live.account_number || live.iban)} reason=${nuvion.getAccountDetailStatusReason(live) || "none"}`
      );
      if (nuvion.isAccountDetailDead(live)) return deadResult({ ...updated, status_reason: live.status_reason });
      if (nuvion.isAccountDetailReady(updated)) {
        _dispatchGlobalAccountCreatedEmailOnce(entity, updated);
      }
      return { entity, detail: updated, isPending: !nuvion.isAccountDetailReady(updated), cached: false };
    } catch (err) {
      console.warn(`[nuvion_orchestrator] Account detail ${first.detail_id} refresh failed:`, err.message);
      return { entity, detail: first, isPending: !nuvion.isAccountDetailReady(first), cached: true };
    }
  }

  // 2. Find or create checking account in `code`
  let account = db.getNuvionAccountsByEntity(entityId, { currency: code, purpose: "receiving" })[0] || null;
  if (!account) {
    let remoteAcc = null;
    try {
      const listed = await nuvion.listAccounts({ entityId, currency: code, limit: 20 });
      const rows = listed?.data || [];
      remoteAcc = rows.find((a) => a.currency === code && a.type === "checking" && a.meta?.purpose !== "card") || null;
    } catch (_) { }

    if (!remoteAcc) {
      remoteAcc = await nuvion.createAccount({
        entityId,
        type: "checking",
        currency: code,
        displayName: `${entity.account_type === "business" ? "Business" : "Personal"} ${code} Receiving`,
        meta: { purpose: "receiving" },
      });
    }

    account = db.upsertNuvionAccount({
      entityId,
      accountId: remoteAcc.id,
      currency: code,
      accountType: remoteAcc.type || "checking",
      displayName: remoteAcc.display_name,
      nuvionBan: remoteAcc.nuvion_ban || null,
      purpose: "receiving",
      status: remoteAcc.status || "active",
    });
  }

  // 3. Find or create permanent account details on that account
  let remoteDetail = null;
  try {
    const listedDet = await nuvion.listAccountDetails({ accountId: account.account_id, entityId, limit: 100 });
    const rows = listedDet?.data || [];
    remoteDetail = rows[0] || null;
  } catch (_) { }

  if (!remoteDetail) {
    remoteDetail = await nuvion.createAccountDetails({
      accountId: account.account_id,
      entityId,
    });
  }

  const saved = saveDetailFromApi(remoteDetail, entityId, account.account_id, code);
  if (nuvion.isAccountDetailReady(saved)) {
    _dispatchGlobalAccountCreatedEmailOnce(entity, saved);
  }
  return {
    entity,
    account,
    detail: saved,
    isPending: !nuvion.isAccountDetailReady(saved),
    cached: false,
  };
}

/**
 * Close an unused / zero-balance international receiving account on Nuvion (`DELETE /accounts/{account_id}`)
 * so Nuvion stops charging monthly maintenance fees for it.
 * Safety guard: refuses deletion if the account still holds any positive balance (`available > 0 || current > 0`).
 */
async function closeGlobalReceivingAccount(telegramId, accountType = "personal", currency, { allowNgn = false, reason = "user_requested" } = {}) {
  const code = String(currency || "").trim().toUpperCase();
  if (!code) throw new Error("Currency is required to close an account.");
  if (code === "NGN" && !allowNgn) {
    throw new Error("Your primary NGN account cannot be closed here.");
  }

  const entity = db.getNuvionEntityByUser(telegramId, accountType);
  if (!entity) {
    throw new Error("No verified account profile found.");
  }

  const activeAccts = db.getNuvionAccountsByEntity(entity.entity_id, { currency: code, purpose: "receiving" });
  const target = activeAccts[0] || null;
  if (!target) {
    throw new Error(`No active ${code} receiving account found.`);
  }

  // Live safety check on Nuvion: never delete an account that holds funds
  if (nuvion.isNuvionConfigured()) {
    try {
      const liveAcct = await nuvion.getAccount(target.account_id, entity.entity_id);
      const avail = Number(liveAcct?.balance?.available || 0);
      const curr = Number(liveAcct?.balance?.current || 0);
      if (avail > 0 || curr > 0) {
        const major = nuvion.fromNuvionMinor(Math.max(avail, curr));
        throw new Error(
          `Your ${code} account still has a balance of ${formatFiatAmount(code, major)}. Please withdraw or convert it before closing.`
        );
      }
    } catch (balErr) {
      if (/still has a balance/i.test(balErr.message)) throw balErr;
      // If Nuvion returns 404 (already deleted on Nuvion), still clean up local DB cleanly
      if (balErr?.status === 404) {
        db.markNuvionAccountClosed(target.account_id);
        invalidateEntityFiatBalanceCache(entity.entity_id);
        return { closed: true, accountId: target.account_id, currency: code, alreadyDeletedRemotely: true };
      }
      throw balErr;
    }

    try {
      await nuvion.deleteAccount(target.account_id, entity.entity_id);
    } catch (delErr) {
      if (delErr?.status !== 404) throw delErr;
    }
  }

  db.markNuvionAccountClosed(target.account_id);
  invalidateEntityFiatBalanceCache(entity.entity_id);
  console.log(`[nuvion_orchestrator] Closed ${code} account ${target.account_id} for TG:${telegramId} (${accountType}) reason=${reason}`);
  return {
    closed: true,
    accountId: target.account_id,
    currency: code,
    reason,
  };
}

function _dispatchGlobalAccountCreatedEmailOnce(entity, detail) {
  if (!entity || !detail || !detail.detail_id) return;
  try {
    const emailMod = require("./email");
    const to = emailMod.resolveUserEmail(entity.telegram_id, entity);
    if (!to) return;
    const claimed = idempotency.tryClaimWebhookEvent(`email_global_acct:${detail.detail_id}`, "email_global_acct", detail.detail_id);
    if (!claimed) return;
    emailMod.sendGlobalAccountCreatedEmail({
      to,
      name: entity.legal_name,
      currency: detail.currency,
      accountType: entity.account_type || "personal",
      detail,
    }).then((r) => {
      if (!r?.sent) console.warn(`[nuvion_orchestrator:acct_email] Not delivered to ${to}:`, r?.reason, r?.error || "");
    }).catch((e) => console.warn("[nuvion_orchestrator:acct_email]", e.message));
  } catch (_) { }
}

function saveDetailFromApi(raw, entityId, accountId, fallbackCurrency) {
  const issuerMeta = raw?.issuer?.meta || {};
  return db.upsertNuvionAccountDetail({
    accountId: raw?.account_id || accountId,
    detailId: raw?.id,
    entityId: raw?.entity_id || entityId,
    assetType: raw?.asset_type || "fiat",
    currency: raw?.currency || fallbackCurrency,
    chain: raw?.chain || null,
    accountNumber: raw?.account_number || null,
    iban: raw?.iban || null,
    routingNumber: raw?.routing_number || issuerMeta.routing_number || null,
    sortCode: issuerMeta.sort_code || (raw?.issuer?.scheme === "sort_code" ? raw?.issuer?.code : null),
    swiftCode: issuerMeta.swift_code || null,
    bankName: issuerMeta.bank_name || raw?.issuer?.name || null,
    beneficiaryName: raw?.beneficiary_name || null,
    status: raw?.status || "pending",
    rawMeta: raw,
  });
}

/**
 * Format clean, finance-first HTML block for named bank coordinates (used in Telegram & Invoices).
 */
function formatReceivingDetailsCard(detail, fallbackBeneficiary = "Proxim Account") {
  const meta = CURRENCY_META[detail.currency] || { flag: "🏦", label: detail.currency, railHint: "Bank Transfer" };
  const lines = [
    `${meta.flag} <b>${escapeHtml(meta.label)} Receiving Account</b>`,
    `──────────────────────────`,
    `• <b>Account Name:</b> ${escapeHtml(detail.beneficiary_name || fallbackBeneficiary)}`,
  ];
  const bankCode = detail.bank_code || internationalBanks.enrichReceivingBankCode(detail.currency, detail.bank_name);
  if (detail.bank_name) lines.push(`• <b>Bank:</b> ${escapeHtml(detail.bank_name)}`);
  if (bankCode) lines.push(`• <b>Bank Code:</b> <code>${escapeHtml(bankCode)}</code>`);
  if (detail.account_number) lines.push(`• <b>Account Number:</b> <code>${escapeHtml(detail.account_number)}</code>`);
  if (detail.routing_number) lines.push(`• <b>Routing Number:</b> <code>${escapeHtml(detail.routing_number)}</code>`);
  if (detail.sort_code) lines.push(`• <b>Sort Code:</b> <code>${escapeHtml(detail.sort_code)}</code>`);
  if (detail.iban) lines.push(`• <b>IBAN:</b> <code>${escapeHtml(detail.iban)}</code>`);
  if (detail.swift_code) lines.push(`• <b>SWIFT / BIC:</b> <code>${escapeHtml(detail.swift_code)}</code>`);
  lines.push(`• <b>Supported Rails:</b> ${escapeHtml(meta.railHint)}`);
  if (detail.currency === "CAD") {
    lines.push(`\n<i>Note: CAD bank coordinates accept SWIFT wires. For local Canadian payments, generate an Interac Request Link instead.</i>`);
  }
  lines.push(`\n<i>Any deposit received here settles directly into your main Proxim balance.</i>`);
  return lines.join("\n");
}

// ── 2. Hosted Payment Links (Open Banking, Interac CAD, Mobile Money) ─────────

async function createHostedPaymentLink({
  telegramId,
  accountType = "personal",
  currency,
  amountMajor,
  fundingType = "open-banking",
  payerName = null,
  payerEmail = null,
  msisdn = null,
  momoChannel = null,
  narration = null,
  invoiceId = null,
}) {
  const code = String(currency || "").toUpperCase();
  const amount = Number(amountMajor);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Payment amount must be greater than zero.");
  }

  const entity = db.getNuvionEntityByUser(telegramId, accountType);
  if (!entity || String(entity.status).toLowerCase() !== "approved") {
    throw new Error("Tier-1 verification must be approved before creating payment links.");
  }
  const entityId = entity.entity_id;

  // Corridor limit checks from docs.nuvion.co/guides/funding-session & accept-with-interac
  if (fundingType === "interac") {
    if (code !== "CAD") throw new Error("Interac payment requests require CAD currency.");
    if (amount < 1 || amount > 25000) throw new Error("Interac amount must be between CA$1.00 and CA$25,000.00.");
    if (!payerEmail || !payerName) throw new Error("Payer name and email are required for Interac requests.");
  } else if (fundingType === "momo") {
    if (code === "KES" && (amount < 20 || amount > 250000)) {
      throw new Error("Kenya M-Pesa amount must be between KSh 20 and KSh 250,000.");
    }
    if (code === "TZS" && (amount < 1000 || amount > 5000000)) {
      throw new Error("Tanzania Mobile Money amount must be between TSh 1,000 and TSh 5,000,000.");
    }
    if (!msisdn || !momoChannel) throw new Error("Mobile phone number (msisdn) and mobile money channel are required.");
  } else if (fundingType === "open-banking") {
    if (code !== "GBP" && code !== "EUR") {
      throw new Error("Open Banking payment links support GBP and EUR.");
    }
  }

  // Ensure an account in `code` exists on the child entity
  let account = db.getNuvionAccountsByEntity(entityId, { currency: code, purpose: "receiving" })[0] || null;
  if (!account) {
    let remoteAcc = null;
    try {
      const listed = await nuvion.listAccounts({ entityId, currency: code, limit: 20 });
      remoteAcc = (listed?.data || []).find((a) => a.currency === code && a.type === "checking") || null;
    } catch (_) { }
    if (!remoteAcc) {
      remoteAcc = await nuvion.createAccount({
        entityId,
        type: "checking",
        currency: code,
        displayName: `${accountType === "business" ? "Business" : "Personal"} ${code} Account`,
        meta: { purpose: "receiving" },
      });
    }
    account = db.upsertNuvionAccount({
      entityId,
      accountId: remoteAcc.id,
      currency: code,
      accountType: remoteAcc.type || "checking",
      displayName: remoteAcc.display_name,
      nuvionBan: remoteAcc.nuvion_ban || null,
      purpose: "receiving",
      status: remoteAcc.status || "active",
    });
  }

  const refSuffix = crypto.randomBytes(4).toString("hex");
  const uniqueReference = `prx-fs-${Date.now()}-${refSuffix}`;
  const amountMinor = nuvion.toNuvionMinor(amount);
  const redirectUrl = `${apiRoutes.getPublicBaseUrl()}/health`;

  const reqOpts = {
    entityId,
    accountId: account.account_id,
    amountMinor,
    currency: code,
    uniqueReference,
    narration: fundingType === "interac"
      ? sanitizeInteracNarration(narration, refSuffix)
      : (narration || `Proxim ${code} payment`),
  };

  if (fundingType === "open-banking") {
    reqOpts.countryCode = code === "GBP" ? "GB" : "DE";
    reqOpts.redirectUrl = redirectUrl;
  } else if (fundingType === "interac") {
    reqOpts.fundingType = "interac";
    reqOpts.meta = {
      name: sanitizeInteracName(payerName),
      email: String(payerEmail).trim().toLowerCase(),
    };
  } else if (fundingType === "momo") {
    reqOpts.fundingType = "momo";
    reqOpts.meta = {
      msisdn: String(msisdn).replace(/\D/g, ""),
      channel: momoChannel,
    };
  }

  const session = await nuvion.createFundingSession(reqOpts);
  const job = db.createNuvionJob({
    entityId,
    telegramId,
    accountType,
    jobType: fundingType === "interac" ? "interac_funding" : "funding_session",
    state: session.status || "awaiting_user",
    currency: code,
    amountMinor,
    uniqueReference,
    sessionId: session.id,
    payload: {
      fundingType,
      invoiceId: invoiceId || null,
      checkoutUrl: session.checkout_url || null,
      referenceNumber: session.reference_number || null,
      payerName: payerName || null,
      payerEmail: payerEmail || null,
      msisdn: msisdn || null,
      momoChannel: momoChannel || null,
      narration: reqOpts.narration,
    },
  });

  return { session, job };
}

// ── 3. Parent Operational Account & 1% FX Margin Book-Transfer Helper ─────────

/**
 * Ensure Proxim's root parent entity has an operational/checking account in `currency`,
 * and ensure the child entity has a reusable `book-transfer` payment detail pointing
 * to that parent account's `nuvion_ban` for zero-fee instant 1% FX margin collection.
 */
async function ensureChildToParentMarginTarget(entityId, currency) {
  const code = String(currency).toUpperCase();
  const cpLabel = `__proxim_parent_margin_${code}__`;

  // 1. Check cached child counterparty/payment detail first
  const cached = db.getNuvionCounterpartiesByEntity(entityId, code).find((c) => c.label === cpLabel);
  if (cached) {
    return { counterpartyId: cached.counterparty_id, paymentDetailId: cached.payment_detail_id };
  }

  // 2. Find or create root parent operational account in `code`
  let parentAcc = _parentOpAccounts.get(code) || null;
  if (!parentAcc) {
    try {
      const listed = await nuvion.listAccounts({ currency: code, limit: 25 });
      const rows = listed?.data || [];
      parentAcc = rows.find((a) => a.currency === code && a.nuvion_ban && (a.type === "operational" || a.type === "checking")) || null;
    } catch (_) { }

    if (!parentAcc) {
      try {
        parentAcc = await nuvion.createAccount({
          type: "operational",
          currency: code,
          displayName: `Proxim FX Margin (${code})`,
          meta: { purpose: "fx_margin" },
        });
      } catch (_) {
        // Fallback to checking account if operational type unavailable
        parentAcc = await nuvion.createAccount({
          type: "checking",
          currency: code,
          displayName: `Proxim FX Margin (${code})`,
          meta: { purpose: "fx_margin" },
        });
      }
    }
    if (parentAcc?.nuvion_ban) {
      _parentOpAccounts.set(code, parentAcc);
    }
  }

  if (!parentAcc?.nuvion_ban) return null;

  // 3. Create child counterparty + book-transfer payment detail targeting parent's nuvion_ban
  const cp = await nuvion.createCounterparty({
    entityId,
    type: "business",
    nickname: `Proxim Platform (${code})`,
    profile: {
      legal_name: "Proxim Platform",
      relationship: "platform",
      email: `treasury+${code.toLowerCase()}@proxim.app`,
      registered_address: {
        line1: "1 Proxim Way",
        city: "Lagos",
        postal_code: "100001",
        country: "NG",
      },
    },
  });

  const pd = await nuvion.createPaymentDetail({
    entityId,
    counterparty_id: cp.id,
    payment_method: "book-transfer",
    currency: code,
    account_holder_name: "Proxim Platform",
    account_number: parentAcc.nuvion_ban,
  });

  db.saveNuvionCounterparty({
    entityId,
    counterpartyId: cp.id,
    paymentDetailId: pd.id,
    label: cpLabel,
    currency: code,
    scheme: "nuvion_direct",
    paymentMethod: "book-transfer",
    accountHolderName: "Proxim Platform",
    summary: { nuvion_ban: parentAcc.nuvion_ban, isPlatformMargin: true },
  });

  return { counterpartyId: cp.id, paymentDetailId: pd.id };
}

// ── 4. Inbound Fiat Auto-Sweep Engine (Zero Idle Custody in Nuvion) ───────────

/**
 * Resolve sender / originator bank details from a Nuvion inflow object (`confirmed`).
 * Checks top-level fields, nested sender/originator/source/debtor/meta objects, and
 * falls back to local/live counterparty lookup when `confirmed.counterparty_id` is present.
 */
async function resolveNuvionInflowSender(confirmed, entityId = null) {
  const statement = require("./statement");
  const base = statement.extractInboundSenderDetails(confirmed);
  let { name, bank, account } = base;

  // If Nuvion attached a counterparty_id on the inflow, check local cache or GET /counterparties/:id
  if ((!name || !bank || !account) && confirmed?.counterparty_id) {
    try {
      if (entityId && typeof db.getNuvionCounterpartiesByEntity === "function") {
        const localCp = db.getNuvionCounterpartiesByEntity(entityId).find(
          (c) => String(c.counterparty_id) === String(confirmed.counterparty_id)
        );
        if (localCp) {
          if (!name && localCp.account_holder_name) name = localCp.account_holder_name;
          try {
            const s = localCp.summary_json ? JSON.parse(localCp.summary_json) : {};
            if (!bank && (s.bank_name || s.bankName)) bank = s.bank_name || s.bankName;
            if (!account && (s.account_number || s.iban || s.wallet_address)) {
              account = s.account_number || s.iban || s.wallet_address;
            }
          } catch (_) { }
        }
      }
      if ((!name || !bank || !account) && typeof nuvion.getCounterparty === "function") {
        const remoteCp = await nuvion.getCounterparty(confirmed.counterparty_id, entityId).catch(() => null);
        if (remoteCp) {
          const fromCp = statement.extractInboundSenderDetails(remoteCp);
          if (!name && fromCp.name) name = fromCp.name;
          if (!bank && fromCp.bank) bank = fromCp.bank;
          if (!account && fromCp.account) account = fromCp.account;
        }
      }
    } catch (_) { }
  }

  return { name: name || null, bank: bank || null, account: account || null };
}

/**
 * Hold a verified user's settled inbound fiat deposit in its local currency checking account
 * (0% Proxim inbound fee, no auto-conversion to USDC).
 * Fraud-screens the inflow, records it in SQLite, settles linked invoices/merchant checkouts,
 * and delivers an instant local-currency confirmation + HD Receipt PNG.
 */
async function handleInboundFiatDeposit({ confirmed, entityRecord, bot = null }) {
  if (!confirmed || !confirmed.id || !entityRecord) {
    return { held: false, swept: false, reason: "missing_context" };
  }

  const currency = String(confirmed.currency || "").toUpperCase();
  const status = String(confirmed.status || "").toLowerCase();
  const paymentType = String(confirmed.payment_type || "").toLowerCase();

  if (status !== "successful") return { held: false, swept: false, reason: `status_${status}` };
  if (STABLECOIN_CODES.has(currency)) return { held: false, swept: false, reason: "stablecoin_inflow_ignored" };
  if (paymentType === "book-transfer") return { held: false, swept: false, reason: "internal_book_transfer_ignored" };

  const grossMinor = Math.round(Number(confirmed.amount) || 0);
  const railFeeMinor = Math.round(Number(confirmed.applicable_fee) || 0);
  const netMinor = grossMinor - railFeeMinor;
  if (netMinor <= 0) return { held: false, swept: false, reason: "zero_net_amount" };

  const holdJobRef = `hold-in-${confirmed.id}`;
  const holdLockKey = `nuvion_in_hold:${confirmed.id}`;
  const existingRow = db.prepare("SELECT * FROM nuvion_jobs WHERE unique_reference = ?").get(holdJobRef);
  if (existingRow && (existingRow.state === "completed" || existingRow.state === "processing")) {
    return { held: true, swept: false, duplicate: true, jobId: existingRow.id };
  }

  const lock = idempotency.tryAcquireOperationLock(holdLockKey, {
    scope: "nuvion_inbound_hold",
    telegramId: entityRecord.telegram_id,
    accountType: entityRecord.account_type || "personal",
    amount: nuvion.fromNuvionMinor(netMinor),
    lockTtlSeconds: 120,
  });
  if (!lock.acquired) {
    return { held: false, swept: false, duplicate: true, reason: lock.reason };
  }

  let job = null;
  try {
    const lockedExisting = db.prepare("SELECT * FROM nuvion_jobs WHERE unique_reference = ?").get(holdJobRef);
    if (lockedExisting && (lockedExisting.state === "completed" || lockedExisting.state === "processing")) {
      idempotency.completeOperationIdempotency(holdLockKey, { txHash: lockedExisting.nuvion_transfer_id || holdJobRef });
      return { held: true, swept: false, duplicate: true, jobId: lockedExisting.id };
    }

    const entity = entityRecord;
    const entityId = entity.entity_id;
    const accountId = confirmed.account_id;
    const grossMajor = nuvion.fromNuvionMinor(grossMinor);
    const netFiatMajor = nuvion.fromNuvionMinor(netMinor);
    const senderInfo = await resolveNuvionInflowSender(confirmed, entityId);

    job = db.createNuvionJob({
      entityId,
      telegramId: entity.telegram_id,
      accountType: entity.account_type || "personal",
      jobType: "inbound_fiat_hold",
      state: "processing",
      currency,
      amountMinor: netMinor,
      marginMinor: 0,
      uniqueReference: holdJobRef,
      nuvionTransferId: confirmed.id,
      payload: {
        inflowId: confirmed.id,
        accountId,
        grossMinor,
        railFeeMinor,
        netMinor,
        narration: confirmed.narration || null,
        fundingSessionId: confirmed.meta?.funding_session_id || null,
        settlementMode: "local",
        senderName: senderInfo.name,
        senderBank: senderInfo.bank,
        senderAccount: senderInfo.account,
      },
    });

    const screenRes = await fraudGuard.screenInboundFiatInflow({
      entityRecord: entity,
      confirmed,
      netMajor: netFiatMajor,
      isPaymentLink: Boolean(confirmed.meta?.funding_session_id),
      bot,
    });
    if (screenRes.hold) {
      db.updateNuvionJob(job.id, {
        state: "held_fraud_review",
        error_message: screenRes.reason,
        payload_json: {
          ...(job.payload || {}),
          heldForReview: true,
          holdReason: screenRes.reason,
          estUsd: screenRes.estUsd,
        },
      });
      idempotency.completeOperationIdempotency(holdLockKey, { txHash: `held_${confirmed.id}` });
      return { held: true, swept: false, fraudHold: true, reason: screenRes.reason, jobId: job.id };
    }

    db.updateNuvionJob(job.id, {
      state: "completed",
      margin_minor: 0,
      nuvion_transfer_id: confirmed.id,
      payload_json: {
        ...(job.payload || {}),
        heldLocally: true,
        feeMinor: 0,
      },
    });
    invalidateEntityFiatBalanceCache(entityId);
    idempotency.completeOperationIdempotency(holdLockKey, { txHash: confirmed.id });

    // Auto-settle any matching Merchant Checkout Session
    try {
      const merchantCheckout = require("./merchant_checkout");
      await merchantCheckout.trySettleSessionByGlobalBank({
        merchantTelegramId: entity.telegram_id,
        accountType: entity.account_type || "business",
        currency,
        amountMajor: grossMajor,
        txHash: confirmed.id,
      });
    } catch (_) { }

    // Record ledger transaction with exact local source currency & 0% inbound fee
    try {
      const txType = currency === "NGN" ? "deposit_naira" : "deposit_fiat";
      const depositChannel = currency === "NGN" ? "naira" : "international";
      let estUsd = currency === "USD" ? netFiatMajor : (Number(screenRes?.estUsd) || 0);
      if (estUsd <= 0 && currency === "NGN") {
        estUsd = Number((netFiatMajor / 1500).toFixed(6));
      } else if (estUsd <= 0) {
        estUsd = netFiatMajor;
      }
      const amountMicro = walletLib.parseToMicro(estUsd.toFixed(6));
      db.recordTransaction(
        entity.telegram_id,
        txType,
        String(amountMicro),
        "confirmed",
        confirmed.id,
        entity.account_type || "personal",
        18,
        "local_fiat",
        confirmed.narration || `${currency} deposit (held in ${currency})`,
        {
          sourceCurrency: currency,
          sourceAmount: Number.isFinite(netFiatMajor) && netFiatMajor > 0 ? netFiatMajor : null,
          depositChannel,
          counterpartyName: senderInfo.name,
          counterpartyBank: senderInfo.bank,
          counterpartyAccount: senderInfo.account,
        }
      );
    } catch (txErr) {
      console.warn("[nuvion_orchestrator] hold recordTransaction note:", txErr.message);
    }

    // Auto-mark any linked invoice paid
    let paidInvoiceNumber = null;
    try {
      const fsId = confirmed.meta?.funding_session_id;
      let invId = null;
      if (fsId) {
        const fsJob = db.prepare("SELECT * FROM nuvion_jobs WHERE session_id = ?").get(String(fsId));
        if (fsJob) {
          const fsPayload = fsJob.payload_json ? JSON.parse(fsJob.payload_json) : {};
          invId = fsPayload.invoiceId || null;
          db.updateNuvionJob(fsJob.id, { state: "settled" });
        }
      }
      if (invId) {
        const inv = invoiceDb.getInvoice(Number(invId));
        if (inv && inv.status !== "paid") {
          invoiceDb.markInvoicePaidWithTxHash(inv.id, confirmed.id);
          paidInvoiceNumber = inv.invoice_number;
        }
      } else if (confirmed.narration) {
        const m = String(confirmed.narration).match(/\b(INV-[A-Z0-9-]+)\b/i);
        if (m) {
          const inv = invoiceDb.getInvoiceByNumber(m[1].toUpperCase());
          if (inv && Number(inv.telegram_id || inv.owner_telegram_id) === Number(entity.telegram_id) && inv.status !== "paid") {
            invoiceDb.markInvoicePaidWithTxHash(inv.id, confirmed.id);
            paidInvoiceNumber = inv.invoice_number;
          }
        }
      }
    } catch (_) { }

    const fiatStr = formatFiatAmount(currency, netFiatMajor);
    const acctLabel = entity.account_type === "business" ? "Business Account" : "Personal Account";
    const senderDisplayLine = [senderInfo.name, [senderInfo.bank, senderInfo.account].filter(Boolean).join(" · ")].filter(Boolean).join(" — ");
    const captionLines = [
      `🎉 <b>${currency} Deposit Received!</b>`,
      `──────────────────────────`,
      `💵 <b>Amount Credited:</b> ${fiatStr}`,
      `🏷️ <b>Deposit Fee:</b> 0% (Held in ${currency})`,
      `💼 <b>Account:</b> ${acctLabel}`,
    ];
    if (senderDisplayLine) {
      captionLines.push(`👤 <b>From:</b> ${escapeHtml(senderDisplayLine)}`);
    }
    if (paidInvoiceNumber) {
      captionLines.push(`🧾 <b>Invoice Paid:</b> <code>${escapeHtml(paidInvoiceNumber)}</code>`);
    }
    if (confirmed.narration) {
      captionLines.push(`💬 <b>Note:</b> <i>${escapeHtml(confirmed.narration)}</i>`);
    }
    captionLines.push(`🔖 <b>Reference:</b> <code>${escapeHtml(confirmed.id)}</code>`);
    captionLines.push(`──────────────────────────\n<i>Held safely in your ${currency} balance with zero conversion fees.</i>`);
    const caption = captionLines.join("\n");

    const telegram = getBotTelegram(bot);
    if (telegram && entity.telegram_id && Number(entity.telegram_id) > 0) {
      let receiptPath = null;
      try {
        receiptPath = await generateReceiptPNG({
          receiptId: `DEP-${String(confirmed.id).slice(-10)}`,
          senderName: senderInfo.name || (currency === "NGN" ? "Nigerian Bank Transfer" : `${currency} Bank Transfer`),
          senderBank: senderInfo.bank || "",
          senderAddress: senderInfo.account || "",
          recipientName: entity.legal_name || acctLabel,
          amountUsdc: currency === "USD" ? netFiatMajor : 0,
          displayCurrency: currency,
          fiatAmountDisplay: fiatStr,
          type: "Deposit",
          timestamp: new Date().toISOString(),
          status: "Confirmed",
          txHash: confirmed.id,
          narration: confirmed.narration || `Held in ${currency} · 0% deposit fee`,
        });
      } catch (_) { }
      try {
        if (receiptPath && fs.existsSync(receiptPath) && typeof telegram.sendPhoto === "function") {
          await telegram.sendPhoto(entity.telegram_id, { source: receiptPath }, { caption, parse_mode: "HTML" });
          fs.unlink(receiptPath, () => { });
        } else {
          await telegram.sendMessage(entity.telegram_id, caption, { parse_mode: "HTML" });
        }
      } catch (_) {
        await telegram.sendMessage(entity.telegram_id, caption, { parse_mode: "HTML" }).catch(() => { });
      }
    }
    if (entity.telegram_id) {
      try {
        await require("./notify").notify(entity.telegram_id, {
          title: `${fiatStr} received`,
          html: caption,
          data: { type: "deposit_fiat", currency, amount: netFiatMajor },
        });
      } catch (_) { }
      // Auto-recover any past-due international account maintenance fees directly into Proxim's Master account
      try {
        const mfw = require("./monthly_fee_worker");
        if (typeof mfw.recoverPastDueGlobalAccountFeesForUser === "function") {
          mfw.recoverPastDueGlobalAccountFeesForUser(entity.telegram_id).catch(() => { });
        }
      } catch (_) { }
    }

    return {
      held: true,
      swept: false,
      jobId: job.id,
      currency,
      grossMajor,
      netMajor: netFiatMajor,
      feeMinor: 0,
      paidInvoiceNumber,
    };
  } catch (err) {
    idempotency.failOperationIdempotency(holdLockKey, err.message);
    if (job) {
      db.updateNuvionJob(job.id, { state: "failed", error_message: err.message });
    }
    throw err;
  }
}

/**
 * Triggered by Auto-Save when a verified user has turned Auto-Save ON and their idle
 * period is due: converts eligible held local-currency balances on Nuvion -> USC (0%
 * Proxim spread; live FX rates apply) and releases them through the Base crypto bridge
 * route into the user's self-custodial wallet so Auto-Earn can allocate them into USD savings.
 */
async function releaseHeldFiatForAutoSave({ user, accountType = "personal", bot = null, minUsdEquivalent = 5.0 }) {
  if (!user || !user.telegram_id || !nuvion.isNuvionConfigured()) {
    return { released: false, reason: "not_configured", releases: [] };
  }
  let entity = db.getNuvionEntityByUser(user.telegram_id, accountType);
  if (!entity || String(entity.status || "").toLowerCase() !== "approved") {
    return { released: false, reason: "no_approved_entity", releases: [] };
  }

  // Throttle duplicate auto-save release triggers per entity to once every 30 minutes
  try {
    const recent = db.prepare(`
      SELECT id FROM nuvion_jobs
      WHERE entity_id = ? AND job_type = 'autosave_fiat_release'
        AND state IN ('processing', 'completed')
        AND datetime(created_at) >= datetime('now', '-30 minutes')
      LIMIT 1
    `).get(entity.entity_id);
    if (recent) {
      return { released: false, reason: "recent_release_in_progress", releases: [] };
    }
  } catch (_) { }

  const heldBalances = await getEntityFiatBalances(user.telegram_id, accountType, { forceRefresh: true });
  const nonZero = heldBalances.filter((b) => b.availableMinor > 0 && b.accountId);
  if (nonZero.length === 0) {
    return { released: false, reason: "no_held_fiat", releases: [] };
  }

  if (!entity.self_counterparty_id || !entity.self_base_payment_detail_id) {
    entity = await nuvionWebhooks.bootstrapApprovedEntity(entity);
  }
  if (!entity?.self_counterparty_id || !entity?.self_base_payment_detail_id) {
    return { released: false, reason: "missing_bridge_wallet", releases: [] };
  }

  const releases = [];
  for (const pocket of nonZero) {
    try {
      const quote = await nuvion.createFxQuote({
        entityId: entity.entity_id,
        fromCurrency: pocket.currency,
        toCurrency: "USC",
        amountFrom: pocket.availableMinor,
        accountId: pocket.accountId,
      });
      const quotedUscMinor = Math.round(Number(quote?.amount_to || 0));
      const quotedUsd = nuvion.fromNuvionMinor(quotedUscMinor);
      if (quotedUsd < Number(minUsdEquivalent || 5.0) || quotedUscMinor < 100) {
        continue;
      }

      const uniqueReference = `autosave-rel-${entity.entity_id.slice(-8)}-${pocket.currency}-${Date.now()}`;
      const job = db.createNuvionJob({
        entityId: entity.entity_id,
        telegramId: user.telegram_id,
        accountType,
        jobType: "autosave_fiat_release",
        state: "processing",
        currency: pocket.currency,
        amountMinor: pocket.availableMinor,
        marginMinor: 0,
        uniqueReference,
        fxQuoteId: quote.id,
        payload: {
          accountId: pocket.accountId,
          sourceCurrency: pocket.currency,
          sourceAmountMinor: pocket.availableMinor,
          quotedUscMinor,
          quotedUsd,
          rate: quote.rate || null,
        },
      });

      const outflow = await nuvion.createTransfer({
        entityId: entity.entity_id,
        accountId: pocket.accountId,
        counterpartyId: entity.self_counterparty_id,
        paymentDetailId: entity.self_base_payment_detail_id,
        amountMinor: pocket.availableMinor,
        currency: pocket.currency,
        narration: `Proxim Auto-Save conversion ${pocket.currency} to USD`,
        paymentType: "stablecoin-transfer",
        fxQuoteId: quote.id,
        uniqueReference,
      });

      db.updateNuvionJob(job.id, {
        state: "completed",
        nuvion_transfer_id: outflow.id,
        payload_json: {
          ...(job.payload || {}),
          outflowId: outflow.id,
        },
      });
      invalidateEntityFiatBalanceCache(entity.entity_id);

      const fiatDisplay = formatFiatAmount(pocket.currency, pocket.available);
      releases.push({
        currency: pocket.currency,
        amountMajor: pocket.available,
        quotedUsd,
        outflowId: outflow.id,
        jobId: job.id,
      });

      try {
        await require("./notify").notify(user.telegram_id, {
          title: "Auto-Save: converting idle balance to USD",
          html:
            `🌱 <b>Auto-Save Triggered (${fiatDisplay} → ~$${quotedUsd.toFixed(2)} USD)</b>\n` +
            `Your idle ${pocket.currency} balance was converted at the live FX rate (0% conversion fee) and is moving into your USD Dollar Savings vault.`,
          data: { type: "autosave_fiat_release", currency: pocket.currency, quotedUsd },
        });
      } catch (_) { }
    } catch (err) {
      console.warn(`[nuvion_orchestrator] Auto-Save release failed for ${pocket.currency} (user ${user.telegram_id}):`, err.message);
    }
  }

  if (releases.length > 0 && process.env.NODE_ENV !== "test") {
    try {
      const evmSweeper = require("./evm_deposit_sweeper");
      if (typeof evmSweeper?.sweepUserDeposits === "function") {
        setTimeout(() => {
          evmSweeper.sweepUserDeposits(user.telegram_id, bot, {
            silent: true,
            onlyChain: "BASE",
            onlyAccountType: accountType || "personal",
          }).catch(() => { });
        }, 12_000).unref?.();
      }
    } catch (_) { }
  }

  return {
    released: releases.length > 0,
    count: releases.length,
    releases,
  };
}

/**
 * Automatically sweeps any settled inbound fiat deposit on a child entity:
 * 1. Optionally collects FX margin via free instant book-transfer (Child -> Proxim Parent)
 *    when `collectMargin !== false` (default for legacy/direct sweep calls; set to `false`
 *    when a user chooses auto-settle to USDC so inbound deposits remain 0% Proxim fee).
 * 2. Quotes FIAT -> USC and fires `stablecoin-transfer` on BASE_MAINNET straight to user's 0x wallet
 * 3. Records transaction, settles linked invoices, sends HD Receipt PNG, and kicks off Base Gateway/Arc sweep
 */
async function handleInboundFiatSweep({ confirmed, entityRecord, bot = null, collectMargin = null }) {
  if (!confirmed || !confirmed.id || !entityRecord) {
    return { swept: false, reason: "missing_context" };
  }

  const currency = String(confirmed.currency || "").toUpperCase();
  const status = String(confirmed.status || "").toLowerCase();
  const paymentType = String(confirmed.payment_type || "").toLowerCase();

  // Only sweep settled FIAT inflows (never sweep USC/UST bridge inflows or internal book-transfers)
  if (status !== "successful") return { swept: false, reason: `status_${status}` };
  if (STABLECOIN_CODES.has(currency)) return { swept: false, reason: "stablecoin_inflow_ignored" };
  if (paymentType === "book-transfer") return { swept: false, reason: "internal_book_transfer_ignored" };

  const grossMinor = Math.round(Number(confirmed.amount) || 0);
  const railFeeMinor = Math.round(Number(confirmed.applicable_fee) || 0);
  const netMinor = grossMinor - railFeeMinor;
  if (netMinor <= 0) return { swept: false, reason: "zero_net_amount" };

  const sweepJobRef = `sweep-in-${confirmed.id}`;
  const sweepLockKey = `nuvion_in_sweep:${confirmed.id}`;
  const existingRow = db.prepare("SELECT * FROM nuvion_jobs WHERE unique_reference = ?").get(sweepJobRef);
  if (existingRow && (existingRow.state === "completed" || existingRow.state === "processing")) {
    return { swept: false, duplicate: true, jobId: existingRow.id };
  }

  // Atomic SQLite mutex: guarantees webhook & poller can NEVER race on the same inflow!
  const lock = idempotency.tryAcquireOperationLock(sweepLockKey, {
    scope: "nuvion_inbound_sweep",
    telegramId: entityRecord.telegram_id,
    accountType: entityRecord.account_type || "personal",
    amount: nuvion.fromNuvionMinor(netMinor),
    lockTtlSeconds: 120,
  });
  if (!lock.acquired) {
    return { swept: false, duplicate: true, reason: lock.reason };
  }

  let job = null;
  try {
    // Re-read inside lock and atomically claim retry_pending -> processing
    const lockedExisting = db.prepare("SELECT * FROM nuvion_jobs WHERE unique_reference = ?").get(sweepJobRef);
    if (lockedExisting) {
      if (lockedExisting.state === "completed" || lockedExisting.state === "processing") {
        idempotency.completeOperationIdempotency(sweepLockKey, { txHash: lockedExisting.nuvion_transfer_id || sweepJobRef });
        return { swept: false, duplicate: true, jobId: lockedExisting.id };
      }
      const claimed = db.db
        .prepare("UPDATE nuvion_jobs SET state = 'processing', updated_at = datetime('now') WHERE id = ? AND state = 'retry_pending'")
        .run(lockedExisting.id);
      if (!claimed || claimed.changes === 0) {
        idempotency.failOperationIdempotency(sweepLockKey, "Could not claim retry_pending job");
        return { swept: false, duplicate: true, jobId: lockedExisting.id };
      }
      job = db.getNuvionJobById(lockedExisting.id);
    }

    let entity = entityRecord;
    const entityId = entity.entity_id;
    const accountId = confirmed.account_id;
    const marginBps = collectMargin === false ? 0 : nuvion.getFxMarginBps("inbound");
    const targetMarginMinor = marginBps > 0 ? nuvion.calcMarginMinor(netMinor, marginBps) : 0;

    if (!job) {
      job = db.createNuvionJob({
        entityId,
        telegramId: entity.telegram_id,
        accountType: entity.account_type || "personal",
        jobType: "inbound_fiat_sweep",
        state: "processing",
        currency,
        amountMinor: netMinor,
        marginMinor: targetMarginMinor,
        uniqueReference: sweepJobRef,
        nuvionTransferId: confirmed.id,
        payload: {
          inflowId: confirmed.id,
          accountId,
          grossMinor,
          railFeeMinor,
          narration: confirmed.narration || null,
          fundingSessionId: confirmed.meta?.funding_session_id || null,
          marginCollected: false,
          collectedMarginMinor: 0,
        },
      });
    }

    const senderInfo = await resolveNuvionInflowSender(confirmed, entityId);
    const jobPayload = {
      ...(job.payload || {}),
      senderName: (job.payload && job.payload.senderName) || senderInfo.name,
      senderBank: (job.payload && job.payload.senderBank) || senderInfo.bank,
      senderAccount: (job.payload && job.payload.senderAccount) || senderInfo.account,
    };

    // Step 0: Chargeback & Reversal Arbitrage Screener (Finding 3)
    // Screens hosted payment links (Interac e-Transfer, Open Banking, MoMo) and frozen accounts
    // BEFORE bootstrapping or sweeping funds out of Nuvion to irreversible Base USDC!
    const screenRes = await fraudGuard.screenInboundFiatInflow({
      entityRecord: entity,
      confirmed,
      netMajor: nuvion.fromNuvionMinor(netMinor),
      isPaymentLink: Boolean(jobPayload.fundingSessionId),
      bot,
    });
    if (screenRes.hold) {
      db.updateNuvionJob(job.id, {
        state: "held_fraud_review",
        error_message: screenRes.reason,
        payload_json: {
          ...jobPayload,
          heldForReview: true,
          holdReason: screenRes.reason,
          estUsd: screenRes.estUsd,
        },
      });
      idempotency.completeOperationIdempotency(sweepLockKey, { txHash: `held_${confirmed.id}` });

      const telegramHold = getBotTelegram(bot);
      if (telegramHold && entity.telegram_id) {
        const grossStrHold = formatFiatAmount(currency, nuvion.fromNuvionMinor(grossMinor));
        await telegramHold.sendMessage(
          entity.telegram_id,
          `🛡️ <b>Deposit Under Security Review (${grossStrHold})</b>\n` +
          `──────────────────────────\n` +
          `• <b>Amount Received:</b> ${grossStrHold}\n` +
          `• <b>Reference:</b> <code>${escapeHtml(confirmed.id)}</code>\n\n` +
          `<i>To protect your account against payment reversals, this inflow is currently held safely in your ${escapeHtml(currency)} account for standard compliance verification and will settle into your balance once cleared.</i>`,
          { parse_mode: "HTML" }
        ).catch(() => { });
      }

      return {
        swept: false,
        held: true,
        reason: screenRes.reason,
        jobId: job.id,
        estUsd: screenRes.estUsd,
      };
    }

    // Ensure entity has its Base self-counterparty bootstrapped
    if (!entity.self_counterparty_id || !entity.self_base_payment_detail_id) {
      entity = await nuvionWebhooks.bootstrapApprovedEntity(entity);
    }
    if (!entity.self_counterparty_id || !entity.self_base_payment_detail_id) {
      throw new Error(`Entity ${entity.entity_id} is missing Base self-counterparty wallet details`);
    }

    // Step 1: Collect 1% FX Margin via free instant book-transfer (Child -> Parent)
    // Persisted immediately into payload_json so retries NEVER double-charge 1% margin!
    let collectedMarginMinor = jobPayload.marginCollected ? Math.round(Number(jobPayload.collectedMarginMinor || 0)) : 0;
    if (!jobPayload.marginCollected && targetMarginMinor >= 1) {
      try {
        const marginTarget = await ensureChildToParentMarginTarget(entityId, currency);
        if (marginTarget) {
          const marginRef = `margin-${confirmed.id}`;
          try {
            await nuvion.createTransfer({
              entityId,
              accountId,
              counterpartyId: marginTarget.counterpartyId,
              paymentDetailId: marginTarget.paymentDetailId,
              amountMinor: targetMarginMinor,
              currency,
              narration: `FX spread ${confirmed.id}`,
              paymentType: "book-transfer",
              uniqueReference: marginRef,
            });
            collectedMarginMinor = targetMarginMinor;
          } catch (mErr) {
            // If margin transfer already succeeded on an earlier attempt (409 duplicate unique_reference), count it once!
            if (mErr instanceof nuvion.NuvionError && mErr.status === 409 && mErr.type === "error_duplicate_resource") {
              collectedMarginMinor = targetMarginMinor;
            } else {
              throw mErr;
            }
          }
          jobPayload.marginCollected = true;
          jobPayload.collectedMarginMinor = collectedMarginMinor;
          db.updateNuvionJob(job.id, {
            margin_minor: collectedMarginMinor,
            payload_json: jobPayload,
          });
        }
      } catch (marginErr) {
        // If margin book-transfer fails (e.g. parent account unavailable), never strand user's deposit!
        console.warn(`[nuvion_orchestrator] Margin book-transfer skipped for ${confirmed.id}:`, marginErr.message);
      }
    }

    // Step 2: Convert remaining fiat (including any prior sub-$1.00 accumulated balance in this account!) -> USC
    // and fire straight to User's 0x wallet on BASE_MAINNET.
    const configuredFeeBuffer = Math.max(0, Math.round(Number(process.env.NUVION_STABLECOIN_OUTFLOW_FEE_MINOR || 0)));
    let singleInflowNetMinor = netMinor - collectedMarginMinor;
    let liveAvailableMinor = singleInflowNetMinor;
    try {
      const liveAcc = await nuvion.getAccount(accountId, entityId);
      const avail = Math.round(Number(liveAcc?.balance?.available || 0));
      if (avail > liveAvailableMinor) {
        liveAvailableMinor = avail;
      }
    } catch (_) { }

    let sweepMinor = liveAvailableMinor - configuredFeeBuffer;
    if (sweepMinor <= 0) {
      db.updateNuvionJob(job.id, { state: "failed", error_message: "Net amount too small after fee buffer" });
      idempotency.failOperationIdempotency(sweepLockKey, "amount_too_small");
      return { swept: false, reason: "amount_too_small" };
    }

    let quote = null;
    let outflow = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ref = attempt === 0 ? `sweep-base-${confirmed.id}` : `sweep-base-${confirmed.id}-r${attempt}`;
      try {
        quote = await nuvion.createFxQuote({
          entityId,
          fromCurrency: currency,
          toCurrency: "USC",
          amountFrom: sweepMinor,
          accountId,
        });

        // Nuvion's POST /transfers (`stablecoin-transfer` to BASE_MAINNET) enforces a strict minimum
        // destination amount of 100 minor units ($1.00 USC). If the converted amount is < $1.00 USC,
        // hold it in the user's fiat receiving account to accumulate with their next deposit and notify them!
        const quotedUscMinor = Math.round(Number(quote?.amount_to || 0));
        if (quotedUscMinor > 0 && quotedUscMinor < 100) {
          const grossMajorSub = nuvion.fromNuvionMinor(grossMinor);
          const accumMajorSub = nuvion.fromNuvionMinor(sweepMinor);
          const quotedUsdSub = nuvion.fromNuvionMinor(quotedUscMinor);
          db.updateNuvionJob(job.id, {
            state: "accumulating_min_sweep",
            margin_minor: collectedMarginMinor,
            fx_quote_id: quote.id,
            error_message: `Below $1.00 USC on-chain sweep minimum ($${quotedUsdSub.toFixed(2)} USC); accumulating in ${currency} account`,
            payload_json: {
              ...jobPayload,
              fxQuoteId: quote.id,
              sweepMinor,
              quotedUscMinor,
              collectedMarginMinor,
            },
          });
          idempotency.completeOperationIdempotency(sweepLockKey, { txHash: `accum_${confirmed.id}` });

          const telegramSub = getBotTelegram(bot);
          if (telegramSub && entity.telegram_id) {
            const isNgnSub = currency === "NGN";
            const acctLabelSub = entity.account_type === "business" ? "Business Account" : "Personal Account";
            const grossStr = formatFiatAmount(currency, grossMajorSub);
            const accumStr = formatFiatAmount(currency, accumMajorSub);
            await telegramSub.sendMessage(
              entity.telegram_id,
              `📥 <b>Deposit Received (${grossStr}) — Accumulating for Settlement</b>\n` +
              `──────────────────────────\n` +
              `• <b>Amount Received:</b> ${grossStr}\n` +
              `• <b>Available in ${currency} Account:</b> <b>${accumStr}</b>` +
              (isNgnSub ? `\n` : ` (~$${quotedUsdSub.toFixed(2)} USD)\n`) +
              `• <b>Account:</b> ${acctLabelSub}\n` +
              `• <b>Reference:</b> <code>${escapeHtml(confirmed.id)}</code>\n\n` +
              `ℹ️ <i>On-chain wallet settlement requires a minimum net balance of <b>$1.00 USD</b>` +
              (isNgnSub ? ` (approx. ₦1,550)` : ``) +
              `. Your <b>${accumStr}</b> is safely held in your ${currency} account and will automatically combine and sweep into your Proxim wallet on your next deposit!</i>`,
              { parse_mode: "HTML" }
            ).catch(() => { });
          }

          return {
            swept: false,
            accumulating: true,
            reason: "below_min_1_usd_sweep",
            jobId: job.id,
            currency,
            sweepMinor,
            quotedUscMinor,
            collectedMarginMinor,
          };
        }

        outflow = await nuvion.createTransfer({
          entityId,
          accountId,
          counterpartyId: entity.self_counterparty_id,
          paymentDetailId: entity.self_base_payment_detail_id,
          amountMinor: sweepMinor,
          currency,
          narration: `Proxim auto-settlement ${confirmed.id}`,
          paymentType: "stablecoin-transfer",
          fxQuoteId: quote.id,
          uniqueReference: ref,
        });
        break;
      } catch (err) {
        // Recover cleanly if this exact unique_reference already landed on Nuvion
        if (err instanceof nuvion.NuvionError && err.status === 409 && err.type === "error_duplicate_resource") {
          const recovered = await nuvion.recoverTransferByReference(ref, entityId).catch(() => null);
          if (recovered) {
            outflow = recovered;
            break;
          }
        }
        // Handle Nuvion applicable_fee on top of amount (400 error_transfer_insufficient_funds)
        if (attempt === 0 && err instanceof nuvion.NuvionError && err.type === "error_transfer_insufficient_funds") {
          const retryBuffer = Math.max(100, Math.ceil(sweepMinor * 0.015));
          if (sweepMinor - retryBuffer > 0) {
            console.warn(`[nuvion_orchestrator] Insufficient funds with fee on ${confirmed.id}; retrying with buffer ${retryBuffer}`);
            sweepMinor -= retryBuffer;
            continue;
          }
        }
        db.updateNuvionJob(job.id, {
          state: "retry_pending",
          retry_count: (job.retry_count || 0) + 1,
          error_message: err.message,
          payload_json: jobPayload,
        });
        throw err;
      }
    }

    const creditedUsd = nuvion.fromNuvionMinor(quote?.amount_to || outflow?.amount || sweepMinor);
    const grossMajor = nuvion.fromNuvionMinor(grossMinor);
    const netFiatMajor = nuvion.fromNuvionMinor(netMinor);

    db.updateNuvionJob(job.id, {
      state: "completed",
      margin_minor: collectedMarginMinor,
      fx_quote_id: quote?.id || null,
      nuvion_transfer_id: outflow.id,
      payload_json: {
        ...jobPayload,
        outflowId: outflow.id,
        fxQuoteId: quote?.id || null,
        sweepMinor,
        collectedMarginMinor,
        creditedUsd,
        rate: quote?.rate || null,
      },
    });
    idempotency.completeOperationIdempotency(sweepLockKey, { txHash: outflow.id });

    // Auto-settle any matching Merchant Checkout Session (Tier-1 Global Bank rail)
    try {
      const merchantCheckout = require("./merchant_checkout");
      await merchantCheckout.trySettleSessionByGlobalBank({
        merchantTelegramId: entity.telegram_id,
        accountType: entity.account_type || "business",
        currency,
        amountMajor: grossMajor,
        txHash: outflow.id || confirmed.id,
      });
    } catch (_) { }

    // Step 3: Record ledger transaction with exact fiat source currency & channel
    try {
      const txType = currency === "NGN" ? "deposit_naira" : "deposit_fiat";
      const depositChannel = currency === "NGN" ? "naira" : "international";
      const amountMicro = walletLib.parseToMicro(creditedUsd.toFixed(6));
      db.recordTransaction(
        entity.telegram_id,
        txType,
        String(amountMicro),
        "confirmed",
        outflow.id || confirmed.id,
        entity.account_type || "personal",
        18,
        "base",
        confirmed.narration || `${currency} deposit`,
        {
          sourceCurrency: currency,
          sourceAmount: Number.isFinite(grossMajor) && grossMajor > 0 ? grossMajor : null,
          depositChannel,
          counterpartyName: jobPayload.senderName || null,
          counterpartyBank: jobPayload.senderBank || null,
          counterpartyAccount: jobPayload.senderAccount || null,
        }
      );
    } catch (txErr) {
      console.warn("[nuvion_orchestrator] recordTransaction note:", txErr.message);
    }

    // Step 4: Auto-mark any linked invoice paid (via funding_session job OR INV-... narration match)
    let paidInvoiceNumber = null;
    try {
      const fsId = confirmed.meta?.funding_session_id;
      let invId = null;
      if (fsId) {
        const fsJob = db.prepare("SELECT * FROM nuvion_jobs WHERE session_id = ?").get(String(fsId));
        if (fsJob) {
          const fsPayload = fsJob.payload_json ? JSON.parse(fsJob.payload_json) : {};
          invId = fsPayload.invoiceId || null;
          db.updateNuvionJob(fsJob.id, { state: "settled" });
        }
      }
      if (invId) {
        const inv = invoiceDb.getInvoice(Number(invId));
        if (inv && inv.status !== "paid") {
          invoiceDb.markInvoicePaidWithTxHash(inv.id, outflow.id || confirmed.id);
          paidInvoiceNumber = inv.invoice_number;
        }
      } else if (confirmed.narration) {
        const m = String(confirmed.narration).match(/\b(INV-[A-Z0-9-]+)\b/i);
        if (m) {
          const inv = invoiceDb.getInvoiceByNumber(m[1].toUpperCase());
          if (inv && Number(inv.telegram_id || inv.owner_telegram_id) === Number(entity.telegram_id) && inv.status !== "paid") {
            invoiceDb.markInvoicePaidWithTxHash(inv.id, outflow.id || confirmed.id);
            paidInvoiceNumber = inv.invoice_number;
          }
        }
      }
    } catch (invErr) {
      console.warn("[nuvion_orchestrator] Invoice auto-match note:", invErr.message);
    }

    // Step 5: Send clean Telegram confirmation + HD Receipt PNG (Naira-only for NGN!)
    const telegram = getBotTelegram(bot);
    if (telegram && entity.telegram_id) {
      const isNgn = currency === "NGN";
      const acctLabel = entity.account_type === "business" ? "Business Account" : "Personal Account";
      const fiatStr = formatFiatAmount(currency, grossMajor);
      const senderDisplayLine = [jobPayload.senderName, [jobPayload.senderBank, jobPayload.senderAccount].filter(Boolean).join(" · ")].filter(Boolean).join(" — ");
      const captionLines = [
        `🎉 <b>Deposit Received!</b>`,
        `──────────────────────────`,
        `💵 <b>Amount Received:</b> ${fiatStr}`,
      ];
      if (!isNgn) {
        captionLines.push(`💰 <b>Credited to Balance:</b> $${creditedUsd.toFixed(2)}`);
      }
      captionLines.push(`💼 <b>Account:</b> ${acctLabel}`);
      if (senderDisplayLine) {
        captionLines.push(`👤 <b>From:</b> ${escapeHtml(senderDisplayLine)}`);
      }
      if (paidInvoiceNumber) {
        captionLines.push(`🧾 <b>Invoice Paid:</b> <code>${escapeHtml(paidInvoiceNumber)}</code>`);
      }
      if (confirmed.narration) {
        captionLines.push(`💬 <b>Note:</b> <i>${escapeHtml(confirmed.narration)}</i>`);
      }
      captionLines.push(`🔖 <b>Reference:</b> <code>${escapeHtml(confirmed.id)}</code>`);
      captionLines.push(`──────────────────────────\n<i>Settled directly into your main Proxim balance.</i>`);
      const caption = captionLines.join("\n");

      let receiptPath = null;
      try {
        receiptPath = await generateReceiptPNG({
          receiptId: `DEP-${String(confirmed.id).slice(-10)}`,
          senderName: jobPayload.senderName || (isNgn ? "Nigerian Bank Transfer" : `${currency} Bank Transfer`),
          senderBank: jobPayload.senderBank || "",
          senderAddress: jobPayload.senderAccount || "",
          recipientName: entity.legal_name || acctLabel,
          amountUsdc: creditedUsd,
          displayCurrency: isNgn ? "NGN" : currency,
          fiatAmountDisplay: isNgn ? formatFiatAmount("NGN", netFiatMajor) : `${fiatStr} ($${creditedUsd.toFixed(2)})`,
          type: "Deposit",
          timestamp: new Date().toISOString(),
          status: "Confirmed",
          txHash: outflow.id || confirmed.id,
          narration: confirmed.narration || null,
        });
      } catch (_) { }

      if (receiptPath && typeof telegram.sendPhoto === "function") {
        try {
          await telegram.sendPhoto(entity.telegram_id, { source: receiptPath }, { caption, parse_mode: "HTML" });
        } catch (_) {
          await telegram.sendMessage(entity.telegram_id, caption, { parse_mode: "HTML" }).catch(() => { });
        }
      } else {
        await telegram.sendMessage(entity.telegram_id, caption, { parse_mode: "HTML" }).catch(() => { });
      }
    }

    // Step 6: Trigger non-blocking silent background Base -> Arc sweep strictly for this accountType (skipped in unit tests)
    if (process.env.NODE_ENV !== "test") {
      setTimeout(() => {
        try {
          const evmDepositSweeper = require("./evm_deposit_sweeper");
          evmDepositSweeper.sweepUserDeposits(entity.telegram_id, null, {
            silent: true,
            onlyChain: "BASE",
            onlyAccountType: entity.account_type || "personal",
          }).catch(() => { });
        } catch (_) { }
      }, 15000);
    }

    return {
      swept: true,
      jobId: job.id,
      outflowId: outflow.id,
      fxQuoteId: quote?.id || null,
      currency,
      grossMajor,
      collectedMarginMinor,
      creditedUsd,
      paidInvoiceNumber,
    };
  } catch (err) {
    idempotency.failOperationIdempotency(sweepLockKey, err.message);
    throw err;
  }
}

/**
 * If external USDC (`USC`) is sent directly to the user's Nuvion-issued Base crypto address
 * (`entity.usc_base_address`) when there is NO pending outbound payout or card load job,
 * automatically forward it 1:1 via `stablecoin-transfer` straight to the user's self-custodial
 * Proxim wallet (`user.deposit_address` / `user.business_deposit_address`)!
 */
async function handleUnallocatedUscInflowSweep({ confirmed, entityRecord, bot = null }) {
  if (!confirmed || !confirmed.id || !entityRecord) {
    return { swept: false, reason: "missing_context" };
  }
  const currency = String(confirmed.currency || "").toUpperCase();
  const status = String(confirmed.status || "").toLowerCase();
  const paymentType = String(confirmed.payment_type || "").toLowerCase();
  if (currency !== "USC" || status !== "successful") {
    return { swept: false, reason: "not_settled_usc" };
  }
  if (paymentType === "book-transfer") {
    return { swept: false, reason: "internal_book_transfer_ignored" };
  }

  // If Payouts or Cards already claimed this USC inflow for a pending job, do nothing!
  const inflowClaimKey = `nuvion_usc_inflow:${confirmed.id}`;
  if (idempotency.isWebhookProcessed(inflowClaimKey)) {
    return { swept: false, reason: "already_claimed_by_payout_or_card_job" };
  }

  const netMinor = Math.max(0, Math.round(Number(confirmed.amount || 0)) - Math.round(Number(confirmed.applicable_fee || 0)));
  if (netMinor < 100) {
    return { swept: false, reason: "below_min_1_usd_sweep" };
  }

  // Double-check no pending payout or card job matches this USC inflow
  try {
    const payouts = require("./nuvion_payouts");
    const candidate = payouts.selectBestMatchingUscCandidate(entityRecord.entity_id, netMinor);
    if (candidate) {
      return { swept: false, reason: "reserved_for_pending_job" };
    }
  } catch (_) { }

  // Atomically claim the USC inflow so it cannot be double-swept
  if (!idempotency.tryClaimWebhookEvent(inflowClaimKey, "usc_direct_passthrough", entityRecord.entity_id)) {
    return { swept: false, duplicate: true, reason: "inflow_already_claimed" };
  }

  let entity = entityRecord;
  if (!entity.self_counterparty_id || !entity.self_base_payment_detail_id) {
    entity = await nuvionWebhooks.bootstrapApprovedEntity(entity);
  }
  if (!entity.self_counterparty_id || !entity.self_base_payment_detail_id) {
    return { swept: false, reason: "missing_self_counterparty" };
  }

  const ref = `sweep-usc-${confirmed.id}`;
  const outflow = await nuvion.createTransfer({
    entityId: entity.entity_id,
    accountId: confirmed.account_id || entity.usc_account_id,
    counterpartyId: entity.self_counterparty_id,
    paymentDetailId: entity.self_base_payment_detail_id,
    amountMinor: netMinor,
    currency: "USC",
    narration: `Proxim Base wallet pass-through ${confirmed.id}`,
    paymentType: "stablecoin-transfer",
    uniqueReference: ref,
  });

  const creditedUsd = nuvion.fromNuvionMinor(netMinor);
  try {
    const amountMicro = walletLib.parseToMicro(creditedUsd.toFixed(6));
    db.recordTransaction(
      entity.telegram_id,
      "deposit_crypto",
      String(amountMicro),
      "confirmed",
      outflow.id || confirmed.id,
      entity.account_type || "personal",
      18,
      "base",
      "Base USDC deposit",
      {
        sourceCurrency: "USDC",
        sourceAmount: Number.isFinite(creditedUsd) && creditedUsd > 0 ? creditedUsd : null,
        depositChannel: "crypto",
      }
    );
  } catch (_) { }

  const telegram = getBotTelegram(bot);
  if (telegram && entity.telegram_id) {
    const acctLabel = entity.account_type === "business" ? "Business Account" : "Personal Account";
    await telegram.sendMessage(
      entity.telegram_id,
      `🎉 <b>Crypto Deposit Forwarded to Your Proxim Wallet!</b>\n` +
      `──────────────────────────\n` +
      `💰 <b>Credited to Balance:</b> +$${creditedUsd.toFixed(2)} USDC\n` +
      `💼 <b>Account:</b> ${acctLabel}\n` +
      `🔖 <b>Reference:</b> <code>${escapeHtml(confirmed.id)}</code>\n` +
      `──────────────────────────\n` +
      `<i>Automatically swept from your Nuvion Base bridge address directly into your self-custodial Proxim wallet.</i>`,
      { parse_mode: "HTML" }
    ).catch(() => { });
  }

  return {
    swept: true,
    outflowId: outflow.id,
    creditedUsd,
  };
}

/**
 * Wire Phase 2 inbound auto-sweep hooks onto nuvionWebhooks (idempotent).
 */
function registerOrchestratorHooks() {
  if (_hooksRegistered) return;
  _hooksRegistered = true;

  nuvionWebhooks.onNuvionEvent("inflows.completed", async ({ confirmed, entityRecord, bot }) => {
    if (!entityRecord) return;
    const currency = String(confirmed?.currency || "").toUpperCase();
    if (!currency) return;
    if (currency === "USC") {
      await handleUnallocatedUscInflowSweep({ confirmed, entityRecord, bot });
      return;
    }
    if (STABLECOIN_CODES.has(currency)) return;
    const user = entityRecord.telegram_id ? db.getUser(entityRecord.telegram_id) : null;
    if (nuvion.shouldHoldInboundFiatForUser(user)) {
      await handleInboundFiatDeposit({ confirmed, entityRecord, bot });
      return;
    }
    await handleInboundFiatSweep({ confirmed, entityRecord, bot, collectMargin: false });
  });

  nuvionWebhooks.onNuvionEvent("funding_sessions.updated", async ({ confirmed, entityRecord }) => {
    if (!confirmed?.id) return;
    const fsJob = db.prepare("SELECT * FROM nuvion_jobs WHERE session_id = ?").get(String(confirmed.id));
    if (fsJob && confirmed.status) {
      db.updateNuvionJob(fsJob.id, { state: String(confirmed.status).toLowerCase() });
    }
    // Note: actual balance sweep happens cleanly when inflows.completed arrives for the settled session
    return { updated: Boolean(fsJob), entityId: entityRecord?.entity_id || null };
  });
}

function _clearParentAccountCache() {
  _parentOpAccounts.clear();
  _fiatBalanceCache.clear();
}

module.exports = {
  CURRENCY_META,
  provisionGlobalReceivingAccount,
  closeGlobalReceivingAccount,
  formatReceivingDetailsCard,
  createHostedPaymentLink,
  ensureChildToParentMarginTarget,
  getEntityFiatBalances,
  invalidateEntityFiatBalanceCache,
  handleInboundFiatDeposit,
  releaseHeldFiatForAutoSave,
  handleInboundFiatSweep,
  handleUnallocatedUscInflowSweep,
  registerOrchestratorHooks,
  formatFiatAmount,
  sanitizeInteracName,
  sanitizeInteracNarration,
  _clearParentAccountCache,
};
