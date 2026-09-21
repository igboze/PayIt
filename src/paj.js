// src/paj.js
// Production integration for Paj v2 Public API (https://docs.paj.cash)
// Base URL: https://api.paj.cash/pub/v2
// Scoped to business API key via x-api-key header. Zero NGN custody.

require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");

const DEFAULT_PAJ_API_URL = "https://api.paj.cash/pub/v2";

function getApiKey() {
  return process.env.PAJCASH_API_KEY || "";
}

function getApiBaseUrl() {
  const envUrl = process.env.PAJCASH_API_URL || "";
  if (!envUrl || envUrl.includes("api.pajcash.com")) {
    return DEFAULT_PAJ_API_URL;
  }
  // Ensure trailing /pub/v2
  if (envUrl.endsWith("/pub/v2")) return envUrl;
  return envUrl.replace(/\/+$/, "") + "/pub/v2";
}

function getClient() {
  const apiKey = getApiKey();
  const baseURL = getApiBaseUrl();
  return axios.create({
    baseURL,
    timeout: 20000,
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
  });
}

const ONRAMP_FEE_NGN_PER_USD = Number(process.env.ONRAMP_FEE_NGN_PER_USD ?? 5.0);

/**
 * 1. Fetch live conversion rates for onramp and offramp.
 * Applies PayIT's ₦5/USD onramp fee markup while preserving market offramp rate.
 * @param {string} currency - e.g. "NGN"
 * @returns {Promise<{ onRampRate: object, offRampRate: object }>}
 */
async function getRates(currency = "NGN") {
  const client = getClient();
  try {
    const response = await client.get("/rate", {
      params: { currency },
    });
    const data = response.data;
    if (data?.onRampRate && typeof data.onRampRate.rate === "number") {
      data.onRampRate.rawRate = data.onRampRate.rate;
      data.onRampRate.rate = Number((data.onRampRate.rate + ONRAMP_FEE_NGN_PER_USD).toFixed(2));
      data.onRampRate.payitFeeNgn = ONRAMP_FEE_NGN_PER_USD;
    }
    return data;
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    throw new Error(`Paj getRates failed (${err.response?.status || "network"}): ${msg}`);
  }
}

/**
 * 2. Get list of supported Nigerian banks with NIBSS codes and logos.
 * @param {object} filter - { code, name, country }
 * @returns {Promise<Array<{ id: string, name: string, country: string, code: string, logo: string }>>}
 */
async function getBanks(filter = {}) {
  const client = getClient();
  try {
    const params = { country: filter.country || "NG" };
    if (filter.code) params.code = filter.code;
    if (filter.name) params.name = filter.name;

    const response = await client.get("/bank", { params });
    return Array.isArray(response.data) ? response.data : [];
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    throw new Error(`Paj getBanks failed (${err.response?.status || "network"}): ${msg}`);
  }
}

/**
 * 3. Create an Onramp Order (Naira -> On-chain Token).
 * Returns virtual bank account details for the user to transfer Naira to.
 * @param {object} params
 * @param {number} [params.fiatAmount] - Exact Naira amount user sends (e.g. 25000)
 * @param {number} [params.amount] - Exact token amount user wants to receive (mutually exclusive with fiatAmount)
 * @param {string} params.recipient - On-chain wallet address to receive tokens
 * @param {string} [params.currency="NGN"] - Local currency
 * @param {string} [params.mint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"] - Token mint (default: Solana USDC)
 * @param {string} [params.chain="SOLANA"] - Settlement chain
 * @param {string} [params.webhookURL] - URL to receive signed status updates
 * @param {string} [params.userExternalId] - Telegram user ID reference
 * @param {number} [params.businessUSDCFee=0] - Business fee markup in USDC
 * @param {string} [params.bvn] - Optional BVN for tier-1 user attribution
 * @returns {Promise<{ id: string, accountNumber: string, accountName: string, bank: string, fiatAmount: number, amount: number, status: string }>}
 */
async function createOnrampOrder(params) {
  const client = getClient();
  const payload = {
    currency: params.currency || "NGN",
    recipient: params.recipient,
    mint: params.mint || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    chain: params.chain || "SOLANA",
    webhookURL: params.webhookURL || process.env.PAJ_WEBHOOK_URL || undefined,
    userExternalId: params.userExternalId ? String(params.userExternalId) : undefined,
    businessUSDCFee: typeof params.businessUSDCFee === "number" ? params.businessUSDCFee : 0,
  };

  if (params.bvn) {
    payload.bvn = params.bvn;
  }

  if (params.fiatAmount !== undefined && params.fiatAmount !== null) {
    payload.fiatAmount = Number(params.fiatAmount);
  } else if (params.amount !== undefined && params.amount !== null) {
    payload.amount = Number(params.amount);
  } else {
    throw new Error("Must provide either fiatAmount or amount for onramp order");
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await client.post("/onramp", payload);
      return response.data;
    } catch (err) {
      lastErr = err;
      const msg = String(err.response?.data?.message || err.response?.data?.error || err.message);
      if (attempt < 2 && (msg.includes("mint info") || msg.includes("Jup error") || msg.includes("timeout") || err.response?.status === 429 || err.response?.status >= 500)) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw new Error(`Paj createOnrampOrder failed (${err.response?.status || "network"}): ${JSON.stringify(msg)}`);
    }
  }
  const finalMsg = lastErr?.response?.data?.message || lastErr?.response?.data?.error || lastErr?.message;
  throw new Error(`Paj createOnrampOrder failed (${lastErr?.response?.status || "network"}): ${JSON.stringify(finalMsg)}`);
}

/**
 * Fetch status of an onramp order by ID.
 * @param {string} orderId
 * @returns {Promise<object|null>}
 */
async function getOnrampOrder(orderId) {
  if (!orderId) return null;
  const client = getClient();
  try {
    const response = await client.get(`/onramp/${orderId}`);
    return response.data;
  } catch (err) {
    return null;
  }
}

/**
 * Triggers a payout sweep for an onramp order to a recipient address.
 * @param {string} orderId
 * @param {string} recipient
 */
async function triggerOnrampSweep(orderId, recipient) {
  if (!orderId || !recipient) return null;
  const client = getClient();
  try {
    const response = await client.post(`/onramp/${orderId}/sweep`, { recipient });
    return response.data;
  } catch (err) {
    return null;
  }
}

/**
 * 4. Create an Offramp Order (On-chain Token -> Naira Bank Payout).
 * Pre-validates bank account with NIBSS and returns dynamic one-time funding address.
 * @param {object} params
 * @param {string} params.accountNumber - Destination Nigerian bank account number (10 digits)
 * @param {string} params.bankCode - 6-digit NIBSS bank code (e.g. "000013" for GTBank, "000017" for Wema)
 * @param {number} [params.amount] - Token amount to sell (e.g. 20)
 * @param {number} [params.fiatAmount] - Exact Naira to deliver (mutually exclusive with amount)
 * @param {string} [params.currency="NGN"] - Local currency
 * @param {string} [params.mint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"] - Token mint (default: Solana USDC)
 * @param {string} [params.chain="SOLANA"] - Settlement chain
 * @param {string} [params.webhookURL] - Callback URL
 * @param {number} [params.businessUSDCFee=0] - Business markup in USDC
 * @param {string} [params.description] - Payment note
 * @returns {Promise<{ id: string, address: string, amount: number, fiatAmount: number, accountName: string, rate: number, status: string }>}
 */
async function createOfframpOrder(params) {
  const client = getClient();
  const payload = {
    accountNumber: String(params.accountNumber).trim(),
    bankCode: String(params.bankCode).trim(),
    currency: params.currency || "NGN",
    mint: params.mint || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    chain: params.chain || "SOLANA",
    webhookURL: params.webhookURL || process.env.PAJ_WEBHOOK_URL || undefined,
    businessUSDCFee: typeof params.businessUSDCFee === "number" ? params.businessUSDCFee : 0,
    description: params.description || "PayIT Cashout",
  };

  if (params.amount !== undefined && params.amount !== null) {
    payload.amount = Number(params.amount);
  } else if (params.fiatAmount !== undefined && params.fiatAmount !== null) {
    payload.fiatAmount = Number(params.fiatAmount);
  } else {
    throw new Error("Must provide either amount or fiatAmount for offramp order");
  }

  if (params.bvn) {
    payload.bvn = params.bvn;
  }

  try {
    const response = await client.post("/offramp", payload);
    return response.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    throw new Error(`Paj createOfframpOrder failed (${err.response?.status || "network"}): ${JSON.stringify(msg)}`);
  }
}

/**
 * 5. Register a Permanent Bank Account Address (Standing PDA on Solana).
 * Any token deposit ever made to the returned address is automatically converted and paid out to the bank account.
 * @param {string} bankCode - 6-digit NIBSS code
 * @param {string} accountNumber - 10-digit account number
 * @returns {Promise<{ id: string, address: string, accountName: string, bank: object }>}
 */
async function registerPermanentBankAccount(bankCode, accountNumber) {
  const client = getClient();
  try {
    const response = await client.post("/bank-account", {
      bankCode: String(bankCode).trim(),
      accountNumber: String(accountNumber).trim(),
    });
    return response.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    throw new Error(`Paj registerPermanentBankAccount failed (${err.response?.status || "network"}): ${JSON.stringify(msg)}`);
  }
}

/**
 * 6. Search for Bank Account details by Account Number or on-chain Address.
 * @param {object} query - { accountNumber, address }
 */
async function searchBankAccount(query = {}) {
  const client = getClient();
  try {
    const response = await client.get("/bank-account", { params: query });
    return response.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    throw new Error(`Paj searchBankAccount failed: ${JSON.stringify(msg)}`);
  }
}

/**
 * 7. Cryptographic HMAC-SHA256 Webhook Verifier.
 * Complies with Paj v2 signature standard: {timestamp}.{rawBody}
 * @param {string|Buffer} rawBody - Exact raw body bytes received from the network
 * @param {object} headers - HTTP headers containing x-paj-timestamp and x-paj-signature
 * @param {string} webhookSecret - Business webhook secret (whsec_...)
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, headers, webhookSecret) {
  if (!webhookSecret) return false;
  const timestamp = headers["x-paj-timestamp"] || headers["X-PAJ-Timestamp"];
  const signatureHeader = headers["x-paj-signature"] || headers["X-PAJ-Signature"];

  if (!timestamp || !signatureHeader) {
    return false;
  }

  // Reject replay attacks older than 5 minutes (300 seconds)
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > 300) {
    return false;
  }

  const received = signatureHeader.replace(/^v1=/, "").trim();
  const rawString = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);

  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${rawString}`)
    .digest("hex");

  if (received.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
}

module.exports = {
  getRates,
  getBanks,
  createOnrampOrder,
  getOnrampOrder,
  triggerOnrampSweep,
  createOfframpOrder,
  registerPermanentBankAccount,
  searchBankAccount,
  verifyWebhookSignature,
  getApiKey,
  getApiBaseUrl,
};
