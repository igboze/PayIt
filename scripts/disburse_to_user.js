require("dotenv").config();
const { JsonRpcProvider, Wallet, parseUnits, formatUnits } = require("ethers");
const { getNetworkConfig } = require("../src/network");

async function disburse(recipientArcAddress, amountUsdc) {
  if (!recipientArcAddress || !amountUsdc) {
    console.error("Usage: node scripts/disburse_to_user.js <0xRecipientAddress> <amountUsdc>");
    process.exit(1);
  }

  const net = getNetworkConfig();
  console.log(`Network: ${net.name} (${net.chainId}) via ${net.rpcUrl}`);

  const relayerKey = process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!relayerKey) {
    throw new Error("RELAYER_PRIVATE_KEY not set in .env");
  }

  const provider = new JsonRpcProvider(net.rpcUrl, net.chainId);
  const relayer = new Wallet(relayerKey, provider);

  console.log(`Relayer Address: ${relayer.address}`);
  const relayerBal = await provider.getBalance(relayer.address);
  console.log(`Relayer Balance: ${formatUnits(relayerBal, 18)} USDC`);

  const amountWei = parseUnits(amountUsdc.toString(), 18);
  console.log(`Sending $${amountUsdc} USDC to ${recipientArcAddress}...`);

  const tx = await relayer.sendTransaction({
    to: recipientArcAddress,
    value: amountWei,
  });

  console.log(`Transaction broadcast! Hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}! Status: ${receipt.status === 1 ? "SUCCESS" : "FAILED"}`);
}

const targetAddress = process.argv[2];
const targetAmount = process.argv[3] || "1.44";

if (targetAddress) {
  disburse(targetAddress, targetAmount).catch(console.error);
}

module.exports = { disburse };
