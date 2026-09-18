// src/fx.js
// USD → NGN live rate fetching with multi-source resilient fallbacks.
// Source 1: Paj Cash live rate (real-market Naira on/offramp rate)
// Source 2: Open Exchange Rates free API
// Source 3: Cached last-known live rate

const axios = require("axios");
const paj = require("./paj");

let _cachedRate = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getUsdToNgnRate() {
  if (_cachedRate && Date.now() - _cacheTime < CACHE_TTL) return _cachedRate;

  // 1. Try Paj live market rate
  try {
    const pajRates = await paj.getRates("NGN");
    const liveRate = pajRates?.onRampRate?.rate || pajRates?.offRampRate?.rate;
    if (liveRate && Number(liveRate) > 0) {
      _cachedRate = Number(liveRate);
      _cacheTime = Date.now();
      return _cachedRate;
    }
  } catch (pajErr) {
    // Paj unavailable, proceed to secondary source
  }

  // 2. Try Open ER API
  try {
    const res = await axios.get("https://open.er-api.com/v6/latest/USD", { timeout: 4000 });
    const rate = res.data?.rates?.NGN;
    if (rate && Number(rate) > 0) {
      _cachedRate = Number(rate);
      _cacheTime = Date.now();
      return _cachedRate;
    }
  } catch (err) {
    console.warn("[fx] OpenER rate fetch warning:", err.message);
  }

  // 3. Fallback to cached rate if available
  if (_cachedRate) {
    return _cachedRate;
  }

  // 4. Default fallback if first fetch on cold boot fails
  return 1620;
}

function formatNaira(amount) {
  return `₦${Math.round(amount).toLocaleString("en-NG")}`;
}

module.exports = { getUsdToNgnRate, formatNaira };
