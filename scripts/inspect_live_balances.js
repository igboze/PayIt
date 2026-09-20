// scripts/inspect_live_balances.js
// Production utility to inspect live user balances across Arc EVM (ERC-20 USDC & gas) and Solana (SPL USDC & SOL)

require("dotenv").config();
const { JsonRpcProvider, Contract, formatUnits } = require("ethers");
const { PublicKey } = require("@solana/web3.js");
const { getAssociatedTokenAddressSync } = require("@solana/spl-token");
const db = require("../src/db");
const { getNetworkConfig } = require("../src/network");
const multichain = require("../src/multichain");

const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];
const SOLANA_USDC_MINT = new PublicKey(
  process.env.SOLANA_USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

async function inspectUsers() {
  const net = getNetworkConfig();
  const provider = new JsonRpcProvider(net.rpcUrl, net.chainId, { staticNetwork: true });
  const usdcAddress = net.usdcAddress || "0x3600000000000000000000000000000000000000";
  const usdcContract = new Contract(usdcAddress, ERC20_ABI, provider);

  let solConn = null;
  try {
    solConn = multichain.getSolanaConnection();
  } catch (err) {
    console.warn("[inspect_live_balances] Solana connection unavailable:", err.message);
  }

  const rows = db.db.prepare("SELECT * FROM users ORDER BY created_at DESC LIMIT 15").all();

  console.log(`\n======================================================================`);
  console.log(`Live User Balances Inspection (${rows.length} users)`);
  console.log(`Arc Network: ${net.name} (${net.rpcUrl})`);
  console.log(`Arc USDC Precompile: ${usdcAddress}`);
  console.log(`======================================================================\n`);

  for (const u of rows) {
    console.log(`TG: ${u.telegram_id} | Username: ${u.username ? "@" + u.username : "N/A"}`);

    // Arc EVM Balances
    if (u.deposit_address) {
      try {
        const [rawUsdc, nativeGasWei] = await Promise.all([
          usdcContract.balanceOf(u.deposit_address).catch(() => 0n),
          provider.getBalance(u.deposit_address).catch(() => 0n),
        ]);
        const usdcBal = formatUnits(rawUsdc, 6);
        const gasBal = formatUnits(nativeGasWei, 18);
        console.log(`  EVM (Personal): ${u.deposit_address}`);
        console.log(`    ├─ Arc USDC: ${usdcBal} USDC`);
        console.log(`    └─ Gas Token: ${gasBal}`);
      } catch (err) {
        console.log(`  EVM: ${u.deposit_address} -> Error: ${err.message}`);
      }
    }

    if (u.business_deposit_address) {
      try {
        const rawBizUsdc = await usdcContract.balanceOf(u.business_deposit_address).catch(() => 0n);
        console.log(`  EVM (Business): ${u.business_deposit_address} -> ${formatUnits(rawBizUsdc, 6)} USDC`);
      } catch {}
    }

    // Solana Balances
    if (u.solana_deposit_address && solConn) {
      try {
        const solPubkey = new PublicKey(u.solana_deposit_address);
        const lamports = await solConn.getBalance(solPubkey).catch(() => 0);
        const solBal = (lamports / 1e9).toFixed(4);

        let splUsdcBal = "0.00";
        try {
          const ata = getAssociatedTokenAddressSync(SOLANA_USDC_MINT, solPubkey);
          const tokenRes = await solConn.getTokenAccountBalance(ata);
          splUsdcBal = tokenRes?.value?.uiAmountString || "0.00";
        } catch {}

        console.log(`  SOL: ${u.solana_deposit_address}`);
        console.log(`    ├─ Native SOL: ${solBal} SOL`);
        console.log(`    └─ SPL USDC:   ${splUsdcBal} USDC`);
      } catch (err) {
        console.log(`  SOL: ${u.solana_deposit_address} -> Error: ${err.message}`);
      }
    }

    console.log(`----------------------------------------------------------------------`);
  }
}

if (require.main === module) {
  inspectUsers().catch((err) => {
    console.error("[inspect_live_balances] Fatal:", err);
    process.exit(1);
  });
}

module.exports = { inspectUsers };
