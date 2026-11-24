// src/nuvion.js
// Production Nuvion Global Banking Infrastructure Client (X-API-Version: 2026-02-06)
// Covers Entities (KYC/KYB), Multi-Currency Accounts, Account Details (Fiat & Base USC),
// Counterparties, FX Quotes, Transfers (24+ rails & Book Transfers), Funding Sessions,
// Virtual & Disposable USD Cards, and HMAC-SHA256 Webhooks.

const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const axios = require("axios");

// Dedicated non-pooled agents prevent stale keep-alive ECONNRESET races after idle periods
// (e.g. Cloudflare/ALB idle timeouts or >5s receipt PNG generation between consecutive calls).
const _httpAgent = new http.Agent({ keepAlive: false });
const _httpsAgent = new https.Agent({ keepAlive: false });

const DEFAULT_API_VERSION = "2026-02-06";
const DEFAULT_FX_MARGIN_BPS = 100; // 1.00%

const SUPPORTED_FIAT_RECEIVING_CURRENCIES = [
  "USD", "EUR", "GBP", "CAD", "NGN", "AED", "KES", "GHS", "TZS", "MXN",
];

// Official Nuvion POST /documents accepted meta.file_type values (exact case-sensitive match)
const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const STABLECOIN_CHAIN_TO_NETWORK = {
  base: "BASE_MAINNET",
  eth: "ETH_MAINNET",
  matic: "MATIC_MAINNET",
  sol: "SOLANA_MAINNET",
};

class NuvionError extends Error {
  constructor({ status = 500, type = "error_unknown", message = "Nuvion API error", validations = null, requestId = null, raw = null } = {}) {
    super(message);
    this.name = "NuvionError";
    this.status = status;
    this.type = type;
    this.validations = validations;
    this.requestId = requestId;
    this.raw = raw;
  }
}

// ── Environment, Keys & Feature Gates ─────────────────────────────────────────

function getEnvironment() {
  const raw = String(process.env.NUVION_ENV || "production").trim().toLowerCase();
  return raw === "sandbox" || raw === "dev" ? "sandbox" : "production";
}

function getBaseUrl() {
  if (process.env.NUVION_BASE_URL && process.env.NUVION_BASE_URL.trim()) {
    return process.env.NUVION_BASE_URL.trim().replace(/\/+$/, "");
  }
  return getEnvironment() === "sandbox" ? "https://api.nuvion.dev" : "https://api.nuvion.co";
}

function getApiVersion() {
  return (process.env.NUVION_API_VERSION || DEFAULT_API_VERSION).trim();
}

function getApiKey(role = "default") {
  const byRole = {
    owner: process.env.NUVION_OWNER_KEY,
    admin: process.env.NUVION_ADMIN_KEY,
    operations: process.env.NUVION_OPS_KEY,
    developer: process.env.NUVION_DEV_KEY,
  };
  const key = (byRole[role] || process.env.NUVION_API_KEY || "").trim();
  return key || null;
}

function isNuvionConfigured() {
  return Boolean(getApiKey("default") || getApiKey("owner") || getApiKey("admin"));
}

function getFxMarginBps(direction = "default") {
  if (direction === "inbound" && process.env.NUVION_INBOUND_MARGIN_BPS) {
    const v = Number(process.env.NUVION_INBOUND_MARGIN_BPS);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  if (direction === "outbound" && process.env.NUVION_OUTBOUND_MARGIN_BPS) {
    const v = Number(process.env.NUVION_OUTBOUND_MARGIN_BPS);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  const v = Number(process.env.NUVION_FX_MARGIN_BPS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_FX_MARGIN_BPS;
}

/**
 * Whether Tier-1 Global Banking / KYC / Cards is open to all general users.
 * Defaults to PUBLIC (`true`) in production now that live verification is complete
 * (even if legacy `NUVION_PUBLIC_LAUNCH=false` was set during initial Railway setup),
 * unless `NUVION_PRIVATE_BETA_ONLY=true` is explicitly set (or in NODE_ENV=test when testing the beta gate).
 */
function isPublicLaunchEnabled() {
  if (String(process.env.NUVION_PRIVATE_BETA_ONLY || "").toLowerCase() === "true") {
    return false;
  }
  if (process.env.NODE_ENV === "test" && String(process.env.NUVION_PUBLIC_LAUNCH || "").toLowerCase() === "false") {
    return false;
  }
  return true;
}

/**
 * Check whether a user can access Tier-1 Global Banking / KYC / Cards.
 */
function isUserAllowedNuvion(telegramId) {
  if (!isNuvionConfigured()) return false;
  if (isPublicLaunchEnabled()) {
    return true;
  }
  if (!telegramId) return false;
  const idStr = String(telegramId).trim();
  const betaIds = String(process.env.NUVION_BETA_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const adminIds = String(process.env.ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return betaIds.includes(idStr) || adminIds.includes(idStr);
}

// ── Minor-Unit Currency Helpers (2 Decimals for ALL Fiat AND USC/UST) ─────────

/**
 * Convert major currency amount (e.g. 100.50 USD or 100.50 USC) into Nuvion minor
 * integer units (10050). Nuvion uses 2 decimal places even for stablecoins (USC/UST).
 */
function toNuvionMinor(majorAmount) {
  const n = Number(majorAmount);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid amount for Nuvion minor unit conversion: ${majorAmount}`);
  }
  return Math.round((n + Number.EPSILON) * 100);
}

/**
 * Convert Nuvion minor integer units (e.g. 10050) into major decimal units (100.5).
 */
function fromNuvionMinor(minorAmount) {
  const n = Number(minorAmount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

/**
 * Calculate Proxim FX margin in integer minor units (default 100 bps = 1%).
 */
function calcMarginMinor(amountMinor, marginBps = getFxMarginBps()) {
  const amt = Math.max(0, Math.round(Number(amountMinor) || 0));
  const bps = Math.max(0, Number(marginBps) || 0);
  return Math.floor((amt * bps) / 10000);
}

// ── Webhook Cryptographic Signature Verifier ──────────────────────────────────

/**
 * Verify Nuvion HMAC-SHA256 webhook signature on the exact raw HTTP body.
 * Spec: HMAC_SHA256(webhook_secret, "{x-nuvion-event-timestamp}.{rawBody}") -> lowercase hex.
 */
function verifyWebhookSignature(rawBody, headers, webhookSecret) {
  if (!webhookSecret || !headers || typeof headers !== "object") return false;

  const normalizedHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    normalizedHeaders[String(k).toLowerCase()] = v;
  }

  const timestamp = normalizedHeaders["x-nuvion-event-timestamp"];
  const received = normalizedHeaders["x-nuvion-event-signature"];
  if (!timestamp || !received) return false;

  const rawString = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
  const expected = crypto
    .createHmac("sha256", String(webhookSecret).trim())
    .update(`${timestamp}.${rawString}`)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(received).trim(), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Core HTTP Transport ───────────────────────────────────────────────────────

function formatUserFriendlyError(err) {
  if (!err) return "Something went wrong. Please try again.";
  if (err instanceof NuvionError) {
    switch (err.type) {
      case "error_auth_credentials_invalid":
      case "error_auth_credentials_revoked":
        return "Global banking service credentials need attention. Please contact support.";
      case "error_transfer_insufficient_funds":
        return err.message || "Insufficient funds for this transfer.";
      case "error_fx_quote_used":
      case "error_fx_quote_expired":
        return "That exchange rate expired. Please request a fresh quote and try again.";
      case "error_duplicate_resource":
        return "This record or email is already registered.";
      case "error_kyc_document_expired":
        return "Your ID document appears to be expired. Please upload a valid unexpired ID.";
      case "error_kyc_document_quality_insufficient":
        return "The uploaded document image wasn't clear enough. Please upload a sharper photo or PDF.";
      case "error_validation_error":
        if (Array.isArray(err.validations) && err.validations.length > 0) {
          const firstObj = err.validations[0];
          const field = Object.keys(firstObj)[0];
          const detail = firstObj[field]?.message;
          if (detail) return detail;
        }
        return err.message || "Some entered details have an invalid format. Please check and retry.";
      default:
        return err.message || "Unable to complete request right now. Please try again.";
    }
  }
  return err.message || "Unable to complete request right now.";
}

async function nuvionRequest({ method, path, params = null, data = null, entityId = null, role = "default", timeoutMs = 25000 }) {
  const apiKey = getApiKey(role);
  if (!apiKey) {
    throw new NuvionError({
      status: 401,
      type: "error_auth_credentials_missing",
      message: "NUVION_API_KEY is not configured",
    });
  }

  const upperMethod = String(method || "GET").toUpperCase();
  const queryParams = params ? { ...params } : {};
  let bodyData = data ? { ...data } : undefined;

  // Enforce Nuvion child-entity scoping rules:
  // - GET: entity_id goes in query string
  // - POST/PUT/PATCH/DELETE: entity_id goes in request body (unless entity_id is in path)
  const hasEntityInPath = /^\/(individual-entities|business-entities|entities)\/[^/]+/.test(path);
  if (entityId && !hasEntityInPath) {
    if (upperMethod === "GET") {
      if (!queryParams.entity_id) queryParams.entity_id = entityId;
    } else {
      bodyData = bodyData || {};
      if (!bodyData.entity_id) bodyData.entity_id = entityId;
    }
  }

  // Strip undefined query params
  const cleanParams = {};
  for (const [k, v] of Object.entries(queryParams)) {
    if (v !== undefined && v !== null && v !== "") cleanParams[k] = v;
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "X-API-Version": getApiVersion(),
  };
  if (bodyData !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const url = `${getBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const maxAttempts = upperMethod === "GET" ? 2 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await axios({
        method: upperMethod,
        url,
        headers,
        params: Object.keys(cleanParams).length ? cleanParams : undefined,
        data: bodyData,
        timeout: timeoutMs,
        httpAgent: _httpAgent,
        httpsAgent: _httpsAgent,
        validateStatus: () => true,
      });

      const payload = res.data || {};
      const requestId = res.headers?.["x-request-id"] || res.headers?.["X-Request-ID"] || null;

      if (res.status >= 200 && res.status < 300) {
        return payload;
      }

      throw new NuvionError({
        status: res.status,
        type: payload.type || `error_http_${res.status}`,
        message: payload.message || `Nuvion request failed with HTTP ${res.status}`,
        validations: payload.validations || null,
        requestId,
        raw: payload,
      });
    } catch (err) {
      if (err instanceof NuvionError) throw err;
      const isTransientSocket = err.code === "ECONNRESET" || err.code === "EPIPE" || /ECONNRESET|socket hang up/i.test(err.message || "");
      if (attempt + 1 < maxAttempts && isTransientSocket) {
        continue;
      }
      throw new NuvionError({
        status: err.response?.status || 503,
        type: "error_network",
        message: err.message || "Network error contacting Nuvion API",
        raw: err.response?.data || null,
      });
    }
  }
}

// ── 1. Entities & KYC/KYB (With Production Schema Pre-Flight Validators) ──────

function _isValidCalendarDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || "").trim())) return false;
  const d = new Date(`${dateStr}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(String(dateStr).trim());
}

function _isPastDate(dateStr) {
  if (!_isValidCalendarDate(dateStr)) return false;
  return new Date(`${dateStr}T00:00:00Z`).getTime() < Date.now();
}

function _isValidIso2(code) {
  return /^[A-Z]{2}$/.test(String(code || "").trim());
}

function _isValidNuvionPhone(phone) {
  const s = String(phone || "").trim();
  return /^\+\d{9,13}$/.test(s) && s.length >= 10 && s.length <= 14;
}

function _isValidEmailAddr(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || "").trim());
}

function _isValidHttpUrl(urlStr) {
  try {
    const parsed = new URL(String(urlStr || "").trim());
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname.includes(".");
  } catch (_) {
    return false;
  }
}

function _validateAddressObj(addr, prefix, issues) {
  if (!addr || typeof addr !== "object") return;
  const line1 = String(addr.line_1 || "").trim();
  if (line1.length < 4 || line1.length > 255) {
    issues.push({ [`${prefix}.line_1`]: { type: "error_validation_invalid_length", message: "Street address (line_1) must be 4–255 characters." } });
  }
  if (!String(addr.city || "").trim() || String(addr.city).length > 100) {
    issues.push({ [`${prefix}.city`]: { type: "error_validation_required_field_missing", message: "Address city is required (1–100 chars)." } });
  }
  if (!String(addr.state || "").trim() || String(addr.state).length > 100) {
    issues.push({ [`${prefix}.state`]: { type: "error_validation_required_field_missing", message: "Address state is required (1–100 chars)." } });
  }
  if (!String(addr.postal_code || "").trim() || String(addr.postal_code).length > 20) {
    issues.push({ [`${prefix}.postal_code`]: { type: "error_validation_required_field_missing", message: "Address postal_code is required (1–20 chars)." } });
  }
  if (!_isValidIso2(addr.country_code)) {
    issues.push({ [`${prefix}.country_code`]: { type: "error_validation_invalid_format", message: "Address country_code must be a 2-letter uppercase ISO code." } });
  }
}

function _validatePersonObj(person, prefix, countryHint, issues, { requirePhone = true } = {}) {
  if (!person || typeof person !== "object") {
    issues.push({ [prefix]: { type: "error_validation_required_field_missing", message: `The '${prefix}' object is required.` } });
    return;
  }
  if (!String(person.first_name || "").trim() || String(person.first_name).length > 100) {
    issues.push({ [`${prefix}.first_name`]: { type: "error_validation_required_field_missing", message: "First name is required (1–100 chars)." } });
  }
  if (!String(person.last_name || "").trim() || String(person.last_name).length > 100) {
    issues.push({ [`${prefix}.last_name`]: { type: "error_validation_required_field_missing", message: "Last name is required (1–100 chars)." } });
  }
  if (!_isPastDate(person.date_of_birth)) {
    issues.push({ [`${prefix}.date_of_birth`]: { type: "error_validation_date_invalid", message: "Date of birth must be a valid past YYYY-MM-DD date." } });
  }
  if (!_isValidEmailAddr(person.email)) {
    issues.push({ [`${prefix}.email`]: { type: "error_validation_email_invalid", message: "A valid email address is required." } });
  }
  if (!_isValidIso2(person.nationality)) {
    issues.push({ [`${prefix}.nationality`]: { type: "error_validation_invalid_format", message: "Nationality must be a 2-letter uppercase ISO country code." } });
  }
  if (!["m", "f"].includes(String(person.gender || ""))) {
    issues.push({ [`${prefix}.gender`]: { type: "error_validation_invalid_format", message: "Gender must be 'm' or 'f'." } });
  }
  if (requirePhone || person.phonenumber) {
    if (!_isValidNuvionPhone(person.phonenumber)) {
      issues.push({ [`${prefix}.phonenumber`]: { type: "error_validation_invalid_length", message: "Phone number must include '+' and be 10–14 characters total (e.g. +2348012345678)." } });
    }
  }

  const nat = String(person.nationality || "").toUpperCase();
  const resCountry = String(countryHint || "").toUpperCase();
  if (nat === "NG" || resCountry === "NG") {
    if (!/^\d{11}$/.test(String(person.bvn || ""))) {
      issues.push({ [`${prefix}.bvn`]: { type: "error_validation_invalid_format", message: "Nigerian nationals/residents require an 11-digit BVN." } });
    }
    if (!/^\d{11}$/.test(String(person.nin || ""))) {
      issues.push({ [`${prefix}.nin`]: { type: "error_validation_invalid_format", message: "Nigerian nationals/residents require an 11-digit NIN." } });
    }
  }
  if (nat === "US" || resCountry === "US") {
    const ssnDigits = String(person.ssn || "").replace(/-/g, "");
    if (!/^\d{9,}$/.test(ssnDigits)) {
      issues.push({ [`${prefix}.ssn`]: { type: "error_validation_invalid_length", message: "U.S. nationals/residents require a valid 9-digit SSN." } });
    }
  }
}

function _validateIdentificationObj(ident, prefix, issues) {
  if (!ident || typeof ident !== "object") return;
  const doc = ident.document;
  if (doc) {
    if (!["international_passport", "drivers_license", "national_id"].includes(String(doc.type || ""))) {
      issues.push({ [`${prefix}.document.type`]: { type: "error_validation_invalid_format", message: "ID document type must be international_passport, drivers_license, or national_id." } });
    }
    if (!String(doc.number || "").trim()) {
      issues.push({ [`${prefix}.document.number`]: { type: "error_validation_required_field_missing", message: "ID document number is required." } });
    }
    if (doc.issuing_country && !_isValidIso2(doc.issuing_country)) {
      issues.push({ [`${prefix}.document.issuing_country`]: { type: "error_validation_invalid_format", message: "ID issuing_country must be a 2-letter ISO code." } });
    }
    if (doc.issue_date && !_isValidCalendarDate(doc.issue_date)) {
      issues.push({ [`${prefix}.document.issue_date`]: { type: "error_validation_date_invalid", message: "ID issue_date must be YYYY-MM-DD." } });
    }
    if (doc.expiry_date) {
      if (!_isValidCalendarDate(doc.expiry_date)) {
        issues.push({ [`${prefix}.document.expiry_date`]: { type: "error_validation_date_invalid", message: "ID expiry_date must be YYYY-MM-DD." } });
      } else {
        const expMs = new Date(`${doc.expiry_date}T23:59:59Z`).getTime();
        if (expMs <= Date.now()) {
          issues.push({ [`${prefix}.document.expiry_date`]: { type: "error_kyc_document_expired", message: "Your government ID is expired. Please use a valid unexpired ID." } });
        }
        if (doc.issue_date && _isValidCalendarDate(doc.issue_date) && doc.issue_date > doc.expiry_date) {
          issues.push({ [`${prefix}.document.issue_date`]: { type: "error_validation_date_out_of_range", message: "ID issue date cannot be after expiry date." } });
        }
      }
    }
  }
}

/**
 * Local pre-flight schema validation for POST /individual-entities (X-API-Version: 2026-02-06).
 * Catches validation issues BEFORE calling live https://api.nuvion.co to protect API standing.
 */
function validateIndividualEntityPayload(payload) {
  const issues = [];
  if (!payload || typeof payload !== "object") {
    throw new NuvionError({ status: 422, type: "error_validation_error", message: "Individual entity payload is required." });
  }
  const name = String(payload.name || "").trim();
  if (name.length < 1 || name.length > 255) {
    issues.push({ name: { type: "error_validation_required_field_missing", message: "Entity name is required (1–255 chars)." } });
  }
  _validatePersonObj(payload.person, "person", payload.address?.country_code, issues, { requirePhone: true });
  if (payload.address) _validateAddressObj(payload.address, "address", issues);
  if (payload.identification) _validateIdentificationObj(payload.identification, "identification", issues);

  if (issues.length > 0) {
    const firstKey = Object.keys(issues[0])[0];
    throw new NuvionError({
      status: 422,
      type: "error_validation_error",
      message: issues[0][firstKey]?.message || "Individual entity validation failed",
      validations: issues,
    });
  }
  return true;
}

/**
 * Local pre-flight schema validation for POST /business-entities (X-API-Version: 2026-02-06).
 * Prevents 422 validation errors and 500 empty business_officers errors on live https://api.nuvion.co.
 */
function validateBusinessEntityPayload(payload) {
  const issues = [];
  if (!payload || typeof payload !== "object") {
    throw new NuvionError({ status: 422, type: "error_validation_error", message: "Business entity payload is required." });
  }
  const name = String(payload.name || "").trim();
  if (name.length < 1 || name.length > 255) {
    issues.push({ name: { type: "error_validation_required_field_missing", message: "Business display name is required (1–255 chars)." } });
  }
  const biz = payload.business;
  if (!biz || typeof biz !== "object") {
    issues.push({ business: { type: "error_validation_required_field_missing", message: "Business details object is required." } });
  } else {
    if (!String(biz.legal_name || "").trim() || String(biz.legal_name).length > 255) {
      issues.push({ "business.legal_name": { type: "error_validation_required_field_missing", message: "Business legal_name is required (1–255 chars)." } });
    }
    if (!String(biz.industry || "").trim() || String(biz.industry).length > 100) {
      issues.push({ "business.industry": { type: "error_validation_required_field_missing", message: "Business industry is required (1–100 chars)." } });
    }
    if (!_isValidEmailAddr(biz.email)) {
      issues.push({ "business.email": { type: "error_validation_email_invalid", message: "A valid business contact email is required." } });
    }
    if (biz.website !== undefined && biz.website !== null && biz.website !== "") {
      if (!_isValidHttpUrl(biz.website)) {
        issues.push({ "business.website": { type: "error_validation_invalid_format", message: "Business website must be a valid URL starting with https:// (or omit it)." } });
      }
    }
    if (!String(biz.type || "").trim()) {
      issues.push({ "business.type": { type: "error_validation_required_field_missing", message: "Business type (e.g. llc, corporation) is required." } });
    }
    if (!String(biz.description || "").trim() || String(biz.description).length > 1000) {
      issues.push({ "business.description": { type: "error_validation_required_field_missing", message: "Business description is required (1–1000 chars)." } });
    }
    if (!String(biz.registration_number || "").trim() || String(biz.registration_number).length > 255) {
      issues.push({ "business.registration_number": { type: "error_validation_required_field_missing", message: "Business registration_number is required." } });
    }
    if (biz.phonenumber !== undefined && biz.phonenumber !== null && biz.phonenumber !== "") {
      if (!_isValidNuvionPhone(biz.phonenumber)) {
        issues.push({ "business.phonenumber": { type: "error_validation_invalid_length", message: "Business phone number must include '+' and be 10–14 characters total." } });
      }
    }
    const inc = biz.incorporation_meta;
    const currentYear = new Date().getUTCFullYear();
    if (!inc || typeof inc !== "object") {
      issues.push({ "business.incorporation_meta": { type: "error_validation_required_field_missing", message: "incorporation_meta is required." } });
    } else {
      const yr = Number(inc.year);
      const mo = Number(inc.month);
      if (!Number.isInteger(yr) || yr < 1900 || yr > currentYear) {
        issues.push({ "business.incorporation_meta.year": { type: "error_validation_value_out_of_range", message: `Incorporation year must be between 1900 and ${currentYear}.` } });
      }
      if (!Number.isInteger(mo) || mo < 1 || mo > 12) {
        issues.push({ "business.incorporation_meta.month": { type: "error_validation_value_out_of_range", message: "Incorporation month must be between 1 and 12." } });
      }
      if (!_isValidIso2(inc.country)) {
        issues.push({ "business.incorporation_meta.country": { type: "error_validation_invalid_format", message: "Incorporation country must be a 2-letter uppercase ISO code." } });
      }
      if (typeof inc.state !== "string" || inc.state.length > 100) {
        issues.push({ "business.incorporation_meta.state": { type: "error_validation_required_field_missing", message: "Incorporation state is required (max 100 chars)." } });
      }
    }
  }

  if (payload.address) _validateAddressObj(payload.address, "address", issues);
  if (payload.operating_address) _validateAddressObj(payload.operating_address, "operating_address", issues);

  if (payload.business_officers !== undefined) {
    if (!Array.isArray(payload.business_officers) || payload.business_officers.length === 0) {
      // Nuvion returns 500 error_system_internal_error on empty business_officers array!
      issues.push({ business_officers: { type: "error_validation_invalid_format", message: "business_officers cannot be empty; include at least one officer or omit the field." } });
    } else {
      payload.business_officers.forEach((off, idx) => {
        const pfx = `business_officers[${idx}]`;
        if (!String(off?.job_title || "").trim() || String(off.job_title).length > 100) {
          issues.push({ [`${pfx}.job_title`]: { type: "error_validation_required_field_missing", message: "Officer job_title is required (1–100 chars)." } });
        }
        if (typeof off?.is_control_person !== "boolean") {
          issues.push({ [`${pfx}.is_control_person`]: { type: "error_validation_required_field_missing", message: "Officer is_control_person boolean is required." } });
        }
        if (typeof off?.is_beneficial_owner !== "boolean") {
          issues.push({ [`${pfx}.is_beneficial_owner`]: { type: "error_validation_required_field_missing", message: "Officer is_beneficial_owner boolean is required." } });
        }
        const pct = Number(off?.ownership_percentage);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          issues.push({ [`${pfx}.ownership_percentage`]: { type: "error_validation_value_out_of_range", message: "Officer ownership_percentage must be 0–100." } });
        }
        if (!off?.person_id && !off?.person) {
          issues.push({ [pfx]: { type: "error_validation_invalid_format", message: "Each officer must include either person or person_id." } });
        } else if (off?.person) {
          _validatePersonObj(off.person, `${pfx}.person`, off.person.address?.country_code || payload.address?.country_code, issues, { requirePhone: false });
          if (off.person.address) _validateAddressObj(off.person.address, `${pfx}.person.address`, issues);
          if (off.person.identification) _validateIdentificationObj(off.person.identification, `${pfx}.person.identification`, issues);
        }
      });
    }
  }

  if (issues.length > 0) {
    const firstKey = Object.keys(issues[0])[0];
    throw new NuvionError({
      status: 422,
      type: "error_validation_error",
      message: issues[0][firstKey]?.message || "Business entity validation failed",
      validations: issues,
    });
  }
  return true;
}

async function createIndividualEntity(payload, { validate = null } = {}) {
  const shouldValidate = validate === null ? getEnvironment() === "production" : Boolean(validate);
  if (shouldValidate) validateIndividualEntityPayload(payload);
  const res = await nuvionRequest({ method: "POST", path: "/individual-entities", data: payload, role: "admin" });
  return res.data;
}

async function updateIndividualEntity(entityId, payload) {
  const res = await nuvionRequest({ method: "PATCH", path: `/individual-entities/${encodeURIComponent(entityId)}`, data: payload, role: "admin" });
  return res.data;
}

async function createBusinessEntity(payload, { validate = null } = {}) {
  const shouldValidate = validate === null ? getEnvironment() === "production" : Boolean(validate);
  if (shouldValidate) validateBusinessEntityPayload(payload);
  const res = await nuvionRequest({ method: "POST", path: "/business-entities", data: payload, role: "admin" });
  return res.data;
}

async function updateBusinessEntity(entityId, payload) {
  const res = await nuvionRequest({ method: "PATCH", path: `/business-entities/${encodeURIComponent(entityId)}`, data: payload, role: "admin" });
  return res.data;
}

async function uploadDocument({ entityId, key, description, fileBase64, fileBackBase64 = null, fileType = "image/jpeg", personId = null }) {
  if (!entityId) {
    throw new NuvionError({ status: 422, type: "error_validation_required_field_missing", message: "entityId is required for document upload." });
  }
  const cleanFileType = String(fileType || "").trim().toLowerCase();
  if (!ALLOWED_DOCUMENT_MIME_TYPES.has(cleanFileType)) {
    throw new NuvionError({
      status: 422,
      type: "error_validation_value_not_supported",
      message: `Unsupported document file type "${fileType}". Accepted formats: PDF, JPG, JPEG, PNG, DOC, DOCX.`,
    });
  }
  const cleanDesc = String(description || key || "Verification document").trim().slice(0, 500);
  if (!fileBase64 || typeof fileBase64 !== "string") {
    throw new NuvionError({ status: 422, type: "error_validation_required_field_missing", message: "Document file content is required." });
  }

  const body = {
    entity_id: entityId,
    key,
    description: cleanDesc,
    file: fileBase64,
    meta: { file_type: cleanFileType },
  };
  if (fileBackBase64) body.file_back = fileBackBase64;
  if (personId) body.link_to_identity = { person_id: personId };

  const res = await nuvionRequest({ method: "POST", path: "/documents", data: body, role: "admin", timeoutMs: 45000 });
  return res.data;
}

async function getOnboardingProgress(entityId) {
  const res = await nuvionRequest({
    method: "GET",
    path: "/onboarding-progress",
    entityId,
    role: "admin",
  });
  return res.data;
}

async function submitOnboarding(entityId) {
  const res = await nuvionRequest({ method: "POST", path: "/onboarding-submissions", data: { entity_id: entityId }, role: "admin" });
  return res.data;
}

async function listEntities({ type = null, name = null, limit = 20, cursor = null } = {}) {
  const res = await nuvionRequest({
    method: "GET",
    path: "/entities",
    params: { type, name, limit, cursor },
    role: "admin",
  });
  return res.data;
}

async function getEntity(entityId) {
  const res = await nuvionRequest({ method: "GET", path: `/entities/${encodeURIComponent(entityId)}`, role: "admin" });
  return res.data;
}

/**
 * Recover an entity ID after a timeout or 409 error_duplicate_resource by searching name
 * and confirming email via GET /entities/{id}.
 */
async function recoverEntityByName({ name, type = "individual", email = null }) {
  const listed = await listEntities({ type, name, limit: 20 });
  const items = listed?.data || [];
  for (const item of items) {
    if (!email) return item;
    try {
      const full = await getEntity(item.id);
      const foundEmail = (full?.person?.email || full?.business?.email || "").toLowerCase();
      if (foundEmail && foundEmail === String(email).trim().toLowerCase()) {
        return { ...item, ...full };
      }
    } catch (_) {}
  }
  return null;
}

// ── 2. Accounts & Account Details ─────────────────────────────────────────────

async function createAccount({ entityId = null, type = "checking", currency, displayName, meta = {} }) {
  const res = await nuvionRequest({
    method: "POST",
    path: "/accounts",
    entityId,
    data: {
      type,
      currency: String(currency).toUpperCase(),
      display_name: displayName,
      meta,
    },
    role: "operations",
  });
  return res.data?.account || res.data;
}

async function listAccounts({ entityId = null, currency = null, displayName = null, limit = 50, cursor = null } = {}) {
  const res = await nuvionRequest({
    method: "GET",
    path: "/accounts",
    entityId,
    params: {
      currency: currency ? String(currency).toUpperCase() : undefined,
      display_name: displayName || undefined,
      limit,
      cursor,
    },
    role: "operations",
  });
  return res.data;
}

async function getAccount(accountId, entityId = null) {
  const res = await nuvionRequest({
    method: "GET",
    path: `/accounts/${encodeURIComponent(accountId)}`,
    entityId,
    role: "operations",
  });
  return res.data?.account || res.data;
}

async function createAccountDetails({ accountId, entityId = null, chain = null, assetType = null }) {
  const body = { account_id: accountId };
  if (chain) body.chain = String(chain).toLowerCase();
  if (assetType) body.asset_type = assetType;

  const res = await nuvionRequest({
    method: "POST",
    path: "/account-details",
    entityId,
    data: body,
    role: "operations",
  });
  return res.data?.account_details || res.data?.account_detail || res.data;
}

async function listAccountDetails({ accountId = null, entityId = null, limit = 100 } = {}) {
  // Note: Nuvion cursor paging is not supported on GET /account-details yet; pass limit=100.
  const res = await nuvionRequest({
    method: "GET",
    path: "/account-details",
    entityId,
    params: { account_id: accountId || undefined, limit },
    role: "operations",
  });
  return res.data;
}

async function getAccountDetails(detailId, entityId = null) {
  const res = await nuvionRequest({
    method: "GET",
    path: `/account-details/${encodeURIComponent(detailId)}`,
    entityId,
    role: "operations",
  });
  // Nuvion quirk: GET /account-details/{id} keys under `account_detail` (singular).
  return res.data?.account_detail || res.data?.account_details || res.data;
}

// ── 3. Counterparties & Payment Details ───────────────────────────────────────

async function createCounterparty({ entityId = null, type = "individual", nickname = null, profile }) {
  const body = { type, profile };
  if (nickname) body.nickname = nickname;
  const res = await nuvionRequest({
    method: "POST",
    path: "/counterparties",
    entityId,
    data: body,
    role: "operations",
  });
  return res.data;
}

async function listCounterparties({ entityId = null, search = null, limit = 50, cursor = null } = {}) {
  const res = await nuvionRequest({
    method: "GET",
    path: "/counterparties",
    entityId,
    params: { search, limit, cursor },
    role: "operations",
  });
  return res.data;
}

async function createPaymentDetail({ entityId = null, ...details }) {
  const res = await nuvionRequest({
    method: "POST",
    path: "/payment-details",
    entityId,
    data: details,
    role: "operations",
  });
  return res.data;
}

async function listPaymentDetails(counterpartyId, { entityId = null, limit = 50 } = {}) {
  const res = await nuvionRequest({
    method: "GET",
    path: `/counterparties/${encodeURIComponent(counterpartyId)}/payment-details`,
    entityId,
    params: { limit },
    role: "operations",
  });
  return res.data;
}

// ── 4. FX Quotes ──────────────────────────────────────────────────────────────

async function createFxQuote({ entityId = null, fromCurrency, toCurrency, amountFrom = null, amountTo = null, accountId = null }) {
  const from = String(fromCurrency || "").toUpperCase();
  const to = String(toCurrency || "").toUpperCase();
  if (!from || !to) throw new Error("fromCurrency and toCurrency are required");
  if (from === to) {
    throw new NuvionError({
      status: 422,
      type: "error_fx_currency_pair_unsupported",
      message: "from_currency and to_currency must differ",
    });
  }
  if ((amountFrom != null && amountTo != null) || (amountFrom == null && amountTo == null)) {
    throw new Error("Provide exactly one of amountFrom or amountTo (in minor units)");
  }

  const body = { from_currency: from, to_currency: to };
  if (amountFrom != null) body.amount_from = Math.round(Number(amountFrom));
  if (amountTo != null) body.amount_to = Math.round(Number(amountTo));
  if (accountId) body.account_id = accountId;

  const res = await nuvionRequest({
    method: "POST",
    path: "/fx-quotes",
    entityId,
    data: body,
    role: "operations",
  });
  return res.data;
}

async function getFxQuote(quoteId, entityId = null) {
  const res = await nuvionRequest({
    method: "GET",
    path: `/fx-quotes/${encodeURIComponent(quoteId)}`,
    entityId,
    role: "operations",
  });
  return res.data;
}

// ── 5. Transfers (Bank, MoMo, Stablecoin, Book) ───────────────────────────────

async function createTransfer({
  entityId = null,
  accountId,
  counterpartyId,
  paymentDetailId,
  amountMinor,
  currency,
  narration,
  paymentType,
  uniqueReference,
  fxQuoteId = null,
  supplementaryData = null,
  meta = null,
}) {
  const body = {
    account_id: accountId,
    counterparty_id: counterpartyId,
    payment_detail_id: paymentDetailId,
    amount: Math.round(Number(amountMinor)),
    currency: String(currency).toUpperCase(),
    narration: narration || "Proxim transfer",
    payment_type: paymentType,
    unique_reference: uniqueReference,
  };
  if (fxQuoteId) body.fx_quote_id = fxQuoteId;
  if (supplementaryData) body.supplementary_data = supplementaryData;
  if (meta) body.meta = meta;

  const res = await nuvionRequest({
    method: "POST",
    path: "/transfers",
    entityId,
    data: body,
    role: "operations",
  });
  return res.data;
}

async function getTransfer(transferId, entityId = null) {
  const res = await nuvionRequest({
    method: "GET",
    path: `/transfers/${encodeURIComponent(transferId)}`,
    entityId,
    role: "operations",
  });
  return res.data;
}

async function listTransfers({
  entityId = null,
  type = null,
  paymentType = null,
  uniqueReference = null,
  accountId = null,
  dateFrom = null,
  dateTo = null,
  sortOrder = null,
  limit = 20,
  cursor = null,
} = {}) {
  const res = await nuvionRequest({
    method: "GET",
    path: "/transfers",
    entityId,
    params: {
      type,
      payment_type: paymentType,
      unique_reference: uniqueReference,
      account_id: accountId,
      date_from: dateFrom,
      date_to: dateTo,
      sort_order: sortOrder,
      limit,
      cursor,
    },
    role: "operations",
  });
  return res.data;
}

async function recoverTransferByReference(uniqueReference, entityId = null) {
  const listed = await listTransfers({ entityId, uniqueReference, limit: 5 });
  const rows = listed?.data || [];
  return rows[0] || null;
}

// ── 6. Funding Sessions (Open Banking, Interac, MoMo, Crypto) ─────────────────

async function createFundingSession({
  entityId = null,
  accountId,
  amountMinor,
  currency,
  fundingType = null,
  uniqueReference,
  narration,
  countryCode = null,
  redirectUrl = null,
  meta = null,
}) {
  const body = {
    account_id: accountId,
    amount: Math.round(Number(amountMinor)),
    currency: String(currency).toUpperCase(),
    unique_reference: uniqueReference,
    narration: narration || "Proxim deposit",
  };
  if (fundingType) body.funding_type = fundingType;
  if (countryCode) body.country_code = countryCode;
  if (redirectUrl) body.redirect_url = redirectUrl;
  if (meta) body.meta = meta;

  const res = await nuvionRequest({
    method: "POST",
    path: "/funding-sessions",
    entityId,
    data: body,
    role: "operations",
  });
  return res.data;
}

async function getFundingSession(sessionId, entityId = null) {
  const res = await nuvionRequest({
    method: "GET",
    path: `/funding-sessions/${encodeURIComponent(sessionId)}`,
    entityId,
    role: "operations",
  });
  return res.data;
}

/**
 * Interac-specific refresh: PATCH /funding-sessions/{id}, falling back cleanly
 * to GET when the session has already reached a final state (400 error_funding_request_not_pending).
 */
async function refreshInteracSession(sessionId, entityId = null) {
  try {
    const res = await nuvionRequest({
      method: "PATCH",
      path: `/funding-sessions/${encodeURIComponent(sessionId)}`,
      entityId,
      role: "operations",
    });
    return res.data;
  } catch (err) {
    if (err instanceof NuvionError && err.status === 400 && err.type === "error_funding_request_not_pending") {
      return getFundingSession(sessionId, entityId);
    }
    throw err;
  }
}

async function listFundingSessions({ entityId = null, accountId = null, limit = 20, cursor = null } = {}) {
  const res = await nuvionRequest({
    method: "GET",
    path: "/funding-sessions",
    entityId,
    params: { account_id: accountId, limit, cursor },
    role: "operations",
  });
  return res.data;
}

// ── 7. Cards (Virtual & Disposable USD Cards) ─────────────────────────────────

async function getCardCreationFee(accountId, { currency = "USD", entityId = null } = {}) {
  const res = await nuvionRequest({
    method: "GET",
    path: `/card-creation-fee/${encodeURIComponent(accountId)}`,
    entityId,
    params: { currency: String(currency).toUpperCase() },
    role: "operations",
  });
  return res.data;
}

async function createVirtualCard({ entityId = null, accountId, cardName, currency = "USD", cardholder, expirationMonth = null, expirationYear = null }) {
  const body = { account_id: accountId, card_name: cardName, currency: String(currency).toUpperCase(), cardholder };
  if (expirationMonth) body.expiration_month = String(expirationMonth);
  if (expirationYear) body.expiration_year = String(expirationYear);
  const res = await nuvionRequest({ method: "POST", path: "/virtual-cards", entityId, data: body, role: "operations" });
  return res.data;
}

async function createDisposableCard({ entityId = null, accountId, cardName, currency = "USD", cardholder, expirationMonth = null, expirationYear = null }) {
  const body = { account_id: accountId, card_name: cardName, currency: String(currency).toUpperCase(), cardholder };
  if (expirationMonth) body.expiration_month = String(expirationMonth);
  if (expirationYear) body.expiration_year = String(expirationYear);
  const res = await nuvionRequest({ method: "POST", path: "/disposable-cards", entityId, data: body, role: "operations" });
  return res.data;
}

async function listCards({ entityId = null, accountId = null, limit = 20, cursor = null } = {}) {
  const res = await nuvionRequest({
    method: "GET",
    path: "/cards",
    entityId,
    params: { account_id: accountId, limit, cursor },
    role: "operations",
  });
  return res.data;
}

async function getCardDetails(cardId, entityId = null) {
  // WARNING: returns raw PAN (number) & CVV. Caller MUST NEVER log or store them!
  const res = await nuvionRequest({
    method: "GET",
    path: `/card-details/${encodeURIComponent(cardId)}`,
    entityId,
    role: "operations",
  });
  return res.data;
}

async function getCardTransactions(cardId, { entityId = null, limit = 20, cursor = null } = {}) {
  const res = await nuvionRequest({
    method: "GET",
    path: `/card-transactions/${encodeURIComponent(cardId)}`,
    entityId,
    params: { limit, cursor },
    role: "operations",
  });
  return res.data;
}

async function freezeCard(cardId, entityId = null) {
  const res = await nuvionRequest({ method: "PATCH", path: `/card-details/${encodeURIComponent(cardId)}/freeze`, entityId, role: "operations" });
  return res.data;
}

async function unfreezeCard(cardId, entityId = null) {
  const res = await nuvionRequest({ method: "PATCH", path: `/card-details/${encodeURIComponent(cardId)}/unfreeze`, entityId, role: "operations" });
  return res.data;
}

async function reassignCard(cardId, newAccountId, entityId = null) {
  const res = await nuvionRequest({
    method: "PATCH",
    path: `/cards/${encodeURIComponent(cardId)}/account`,
    entityId,
    data: { account_id: newAccountId },
    role: "operations",
  });
  return res.data;
}

async function deleteCard(cardId, entityId = null) {
  const res = await nuvionRequest({ method: "DELETE", path: `/card-details/${encodeURIComponent(cardId)}`, entityId, role: "operations" });
  return res.data;
}

// ── 8. Webhooks Management ────────────────────────────────────────────────────

async function createWebhook({ url, enabledEvents = { all: true }, description = "Proxim Global Webhook", expiresIn = null, entityId = null }) {
  const body = { url, enabled_events: enabledEvents, description };
  if (expiresIn) body.expires_in = expiresIn;
  const res = await nuvionRequest({ method: "POST", path: "/entity-webhooks", entityId, data: body, role: "developer" });
  return res.data;
}

async function updateWebhook(webhookId, fields = {}, entityId = null) {
  const res = await nuvionRequest({
    method: "PATCH",
    path: `/entity-webhooks/${encodeURIComponent(webhookId)}`,
    entityId,
    data: fields,
    role: "developer",
  });
  return res.data;
}

async function getWebhook(webhookId, entityId = null) {
  const res = await nuvionRequest({ method: "GET", path: `/entity-webhooks/${encodeURIComponent(webhookId)}`, entityId, role: "developer" });
  return res.data;
}

async function listWebhooks({ entityId = null, limit = 20, cursor = null } = {}) {
  const res = await nuvionRequest({
    method: "GET",
    path: "/entity-webhooks",
    entityId,
    params: { limit, cursor },
    role: "developer",
  });
  return res.data;
}

async function deleteWebhook(webhookId, entityId = null) {
  const res = await nuvionRequest({ method: "DELETE", path: `/entity-webhooks/${encodeURIComponent(webhookId)}`, entityId, role: "developer" });
  return res.data;
}

async function listWebhookLogs({ entityWebhookId = null, createdFrom = null, createdTo = null, limit = 50, cursor = null } = {}) {
  const res = await nuvionRequest({
    method: "GET",
    path: "/webhook-logs",
    params: {
      entity_webhook_id: entityWebhookId,
      created_from: createdFrom,
      created_to: createdTo,
      limit,
      cursor,
    },
    role: "developer",
  });
  return res.data;
}

async function sendTestWebhook({ entityWebhookId, eventGroup = "inflows", eventName = "completed" }) {
  const res = await nuvionRequest({
    method: "POST",
    path: "/webhook-tests",
    data: {
      entity_webhook_id: entityWebhookId,
      event_group: eventGroup,
      event_name: eventName,
    },
    role: "developer",
  });
  return res;
}

// An account detail is usable once it carries bank coordinates, unless its status is
// explicitly a dead/failed one. Nuvion's "ready" status word is not documented here, so we
// must not require the literal "active" (a ready account with a number was shown as pending).
const DEAD_DETAIL_STATUSES = new Set(["inactive", "closed", "deleted", "deactivated", "failed", "rejected", "cancelled", "canceled", "suspended", "blocked", "disabled"]);
function isAccountDetailReady(detail) {
  if (!detail) return false;
  const hasCoords = !!(detail.account_number || detail.iban);
  if (!hasCoords) return false;
  return !DEAD_DETAIL_STATUSES.has(String(detail.status || "").toLowerCase());
}

/** True when Nuvion has explicitly marked the detail as not usable (e.g. "inactive"). */
function isAccountDetailDead(detail) {
  return !!detail && DEAD_DETAIL_STATUSES.has(String(detail.status || "").toLowerCase());
}

/** Human-readable status_reason from a live detail or a stored row's raw_meta_json. */
function getAccountDetailStatusReason(detail) {
  if (!detail) return null;
  let reason = detail.status_reason;
  if (reason === undefined && detail.raw_meta_json) {
    try { reason = JSON.parse(detail.raw_meta_json)?.status_reason; } catch (_) {}
  }
  if (reason === undefined || reason === null || reason === "") return null;
  if (typeof reason === "string") return reason.slice(0, 300);
  if (typeof reason === "object") {
    const text = reason.message || reason.description || reason.reason || reason.code;
    return String(text || JSON.stringify(reason)).slice(0, 300);
  }
  return String(reason).slice(0, 300);
}

module.exports = {
  isAccountDetailReady,
  isAccountDetailDead,
  getAccountDetailStatusReason,
  NuvionError,
  DEFAULT_API_VERSION,
  DEFAULT_FX_MARGIN_BPS,
  SUPPORTED_FIAT_RECEIVING_CURRENCIES,
  ALLOWED_DOCUMENT_MIME_TYPES,
  STABLECOIN_CHAIN_TO_NETWORK,
  getEnvironment,
  getBaseUrl,
  getApiVersion,
  getApiKey,
  isNuvionConfigured,
  isPublicLaunchEnabled,
  isUserAllowedNuvion,
  getFxMarginBps,
  toNuvionMinor,
  fromNuvionMinor,
  calcMarginMinor,
  verifyWebhookSignature,
  formatUserFriendlyError,
  nuvionRequest,
  // Entities
  validateIndividualEntityPayload,
  validateBusinessEntityPayload,
  createIndividualEntity,
  updateIndividualEntity,
  createBusinessEntity,
  updateBusinessEntity,
  uploadDocument,
  getOnboardingProgress,
  submitOnboarding,
  listEntities,
  getEntity,
  recoverEntityByName,
  // Accounts & Details
  createAccount,
  listAccounts,
  getAccount,
  createAccountDetails,
  listAccountDetails,
  getAccountDetails,
  // Counterparties & Payment Details
  createCounterparty,
  listCounterparties,
  createPaymentDetail,
  listPaymentDetails,
  // FX & Transfers
  createFxQuote,
  getFxQuote,
  createTransfer,
  getTransfer,
  listTransfers,
  recoverTransferByReference,
  // Funding Sessions
  createFundingSession,
  getFundingSession,
  refreshInteracSession,
  listFundingSessions,
  // Cards
  getCardCreationFee,
  createVirtualCard,
  createDisposableCard,
  listCards,
  getCardDetails,
  getCardTransactions,
  freezeCard,
  unfreezeCard,
  reassignCard,
  deleteCard,
  // Webhooks
  createWebhook,
  updateWebhook,
  getWebhook,
  listWebhooks,
  deleteWebhook,
  listWebhookLogs,
  sendTestWebhook,
};
