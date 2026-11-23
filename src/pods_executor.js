// src/pods_executor.js
// Atomic EIP-7702 Batch Execution Engine + Micro-Gas Sponsor + Arc->Base Funding Bridge
// Uses Pods Finance's canonical EIP-7702 Simple Account batcher (0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9)
// so multi-leg approve + bridge + strategy calls execute in ONE atomic Type-4 transaction.

const { JsonRpcProvider, Wallet, Contract, Interface, parseEther, formatUnits, parseUnits } = require("ethers");
const gateway = require("./gateway");
const cctpBridge = require("./cctp_bridge");
const { getNetworkConfig } = require("./network");
const walletLib = require("./wallet");
const pods = require("./pods");

const SIMPLE_7702_ACCOUNT_ADDRESS = "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9";

const EIP7702_BATCH_IFACE = new Interface([
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
]);

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const CHAIN_CONFIG = {
  8453: {
    name: "Base",
    rpcUrl: () => process.env.BASE_RPC_URL || "https://mainnet.base.org",
    nativeSymbol: "ETH",
    minGasEther: "0.00008",
    dripEther: "0.00018",
  },
  56: {
    name: "BSC",
    rpcUrl: () => process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
    nativeSymbol: "BNB",
    minGasEther: "0.0004",
    dripEther: "0.0009",
  },
  100: {
    name: "Gnosis",
    rpcUrl: () => process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com",
    nativeSymbol: "xDAI",
    minGasEther: "0.005",
    dripEther: "0.015",
  },
  42161: {
    name: "Arbitrum",
    rpcUrl: () => process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
    nativeSymbol: "ETH",
    minGasEther: "0.00008",
    dripEther: "0.00018",
  },
  1: {
    name: "Ethereum",
    rpcUrl: () => process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com",
    nativeSymbol: "ETH",
    minGasEther: "0.0008",
    dripEther: "0.0015",
  },
};

function getChainProvider(chainId) {
  const cfg = CHAIN_CONFIG[Number(chainId)];
  if (!cfg) throw new Error(`Unsupported Pods execution chainId: ${chainId}`);
  return new JsonRpcProvider(cfg.rpcUrl(), Number(chainId), { staticNetwork: true });
}

function getGasRelayerKey() {
  return (
    process.env.EVM_GAS_RELAYER_PRIVATE_KEY ||
    process.env.GAS_SPONSOR_PRIVATE_KEY ||
    process.env.RELAYER_PRIVATE_KEY ||
    ""
  ).trim();
}

/**
 * Ensure the user's EOA has enough native gas on `chainId` to broadcast an EIP-7702 batch tx.
 * Automatically sponsors micro-gas from the configured relayer wallet if available.
 */
async function ensureGasForChain(chainId, userAddress) {
  const cfg = CHAIN_CONFIG[Number(chainId)];
  if (!cfg) throw new Error(`Unsupported chainId: ${chainId}`);
  const provider = getChainProvider(chainId);
  const currentBal = await provider.getBalance(userAddress);
  const minRequired = parseEther(cfg.minGasEther);
  if (currentBal >= minRequired) {
    return { sponsored: false, balanceWei: currentBal.toString() };
  }

  const relayerKey = getGasRelayerKey();
  if (!relayerKey) {
    throw new Error(
      `Insufficient ${cfg.nativeSymbol} gas on ${cfg.name} and no gas relayer configured. Please contact support.`
    );
  }

  const relayer = new Wallet(relayerKey, provider);
  const dripAmount = parseEther(cfg.dripEther);
  const relayerBal = await provider.getBalance(relayer.address);
  if (relayerBal < dripAmount * 2n) {
    throw new Error(
      `Platform ${cfg.name} gas relayer is low on ${cfg.nativeSymbol}. Please retry shortly.`
    );
  }

  const tx = await relayer.sendTransaction({
    to: userAddress,
    value: dripAmount,
  });
  await tx.wait(1);
  return { sponsored: true, txHash: tx.hash, drippedWei: dripAmount.toString() };
}

/**
 * Get the user's current USDC balance on Base (6 decimals).
 */
async function getBaseUsdcBalance(userAddress) {
  const provider = getChainProvider(pods.BASE_CHAIN_ID);
  const usdc = new Contract(pods.BASE_USDC_ADDRESS, ERC20_ABI, provider);
  const raw = await usdc.balanceOf(userAddress);
  return Number(formatUnits(raw, 6));
}

/**
 * Ensure the user has at least `amountUsdc` on Base to fund a Pods cross-chain buy/deposit.
 * If Base USDC is short, bridges the exact shortfall from Arc Mainnet -> Base via Circle Gateway.
 */
async function ensureBaseUsdcForInvestment({ privateKey, userAddress, amountUsdc, telegramId = null }) {
  const needed = Number(amountUsdc);
  if (!Number.isFinite(needed) || needed <= 0) {
    throw new Error("Invalid investment amount");
  }

  const currentBase = await getBaseUsdcBalance(userAddress);
  if (currentBase >= needed - 0.01) {
    return { bridged: false, baseBalanceBefore: currentBase, baseBalanceAfter: currentBase };
  }

  const shortfall = Number((needed - currentBase + 0.05).toFixed(2)); // tiny $0.05 buffer for bridge dust
  const arcBal = Number(await walletLib.getArcBalance(userAddress) || 0);
  if (arcBal < shortfall) {
    throw new Error(
      `Insufficient balance. Needed $${needed.toFixed(2)} USDC (Arc: $${arcBal.toFixed(2)}, Base: $${currentBase.toFixed(2)}).`
    );
  }

  let bridgeTxHash = null;

  // 1. Try instant Circle Gateway transfer if user has Gateway balance on Arc
  try {
    const gwRes = await gateway.transferBetweenChains(privateKey, {
      sourceChain: "Arc",
      destinationChain: "Base",
      amountUsdc: shortfall,
      recipientAddress: userAddress,
    });
    bridgeTxHash = gwRes?.transferId || gwRes?.txHash || null;
  } catch (gwErr) {
    // 2. Standard path: burn directly on Arc Mainnet via CCTP V2 and mint on Base
    const arcCfg = getNetworkConfig();
    const arcProvider = new JsonRpcProvider(arcCfg.rpcUrl, arcCfg.chainId, { staticNetwork: true });
    const arcWallet = new Wallet(privateKey, arcProvider);
    const burnRes = await cctpBridge.executeArcToEvmCctpBurn({
      userWallet: arcWallet,
      amountUsdc: shortfall,
      destinationDomain: cctpBridge.CCTP_DOMAINS.BASE,
      destinationRecipientAddress: userAddress,
      telegramId,
    });
    bridgeTxHash = burnRes?.txHash || null;

    if (burnRes?.txHash) {
      await cctpBridge.completeCctpWithdrawalOnEvm({
        arcTxHash: burnRes.txHash,
        messageHex: burnRes.messageHex,
        messageHash: burnRes.messageHash,
        destinationDomain: cctpBridge.CCTP_DOMAINS.BASE,
        destinationRecipientAddress: userAddress,
        userWallet: arcWallet,
        userPrivateKey: privateKey,
        telegramId,
        amountUsdc: shortfall,
        chainName: "Base",
        maxAttempts: 40,
      });
    }
  }

  // Brief confirmation poll for Base USDC arrival (up to ~30s)
  for (let i = 0; i < 10; i++) {
    const updated = await getBaseUsdcBalance(userAddress);
    if (updated >= needed - 0.01) {
      return {
        bridged: true,
        shortfall,
        bridgeTxHash,
        baseBalanceBefore: currentBase,
        baseBalanceAfter: updated,
      };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  const finalBal = await getBaseUsdcBalance(userAddress);
  return {
    bridged: true,
    shortfall,
    bridgeTxHash,
    baseBalanceBefore: currentBase,
    baseBalanceAfter: finalBal,
  };
}

/**
 * Execute all Pods `bytecode[]` legs for `chainId` in ONE atomic EIP-7702 Type-4 transaction.
 */
async function executePodsBytecodeAtomic({ privateKey, chainId, bytecodeLegs }) {
  if (!Array.isArray(bytecodeLegs) || bytecodeLegs.length === 0) {
    throw new Error("No bytecode legs returned by Pods API");
  }

  const targetChain = Number(chainId);
  const legs = bytecodeLegs.filter((l) => !l.chainId || Number(l.chainId) === targetChain);
  if (!legs.length) {
    throw new Error(`No executable legs found for chainId ${targetChain}`);
  }

  const provider = getChainProvider(targetChain);
  const wallet = new Wallet(privateKey, provider);

  await ensureGasForChain(targetChain, wallet.address);

  // Single-leg transactions can execute directly as a normal EOA tx; multi-leg MUST batch via EIP-7702
  if (legs.length === 1) {
    const leg = legs[0];
    const tx = await wallet.sendTransaction({
      to: leg.to,
      data: leg.data || "0x",
      value: BigInt(leg.value || "0"),
    });
    const receipt = await tx.wait(1);
    return {
      txHash: tx.hash,
      blockNumber: receipt?.blockNumber || null,
      atomicBatch: false,
      legCount: 1,
    };
  }

  const calls = legs.map((leg) => ({
    target: leg.to,
    value: BigInt(leg.value || "0"),
    data: leg.data || "0x",
  }));
  const totalValue = calls.reduce((acc, c) => acc + c.value, 0n);
  const batchCalldata = EIP7702_BATCH_IFACE.encodeFunctionData("executeBatch", [calls]);

  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const auth = await wallet.authorize({
    address: SIMPLE_7702_ACCOUNT_ADDRESS,
    nonce: nonce + 1,
    chainId: targetChain,
  });

  const tx = await wallet.sendTransaction({
    type: 4,
    to: wallet.address,
    data: batchCalldata,
    value: totalValue,
    authorizationList: [auth],
    nonce,
  });
  const receipt = await tx.wait(1);
  return {
    txHash: tx.hash,
    blockNumber: receipt?.blockNumber || null,
    atomicBatch: true,
    legCount: legs.length,
  };
}

/**
 * Helper to convert human USD amount to Base USDC 6-decimal integer string.
 */
function toBaseUsdcUnits(amountUsd) {
  return parseUnits(Number(amountUsd).toFixed(6), 6).toString();
}

module.exports = {
  SIMPLE_7702_ACCOUNT_ADDRESS,
  CHAIN_CONFIG,
  getChainProvider,
  ensureGasForChain,
  getBaseUsdcBalance,
  ensureBaseUsdcForInvestment,
  executePodsBytecodeAtomic,
  toBaseUsdcUnits,
};
