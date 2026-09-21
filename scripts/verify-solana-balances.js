/**
 * On-Chain Solana Verification Script
 * Checks live Solana Mainnet RPC balances and account details for User's addresses.
 */

const { PublicKey } = require("@solana/web3.js");
const multichain = require("../src/multichain");

const ADDRESSES = [
  { label: "Paj Deposit Address (legacy_solana_address...)", address: "legacy_solana_deposit_address_placeholder" },
  { label: "Current Derived Solana Address (target_solana_address...)", address: "target_solana_address_placeholder" },
  { label: "Previous Derived Solana Address (previous_solana_address...)", address: "previous_solana_address_placeholder" },
];

async function verifyOnChain() {
  console.log("🌐 Querying Solana Mainnet RPC directly...\n");
  const conn = multichain.getSolanaConnection();

  for (const item of ADDRESSES) {
    console.log(`📌 ${item.label}`);
    console.log(`   Address: ${item.address}`);
    try {
      const pubkey = new PublicKey(item.address);
      const accountInfo = await conn.getAccountInfo(pubkey);
      const lamports = accountInfo ? accountInfo.lamports : 0;
      console.log(`   SOL Balance: ${lamports / 1e9} SOL`);
      console.log(`   Account Owner Program: ${accountInfo ? accountInfo.owner.toBase58() : "(Account Not Created / 0 Lamports)"}`);

      const splBal = await multichain.getSplTokenBalance(item.address);
      console.log(`   SPL USDC Balance: $${splBal?.uiAmount || 0} USDC`);
    } catch (err) {
      console.log(`   Error querying RPC: ${err.message}`);
    }
    console.log("─".repeat(60));
  }
}

verifyOnChain().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
