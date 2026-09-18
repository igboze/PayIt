// src/network.js
// Centralized network configuration for Arc (Mainnet & Testnet)

const NETWORKS = {
  mainnet: {
    name: "Arc Mainnet",
    chainId: 5042,
    rpcUrl: "https://rpc.mainnet.arc.io",
    explorerUrl: "https://explorer.arc.io",
    gatewayApiUrl: "https://gateway-api.circle.com/v1",
    gatewayWalletAddress: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayMinterAddress: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    usdcAddress: "0x3600000000000000000000000000000000000000",
    eurcAddress: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
    domainId: 26,
    isTestnet: false,
  },
  testnet: {
    name: "Arc Testnet",
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.network",
    explorerUrl: "https://testnet.arcscan.app",
    gatewayApiUrl: "https://gateway-api-testnet.circle.com/v1",
    gatewayWalletAddress: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayMinterAddress: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    usdcAddress: "0x3600000000000000000000000000000000000000",
    eurcAddress: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    domainId: 26,
    isTestnet: true,
  },
};

/**
 * Resolve current active network configuration.
 * Defaults to Mainnet unless ARC_NETWORK=testnet or testnet RPC/chainId is explicitly configured.
 */
function getNetworkConfig() {
  const envNet = (process.env.ARC_NETWORK || "").trim().toLowerCase();
  const envRpc = process.env.ARC_RPC_URL || "";
  const envChainId = process.env.ARC_CHAIN_ID;

  let baseKey = "mainnet";
  if (envNet === "testnet" || envRpc.includes("testnet") || String(envChainId) === "5042002") {
    baseKey = "testnet";
  }

  const base = NETWORKS[baseKey];

  const chainId = envChainId ? parseInt(envChainId, 10) : base.chainId;
  const rpcUrl = process.env.ARC_RPC_URL || base.rpcUrl;
  const explorerUrl = (process.env.ARC_EXPLORER_URL || base.explorerUrl).replace(/\/+$/, "");
  const gatewayApiUrl = process.env.GATEWAY_API_URL || base.gatewayApiUrl;
  const usdcAddress = process.env.ARC_USDC_ADDRESS || base.usdcAddress;
  const eurcAddress = process.env.ARC_EURC_ADDRESS || base.eurcAddress;

  return {
    ...base,
    key: baseKey,
    chainId,
    rpcUrl,
    explorerUrl,
    gatewayApiUrl,
    usdcAddress,
    eurcAddress,
  };
}

/**
 * Format block explorer URL for addresses or transactions.
 */
function getExplorerUrl(identifier, type = "address") {
  const { explorerUrl } = getNetworkConfig();
  const cleanId = String(identifier || "").trim();
  const cleanType = type === "tx" || type === "transaction" ? "tx" : "address";
  return `${explorerUrl}/${cleanType}/${cleanId}`;
}

module.exports = {
  NETWORKS,
  getNetworkConfig,
  getExplorerUrl,
};
