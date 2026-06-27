// src/offramp.js
// Paj Cash Naira off-ramp integration
// On-chain USDC transfer happens in bot.js (executeWithdraw) before this is called.
// This file handles the Paj Cash API notification so they know to send Naira to the user.
// Replace with real Paj Cash API docs/credentials when available.

const axios = require("axios");
const walletLib = require("./wallet");

const PAJCASH_API_BASE = process.env.PAJCASH_API_URL || "https://api.pajcash.com";
const PAJCASH_API_KEY  = process.env.PAJCASH_API_KEY  || "";

/**
 * Notify Paj Cash that USDC has been sent and Naira payout is requested.
 * @param {number} telegramId - user's Telegram ID (for reference)
 * @param {bigint} amountMicro - amount in 18-decimal micro format
 * @param {object} bankDetails - { accountNumber, bankCode, accountName }
 */
async function requestOfframp(telegramId, amountMicro, bankDetails) {
  const amountUsdc = parseFloat(walletLib.formatMicro(amountMicro));

  if (!PAJCASH_API_KEY) {
    // No credentials configured — return a placeholder reference
    console.warn("[offramp] PAJCASH_API_KEY not set — skipping real API call");
    return { reference: `MOCK-${Date.now()}`, status: "pending" };
  }

  const response = await axios.post(
    `${PAJCASH_API_BASE}/v1/offramp`,
    {
      amount: amountUsdc,
      currency: "USDC",
      destinationCurrency: "NGN",
      bankDetails,
      reference: `PAYIT-${telegramId}-${Date.now()}`,
    },
    {
      headers: {
        Authorization: `Bearer ${PAJCASH_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    }
  );

  return response.data;
}

module.exports = { requestOfframp };
