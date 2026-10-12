// scripts/complete-in-flight-withdraw.js
require("dotenv").config();
const { JsonRpcProvider, Contract, Wallet, parseUnits, formatUnits } = require("ethers");
const axios = require("axios");
const nearLib = require("../src/near");
const { EVM_CCTP_CONTRACTS, CCTP_DOMAINS } = require("../src/cctp_bridge");

const ARC_TX_HASH = process.argv[2] || "0x0c94d1a91970c58df0fb68fc3f9c27f6a803aa8aac5273a6601af38bb4bc4e0d";
const DESTINATION_CHAIN = (process.argv[3] || "near").toLowerCase();
const DESTINATION_RECIPIENT = process.argv[4] || "nackam.near";
const USER_PRIVATE_KEY = process.argv[5] || process.env.USER_PRIVATE_KEY;

async function run() {
  console.log("=== Completing In-Flight Cross-Chain Withdrawal ===");
  console.log("Arc Tx Hash:        ", ARC_TX_HASH);
  console.log("Destination Chain:  ", DESTINATION_CHAIN);
  console.log("Recipient Address:  ", DESTINATION_RECIPIENT);

  // Step 1: Fetch Circle CCTP message and attestation
  console.log("\n1. Querying Circle Iris API...");
  const irisRes = await axios.get(`https://iris-api.circle.com/v2/messages/26?transactionHash=${ARC_TX_HASH}`);
  const msgObj = irisRes.data?.messages?.[0];
  if (!msgObj) {
    throw new Error(`No CCTP message found for transaction ${ARC_TX_HASH}`);
  }

  console.log("  Status:     ", msgObj.status);
  console.log("  Attestation:", msgObj.attestation ? "Verified ✓" : "Pending");
  if (msgObj.status !== "complete" || !msgObj.attestation) {
    throw new Error("Circle attestation is not yet complete. Please try again in 1 minute.");
  }

  const rawMessage = msgObj.message;
  const rawAttestation = msgObj.attestation;
  const amountUnits = BigInt(msgObj.decodedMessage?.decodedMessageBody?.amount || "7700000");
  const amountUsdc = Number(formatUnits(amountUnits, 6));
  const mintRecipient = msgObj.decodedMessage?.decodedMessageBody?.mintRecipient;

  console.log(`  Amount:      $${amountUsdc.toFixed(2)} USDC`);
  console.log(`  Recipient:   ${mintRecipient}`);

  // Step 2: Submit receiveMessage on Base
  const baseRpc = EVM_CCTP_CONTRACTS.BASE.rpcUrl;
  const baseProvider = new JsonRpcProvider(baseRpc);
  const signerKey = USER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;

  if (!signerKey) {
    console.log("\n⚠️ No private key provided to sign transactions on Base.");
    console.log("Provide the user's private key as an argument to execute the Base mint and NEAR intent:");
    console.log("  node scripts/complete-in-flight-withdraw.js <arcTxHash> <chain> <recipient> <privateKey>");
    return;
  }

  const baseSigner = new Wallet(signerKey, baseProvider);
  console.log("\n2. Submitting receiveMessage on Base...");
  console.log("  Signer: ", baseSigner.address);
  const ethBal = await baseProvider.getBalance(baseSigner.address);
  console.log("  ETH:    ", formatUnits(ethBal, 18), "ETH");

  const messageTransmitterV2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
  const transmitter = new Contract(
    messageTransmitterV2,
    ["function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool)"],
    baseSigner
  );

  let mintTxHash = null;
  try {
    const rxTx = await transmitter.receiveMessage(rawMessage, rawAttestation);
    console.log("  Transaction sent:", rxTx.hash);
    const receipt = await rxTx.wait(1);
    console.log("  ✓ receiveMessage confirmed in block", receipt.blockNumber);
    mintTxHash = receipt.hash;
  } catch (err) {
    if (err.message && err.message.toLowerCase().includes("nonce already used")) {
      console.log("  ✓ Nonce already used (USDC is already minted on Base)");
    } else {
      throw err;
    }
  }

  // Check Base USDC balance of mintRecipient
  const baseUsdcContract = new Contract(
    EVM_CCTP_CONTRACTS.BASE.usdc,
    [
      "function balanceOf(address) view returns (uint256)",
      "function transfer(address,uint256) returns (bool)",
    ],
    baseSigner
  );

  const usdcBal = await baseUsdcContract.balanceOf(baseSigner.address);
  console.log("\n3. Base USDC Balance of Signer:", formatUnits(usdcBal, 6), "USDC");

  if (DESTINATION_CHAIN === "base") {
    console.log("\n🎉 Withdrawal Complete! Funds have been minted directly to your Base address.");
    return;
  }

  // Step 3: Route via NEAR Intents (1Click)
  console.log(`\n4. Routing $${amountUsdc} to ${DESTINATION_CHAIN.toUpperCase()} (${DESTINATION_RECIPIENT}) via 1Click...`);
  let targetAsset;
  if (DESTINATION_CHAIN === "near") targetAsset = nearLib.ASSETS.NEAR_WNEAR;
  else if (DESTINATION_CHAIN === "bitcoin" || DESTINATION_CHAIN === "btc") targetAsset = nearLib.ASSETS.WBTC;
  else if (DESTINATION_CHAIN === "tron") targetAsset = nearLib.ASSETS.NEAR_USDT;
  else if (DESTINATION_CHAIN === "starknet") targetAsset = nearLib.ASSETS.STARKNET_STRK;
  else targetAsset = nearLib.ASSETS.NEAR_WNEAR;

  const quoteRes = await nearLib.getQuote({
    originAsset: nearLib.ASSETS.BASE_USDC,
    destinationAsset: targetAsset,
    amount: amountUnits.toString(),
    recipient: DESTINATION_RECIPIENT,
    refundTo: baseSigner.address,
    dry: false,
  });

  const depositAddress = quoteRes?.quote?.depositAddress;
  if (!depositAddress) {
    throw new Error(`1Click did not return a deposit address: ${JSON.stringify(quoteRes)}`);
  }

  console.log("  1Click Deposit Address:", depositAddress);
  console.log("  Estimated Output:       ", quoteRes?.quote?.amountOutFormatted, DESTINATION_CHAIN.toUpperCase());
  console.log("  Estimated Delivery Time:", quoteRes?.quote?.timeEstimate, "seconds");

  console.log("\n5. Transferring Base USDC to 1Click...");
  const transferTx = await baseUsdcContract.transfer(depositAddress, amountUnits);
  console.log("  Transfer tx broadcasted:", transferTx.hash);
  const transferReceipt = await transferTx.wait(1);
  console.log("  ✓ Transfer confirmed in block", transferReceipt.blockNumber);

  console.log(`\n🎉 SUCCESS! $${amountUsdc} USDC routed to ${DESTINATION_RECIPIENT} on ${DESTINATION_CHAIN.toUpperCase()}.`);
  console.log("Solvers will deliver the tokens within ~35 seconds.");
}

run().catch((err) => {
  console.error("\n❌ Error:", err.shortMessage || err.message);
  process.exit(1);
});
