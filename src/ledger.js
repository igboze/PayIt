// src/ledger.js
// Bridges the on-chain world (Arc deposit addresses) with the internal
// database ledger that the bot actually shows users.

const db = require("./db");
const walletLib = require("./wallet");

// Checks a user's on-chain deposit address for new (un-swept) funds.
// If found: sweeps them to the treasury wallet and credits the internal ledger.
// This is called whenever the user checks their balance/deposit status.
// In production this would instead be a background job polling all
// addresses on a timer, with proper confirmation-count handling.
async function checkAndCreditDeposits(user) {
  const onChainBalance = await walletLib.getNativeBalanceMicro(user.deposit_address);
  const alreadySwept = BigInt(user.swept_micro_usdc);

  if (onChainBalance <= alreadySwept) {
    return { credited: 0n };
  }

  const userWallet = walletLib.deriveUserWallet(user.wallet_index);
  const treasury = walletLib.getTreasuryWallet();

  const { swept, txHash } = await walletLib.sweepToTreasury(userWallet, treasury.address);
  if (swept === 0n) {
    return { credited: 0n };
  }

  const newSweptTotal = alreadySwept + swept;
  db.updateSweptAndBalance(user.telegram_id, newSweptTotal, swept);
  db.recordTransaction(user.telegram_id, "deposit", swept, "confirmed", txHash);

  return { credited: swept, txHash };
}

module.exports = { checkAndCreditDeposits };
