// scripts/fund-paymaster.js
// Deposits native USDC into the ERC-4337 EntryPoint contract for a specified Paymaster.
// Usage: node scripts/fund-paymaster.js <amount_usdc> [paymaster_address]

require("dotenv").config();
const { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits } = require("ethers");

const ARC_RPC_URL = process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";
const ENTRY_POINT_ADDRESS = process.env.ARC_ENTRY_POINT_ADDRESS || "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

const ENTRY_POINT_ABI = [
  "function depositTo(address account) external payable",
  "function balanceOf(address account) external view returns (uint256)",
];

async function main() {
  const amountArg = process.argv[2] || "5";
  const paymasterAddress = process.argv[3] || process.env.ARC_PAYMASTER_ADDRESS;

  if (!paymasterAddress) {
    console.error("❌ Error: Paymaster address required. Provide it as an argument or set ARC_PAYMASTER_ADDRESS in .env");
    console.log("Usage: node scripts/fund-paymaster.js <amount_usdc> <paymaster_address>");
    process.exit(1);
  }

  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) {
    console.error("❌ Error: DEPLOYER_PRIVATE_KEY is missing in .env");
    process.exit(1);
  }

  const provider = new JsonRpcProvider(ARC_RPC_URL, 5042002);
  const cleanKey = deployerKey.startsWith("0x") ? deployerKey : "0x" + deployerKey;
  const wallet = new Wallet(cleanKey, provider);

  console.log(`🏦 Funder address: ${wallet.address}`);
  console.log(`🎯 Paymaster address: ${paymasterAddress}`);
  console.log(`📍 EntryPoint address: ${ENTRY_POINT_ADDRESS}`);

  const entryPoint = new Contract(ENTRY_POINT_ADDRESS, ENTRY_POINT_ABI, wallet);

  // Arc native gas token is USDC in 18-decimal units (wei)
  const depositWei = parseUnits(amountArg, 18);
  console.log(`💸 Depositing ${amountArg} USDC (${depositWei.toString()} wei) to EntryPoint...`);

  const tx = await entryPoint.depositTo(paymasterAddress, { value: depositWei });
  console.log(`⏳ Tx submitted: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`✅ Deposit confirmed in block ${receipt.blockNumber}!`);

  const newBalanceWei = await entryPoint.balanceOf(paymasterAddress);
  const newBalanceUsdc = formatUnits(newBalanceWei, 18);
  console.log(`📊 Updated Paymaster Deposit Balance: ${newBalanceUsdc} USDC (${newBalanceWei.toString()} wei)`);
}

main().catch((err) => {
  console.error("❌ Funding failed:", err);
  process.exit(1);
});
