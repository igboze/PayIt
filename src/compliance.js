// src/compliance.js
// Partner, Platform & Legal Compliance Controls for Proxim:
// 1. OFAC / FATF Sanctioned & Prohibited Jurisdiction Blocklist
// 2. Terms of Service & Privacy Policy versioning + consent helpers
// 3. Regulated-partner legal disclaimers ("financial technology platform, not a bank")

const TERMS_VERSION = process.env.PROXIM_TERMS_VERSION || "2026-11";
const WEBSITE_URL = "https://www.proximfi.xyz/";
const TERMS_URL = process.env.PROXIM_TERMS_URL || WEBSITE_URL;
const PRIVACY_URL = process.env.PROXIM_PRIVACY_URL || WEBSITE_URL;

// OFAC Comprehensive Sanctions + FATF Blacklist + High-Risk Partner-Restricted Corridors (ISO-3166-1 alpha-2)
const PROHIBITED_JURISDICTIONS = new Set([
  "KP", // North Korea
  "IR", // Iran
  "SY", // Syria
  "CU", // Cuba
  "RU", // Russia
  "BY", // Belarus
  "MM", // Myanmar
  "AF", // Afghanistan
  "VE", // Venezuela
  "YE", // Yemen
  "SD", // Sudan
  "SS", // South Sudan
  "SO", // Somalia
  "LY", // Libya
  "CF", // Central African Republic
  "CD", // Democratic Republic of the Congo
  "IQ", // Iraq
  "LB", // Lebanon
  "ZW", // Zimbabwe
]);

const LEGAL_BANKING_DISCLAIMER =
  "Proxim is a financial technology platform, not a bank. Regulated fiat accounts, cards, and cross-border settlement services are provided by licensed partner institutions.";

const KYC_CONSENT_FOOTER =
  `\n\n🔒 <i>Handled securely by <b>Nuvion</b> · Regulated partner verification · By continuing you agree to our Terms &amp; Privacy Policy (<a href="${WEBSITE_URL}">proximfi.xyz</a>). Your reply is auto-deleted after capture.</i>`;

function normalizeCountryCode(code) {
  return String(code || "").trim().toUpperCase();
}

function isSanctionedCountry(code) {
  const clean = normalizeCountryCode(code);
  if (!clean) return false;
  return PROHIBITED_JURISDICTIONS.has(clean);
}

function getSanctionedCountryMessage(code) {
  const clean = normalizeCountryCode(code) || "this jurisdiction";
  return (
    `⛔ <b>Jurisdiction Not Supported (${clean})</b>\n` +
    `──────────────────────────\n` +
    `Due to international sanctions and partner compliance regulations (OFAC/FATF), ` +
    `Tier 1 Global Accounts, USD Cards, and fiat corridors are not available for residents or entities registered in <b>${clean}</b>.\n\n` +
    `<i>${LEGAL_BANKING_DISCLAIMER}</i>`
  );
}

function buildLegalSummaryHtml() {
  return (
    `⚖️ <b>Proxim Legal, Terms &amp; Compliance</b>\n` +
    `──────────────────────────\n` +
    `• <b>Platform Role:</b> ${LEGAL_BANKING_DISCLAIMER}\n` +
    `• <b>Tier 0 vs Tier 1:</b> Unverified Tier 0 accounts are capped at local NGN &amp; standard limits. Global Bank Accounts, USD Cards, and international transfers require Tier 1 KYC/KYB verification.\n` +
    `• <b>Prohibited Use:</b> Sanctioned jurisdictions (OFAC/FATF), third-party fraud, unlicensed FX arbitrage, and illicit proceeds are strictly prohibited and subject to automated compliance holds.\n` +
    `• <b>Key Control:</b> Security phrases / private keys can be exported anytime via <code>/export_keys</code> (Self-Custodial Key Export Enabled).\n` +
    `• <b>Terms &amp; Privacy Policy (v${TERMS_VERSION}):</b> <a href="${TERMS_URL}">www.proximfi.xyz</a>`
  );
}

module.exports = {
  TERMS_VERSION,
  WEBSITE_URL,
  TERMS_URL,
  PRIVACY_URL,
  PROHIBITED_JURISDICTIONS,
  LEGAL_BANKING_DISCLAIMER,
  KYC_CONSENT_FOOTER,
  normalizeCountryCode,
  isSanctionedCountry,
  getSanctionedCountryMessage,
  buildLegalSummaryHtml,
};
