// src/fx.js
// USD → NGN rate fetching with fallback chain
// Primary: exchangerate-api free tier. Fallback: hardcoded recent rate.

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

module.exports = { getUsdToNgnRate, formatNaira };
