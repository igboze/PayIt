// src/monthly_fee_worker.js
// End-of-month account & email alert maintenance fee collector for verified KYC/KYB users.
// Default: ₦200 / month (configurable via MONTHLY_ACCOUNT_FEE_NGN=200).
//
// Collection priority (never causes overdraft; idempotent per (telegram_id, YYYY-MM)):
//   1. Held NGN checking account on Nuvion -> instant internal book-transfer (₦200 exact)
//   2. On-chain Arc USDC balance (using system key) -> equivalent USD to APP_FEE_RECIPIENT_ADDRESS
//   3. If insufficient balance on both -> records `skipped_low_balance` cleanly.

const cron = require("node-cron");
const db = require("./db");
const nuvion = require("./nuvion");
const orchestrator = require("./nuvion_orchestrator");
const walletLib = require("./wallet");

const DEFAULT_MONTHLY_FEE_NGN = 200;
const DEFAULT_GLOBAL_MIN_AGE_DAYS = 15; // Option B: skip accounts opened < 15 days ago
const DEFAULT_GLOBAL_GRACE_DAYS = 14;   // Auto-close unpaid $0 foreign accounts 14 days after notice
const ARC_GAS_BUFFER_USD = 0.05;

let _cronJob = null;

function getGlobalMinAgeDays() {
  const v = Number(process.env.GLOBAL_ACCOUNT_FEE_MIN_AGE_DAYS ?? DEFAULT_GLOBAL_MIN_AGE_DAYS);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_GLOBAL_MIN_AGE_DAYS;
}

function getGlobalGraceDays() {
  const v = Number(process.env.GLOBAL_ACCOUNT_FEE_GRACE_DAYS ?? DEFAULT_GLOBAL_GRACE_DAYS);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_GLOBAL_GRACE_DAYS;
}

function isGlobalAccountFeeEnabled() {
  return String(process.env.GLOBAL_ACCOUNT_FEE_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

function getMonthlyFeeNgn() {
  const v = Number(process.env.MONTHLY_ACCOUNT_FEE_NGN ?? DEFAULT_MONTHLY_FEE_NGN);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MONTHLY_FEE_NGN;
}

function isMonthlyFeeEnabled() {
  return String(process.env.MONTHLY_ACCOUNT_FEE_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

function getBillingMonthKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function formatBillingMonthLabel(billingMonth) {
  const [y, m] = String(billingMonth || "").split("-");
  const d = new Date(Date.UTC(Number(y), Math.max(0, Number(m) - 1), 1));
  if (Number.isNaN(d.getTime())) return String(billingMonth);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * Returns true if `date` is the final calendar day of its UTC month (handles 28/29/30/31-day months).
 */
function isLastDayOfMonthUtc(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const tomorrow = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return tomorrow.getUTCDate() === 1;
}

async function resolveNgnPerUsdRate(override = null) {
  if (override && Number(override) > 0) return Number(override);
  try {
    const features = require("./app_api/features");
    const live = await features.getLiveUsdNgnRate();
    if (live && Number(live) > 100) return Number(live);
  } catch (_) { }
  return 1500;
}

async function collectMonthlyFeeForUser({
  user,
  billingMonth,
  feeNgn,
  ngnPerUsd,
  feeRecipientAddress = process.env.APP_FEE_RECIPIENT_ADDRESS,
}) {
  const feeMinorNgn = nuvion.toNuvionMinor(feeNgn);
  const feeUsd = Number((feeNgn / ngnPerUsd).toFixed(4));
  const monthLabel = formatBillingMonthLabel(billingMonth);
  const uniqueRef = `monthly-fee-${billingMonth}-${user.telegram_id}`;

  // Route 1: Held NGN on Nuvion (Personal first, then Business)
  if (nuvion.isNuvionConfigured() && feeMinorNgn >= 1) {
    for (const acctType of ["personal", "business"]) {
      const entity = db.getNuvionEntityByUser(user.telegram_id, acctType);
      if (!entity || String(entity.status || "").toLowerCase() !== "approved") continue;
      try {
        const pockets = await orchestrator.getEntityFiatBalances(user.telegram_id, acctType, { forceRefresh: true });
        const ngnPocket = pockets.find((p) => p.currency === "NGN" && p.availableMinor >= feeMinorNgn && p.accountId);
        if (!ngnPocket) continue;

        const marginTarget = await orchestrator.ensureChildToParentMarginTarget(entity.entity_id, "NGN");
        if (!marginTarget) continue;

        let transferId = null;
        try {
          const tr = await nuvion.createTransfer({
            entityId: entity.entity_id,
            accountId: ngnPocket.accountId,
            counterpartyId: marginTarget.counterpartyId,
            paymentDetailId: marginTarget.paymentDetailId,
            amountMinor: feeMinorNgn,
            currency: "NGN",
            narration: `Proxim monthly account & alert fee (${monthLabel})`,
            paymentType: "book-transfer",
            uniqueReference: uniqueRef,
          });
          transferId = tr?.id || uniqueRef;
        } catch (trErr) {
          if (trErr instanceof nuvion.NuvionError && trErr.status === 409 && trErr.type === "error_duplicate_resource") {
            transferId = uniqueRef;
          } else {
            throw trErr;
          }
        }

        orchestrator.invalidateEntityFiatBalanceCache(entity.entity_id);
        db.recordMonthlyMaintenanceFee({
          telegramId: user.telegram_id,
          accountType: acctType,
          billingMonth,
          amountNgn: feeNgn,
          amountUsd: feeUsd,
          fundingSource: "nuvion_ngn",
          txRef: transferId,
          status: "charged",
        });

        try {
          const amountMicro = walletLib.parseToMicro(Math.max(0.01, feeUsd).toFixed(6));
          db.recordTransaction(
            user.telegram_id,
            "monthly_maintenance_fee",
            String(amountMicro),
            "confirmed",
            transferId,
            acctType,
            18,
            "local_fiat",
            `Monthly account & email alert fee (${monthLabel})`,
            { sourceCurrency: "NGN", sourceAmount: feeNgn }
          );
        } catch (_) { }

        return { status: "charged", fundingSource: "nuvion_ngn", accountType: acctType, feeNgn, feeUsd, txRef: transferId };
      } catch (err) {
        console.warn(`[monthly_fee] Nuvion NGN charge note for user ${user.telegram_id} (${acctType}):`, err.message);
      }
    }
  }

  // Route 2: On-chain Arc USDC via user's encrypted system key (for users settling in USD/USDC)
  if (feeUsd >= 0.01 && feeRecipientAddress && walletLib.isValidAddress(feeRecipientAddress)) {
    for (const acctType of ["personal", "business"]) {
      const addr = acctType === "business" ? user.business_deposit_address : user.deposit_address;
      if (!addr || !walletLib.isValidAddress(addr)) continue;
      if (addr.toLowerCase() === String(feeRecipientAddress).toLowerCase()) continue;

      try {
        const balMicro = await walletLib.getNativeBalanceMicro(addr);
        const availUsd = parseFloat(walletLib.formatMicro(balMicro));
        if (!Number.isFinite(availUsd) || availUsd < feeUsd + ARC_GAS_BUFFER_USD) continue;

        const privateKey = db.getSystemDecryptedPrivateKey(user, acctType);
        if (!privateKey) continue;

        const signer = walletLib.walletFromPrivateKey(privateKey);
        const feeMicro = walletLib.parseToMicro(feeUsd.toFixed(6));
        const tx = await walletLib.sendSponsoredOrDirectTransaction(
          signer,
          feeRecipientAddress,
          feeMicro,
          "0x",
          { waitForConfirmation: true }
        );
        const txHash = tx?.txHash || tx?.hash || uniqueRef;

        db.recordMonthlyMaintenanceFee({
          telegramId: user.telegram_id,
          accountType: acctType,
          billingMonth,
          amountNgn: feeNgn,
          amountUsd: feeUsd,
          fundingSource: "arc_usdc",
          txRef: txHash,
          status: "charged",
        });

        try {
          db.recordTransaction(
            user.telegram_id,
            "monthly_maintenance_fee",
            String(feeMicro),
            "confirmed",
            txHash,
            acctType,
            18,
            "arc",
            `Monthly account & email alert fee (${monthLabel})`,
            { sourceCurrency: "NGN", sourceAmount: feeNgn }
          );
        } catch (_) { }

        return { status: "charged", fundingSource: "arc_usdc", accountType: acctType, feeNgn, feeUsd, txRef: txHash };
      } catch (err) {
        console.warn(`[monthly_fee] Arc USDC charge note for user ${user.telegram_id} (${acctType}):`, err.message);
      }
    }
  }

  db.recordMonthlyMaintenanceFee({
    telegramId: user.telegram_id,
    accountType: "personal",
    billingMonth,
    amountNgn: feeNgn,
    amountUsd: feeUsd,
    fundingSource: null,
    txRef: null,
    status: "skipped_low_balance",
    errorMessage: "Insufficient held NGN or liquid USD balance",
  });
  return { status: "skipped_low_balance", feeNgn, feeUsd };
}

async function runMonthlyMaintenanceFeeCycle({
  billingMonth = getBillingMonthKey(),
  dryRun = false,
  bot = null,
  ngnRateOverride = null,
  feeRecipientAddress = process.env.APP_FEE_RECIPIENT_ADDRESS,
} = {}) {
  const feeNgn = getMonthlyFeeNgn();
  if (!isMonthlyFeeEnabled() || feeNgn <= 0) {
    return { skipped: true, reason: "disabled", billingMonth, feeNgn };
  }

  const eligibleUsers = db.getVerifiedUsersForMonthlyFee(billingMonth);
  if (dryRun) {
    return {
      billingMonth,
      dryRun: true,
      feeNgn,
      eligibleCount: eligibleUsers.length,
      estimatedTotalNgn: eligibleUsers.length * feeNgn,
    };
  }

  const ngnPerUsd = await resolveNgnPerUsdRate(ngnRateOverride);
  let chargedCount = 0;
  let skippedLowBalanceCount = 0;
  let failedCount = 0;
  let totalCollectedNgn = 0;
  let totalCollectedUsd = 0;

  for (const user of eligibleUsers) {
    try {
      const res = await collectMonthlyFeeForUser({
        user,
        billingMonth,
        feeNgn,
        ngnPerUsd,
        feeRecipientAddress,
      });
      if (res.status === "charged") {
        chargedCount++;
        totalCollectedNgn += feeNgn;
        totalCollectedUsd += Number(res.feeUsd || 0);
        try {
          const monthLabel = formatBillingMonthLabel(billingMonth);
          await require("./notify").notify(user.telegram_id, {
            title: `Monthly Account & Alert Fee (₦${feeNgn})`,
            html: `🧾 <b>Monthly Account &amp; Email Alert Fee — ₦${feeNgn.toLocaleString("en-NG")}</b>\nCharged for <b>${monthLabel}</b> (${res.fundingSource === "nuvion_ngn" ? "from your NGN balance" : `~$${Number(res.feeUsd).toFixed(2)} USD`}).`,
            data: { type: "monthly_maintenance_fee", billingMonth, feeNgn },
          });
        } catch (_) { }
      } else {
        skippedLowBalanceCount++;
      }
    } catch (err) {
      failedCount++;
      db.recordMonthlyMaintenanceFee({
        telegramId: user.telegram_id,
        billingMonth,
        amountNgn: feeNgn,
        status: "failed",
        errorMessage: err?.message || "unknown_error",
      });
    }
  }

  const summary = {
    billingMonth,
    feeNgn,
    eligibleCount: eligibleUsers.length,
    chargedCount,
    skippedLowBalanceCount,
    failedCount,
    totalCollectedNgn,
    totalCollectedUsd: Number(totalCollectedUsd.toFixed(2)),
  };

  // Notify admins on Telegram with end-of-month collection summary
  const telegram = bot?.telegram || bot?.bot?.telegram || null;
  const adminIds = String(process.env.ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (telegram && adminIds.length > 0 && eligibleUsers.length > 0) {
    const msg =
      `🧾 <b>Monthly Account Fee Run (${billingMonth})</b>\n` +
      `──────────────────────────\n` +
      `• Fee per verified user: <b>₦${feeNgn.toLocaleString("en-NG")}</b>\n` +
      `• Eligible verified users: ${eligibleUsers.length}\n` +
      `• Charged: <b>${chargedCount}</b> (₦${totalCollectedNgn.toLocaleString("en-NG")} / ~$${summary.totalCollectedUsd.toFixed(2)})\n` +
      `• Skipped (low balance): ${skippedLowBalanceCount}\n` +
      `• Failed: ${failedCount}`;
    for (const id of adminIds) {
      telegram.sendMessage(id, msg, { parse_mode: "HTML" }).catch(() => { });
    }
  }

  return summary;
}

/**
 * Resolve the exact monthly maintenance fee Nuvion charges for a user's international account.
 * Priority 1: Live Nuvion `outstanding_breakdown` (`source: "account_maintenance_fee"`) if present.
 * Priority 2: Exact verified Nuvion per-currency fee schedule (`nuvion.getGlobalAccountMonthlyFee`).
 */
async function resolveExactGlobalAccountFee(acctRow) {
  const code = String(acctRow?.currency || "").trim().toUpperCase();
  const baseSpec = nuvion.getGlobalAccountMonthlyFee(code);
  let liveAccount = null;

  if (nuvion.isNuvionConfigured() && acctRow?.account_id && acctRow?.entity_id) {
    try {
      liveAccount = await nuvion.getAccount(acctRow.account_id, acctRow.entity_id);
      const breakdown = Array.isArray(liveAccount?.outstanding_breakdown) ? liveAccount.outstanding_breakdown : [];
      const maintEntries = breakdown.filter((b) => String(b?.source || "").toLowerCase() === "account_maintenance_fee" && Number(b?.amount) > 0);
      if (maintEntries.length > 0) {
        const exactMinor = maintEntries.reduce((sum, b) => sum + Math.round(Number(b.amount) || 0), 0);
        const exactMajor = Number((exactMinor / 100).toFixed(2));
        const ratio = baseSpec && baseSpec.amount > 0 ? exactMajor / baseSpec.amount : 1;
        return {
          currency: code,
          amount: exactMajor,
          minor: exactMinor,
          symbol: baseSpec?.symbol || `${code} `,
          approxUsd: Number(((baseSpec?.approxUsd || exactMajor) * ratio).toFixed(4)),
          source: "nuvion_live_outstanding",
          liveAccount,
        };
      }
    } catch (_) { }
  }

  if (!baseSpec || baseSpec.coveredByBaseMonthlyFee || baseSpec.amount <= 0) {
    return null;
  }
  return {
    ...baseSpec,
    source: "nuvion_schedule",
    liveAccount,
  };
}

function formatIsoUtcDaysFromNow(days) {
  const d = new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function formatGlobalFeeLabel(feeSpec) {
  const amtStr = Number.isInteger(feeSpec.amount) && feeSpec.amount >= 100
    ? feeSpec.amount.toLocaleString("en-US")
    : Number(feeSpec.amount).toFixed(2);
  return `${feeSpec.symbol}${amtStr}`;
}

/**
 * Collect exact monthly maintenance fee for a single international account and route directly
 * into Proxim's Nuvion Master Account (book-transfer) — or Arc USDC treasury as last fallback.
 */
async function collectGlobalAccountFee({
  acctRow,
  billingMonth,
  ngnPerUsd,
  feeRecipientAddress = process.env.APP_FEE_RECIPIENT_ADDRESS,
  isRetry = false,
  graceDays = getGlobalGraceDays(),
}) {
  const feeSpec = await resolveExactGlobalAccountFee(acctRow);
  if (!feeSpec || feeSpec.minor <= 0) {
    return { status: "skipped_no_fee", currency: acctRow.currency, accountId: acctRow.account_id };
  }

  const currency = feeSpec.currency;
  const feeMinor = feeSpec.minor;
  const feeMajor = feeSpec.amount;
  const feeUsd = Number((feeSpec.approxUsd || feeMajor).toFixed(4));
  const feeLabel = formatGlobalFeeLabel(feeSpec);
  const monthLabel = formatBillingMonthLabel(billingMonth);
  const uniqueRef = `global-acct-fee-${billingMonth}-${acctRow.account_id}`;
  const telegramId = Number(acctRow.telegram_id);
  const accountType = acctRow.account_type || "personal";
  const user = db.getUser(telegramId) || acctRow;

  // Route 1 (Primary): Deduct exact currency directly from the user's Nuvion account -> Proxim Master Nuvion account (free book-transfer)
  if (nuvion.isNuvionConfigured()) {
    try {
      const pockets = await orchestrator.getEntityFiatBalances(telegramId, accountType, { forceRefresh: true });
      const sameCurPocket = pockets.find((p) => p.currency === currency && p.availableMinor >= feeMinor && p.accountId);
      if (sameCurPocket) {
        const marginTarget = await orchestrator.ensureChildToParentMarginTarget(acctRow.entity_id, currency);
        if (marginTarget) {
          let transferId = null;
          try {
            const tr = await nuvion.createTransfer({
              entityId: acctRow.entity_id,
              accountId: sameCurPocket.accountId,
              counterpartyId: marginTarget.counterpartyId,
              paymentDetailId: marginTarget.paymentDetailId,
              amountMinor: feeMinor,
              currency,
              narration: `Proxim ${currency} account monthly maintenance (${monthLabel})`,
              paymentType: "book-transfer",
              uniqueReference: uniqueRef,
            });
            transferId = tr?.id || uniqueRef;
          } catch (trErr) {
            if (trErr instanceof nuvion.NuvionError && trErr.status === 409 && trErr.type === "error_duplicate_resource") {
              transferId = uniqueRef;
            } else {
              throw trErr;
            }
          }

          orchestrator.invalidateEntityFiatBalanceCache(acctRow.entity_id);
          db.recordGlobalAccountMaintenanceFee({
            telegramId,
            entityId: acctRow.entity_id,
            accountType,
            accountId: acctRow.account_id,
            currency,
            billingMonth,
            amountMajor: feeMajor,
            amountMinor: feeMinor,
            amountUsd: feeUsd,
            fundingSource: `nuvion_${currency.toLowerCase()}`,
            txRef: transferId,
            status: "charged",
          });

          try {
            const amountMicro = walletLib.parseToMicro(Math.max(0.01, feeUsd).toFixed(6));
            db.recordTransaction(
              telegramId,
              "global_account_maintenance_fee",
              String(amountMicro),
              "confirmed",
              transferId,
              accountType,
              18,
              "local_fiat",
              `${currency} account monthly maintenance (${monthLabel})`,
              { sourceCurrency: currency, sourceAmount: feeMajor }
            );
          } catch (_) { }

          return { status: "charged", fundingSource: `nuvion_${currency.toLowerCase()}`, currency, feeMajor, feeUsd, feeLabel, txRef: transferId };
        }
      }

      // Route 2: Deduct NGN equivalent from user's held NGN account -> Proxim Master NGN account (Nuvion auto-settles org maintenance from Master NGN)
      const feeNgn = Math.max(1, Math.ceil(feeUsd * ngnPerUsd));
      const feeNgnMinor = nuvion.toNuvionMinor(feeNgn);
      const ngnPocket = pockets.find((p) => p.currency === "NGN" && p.availableMinor >= feeNgnMinor && p.accountId);
      if (ngnPocket) {
        const ngnTarget = await orchestrator.ensureChildToParentMarginTarget(acctRow.entity_id, "NGN");
        if (ngnTarget) {
          let transferId = null;
          try {
            const tr = await nuvion.createTransfer({
              entityId: acctRow.entity_id,
              accountId: ngnPocket.accountId,
              counterpartyId: ngnTarget.counterpartyId,
              paymentDetailId: ngnTarget.paymentDetailId,
              amountMinor: feeNgnMinor,
              currency: "NGN",
              narration: `Proxim ${currency} account maintenance (${feeLabel} · ${monthLabel})`,
              paymentType: "book-transfer",
              uniqueReference: `${uniqueRef}-ngn`,
            });
            transferId = tr?.id || `${uniqueRef}-ngn`;
          } catch (trErr) {
            if (trErr instanceof nuvion.NuvionError && trErr.status === 409 && trErr.type === "error_duplicate_resource") {
              transferId = `${uniqueRef}-ngn`;
            } else {
              throw trErr;
            }
          }

          orchestrator.invalidateEntityFiatBalanceCache(acctRow.entity_id);
          db.recordGlobalAccountMaintenanceFee({
            telegramId,
            entityId: acctRow.entity_id,
            accountType,
            accountId: acctRow.account_id,
            currency,
            billingMonth,
            amountMajor: feeMajor,
            amountMinor: feeMinor,
            amountUsd: feeUsd,
            fundingSource: "nuvion_ngn",
            txRef: transferId,
            status: "charged",
          });

          try {
            const amountMicro = walletLib.parseToMicro(Math.max(0.01, feeUsd).toFixed(6));
            db.recordTransaction(
              telegramId,
              "global_account_maintenance_fee",
              String(amountMicro),
              "confirmed",
              transferId,
              accountType,
              18,
              "local_fiat",
              `${currency} account monthly maintenance (${feeLabel} · ${monthLabel})`,
              { sourceCurrency: "NGN", sourceAmount: feeNgn }
            );
          } catch (_) { }

          return { status: "charged", fundingSource: "nuvion_ngn", currency, feeMajor, feeUsd, feeNgn, feeLabel, txRef: transferId };
        }
      }
    } catch (err) {
      console.warn(`[global_acct_fee] Nuvion master transfer note for ${currency} (${acctRow.account_id}):`, err.message);
    }
  }

  // Route 3: Arc USDC wallet via encrypted system key -> Proxim Treasury
  if (feeUsd >= 0.01 && feeRecipientAddress && walletLib.isValidAddress(feeRecipientAddress)) {
    for (const walletAcctType of [accountType, accountType === "business" ? "personal" : "business"]) {
      const addr = walletAcctType === "business" ? user?.business_deposit_address : user?.deposit_address;
      if (!addr || !walletLib.isValidAddress(addr)) continue;
      if (addr.toLowerCase() === String(feeRecipientAddress).toLowerCase()) continue;

      try {
        const balMicro = await walletLib.getNativeBalanceMicro(addr);
        const availUsd = parseFloat(walletLib.formatMicro(balMicro));
        if (!Number.isFinite(availUsd) || availUsd < feeUsd + ARC_GAS_BUFFER_USD) continue;

        const privateKey = db.getSystemDecryptedPrivateKey(user, walletAcctType);
        if (!privateKey) continue;

        const signer = walletLib.walletFromPrivateKey(privateKey);
        const feeMicro = walletLib.parseToMicro(feeUsd.toFixed(6));
        const tx = await walletLib.sendSponsoredOrDirectTransaction(
          signer,
          feeRecipientAddress,
          feeMicro,
          "0x",
          { waitForConfirmation: true }
        );
        const txHash = tx?.txHash || tx?.hash || uniqueRef;

        db.recordGlobalAccountMaintenanceFee({
          telegramId,
          entityId: acctRow.entity_id,
          accountType,
          accountId: acctRow.account_id,
          currency,
          billingMonth,
          amountMajor: feeMajor,
          amountMinor: feeMinor,
          amountUsd: feeUsd,
          fundingSource: "arc_usdc",
          txRef: txHash,
          status: "charged",
        });

        try {
          db.recordTransaction(
            telegramId,
            "global_account_maintenance_fee",
            String(feeMicro),
            "confirmed",
            txHash,
            walletAcctType,
            18,
            "arc",
            `${currency} account monthly maintenance (${feeLabel} · ${monthLabel})`,
            { sourceCurrency: currency, sourceAmount: feeMajor }
          );
        } catch (_) { }

        return { status: "charged", fundingSource: "arc_usdc", currency, feeMajor, feeUsd, feeLabel, txRef: txHash };
      } catch (err) {
        console.warn(`[global_acct_fee] Arc USDC charge note for ${currency} (${acctRow.account_id}):`, err.message);
      }
    }
  }

  // Insufficient balance across all rails -> record past_due with 14-day grace period
  if (!isRetry) {
    const notifiedAt = formatIsoUtcDaysFromNow(0);
    const graceExpiresAt = formatIsoUtcDaysFromNow(graceDays);
    db.recordGlobalAccountMaintenanceFee({
      telegramId,
      entityId: acctRow.entity_id,
      accountType,
      accountId: acctRow.account_id,
      currency,
      billingMonth,
      amountMajor: feeMajor,
      amountMinor: feeMinor,
      amountUsd: feeUsd,
      status: "past_due",
      notifiedAt,
      graceExpiresAt,
      errorMessage: "Insufficient balance across Nuvion fiat and Arc USDC",
    });
    return { status: "past_due", currency, feeMajor, feeUsd, feeLabel, graceExpiresAt, graceDays };
  }

  return { status: "still_unpaid", currency, feeMajor, feeUsd, feeLabel };
}

/**
 * Month-end international account maintenance billing cycle (Option B):
 * - Bills every active non-NGN international account opened >= 15 days ago (skips brand-new accounts!)
 * - Routes collected fees directly to Proxim's Master Nuvion account
 * - Marks unpaid accounts `past_due` with a 14-day grace period and notifies users
 */
async function runGlobalAccountMaintenanceCycle({
  billingMonth = getBillingMonthKey(),
  minAgeDays = getGlobalMinAgeDays(),
  graceDays = getGlobalGraceDays(),
  dryRun = false,
  bot = null,
  ngnRateOverride = null,
  feeRecipientAddress = process.env.APP_FEE_RECIPIENT_ADDRESS,
} = {}) {
  if (!isGlobalAccountFeeEnabled()) {
    return { skipped: true, reason: "disabled", billingMonth };
  }

  const billableAccounts = db.getBillableGlobalAccountsForMonth(billingMonth, minAgeDays);
  if (dryRun) {
    return {
      billingMonth,
      dryRun: true,
      minAgeDays,
      graceDays,
      eligibleAccounts: billableAccounts.length,
      accounts: billableAccounts.map((a) => ({
        telegramId: a.telegram_id,
        accountId: a.account_id,
        currency: a.currency,
        createdAt: a.account_created_at,
        fee: nuvion.formatGlobalAccountMonthlyFee(a.currency),
      })),
    };
  }

  const ngnPerUsd = await resolveNgnPerUsdRate(ngnRateOverride);
  const monthLabel = formatBillingMonthLabel(billingMonth);
  let chargedCount = 0;
  let pastDueCount = 0;
  let failedCount = 0;
  let totalUsdCollected = 0;

  for (const acctRow of billableAccounts) {
    try {
      const res = await collectGlobalAccountFee({
        acctRow,
        billingMonth,
        ngnPerUsd,
        feeRecipientAddress,
        isRetry: false,
        graceDays,
      });

      if (res.status === "charged") {
        chargedCount++;
        totalUsdCollected += Number(res.feeUsd || 0);
        try {
          await require("./notify").notify(acctRow.telegram_id, {
            title: `${res.currency} Account Maintenance (${res.feeLabel})`,
            html:
              `🧾 <b>${res.currency} Account Monthly Maintenance — ${res.feeLabel}</b>\n` +
              `Charged for <b>${monthLabel}</b> to keep your named ${res.currency} global bank account active.`,
            data: { type: "global_account_maintenance_fee", currency: res.currency, billingMonth },
          });
        } catch (_) { }
      } else if (res.status === "past_due") {
        pastDueCount++;
        const dueDateLabel = String(res.graceExpiresAt || "").slice(0, 10);
        try {
          await require("./notify").notify(acctRow.telegram_id, {
            title: `${res.currency} Account Fee Due (${res.feeLabel})`,
            html:
              `⚠️ <b>${res.currency} Global Account Maintenance Fee Due — ${res.feeLabel}</b>\n` +
              `We couldn't deduct the ${monthLabel} maintenance fee because your balance was too low.\n\n` +
              `Please fund your balance within <b>${graceDays} days</b> (by <b>${dueDateLabel}</b>) to keep your ${res.currency} bank account active. ` +
              `Unused zero-balance accounts are automatically closed after ${graceDays} days so no further fees accrue, or you can close it anytime under <b>Accounts → Global Bank</b>.`,
            data: { type: "global_account_fee_past_due", currency: res.currency, billingMonth, graceExpiresAt: res.graceExpiresAt },
          });
        } catch (_) { }
      }
    } catch (err) {
      failedCount++;
      console.warn(`[global_acct_fee] billing error for ${acctRow.account_id}:`, err.message);
    }
  }

  const summary = {
    billingMonth,
    minAgeDays,
    graceDays,
    eligibleAccounts: billableAccounts.length,
    chargedCount,
    pastDueCount,
    failedCount,
    totalUsdCollected: Number(totalUsdCollected.toFixed(2)),
  };

  const telegram = bot?.telegram || bot?.bot?.telegram || null;
  const adminIds = String(process.env.ADMIN_TELEGRAM_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (telegram && adminIds.length > 0 && billableAccounts.length > 0) {
    const msg =
      `🌍 <b>Global Account Maintenance Run (${billingMonth})</b>\n` +
      `──────────────────────────\n` +
      `• Billable foreign accounts (≥${minAgeDays}d old): ${billableAccounts.length}\n` +
      `• Charged → Master Account: <b>${chargedCount}</b> (~$${summary.totalUsdCollected.toFixed(2)})\n` +
      `• Past due (${graceDays}-day grace started): ${pastDueCount}\n` +
      `• Failed: ${failedCount}`;
    for (const id of adminIds) {
      telegram.sendMessage(id, msg, { parse_mode: "HTML" }).catch(() => { });
    }
  }

  return summary;
}

/**
 * Daily grace-period processor:
 * 1. Sends a Day-7 friendly reminder for past-due international accounts.
 * 2. On Day 14 (grace expired): retries fee collection once; if still unpaid AND zero balance,
 *    closes the account on Nuvion via DELETE /accounts/{account_id} so Nuvion stops billing Proxim.
 */
async function processGlobalAccountGracePeriods({
  bot = null,
  ngnRateOverride = null,
  feeRecipientAddress = process.env.APP_FEE_RECIPIENT_ADDRESS,
} = {}) {
  if (!isGlobalAccountFeeEnabled()) return { skipped: true };

  const ngnPerUsd = await resolveNgnPerUsdRate(ngnRateOverride);
  let remindedCount = 0;
  let recoveredCount = 0;
  let closedCount = 0;
  let keptPositiveBalanceCount = 0;

  // 1. Mid-grace Day-7 reminders
  const needReminder = db.getPastDueGlobalAccountFees({ needsReminderOnly: true });
  for (const row of needReminder) {
    try {
      const feeSpec = nuvion.getGlobalAccountMonthlyFee(row.currency) || { symbol: `${row.currency} `, amount: row.amount_major };
      const feeLabel = formatGlobalFeeLabel({ ...feeSpec, amount: row.amount_major });
      const dueDateLabel = String(row.grace_expires_at || "").slice(0, 10);
      await require("./notify").notify(row.telegram_id, {
        title: `Reminder: ${row.currency} Account Closes ${dueDateLabel}`,
        html:
          `⏰ <b>Reminder: ${row.currency} Global Account Fee (${feeLabel})</b>\n` +
          `Your ${row.currency} account maintenance fee for ${formatBillingMonthLabel(row.billing_month)} is still unpaid.\n` +
          `Fund your balance before <b>${dueDateLabel}</b> to keep it active — otherwise this unused ${row.currency} account will close automatically to stop future monthly fees.`,
        data: { type: "global_account_fee_reminder", currency: row.currency, accountId: row.account_id },
      });
      db.markGlobalAccountFeeReminderSent(row.id);
      remindedCount++;
    } catch (_) { }
  }

  // 2. Day-14 expired grace periods -> final retry, then auto-close if still unpaid & $0 balance
  const expired = db.getPastDueGlobalAccountFees({ expiredOnly: true });
  for (const row of expired) {
    try {
      const retryRes = await collectGlobalAccountFee({
        acctRow: row,
        billingMonth: row.billing_month,
        ngnPerUsd,
        feeRecipientAddress,
        isRetry: true,
      });

      if (retryRes.status === "charged") {
        recoveredCount++;
        try {
          await require("./notify").notify(row.telegram_id, {
            title: `${row.currency} Account Renewed (${retryRes.feeLabel})`,
            html: `✅ <b>${row.currency} Account Fee Collected (${retryRes.feeLabel})</b>\nYour ${row.currency} global bank account remains active.`,
            data: { type: "global_account_maintenance_fee", currency: row.currency },
          });
        } catch (_) { }
        continue;
      }

      // Still unpaid after 14-day grace -> close on Nuvion (only if zero balance)
      try {
        await orchestrator.closeGlobalReceivingAccount(row.telegram_id, row.account_type || "personal", row.currency, {
          reason: "unpaid_maintenance_grace_expired",
        });
        db.recordGlobalAccountMaintenanceFee({
          telegramId: row.telegram_id,
          entityId: row.entity_id,
          accountType: row.account_type || "personal",
          accountId: row.account_id,
          currency: row.currency,
          billingMonth: row.billing_month,
          amountMajor: row.amount_major,
          amountMinor: row.amount_minor,
          amountUsd: row.amount_usd,
          status: "closed_unpaid",
          closedAt: formatIsoUtcDaysFromNow(0),
          errorMessage: "Closed automatically after 14-day grace period with zero balance",
        });
        closedCount++;
        try {
          await require("./notify").notify(row.telegram_id, {
            title: `${row.currency} Account Closed`,
            html:
              `🔒 <b>Unused ${row.currency} Account Closed</b>\n` +
              `Your ${row.currency} global bank account was closed after the 14-day grace period so no further monthly maintenance fees accrue.\n` +
              `You can open a new ${row.currency} account anytime under <b>Accounts → Global Bank</b>.`,
            data: { type: "global_account_closed_unpaid", currency: row.currency, accountId: row.account_id },
          });
        } catch (_) { }
      } catch (closeErr) {
        if (/still has a balance/i.test(closeErr.message)) {
          keptPositiveBalanceCount++;
          console.warn(`[global_acct_fee] Refused auto-close for ${row.account_id} (${row.currency}): ${closeErr.message}`);
        } else {
          console.warn(`[global_acct_fee] Auto-close note for ${row.account_id} (${row.currency}):`, closeErr.message);
        }
      }
    } catch (err) {
      console.warn(`[global_acct_fee] Grace expiry processing note for ${row.account_id}:`, err.message);
    }
  }

  return { remindedCount, recoveredCount, closedCount, keptPositiveBalanceCount };
}

/**
 * Recover any past-due international account maintenance fees immediately when a user receives new funds.
 */
async function recoverPastDueGlobalAccountFeesForUser(telegramId, { ngnRateOverride = null, feeRecipientAddress = process.env.APP_FEE_RECIPIENT_ADDRESS } = {}) {
  const pastDue = db.getPastDueGlobalAccountFees({ telegramId });
  if (!pastDue || pastDue.length === 0) return { recoveredCount: 0 };

  const ngnPerUsd = await resolveNgnPerUsdRate(ngnRateOverride);
  let recoveredCount = 0;
  for (const row of pastDue) {
    try {
      const res = await collectGlobalAccountFee({
        acctRow: row,
        billingMonth: row.billing_month,
        ngnPerUsd,
        feeRecipientAddress,
        isRetry: true,
      });
      if (res.status === "charged") {
        recoveredCount++;
        try {
          await require("./notify").notify(row.telegram_id, {
            title: `${row.currency} Account Fee Settled (${res.feeLabel})`,
            html: `✅ Your overdue <b>${row.currency}</b> account maintenance fee (<b>${res.feeLabel}</b>) was settled automatically. Your ${row.currency} account stays active.`,
            data: { type: "global_account_maintenance_fee", currency: row.currency },
          });
        } catch (_) { }
      }
    } catch (_) { }
  }
  return { recoveredCount };
}

function startMonthlyFeeWorker(bot = null) {
  if (_cronJob || (!isMonthlyFeeEnabled() && !isGlobalAccountFeeEnabled())) return _cronJob;
  // Runs daily at 22:00 UTC:
  // - Daily: process Day-7 reminders & Day-14 auto-closure of unpaid $0 international accounts
  // - Month-end only: run base ₦200 fee + international account maintenance billing (for accounts >= 15 days old)
  _cronJob = cron.schedule("0 22 * * *", () => {
    processGlobalAccountGracePeriods({ bot }).catch((err) => {
      console.warn("[monthly_fee_worker] grace-period error:", err.message);
    });
    if (!isLastDayOfMonthUtc(new Date())) return;
    runMonthlyMaintenanceFeeCycle({ bot }).catch((err) => {
      console.warn("[monthly_fee_worker] cycle error:", err.message);
    });
    runGlobalAccountMaintenanceCycle({ bot }).catch((err) => {
      console.warn("[monthly_fee_worker] global-account cycle error:", err.message);
    });
  }, { timezone: "UTC" });
  console.log(
    `[monthly_fee_worker] Scheduled daily grace check + end-of-month billing ` +
    `(base ₦${getMonthlyFeeNgn()} + international accounts ≥${getGlobalMinAgeDays()}d old, ${getGlobalGraceDays()}d grace)`
  );
  return _cronJob;
}

function stopMonthlyFeeWorker() {
  if (_cronJob) {
    _cronJob.stop();
    _cronJob = null;
  }
}

module.exports = {
  DEFAULT_MONTHLY_FEE_NGN,
  DEFAULT_GLOBAL_MIN_AGE_DAYS,
  DEFAULT_GLOBAL_GRACE_DAYS,
  getMonthlyFeeNgn,
  getGlobalMinAgeDays,
  getGlobalGraceDays,
  isMonthlyFeeEnabled,
  isGlobalAccountFeeEnabled,
  getBillingMonthKey,
  formatBillingMonthLabel,
  isLastDayOfMonthUtc,
  collectMonthlyFeeForUser,
  runMonthlyMaintenanceFeeCycle,
  resolveExactGlobalAccountFee,
  collectGlobalAccountFee,
  runGlobalAccountMaintenanceCycle,
  processGlobalAccountGracePeriods,
  recoverPastDueGlobalAccountFeesForUser,
  startMonthlyFeeWorker,
  stopMonthlyFeeWorker,
};
