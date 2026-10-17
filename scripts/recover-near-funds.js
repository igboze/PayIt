// scripts/recover-near-funds.js
// Inspect or sweep native NEAR funds from a user's derived NEAR implicit account.
//
// Usage:
//   node scripts/recover-near-funds.js --pk <evm_private_key> [--to <destination_near_address>] [--amount <near_amount>]
//   node scripts/recover-near-funds.js --user <telegram_id> [--to <destination_near_address>] [--amount <near_amount>]
//   node scripts/recover-near-funds.js --near-key <ed25519:...> [--to <destination_near_address>] [--amount <near_amount>]

require("dotenv").config();
const nearLib = require("../src/near");
const db = require("../src/db");
const nearApi = require("near-api-js");

async function main() {
  const args = process.argv.slice(2);
  let evmPk = null;
  let nearKey = null;
  let toAddress = null;
  let amount = null;
  let tgId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pk") evmPk = args[++i];
    else if (args[i] === "--near-key") nearKey = args[++i];
    else if (args[i] === "--to") toAddress = args[++i];
    else if (args[i] === "--amount") amount = parseFloat(args[++i]);
    else if (args[i] === "--user") tgId = args[++i];
  }

  if (tgId) {
    const user = db.getUser(tgId);
    if (!user) {
      console.error(`User with Telegram ID ${tgId} not found in database.`);
      process.exit(1);
    }
    const sysKey = db.getSystemDecryptedPrivateKey(user);
    if (!sysKey) {
      console.error("Could not decrypt system key for user.");
      process.exit(1);
    }
    evmPk = sysKey;
  }

  let derived = null;
  if (evmPk) {
    derived = nearLib.deriveNearAddress(evmPk);
    nearKey = derived.secretKeyBase58;
  }

  if (!nearKey) {
    console.log("Usage:");
    console.log("  node scripts/recover-near-funds.js --pk <0x...>");
    console.log("  node scripts/recover-near-funds.js --near-key <ed25519:...>");
    console.log("  node scripts/recover-near-funds.js --user <telegram_id>");
    console.log("Optional arguments:");
    console.log("  --to <destination_near_address>  (transfers funds to this address)");
    console.log("  --amount <near_amount>           (transfers specific amount, defaults to all available minus gas)");
    process.exit(1);
  }

  const keyPair = nearApi.KeyPair.fromString(nearKey);
  const accountId = derived?.nearAddress || Buffer.from(keyPair.publicKey.data).toString("hex").toLowerCase();

  console.log("==========================================");
  console.log("NEAR Implicit Account:", accountId);
  console.log("NEAR Secret Key:      ", nearKey);
  console.log("==========================================");

  const nodeUrl = process.env.NEAR_RPC_URL || "https://rpc.mainnet.near.org";
  const provider = new nearApi.JsonRpcProvider({ url: nodeUrl });
  const signer = new nearApi.KeyPairSigner(keyPair);
  const account = new nearApi.Account(accountId, provider, signer);

  try {
    const balance = await account.getBalance();
    const availableNear = Number(balance.available) / 1e24;
    const totalNear = Number(balance.total) / 1e24;

    console.log(`Balance:`);
    console.log(`  Total:     ${totalNear.toFixed(6)} NEAR`);
    console.log(`  Available: ${availableNear.toFixed(6)} NEAR`);
    console.log(`  Storage:   ${(Number(balance.stateStaked) / 1e24).toFixed(6)} NEAR`);

    if (toAddress) {
      const sweepAmountNear = amount ? amount : Math.max(0, availableNear - 0.005);
      if (sweepAmountNear <= 0) {
        console.error("Insufficient balance to transfer after reserving gas fees (0.005 NEAR).");
        process.exit(1);
      }
      const yoctoAmount = BigInt(Math.floor(sweepAmountNear * 1e6)) * 10n ** 18n;
      console.log(`\nInitiating transfer of ${sweepAmountNear.toFixed(6)} NEAR to ${toAddress}...`);
      const result = await account.transfer({
        recipient: toAddress,
        amount: yoctoAmount,
      });
      console.log("✅ Transfer successful!");
      console.log("Tx Hash:", result.transaction?.hash);
      console.log(`Explorer: https://nearblocks.io/txns/${result.transaction?.hash}`);
    } else {
      console.log("\n(Tip: Pass --to <destination_address> to sweep these funds)");
    }
  } catch (err) {
    if (err.message && err.message.includes("does not exist")) {
      console.log(`Balance:`);
      console.log(`  Total:     0.000000 NEAR`);
      console.log(`  Available: 0.000000 NEAR`);
      console.log(`\n(Account is not yet initialized or has 0 balance on NEAR)`);
    } else {
      console.error("Error querying or executing transfer:", err.message);
    }
  }
}

main().catch(console.error);
