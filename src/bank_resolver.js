// src/bank_resolver.js
// Resolves Nigerian bank names and aliases to 6-digit NIBSS bank codes.
// Supports commercial banks, digital neobanks (Kuda, OPay, PalmPay, Moniepoint),
// and integrates with Paj v2 getBanks API for live directory fallback.

const paj = require("./paj");

// Static dictionary of top Nigerian commercial banks & fintechs
const KNOWN_BANKS = {
  // Top Tier 1 Commercial Banks
  "000013": ["gtbank", "gtb", "guaranty trust bank", "guaranty trust"],
  "000014": ["access bank", "access", "access diamond", "diamond bank"],
  "000015": ["zenith bank", "zenith"],
  "000016": ["first bank", "first bank of nigeria", "fbn"],
  "000004": ["uba", "united bank for africa"],

  // Neobanks & Fintechs
  "090267": ["kuda", "kuda bank", "kuda microfinance bank"],
  "100004": ["opay", "paycom"],
  "100033": ["palmpay", "palm pay"],
  "090405": ["moniepoint", "moniepoint mfb", "moniepoint microfinance bank"],
  "090110": ["vfd", "vfd microfinance bank", "vbank"],
  "090177": ["carbon", "one finance"],
  "090551": ["fairmoney", "fairmoney microfinance bank"],
  "090701": ["dot", "dot microfinance bank"],

  // Commercial & Merchant Banks
  "000012": ["stanbic", "stanbic ibtc", "stanbic ibtc bank"],
  "000001": ["sterling", "sterling bank"],
  "000003": ["fcmb", "first city monument bank"],
  "000007": ["fidelity", "fidelity bank"],
  "000017": ["wema", "wema bank", "alat"],
  "000018": ["union bank", "union"],
  "000010": ["ecobank", "ecobank nigeria"],
  "000008": ["polaris", "polaris bank", "skye bank"],
  "000002": ["keystone", "keystone bank"],
  "000011": ["unity", "unity bank"],
  "000023": ["providus", "providus bank"],
  "000026": ["taj", "taj bank"],
  "000006": ["jaiz", "jaiz bank"],
  "000020": ["heritage", "heritage bank"],
};

// In-memory cache for live Paj bank directory
let cachedLiveBanks = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve a bank name, code, or alias to a valid 6-digit NIBSS bank code.
 *
 * @param {string} input - Bank name (e.g. "GTBank", "OPay", "Access") or numeric code
 * @returns {Promise<{ bankCode: string, bankName: string }>}
 */
async function resolveBankCode(input) {
  if (!input) {
    return { bankCode: "000013", bankName: "Guaranty Trust Bank" }; // Default fallback
  }

  const raw = String(input).trim();
  const clean = normalize(raw);

  // 1. If already numeric
  if (/^\d+$/.test(raw)) {
    const padded = raw.padStart(6, "0");
    for (const [code, aliases] of Object.entries(KNOWN_BANKS)) {
      if (code === padded || code.endsWith(raw)) {
        return { bankCode: code, bankName: aliases[0].toUpperCase() };
      }
    }
    return { bankCode: padded, bankName: `Bank (${padded})` };
  }

  // 2. Exact or substring match in static dictionary
  for (const [code, aliases] of Object.entries(KNOWN_BANKS)) {
    for (const alias of aliases) {
      const normAlias = normalize(alias);
      if (clean === normAlias || clean.includes(normAlias) || normAlias.includes(clean)) {
        return {
          bankCode: code,
          bankName: aliases[0].toUpperCase(),
        };
      }
    }
  }

  // 3. Query Paj live banks directory
  try {
    const now = Date.now();
    if (!cachedLiveBanks || now - lastCacheTime > CACHE_TTL_MS) {
      cachedLiveBanks = await paj.getBanks({ country: "NG" });
      lastCacheTime = now;
    }

    if (Array.isArray(cachedLiveBanks) && cachedLiveBanks.length > 0) {
      // Find matching bank by name
      const matched = cachedLiveBanks.find((b) => {
        const bName = normalize(b.name);
        return bName.includes(clean) || clean.includes(bName);
      });

      if (matched && matched.code) {
        return {
          bankCode: String(matched.code).padStart(6, "0"),
          bankName: matched.name,
        };
      }
    }
  } catch (err) {
    // If live lookup fails, keep going
  }

  // 4. Default to standard GTBank if completely unresolved
  return { bankCode: "000013", bankName: raw || "GTBank" };
}

/**
 * Parse arbitrary user input for a 10-digit Nigerian account number and bank name.
 * Handles diverse formats:
 * - "GTBank · 0123456789 · John Doe"
 * - "0123456789 GTBank"
 * - "Kuda 2001234567"
 * - "0123456789, Access Bank"
 * - "Palmpay 8715461871"
 *
 * @param {string} text
 * @returns {Promise<{ accountNumber: string|null, bankCode: string, bankName: string, accountName: string|null }>}
 */
async function parseBankDetails(text) {
  if (!text || typeof text !== "string") {
    return { accountNumber: null, bankCode: "000013", bankName: "Guaranty Trust Bank", accountName: null };
  }

  const raw = text.trim();

  // Find 10-digit account number anywhere in string
  const acctMatch = raw.match(/\b\d{10}\b/);
  const accountNumber = acctMatch ? acctMatch[0] : null;

  // Split by standard delimiters
  const segments = raw.split(/[·\-,|\n]/).map(s => s.trim()).filter(Boolean);

  let bankQuery = "";
  let accountName = null;

  if (segments.length >= 2) {
    // Check segments for account number vs bank vs name
    const remaining = [];
    for (const seg of segments) {
      if (seg.replace(/\D/g, "") === accountNumber) continue;
      remaining.push(seg);
    }
    if (remaining.length >= 1) {
      bankQuery = remaining[0];
    }
    if (remaining.length >= 2) {
      accountName = remaining.slice(1).join(" ");
    }
  } else if (accountNumber) {
    // Single segment containing account number and bank words
    bankQuery = raw.replace(accountNumber, "").replace(/[^a-zA-Z0-9\s]/g, " ").trim();
  } else {
    bankQuery = raw;
  }

  const resolved = await resolveBankCode(bankQuery);

  return {
    accountNumber,
    bankCode: resolved.bankCode,
    bankName: resolved.bankName,
    accountName: accountName || null,
  };
}

module.exports = {
  resolveBankCode,
  parseBankDetails,
  KNOWN_BANKS,
};

