// src/wallet.js
// Wallet generation, AES-256-GCM encryption/decryption (scrypt KDF), Arc RPC helpers
// Arc testnet: native USDC at 18 decimals (confirmed from live chain behaviour)

const { Wallet, JsonRpcProvider, parseUnits, formatUnits } = require("ethers");
const crypto = require("crypto");

const ARC_RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
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
//
// Node's crypto.scryptSync() defaults to a 32MB maxmem cap. The actual
// memory scrypt needs scales as 128 * N * r * p bytes — with N=2^15, r=8,
// p=1, that's exactly 32MB (128 * 32768 * 8 * 1 = 33,554,432 bytes), right
// at the default ceiling. Depending on Node version/platform, that
// boundary case can throw "Invalid scrypt params: ... memory limit
// exceeded". We explicitly set maxmem with headroom so this never
// depends on hitting Node's default cap exactly. This does not change
// security: N/r/p (the actual KDF cost) are untouched, we're only telling
// Node it's allowed to use the memory the chosen N/r/p already require.
//
// Each wallet's key is encrypted independently with a fresh salt+IV per call.

const SCRYPT_N = 32768; // 2^15
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN  = 32;
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * SCRYPT_P * 2; // 2x headroom above the exact requirement

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
  // "micro" here means the raw 18-decimal bigint representation
  return parseUnits(amountStr.toString(), 18);
}

function formatMicro(microAmount) {
  return formatUnits(microAmount.toString(), 18);
}

// ─── Arc RPC: native USDC balance ────────────────────────────────────────────

async function getNativeBalanceMicro(address) {
  const provider = getProvider();
  const balance = await provider.getBalance(address);
  return balance; // BigInt
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
  sendFromWallet,
};