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
const ARC_GAS_BUFFER_USD = 0.05;

let _cronJob = null;

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

function startMonthlyFeeWorker(bot = null) {
  if (_cronJob || !isMonthlyFeeEnabled()) return _cronJob;
  // Runs daily at 22:00 UTC and only executes on the final day of each month
  _cronJob = cron.schedule("0 22 * * *", () => {
    if (!isLastDayOfMonthUtc(new Date())) return;
    runMonthlyMaintenanceFeeCycle({ bot }).catch((err) => {
      console.warn("[monthly_fee_worker] cycle error:", err.message);
    });
  }, { timezone: "UTC" });
  console.log(`[monthly_fee_worker] Scheduled end-of-month ₦${getMonthlyFeeNgn()} fee check (22:00 UTC daily)`);
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
  getMonthlyFeeNgn,
  isMonthlyFeeEnabled,
  getBillingMonthKey,
  formatBillingMonthLabel,
  isLastDayOfMonthUtc,
  collectMonthlyFeeForUser,
  runMonthlyMaintenanceFeeCycle,
  startMonthlyFeeWorker,
  stopMonthlyFeeWorker,
};
