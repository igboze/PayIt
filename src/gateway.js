// src/gateway.js
// Circle Gateway — cross-chain USDC inflow to Arc Testnet
//
// HOW IT ACTUALLY WORKS (not a single deposit address):
//   1. User approves the Gateway Wallet contract to spend their USDC on source chain
//   2. User calls deposit() on the Gateway Wallet contract — NOT a plain transfer
//   3. After source chain finality, user signs a burn intent (EIP-712)
//   4. Bot submits intent to Gateway API → gets attestation
//   5. Bot calls gatewayMint() on Arc with the attestation → USDC appears on Arc
//
// ⚠️  Plain ERC-20 transfers to the Gateway Wallet contract = permanent loss of funds
//
// FIX 1: Added executeDeposit() which actually runs the approve + deposit() on-chain.
// FIX 2: CHAIN_RPCS is now exported so wallet.js and other modules can use it.
// FIX 3: Source-chain USDC decimals are correctly 6 (not 18).
//
// Testnet API: https://gateway-api-testnet.circle.com/v1
// Docs: https://developers.circle.com/gateway

const axios = require("axios");
const {
  Contract, Wallet, JsonRpcProvider,
  parseUnits, formatUnits, ZeroAddress,
  MaxUint256, randomBytes, zeroPadValue, getAddress,
} = require("ethers");

const GATEWAY_API_BASE = process.env.GATEWAY_API_URL || "https://gateway-api-testnet.circle.com/v1";

// ── Confirmed contract addresses (same on all supported chains) ────────────────
const GATEWAY_WALLET_ADDRESS  = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const GATEWAY_MINTER_ADDRESS  = "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B";
const ARC_USDC_ADDRESS        = "0x3600000000000000000000000000000000000000";
const ARC_DOMAIN_ID           = 26; // confirmed via GET /v1/info (ARC Testnet)
const MAX_TRANSFER_FEE        = parseUnits("2.01", 6);

// ── USDC contract addresses per testnet chain ──────────────────────────────────
const USDC_ADDRESSES = {
  "Ethereum Sepolia": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  "Base Sepolia":     "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "Avalanche Fuji":   "0x5425890298aed601595a70ab815c96711a31bc65",
};

// ── CCTP domain IDs ────────────────────────────────────────────────────────────
const DOMAIN_IDS = {
  "Ethereum Sepolia": 0,
  "Avalanche Fuji":   1,
  "Base Sepolia":     6,
  "Arc Testnet":      ARC_DOMAIN_ID,
};

const EIP712_DOMAIN = { name: "GatewayWallet", version: "1" };

const BURN_INTENT_TYPES = {
  TransferSpec: [
    { name: "version",             type: "uint32"   },
    { name: "sourceDomain",        type: "uint32"   },
    { name: "destinationDomain",   type: "uint32"   },
    { name: "sourceContract",      type: "bytes32"  },
    { name: "destinationContract", type: "bytes32"  },
    { name: "sourceToken",         type: "bytes32"  },
    { name: "destinationToken",    type: "bytes32"  },
    { name: "sourceDepositor",     type: "bytes32"  },
    { name: "destinationRecipient",type: "bytes32"  },
    { name: "sourceSigner",        type: "bytes32"  },
    { name: "destinationCaller",   type: "bytes32"  },
    { name: "value",               type: "uint256"  },
    { name: "salt",                type: "bytes32"  },
    { name: "hookData",            type: "bytes"    },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee",         type: "uint256" },
    { name: "spec",           type: "TransferSpec" },
  ],
};

function toBytes32(address) {
  return zeroPadValue(getAddress(address), 32);
}

/** JSON.stringify replacer — axios cannot serialize BigInt from ethers. */
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v
  ));
}

function friendlyGatewayError(err, chainName) {
  const msg = err?.shortMessage || err?.message || String(err);
  if (/404 Not Found/i.test(msg) && /rpc/i.test(msg)) {
    return `Cannot reach ${chainName} RPC. Try again in a moment or contact support.`;
  }
  if (/INSUFFICIENT_FUNDS|insufficient funds/i.test(msg)) {
    const chain = SUPPORTED_CHAINS.find(c => c.name === chainName);
    return `Not enough gas on ${chainName}. Get testnet ${chain?.symbol || "native token"} from a faucet — you need it to pay transaction fees (separate from USDC).`;
  }
  if (/insufficient funds|exceeds balance|transfer amount exceeds/i.test(msg) && /USDC/i.test(msg) === false) {
    const chain = SUPPORTED_CHAINS.find(c => c.name === chainName);
    return `Not enough USDC on ${chainName}. Request USDC from faucet.circle.com for your PayIT address, then try again.`;
  }
  return msg;
}

// ── RPC endpoints for each source chain ───────────────────────────────────────
// Public fallbacks; override via env if needed (e.g. SEPOLIA_RPC_URL).
const CHAIN_RPCS = {
  "Ethereum Sepolia": process.env.SEPOLIA_RPC_URL     || "https://ethereum-sepolia-rpc.publicnode.com",
  "Base Sepolia":     process.env.BASE_SEPOLIA_RPC_URL || "https://base-sepolia-rpc.publicnode.com",
  "Avalanche Fuji":   process.env.FUJI_RPC_URL         || "https://api.avax-test.network/ext/bc/C/rpc",
};

const SUPPORTED_CHAINS = [
  { name: "Ethereum Sepolia", chainId: 11155111, symbol: "ETH",  domain: 0, explorer: "https://sepolia.etherscan.io/tx/" },
  { name: "Base Sepolia",     chainId: 84532,    symbol: "BASE", domain: 6, explorer: "https://sepolia.basescan.org/tx/" },
  { name: "Avalanche Fuji",   chainId: 43113,    symbol: "AVAX", domain: 1, explorer: "https://testnet.snowtrace.io/tx/" },
];

// ── ABIs (minimal) ─────────────────────────────────────────────────────────────
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
];

const GATEWAY_WALLET_ABI = [
  // Must use this — plain transfer() loses funds permanently
  "function deposit(address token, uint256 amount) external",
  "function balanceOf(address owner, uint32 domain) view returns (uint256)",
];

const GATEWAY_MINTER_ABI = [
  "function gatewayMint(bytes calldata attestation, bytes calldata signature) external",
];

// ── Gateway API helpers ────────────────────────────────────────────────────────

async function getGatewayInfo() {
  try {
    const res = await axios.get(`${GATEWAY_API_BASE}/info`);
    return res.data;
  } catch (err) {
    console.error("[gateway] getGatewayInfo error:", err.message);
    return null;
  }
}

/**
 * Check user's available Gateway balance on a domain (post-finality deposits).
 * domainId: 0=Sepolia, 1=Fuji, 6=Base Sepolia
 */
async function getGatewayBalance(depositorAddress, domainId) {
  try {
    const res = await axios.get(`${GATEWAY_API_BASE}/balances`, {
      params: { depositor: depositorAddress, domains: domainId },
    });
    return res.data;
  } catch (err) {
    console.error("[gateway] getGatewayBalance error:", err.message);
    return null;
  }
}

/**
 * Check pending deposits (submitted but not yet finalized on source chain).
 */
async function getPendingDeposits(depositorAddress) {
  try {
    const res = await axios.get(`${GATEWAY_API_BASE}/deposits`, {
      params: { depositor: depositorAddress },
    });
    return res.data;
  } catch (err) {
    console.error("[gateway] getPendingDeposits error:", err.message);
    return null;
  }
}

/**
 * Submit burn intent to Gateway API → returns attestation for minting on Arc.
 * burnIntentRequest: { burnIntent, signature } constructed and signed by user wallet.
 */
async function submitTransfer(burnIntentRequests) {
  try {
    const res = await axios.post(`${GATEWAY_API_BASE}/transfer`, burnIntentRequests, {
      headers: { "Content-Type": "application/json" },
    });
    return res.data;
  } catch (err) {
    console.error("[gateway] submitTransfer error:", err?.response?.data || err.message);
    return null;
  }
}

// ── Main bot-facing helpers ────────────────────────────────────────────────────

/**
 * Returns structured deposit instructions for the bot's Gateway screen.
 * The user must call deposit() on the Gateway Wallet contract — NOT a plain send.
 */
async function getDepositInfo(arcAddress) {
  const info = await getGatewayInfo();
  const apiOnline = !!info;

  return {
    apiOnline,
    arcAddress,
    gatewayWalletAddress: GATEWAY_WALLET_ADDRESS,
    gatewayMinterAddress: GATEWAY_MINTER_ADDRESS,
    chains: SUPPORTED_CHAINS,
    usdcAddresses: USDC_ADDRESSES,
    steps: [
      `*Step 1 — Get testnet USDC*\nVisit https://faucet.circle.com, select your chain and request USDC.`,
      `*Step 2 — Approve*\nIn your web3 wallet (MetaMask etc), approve the Gateway Wallet contract to spend your USDC:\nContract: \`${GATEWAY_WALLET_ADDRESS}\``,
      `*Step 3 — Deposit (NOT a plain send)*\nCall \`deposit(usdcAddress, amount)\` on the Gateway Wallet contract.\n⚠️ A plain USDC transfer to this address permanently loses your funds.`,
      `*Step 4 — Wait for finality*\nSepolia: ~12 mins · Base Sepolia: ~2 mins · Avalanche Fuji: instant`,
      `*Step 5 — Transfer to Arc*\nOnce finalized, tap *Transfer to Arc* and sign the burn intent. Your USDC will appear on Arc in <500ms.`,
    ],
  };
}

/**
 * FIX 1: Actually execute the approve + deposit on-chain for a given source chain.
 *
 * This function does what the docs describe — it's what the bot must call when
 * the user initiates a cross-chain deposit from within PayIT (i.e. the user has
 * their private key stored in the bot's DB and triggers "Add from Abroad").
 *
 * NOTE: Source-chain USDC is always 6 decimals — NOT 18 like Arc's native USDC.
 *
 * @param {string} privateKey       - User's private key (decrypted from DB)
 * @param {string} sourceChainName  - e.g. "Ethereum Sepolia"
 * @param {string|number} amountUsdc - Human-readable USDC amount, e.g. "25.00"
 * @returns {{ approveTxHash: string, depositTxHash: string }}
 */
async function getSourceChainNativeBalance(walletAddress, sourceChainName) {
  const chain = SUPPORTED_CHAINS.find(c => c.name === sourceChainName);
  if (!chain) throw new Error(`Unsupported chain: ${sourceChainName}`);
  const provider = new JsonRpcProvider(CHAIN_RPCS[sourceChainName], chain.chainId);
  const raw = await provider.getBalance(walletAddress);
  return formatUnits(raw, 18);
}

/**
 * Build and EIP-712-sign a burn intent to move Gateway USDC to Arc.
 */
async function buildSignedBurnIntent(signer, sourceChainName, amountUsdc, recipientAddress) {
  const chain = SUPPORTED_CHAINS.find(c => c.name === sourceChainName);
  if (!chain) throw new Error(`Unsupported chain: ${sourceChainName}`);

  const usdcAddress = USDC_ADDRESSES[sourceChainName];
  const depositor     = getAddress(await signer.getAddress());
  const recipient     = getAddress(recipientAddress);
  const value         = parseUnits(amountUsdc.toString(), 6);
  const salt          = "0x" + Buffer.from(randomBytes(32)).toString("hex");

  const burnIntent = {
    maxBlockHeight: MaxUint256,
    maxFee:         MAX_TRANSFER_FEE,
    spec: {
      version:              1,
      sourceDomain:         chain.domain,
      destinationDomain:    ARC_DOMAIN_ID,
      sourceContract:       toBytes32(GATEWAY_WALLET_ADDRESS),
      destinationContract:  toBytes32(GATEWAY_MINTER_ADDRESS),
      sourceToken:          toBytes32(usdcAddress),
      destinationToken:     toBytes32(ARC_USDC_ADDRESS),
      sourceDepositor:      toBytes32(depositor),
      destinationRecipient: toBytes32(recipient),
      sourceSigner:         toBytes32(depositor),
      destinationCaller:    toBytes32(ZeroAddress),
      value,
      salt,
      hookData: "0x",
    },
  };

  const signature = await signer.signTypedData(EIP712_DOMAIN, BURN_INTENT_TYPES, burnIntent);
  return { burnIntent, signature };
}

/**
 * Transfer Gateway USDC from a source chain to Arc (burn + mint via Circle API).
 * Uses enableForwarder so Circle submits the Arc mint automatically.
 */
async function transferToArc(privateKey, sourceChainName, amountUsdc, recipientAddress) {
  try {
    const signer = new Wallet(privateKey);
    const { burnIntent, signature } = await buildSignedBurnIntent(
      signer, sourceChainName, amountUsdc, recipientAddress
    );

    const res = await axios.post(
      `${GATEWAY_API_BASE}/transfer?enableForwarder=true`,
      jsonSafe([{ burnIntent, signature }]),
      { headers: { "Content-Type": "application/json" } }
    );
    return res.data;
  } catch (err) {
    const apiMsg = err?.response?.data?.message || err?.response?.data?.error;
    if (apiMsg) throw new Error(typeof apiMsg === "string" ? apiMsg : JSON.stringify(apiMsg));
    throw err;
  }
}

/**
 * Summarise per-chain USDC + gas balances for the bot UI.
 */
async function getSourceChainBalances(walletAddress) {
  const walletLib = require("./wallet");
  const rows = [];
  for (const chain of SUPPORTED_CHAINS) {
    try {
      const [usdc, gas] = await Promise.all([
        walletLib.getUsdcBalance(walletAddress, chain.name),
        getSourceChainNativeBalance(walletAddress, chain.name),
      ]);
      rows.push({ chain: chain.name, symbol: chain.symbol, usdc, gas });
    } catch (err) {
      rows.push({ chain: chain.name, symbol: chain.symbol, usdc: "?", gas: "?", error: err.message });
    }
  }
  return rows;
}

async function executeDeposit(privateKey, sourceChainName, amountUsdc) {
  const chain = SUPPORTED_CHAINS.find(c => c.name === sourceChainName);
  if (!chain) throw new Error(`Unsupported chain: ${sourceChainName}`);

  const rpcUrl      = CHAIN_RPCS[sourceChainName];
  const usdcAddress = USDC_ADDRESSES[sourceChainName];
  if (!rpcUrl || !usdcAddress) {
    throw new Error(`Missing RPC or USDC address config for: ${sourceChainName}`);
  }

  const provider = new JsonRpcProvider(rpcUrl, chain.chainId);
  const signer   = new Wallet(privateKey, provider);
  const address  = await signer.getAddress();

  const amountBN = parseUnits(amountUsdc.toString(), 6);

  const usdc    = new Contract(usdcAddress, ERC20_ABI, signer);
  const gateway = new Contract(GATEWAY_WALLET_ADDRESS, GATEWAY_WALLET_ABI, signer);

  // Pre-flight: USDC + gas before sending any transactions
  const [usdcBal, gasBal] = await Promise.all([
    usdc.balanceOf(address),
    provider.getBalance(address),
  ]);
  if (usdcBal < amountBN) {
    throw new Error(
      `Not enough USDC on ${sourceChainName}. You have ${formatUnits(usdcBal, 6)} USDC but need ${amountUsdc}. ` +
      `Get USDC from faucet.circle.com for your PayIT address.`
    );
  }
  if (gasBal === 0n) {
    throw new Error(
      `No gas on ${sourceChainName}. Get testnet ${chain.symbol} from a faucet first — ` +
      `you need it to pay transaction fees (this is separate from USDC).`
    );
  }

  try {
    // Step 1: Approve Gateway Wallet to spend user's USDC
    console.log(`[gateway] Approving ${amountUsdc} USDC on ${sourceChainName}...`);
    const approveTx = await usdc.approve(GATEWAY_WALLET_ADDRESS, amountBN);
    const approveReceipt = await approveTx.wait();
    console.log(`[gateway] Approve confirmed: ${approveReceipt.hash}`);

    // Step 2: Call deposit() — NOT a plain transfer
    console.log(`[gateway] Depositing ${amountUsdc} USDC via Gateway Wallet contract...`);
    const depositTx = await gateway.deposit(usdcAddress, amountBN);
    const depositReceipt = await depositTx.wait();
    console.log(`[gateway] Deposit confirmed: ${depositReceipt.hash}`);

    return {
      approveTxHash: approveReceipt.hash,
      depositTxHash: depositReceipt.hash,
    };
  } catch (err) {
    throw new Error(friendlyGatewayError(err, sourceChainName));
  }
}

/**
 * Check all gateway balances for a user address across supported chains.
 * Returns a summary of available + pending balances.
 */
async function getTransferStatus(depositorAddress) {
  const results = {};
  for (const chain of SUPPORTED_CHAINS) {
    const available = await getGatewayBalance(depositorAddress, chain.domain);
    if (available) results[chain.name] = { available };
  }
  const pending = await getPendingDeposits(depositorAddress);
  if (pending) results.pending = pending;
  return Object.keys(results).length ? results : null;
}

module.exports = {
  getDepositInfo,
  getTransferStatus,
  executeDeposit,
  transferToArc,
  buildSignedBurnIntent,
  getSourceChainBalances,
  getSourceChainNativeBalance,
  getGatewayInfo,
  getGatewayBalance,
  getPendingDeposits,
  submitTransfer,
  SUPPORTED_CHAINS,
  CHAIN_RPCS,
  GATEWAY_WALLET_ADDRESS,
  GATEWAY_MINTER_ADDRESS,
  ARC_USDC_ADDRESS,
  ARC_DOMAIN_ID,
  USDC_ADDRESSES,
  DOMAIN_IDS,
  GATEWAY_WALLET_ABI,
  GATEWAY_MINTER_ABI,
  ERC20_ABI,
};