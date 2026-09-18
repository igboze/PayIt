require("dotenv").config();
const { JsonRpcProvider, formatUnits } = require("ethers");
const { getNetworkConfig } = require("../src/network");
const Database = require("better-sqlite3");

async function inspectUsers() {
  const net = getNetworkConfig();
  const provider = new JsonRpcProvider(net.rpcUrl, net.chainId);

  const sqlite = new Database("C:/data/payit.db");
  const rows = sqlite.prepare("SELECT * FROM users ORDER BY created_at DESC LIMIT 15").all();

  console.log("Recent users in DB:");
  for (const u of rows) {
    try {
      const bal = await provider.getBalance(u.deposit_address);
      console.log(`TG: ${u.telegram_id}, @${u.username}`);
      console.log(`  EVM: ${u.deposit_address} -> Balance: ${formatUnits(bal, 18)} USDC`);
      console.log(`  SOL: ${u.solana_deposit_address}`);
    } catch (e) {
      console.log(`Error checking TG:${u.telegram_id}:`, e.message);
    }
  }
}

inspectUsers().catch(console.error);
