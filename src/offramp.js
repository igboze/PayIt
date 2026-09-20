// src/offramp.js
// Production Paj v2 Off-Ramp Wrapper for PayIT
// Uses the official Paj v2 API (https://docs.paj.cash)

const paj = require("./paj");
const walletLib = require("./wallet");

/**
 * Request real Naira payout via Paj v2 offramp order.
 *
 * @param {number} telegramId - Telegram user ID
 * @param {bigint} amountMicro - Amount in 18-decimal micro format
 * @param {object} bankDetails - { accountNumber, bankCode, accountName, fiatAmount }
 * @returns {Promise<object>}
 */
async function requestOfframp(telegramId, amountMicro, bankDetails) {
  const amountUsdc = parseFloat(walletLib.formatMicro(amountMicro));

  try {
    if (!bankDetails || !bankDetails.accountNumber) {
      throw new Error("Account number is required for cash out payout");
    }
    if (!bankDetails.bankCode) {
      throw new Error("Valid 6-digit NIBSS bank code is required for cash out payout");
    }

    const payload = {
      accountNumber: String(bankDetails.accountNumber).trim(),
      bankCode: String(bankDetails.bankCode).trim(),
      currency: "NGN",
      description: `PayIT Cash Out - TG:${telegramId}`,
    };

    if (bankDetails && bankDetails.fiatAmount) {
      payload.fiatAmount = Number(bankDetails.fiatAmount);
    } else {
      payload.amount = amountUsdc;
    }

    const order = await paj.createOfframpOrder(payload);

    return {
      success: true,
      reference: order.id,
      address: order.address,
      amount: order.amount,
      fiatAmount: order.fiatAmount,
      accountName: order.accountName,
      rate: order.rate,
      status: order.status,
      data: order,
    };
  } catch (err) {
    console.error(`[offramp] Paj v2 Offramp creation failed:`, err.message);
    return {
      success: false,
      error: err.message,
      status: "failed",
    };
  }
}

module.exports = { requestOfframp };
