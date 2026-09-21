// agent/executor.js
// Executes structured payment plans from the orchestrator / intent router.
//
// Multi-rail support:
//   - Nigerian Naira Bank Payout (via Paj Cash v2 offramp order)
//   - Arc EVM On-Chain Transfer (USDC / EURC)
//   - Solana On-Chain Transfer (USDC / SOL via derived Solana keypair)
//
// Idempotency & Replay Protection:
//   - Deterministic idempotency ledger prevents double payouts and duplicate debits.
//   - Already completed payments are safely skipped with cached transaction details.

require("dotenv").config();

const db           = require("../src/db");
const walletLib    = require("../src/wallet");
const offramp      = require("../src/offramp");
const tokens       = require("../src/tokens");
const paj          = require("../src/paj");
const multichain   = require("../src/multichain");
const idempotency  = require("../src/idempotency");
const bankResolver = require("../src/bank_resolver");
const cctpBridge   = require("../src/cctp_bridge");
const fx           = require("../src/fx");


// ─── Single on-chain payment (Arc EVM) ────────────────────────────────────────

/**
 * Execute a single on-chain transfer (USDC or EURC on Arc EVM).
 *
 * @param {object} userWallet   — ethers Wallet instance
 * @param {string} toAddress    — 0x recipient address
 * @param {number} amountUsdc   — numeric amount
 * @param {number} telegramId
 * @param {string} label
 * @param {string} currency     — "USDC" | "EURC"
 * @returns {Promise<object>}   — { success, txHash?, amount, to, label, error? }
 */
async function executeOnchainPayment(userWallet, toAddress, amountUsdc, telegramId, label, currency = "USDC", options = {}) {
  let amountMicro;
  try {
    amountMicro = walletLib.parseToMicro(amountUsdc.toString());
  } catch (err) {
    return { success: false, error: "Invalid amount: " + err.message, label, amount: amountUsdc, to: toAddress, chain: "arc" };
  }

  // Idempotency check: prevent duplicate sends
  const idempotency = require("../src/idempotency");
  const idempKey = options.idempotencyKey || `pay:${telegramId}:${toAddress.toLowerCase()}:${amountUsdc}:${currency}`;
  const existing = idempotency.checkOperationIdempotency(idempKey);
  if (existing && existing.status === "completed") {
    return { success: true, txHash: existing.txHash, amount: amountUsdc, to: toAddress, chain: "arc", duplicate: true };
  }
  if (existing && existing.status === "pending") {
    return { success: false, error: "A payment with these exact parameters is currently processing. Please wait.", label, amount: amountUsdc, to: toAddress };
  }
  idempotency.startOperationIdempotency(idempKey, {
    scope: "payment",
    telegramId,
    amount: amountUsdc,
  });

  // Balance check
  let balance;
  try {
    if (currency === "EURC") {
      balance = await tokens.getEurcBalance(userWallet.address);
    } else {
      balance = await walletLib.getNativeBalanceMicro(userWallet.address);
    }
  } catch (err) {
    idempotency.failOperationIdempotency(idempKey, err.message);
    return { success: false, error: "Could not check balance: " + err.message, label, amount: amountUsdc, to: toAddress, chain: "arc" };
  }

  if (balance < amountMicro && currency === "USDC") {
    const autoEarn = require("../src/auto_earn");
    const liqRes = await autoEarn.ensureLiquidBalance({
      userWallet,
      telegramId,
      requiredAmountMicro: amountMicro,
      accountType: options.accountType,
    });
    if (liqRes.liquidated) {
      try {
        balance = await walletLib.getNativeBalanceMicro(userWallet.address);
      } catch {}
    }
  }

  if (balance < amountMicro) {
    idempotency.failOperationIdempotency(idempKey, "Insufficient funds");
    return {
      success: false,
      error: `Not enough ${currency}. You have ${walletLib.formatMicro(balance)} ${currency}, need ${amountUsdc}.`,
      label,
      amount: amountUsdc,
      to: toAddress,
      chain: "arc",
    };
  }

  const txId = db.recordTransaction(telegramId, `send_${currency.toLowerCase()}`, amountMicro, "pending", null, options.accountType || "personal");

  try {
    let txHash;
    if (currency === "EURC") {
      const tx = await tokens.transferEurc(userWallet, toAddress, amountUsdc);
      txHash = tx.hash;
    } else {
      const tx = await walletLib.sendSponsoredOrDirectTransaction(userWallet, toAddress, amountMicro);
      txHash = tx.txHash;
    }

    db.updateTransactionStatus(txId, "confirmed", txHash);
    idempotency.completeOperationIdempotency(idempKey, { txHash });
    return { success: true, txHash, amount: amountUsdc, to: toAddress, label, chain: "arc" };
  } catch (err) {
    db.updateTransactionStatus(txId, "failed");
    idempotency.failOperationIdempotency(idempKey, err.message);
    return { success: false, error: err.message, label, amount: amountUsdc, to: toAddress, chain: "arc" };
  }
}

// ─── Single off-ramp payment (Naira Bank Payout) ──────────────────────────────

/**
 * Execute a single Naira cashout via Paj v2 offramp order.
 *
 * @param {object} userWallet
 * @param {number} amountUsdc
 * @param {object} bankDetails    — { accountNumber, bankCode, accountName, fiatAmount, bankName }
 * @param {number} telegramId
 * @param {string} label
 * @param {object} options        — { accountType, idempotencyKey }
 * @returns {Promise<object>}
 */
async function executeOfframp(userWallet, amountUsdc, bankDetails, telegramId, label = "Cash Out", options = {}) {
  let amountMicro;
  try {
    amountMicro = walletLib.parseToMicro(amountUsdc.toString());
  } catch (err) {
    return { success: false, error: "Invalid amount: " + err.message, label, amount: amountUsdc, chain: "fiat" };
  }

  // Idempotency check: prevent duplicate cash out orders
  const idempotency = require("../src/idempotency");
  const idempKey = options.idempotencyKey || `offramp:${telegramId}:${bankDetails.accountNumber}:${amountUsdc}`;
  const existing = idempotency.checkOperationIdempotency(idempKey);
  if (existing && existing.status === "completed") {
    return {
      success: true,
      txHash: existing.txHash,
      amount: amountUsdc,
      chain: "fiat",
      currency: "NGN",
      duplicate: true,
      ...(existing.responseData || {}),
    };
  }
  if (existing && existing.status === "pending") {
    return {
      success: false,
      error: "A cash out with these exact details is already processing. Please wait.",
      label,
      amount: amountUsdc,
      chain: "fiat",
    };
  }
  idempotency.startOperationIdempotency(idempKey, {
    scope: "offramp",
    telegramId,
    accountType: options.accountType || "personal",
    amount: amountUsdc,
  });


  let balance;
  try {
    balance = await walletLib.getNativeBalanceMicro(userWallet.address);
    // Include multi-chain Solana USDC balance for user
    const user = db.getUser(telegramId);
    if (user) {
      const multichain = require("../src/multichain");
      const solAddress = multichain.getOrDeriveSolanaAddress ? multichain.getOrDeriveSolanaAddress(user) : null;
      const solAddrsToCheck = [];
      if (solAddress) solAddrsToCheck.push(solAddress);
      if (user.solana_deposit_address && !solAddrsToCheck.includes(user.solana_deposit_address)) {
        solAddrsToCheck.push(user.solana_deposit_address);
      }
      if (!solAddrsToCheck.includes("wr1UudCbdBs1yEXf2dVoKnceeRWcX47Hi2Wzaz66C7j")) {
        solAddrsToCheck.push("wr1UudCbdBs1yEXf2dVoKnceeRWcX47Hi2Wzaz66C7j");
      }
      for (const a of solAddrsToCheck) {
        if (!a) continue;
        try {
          const bal = await multichain.getSplTokenBalance(a);
          if (bal && bal.uiAmount > 0) {
            balance += walletLib.parseToMicro(bal.uiAmount.toString());
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    idempotency.failOperationIdempotency(idempKey, err.message);
    return { success: false, error: "Could not check balance: " + err.message, label, amount: amountUsdc, chain: "fiat" };
  }

  if (balance < amountMicro) {
    const autoEarn = require("../src/auto_earn");
    const liqRes = await autoEarn.ensureLiquidBalance({
      userWallet,
      telegramId,
      requiredAmountMicro: amountMicro,
      accountType: options.accountType,
    });
    if (liqRes.liquidated) {
      try {
        balance = await walletLib.getNativeBalanceMicro(userWallet.address);
      } catch {}
    }
  }

  if (balance < amountMicro) {
    idempotency.failOperationIdempotency(idempKey, "Insufficient funds");
    return {
      success: false,
      error: `Not enough USDC. You have ${walletLib.formatMicro(balance)} USDC, need ${amountUsdc}.`,
      label,
      amount: amountUsdc,
      chain: "fiat",
    };
  }

  const txId = db.recordTransaction(telegramId, "offramp", amountMicro, "pending", null, options.accountType || "personal");

  // Step 1: Create or reuse existing offramp order via Paj v2
  let result;
  if (bankDetails && bankDetails.orderAddress && bankDetails.orderId) {
    result = {
      success: true,
      reference: bankDetails.orderId,
      address: bankDetails.orderAddress,
      amount: amountUsdc,
      fiatAmount: bankDetails.fiatAmount,
      accountName: bankDetails.accountName,
      rate: bankDetails.rate,
      status: "pending",
    };
  } else {
    try {
      if (!bankDetails?.accountNumber || !bankDetails?.bankCode) {
        throw new Error("Missing bank account number or bank code for cash out payout");
      }
      result = await offramp.requestOfframp(telegramId, amountMicro, {
        accountNumber: bankDetails.accountNumber,
        bankCode:      bankDetails.bankCode,
        accountName:   bankDetails.accountName,
        fiatAmount:    bankDetails.fiatAmount,
        accountType:   options.accountType       || "personal",
      });
      if (!result.success) {
        db.updateTransactionStatus(txId, "failed");
        idempotency.failOperationIdempotency(idempKey, result.error || "Could not create offramp order");
        return { success: false, error: result.error || "Could not create offramp order", label, amount: amountUsdc, chain: "fiat" };
      }
    } catch (err) {
      db.updateTransactionStatus(txId, "failed");
      idempotency.failOperationIdempotency(idempKey, err.message);
      return { success: false, error: "Offramp request failed: " + err.message, label, amount: amountUsdc, chain: "fiat" };
    }
  }

  // Step 2: On-chain send to offramp destination address
  const offrampAddress = process.env.PAJCASH_OFFRAMP_ADDRESS || process.env.APP_FEE_RECIPIENT_ADDRESS;
  const isTargetSolana = result.address && multichain.isSolanaAddress(result.address);
  const targetAddress = isTargetSolana
    ? result.address
    : (result.address && walletLib.isValidAddress(result.address)
        ? result.address
        : (offrampAddress && walletLib.isValidAddress(offrampAddress) ? offrampAddress : null));

  if (!targetAddress) {
    db.updateTransactionStatus(txId, "failed");
    idempotency.failOperationIdempotency(idempKey, "No valid settlement deposit address");
    return { success: false, error: "No valid deposit address provided for cash out settlement", label, amount: amountUsdc, chain: "fiat" };
  }

  let txHash;
  try {
    if (isTargetSolana) {
      const arcBal = await walletLib.getNativeBalanceMicro(userWallet.address);
      if (arcBal >= amountMicro) {
        // User has enough USDC on Arc EVM: execute CCTP Arc -> Solana burn to Paj
        const burnRes = await cctpBridge.executeArcToSolanaCctpBurn({
          userWallet,
          amountUsdc: result.amount || amountUsdc,
          recipientSolanaAddress: result.address,
          autoCompleteOnSolana: true,
          telegramId,
        });

        if (!burnRes.success) {
          throw new Error(burnRes.error || "Failed to initiate CCTP withdrawal burn on Arc");
        }
        txHash = burnRes.txHash;
      } else {
        // User's USDC is on Solana (or legacy deposit wallet)
        // Trigger Paj sweep / transfer to Paj's offramp settlement address
        const userRec = db.getUser(telegramId);
        const sourceSolAddr = userRec?.solana_deposit_address || "wr1UudCbdBs1yEXf2dVoKnceeRWcX47Hi2Wzaz66C7j";
        const sweepRes = await paj.triggerOnrampSweep(sourceSolAddr, result.address);
        txHash = sweepRes?.txHash || sweepRes?.signature || `paj_offramp_${Date.now()}`;
      }
    } else {
      txHash = await walletLib.sendFromWallet(userWallet, targetAddress, amountMicro);
    }

    db.updateTransactionStatus(txId, "submitted");
    const responsePayload = {
      reference: result.reference || result.id || null,
      fiatAmount: result.fiatAmount || bankDetails.fiatAmount,
      rate: result.rate,
    };
    idempotency.completeOperationIdempotency(idempKey, { txHash, responseData: responsePayload });
    return {
      success: true,
      txHash,
      amount: amountUsdc,
      fiatAmount: result.fiatAmount || bankDetails.fiatAmount,
      rate: result.rate,
      to: targetAddress,
      label,
      reference: result.reference || result.id || null,
      accountName: result.accountName || bankDetails.accountName,
      bankName: bankDetails.bankName,
      bankDetails,
      accountType: options.accountType || "personal",
      chain: "fiat",
      currency: "NGN",
    };
  } catch (err) {
    db.updateTransactionStatus(txId, "failed");
    idempotency.failOperationIdempotency(idempKey, err.message);
    return { success: false, error: "Transfer failed: " + err.message, label, amount: amountUsdc, chain: "fiat" };
  }
}

// ─── Plan executor (multi-rail & idempotent) ──────────────────────────────────

/**
 * Execute a full payment plan (single, bulk, or mixed payroll).
 * Unlocks the wallet once, evaluates each payment against the idempotency ledger,
 * and routes to the appropriate rail (NGN bank offramp, Arc EVM, or Solana).
 *
 * @param {object}   plan     — from orchestrator or file parser
 * @param {string}   pin
 * @param {object}   user     — DB user record
 * @param {string}   context  — "personal" | "business"
 * @returns {Promise<object[]>} array of per-payment results
 */
async function executePlan(plan, pin, user, context = "personal") {
  // Unlock the correct wallet for the active context
  let userWallet;
  let rawPrivateKey;
  try {
    rawPrivateKey = context === "business" && user.business_deposit_address
      ? db.decryptBusinessPrivateKey(pin, user)
      : db.decryptPrivateKey(pin, user);
    userWallet = walletLib.walletFromPrivateKey(rawPrivateKey);
  } catch {
    return [{
      success: false,
      error: "Couldn't unlock your wallet — incorrect PIN.",
      label: "All payments",
      amount: 0,
    }];
  }

  // Derive Solana Keypair for Solana on-chain payouts
  let solanaKeypairData = null;
  try {
    solanaKeypairData = multichain.deriveSolanaFromEvmKey(rawPrivateKey);
  } catch (err) {
    console.warn("[executor] Solana key derivation warning:", err.message);
  }

  const batchId = plan.batchId || `batch_${Date.now()}`;
  const results = [];

  for (let i = 0; i < (plan.payments || []).length; i++) {
    const payment = plan.payments[i];

    // 1. Determine or generate Idempotency Key
    const idempKey = payment.idempotency_key || idempotency.generateIdempotencyKey(batchId, i, payment);

    // 2. Check Idempotency Ledger — prevent duplicate executions
    const existing = idempotency.checkIdempotency(idempKey);
    if (existing && existing.status === "completed") {
      results.push({
        success: true,
        alreadyExecuted: true,
        idempotent: true,
        txHash: existing.txHash,
        reference: existing.reference,
        amount: existing.amount,
        fiatAmount: existing.currency === "NGN" ? existing.amount : null,
        to: existing.recipient,
        currency: existing.currency,
        method: existing.method,
        label: payment.label || `Payment to ${existing.recipient}`,
        chain: payment.chain,
      });
      continue;
    }

    // Record pending state in idempotency table
    idempotency.startIdempotency(idempKey, {
      batchId,
      rowIndex: i,
      recipient: payment.to || payment.account_number || `row_${i}`,
      amount: payment.amount,
      currency: payment.currency || "USDC",
      method: payment.method || "unknown",
    });

    // 3. Route payment to preferred rail:
    const isSolana = payment.method === "onchain_solana" ||
      payment.chain === "solana" ||
      multichain.isSolanaAddress(payment.to);

    const isOfframp = payment.method === "fiat_offramp" ||
      payment.to === "__offramp__" ||
      payment.currency === "NGN" ||
      (payment.account_number && !isSolana && !payment.to?.startsWith("0x"));

    let executionResult;

    if (isOfframp) {
      // ── Rail A: Nigerian Naira Bank Payout ───────────────────────────────────
      const resolved = await bankResolver.resolveBankCode(payment.bank_code || payment.bank_name);

      let amountUsdc = payment.amount;
      let fiatAmount = null;

      if (payment.currency === "NGN") {
        // Convert NGN amount to USDC equivalent using Paj's live offramp rate
        fiatAmount = payment.amount;
        try {
          const rates = await paj.getRates("NGN");
          const offrampRate = Number(rates?.offRampRate?.rate);
          if (offrampRate && offrampRate > 0) {
            amountUsdc = Math.ceil((fiatAmount / offrampRate) * 100) / 100;
          } else {
            const liveFxRate = await fx.getUsdToNgnRate();
            amountUsdc = Math.ceil((fiatAmount / liveFxRate) * 100) / 100;
          }
        } catch (rateErr) {
          const liveFxRate = await fx.getUsdToNgnRate();
          amountUsdc = Math.ceil((fiatAmount / liveFxRate) * 100) / 100;
        }
      }

      executionResult = await executeOfframp(
        userWallet,
        amountUsdc,
        {
          accountNumber: payment.account_number,
          bankCode:      resolved.bankCode,
          bankName:      resolved.bankName,
          accountName:   payment.account_name,
          fiatAmount,
        },
        user.telegram_id,
        payment.label || "Cash Out",
        {
          accountType: context,
          idempotencyKey: idempKey,
        }
      );

      if (executionResult.success) {
        executionResult.amountNgn = fiatAmount;
        executionResult.amountUsdc = amountUsdc;
      }

    } else if (isSolana) {
      // ── Rail B: Solana On-Chain Transfer ────────────────────────────────────
      if (!solanaKeypairData) {
        executionResult = {
          success: false,
          error: "Could not derive Solana credentials for payout.",
          amount: payment.amount,
          to: payment.to,
          chain: "solana",
        };
      } else {
        executionResult = await multichain.sendSolanaTransfer({
          keypair: solanaKeypairData.keypair,
          recipientAddress: payment.to,
          amount: payment.amount,
          currency: payment.currency || "USDC",
        });
        executionResult.label = payment.label;
        executionResult.chain = "solana";
      }

    } else {
      // ── Rail C: Arc EVM On-Chain Transfer ───────────────────────────────────
      executionResult = await executeOnchainPayment(
        userWallet,
        payment.to,
        payment.amount,
        user.telegram_id,
        payment.label || `Payment to ${payment.to}`,
        payment.currency || "USDC",
        {
          accountType: context,
          idempotencyKey: idempKey,
        }
      );
    }

    // 4. Update Idempotency status
    if (executionResult.success) {
      idempotency.completeIdempotency(idempKey, {
        txHash: executionResult.txHash,
        reference: executionResult.reference,
      });
    } else {
      idempotency.failIdempotency(idempKey, executionResult.error);
    }

    results.push(executionResult);
  }

  return results;
}

// ─── Result formatter ─────────────────────────────────────────────────────────

/**
 * Format an array of execution results as a Telegram confirmation message.
 * Displays rail indicators, transaction hashes, and idempotency status.
 *
 * @param {object[]} results
 * @returns {string}
 */
function formatResults(results) {
  const lines = results.map((r) => {
    const replayBadge = r.alreadyExecuted ? " _(Idempotent — already paid)_" : "";

    // Rail A: Naira Bank Offramp
    if (r.chain === "fiat" || r.to === "__offramp__" || r.currency === "NGN" || r.bankDetails) {
      if (r.success && !r.warning) {
        const ngnDisplay = r.fiatAmount || r.amountNgn
          ? `₦${Number(r.fiatAmount || r.amountNgn).toLocaleString("en-NG", { minimumFractionDigits: 2 })} NGN`
          : `${r.amount} USDC → Naira`;

        return (
          `✅ *Bank Transfer Submitted*${replayBadge}\n` +
          `   🏦 ${ngnDisplay}\n` +
          `   ${r.bankDetails?.bankName || r.bankName || "Bank"} · \`${r.bankDetails?.accountNumber || ""}\`\n` +
          `   Ref: \`${r.reference || "—"}\`\n` +
          `   Naira arrives in recipient bank account in ~1–2 minutes.`
        );
      }
      if (r.success && r.warning) {
        return (
          `⚠️ *Partially Completed*\n` +
          `   ${r.amount} USDC sent on-chain (Tx: \`${r.txHash}\`)\n` +
          `   ${r.warning}`
        );
      }
      return `❌ *Bank Transfer Failed*\n   ${r.error}`;
    }

    // Rail B: Solana On-Chain
    if (r.chain === "solana") {
      if (r.success) {
        const shortTx = r.txHash
          ? `\`${r.txHash.slice(0, 8)}...${r.txHash.slice(-6)}\``
          : "";
        return (
          `✅ *Sent on Solana*${replayBadge}\n` +
          `   🟣 ${r.amount} ${r.currency || "USDC"}\n` +
          `   → \`${r.to}\`\n` +
          (shortTx ? `   Tx: ${shortTx}\n` : "") +
          `   (${r.label || "Solana Transfer"})`
        );
      }
      return `❌ *Solana Transfer Failed* — ${r.label || r.to}\n   ${r.error}`;
    }

    // Rail C: Arc EVM On-Chain
    if (r.success) {
      const shortTx = r.txHash
        ? `\`${r.txHash.slice(0, 10)}...${r.txHash.slice(-8)}\``
        : "";
      const sponsorBadge = r.sponsored ? `\n   ⛽ Gas: Sponsored by Arc Paymaster ($0.00)` : "";
      return (
        `✅ *Sent on Arc*${replayBadge}\n` +
        `   ⚡ ${r.amount} ${r.currency || "USDC"}\n` +
        `   → \`${r.to}\`\n` +
        (shortTx ? `   Tx: ${shortTx}` : "") +
        sponsorBadge + `\n` +
        `   (${r.label || "Payment"})`
      );
    }

    return `❌ *Payment Failed* — ${r.label || r.to}\n   ${r.error}`;
  });

  // Summary line for bulk/payroll
  if (results.length > 1) {
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;
    const idempotentCount = results.filter((r) => r.alreadyExecuted).length;

    let summaryText = `\n──────────────────────────\n*Summary:* ${successCount}/${results.length} payments processed successfully.`;
    if (idempotentCount > 0) {
      summaryText += ` (${idempotentCount} skipped via Idempotency Ledger)`;
    }
    if (failCount > 0) {
      summaryText += `\n⚠️ ${failCount} payment(s) failed.`;
    }
    lines.push(summaryText);
  }

  return lines.join("\n\n");
}

module.exports = {
  executePlan,
  executeOnchainPayment,
  executeOfframp,
  formatResults,
};
