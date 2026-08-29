// src/paymaster.js
// Arc Paymaster & ERC-4337 Account Abstraction (Gas Sponsorship) Integration
// Supports zero-gas transactions on Arc Network (Chain ID 5042002) via Paymaster RPC.

const { JsonRpcProvider, Contract, getAddress, keccak256, AbiCoder, toBeHex, getBytes } = require("ethers");
const axios = require("axios");

// Default EntryPoint v0.7 address for Arc Network
const DEFAULT_ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const DEFAULT_CHAIN_ID = 5042002;

/**
 * Get the current Arc Paymaster and Bundler configuration from environment.
 */
function getPaymasterConfig() {
  const enabledEnv = process.env.ARC_PAYMASTER_ENABLED;
  const isEnabled = enabledEnv === undefined ? true : (enabledEnv === "true" || enabledEnv === "1");
  const paymasterUrl = process.env.ARC_PAYMASTER_RPC_URL || "https://paymaster.testnet.arc.network/v1";
  const bundlerUrl = process.env.ARC_BUNDLER_RPC_URL || process.env.ARC_RPC_URL || "https://bundler.testnet.arc.network/v1";
  const policyId = process.env.ARC_PAYMASTER_POLICY_ID || "payit-default-sponsorship";
  const entryPoint = process.env.ARC_ENTRY_POINT_ADDRESS || DEFAULT_ENTRY_POINT;
  const chainId = parseInt(process.env.ARC_CHAIN_ID || DEFAULT_CHAIN_ID, 10);

  return {
    enabled: isEnabled,
    paymasterUrl,
    bundlerUrl,
    policyId,
    entryPoint: getAddress(entryPoint),
    chainId,
  };
}

/**
 * Check if Arc Paymaster is enabled and configured.
 */
function isPaymasterActive() {
  const config = getPaymasterConfig();
  return Boolean(config.enabled && config.paymasterUrl && config.bundlerUrl);
}

/**
 * Generic JSON-RPC helper for Bundler / Paymaster RPC requests.
 */
async function callJsonRpc(endpointUrl, method, params = [], timeoutMs = 15000) {
  const payload = {
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params,
  };

  const response = await axios.post(endpointUrl, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: timeoutMs,
  });

  if (response.data && response.data.error) {
    const err = new Error(response.data.error.message || `RPC Error in ${method}`);
    err.code = response.data.error.code;
    err.data = response.data.error.data;
    throw err;
  }

  return response.data ? response.data.result : null;
}

/**
 * Calculate deterministic UserOperation hash according to ERC-4337 specification.
 */
function getUserOpHash(userOp, entryPoint, chainId) {
  const abiCoder = AbiCoder.defaultAbiCoder();
  const packedUserOp = abiCoder.encode(
    [
      "address",
      "uint256",
      "bytes32",
      "bytes32",
      "uint256",
      "uint256",
      "uint256",
      "uint256",
      "uint256",
      "bytes32",
    ],
    [
      userOp.sender,
      userOp.nonce,
      keccak256(userOp.initCode || "0x"),
      keccak256(userOp.callData || "0x"),
      userOp.callGasLimit,
      userOp.verificationGasLimit,
      userOp.preVerificationGas,
      userOp.maxFeePerGas,
      userOp.maxPriorityFeePerGas,
      keccak256(userOp.paymasterAndData || "0x"),
    ]
  );

  const enc = abiCoder.encode(
    ["bytes32", "address", "uint256"],
    [keccak256(packedUserOp), entryPoint, chainId]
  );

  return keccak256(enc);
}

/**
 * Build a basic UserOperation structure for a target transaction.
 */
async function buildBaseUserOp({ sender, to, value = 0n, data = "0x", nonce = 0n }) {
  // Simple direct execution callData encoding for smart accounts (execute(address,uint256,bytes))
  const abiCoder = AbiCoder.defaultAbiCoder();
  // Standard execute(to, value, data) selector: 0xb61d27f6
  const EXECUTE_SELECTOR = "0xb61d27f6";
  const executeCallData = EXECUTE_SELECTOR + abiCoder.encode(["address", "uint256", "bytes"], [to, value, data]).slice(2);

  return {
    sender: getAddress(sender),
    nonce: toBeHex(nonce),
    initCode: "0x",
    callData: executeCallData,
    callGasLimit: toBeHex(100000),
    verificationGasLimit: toBeHex(150000),
    preVerificationGas: toBeHex(50000),
    maxFeePerGas: toBeHex(20000000000n), // 20 Gwei (Arc minimum base fee)
    maxPriorityFeePerGas: toBeHex(2000000000n), // 2 Gwei
    paymasterAndData: "0x",
    signature: "0x",
  };
}

function chainIdToHex(chainId) {
  return "0x" + Number(chainId).toString(16);
}

/**
 * Request gas sponsorship data from Arc Paymaster.
 * Calls `pm_sponsorUserOperation` (or fallback `pm_getPaymasterData`).
 */
async function requestPaymasterSponsorship(userOp, config = getPaymasterConfig()) {
  const { paymasterUrl, entryPoint, policyId } = config;

  try {
    // Try standard ERC-4337 Paymaster RPC method
    const sponsorshipResult = await callJsonRpc(paymasterUrl, "pm_sponsorUserOperation", [
      userOp,
      entryPoint,
      { policyId },
    ]);

    if (typeof sponsorshipResult === "string") {
      return { paymasterAndData: sponsorshipResult };
    }

    if (sponsorshipResult && typeof sponsorshipResult === "object") {
      return {
        paymasterAndData: sponsorshipResult.paymasterAndData || "0x",
        callGasLimit: sponsorshipResult.callGasLimit || userOp.callGasLimit,
        verificationGasLimit: sponsorshipResult.verificationGasLimit || userOp.verificationGasLimit,
        preVerificationGas: sponsorshipResult.preVerificationGas || userOp.preVerificationGas,
        maxFeePerGas: sponsorshipResult.maxFeePerGas || userOp.maxFeePerGas,
        maxPriorityFeePerGas: sponsorshipResult.maxPriorityFeePerGas || userOp.maxPriorityFeePerGas,
      };
    }

    return { paymasterAndData: "0x" };
  } catch (err) {
    // Fallback: try pm_getPaymasterData if bundler-specific
    try {
      const fallbackResult = await callJsonRpc(paymasterUrl, "pm_getPaymasterData", [
        userOp,
        entryPoint,
        chainIdToHex(config.chainId),
      ]);
      return { paymasterAndData: fallbackResult.paymasterAndData || fallbackResult };
    } catch (fallbackErr) {
      throw new Error(`Paymaster sponsorship rejected: ${err.message || fallbackErr.message}`);
    }
  }
}

/**
 * Submit signed UserOperation to the Arc Bundler.
 */
async function submitUserOperation(signedUserOp, config = getPaymasterConfig()) {
  const { bundlerUrl, entryPoint } = config;
  const userOpHash = await callJsonRpc(bundlerUrl, "eth_sendUserOperation", [signedUserOp, entryPoint]);
  return userOpHash;
}

/**
 * Poll Bundler for UserOperation receipt.
 */
async function waitForUserOpReceipt(userOpHash, config = getPaymasterConfig(), maxWaitMs = 60000, pollIntervalMs = 2000) {
  const { bundlerUrl } = config;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const receipt = await callJsonRpc(bundlerUrl, "eth_getUserOperationReceipt", [userOpHash]);
      if (receipt && (receipt.receipt || receipt.transactionHash)) {
        return receipt;
      }
    } catch {
      // Receipt might not be indexed immediately, continue polling
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return null;
}

/**
 * Execute a transaction via Arc Paymaster (Gas-sponsored).
 * Returns { success: true, txHash, userOpHash, sponsored: true } on success,
 * or throws if Paymaster fails.
 */
async function executeSponsoredTransaction(signer, toAddress, amountMicro, data = "0x", options = {}) {
  const config = getPaymasterConfig();
  if (!config.enabled) {
    throw new Error("Arc Paymaster is currently disabled in environment configuration.");
  }

  const sender = signer.address;
  const target = getAddress(toAddress);
  const value = BigInt(amountMicro.toString());

  // 1. Build Base UserOperation
  const userOp = await buildBaseUserOp({
    sender,
    to: target,
    value,
    data,
    nonce: options.nonce || 0n,
  });

  // 2. Request Paymaster Sponsorship
  const sponsorship = await requestPaymasterSponsorship(userOp, config);
  Object.assign(userOp, sponsorship);

  // 3. Sign UserOp Hash with Signer
  const userOpHash = getUserOpHash(userOp, config.entryPoint, config.chainId);
  const signature = await signer.signMessage(getBytes(userOpHash));
  userOp.signature = signature;

  // 4. Submit to Bundler
  const opHash = await submitUserOperation(userOp, config);

  // 5. Attempt to fetch receipt or return opHash
  let txHash = opHash;
  try {
    const receipt = await waitForUserOpReceipt(opHash, config, 10000, 1500);
    if (receipt && receipt.receipt && receipt.receipt.transactionHash) {
      txHash = receipt.receipt.transactionHash;
    } else if (receipt && receipt.transactionHash) {
      txHash = receipt.transactionHash;
    }
  } catch (receiptErr) {
    console.warn(`[paymaster] Receipt polling warning for UserOp ${opHash}:`, receiptErr.message);
  }

  return {
    success: true,
    txHash,
    userOpHash: opHash,
    sponsored: true,
    sponsor: "Arc Paymaster",
  };
}

module.exports = {
  getPaymasterConfig,
  isPaymasterActive,
  callJsonRpc,
  getUserOpHash,
  buildBaseUserOp,
  requestPaymasterSponsorship,
  submitUserOperation,
  waitForUserOpReceipt,
  executeSponsoredTransaction,
  DEFAULT_ENTRY_POINT,
  DEFAULT_CHAIN_ID,
};
