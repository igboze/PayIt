/**
 * On-Chain Solana Verification Script
 * Checks live Solana Mainnet RPC balances and account details for specified addresses.
 *
 * Usage: node scripts/verify-solana-balances.js <SOLANA_ADDRESS_1> [SOLANA_ADDRESS_2] ...
 */

const { PublicKey } = require("@solana/web3.js");
const multichain = require("../src/multichain");

async function verifyOnChain() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Usage: node scripts/verify-solana-balances.js <SOLANA_ADDRESS_1> [SOLANA_ADDRESS_2] ...");
    process.exit(1);
  }

  const addresses = args.map((addr, idx) => ({
    label: `Address #${idx + 1}`,
    address: addr.trim(),
  }));

  console.log("🌐 Querying Solana Mainnet RPC directly...\n");
  const conn = multichain.getSolanaConnection();

  for (const item of addresses) {
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
