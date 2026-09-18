// src/auto_earn.js
// 2-Hour Idle Auto-Earn Engine for PayIT
// Automatically allocates idle user balances into non-locking Arc Morpho vaults
// and automatically liquidates (with 10% dev fee routing) when user needs funds.

const db = require("./db");
const walletLib = require("./wallet");
const savings = require("./savings");

const IDLE_HOURS = 2; // Funds sitting untouched for 2 hours start earning
const MIN_AUTO_EARN_BALANCE = 5.0; // Minimum $5.00 to allocate to Auto-Earn
const GAS_BUFFER_USDC = 0.5; // Retain $0.50 liquid buffer

/**
 * Scan for users whose funds have sat idle for >= 2 hours and allocate to Auto-Earn.
 *
 * @param {object} [options]
 * @returns {Promise<number>} Number of users auto-allocated
 */
async function checkAndRunAutoEarn(options = {}) {
  const idleHours = options.idleHours || IDLE_HOURS;
  const idleUsers = db.getIdleUsersForAutoEarn(idleHours);

  if (!idleUsers || idleUsers.length === 0) {
    return 0;
  }

  let pools;
  try {
    pools = await savings.getYieldPools();
  } catch (err) {
    console.warn("[auto_earn] Failed to fetch pools for auto-allocation:", err.message);
    return 0;
  }

  const bestPool = pools[0];
  let allocatedCount = 0;

  for (const user of idleUsers) {
    // 1. Personal Account Auto-Earn
    try {
      const personalAddress = user.deposit_address;
      const hasPersonalYield = db.getOpenYieldPosition(user.telegram_id, "personal");

      if (personalAddress && walletLib.isValidAddress(personalAddress) && !hasPersonalYield) {
        const balMicro = await walletLib.getNativeBalanceMicro(personalAddress);
        const balanceUsdc = parseFloat(walletLib.formatMicro(balMicro));

        if (balanceUsdc >= MIN_AUTO_EARN_BALANCE) {
          const depositAmount = parseFloat((balanceUsdc - GAS_BUFFER_USDC).toFixed(2));
          if (depositAmount >= 1.0) {
            savings.openYieldPosition(user.telegram_id, depositAmount, bestPool, {
              isAutoEarn: true,
              depositTxHash: null,
              accountType: "personal",
            });

            db.recordTransaction(
              user.telegram_id,
              "auto_earn_deposit",
              BigInt(Math.round(depositAmount * 1e18)),
              "confirmed",
              null,
              "personal"
            );

            allocatedCount++;
          }
        }
      }
    } catch (persErr) {
      console.warn(`[auto_earn] Personal allocation error for user ${user.telegram_id}:`, persErr.message);
    }

    // 2. Business Account Auto-Earn
    try {
      const bizAddress = user.business_deposit_address;
      const hasBizYield = db.getOpenYieldPosition(user.telegram_id, "business");

      if (bizAddress && walletLib.isValidAddress(bizAddress) && !hasBizYield) {
        const balMicro = await walletLib.getNativeBalanceMicro(bizAddress);
        const balanceUsdc = parseFloat(walletLib.formatMicro(balMicro));

        if (balanceUsdc >= MIN_AUTO_EARN_BALANCE) {
          const depositAmount = parseFloat((balanceUsdc - GAS_BUFFER_USDC).toFixed(2));
          if (depositAmount >= 1.0) {
            savings.openYieldPosition(user.telegram_id, depositAmount, bestPool, {
              isAutoEarn: true,
              depositTxHash: null,
              accountType: "business",
            });

            db.recordTransaction(
              user.telegram_id,
              "auto_earn_deposit",
              BigInt(Math.round(depositAmount * 1e18)),
              "confirmed",
              null,
              "business"
            );

            allocatedCount++;
          }
        }
      }
    } catch (bizErr) {
      console.warn(`[auto_earn] Business allocation error for user ${user.telegram_id}:`, bizErr.message);
    }
  }

  return allocatedCount;
}

/**
 * Automatic liquidation hook:
 * Ensures the user has enough liquid balance to execute an outgoing transaction.
 * If liquid balance is insufficient but user has an active yield/auto-earn position,
 * it automatically withdraws the funds from the vault (routing 10% dev fee) seamlessly.
 *
 * @param {object} params
 * @param {object} params.userWallet - ethers Wallet
 * @param {number} params.telegramId
 * @param {bigint} params.requiredAmountMicro
 * @param {string} [params.accountType] - 'personal' | 'business'
 * @param {string} [params.feeRecipientAddress]
 * @returns {Promise<{ liquidated: boolean, amountUsdc?: number, devFee?: number, error?: string }>}
 */
async function ensureLiquidBalance({ userWallet, telegramId, requiredAmountMicro, accountType, feeRecipientAddress }) {
  const address = userWallet.address;
  let currentBalMicro = BigInt(0);
  try {
    currentBalMicro = await walletLib.getNativeBalanceMicro(address);
  } catch (err) {
    return { liquidated: false, error: "Could not read wallet balance" };
  }

  if (currentBalMicro >= requiredAmountMicro) {
    // Balance is already sufficient, no liquidation needed
    return { liquidated: false };
  }

  // Determine account type: explicitly passed or derived from wallet address
  let targetAccountType = accountType;
  if (!targetAccountType && telegramId) {
    const user = db.getUser(telegramId);
    if (user && user.business_deposit_address && user.business_deposit_address.toLowerCase() === address.toLowerCase()) {
      targetAccountType = "business";
    } else {
      targetAccountType = "personal";
    }
  }

  // Deficit exists — check if user has active savings position for THIS account type
  const position = db.getOpenYieldPosition(telegramId, targetAccountType);
  if (!position || position.amount_usdc <= 0) {
    return { liquidated: false };
  }

  try {
    const withdrawResult = await savings.withdrawFromVaultWithFee({
      userWallet,
      position,
      feeRecipientAddress,
    });

    db.recordTransaction(
      telegramId,
      "auto_earn_liquidate",
      BigInt(Math.round(withdrawResult.totalUserPayout * 1e18)),
      "confirmed",
      null,
      targetAccountType || "personal"
    );

    return {
      liquidated: true,
      positionClosed: true,
      accountType: targetAccountType,
      amountUsdc: withdrawResult.totalUserPayout,
      devFee: withdrawResult.devFee,
      withdrawTxHash: withdrawResult.withdrawTxHash,
      feeTxHash: withdrawResult.feeTxHash,
    };
  } catch (err) {
    console.warn(`[auto_earn] Auto-liquidation failed for TG:${telegramId}:`, err.message);
    return { liquidated: false, error: err.message };
  }
}

// Background scheduler interval (runs every 15 minutes by default)
let _intervalHandle = null;
let _defaultFeeRecipient = process.env.APP_FEE_RECIPIENT_ADDRESS || null;

function startAutoEarnWorker(optionsOrInterval = 15 * 60 * 1000) {
  let intervalMs = 15 * 60 * 1000;
  if (typeof optionsOrInterval === "number") {
    intervalMs = optionsOrInterval;
  } else if (optionsOrInterval && typeof optionsOrInterval === "object") {
    if (optionsOrInterval.intervalMs) intervalMs = optionsOrInterval.intervalMs;
    if (optionsOrInterval.feeRecipientAddress) _defaultFeeRecipient = optionsOrInterval.feeRecipientAddress;
  }

  if (_intervalHandle) clearInterval(_intervalHandle);
  _intervalHandle = setInterval(() => {
    checkAndRunAutoEarn({ feeRecipientAddress: _defaultFeeRecipient }).catch((e) => console.warn("[auto_earn:worker]", e.message));
  }, intervalMs);
}

function stopAutoEarnWorker() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}

module.exports = {
  checkAndRunAutoEarn,
  ensureLiquidBalance,
  startAutoEarnWorker,
  stopAutoEarnWorker,
  IDLE_HOURS,
  MIN_AUTO_EARN_BALANCE,
};
