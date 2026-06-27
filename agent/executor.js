// agent/executor.js
// Executes a parsed payment plan. Each payment in the plan is sent on-chain.
// Called after the user confirms with their PIN.

const walletLib = require("../src/wallet");
const db        = require("../src/db");

async function executePlan(plan, pin, user) {
  let signerWallet;
  try {
    const context = user.active_context || "personal";
    const pk = context === "business"
      ? db.decryptBusinessPrivateKey(pin, user)
      : db.decryptPrivateKey(pin, user);
    signerWallet = walletLib.walletFromPrivateKey(pk);
  } catch {
    return [{ success: false, label: "All payments", error: "Could not unlock wallet — wrong PIN?" }];
  }

  const results = [];
  for (const payment of plan.payments) {
    try {
      const amountMicro = walletLib.parseToMicro(payment.amount);
      const txHash = await walletLib.sendFromWallet(signerWallet, payment.to, amountMicro);
      db.recordTransaction(user.telegram_id, "autopay", amountMicro, "confirmed", txHash);
      results.push({ success: true, label: payment.label, to: payment.to, amount: payment.amount, txHash });
    } catch (err) {
      results.push({ success: false, label: payment.label, to: payment.to, amount: payment.amount, error: err.message });
    }
  }
  return results;
}

function formatResults(results) {
  return results.map(r => {
    if (r.success) {
      return `✅ ${r.amount} USDC → \`${r.to}\`\n   ${r.label}\n   Tx: ${r.txHash}`;
    }
    return `❌ Failed: ${r.label}\n   ${r.error}`;
  }).join("\n\n");
}

module.exports = { executePlan, formatResults };
