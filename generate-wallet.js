// generate-wallet.js
//
// NOTE: as of the non-custodial redesign, the bot no longer needs a shared
// treasury wallet to run - each user gets their own independent wallet
// automatically at /start. This script is now just a generic utility for
// generating a standalone Arc-compatible wallet for any other purpose you
// might need one (e.g. a future gas-sponsor wallet, or just testing).
//
// Usage: npm run generate-wallet

const { Wallet } = require("ethers");

const wallet = Wallet.createRandom();

console.log("\n=================================================");
console.log(" NEW WALLET GENERATED");
console.log("=================================================\n");
console.log("Address:", wallet.address);
console.log("\nPrivate key (use this for SAVINGS_VAULT_PRIVATE_KEY if generating a savings demo vault):");
console.log(wallet.privateKey);
console.log("\nSeed phrase (12 words) - alternative way to back up the same wallet:");
console.log(wallet.mnemonic.phrase);
console.log("\n=================================================");
console.log("This wallet is NOT used by the bot automatically.");
console.log("Fund it via https://faucet.circle.com if you need testnet USDC for it.");
console.log("Never share this seed phrase or commit it to git.");
console.log("=================================================\n");
