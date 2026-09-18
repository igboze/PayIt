// src/ledger.js
// Transaction ledger & deposit verification layer for PayIT
// Records confirmed on-chain transactions, audits balances, and manages transaction histories.

const db = require("./db");
const walletLib = require("./wallet");

/**
 * Record a transaction into the user's isolated account ledger.
 *
 * @param {object} params
 * @param {number} params.telegramId
 * @param {string} params.type - 'deposit' | 'send' | 'withdrawal' | 'auto_earn_deposit' | 'auto_earn_liquidate'
 * @param {bigint|number|string} params.amountMicro - Amount in micro-units (18 decimals)
 * @param {string} [params.status='confirmed']
 * @param {string} [params.txHash]
 * @param {string} [params.accountType='personal'] - 'personal' | 'business'
 */
function recordTransaction({
  telegramId,
  type,
  amountMicro,
  status = "confirmed",
  txHash = null,
  accountType = "personal",
}) {
  const microVal = typeof amountMicro === "bigint" ? amountMicro : BigInt(amountMicro || 0);
  return db.recordTransaction(telegramId, type, microVal, status, txHash, accountType);
}

/**
 * Get transaction history isolated by personal or business account.
 *
 * @param {number} telegramId
 * @param {string} [accountType='personal']
 * @param {number} [limit=50]
 */
function getTransactions(telegramId, accountType = "personal", limit = 50) {
  return db.getTransactions(telegramId, limit, accountType);
}

/**
 * Check a user's on-chain balance against recorded ledger balance.
 *
 * @param {object} user - DB user object
 * @param {string} [accountType='personal']
 * @returns {Promise<{ address: string, balanceMicro: bigint, formattedUsdc: string }>}
 */
async function getAccountOnChainBalance(user, accountType = "personal") {
  const address = accountType === "business"
    ? (user.business_deposit_address || user.deposit_address)
    : user.deposit_address;

  if (!address || !walletLib.isValidAddress(address)) {
    return { address: null, balanceMicro: 0n, formattedUsdc: "0.00" };
  }

  const balanceMicro = await walletLib.getNativeBalanceMicro(address);
  const formattedUsdc = walletLib.formatMicro(balanceMicro);
  return { address, balanceMicro, formattedUsdc };
}

module.exports = {
  recordTransaction,
  getTransactions,
  getAccountOnChainBalance,
};
