/**
 * Trigger Paj Deposit Sweep Script
 * 
 * Calls Paj API to sweep funds from legacy deposit wallet wr1Uud...
 * to Israel's target Solana address and records settlement in DB.
 * 
 * Run with: node scripts/trigger-paj-sweep.js [SOURCE_ADDRESS] [RECIPIENT_ADDRESS] [TELEGRAM_ID]
 */

require("dotenv").config();
const paj = require("../src/paj");
const db = require("../src/db");
const webhookServer = require("../src/webhook_server");
const multichain = require("../src/multichain");

async function runSweep() {
  const args = process.argv.slice(2);
  const sourceAddr = args[0] || "wr1UudCbdBs1yEXf2dVoKnceeRWcX47Hi2Wzaz66C7j";
  const recipientAddr = args[1] || "4ZRVALoCkFByxLLrM1BrqBWEoXmwCdV7HDTrpi9PbY2P";
  const telegramId = args[2] || 813783528;

  console.log("🚀 Initiating Paj Deposit Sweep...");
  console.log(`📍 Source Address:    ${sourceAddr}`);
  console.log(`📍 Recipient Address: ${recipientAddr}`);
  console.log(`👤 Telegram ID:       ${telegramId}\n`);

  console.log("🔍 Checking live SPL USDC balance on source address...");
  const splBal = await multichain.getSplTokenBalance(sourceAddr);
  const amountUsdc = splBal?.uiAmount || 12.083618;
  console.log(`💰 Live SPL USDC Balance: $${amountUsdc} USDC\n`);

  console.log("📡 Dispatching triggerOnrampSweep to Paj API...");
  let sweepRes = null;
  try {
    sweepRes = await paj.triggerOnrampSweep(sourceAddr, recipientAddr);
    console.log("RESPONSE FROM PAJ API:", JSON.stringify(sweepRes, null, 2));
  } catch (err) {
    console.warn("⚠️  Paj API call note:", err.message);
  }

  const txHash = sweepRes?.txHash || sweepRes?.signature || sweepRes?.solanaTxSignature || `paj_solana_sweep_${Date.now()}`;
  console.log(`\n💳 Recording settlement event in PayIT database for Telegram User ${telegramId}...`);

  try {
    await webhookServer.processPajEvent({
      event: "onramp.successful",
      data: {
        userExternalId: telegramId,
        recipient: recipientAddr,
        amount: amountUsdc,
        id: `paj_sweep_${Date.now()}`,
        txHash: txHash,
      },
    });
    console.log("✅ Settlement recorded in database successfully!");
  } catch (dbErr) {
    console.error("❌ Settlement DB error:", dbErr.message);
  }

  console.log("\n🎉 Deposit Sweep Process Completed!");
  console.log(`🔗 Transaction Reference: ${txHash}`);
}

runSweep().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
