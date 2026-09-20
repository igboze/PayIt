// src/bank_resolver.js
// Resolves Nigerian bank names and aliases to 6-digit NIBSS bank codes.
// Supports commercial banks, digital neobanks (Kuda, OPay, PalmPay, Moniepoint),
// and integrates with Paj v2 getBanks API for live directory lookup.

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

const STOP_WORDS = new Set(["bank", "mfb", "microfinance", "plc", "ltd", "limited", "nigeria", "the", "for", "and"]);

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
 * @returns {Promise<{ bankCode: string, bankName: string }|null>}
 */
async function resolveBankCode(input) {
  if (!input) {
    return null;
  }

  const raw = String(input).trim();
  if (!raw) {
    return null;
  }

  const clean = normalize(raw);
  if (!clean || STOP_WORDS.has(clean)) {
    return null;
  }

  // 1. If already numeric
  if (/^\d+$/.test(raw)) {
    const padded = raw.padStart(6, "0");
    for (const [code, aliases] of Object.entries(KNOWN_BANKS)) {
      if (code === padded || code.endsWith(raw)) {
        return { bankCode: code, bankName: aliases[0].toUpperCase() };
      }
    }
    // Check Paj live directory for numeric code
    if (process.env.PAJCASH_API_KEY) {
      try {
        const now = Date.now();
        if (!cachedLiveBanks || now - lastCacheTime > CACHE_TTL_MS) {
          cachedLiveBanks = await paj.getBanks({ country: "NG" });
          lastCacheTime = now;
        }
        if (Array.isArray(cachedLiveBanks) && cachedLiveBanks.length > 0) {
          const matched = cachedLiveBanks.find(
            (b) => String(b.code || "").padStart(6, "0") === padded || String(b.code || "") === raw
          );
          if (matched) {
            return {
              bankCode: String(matched.code).padStart(6, "0"),
              bankName: matched.name,
            };
          }
        }
      } catch {
        // Ignore directory query failure
      }
    }
    if (padded.length === 6) {
      return { bankCode: padded, bankName: `Bank (${padded})` };
    }
    return null;
  }

  // 2. Exact match in static dictionary
  for (const [code, aliases] of Object.entries(KNOWN_BANKS)) {
    for (const alias of aliases) {
      const normAlias = normalize(alias);
      if (clean === normAlias) {
        return {
          bankCode: code,
          bankName: aliases[0].toUpperCase(),
        };
      }
    }
  }

  // 3. Substring match (user input contains the bank alias, e.g. "Access Bank Nigeria PLC")
  for (const [code, aliases] of Object.entries(KNOWN_BANKS)) {
    for (const alias of aliases) {
      const normAlias = normalize(alias);
      if (normAlias.length >= 3 && clean.includes(normAlias)) {
        return {
          bankCode: code,
          bankName: aliases[0].toUpperCase(),
        };
      }
    }
  }

  // 4. Prefix match on alias (e.g. user typed "stanbi" for "stanbic", with length >= 4 and not a stop word)
  if (clean.length >= 4) {
    for (const [code, aliases] of Object.entries(KNOWN_BANKS)) {
      for (const alias of aliases) {
        const normAlias = normalize(alias);
        if (normAlias.startsWith(clean)) {
          return {
            bankCode: code,
            bankName: aliases[0].toUpperCase(),
          };
        }
      }
    }
  }

  // 5. Query Paj live banks directory if API key is present
  if (process.env.PAJCASH_API_KEY) {
    try {
      const now = Date.now();
      if (!cachedLiveBanks || now - lastCacheTime > CACHE_TTL_MS) {
        cachedLiveBanks = await paj.getBanks({ country: "NG" });
        lastCacheTime = now;
      }

      if (Array.isArray(cachedLiveBanks) && cachedLiveBanks.length > 0) {
        const matched = cachedLiveBanks.find((b) => {
          const bName = normalize(b.name);
          return (
            bName === clean ||
            (bName.length >= 3 && clean.includes(bName)) ||
            (clean.length >= 4 && bName.startsWith(clean))
          );
        });

        if (matched && matched.code) {
          return {
            bankCode: String(matched.code).padStart(6, "0"),
            bankName: matched.name,
          };
        }
      }
    } catch {
      // If live lookup fails, continue
    }
  }

  // Unresolved
  return null;
}

/**
 * Parse arbitrary user input for a 10-digit Nigerian account number and bank name.
 * Handles diverse formats without assuming segment order:
 * - "John Doe · 0123456789 · GTBank"
 * - "GTBank · 0123456789 · John Doe"
 * - "0123456789 GTBank John Doe"
 * - "Kuda 2001234567"
 * - "0123456789, Access Bank"
 * - "Palmpay 8715461871"
 *
 * @param {string} text
 * @returns {Promise<{ accountNumber: string|null, bankCode: string|null, bankName: string|null, accountName: string|null }>}
 */
async function parseBankDetails(text) {
  if (!text || typeof text !== "string") {
    return { accountNumber: null, bankCode: null, bankName: null, accountName: null };
  }

  const raw = text.trim();

  // Find 10-digit account number anywhere in string
  const acctMatch = raw.match(/\b\d{10}\b/);
  const accountNumber = acctMatch ? acctMatch[0] : null;

  // Split by standard delimiters
  const segments = raw.split(/[·\-,|\n]/).map((s) => s.trim()).filter(Boolean);

  let bankCode = null;
  let bankName = null;
  let accountName = null;

  if (segments.length >= 2) {
    // Filter out the account number segment
    const candidateSegments = segments.filter((seg) => seg.replace(/\D/g, "") !== accountNumber);

    let bankSegmentIndex = -1;
    let bankResolution = null;

    // Pass 1: exact match on known bank aliases
    for (let i = 0; i < candidateSegments.length; i++) {
      const segNorm = normalize(candidateSegments[i]);
      if (!segNorm || STOP_WORDS.has(segNorm)) continue;

      for (const [code, aliases] of Object.entries(KNOWN_BANKS)) {
        for (const alias of aliases) {
          if (segNorm === normalize(alias)) {
            bankResolution = { bankCode: code, bankName: aliases[0].toUpperCase() };
            bankSegmentIndex = i;
            break;
          }
        }
        if (bankResolution) break;
      }
      if (bankResolution) break;
    }

    // Pass 2: full resolveBankCode on segments
    if (!bankResolution) {
      for (let i = 0; i < candidateSegments.length; i++) {
        const seg = candidateSegments[i];
        const res = await resolveBankCode(seg);
        if (res && res.bankCode) {
          bankResolution = res;
          bankSegmentIndex = i;
          break;
        }
      }
    }

    if (bankResolution) {
      bankCode = bankResolution.bankCode;
      bankName = bankResolution.bankName;
      const nameParts = candidateSegments.filter((_, idx) => idx !== bankSegmentIndex);
      if (nameParts.length > 0) {
        accountName = nameParts.join(" ");
      }
    } else {
      if (candidateSegments.length > 0) {
        accountName = candidateSegments.join(" ");
      }
    }
  } else {
    // Single segment or freeform text
    let remainingText = raw;
    if (accountNumber) {
      remainingText = remainingText.replace(accountNumber, " ");
    }
    remainingText = remainingText.replace(/[^a-zA-Z0-9\s]/g, " ").trim();

    const words = remainingText.split(/\s+/).filter(Boolean);
    let matchedBank = null;
    let matchedWordsCount = 0;
    let matchedWordStartIndex = -1;

    // First, look for EXACT matches on KNOWN_BANKS aliases from longest phrase to shortest
    for (let len = Math.min(4, words.length); len >= 1; len--) {
      for (let i = 0; i <= words.length - len; i++) {
        const candidateNorm = normalize(words.slice(i, i + len).join(" "));
        if (!candidateNorm || STOP_WORDS.has(candidateNorm)) continue;

        for (const [code, aliases] of Object.entries(KNOWN_BANKS)) {
          for (const alias of aliases) {
            if (candidateNorm === normalize(alias)) {
              matchedBank = { bankCode: code, bankName: aliases[0].toUpperCase() };
              matchedWordsCount = len;
              matchedWordStartIndex = i;
              break;
            }
          }
          if (matchedBank) break;
        }
        if (matchedBank) break;
      }
      if (matchedBank) break;
    }

    // If still not matched, check resolveBankCode for candidates
    if (!matchedBank) {
      for (let len = Math.min(4, words.length); len >= 1; len--) {
        for (let i = 0; i <= words.length - len; i++) {
          const phrase = words.slice(i, i + len).join(" ");
          const res = await resolveBankCode(phrase);
          if (res && res.bankCode) {
            matchedBank = res;
            matchedWordsCount = len;
            matchedWordStartIndex = i;
            break;
          }
        }
        if (matchedBank) break;
      }
    }

    if (matchedBank) {
      bankCode = matchedBank.bankCode;
      bankName = matchedBank.bankName;
      const nonBankWords = [
        ...words.slice(0, matchedWordStartIndex),
        ...words.slice(matchedWordStartIndex + matchedWordsCount),
      ];
      if (nonBankWords.length > 0) {
        accountName = nonBankWords.join(" ");
      }
    } else if (remainingText.length > 0) {
      accountName = remainingText;
    }
  }

  return {
    accountNumber,
    bankCode,
    bankName,
    accountName: accountName || null,
  };
}

module.exports = {
  resolveBankCode,
  parseBankDetails,
  KNOWN_BANKS,
};
