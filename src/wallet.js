// src/wallet.js
// Wallet generation, AES-256-GCM encryption/decryption (scrypt KDF), Arc RPC helpers
// Arc testnet: native USDC at 18 decimals (confirmed from live chain behaviour)
//
// FIX: Added getUsdcBalance() which reads ERC-20 balanceOf() for source chains
//      (Sepolia, Base Sepolia, Fuji) using 6 decimals — NOT provider.getBalance()
//      which only returns the native gas token (ETH/AVAX), not USDC.

const { Wallet, JsonRpcProvider, Contract, parseUnits, formatUnits } = require("ethers");
const crypto = require("crypto");

const ARC_RPC  = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const CHAIN_ID = 5042002;

let _provider = null;
function getProvider() {
  if (!_provider) _provider = new JsonRpcProvider(ARC_RPC, CHAIN_ID);
  return _provider;
}

// ─── Wallet generation ────────────────────────────────────────────────────────

function generateUserWallet() {
  const wallet = Wallet.createRandom();
  return { address: wallet.address, privateKey: wallet.privateKey };
}

function walletFromPrivateKey(privateKey) {
  return new Wallet(privateKey, getProvider());
}

function isValidAddress(address) {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

// ─── AES-256-GCM encryption (scrypt KDF) ─────────────────────────────────────
// scrypt params: N=2^15, r=8, p=1 — tuned for ~200ms on a modest server.

const SCRYPT_N = 32768; // 2^15
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN  = 32;
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * SCRYPT_P * 2; // 2x headroom

function deriveKey(pin, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  return crypto.scryptSync(pin, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

/**
 * Encrypt a private key with a 4-digit PIN.
 * Returns { encryptedKey, salt, iv, tag } — all hex strings, safe to store in DB.
 */
function encryptPrivateKey(privateKey, pin) {
  const salt = crypto.randomBytes(32).toString("hex");
  const iv   = crypto.randomBytes(12).toString("hex");
  const key  = deriveKey(pin, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  const encrypted = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encryptedKey: encrypted.toString("hex"),
    salt,
    iv,
    tag: tag.toString("hex"),
  };
}

/**
 * Decrypt a private key. Throws if PIN is wrong (GCM auth tag fails).
 */
function decryptPrivateKey(pin, { encryptedKey, salt, iv, tag }) {
  const key = deriveKey(pin, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedKey, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

// ─── Amount formatting ────────────────────────────────────────────────────────
// Arc testnet native USDC: 18 decimals (confirmed from live RPC, despite 6-decimal docs)

function parseToMicro(amountStr) {
  return parseUnits(amountStr.toString(), 18);
}

function formatMicro(microAmount) {
  return formatUnits(microAmount.toString(), 18);
}

// ─── Arc RPC: native USDC balance (18 decimals) ───────────────────────────────

async function getNativeBalanceMicro(address) {
  const provider = getProvider();
  const balance = await provider.getBalance(address);
  return balance; // BigInt — use formatMicro() to display
}

// ─── Source-chain ERC-20 USDC balance (6 decimals) ───────────────────────────
//
// FIX: The original code used provider.getBalance() which returns the native
// gas token (ETH on Sepolia, AVAX on Fuji) — NOT the USDC ERC-20 token.
// USDC on all source chains is an ERC-20 contract with 6 decimals. This
// function reads balanceOf() from the USDC contract directly.
//
// @param {string} walletAddress   - The user's wallet address
// @param {string} chainName       - e.g. "Ethereum Sepolia" (must be in SUPPORTED_CHAINS)
// @returns {string}               - Human-readable USDC amount, e.g. "25.000000"

const ERC20_BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
];

async function getUsdcBalance(walletAddress, chainName) {
  // Import lazily to avoid circular dependency (gateway imports wallet too)
  const { CHAIN_RPCS, USDC_ADDRESSES, SUPPORTED_CHAINS } = require("./gateway");

  const chain = SUPPORTED_CHAINS.find(c => c.name === chainName);
  if (!chain) throw new Error(`Unsupported chain: ${chainName}`);

  const rpcUrl      = CHAIN_RPCS[chainName];
  const usdcAddress = USDC_ADDRESSES[chainName];
  if (!rpcUrl || !usdcAddress) {
    throw new Error(`Missing RPC or USDC address config for: ${chainName}`);
  }

  const provider = new JsonRpcProvider(rpcUrl, chain.chainId);
  const usdc     = new Contract(usdcAddress, ERC20_BALANCE_ABI, provider);

  const raw = await usdc.balanceOf(walletAddress);
  // Source chains: USDC = 6 decimals (NOT 18 — that is only Arc's native USDC)
  return formatUnits(raw, 6);
}

function deriveSecretKey(secret) {
  const effectiveSecret = secret || process.env.INVOICE_FORWARDING_SECRET || "payit-invoice-fallback-secret";
  if (typeof effectiveSecret !== "string" || !effectiveSecret.trim()) {
    throw new Error("INVOICE_FORWARDING_SECRET is required for sensitive encryption/decryption.");
  }
  return crypto.createHash("sha256").update(effectiveSecret, "utf8").digest();
}

function encryptSensitiveValue(value, secret) {
  const key = deriveSecretKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptSensitiveValue(encryptedValue, secret) {
  const key = deriveSecretKey(secret);
  const parts = encryptedValue.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted value format.");
  }
  const [ivHex, tagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

// ─── Arc RPC: native USDC send ────────────────────────────────────────────────
// Native USDC on Arc: just send ETH-style (it IS the native token)

// ─── HD Wallet: Derive unique address per invoice (BIP44-ish) ─────────────────
// Each invoice gets a deterministic, unique address derived from the user's 
// master private key. All derived addresses remain under user control.
//
// Derivation: child_key = keccak256(master_key || invoice_index)
// This ensures: (1) each invoice has unique address, (2) all recoverable from master

function deriveInvoiceAddress(masterPrivateKey, invoiceIndex) {
  const { keccak256, toBeHex, Wallet: EthersWallet, getAddress } = require("ethers");
  
  // Ensure master key is hex-formatted
  const cleanMasterKey = masterPrivateKey.startsWith("0x") 
    ? masterPrivateKey 
    : "0x" + masterPrivateKey;
  
  // Convert invoice index to 32-byte hex
  const indexHex = toBeHex(invoiceIndex, 32);
  
  // Concatenate as hex strings and hash
  const combined = cleanMasterKey + indexHex.slice(2);
  const childSeed = keccak256(combined);
  
  // Create wallet from derived seed
  const childWallet = new EthersWallet(childSeed);
  
  return {
    address: getAddress(childWallet.address), // Checksum format
    derivationPath: `m/44'/60'/0'/0/${invoiceIndex}`,
    invoiceIndex: invoiceIndex,
    childPrivateKey: childWallet.privateKey
  };
}

/**
 * Validate invoice payment on-chain
 * Checks if payment to invoice address matches expected amount
 * 
 * @param {number} invoiceId - Invoice ID in database
 * @param {BigInt} expectedAmountMicro - Expected payment in Arc's 18-decimal USDC
 * @param {string} txHash - Transaction hash to verify
 * @param {string} paymentAddress - Invoice's unique payment address
 * @returns {Promise<boolean>} - true if payment is valid, false otherwise
 */
async function validateInvoicePayment(invoiceId, expectedAmountMicro, txHash, paymentAddress, provider = getProvider()) {
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    
    if (!receipt) return false; // TX not yet mined
    
    // Check: recipient matches + amount matches (within 1% tolerance for rounding)
    const recipientMatches = receipt.to && 
      receipt.to.toLowerCase() === paymentAddress.toLowerCase();

    let actualAmount = receipt.value;
    if (actualAmount == null && provider.getTransaction) {
      const tx = await provider.getTransaction(txHash);
      actualAmount = tx?.value ?? null;
    }

    if (actualAmount == null) return false;

    const tolerance = expectedAmountMicro / BigInt(100); // 1% tolerance
    const amountMatches = actualAmount >= (expectedAmountMicro - tolerance) && 
                         actualAmount <= (expectedAmountMicro + tolerance);
    
    return recipientMatches && amountMatches;
  } catch (err) {
    console.error(`[wallet] validateInvoicePayment error for INV_${invoiceId}:`, err.message);
    return false;
  }
}

async function sendFromWallet(signer, toAddress, amountMicro) {
  const tx = await signer.sendTransaction({
    to: toAddress,
    value: amountMicro,
  });
  const receipt = await tx.wait();
  return receipt.hash;
}

module.exports = {
  generateUserWallet,
  walletFromPrivateKey,
  isValidAddress,
  encryptPrivateKey,
  decryptPrivateKey,
  encryptSensitiveValue,
  decryptSensitiveValue,
  parseToMicro,
  formatMicro,
  getNativeBalanceMicro,
  getUsdcBalance,           // FIX: new export — use this for source-chain balances
  deriveInvoiceAddress,     // NEW: HD wallet invoice address derivation
  validateInvoicePayment,   // NEW: validate payment against invoice
  sendFromWallet,
};