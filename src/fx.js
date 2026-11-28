// src/fx.js
// USD → NGN live rate fetching with multi-source resilient fallbacks.
// Source 1: Paj Cash live rate (real-market Naira on/offramp rate)
// Source 2: Open Exchange Rates free API
// Source 3: Cached last-known live rate

const axios = require("axios");
const paj = require("./paj");

let _cachedRate = null;
let _cachedMeta = null;
let _cacheTime = 0;
const CACHE_TTL = 60 * 1000; // 60 seconds so live Paj cronjob rate updates reflect immediately

function clearRateCache() {
  _cachedRate = null;
  _cachedMeta = null;
  _cacheTime = 0;
}

async function getUsdToNgnRateDetails({ forceRefresh = false } = {}) {
  if (!forceRefresh && _cachedRate && _cachedMeta && Date.now() - _cacheTime < CACHE_TTL) {
    return _cachedMeta;
  }

  // 1. Try Paj live market rate (use exact offRampRate decimal — never round away kobo)
  try {
    const pajRates = await paj.getRates("NGN");
    const offRamp = Number(pajRates?.offRampRate?.rate || 0) || null;
    const onRamp = Number(pajRates?.onRampRate?.rawRate || pajRates?.onRampRate?.rate || 0) || null;
    const liveRate = offRamp || onRamp;
    if (liveRate && Number.isFinite(liveRate) && liveRate > 0) {
      const exactRate = Number(liveRate.toFixed(2));
      const updatedAt = pajRates?.offRampRate?.createdAt || pajRates?.onRampRate?.createdAt || null;
      _cachedRate = exactRate;
      _cachedMeta = {
        rate: exactRate,
        offRampRate: offRamp ? Number(offRamp.toFixed(2)) : exactRate,
        onRampRate: onRamp ? Number(onRamp.toFixed(2)) : exactRate,
        source: "paj",
        updatedAt,
      };
      _cacheTime = Date.now();
      return _cachedMeta;
    }
  } catch (pajErr) {
    // Paj unavailable, proceed to secondary source
  }

  // 2. Try Open ER API
  try {
    const res = await axios.get("https://open.er-api.com/v6/latest/USD", { timeout: 4000 });
    const rate = Number(res.data?.rates?.NGN || 0);
    if (rate && Number.isFinite(rate) && rate > 0) {
      const exactRate = Number(rate.toFixed(2));
      _cachedRate = exactRate;
      _cachedMeta = {
        rate: exactRate,
        offRampRate: exactRate,
        onRampRate: exactRate,
        source: "open_er",
        updatedAt: res.data?.time_last_update_utc || null,
      };
      _cacheTime = Date.now();
      return _cachedMeta;
    }
  } catch (err) {
    console.warn("[fx] OpenER rate fetch warning:", err.message);
  }

  // 3. Fallback to cached rate if available
  if (_cachedRate && _cachedMeta) {
    return _cachedMeta;
  }

  // 4. Configured override or fail cold boot fetch
  if (process.env.USD_TO_NGN_RATE && Number(process.env.USD_TO_NGN_RATE) > 0) {
    const override = Number(Number(process.env.USD_TO_NGN_RATE).toFixed(2));
    return { rate: override, offRampRate: override, onRampRate: override, source: "env", updatedAt: null };
  }

  throw new Error("Unable to fetch live USD/NGN exchange rate from live providers (Paj, OpenER)");
}

async function getUsdToNgnRate(options = {}) {
  const details = await getUsdToNgnRateDetails(options);
  return details.rate;
}

function formatNaira(amount) {
  return `₦${Math.round(amount).toLocaleString("en-NG")}`;
}

function formatNairaRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n) || n <= 0) return "₦0.00";
  return `₦${n.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

module.exports = { getUsdToNgnRate, getUsdToNgnRateDetails, clearRateCache, formatNaira, formatNairaRate };
