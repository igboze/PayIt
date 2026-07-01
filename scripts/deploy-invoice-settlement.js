const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config();

const ARC_TESTNET_CHAIN_ID = 5042002;
const ARC_TESTNET_RPC_URLS = ["https://rpc.testnet.arc.network", "https://rpc-canonical.testnet.arc.network"];

function validateDeploymentConfig({ rpcUrl, privateKey, feeRecipient, tokenAddress, chainId, signerAddress }) {
  const errors = [];

  if (!rpcUrl) {
    errors.push("RPC URL is required.");
  } else if (!ARC_TESTNET_RPC_URLS.includes(rpcUrl) && !rpcUrl.includes("arc.network")) {
    errors.push("RPC URL must point to an Arc network endpoint.");
  }

  if (!privateKey) {
    errors.push("DEPLOYER_PRIVATE_KEY is required.");
  } else if (!privateKey.startsWith("0x")) {
    errors.push("DEPLOYER_PRIVATE_KEY must be a 0x-prefixed private key.");
  }

  if (!feeRecipient || !ethers.isAddress(feeRecipient)) {
    errors.push("APP_FEE_RECIPIENT_ADDRESS must be a valid address.");
  }

  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    errors.push("SETTLEMENT_TOKEN_ADDRESS must be a valid address.");
  }

  if (chainId && Number(chainId) !== ARC_TESTNET_CHAIN_ID) {
    errors.push(`Arc testnet deployment requires chain ID ${ARC_TESTNET_CHAIN_ID}.`);
  }

  if (!signerAddress || !ethers.isAddress(signerAddress)) {
    errors.push("Signer address could not be resolved.");
  }

  return { ok: errors.length === 0, errors };
}

async function main() {
  const feeRecipient = process.env.APP_FEE_RECIPIENT_ADDRESS || process.env.FEE_RECIPIENT_ADDRESS;
  const rpcUrl = process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const network = await provider.getNetwork();

  const validation = validateDeploymentConfig({
    rpcUrl,
    privateKey,
    feeRecipient,
    tokenAddress: process.env.SETTLEMENT_TOKEN_ADDRESS || process.env.ARC_USDC_ADDRESS || process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000",
    chainId: Number(network.chainId),
    signerAddress: signer.address,
  });

  if (!validation.ok) {
    throw new Error(`Deployment validation failed:\n- ${validation.errors.join("\n- ")}`);
  }

  console.log(`Deploying InvoiceSettlement on chain ${network.chainId} via ${rpcUrl}`);

  const artifactPath = path.join(__dirname, "..", "artifacts", "InvoiceSettlement.json");
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Compiled contract artifact not found: ${artifactPath}. Run npm run compile-contracts first.`);
  }

  const tokenAddress = process.env.SETTLEMENT_TOKEN_ADDRESS || process.env.ARC_USDC_ADDRESS || process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000";

  const pauser = process.env.PAUSER_ADDRESS || signer.address;
  const blacklister = process.env.BLACKLISTER_ADDRESS || signer.address;

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(tokenAddress, feeRecipient, pauser, blacklister);
  await contract.waitForDeployment();

  console.log(`InvoiceSettlement deployed to: ${contract.target}`);

  const outputPath = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(outputPath)) fs.mkdirSync(outputPath, { recursive: true });
  fs.writeFileSync(path.join(outputPath, "invoice-settlement-address.txt"), contract.target);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { validateDeploymentConfig };
