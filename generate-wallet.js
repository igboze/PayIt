// generate-wallet.js
//
// Generic utility — generates a standalone Arc-compatible wallet.
// Use for: gas-sponsor wallet, fee recipient wallet, testing.
// NOT used by the bot automatically — users get wallets at /start.
//
// Usage: npm run generate-wallet

const { Wallet } = require("ethers");

const wallet = Wallet.createRandom();

console.log("\n=================================================");
console.log(" NEW WALLET GENERATED (Arc / EVM compatible)");
console.log("=================================================\n");
console.log("Address    :", wallet.address);
console.log("Private key:", wallet.privateKey);
console.log("Seed phrase:", wallet.mnemonic.phrase);
console.log("\n=================================================");
console.log("Fund with testnet USDC at https://faucet.circle.com");
console.log("Select: Arc Testnet — request USDC or EURC");
console.log("Never share or commit your private key or seed phrase.");
console.log("=================================================\n");
