// src/offramp.js
// Production Paj v2 Off-Ramp Wrapper for Proxim
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
      description: `Proxim Cash Out - TG:${telegramId}`,
      // Explicit settlement rail (defaults to Solana rail for backward compatibility).
      // Pass { rail: "arc", chain, mint } to cash out directly on Arc via Paj.
      ...(bankDetails.chain ? { chain: bankDetails.chain } : {}),
      ...(bankDetails.mint ? { mint: bankDetails.mint } : {}),
    };

    if (bankDetails && typeof bankDetails.businessUSDCFee === "number") {
      payload.businessUSDCFee = bankDetails.businessUSDCFee;
    }

    if (bankDetails && bankDetails.fiatAmount) {
      payload.fiatAmount = Number(bankDetails.fiatAmount);
    } else {
      payload.amount = amountUsdc;
    }

    if (telegramId) {
      payload.userExternalId = String(telegramId);
    }

    const order = await paj.createOfframpOrder(payload);
    const orderData = order?.data || order;

    return {
      success: true,
      reference: orderData?.id || orderData?.orderId || orderData?.reference || order?.id || order?.reference,
      address: orderData?.address || order?.address,
      amount: orderData?.amount || order?.amount,
      fiatAmount: orderData?.fiatAmount || order?.fiatAmount,
      accountName: orderData?.accountName || order?.accountName,
      rate: orderData?.rate || order?.rate,
      status: orderData?.status || order?.status,
      data: orderData,
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
