// src/merchant_checkout.js
// Proxim Merchant Payment Acceptance Engine
// Powers:
//   - Headless & Hosted Checkout Sessions (POST /api/v1/checkout/sessions)
//   - Reusable Branded Payment Links (POST /api/v1/payment-links -> /pay/:slug)
//   - Multi-channel provisioning: Paj v2 NGN Bank, Tier-1 Named Global Bank, NEAR Intents Exact-Amount Crypto
//   - Automatic settlement hooks & HMAC-SHA256 webhook dispatch (checkout.session.completed)

const crypto = require("node:crypto");
const QRCode = require("qrcode");
const dbMod = require("./db");
const bizProfile = require("./biz_profile");
const paj = require("./paj");
const nearLib = require("./near");
const multichain = require("./multichain");
const apiKeys = require("./api_keys");

const db = dbMod.db;

db.exec(`
  CREATE TABLE IF NOT EXISTS checkout_sessions (
    session_id            TEXT PRIMARY KEY,
    key_id                TEXT NOT NULL,
    merchant_telegram_id  INTEGER NOT NULL,
    account_type          TEXT NOT NULL DEFAULT 'business',
    reference             TEXT,
    description           TEXT,
    amount                REAL NOT NULL,
    currency              TEXT NOT NULL DEFAULT 'USD',
    amount_usdc           REAL NOT NULL DEFAULT 0,
    amount_ngn            REAL NOT NULL DEFAULT 0,
    fx_rate               REAL NOT NULL DEFAULT 1,
    channels_json         TEXT NOT NULL,
    crypto_chain          TEXT NOT NULL DEFAULT 'sol_usdc',
    payment_details_json  TEXT NOT NULL,
    brand_json            TEXT,
    customer_name         TEXT,
    customer_email        TEXT,
    metadata_json         TEXT,
    success_url           TEXT,
    cancel_url            TEXT,
    webhook_url           TEXT,
    status                TEXT NOT NULL DEFAULT 'open',
    paid_channel          TEXT,
    paid_tx_hash          TEXT,
    expires_at            TEXT NOT NULL,
    paid_at               TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_checkout_sessions_key ON checkout_sessions(key_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_checkout_sessions_ref ON checkout_sessions(key_id, reference);
  CREATE INDEX IF NOT EXISTS idx_checkout_sessions_status ON checkout_sessions(status);

  CREATE TABLE IF NOT EXISTS payment_links (
    link_id               TEXT PRIMARY KEY,
    slug                  TEXT NOT NULL UNIQUE,
    key_id                TEXT NOT NULL,
    merchant_telegram_id  INTEGER NOT NULL,
    account_type          TEXT NOT NULL DEFAULT 'business',
    title                 TEXT NOT NULL,
    description           TEXT,
    amount                REAL,
    currency              TEXT NOT NULL DEFAULT 'USD',
    channels_json         TEXT NOT NULL,
    crypto_chain          TEXT NOT NULL DEFAULT 'sol_usdc',
    brand_json            TEXT,
    success_url           TEXT,
    cancel_url            TEXT,
    webhook_url           TEXT,
    active                INTEGER NOT NULL DEFAULT 1,
    created_at            TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_payment_links_key ON payment_links(key_id);

  CREATE TABLE IF NOT EXISTS merchant_settings (
    key_id                        TEXT PRIMARY KEY,
    business_name                 TEXT,
    logo_url                      TEXT,
    primary_color                 TEXT,
    accent_color                  TEXT,
    default_channels_json         TEXT,
    default_crypto_chain          TEXT,
    default_global_bank_currency  TEXT,
    webhook_url                   TEXT,
    success_url                   TEXT,
    cancel_url                    TEXT,
    updated_at                    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const SUPPORTED_CHANNELS = new Set(["ngn_bank", "global_bank", "crypto"]);

function sanitizeSlug(raw) {
  const clean = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return clean || `pay-${crypto.randomBytes(4).toString("hex")}`;
}

function sanitizeHexColor(color, fallback) {
  const s = String(color || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : fallback;
}

function parseJsonSafe(str, fallback = null) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

function formatSessionRow(row, baseUrl = "") {
  if (!row) return null;
  const isExpired = row.status === "open" && row.expires_at && new Date(row.expires_at).getTime() < Date.now();
  const status = isExpired ? "expired" : row.status;
  return {
    sessionId: row.session_id,
    checkoutUrl: baseUrl ? `${baseUrl.replace(/\/+$/, "")}/checkout/${row.session_id}` : `/checkout/${row.session_id}`,
    reference: row.reference || null,
    description: row.description || null,
    amount: Number(row.amount),
    currency: row.currency,
    amountUsdc: Number(row.amount_usdc),
    amountNgn: Number(row.amount_ngn),
    fxRate: Number(row.fx_rate),
    channels: parseJsonSafe(row.channels_json, []),
    cryptoChain: row.crypto_chain,
    paymentMethods: parseJsonSafe(row.payment_details_json, {}),
    brand: parseJsonSafe(row.brand_json, {}),
    customer: {
      name: row.customer_name || null,
      email: row.customer_email || null,
    },
    metadata: parseJsonSafe(row.metadata_json, {}),
    successUrl: row.success_url || null,
    cancelUrl: row.cancel_url || null,
    status,
    paidChannel: row.paid_channel || null,
    paidTxHash: row.paid_tx_hash || null,
    expiresAt: row.expires_at,
    paidAt: row.paid_at || null,
    createdAt: row.created_at,
  };
}

function formatLinkRow(row, baseUrl = "") {
  if (!row) return null;
  return {
    linkId: row.link_id,
    slug: row.slug,
    url: baseUrl ? `${baseUrl.replace(/\/+$/, "")}/pay/${row.slug}` : `/pay/${row.slug}`,
    title: row.title,
    description: row.description || null,
    amount: row.amount != null ? Number(row.amount) : null,
    currency: row.currency,
    channels: parseJsonSafe(row.channels_json, []),
    cryptoChain: row.crypto_chain,
    brand: parseJsonSafe(row.brand_json, {}),
    successUrl: row.success_url || null,
    cancelUrl: row.cancel_url || null,
    active: Boolean(row.active),
    createdAt: row.created_at,
  };
}

/**
 * Create a live Merchant Checkout Session and provision the requested payment channels
 * (Paj v2 NGN Bank Transfer, Tier-1 Named Global Bank, and/or NEAR Intents exact-amount Crypto).
 */
async function createCheckoutSession({
  apiKey,
  amount,
  currency = "USD",
  channels = null,
  cryptoChain = "sol_usdc",
  globalBankCurrency = null,
  reference = null,
  description = null,
  customerName = null,
  customerEmail = null,
  metadata = null,
  brand = null,
  successUrl = null,
  cancelUrl = null,
  webhookUrl = null,
  expiresInMinutes = 30,
  accountType = "business",
  baseUrl = "",
}) {
  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    const err = new Error("amount must be a positive number");
    err.statusCode = 400;
    throw err;
  }

  const cur = String(currency || "USD").toUpperCase();
  const merchantId = Number(apiKey.telegram_id || 0);
  const user = merchantId ? dbMod.getUser(merchantId) : null;
  let profile = null;
  if (merchantId) {
    try { profile = bizProfile.getBizProfile(merchantId); } catch (_) {}
  }
  const acctType = accountType === "personal" ? "personal" : (user?.business_deposit_address ? "business" : "personal");
  const settlementWallet = user
    ? (acctType === "business" ? (user.business_deposit_address || user.deposit_address) : user.deposit_address)
    : null;

  if (!settlementWallet) {
    const err = new Error("Merchant settlement wallet not found for this API key");
    err.statusCode = 400;
    throw err;
  }

  // Load saved merchant white-label settings so businesses configure branding & rails ONCE
  const savedSettings = getMerchantSettings(apiKey.key_id);

  const normalizedChannels = Array.isArray(channels) && channels.length
    ? channels.map((c) => String(c).toLowerCase().trim()).filter((c) => SUPPORTED_CHANNELS.has(c))
    : (savedSettings?.defaultChannels?.length
      ? savedSettings.defaultChannels.filter((c) => SUPPORTED_CHANNELS.has(c))
      : (cur === "NGN" ? ["ngn_bank", "crypto"] : ["crypto", "ngn_bank"]));
  if (!normalizedChannels.length) {
    const err = new Error("channels must include at least one of: ngn_bank, global_bank, crypto");
    err.statusCode = 400;
    throw err;
  }

  const effectiveCryptoChain = cryptoChain || savedSettings?.defaultCryptoChain || "sol_usdc";
  const effectiveGlobalBankCur = globalBankCurrency || savedSettings?.defaultGlobalBankCurrency || null;
  const effectiveSuccessUrl = successUrl || savedSettings?.successUrl || null;
  const effectiveCancelUrl = cancelUrl || savedSettings?.cancelUrl || null;
  const effectiveWebhookUrl = webhookUrl || savedSettings?.webhookUrl || apiKey.webhook_url || null;

  // FX resolution for NGN <-> USD
  let fxRate = 1388.75;
  if (cur === "NGN" || normalizedChannels.includes("ngn_bank")) {
    try {
      const rates = await paj.getRates("NGN");
      if (rates?.onRampRate?.rate) fxRate = Number(rates.onRampRate.rate);
    } catch (_) {}
  }

  const amountNgn = cur === "NGN" ? Math.round(numAmount) : Math.round(numAmount * fxRate);
  const amountUsdc = cur === "NGN"
    ? Number((amountNgn / fxRate).toFixed(2))
    : Number(numAmount.toFixed(2));

  const sessionId = `cs_live_${crypto.randomBytes(12).toString("hex")}`;
  const ttlMin = Math.max(5, Math.min(1440, Number(expiresInMinutes) || 30));
  const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000).toISOString();

  // Resolve merchant branding (per-request brand -> saved merchant_settings -> saved biz_profile -> app_name)
  let savedLogoUri = null;
  const resolvedLogoUrl = brand?.logoUrl || savedSettings?.logoUrl || null;
  if (!resolvedLogoUrl && merchantId) {
    try { savedLogoUri = bizProfile.getLogoDataUri(merchantId); } catch (_) {}
  }
  const resolvedBrand = {
    businessName: String(brand?.businessName || savedSettings?.businessName || profile?.business_name || apiKey.app_name || "Proxim Merchant").slice(0, 60),
    logoUrl: resolvedLogoUrl,
    logoDataUri: savedLogoUri,
    primaryColor: sanitizeHexColor(brand?.primaryColor || savedSettings?.primaryColor, "#0f172a"),
    accentColor: sanitizeHexColor(brand?.accentColor || savedSettings?.accentColor, "#059669"),
  };

  // Decrypt system key if available for Solana/NEAR refund derivations
  let systemKey = null;
  try {
    systemKey = dbMod.getSystemDecryptedPrivateKey(user, acctType);
  } catch (_) {}

  const paymentMethods = {};

  // 1. Provision Naira Bank Transfer (Paj v2)
  if (normalizedChannels.includes("ngn_bank")) {
    try {
      const feeBps = Number(process.env.INVOICE_PROCESSING_FEE_BPS ?? 50);
      const feeUsdc = Number((amountUsdc * (feeBps / 10000)).toFixed(4));
      let order = null;
      if (paj.isArcOnrampEnabled() && settlementWallet) {
        try {
          order = await paj.createOnrampOrder({
            fiatAmount: amountNgn,
            currency: "NGN",
            recipient: settlementWallet,
            mint: paj.RAILS.arc.mint,
            chain: paj.RAILS.arc.chain,
            userExternalId: sessionId,
            description: description || `Checkout ${sessionId}`,
            businessUSDCFee: feeUsdc,
          });
        } catch (_) {}
      }
      if (!order && systemKey) {
        const solAddr = multichain.deriveSolanaFromEvmKey(systemKey).solanaAddress;
        order = await paj.createOnrampOrder({
          fiatAmount: amountNgn,
          currency: "NGN",
          recipient: solAddr,
          chain: paj.RAILS.solana.chain,
          mint: paj.RAILS.solana.mint,
          userExternalId: sessionId,
          description: description || `Checkout ${sessionId}`,
          businessUSDCFee: feeUsdc,
        });
      }
      if (order && order.accountNumber) {
        paymentMethods.ngnBank = {
          bankName: order.bank || "Wema Bank PLC",
          accountNumber: order.accountNumber,
          accountName: order.accountName || resolvedBrand.businessName,
          amountNgn: order.fiatAmount || amountNgn,
          currency: "NGN",
          orderId: order.id || null,
        };
      }
    } catch (err) {
      console.warn("[merchant_checkout] Paj NGN provisioning notice:", err.message);
    }
  }

  // Lazy-require invoice_hd to avoid circular require (invoice_hd -> nuvion_orchestrator -> api_routes -> merchant_checkout)
  const invoiceHd = require("./invoice_hd");

  // 2. Provision Tier-1 Named Global Bank Account (if merchant is Tier-1 verified)
  if (normalizedChannels.includes("global_bank")) {
    const bankCur = String(effectiveGlobalBankCur || (cur !== "NGN" ? cur : "USD")).toUpperCase();
    try {
      if (invoiceHd.isTier1VerifiedForInvoice(merchantId, acctType)) {
        const bankRes = await invoiceHd.provisionNuvionBankForInvoice({
          telegramId: merchantId,
          accountType: acctType,
          bankCurrency: bankCur,
          invoiceCurrency: cur,
          totalNative: numAmount,
          totalUsdc: amountUsdc,
          totalNgn: amountNgn,
          fallbackBeneficiary: resolvedBrand.businessName,
        });
        if (bankRes && !bankRes.pending) {
          paymentMethods.globalBank = {
            currency: bankRes.currency,
            railHint: bankRes.railHint,
            bankName: bankRes.bankName,
            accountNumber: bankRes.accountNumber,
            iban: bankRes.iban,
            routingNumber: bankRes.routingNumber,
            sortCode: bankRes.sortCode,
            swiftCode: bankRes.swiftCode,
            accountName: bankRes.accountName,
            amount: bankRes.fiatAmount,
          };
        }
      }
    } catch (err) {
      console.warn("[merchant_checkout] Global bank provisioning notice:", err.message);
    }
  }

  // 3. Provision Crypto / NEAR Intents Exact-Amount Checkout
  if (normalizedChannels.includes("crypto")) {
    const chainId = invoiceHd.INVOICE_CRYPTO_CHAINS[effectiveCryptoChain] ? effectiveCryptoChain : "sol_usdc";
    let cryptoRes = null;
    if (systemKey && chainId !== "arc") {
      cryptoRes = await invoiceHd.provisionInvoiceCryptoIntent({
        telegramId: merchantId,
        accountType: acctType,
        cryptoChain: chainId,
        totalUsdc: amountUsdc,
        mainWalletAddress: settlementWallet,
        decryptedPrivateKey: systemKey,
        fallbackArcAddress: settlementWallet,
      });
    } else {
      cryptoRes = {
        chainId: "arc",
        chainLabel: "Arc Mainnet",
        tokenSymbol: "USDC",
        exactAmount: amountUsdc,
        depositAddress: settlementWallet,
        depositMemo: null,
        viaNearIntents: false,
      };
    }

    let qrDataUri = null;
    if (cryptoRes?.depositAddress) {
      try {
        qrDataUri = await QRCode.toDataURL(cryptoRes.depositAddress, {
          margin: 1,
          width: 220,
          color: { dark: resolvedBrand.primaryColor, light: "#ffffff" },
        });
      } catch (_) {}
    }

    paymentMethods.crypto = {
      chainId: cryptoRes.chainId,
      chainLabel: cryptoRes.chainLabel,
      tokenSymbol: cryptoRes.tokenSymbol,
      exactAmount: cryptoRes.exactAmount,
      depositAddress: cryptoRes.depositAddress,
      depositMemo: cryptoRes.depositMemo || null,
      viaNearIntents: Boolean(cryptoRes.viaNearIntents),
      qrDataUri,
    };
  }

  db.prepare(`
    INSERT INTO checkout_sessions (
      session_id, key_id, merchant_telegram_id, account_type, reference, description,
      amount, currency, amount_usdc, amount_ngn, fx_rate,
      channels_json, crypto_chain, payment_details_json, brand_json,
      customer_name, customer_email, metadata_json,
      success_url, cancel_url, webhook_url, status, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
  `).run(
    sessionId,
    apiKey.key_id,
    merchantId,
    acctType,
    reference ? String(reference).slice(0, 120) : null,
    description ? String(description).slice(0, 240) : null,
    numAmount,
    cur,
    amountUsdc,
    amountNgn,
    fxRate,
    JSON.stringify(normalizedChannels),
    effectiveCryptoChain,
    JSON.stringify(paymentMethods),
    JSON.stringify(resolvedBrand),
    customerName ? String(customerName).slice(0, 100) : null,
    customerEmail ? String(customerEmail).slice(0, 120) : null,
    metadata ? JSON.stringify(metadata) : null,
    effectiveSuccessUrl,
    effectiveCancelUrl,
    effectiveWebhookUrl,
    expiresAt
  );

  return formatSessionRow(getCheckoutSessionRow(sessionId), baseUrl);
}

function getCheckoutSessionRow(sessionId) {
  if (!sessionId) return null;
  return db.prepare("SELECT * FROM checkout_sessions WHERE session_id = ?").get(String(sessionId)) || null;
}

function getCheckoutSession(sessionId, baseUrl = "") {
  return formatSessionRow(getCheckoutSessionRow(sessionId), baseUrl);
}

function listCheckoutSessions(keyId, { status = null, reference = null, limit = 25 } = {}, baseUrl = "") {
  let sql = "SELECT * FROM checkout_sessions WHERE key_id = ?";
  const params = [String(keyId)];
  if (status) {
    sql += " AND status = ?";
    params.push(String(status));
  }
  if (reference) {
    sql += " AND reference = ?";
    params.push(String(reference));
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(Math.max(1, Math.min(100, Number(limit) || 25)));
  return db.prepare(sql).all(...params).map((r) => formatSessionRow(r, baseUrl));
}

function cancelCheckoutSession(sessionId, keyId, baseUrl = "") {
  const row = getCheckoutSessionRow(sessionId);
  if (!row || row.key_id !== keyId) return null;
  if (row.status !== "open") return formatSessionRow(row, baseUrl);
  db.prepare("UPDATE checkout_sessions SET status = 'cancelled' WHERE session_id = ?").run(sessionId);
  return formatSessionRow(getCheckoutSessionRow(sessionId), baseUrl);
}

/**
 * Mark a checkout session as paid (called by Paj webhook, NEAR Intents settlement, or test trigger)
 * and dispatch an HMAC-SHA256 signed `checkout.session.completed` webhook to the merchant.
 */
async function markCheckoutSessionPaid(sessionId, { paidChannel = "crypto", txHash = null } = {}, baseUrl = "") {
  const row = getCheckoutSessionRow(sessionId);
  if (!row) return null;
  if (row.status === "paid") return formatSessionRow(row, baseUrl);

  db.prepare(`
    UPDATE checkout_sessions
    SET status = 'paid', paid_channel = ?, paid_tx_hash = ?, paid_at = datetime('now')
    WHERE session_id = ?
  `).run(String(paidChannel), txHash ? String(txHash) : null, sessionId);

  const updated = formatSessionRow(getCheckoutSessionRow(sessionId), baseUrl);
  const webhookTarget = row.webhook_url;
  if (webhookTarget) {
    try {
      await apiKeys.dispatchBuilderWebhook(
        { key_id: row.key_id, webhook_url: webhookTarget },
        "checkout.session.completed",
        updated
      );
    } catch (err) {
      console.warn("[merchant_checkout] Webhook dispatch notice:", err.message);
    }
  }
  return updated;
}

// ── Reusable Payment Links ───────────────────────────────────────────────────

function createPaymentLink({
  apiKey,
  title,
  description = null,
  amount = null,
  currency = "USD",
  slug = null,
  channels = ["ngn_bank", "crypto"],
  cryptoChain = "sol_usdc",
  brand = null,
  successUrl = null,
  cancelUrl = null,
  webhookUrl = null,
  accountType = "business",
  baseUrl = "",
}) {
  if (!title || !String(title).trim()) {
    const err = new Error("title is required for a payment link");
    err.statusCode = 400;
    throw err;
  }
  const linkId = `pl_live_${crypto.randomBytes(10).toString("hex")}`;
  const cleanSlug = sanitizeSlug(slug || `${title}-${crypto.randomBytes(3).toString("hex")}`);
  const cur = String(currency || "USD").toUpperCase();
  const numAmt = amount != null && amount !== "" ? Number(amount) : null;
  if (numAmt !== null && (!Number.isFinite(numAmt) || numAmt <= 0)) {
    const err = new Error("amount must be positive when provided");
    err.statusCode = 400;
    throw err;
  }

  const normalizedChannels = (Array.isArray(channels) ? channels : ["ngn_bank", "crypto"])
    .map((c) => String(c).toLowerCase().trim())
    .filter((c) => SUPPORTED_CHANNELS.has(c));

  db.prepare(`
    INSERT INTO payment_links (
      link_id, slug, key_id, merchant_telegram_id, account_type,
      title, description, amount, currency, channels_json, crypto_chain,
      brand_json, success_url, cancel_url, webhook_url, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    linkId,
    cleanSlug,
    apiKey.key_id,
    Number(apiKey.telegram_id || 0),
    accountType === "personal" ? "personal" : "business",
    String(title).trim().slice(0, 100),
    description ? String(description).slice(0, 240) : null,
    numAmt,
    cur,
    JSON.stringify(normalizedChannels.length ? normalizedChannels : ["ngn_bank", "crypto"]),
    cryptoChain || "sol_usdc",
    brand ? JSON.stringify(brand) : null,
    successUrl || null,
    cancelUrl || null,
    webhookUrl || apiKey.webhook_url || null
  );

  return formatLinkRow(db.prepare("SELECT * FROM payment_links WHERE link_id = ?").get(linkId), baseUrl);
}

function getPaymentLinkBySlug(slug, baseUrl = "") {
  const row = db.prepare("SELECT * FROM payment_links WHERE slug = ? AND active = 1").get(String(slug));
  return formatLinkRow(row, baseUrl);
}

function getPaymentLinkRowBySlug(slug) {
  return db.prepare("SELECT * FROM payment_links WHERE slug = ? AND active = 1").get(String(slug)) || null;
}

function listPaymentLinks(keyId, baseUrl = "") {
  return db
    .prepare("SELECT * FROM payment_links WHERE key_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(String(keyId))
    .map((r) => formatLinkRow(r, baseUrl));
}

function deactivatePaymentLink(linkId, keyId) {
  const res = db
    .prepare("UPDATE payment_links SET active = 0 WHERE link_id = ? AND key_id = ?")
    .run(String(linkId), String(keyId));
  return res.changes > 0;
}

// ── Merchant White-Label Settings & Unified Analytics ────────────────────────

function getMerchantSettings(keyId) {
  if (!keyId) return null;
  const row = db.prepare("SELECT * FROM merchant_settings WHERE key_id = ?").get(String(keyId));
  if (!row) return null;
  return {
    keyId: row.key_id,
    businessName: row.business_name || null,
    logoUrl: row.logo_url || null,
    primaryColor: row.primary_color || "#0f172a",
    accentColor: row.accent_color || "#059669",
    defaultChannels: parseJsonSafe(row.default_channels_json, ["ngn_bank", "crypto"]),
    defaultCryptoChain: row.default_crypto_chain || "sol_usdc",
    defaultGlobalBankCurrency: row.default_global_bank_currency || "USD",
    webhookUrl: row.webhook_url || null,
    successUrl: row.success_url || null,
    cancelUrl: row.cancel_url || null,
    updatedAt: row.updated_at,
  };
}

function upsertMerchantSettings(keyId, updates = {}) {
  const existing = getMerchantSettings(keyId) || {};
  const channels = Array.isArray(updates.defaultChannels)
    ? updates.defaultChannels.map((c) => String(c).toLowerCase().trim()).filter((c) => SUPPORTED_CHANNELS.has(c))
    : (existing.defaultChannels || ["ngn_bank", "crypto"]);

  db.prepare(`
    INSERT INTO merchant_settings (
      key_id, business_name, logo_url, primary_color, accent_color,
      default_channels_json, default_crypto_chain, default_global_bank_currency,
      webhook_url, success_url, cancel_url, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(key_id) DO UPDATE SET
      business_name = excluded.business_name,
      logo_url = excluded.logo_url,
      primary_color = excluded.primary_color,
      accent_color = excluded.accent_color,
      default_channels_json = excluded.default_channels_json,
      default_crypto_chain = excluded.default_crypto_chain,
      default_global_bank_currency = excluded.default_global_bank_currency,
      webhook_url = excluded.webhook_url,
      success_url = excluded.success_url,
      cancel_url = excluded.cancel_url,
      updated_at = datetime('now')
  `).run(
    String(keyId),
    updates.businessName !== undefined ? (updates.businessName ? String(updates.businessName).slice(0, 60) : null) : (existing.businessName || null),
    updates.logoUrl !== undefined ? (updates.logoUrl || null) : (existing.logoUrl || null),
    updates.primaryColor !== undefined ? sanitizeHexColor(updates.primaryColor, "#0f172a") : (existing.primaryColor || "#0f172a"),
    updates.accentColor !== undefined ? sanitizeHexColor(updates.accentColor, "#059669") : (existing.accentColor || "#059669"),
    JSON.stringify(channels.length ? channels : ["ngn_bank", "crypto"]),
    updates.defaultCryptoChain !== undefined ? String(updates.defaultCryptoChain) : (existing.defaultCryptoChain || "sol_usdc"),
    updates.defaultGlobalBankCurrency !== undefined ? String(updates.defaultGlobalBankCurrency).toUpperCase() : (existing.defaultGlobalBankCurrency || "USD"),
    updates.webhookUrl !== undefined ? (updates.webhookUrl || null) : (existing.webhookUrl || null),
    updates.successUrl !== undefined ? (updates.successUrl || null) : (existing.successUrl || null),
    updates.cancelUrl !== undefined ? (updates.cancelUrl || null) : (existing.cancelUrl || null)
  );
  return getMerchantSettings(keyId);
}

function getMerchantAnalytics(keyId) {
  const rows = db.prepare("SELECT status, amount_usdc, amount_ngn, paid_channel FROM checkout_sessions WHERE key_id = ?").all(String(keyId));
  let totalPaidUsdc = 0;
  let totalPaidNgn = 0;
  let paidCount = 0;
  let openCount = 0;
  let cancelledCount = 0;
  const byChannel = {};

  for (const r of rows) {
    if (r.status === "paid") {
      paidCount++;
      totalPaidUsdc += Number(r.amount_usdc || 0);
      totalPaidNgn += Number(r.amount_ngn || 0);
      const ch = r.paid_channel || "unknown";
      byChannel[ch] = (byChannel[ch] || 0) + Number(r.amount_usdc || 0);
    } else if (r.status === "open") {
      openCount++;
    } else if (r.status === "cancelled") {
      cancelledCount++;
    }
  }

  return {
    totalSessions: rows.length,
    paidCount,
    openCount,
    cancelledCount,
    totalVolumeUsdc: Number(totalPaidUsdc.toFixed(2)),
    totalVolumeNgn: Math.round(totalPaidNgn),
    volumeByChannelUsdc: byChannel,
  };
}

// ── Cross-Rail Automatic Settlement Matchers ─────────────────────────────────

/**
 * Match a settled NEAR Intents deposit (Solana / NEAR / Robinhood / Starknet) to an open Checkout Session.
 */
async function trySettleSessionByNearIntent(nearDepositRow) {
  if (!nearDepositRow?.deposit_address) return null;
  const targetAddr = String(nearDepositRow.deposit_address).trim().toLowerCase();
  const openRows = db.prepare("SELECT * FROM checkout_sessions WHERE status = 'open' ORDER BY rowid DESC LIMIT 100").all();
  for (const row of openRows) {
    const pm = parseJsonSafe(row.payment_details_json, {});
    const cryptoAddr = String(pm?.crypto?.depositAddress || "").trim().toLowerCase();
    if (cryptoAddr && cryptoAddr === targetAddr) {
      return markCheckoutSessionPaid(row.session_id, {
        paidChannel: `crypto_${pm.crypto.chainId || "near_intent"}`,
        txHash: nearDepositRow.correlation_id || String(nearDepositRow.id || ""),
      });
    }
  }
  return null;
}

/**
 * Match an inbound Tier-1 Global Bank (Nuvion USD/GBP/EUR/NGN/...) deposit to an open Checkout Session.
 */
async function trySettleSessionByGlobalBank({ merchantTelegramId, accountType = "business", currency, amountMajor, txHash = null }) {
  if (!merchantTelegramId || !currency || !amountMajor) return null;
  const cur = String(currency).toUpperCase();
  const amt = Number(amountMajor);
  if (!Number.isFinite(amt) || amt <= 0) return null;

  const openRows = db
    .prepare("SELECT * FROM checkout_sessions WHERE status = 'open' AND merchant_telegram_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(Number(merchantTelegramId));

  for (const row of openRows) {
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) continue;
    const pm = parseJsonSafe(row.payment_details_json, {});
    const gb = pm?.globalBank;
    if (!gb || String(gb.currency || "").toUpperCase() !== cur) continue;
    const expected = gb.amount != null ? Number(gb.amount) : (row.currency === cur ? Number(row.amount) : Number(row.amount_usdc));
    if (expected > 0 && amt >= expected * 0.98) {
      return markCheckoutSessionPaid(row.session_id, {
        paidChannel: `global_bank_${cur.toLowerCase()}`,
        txHash: txHash || `gb_${cur}_${Date.now()}`,
      });
    }
  }
  return null;
}

/**
 * Match a direct on-chain EVM / Arc USDC deposit to an open Checkout Session.
 */
async function trySettleSessionByDirectEvm({ recipientAddress, amountUsdc, txHash = null, chainName = "evm" }) {
  if (!recipientAddress || !amountUsdc) return null;
  const target = String(recipientAddress).trim().toLowerCase();
  const amt = Number(amountUsdc);
  if (!Number.isFinite(amt) || amt <= 0) return null;

  const openRows = db.prepare("SELECT * FROM checkout_sessions WHERE status = 'open' ORDER BY rowid DESC LIMIT 100").all();
  for (const row of openRows) {
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) continue;
    const pm = parseJsonSafe(row.payment_details_json, {});
    const cryptoAddr = String(pm?.crypto?.depositAddress || "").trim().toLowerCase();
    if (cryptoAddr && cryptoAddr === target && amt >= Number(row.amount_usdc || 0) * 0.98) {
      return markCheckoutSessionPaid(row.session_id, {
        paidChannel: `crypto_${String(chainName).toLowerCase()}`,
        txHash: txHash || `evm_${Date.now()}`,
      });
    }
  }
  return null;
}

module.exports = {
  createCheckoutSession,
  getCheckoutSession,
  getCheckoutSessionRow,
  listCheckoutSessions,
  cancelCheckoutSession,
  markCheckoutSessionPaid,
  createPaymentLink,
  getPaymentLinkBySlug,
  getPaymentLinkRowBySlug,
  listPaymentLinks,
  deactivatePaymentLink,
  getMerchantSettings,
  upsertMerchantSettings,
  getMerchantAnalytics,
  trySettleSessionByNearIntent,
  trySettleSessionByGlobalBank,
  trySettleSessionByDirectEvm,
};
