// sweep-legacy-solana.js
// Run AFTER applying the solana_address.js fix and reconciling users (they just need to
// enter their PIN once, which calls reconcileUser() automatically). Put this file at the
// repo root (next to bot.js) and run: node sweep-legacy-solana.js
//
// For every row in legacy_solana_addresses, checks the USDC balance sitting at the OLD
// address and, if the current key can still derive that same old address's private key
// path (it can't, in general - the old address belongs to a key the bot may not hold),
// reports what to do next. In this codebase, "legacy" addresses are ones Paj paid before
// the derivation was corrected, which are STILL derived from the same EVM key (see
// solana_address.js) via a different, older derivation - so in practice for THIS bug the
// old and new addresses are usually both derivable from data already in the DB. This
// script does NOT invent a recovery path; it reports balances so you can decide, and
// (only if you confirm) moves funds from an old address to the correct one using the
// SAME key, when that key is available.
//
// Safe by default: prints a report only. Set EXECUTE=1 to actually transfer.

require("dotenv").config();
const db = require("./src/db");
const multichain = require("./src/multichain");
const solAddrLib = require("./src/solana_address");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const conn = multichain.getSolanaConnection();
  const rows = db.db.prepare("SELECT * FROM legacy_solana_addresses ORDER BY telegram_id").all();

  if (!rows.length) {
    console.log("No rows in legacy_solana_addresses yet. This table fills in as users unlock their PIN " +
      "(or create an on-ramp order) after the fix is deployed, and a stored address no longer matches " +
      "the derived one.");
    return;
  }

  console.log(`Found ${rows.length} legacy address record(s).\n`);

  for (const row of rows) {
    const user = db.getUser(row.telegram_id);
    console.log(`TG:${row.telegram_id} [${row.account_type}]`);
    console.log(`  old address : ${row.address}`);
    console.log(`  replaced by : ${row.replaced_by}`);

    let bal;
    try {
      bal = await multichain.getSplTokenBalance(row.address, multichain.SOLANA_USDC_MINT);
    } catch (e) {
      bal = null;
    }
    console.log(`  USDC currently at old address: ${bal ? bal.uiAmount : "unknown (RPC error)"}`);

    if (!bal || bal.uiAmount <= 0) {
      console.log("  Nothing to sweep here.\n");
      continue;
    }

    if (!user) {
      console.log("  No user record found. Funds may belong to a deleted/unknown account.\n");
      continue;
    }

    const isBiz = row.account_type === "business";
    const derived = solAddrLib.getDerivedSolanaAddress(user, { isBiz });
    if (derived !== row.replaced_by) {
      console.log(`  WARNING: current derived address (${derived}) no longer matches the recorded ` +
        `replacement (${row.replaced_by}). Re-check before doing anything.\n`);
      continue;
    }

    console.log(`  ACTION NEEDED: ask Paj to sweep order/address ${row.address} to ${row.replaced_by} ` +
      `(paj.triggerOnrampSweep), since Paj (not this bot) controls the payout of on-ramp orders. ` +
      `If this address is instead one the bot's OLD key controlled directly (pre-fix custodial era, ` +
      `not this Paj on-ramp bug), see sweep-legacy.js / audit-solana-addresses.js instead.\n`);

    await sleep(150);
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
