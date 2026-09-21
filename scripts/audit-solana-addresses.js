/**
 * Audit Solana Addresses Script
 * 
 * Read-only audit script to check for users whose stored Solana deposit address
 * in the database differs from their key-derived Solana address.
 * 
 * Run with: node scripts/audit-solana-addresses.js
 */

const db = require("../src/db");
const walletLib = require("../src/wallet");
const multichain = require("../src/multichain");

async function runAudit() {
  console.log("🔍 Starting Solana Address Audit...\n");
  
  let rows = [];
  try {
    rows = db.getAllUsers ? db.getAllUsers() : [];
    if (!rows || rows.length === 0) {
      if (db.db && db.db.prepare) {
        rows = db.db.prepare("SELECT * FROM users").all();
      }
    }
  } catch (err) {
    console.error("Failed to query users table:", err.message);
    process.exit(1);
  }

  console.log(`Total users in database: ${rows ? rows.length : 0}\n`);
  let mismatchesFound = 0;

  for (const user of (rows || [])) {
    const tgId = user.telegram_id;

    // Check personal account
    if (user.system_encrypted_key) {
      try {
        const rawKey = walletLib.decryptSensitiveValue(user.system_encrypted_key);
        if (rawKey) {
          const derivedSol = multichain.deriveSolanaFromEvmKey(rawKey).solanaAddress;
          const storedSol = user.solana_deposit_address;
          if (storedSol && storedSol !== derivedSol) {
            mismatchesFound++;
            console.log(`⚠️  [MISMATCH DETECTED] TG User: ${tgId} (Personal)`);
            console.log(`    Stored Solana Address:  ${storedSol}`);
            console.log(`    Derived Solana Address: ${derivedSol}`);
            
            try {
              const storedBal = await multichain.getSplTokenBalance(storedSol);
              const derivedBal = await multichain.getSplTokenBalance(derivedSol);
              console.log(`    Stored Address Balance:  $${storedBal?.uiAmount || 0} USDC`);
              console.log(`    Derived Address Balance: $${derivedBal?.uiAmount || 0} USDC`);
            } catch (balErr) {
              console.log(`    Balance Query Error: ${balErr.message}`);
            }
            console.log("─".repeat(60));
          }
        }
      } catch (err) {
        console.warn(`[audit:decrypt_error] TG:${tgId} Personal: ${err.message}`);
      }
    }

    // Check business account
    if (user.biz_system_encrypted_key) {
      try {
        const rawKey = walletLib.decryptSensitiveValue(user.biz_system_encrypted_key);
        if (rawKey) {
          const derivedSol = multichain.deriveSolanaFromEvmKey(rawKey).solanaAddress;
          const storedSol = user.biz_solana_deposit_address;
          if (storedSol && storedSol !== derivedSol) {
            mismatchesFound++;
            console.log(`⚠️  [MISMATCH DETECTED] TG User: ${tgId} (Business)`);
            console.log(`    Stored Biz Solana Address:  ${storedSol}`);
            console.log(`    Derived Biz Solana Address: ${derivedSol}`);
            
            try {
              const storedBal = await multichain.getSplTokenBalance(storedSol);
              const derivedBal = await multichain.getSplTokenBalance(derivedSol);
              console.log(`    Stored Address Balance:  $${storedBal?.uiAmount || 0} USDC`);
              console.log(`    Derived Address Balance: $${derivedBal?.uiAmount || 0} USDC`);
            } catch (balErr) {
              console.log(`    Balance Query Error: ${balErr.message}`);
            }
            console.log("─".repeat(60));
          }
        }
      } catch (err) {
        console.warn(`[audit:decrypt_error] TG:${tgId} Business: ${err.message}`);
      }
    }
  }

  console.log(`\n✅ Audit complete. Total address mismatches found: ${mismatchesFound}`);
}

runAudit().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
