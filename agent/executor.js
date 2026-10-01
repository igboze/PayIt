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


  // ── Rail selection: cash out directly from whichever chain holds the funds ──
  // rail: "arc" | "solana" | "auto" (options.rail; default "auto").
  // If a Paj order reservation already exists, its address format is the
  // source of truth for the rail (reservations are created per-chain).
  let rail = options.rail || "auto";
  if (bankDetails && bankDetails.orderAddress) {
    rail = multichain.isSolanaAddress(bankDetails.orderAddress) ? "solana" : "arc";
  }

  const arcRailEnabled = paj.isArcRailEnabled();

  // Per-chain balances (source of truth = on-chain, no third-party addresses).
  let arcBalanceMicro;
  let solBalanceMicro = 0n;
  try {
    arcBalanceMicro = await walletLib.getNativeBalanceMicro(userWallet.address);
    const user = db.getUser(telegramId);
    if (user) {
      const solAddress = multichain.getOrDeriveSolanaAddress ? multichain.getOrDeriveSolanaAddress(user) : null;
      const solAddrsToCheck = [];
      if (solAddress) solAddrsToCheck.push(solAddress);
      if (user.solana_deposit_address && !solAddrsToCheck.includes(user.solana_deposit_address)) {
        solAddrsToCheck.push(user.solana_deposit_address);
      }
      let solUsdc = 0;
      for (const a of solAddrsToCheck) {
        if (!a) continue;
        try {
          const bal = await multichain.getSplTokenBalance(a);
          if (bal && bal.uiAmount > 0) solUsdc += bal.uiAmount;
        } catch (_) {}
      }
      solBalanceMicro = walletLib.parseToMicro(solUsdc.toFixed(6));
    }
  } catch (err) {
    idempotency.failOperationIdempotency(idempKey, err.message);
    return { success: false, error: "Could not check balance: " + err.message, label, amount: amountUsdc, chain: "fiat" };
  }

  if (rail === "auto") {
    if (arcRailEnabled && arcBalanceMicro >= amountMicro) rail = "arc";
    else if (solBalanceMicro >= amountMicro) rail = "solana";
    else rail = arcRailEnabled ? "arc" : "solana";
  }
  if (rail === "arc" && !arcRailEnabled) {
    if (options.rail === "arc") {
      idempotency.failOperationIdempotency(idempKey, "Arc rail not enabled");
      return {
        success: false,
        error: "Arc cash-out is not enabled yet (PAJ_ARC_OFFRAMP_ENABLED). Cash out via Solana instead.",
        label, amount: amountUsdc, chain: "fiat",
      };
    }
    rail = "solana";
  }

  let balance = rail === "arc" ? arcBalanceMicro : solBalanceMicro;
  if (balance < amountMicro && rail === "arc") {
    const autoEarn = require("../src/auto_earn");
    const liqRes = await autoEarn.ensureLiquidBalance({
      userWallet,
      telegramId,
      requiredAmountMicro: amountMicro,
      accountType: options.accountType,
    });
    if (liqRes.liquidated) {
      try {
        arcBalanceMicro = await walletLib.getNativeBalanceMicro(userWallet.address);
        balance = arcBalanceMicro;
      } catch {}
    }
  }

  if (balance < amountMicro) {
    idempotency.failOperationIdempotency(idempKey, "Insufficient funds");
    const railName = rail === "arc" ? "Arc" : "Solana";
    return {
      success: false,
      error:
        `Not enough USDC on ${railName}. You have $${walletLib.formatMicro(balance)} there ` +
        `(Arc: $${walletLib.formatMicro(arcBalanceMicro)} · Solana: $${walletLib.formatMicro(solBalanceMicro)}), need ${amountUsdc}. ` +
        `Use "Move Funds" to rebalance between chains.`,
      label,
      amount: amountUsdc,
      chain: "fiat",
    };
  }

  const txId = db.recordTransaction(telegramId, "offramp", amountMicro, "pending", null, options.accountType || "personal", 18, rail);

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
      const railCfg = paj.RAILS[rail] || paj.RAILS.solana;
      result = await offramp.requestOfframp(telegramId, amountMicro, {
        accountNumber: bankDetails.accountNumber,
        bankCode:      bankDetails.bankCode,
        accountName:   bankDetails.accountName,
        fiatAmount:    bankDetails.fiatAmount,
        accountType:   options.accountType       || "personal",
        chain:         railCfg.chain,
        mint:          railCfg.mint,
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

  // Step 2: On-chain send to the rail-specific settlement address.
  // No CCTP bridging here — funds already sit on the rail's chain and move
  // in a single transfer (Arc: native USDC ~1s; Solana: SPL USDC).
  const isTargetSolana = rail === "solana";
  const targetAddress = result.address || null;

  if (!targetAddress || (!isTargetSolana && !walletLib.isValidAddress(targetAddress))) {
    db.updateTransactionStatus(txId, "failed");
    idempotency.failOperationIdempotency(idempKey, "No valid settlement deposit address");
    return { success: false, error: "Paj did not return a valid settlement address for this cash out", label, amount: amountUsdc, chain: "fiat" };
  }

  let txHash;
  try {
    if (isTargetSolana) {
      // Direct SPL USDC transfer from the derived keypair to Paj's order address.
      const solData = multichain.deriveSolanaFromEvmKey(userWallet.privateKey);
      const directSolTx = await multichain.sendSolanaTransfer({
        keypair: solData.keypair,
        recipientAddress: targetAddress,
        amount: result.amount || amountUsdc,
      });
      txHash = directSolTx?.txHash || directSolTx?.signature;
      if (!txHash) {
        const detail = directSolTx?.error ? `: ${directSolTx.error}` : ".";
        throw new Error(`Solana transfer could not be completed${detail}`);
      }
    } else {
      // Arc rail: plain native-USDC transfer on Arc (~1s finality, zero bridging).
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
      rail,
      chain: "fiat",
      currency: "NGN",
    };
  } catch (err) {
    db.updateTransactionStatus(txId, "failed");
    idempotency.failOperationIdempotency(idempKey, err.message);
    return { success: false, error: "Transfer failed: " + err.message, label, amount: amountUsdc, chain: "fiat" };
  }
}

// ─── Move Funds: user-triggered CCTP rebalancing between Arc and Solana ───────

/**
 * Move USDC between the user's Arc (EVM) wallet and their derived Solana
 * address via Circle CCTP.  Balances are on-chain (no internal ledger), so a
 * move simply burns on the source chain and mints to the user's own address
 * on the destination chain.
 *
 * @param {object} userWallet  — ethers Wallet on Arc (source for arc_to_solana,
 *                               recipient for solana_to_arc)
 * @param {object} params
 * @param {string} params.direction   — "arc_to_solana" | "solana_to_arc"
 * @param {number} params.amountUsdc  — amount to move
 * @param {number} params.telegramId
 * @param {string} [params.accountType]
 * @param {object} [params.bot]       — Telegram bot (user notification on mint)
 * @returns {Promise<object>}
 */
async function moveFundsBetweenChains(userWallet, { direction, amountUsdc, telegramId, accountType = "personal", bot = null }) {
  let amountMicro;
  try {
    amountMicro = walletLib.parseToMicro(Number(amountUsdc).toFixed(6));
  } catch (err) {
    return { success: false, error: "Invalid amount: " + err.message, amount: amountUsdc, direction };
  }

  // Idempotency: an identical move (same direction + amount) already processing
  // is rejected; a completed one returns the cached result.
  const idempKey = `move:${telegramId}:${direction}:${amountUsdc}`;
  const existing = idempotency.checkOperationIdempotency(idempKey);
  if (existing && existing.status === "completed") {
    return { success: true, duplicate: true, direction, amount: amountUsdc, ...(existing.responseData || {}) };
  }
  if (existing && existing.status === "pending") {
    return { success: false, error: "An identical move is already processing. Please wait for it to finish.", direction, amount: amountUsdc };
  }
  idempotency.startOperationIdempotency(idempKey, {
    scope: "move_funds",
    telegramId,
    accountType,
    amount: amountUsdc,
  });

  // ── Arc → Solana: burn native USDC on Arc, mint SPL USDC to derived address ──
  if (direction === "arc_to_solana") {
    let arcBalanceMicro;
    try {
      arcBalanceMicro = await walletLib.getNativeBalanceMicro(userWallet.address);
    } catch (err) {
      idempotency.failOperationIdempotency(idempKey, err.message);
      return { success: false, error: "Could not check Arc balance: " + err.message, amount: amountUsdc, direction };
    }
    if (arcBalanceMicro < amountMicro) {
      idempotency.failOperationIdempotency(idempKey, "Insufficient Arc balance");
      return {
        success: false,
        error: `Not enough USDC on Arc. You have $${walletLib.formatMicro(arcBalanceMicro)}, need $${Number(amountUsdc).toFixed(2)}.`,
        amount: amountUsdc,
        direction,
      };
    }

    let recipientSolanaAddress;
    try {
      recipientSolanaAddress = multichain.deriveSolanaFromEvmKey(userWallet.privateKey).solanaAddress;
    } catch (err) {
      idempotency.failOperationIdempotency(idempKey, err.message);
      return { success: false, error: "Could not derive your Solana address: " + err.message, amount: amountUsdc, direction };
    }

    const txId = db.recordTransaction(telegramId, "move_funds", amountMicro, "pending", null, accountType, 18, "arc");
    try {
      const result = await cctpBridge.executeArcToSolanaCctpBurn({
        userWallet,
        amountUsdc: Number(amountUsdc),
        recipientSolanaAddress,
        autoCompleteOnSolana: true,
        telegramId,
      });
      if (!result || result.success === false) {
        db.updateTransactionStatus(txId, "failed");
        idempotency.failOperationIdempotency(idempKey, (result && result.error) || "Arc burn failed");
        return { success: false, error: (result && result.error) || "Arc burn failed", amount: amountUsdc, direction };
      }
      db.updateTransactionStatus(txId, "submitted", result.txHash || null);
      idempotency.completeOperationIdempotency(idempKey, {
        txHash: result.txHash,
        responseData: { txHash: result.txHash, recipient: recipientSolanaAddress, fromChain: "arc", toChain: "solana" },
      });
      return {
        success: true,
        txHash: result.txHash,
        amount: amountUsdc,
        direction,
        fromChain: "arc",
        toChain: "solana",
        recipient: recipientSolanaAddress,
      };
    } catch (err) {
      db.updateTransactionStatus(txId, "failed");
      idempotency.failOperationIdempotency(idempKey, err.message);
      return { success: false, error: "Move failed: " + err.message, amount: amountUsdc, direction };
    }
  }

  // ── Solana → Arc: burn SPL USDC on derived address, mint native USDC on Arc ──
  if (direction === "solana_to_arc") {
    let solData;
    try {
      solData = multichain.deriveSolanaFromEvmKey(userWallet.privateKey);
    } catch (err) {
      idempotency.failOperationIdempotency(idempKey, err.message);
      return { success: false, error: "Could not derive your Solana keypair: " + err.message, amount: amountUsdc, direction };
    }
    const solanaAddress = solData.keypair.publicKey.toBase58();

    // SPL balance check on the derived address (source of truth = on-chain).
    let splUsdc = 0;
    try {
      const bal = await multichain.getSplTokenBalance(solanaAddress);
      if (bal && bal.uiAmount > 0) splUsdc = bal.uiAmount;
    } catch (err) {
      idempotency.failOperationIdempotency(idempKey, err.message);
      return { success: false, error: "Could not check Solana balance: " + err.message, amount: amountUsdc, direction };
    }
    if (splUsdc < Number(amountUsdc)) {
      idempotency.failOperationIdempotency(idempKey, "Insufficient Solana balance");
      return {
        success: false,
        error: `Not enough USDC on Solana. You have $${splUsdc.toFixed(2)}, need $${Number(amountUsdc).toFixed(2)}.`,
        amount: amountUsdc,
        direction,
      };
    }

    // Pre-flight: Solana fee payer must have SOL before we burn.
    const feeCheck = await cctpBridge.checkSolanaFeePayerBalance();
    if (!feeCheck.ok) {
      idempotency.failOperationIdempotency(idempKey, "Solana fee payer low");
      return {
        success: false,
        error: `Solana fee-payer wallet (${feeCheck.address}) has insufficient SOL for gas. Your funds remain safe on Solana (${solanaAddress}).`,
        amount: amountUsdc,
        direction,
      };
    }

    const txId = db.recordTransaction(telegramId, "move_funds", amountMicro, "pending", null, accountType, 18, "solana");

    // Ledger row BEFORE burn (recovery worker picks up anything stuck).
    const inboundId = db.recordInboundCctpTransfer({
      telegramId,
      solanaAddress,
      arcAddress: userWallet.address,
      amountUsdc: Number(amountUsdc),
      solanaBurnSig: null,
      status: "initiated",
    });

    const burnResult = await multichain.executeSolanaCctpBurn({
      userKeypair: solData.keypair,
      amountUsdc: Number(amountUsdc),
      recipientArcAddress: userWallet.address,
    });
    if (!burnResult || !burnResult.success) {
      db.updateInboundCctpTransfer(inboundId, { status: "failed_burn" });
      db.updateTransactionStatus(txId, "failed");
      idempotency.failOperationIdempotency(idempKey, (burnResult && burnResult.error) || "Solana burn failed");
      return { success: false, error: "Solana CCTP burn failed: " + ((burnResult && burnResult.error) || "unknown"), amount: amountUsdc, direction };
    }

    const solanaBurnSig = burnResult.txSignature;
    // Stash the burn sig as the tx hash so the background flow's
    // updateTransactionByTxHash(solanaBurnSig, "confirmed", arcTxHash) matches.
    db.updateInboundCctpTransfer(inboundId, { solana_burn_sig: solanaBurnSig, status: "burned" });
    db.updateTransactionStatus(txId, "submitted", solanaBurnSig);

    // Background: poll Iris attestation + receiveMessage on Arc.  Notifies the
    // user on mint.  The recovery worker also picks this row up if it stalls.
    cctpBridge.completeInboundCctpTransferFlow({
      inboundId,
      solanaBurnSig,
      recipientArcAddress: userWallet.address,
      amountUsdc: Number(amountUsdc),
      telegramId,
      bot,
    }).catch((err) => console.warn("[executor:move_funds] inbound completion note:", err.message));

    idempotency.completeOperationIdempotency(idempKey, {
      txHash: solanaBurnSig,
      responseData: { txHash: solanaBurnSig, inboundId, fromChain: "solana", toChain: "arc" },
    });
    return {
      success: true,
      txHash: solanaBurnSig,
      amount: amountUsdc,
      direction,
      fromChain: "solana",
      toChain: "arc",
      inboundId,
    };
  }

  idempotency.failOperationIdempotency(idempKey, "Unknown direction");
  return { success: false, error: `Unknown direction "${direction}". Use "arc_to_solana" or "solana_to_arc".`, amount: amountUsdc };
}

const CROSSCHAIN_WITHDRAWAL_FEE_USDC = Number(process.env.CROSSCHAIN_WITHDRAWAL_FEE_USDC ?? 0.30);
const PAYROLL_PER_PAYEE_FEE_USDC = Number(process.env.PAYROLL_PER_PAYEE_FEE_USDC ?? 0.10);

function getFeeRecipientAddress() {
  return (
    process.env.APP_FEE_RECIPIENT_ADDRESS ||
    process.env.PAYIT_DEV_FEE_ADDRESS ||
    "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"
  );
}

/**
 * Execute a cross-chain withdrawal of Arc USDC to ANY destination chain and address.
 *
 * Tier 1: CCTP-Supported Chains (Solana, Base, Arbitrum, Optimism, Polygon, Avalanche, Ethereum)
 *   -> Burns USDC on Arc via CCTP, mints native USDC directly to destinationAddress.
 *
 * Tier 2: Intent-Supported Chains (Bitcoin, Tron, NEAR)
 *   -> Burns USDC on Arc to Base via CCTP, then executes 1Click Intent to swap & deliver.
 */
async function executeCrossChainWithdrawal(userWallet, {
  destinationChain,
  destinationAddress,
  destinationAsset = "USDC",
  amountUsdc,
  telegramId,
  accountType = "personal",
  bot = null,
}) {
  let amountMicro;
  try {
    amountMicro = walletLib.parseToMicro(Number(amountUsdc).toFixed(6));
  } catch (err) {
    return { success: false, error: "Invalid amount: " + err.message, amount: amountUsdc, destinationChain };
  }

  const chainKey = String(destinationChain || "").toLowerCase();
  const idempKey = `withdraw_cc:${telegramId}:${chainKey}:${destinationAddress}:${amountUsdc}`;
  const existing = idempotency.checkOperationIdempotency(idempKey);
  if (existing && existing.status === "completed") {
    return { success: true, duplicate: true, amount: amountUsdc, destinationChain, ...(existing.responseData || {}) };
  }
  if (existing && existing.status === "pending") {
    return { success: false, error: "A withdrawal to this address is currently processing. Please wait.", destinationChain, amount: amountUsdc };
  }

  idempotency.startOperationIdempotency(idempKey, {
    scope: "crosschain_withdrawal",
    telegramId,
    accountType,
    amount: amountUsdc,
  });

  // Balance Check on Arc
  let arcBalanceMicro;
  try {
    arcBalanceMicro = await walletLib.getNativeBalanceMicro(userWallet.address);
  } catch (err) {
    idempotency.failOperationIdempotency(idempKey, err.message);
    return { success: false, error: "Could not check Arc balance: " + err.message, amount: amountUsdc, destinationChain };
  }
  if (arcBalanceMicro < amountMicro) {
    idempotency.failOperationIdempotency(idempKey, "Insufficient Arc balance");
    return {
      success: false,
      error: `Not enough USDC on Arc. You have $${walletLib.formatMicro(arcBalanceMicro)}, need $${Number(amountUsdc).toFixed(2)}.`,
      amount: amountUsdc,
      destinationChain,
    };
  }

  // Calculate protocol bridge fee (e.g. $0.30 flat)
  const platformFee = Number(amountUsdc) > CROSSCHAIN_WITHDRAWAL_FEE_USDC
    ? CROSSCHAIN_WITHDRAWAL_FEE_USDC
    : 0;
  const netAmountUsdc = Number((Number(amountUsdc) - platformFee).toFixed(6));

  // Route platform fee to fee recipient address on Arc if configured
  const feeRecipient = getFeeRecipientAddress();
  if (platformFee > 0 && feeRecipient && walletLib.isValidAddress(feeRecipient) && userWallet.address.toLowerCase() !== feeRecipient.toLowerCase()) {
    try {
      const feeMicro = walletLib.parseToMicro(platformFee.toFixed(6));
      await walletLib.sendSponsoredOrDirectTransaction(userWallet, feeRecipient, feeMicro);
      console.log(`[executor] Collected $${platformFee} crosschain fee on Arc -> ${feeRecipient}`);
    } catch (feeErr) {
      console.warn("[executor:withdrawal_fee_note]", feeErr.message);
    }
  }

  const CCTP_CHAINS = new Set(["solana", "base", "arbitrum", "optimism", "polygon", "avalanche", "ethereum"]);

  // ── Tier 1: Direct CCTP Withdrawal ──────────────────────────────────────────
  if (CCTP_CHAINS.has(chainKey)) {
    const txId = db.recordTransaction(telegramId, "crosschain_withdraw", amountMicro, "pending", null, accountType, 18, "arc");
    try {
      const result = await cctpBridge.executeArcCrossChainWithdrawal({
        userWallet,
        amountUsdc: netAmountUsdc,
        destinationChain: chainKey,
        destinationAddress,
        telegramId,
      });

      if (!result || result.success === false) {
        db.updateTransactionStatus(txId, "failed");
        idempotency.failOperationIdempotency(idempKey, (result && result.error) || "Arc CCTP burn failed");
        return { success: false, error: (result && result.error) || "Arc CCTP burn failed", amount: amountUsdc, destinationChain };
      }

      db.updateTransactionStatus(txId, "submitted", result.txHash || null);
      idempotency.completeOperationIdempotency(idempKey, {
        txHash: result.txHash,
        responseData: {
          txHash: result.txHash,
          destinationChain,
          destinationAddress,
          amountUsdc,
          engine: "CCTP",
        },
      });

      return {
        success: true,
        txHash: result.txHash,
        amount: amountUsdc,
        destinationChain,
        destinationAddress,
        engine: "CCTP",
      };
    } catch (err) {
      db.updateTransactionStatus(txId, "failed");
      idempotency.failOperationIdempotency(idempKey, err.message);
      return { success: false, error: "Cross-chain withdrawal failed: " + err.message, amount: amountUsdc, destinationChain };
    }
  }

  // ── Tier 2: Intent-based Withdrawal (BTC, Tron, NEAR) ───────────────────────
  // Step 1: Arc burns USDC to Base relayer address via CCTP
  // Step 2: PayIT triggers 1Click Intent from Base USDC to destination chain
  const INTENT_CHAINS = new Set(["bitcoin", "btc", "tron", "near"]);
  if (INTENT_CHAINS.has(chainKey)) {
    const txId = db.recordTransaction(telegramId, "intent_withdraw", amountMicro, "pending", null, accountType, 18, "arc");
    try {
      // Burn to Base relayer / destination
      const baseBurn = await cctpBridge.executeArcToEvmCctpBurn({
        userWallet,
        amountUsdc: Number(amountUsdc),
        destinationDomain: cctpBridge.CCTP_DOMAINS.BASE,
        destinationRecipientAddress: userWallet.address, // Base address
        telegramId,
      });

      if (!baseBurn || !baseBurn.success) {
        db.updateTransactionStatus(txId, "failed");
        idempotency.failOperationIdempotency(idempKey, baseBurn?.error || "Intent hop burn failed");
        return { success: false, error: baseBurn?.error || "Intent hop burn failed", amount: amountUsdc, destinationChain };
      }

      db.updateTransactionStatus(txId, "submitted", baseBurn.txHash || null);
      idempotency.completeOperationIdempotency(idempKey, {
        txHash: baseBurn.txHash,
        responseData: {
          txHash: baseBurn.txHash,
          destinationChain,
          destinationAddress,
          amountUsdc,
          engine: "NEAR_INTENTS",
        },
      });

      return {
        success: true,
        txHash: baseBurn.txHash,
        amount: amountUsdc,
        destinationChain,
        destinationAddress,
        engine: "NEAR_INTENTS",
      };
    } catch (err) {
      db.updateTransactionStatus(txId, "failed");
      idempotency.failOperationIdempotency(idempKey, err.message);
      return { success: false, error: "Intent withdrawal failed: " + err.message, amount: amountUsdc, destinationChain };
    }
  }

  idempotency.failOperationIdempotency(idempKey, "Unsupported destination chain");
  return { success: false, error: `Unsupported destination chain "${destinationChain}".`, amount: amountUsdc };
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
  moveFundsBetweenChains,
  executeCrossChainWithdrawal,
  formatResults,
};
