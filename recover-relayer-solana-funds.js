// recover-relayer-solana-funds.js
//
// Tests candidate keys/seeds you provide against a target address to see if
// a candidate keypair controls it.
//
// ── USAGE ──
// 1. Dry run: node recover-relayer-solana-funds.js <TARGET_SOLANA_ADDRESS>
// 2. If a match is found and confirmed, transfer the funds:
//      DEST_ADDRESS=<user's current correct Solana address> EXECUTE=1 node recover-relayer-solana-funds.js <TARGET_SOLANA_ADDRESS>

require("dotenv").config();
const { Keypair } = require("@solana/web3.js");
const bs58mod = require("bs58");
const bs58 = bs58mod.default || bs58mod;
const multichain = require("./src/multichain");

const TARGET_ADDRESS = process.argv[2];
if (!TARGET_ADDRESS) {
  console.log("Usage: node recover-relayer-solana-funds.js <TARGET_SOLANA_ADDRESS>");
  process.exit(1);
}

// Add anything plausible here. Each entry is tried; wrong guesses are just skipped, nothing
// is sent anywhere until a match is found AND EXECUTE=1 is set.
const CANDIDATES = [
  // EVM-style hex private keys, run through the SAME derivation your bot uses
  // (multichain.deriveSolanaFromEvmKey) - try old RELAYER_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY
  { label: "env:RELAYER_PRIVATE_KEY", type: "evm", value: process.env.RELAYER_PRIVATE_KEY },
  { label: "env:DEPLOYER_PRIVATE_KEY", type: "evm", value: process.env.DEPLOYER_PRIVATE_KEY },
  { label: "env:OLD_RELAYER_PRIVATE_KEY", type: "evm", value: process.env.OLD_RELAYER_PRIVATE_KEY },
  { label: "env:SOLANA_FEE_PAYER_KEY", type: "solana", value: process.env.SOLANA_FEE_PAYER_KEY },

  // If you find a raw Solana secret key (base58 string, or a JSON array of 64 numbers),
  // paste it directly here as a "solana" type candidate:
  // { label: "manual: found in old backup", type: "solana", value: "5Kb8kL..." },

  // If you find an old EVM-style hex key from a backup, paste it as an "evm" type candidate:
  // { label: "manual: old .env backup", type: "evm", value: "0xabc123..." },
].filter((c) => c.value);

function loadEvmDerived(hexKey) {
  return multichain.deriveSolanaFromEvmKey(hexKey).keypair;
}

function loadSolanaKeypair(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

async function main() {
  if (CANDIDATES.length === 0) {
    console.log(
      "No candidates configured yet. Open this file and fill in CANDIDATES with any old\n" +
      "relayer key, seed, or env var value you find (see the header comment for where to look),\n" +
      "then run this again."
    );
    return;
  }

  console.log(`Testing ${CANDIDATES.length} candidate(s) against ${TARGET_ADDRESS}\n`);

  let matchedKeypair = null;
  let matchedLabel = null;

  for (const c of CANDIDATES) {
    let keypair;
    try {
      keypair = c.type === "evm" ? loadEvmDerived(c.value) : loadSolanaKeypair(c.value);
    } catch (e) {
      console.log(`  [${c.label}] could not parse: ${e.message}`);
      continue;
    }
    const addr = keypair.publicKey.toBase58();
    const isMatch = addr === TARGET_ADDRESS;
    console.log(`  [${c.label}] -> ${addr} ${isMatch ? "  <== MATCH" : ""}`);
    if (isMatch) {
      matchedKeypair = keypair;
      matchedLabel = c.label;
    }
  }

  if (!matchedKeypair) {
    console.log(
      "\nNo candidate matched. This means none of the keys you tried control this address.\n" +
      "Keep looking (Railway variable history and git history are the most likely places),\n" +
      "or if nothing turns up, this address may not be recoverable and the path becomes a\n" +
      "manual conversation with Paj (see investigate-stuck-paj-address.js for the evidence\n" +
      "to send them)."
    );
    return;
  }

  console.log(`\nMatch confirmed: ${matchedLabel} controls ${TARGET_ADDRESS}`);

  const conn = multichain.getSolanaConnection();
  const bal = await multichain.getSplTokenBalance(TARGET_ADDRESS, multichain.SOLANA_USDC_MINT);
  console.log(`USDC balance at address: ${bal.uiAmount}`);
  const solLamports = await conn.getBalance(matchedKeypair.publicKey);
  console.log(`SOL balance (for fees): ${(solLamports / 1e9).toFixed(6)}`);

  if (bal.uiAmount <= 0) {
    console.log("Nothing to transfer.");
    return;
  }

  const dest = process.env.DEST_ADDRESS;
  if (!dest) {
    console.log(
      "\nSet DEST_ADDRESS to the user's CURRENT correct Solana address (the one your fixed\n" +
      "getOrDeriveSolanaAddress()/resolveSolanaRecipient() now returns for them) and re-run\n" +
      "with EXECUTE=1 to send the funds there."
    );
    return;
  }

  if (solLamports === 0) {
    console.log(
      `\nThis key has 0 SOL, so it cannot pay the network fee to send its own USDC.\n` +
      `Send a small amount of SOL (0.002 is plenty) to ${matchedKeypair.publicKey.toBase58()} first, then re-run.`
    );
    return;
  }

  if (process.env.EXECUTE !== "1") {
    console.log(`\nDry run only. Would send ${bal.uiAmount} USDC to ${dest}. Set EXECUTE=1 to actually send.`);
    return;
  }

  console.log(`\nSending ${bal.uiAmount} USDC to ${dest} ...`);
  const result = await multichain.sendSolanaTransfer({
    keypair: matchedKeypair,
    recipientAddress: dest,
    amount: bal.uiAmount,
    currency: "USDC",
  });
  console.log(result);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
