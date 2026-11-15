// src/fx.js
// USD → NGN rate fetching with fallback chain
// Primary: exchangerate-api free tier. Fallback: hardcoded recent rate.
//
// Also turns what users type ("₦20,000", "N20k", "50 dollars") into a
// { currency, amount } pair and converts Naira to the USDC we actually move.

const axios = require("axios");

const FALLBACK_RATE = 1620; // update periodically if live fetch fails
let _cachedRate = null;
let _cacheTime  = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getUsdToNgnRate() {
  if (_cachedRate && Date.now() - _cacheTime < CACHE_TTL) return _cachedRate;
  try {
    // Free tier, no key required
    const res = await axios.get("https://open.er-api.com/v6/latest/USD", { timeout: 4000 });
    const rate = res.data?.rates?.NGN;
    if (rate) {
      _cachedRate = rate;
      _cacheTime  = Date.now();
      return rate;
    }
  } catch (err) {
    console.error("[fx] Rate fetch failed:", err.message);
  }
  return FALLBACK_RATE;
}

function formatNaira(amount) {
  return `₦${Math.round(amount).toLocaleString("en-NG")}`;
}

function formatUsd(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

/** "₦20,000 (≈ $12.35)" — Naira first, dollars as the hint. */
function formatDual(usd, rate) {
  return `${formatNaira(usd * rate)} (≈ ${formatUsd(usd)})`;
}

// USDC has 6 decimals on every chain — never carry more precision than that.
function roundUsdc(amount) {
  return Number((Math.floor(amount * 1e6) / 1e6).toFixed(6));
}

const MULTIPLIERS = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6 };

/**
 * Parse a money amount the way Nigerian users type it.
 *   "₦20,000" "N20,000" "20k naira" "NGN 20000" → { currency: "NGN", amount: 20000 }
 *   "$50" "50 usd" "50 usdc" "50 dollars"       → { currency: "USD", amount: 50 }
 *   "20000" (no unit)                          → { currency: defaultCurrency, amount }
 * Returns null when no positive amount is found.
 */
function parseMoneyInput(text, { defaultCurrency = "NGN" } = {}) {
  if (text == null) return null;
  const raw = String(text).trim().toLowerCase();
  const num = raw.match(/(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|million)?\b/);
  if (!num) return null;
  const amount = parseFloat(num[1].replace(/,/g, "")) * (MULTIPLIERS[num[2]] || 1);
  if (!isFinite(amount) || amount <= 0) return null;

  let currency = defaultCurrency;
  if (/₦|\bngn\b|naira|\bn\s?\d/.test(raw))             currency = "NGN";
  else if (/\$|\busdc?\b|dollar/.test(raw))              currency = "USD";
  else if (/€|\beurc?\b|euro/.test(raw))                 currency = "EUR";
  return { currency, amount };
}

/**
 * Resolve a parsed input into both sides of the conversion.
 * @returns {Promise<{ usd: number, ngn: number, rate: number, inputCurrency: string }>}
 */
async function resolveAmount(parsed) {
  const rate = await getUsdToNgnRate();
  if (parsed.currency === "NGN") {
    return { usd: roundUsdc(parsed.amount / rate), ngn: parsed.amount, rate, inputCurrency: "NGN" };
  }
  return { usd: roundUsdc(parsed.amount), ngn: parsed.amount * rate, rate, inputCurrency: parsed.currency };
}

module.exports = {
  getUsdToNgnRate,
  formatNaira,
  formatUsd,
  formatDual,
  roundUsdc,
  parseMoneyInput,
  resolveAmount,
};
