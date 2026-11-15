// src/near_intents.js
// NEAR Intents (1Click API) — cross-chain send & receive in any supported token.
//
// HOW IT WORKS:
//   1. We ask 1Click for a quote: "swap X of originAsset into destinationAsset,
//      deliver to recipient". A non-dry quote returns a one-time depositAddress.
//   2. Someone sends originAsset to that depositAddress on the origin chain.
//   3. We tell 1Click the deposit tx hash (speeds things up), then poll status.
//   4. Solvers fill the swap and deliver destinationAsset to the recipient.
//
// PayIT's side of every swap is USDC on the SETTLEMENT chain (Base by default).
// The user's PayIT key is a normal EVM key, so the same address holds USDC there.
// ⚠️  Arc testnet is NOT a NEAR Intents chain — settlement runs on mainnet.
//
// Docs: https://docs.near-intents.org/near-intents/integration/distribution-channels/1click-api

const axios = require("axios");
const { Contract, JsonRpcProvider, Wallet, parseUnits, formatUnits } = require("ethers");

const API_BASE         = process.env.NEAR_INTENTS_API_URL || "https://1click.chaindefuser.com";
const API_JWT          = process.env.NEAR_INTENTS_JWT || "";
const SETTLEMENT_CHAIN = process.env.NEAR_INTENTS_SETTLEMENT_CHAIN || "base";
const SETTLEMENT_RPC   = process.env.NEAR_INTENTS_SETTLEMENT_RPC_URL || "https://mainnet.base.org";
const SLIPPAGE_BPS     = Number(process.env.NEAR_INTENTS_SLIPPAGE_BPS || 100); // 1%
const QUOTE_TTL_MS     = 30 * 60 * 1000;

/** Live sends/receives move real mainnet funds — off unless explicitly enabled. */
function isEnabled() {
  return process.env.NEAR_INTENTS_ENABLED === "true";
}

// ── Chains ────────────────────────────────────────────────────────────────────

const CHAIN_LABELS = {
  eth: "Ethereum", base: "Base", arb: "Arbitrum", op: "Optimism", pol: "Polygon",
  bsc: "BNB Chain", avax: "Avalanche", gnosis: "Gnosis", sol: "Solana", near: "NEAR",
  btc: "Bitcoin", tron: "Tron", ton: "TON", sui: "Sui", xrp: "XRP Ledger",
  doge: "Dogecoin", ltc: "Litecoin", bch: "Bitcoin Cash", stellar: "Stellar",
  aptos: "Aptos", cardano: "Cardano", zec: "Zcash", starknet: "Starknet",
  bera: "Berachain", monad: "Monad", xlayer: "X Layer", plasma: "Plasma",
  scroll: "Scroll", abs: "Abstract", hood: "Robinhood Chain",
};

// Shown first in pickers — the chains Nigerian users actually hold funds on.
const POPULAR_CHAINS = ["bsc", "tron", "sol", "eth", "base", "arb", "pol", "near", "btc", "ton", "op", "avax"];

const EVM_CHAINS = new Set([
  "eth", "base", "arb", "op", "pol", "bsc", "avax", "gnosis", "bera", "monad",
  "xlayer", "plasma", "scroll", "abs", "hood", "adi",
]);

function chainLabel(chain) {
  return CHAIN_LABELS[chain] || chain.toUpperCase();
}

function isEvmChain(chain) {
  return EVM_CHAINS.has(chain);
}

// ── Token list (cached) ───────────────────────────────────────────────────────

const TOKEN_CACHE_TTL = 10 * 60 * 1000;
let _tokens    = null;
let _tokensAt  = 0;

function authHeaders() {
  return API_JWT ? { Authorization: `Bearer ${API_JWT}` } : {};
}

function apiError(err) {
  const msg = err?.response?.data?.message || err?.message || String(err);
  return new Error(Array.isArray(msg) ? msg.join("; ") : msg);
}

async function getTokens() {
  if (_tokens && Date.now() - _tokensAt < TOKEN_CACHE_TTL) return _tokens;
  try {
    const res = await axios.get(`${API_BASE}/v0/tokens`, { headers: authHeaders(), timeout: 10000 });
    _tokens   = (res.data || []).filter(t => !/DEPRECATED/i.test(t.symbol));
    _tokensAt = Date.now();
    return _tokens;
  } catch (err) {
    if (_tokens) return _tokens; // stale beats nothing
    throw apiError(err);
  }
}

/** Unique chains, popular first then alphabetical. */
async function getChains() {
  const tokens = await getTokens();
  const chains = [...new Set(tokens.map(t => t.blockchain))];
  return chains.sort((a, b) => {
    const pa = POPULAR_CHAINS.indexOf(a), pb = POPULAR_CHAINS.indexOf(b);
    if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    return chainLabel(a).localeCompare(chainLabel(b));
  });
}

async function getChainTokens(chain) {
  return (await getTokens()).filter(t => t.blockchain === chain);
}

async function findToken(chain, symbol) {
  const want = String(symbol).trim().toUpperCase().replace(/^\$/, "");
  const list = await getChainTokens(chain);
  return list.find(t => t.symbol.toUpperCase() === want)
      || list.find(t => t.symbol.toUpperCase().replace(/^\$/, "") === want)
      || null;
}

/** The chain's gas token. 1Click lists natives without a contractAddress. */
async function getNativeToken(chain) {
  const list = await getChainTokens(chain);
  return list.find(t => !t.contractAddress)
      || (chain === "near" ? list.find(t => t.symbol === "wNEAR") : null)
      || null;
}

async function getUsdcToken(chain) {
  return findToken(chain, "USDC");
}

/** USDC on the settlement chain — PayIT's side of every swap. */
async function getSettlementToken() {
  const token = await getUsdcToken(SETTLEMENT_CHAIN);
  if (!token) throw new Error(`USDC on ${chainLabel(SETTLEMENT_CHAIN)} isn't available on NEAR Intents.`);
  return token;
}

// ── Addresses ─────────────────────────────────────────────────────────────────

const ADDRESS_PATTERNS = {
  sol:   /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  btc:   /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  tron:  /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  near:  /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$|^[0-9a-f]{64}$/,
  doge:  /^D[1-9A-HJ-NP-Za-km-z]{25,34}$/,
  ltc:   /^(ltc1[02-9ac-hj-np-z]{11,71}|[LM3][1-9A-HJ-NP-Za-km-z]{26,33})$/,
  xrp:   /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
  stellar: /^G[A-Z2-7]{55}$/,
};

/**
 * Cheap local sanity check so typos fail fast. The quote request is the real
 * validator — 1Click rejects recipients that aren't valid for the chain.
 */
function isValidRecipient(chain, address) {
  const a = String(address || "").trim();
  if (!a || /\s/.test(a)) return false;
  if (isEvmChain(chain)) return /^0x[0-9a-fA-F]{40}$/.test(a);
  if (ADDRESS_PATTERNS[chain]) return ADDRESS_PATTERNS[chain].test(a) && a.length >= 2 && a.length <= 100;
  return a.length >= 20 && a.length <= 120;
}

// ── Amounts ───────────────────────────────────────────────────────────────────

function toUnits(amount, decimals) {
  return parseUnits(Number(amount).toFixed(Math.min(decimals, 18)), decimals).toString();
}

function fromUnits(units, decimals) {
  return parseFloat(formatUnits(BigInt(units), decimals));
}

// ── Quotes / status ───────────────────────────────────────────────────────────

/**
 * Request a 1Click quote.
 * @param {object} p
 * @param {boolean} p.dry               true = price only, no deposit address
 * @param {"EXACT_INPUT"|"EXACT_OUTPUT"} p.swapType
 * @param {string} p.originAsset        assetId
 * @param {string} p.destinationAsset   assetId
 * @param {string} p.amount             smallest units of origin (EXACT_INPUT) or destination (EXACT_OUTPUT)
 * @param {string} p.recipient          address on destination chain
 * @param {string} p.refundTo           address on origin chain
 */
async function getQuote({ dry, swapType = "EXACT_INPUT", originAsset, destinationAsset, amount, recipient, refundTo }) {
  const body = {
    dry,
    swapType,
    slippageTolerance: SLIPPAGE_BPS,
    originAsset,
    depositType:       "ORIGIN_CHAIN",
    destinationAsset,
    amount:            String(amount),
    refundTo,
    refundType:        "ORIGIN_CHAIN",
    recipient,
    recipientType:     "DESTINATION_CHAIN",
    deadline:          new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    quoteWaitingTimeMs: 3000,
  };
  if (process.env.NEAR_INTENTS_REFERRAL) body.referral = process.env.NEAR_INTENTS_REFERRAL;
  try {
    const res = await axios.post(`${API_BASE}/v0/quote`, body, {
      headers: { "Content-Type": "application/json", ...authHeaders() },
      timeout: 20000,
    });
    if (!res.data?.quote) throw new Error("No quote returned — try a different amount or token.");
    return res.data.quote;
  } catch (err) {
    throw apiError(err);
  }
}

/** Tell 1Click about our deposit tx so it doesn't wait to discover it. */
async function submitDeposit(txHash, depositAddress) {
  try {
    await axios.post(`${API_BASE}/v0/deposit/submit`, { txHash, depositAddress }, {
      headers: { "Content-Type": "application/json", ...authHeaders() },
      timeout: 10000,
    });
  } catch (err) {
    // Non-fatal: 1Click still detects the deposit on its own.
    console.warn("[near_intents] deposit submit failed:", apiError(err).message);
  }
}

async function getStatus(depositAddress) {
  try {
    const res = await axios.get(`${API_BASE}/v0/status`, {
      params: { depositAddress },
      headers: authHeaders(),
      timeout: 10000,
    });
    return res.data;
  } catch (err) {
    throw apiError(err);
  }
}

const TERMINAL_STATUSES = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

/**
 * Poll a swap until it finishes, then call onDone(statusResponse).
 * In-memory only — a restart stops the watch (the swap itself still completes).
 */
function watchSwap(depositAddress, onDone, { intervalMs = 15000, timeoutMs = 60 * 60 * 1000 } = {}) {
  const startedAt = Date.now();
  const tick = async () => {
    try {
      const status = await getStatus(depositAddress);
      if (TERMINAL_STATUSES.has(status?.status)) return onDone(status);
    } catch (err) {
      console.warn("[near_intents] status poll:", err.message);
    }
    if (Date.now() - startedAt > timeoutMs) return onDone({ status: "TIMEOUT" });
    setTimeout(tick, intervalMs);
  };
  setTimeout(tick, intervalMs);
}

// ── Settlement chain (USDC on Base by default) ────────────────────────────────

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

let _settlementProvider = null;
function getSettlementProvider() {
  if (!_settlementProvider) _settlementProvider = new JsonRpcProvider(SETTLEMENT_RPC);
  return _settlementProvider;
}

/** USDC balance (as a number) of an address on the settlement chain. */
async function getSettlementUsdcBalance(address) {
  const token = await getSettlementToken();
  const usdc  = new Contract(token.contractAddress, ERC20_ABI, getSettlementProvider());
  return fromUnits(await usdc.balanceOf(address), token.decimals);
}

/**
 * Send settlement-chain USDC from the user's key to a 1Click deposit address.
 * Needs a little native gas on the settlement chain (ETH on Base).
 */
async function sendSettlementUsdc(privateKey, depositAddress, amountUnits) {
  const token  = await getSettlementToken();
  const signer = new Wallet(privateKey, getSettlementProvider());
  const gas    = await getSettlementProvider().getBalance(signer.address);
  if (gas === 0n) {
    throw new Error(`You need a little ${chainLabel(SETTLEMENT_CHAIN)} gas (ETH) at ${signer.address} to send.`);
  }
  const usdc    = new Contract(token.contractAddress, ERC20_ABI, signer);
  const tx      = await usdc.transfer(depositAddress, BigInt(amountUnits));
  const receipt = await tx.wait();
  return receipt.hash;
}

module.exports = {
  SETTLEMENT_CHAIN,
  isEnabled,
  chainLabel,
  isEvmChain,
  getTokens,
  getChains,
  getChainTokens,
  findToken,
  getNativeToken,
  getUsdcToken,
  getSettlementToken,
  isValidRecipient,
  toUnits,
  fromUnits,
  getQuote,
  submitDeposit,
  getStatus,
  watchSwap,
  getSettlementUsdcBalance,
  sendSettlementUsdc,
};
