require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

const ARC_RPC_URL = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

module.exports = {
  solidity: "0.8.20",
  defaultNetwork: "arc_testnet",
  networks: {
    arc_testnet: {
      url: ARC_RPC_URL,
      chainId: 5042002,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./tests",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
