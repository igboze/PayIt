/**
 * Admin PIN Reset Script (Option A)
 *
 * Resets a user's 4-digit security PIN when they have forgotten it.
 * 
 * How it works:
 * 1. Locates the user by Telegram ID or Username.
 * 2. Decrypts the user's private key via their `system_encrypted_key`
 *    (or falls back to an offline PIN sweep if system_encrypted_key is not yet backfilled).
 * 3. Re-encrypts the wallet keys under the new 4-digit PIN.
 * 4. Clears any PIN lockout / failed attempt counters and unblocks the account.
 * 5. Verifies the new PIN to ensure the wallet unlocks cleanly.
 *
 * Usage:
 *   node scripts/admin-reset-pin.js --user <telegram_id_or_username> [--pin <4-digit-pin>]
 *
 * Examples:
 *   node scripts/admin-reset-pin.js --user 123456789 --pin 5821
 *   node scripts/admin-reset-pin.js --user @crypto_bob
 *   node scripts/admin-reset-pin.js --help
 */

require("dotenv").config();
const db = require("../src/db");
const walletLib = require("../src/wallet");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    user: null,
    pin: null,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if ((arg === "--user" || arg === "-u") && args[i + 1]) {
      parsed.user = args[++i];
    } else if ((arg === "--pin" || arg === "-p") && args[i + 1]) {
      parsed.pin = args[++i];
    }
  }

  return parsed;
}

function printUsage() {
  console.log(`
PayIT Support Admin - Reset User PIN
===================================
Usage:
  node scripts/admin-reset-pin.js --user <telegramId_or_username> [--pin <4_digit_pin>]

Options:
  --user, -u   Telegram User ID or @username (required)
  --pin,  -p   New 4-digit PIN (optional; if not provided, a random 4-digit PIN will be generated)
  --help, -h   Show this help message
`);
}

function generateRandomPin() {
  // Generate a random 4-digit PIN (1000 - 9999)
  return Math.floor(1000 + Math.random() * 9000).toString();
}

/**
 * Fallback: If system_encrypted_key is missing on a legacy account,
 * brute-force the 4-digit PIN (0000 - 9999) using the user's stored salt/iv/tag.
 */
function recoverKeysViaPinSweep(user) {
  console.log("ℹ️  system_encrypted_key is missing. Attempting fast offline PIN recovery (0000-9999)...");
  const startTime = Date.now();

  for (let i = 0; i <= 9999; i++) {
    const candidatePin = i.toString().padStart(4, "0");
    try {
      const personalPk = walletLib.decryptPrivateKey(candidatePin, {
        encryptedKey: user.encrypted_key,
        salt: user.key_salt,
        iv: user.key_iv,
        tag: user.key_tag,
      });

      let bizPk = null;
      if (user.biz_encrypted_key) {
        bizPk = walletLib.decryptPrivateKey(candidatePin, {
          encryptedKey: user.biz_encrypted_key,
          salt: user.biz_key_salt,
          iv: user.biz_key_iv,
          tag: user.biz_key_tag,
        });
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`   Found current PIN in ${elapsed}s: [${candidatePin}]`);
      return { personalPk, bizPk, oldPin: candidatePin };
    } catch {
      // Continue searching
    }
  }

  throw new Error("Could not recover private key via offline PIN sweep.");
}

async function main() {
  const { user: userQuery, pin: requestedPin, help } = parseArgs();

  if (help || !userQuery) {
    printUsage();
    process.exit(help ? 0 : 1);
  }

  // Validate or generate PIN
  let newPin = requestedPin;
  if (!newPin) {
    newPin = generateRandomPin();
  } else if (!/^\d{4}$/.test(newPin)) {
    console.error("❌ Error: PIN must be exactly 4 digits (e.g. 1234).");
    process.exit(1);
  }

  // Find user
  let user = null;
  const isNumeric = /^-?\d+$/.test(userQuery);
  if (isNumeric) {
    user = db.getUser(Number(userQuery));
  }
  if (!user) {
    user = db.findUserByUsername(userQuery);
  }

  if (!user) {
    console.error(`❌ User not found for identifier: "${userQuery}".`);
    process.exit(1);
  }

  const tgId = user.telegram_id;
  console.log(`\n========================================`);
  console.log(`Resetting PIN for User:`);
  console.log(`  Telegram ID : ${tgId}`);
  console.log(`  Username    : ${user.username ? "@" + user.username : "(none)"}`);
  console.log(`  Wallet Addr : ${user.deposit_address}`);
  console.log(`  New PIN     : ${newPin}`);
  console.log(`========================================\n`);

  let personalPk = null;
  let bizPk = null;

  // Step 1: Recover private keys
  if (user.system_encrypted_key) {
    try {
      console.log("🔓 Decrypting wallet keys using system_encrypted_key...");
      personalPk = db.getSystemDecryptedPrivateKey(user, "personal");

      if (user.biz_encrypted_key && user.biz_system_encrypted_key) {
        bizPk = db.getSystemDecryptedPrivateKey(user, "business");
      }
    } catch (err) {
      console.warn(`⚠️ System decryption failed (${err.message}). Trying fallback sweep...`);
    }
  }

  if (!personalPk) {
    const sweepResult = recoverKeysViaPinSweep(user);
    personalPk = sweepResult.personalPk;
    bizPk = sweepResult.bizPk;
  }

  if (!personalPk) {
    console.error("❌ Failed to recover private key for user.");
    process.exit(1);
  }

  // Step 2: Update PIN in database
  console.log("🔐 Re-encrypting wallet keys with new PIN...");
  db.updatePin(tgId, newPin, personalPk, bizPk);

  // Step 3: Clear lockout and unblock if needed
  console.log("🧹 Resetting PIN lockout and unblocking user...");
  db.resetPinLockout(tgId);
  db.unblockUser(tgId);

  // Step 4: Verify the new PIN works
  const verified = db.verifyPin(tgId, newPin);
  if (!verified) {
    console.error("❌ FATAL: Verification failed after setting new PIN! Please check database integrity.");
    process.exit(1);
  }

  console.log("\n✅ SUCCESS: PIN has been reset and verified!");
  console.log("--------------------------------------------------");
  console.log(`Temporary PIN for user: ${newPin}`);
  console.log("--------------------------------------------------");
  console.log(`Customer Support message template to send to the user:\n`);
  console.log(
    `"Hello! Your security PIN has been temporarily reset to: ${newPin}\n` +
    `Please log in to the bot, go to Settings (or type /settings), and select 'Change PIN' to set your own private 4-digit PIN."\n`
  );
}

main().catch((err) => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});
