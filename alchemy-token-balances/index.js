// index.js
// Calls alchemy_getTokenBalances on Ethereum Mainnet using Alchemy JSON-RPC API
require("dotenv").config();

async function getTokenBalances() {
  const apiKey = process.env.ALCHEMY_API_KEY;

  if (!apiKey || apiKey === "your_alchemy_api_key_here") {
    console.error("❌ Error: ALCHEMY_API_KEY is not set.");
    console.error("Please create a .env file in this directory with:");
    console.error("  ALCHEMY_API_KEY=<your-alchemy-api-key>");
    process.exit(1);
  }

  // Ethereum Mainnet Alchemy endpoint
  const endpoint = `https://eth-mainnet.g.alchemy.com/v2/${apiKey}`;

  // Target Ethereum address (pass via CLI: node index.js 0x... or defaults to vitalik.eth)
  const targetAddress = process.argv[2] || "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

  console.log("==================================================");
  console.log("📡 Alchemy API: alchemy_getTokenBalances");
  console.log(`🌐 Network: Ethereum Mainnet`);
  console.log(`👤 Target Address: ${targetAddress}`);
  console.log("==================================================\n");

  // JSON-RPC payload for alchemy_getTokenBalances
  // Option 'erc20' returns balances for top ERC-20 tokens
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "alchemy_getTokenBalances",
    params: [
      targetAddress,
      "erc20" // or provide an array of contract addresses: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"]
    ]
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (data.error) {
      console.error("❌ Alchemy RPC Error:", data.error);
      return;
    }

    console.log("✅ Response Received:\n");
    console.log(JSON.stringify(data, null, 2));

    // Summary of non-zero token balances
    const balances = data.result?.tokenBalances || [];
    const nonZeroBalances = balances.filter(
      (b) => b.tokenBalance && b.tokenBalance !== "0x0" && b.tokenBalance !== "0x0000000000000000000000000000000000000000000000000000000000000000"
    );

    console.log("\n--------------------------------------------------");
    console.log(`📊 Total tokens checked: ${balances.length}`);
    console.log(`💰 Non-zero balance tokens: ${nonZeroBalances.length}`);
    console.log("--------------------------------------------------");

    if (nonZeroBalances.length > 0) {
      console.log("\nNon-zero Token Balances (Raw Hex):");
      nonZeroBalances.slice(0, 10).forEach((t, i) => {
        const rawHex = t.tokenBalance;
        const rawBigInt = BigInt(rawHex);
        console.log(`  ${i + 1}. Contract: ${t.contractAddress}`);
        console.log(`     Raw Balance (Hex): ${rawHex}`);
        console.log(`     Raw Balance (Int): ${rawBigInt.toString()}\n`);
      });
      if (nonZeroBalances.length > 10) {
        console.log(`  ... and ${nonZeroBalances.length - 10} more tokens.`);
      }
    }

  } catch (error) {
    console.error("❌ Failed to call Alchemy API:", error.message);
  }
}

getTokenBalances();
