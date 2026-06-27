// agent/executor.js
// Executes structured payment plans from the orchestrator / intent router.
//
// Updated to handle:
//   - Single on-chain USDC / EURC transfers
//   - Bulk transfers (sequential, per-payment status reported)
//   - Off-ramp (Naira cashout via Paj Cash)
//   - Payroll (same as bulk, labelled differently for receipts)
//
// All functions return a consistent result shape so formatResults() works
// regardless of payment type.

require("dotenv").config();

const db        = require("../src/db");
const walletLib = require("../src/wallet");
const offramp   = require("../src/offramp");
const tokens    = require("../src/tokens");

// ─── Single on-chain payment ──────────────────────────────────────────────────

/**
 * Execute a single on-chain transfer (USDC or EURC).
 *
 * @param {object} userWallet   — ethers Wallet instance
 * @param {string} toAddress    — 0x recipient address
 * @param {number} amountUsdc   — numeric amount
 * @param {number} telegramId
 * @param {string} label
 * @param {string} currency     — "USDC" | "EURC"
 * @returns {Promise<object>}   — { success, txHash?, amount, to, label, error? }
 */
async function executeOnchainPayment(userWallet, toAddress, amountUsdc, telegramId, label, currency = "USDC") {
  let amountMicro;
  try {
    amountMicro = walletLib.parseToMicro(amountUsdc.toString());
  } catch (err) {
    return { success: false, error: "Invalid amount: " + err.message, label, amount: amountUsdc, to: toAddress };
  }

  // Balance check
  let balance;
  try {
    if (currency === "EURC") {
      balance = await tokens.getEurcBalance(userWallet.address);
    } else {
      balance = await walletLib.getNativeBalanceMicro(userWallet.address);
    }
  } catch (err) {
    return { success: false, error: "Could not check balance: " + err.message, label, amount: amountUsdc, to: toAddress };
  }

  if (balance < amountMicro) {
    return {
      success: false,
      error: `Not enough ${currency}. You have ${walletLib.formatMicro(balance)} ${currency}, need ${amountUsdc}.`,
      label,
      amount: amountUsdc,
      to: toAddress,
    };
  }

  const txId = db.recordTransaction(telegramId, `send_${currency.toLowerCase()}`, amountMicro, "pending", null);

  try {
    let txHash;
    if (currency === "EURC") {
      txHash = await tokens.sendEurc(userWallet, toAddress, amountMicro);
    } else {
      txHash = await walletLib.sendFromWallet(userWallet, toAddress, amountMicro);
    }
    db.updateTransactionStatus(txId, "confirmed");
    return { success: true, txHash, amount: amountUsdc, to: toAddress, label, currency };
  } catch (err) {
    db.updateTransactionStatus(txId, "failed");
    return { success: false, error: err.message, label, amount: amountUsdc, to: toAddress, currency };
  }
}

// ─── Single off-ramp payment ──────────────────────────────────────────────────

/**
 * Execute a single Naira cashout.
 *
 * @param {object} userWallet
 * @param {number} amountUsdc
 * @param {object} bankDetails    — { accountNumber, bankCode, accountName }
 * @param {number} telegramId
 * @param {string} label
 * @returns {Promise<object>}
 */
async function executeOfframp(userWallet, amountUsdc, bankDetails, telegramId, label = "Cash Out") {
  let amountMicro;
  try {
    amountMicro = walletLib.parseToMicro(amountUsdc.toString());
  } catch (err) {
    return { success: false, error: "Invalid amount: " + err.message, label, amount: amountUsdc };
  }

  const offrampAddress = process.env.PAJCASH_OFFRAMP_ADDRESS;
  if (!offrampAddress || !walletLib.isValidAddress(offrampAddress)) {
    return { success: false, error: "Cash out isn't available yet in your region — coming soon.", label, amount: amountUsdc };
  }

  let balance;
  try {
    balance = await walletLib.getNativeBalanceMicro(userWallet.address);
  } catch (err) {
    return { success: false, error: "Could not check balance: " + err.message, label, amount: amountUsdc };
  }

  if (balance < amountMicro) {
    return {
      success: false,
      error: `Not enough USDC. You have ${walletLib.formatMicro(balance)} USDC, need ${amountUsdc}.`,
      label,
      amount: amountUsdc,
    };
  }

  const txId = db.recordTransaction(telegramId, "offramp", amountMicro, "pending", null);

  // Step 1: on-chain send to offramp address
  let txHash;
  try {
    txHash = await walletLib.sendFromWallet(userWallet, offrampAddress, amountMicro);
  } catch (err) {
    db.updateTransactionStatus(txId, "failed");
    return { success: false, error: "Transfer failed: " + err.message, label, amount: amountUsdc };
  }

  // Step 2: notify Paj Cash
  try {
    const result = await offramp.requestOfframp(telegramId, amountMicro, {
      accountNumber: bankDetails.accountNumber || "0000000000",
      bankCode:      bankDetails.bankCode      || "000",
      accountName:   bankDetails.accountName   || "PayIT User",
    });
    db.updateTransactionStatus(txId, "submitted");
    return {
      success: true,
      txHash,
      amount: amountUsdc,
      to: "__offramp__",
      label,
      reference: result.reference || result.id || null,
      bankDetails,
    };
  } catch (err) {
    // On-chain went through — partial success
    db.updateTransactionStatus(txId, "onchain_sent_notify_failed");
    return {
      success: true,
      txHash,
      amount: amountUsdc,
      to: "__offramp__",
      label,
      warning: "Your USDC was sent but the Naira payout notification failed. Contact support with your transaction ID if Naira doesn't arrive within 15 minutes.",
      bankDetails,
    };
  }
}

// ─── Plan executor (bulk / mixed) ─────────────────────────────────────────────

/**
 * Execute a full payment plan (single, bulk, or mixed).
 * Unlocks the wallet once and processes each payment sequentially.
 *
 * @param {object}   plan     — from orchestrator or intent router
 * @param {string}   pin
 * @param {object}   user     — DB user record
 * @param {string}   context  — "personal" | "business"
 * @returns {Promise<object[]>} array of per-payment results
 */
async function executePlan(plan, pin, user, context = "personal") {
  // Unlock the correct wallet for the active context
  let userWallet;
  try {
    const pk = context === "business" && user.business_deposit_address
      ? db.decryptBusinessPrivateKey(pin, user)
      : db.decryptPrivateKey(pin, user);
    userWallet = walletLib.walletFromPrivateKey(pk);
  } catch {
    return [{
      success: false,
      error: "Couldn't unlock your wallet — incorrect PIN.",
      label: "All payments",
      amount: 0,
    }];
  }

  const results = [];

  for (const payment of plan.payments) {
    // Off-ramp payment
    if (payment.to === "__offramp__") {
      const result = await executeOfframp(
        userWallet,
        payment.amount,
        {
          accountNumber: payment.account_number,
          bankCode:      payment.bank_code || "000",
          accountName:   payment.account_name,
        },
        user.telegram_id,
        payment.label || "Cash Out"
      );
      results.push(result);
      continue;
    }

    // On-chain payment
    const result = await executeOnchainPayment(
      userWallet,
      payment.to,
      payment.amount,
      user.telegram_id,
      payment.label || `Payment to ${payment.to}`,
      payment.currency || "USDC"
    );
    results.push(result);
  }

  return results;
}

// ─── Result formatter ─────────────────────────────────────────────────────────

/**
 * Format an array of execution results as a Telegram message.
 * Shows per-payment status, tx hashes, and any warnings.
 *
 * @param {object[]} results
 * @returns {string}
 */
function formatResults(results) {
  const lines = results.map((r) => {
    if (r.to === "__offramp__") {
      // Off-ramp result
      if (r.success && !r.warning) {
        return (
          `✅ Cash out submitted\n` +
          `   ${r.amount} USDC → Naira\n` +
          `   ${r.bankDetails?.accountName || ""} · ${r.bankDetails?.accountNumber || ""}\n` +
          `   Ref: ${r.reference || "—"}\n` +
          `   Naira arrives in ~10 minutes`
        );
      }
      if (r.success && r.warning) {
        return (
          `⚠️ Partially completed\n` +
          `   ${r.amount} USDC sent on-chain (Tx: \`${r.txHash}\`)\n` +
          `   ${r.warning}`
        );
      }
      return `❌ Cash out failed\n   ${r.error}`;
    }

    // On-chain result
    if (r.success) {
      const shortTx = r.txHash
        ? `\`${r.txHash.slice(0, 10)}...${r.txHash.slice(-8)}\``
        : "";
      return (
        `✅ Sent ${r.amount} ${r.currency || "USDC"}\n` +
        `   → \`${r.to}\`\n` +
        (shortTx ? `   Tx: ${shortTx}\n` : "") +
        `   (${r.label})`
      );
    }

    return `❌ Failed — ${r.label}\n   ${r.error}`;
  });

  // Summary line for bulk
  if (results.length > 1) {
    const successCount = results.filter(r => r.success).length;
    const failCount    = results.length - successCount;
    const totalSent    = results.filter(r => r.success).reduce((s, r) => s + Number(r.amount), 0);
    lines.push(
      `\n──────────────────────────\n` +
      `${successCount}/${results.length} payments succeeded · ` +
      `${totalSent.toFixed(2)} USDC sent` +
      (failCount > 0 ? ` · ${failCount} failed` : "")
    );
  }

  return lines.join("\n\n");
}

module.exports = { executePlan, executeOnchainPayment, executeOfframp, formatResults };
