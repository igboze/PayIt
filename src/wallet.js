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

// ─── Arc RPC: native USDC send ────────────────────────────────────────────────
// Native USDC on Arc: just send ETH-style (it IS the native token)

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
  parseToMicro,
  formatMicro,
  getNativeBalanceMicro,
  getUsdcBalance,           // FIX: new export — use this for source-chain balances
  sendFromWallet,
};