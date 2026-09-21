/**
 * Recover Legacy Solana Funds Script
 * 
 * Takes an old EVM Private Key, derives the corresponding legacy Solana Keypair,
 * and signs an on-chain SPL USDC transfer to send all funds to the user's new derived Solana address.
 * 
 * Usage:
 *   node scripts/recover-legacy-solana-funds.js <OLD_EVM_PRIVATE_KEY> <RECIPIENT_SOLANA_ADDRESS>
 */

const { PublicKey, Transaction, Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");
const walletLib = require("../src/wallet");
const multichain = require("../src/multichain");
const db = require("../src/db");

async function recoverLegacyFunds() {
  const args = process.argv.slice(2);
  const oldEvmKey = args[0];
  const targetSolAddress = args[1] || "4ZRVALoCkFByxLLrM1BrqBWEoXmwCdV7HDTrpi9PbY2P";

  if (!oldEvmKey) {
    console.log("Usage: node scripts/recover-legacy-solana-funds.js <OLD_EVM_PRIVATE_KEY> [RECIPIENT_SOLANA_ADDRESS]");
    process.exit(1);
  }

  console.log("🔑 Deriving Solana keypair from old EVM private key...");
  let solKeypair;
  let sourceSolAddress;

  try {
    const derived = multichain.deriveSolanaFromEvmKey(oldEvmKey);
    solKeypair = derived.keypair;
    sourceSolAddress = derived.solanaAddress;
  } catch (err) {
    console.error("❌ Failed to derive Solana keypair from provided EVM key:", err.message);
    process.exit(1);
  }

  console.log(`📍 Legacy Solana Source Address:  ${sourceSolAddress}`);
  console.log(`📍 Destination Solana Address:    ${targetSolAddress}\n`);

  console.log("🔍 Checking SPL USDC balance on legacy source address...");
  const conn = multichain.getSolanaConnection();
  const splBal = await multichain.getSplTokenBalance(sourceSolAddress);

  if (!splBal || !splBal.uiAmount || splBal.uiAmount <= 0) {
    console.log(`⚠️  No SPL USDC balance found on legacy address ${sourceSolAddress} (Balance: $${splBal?.uiAmount || 0}).`);
    process.exit(0);
  }

  const amountUsdc = splBal.uiAmount;
  console.log(`💰 Detected $${amountUsdc} USDC on ${sourceSolAddress}. Initiating transfer...`);

  // Check SOL balance for gas fee
  const lamports = await conn.getBalance(solKeypair.publicKey);
  const bs58Key = process.env.SOLANA_FEE_PAYER_KEY;
  const bs58Decode = bs58.default ? bs58.default.decode : bs58.decode;
  let feePayerKeypair = (bs58Key && bs58Key !== "mock-solana-fee-payer-key") ? Keypair.fromSecretKey(bs58Decode(bs58Key)) : null;

  if (lamports < 5000 && !feePayerKeypair) {
    console.error(`❌ Legacy address has insufficient SOL (${lamports / 1e9} SOL) and no valid SOLANA_FEE_PAYER_KEY set to cover network fees.`);
    process.exit(1);
  }

  const payerKeypair = (lamports >= 5000) ? solKeypair : feePayerKeypair;
  console.log(`⛽ Transaction Fee-Payer: ${payerKeypair.publicKey.toBase58()}`);

  try {
    const res = await multichain.sendSolanaTransfer({
      keypair: solKeypair,
      recipientAddress: targetSolAddress,
      amount: amountUsdc,
      currency: "USDC",
    });

    if (res.success) {
      console.log(`\n🎉 Success! On-Chain Transfer Confirmed on Solana Mainnet.`);
      console.log(`🔗 Tx Hash / Signature: ${res.signature}`);
      console.log(`🔗 Solscan Explorer:   https://solscan.io/tx/${res.signature}`);
      console.log(`✅ Transferred $${amountUsdc} USDC from ${sourceSolAddress} to ${targetSolAddress}`);
    } else {
      console.error(`❌ Transfer failed: ${res.error}`);
    }
  } catch (err) {
    console.error("❌ Exception during Solana transfer execution:", err.message);
  }
}

recoverLegacyFunds().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
