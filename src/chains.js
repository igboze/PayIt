// src/chains.js
// Chain registry + adapters + unified balance read path (Phase 4).
//
// One access point for "what chains exist, what are their configs, what are
// the user's addresses and balances on each".  This module COMPOSES the
// existing single sources of truth (network.js, cctp_bridge contract tables,
// paj.RAILS, multichain) — it does not duplicate their literals.

const db = require("./db");
const network = require("./network");
const paj = require("./paj");
const multichain = require("./multichain");
const walletLib = require("./wallet");
const tokens = require("./tokens");
const solAddr = require("./solana_address");
const cctpBridge = require("./cctp_bridge");

function _env(key, fallback = null) {
  const v = (process.env[key] || "").trim();
  return v || fallback;
}

/**
 * Registry snapshot.  Keys are the product-level chain identifiers used in
 * conversation states, transaction rows and UI labels (lowercase).
 */
function getChains() {
  const arcNet = network.getNetworkConfig();
  const evmCctp = cctpBridge.EVM_CCTP_CONTRACTS || {};
  const baseCfg = evmCctp.BASE || null;

  return {
    arc: {
      key: "arc",
      label: "Arc",
      family: "evm",
      chainId: arcNet.chainId,
      rpcUrl: arcNet.rpcUrl,
      explorerUrl: arcNet.explorerUrl,
      usdc: { address: arcNet.usdcAddress, decimals: 6 },
      eurc: { address: arcNet.eurcAddress, decimals: 6 },
      cctp: {
        ...(cctpBridge.ARC_CCTP_CONTRACTS || {}),
        domain: cctpBridge.CCTP_DOMAINS.ARC,
      },
      pajRail: paj.RAILS.arc || null,
      enabled: true,
    },
    solana: {
      key: "solana",
      label: "Solana",
      family: "solana",
      rpcUrl: _env("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
      usdc: { mint: multichain.SOLANA_USDC_MINT, decimals: 6 },
      cctp: { domain: cctpBridge.CCTP_DOMAINS.SOLANA },
      pajRail: paj.RAILS.solana || null,
      enabled: true,
    },
    base: {
      key: "base",
      label: "Base",
      family: "evm",
      chainId: baseCfg ? baseCfg.chainId : 8453,
      rpcUrl: baseCfg ? baseCfg.rpcUrl : _env("BASE_RPC_URL", "https://mainnet.base.org"),
      usdc: baseCfg
        ? { address: baseCfg.usdc, decimals: baseCfg.decimals || 6 }
        : { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
      cctp: baseCfg
        ? { tokenMessenger: baseCfg.tokenMessenger, messageTransmitter: baseCfg.messageTransmitter, domain: baseCfg.domain }
        : null,
      pajRail: null,
      enabled: Boolean(baseCfg),
    },
    near: {
      key: "near",
      label: "NEAR",
      family: "near",
      // No native custodial balance: deposits arrive via 1Click intents and are
      // swept to Arc by the EVM sweeper.  "Balance" here = pending deposits.
      usdc: null,
      pajRail: null,
      enabled: Boolean(_env("NEAR_INTENTS_API_KEY")),
    },
  };
}

function listChains() {
  return Object.values(getChains());
}

function getChain(key) {
  return getChains()[String(key || "").toLowerCase()] || null;
}

/**
 * Chains that can currently fund a paj cash-out (both product chains).
 */
function getPajRailChains() {
  return listChains().filter((c) => c.pajRail);
}

// ─── Address derivation ───────────────────────────────────────────────────────

/**
 * The user's address on a chain, for the given account context.
 *  - arc: deposit_address (personal) / business_deposit_address (business)
 *  - solana: derived-from-EVM-key address (repairs the stored column on drift,
 *    same as the bot's getOrDeriveSolanaAddress)
 *  - near: derived implicit account from the system key (refund address);
 *    returns null when the system key is unavailable
 */
function deriveAddress(user, accountType, chainKey) {
  if (!user) return null;
  const isBiz = accountType === "business";
  const chain = getChain(chainKey);
  if (!chain) return null;

  if (chain.family === "evm" && chainKey === "arc") {
    return (isBiz ? user.business_deposit_address : null) || user.deposit_address || null;
  }
  if (chain.family === "solana") {
    try {
      const derived = solAddr.resolveSolanaRecipient(user, { isBiz });
      if (derived) return derived;
    } catch (err) {
      console.warn("[chains] solana address resolution note:", err.message);
    }
    return (isBiz ? user.biz_solana_deposit_address : user.solana_deposit_address) || null;
  }
  if (chain.family === "near") {
    try {
      const nearLib = require("./near");
      const sysKey = db.getSystemDecryptedPrivateKey(user);
      return nearLib.deriveNearAddress(sysKey).nearAddress;
    } catch (err) {
      console.warn("[chains] near address derivation note:", err.message);
      return null;
    }
  }
  return null;
}

// ─── Unified balance ──────────────────────────────────────────────────────────

function _round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Single read path for "how much money does this user have, and where".
 * Used by balance display, cash-out rail selection and Move Funds.
 *
 * @returns {Promise<{
 *   accountType: string,
 *   arcAddress: string|null,
 *   solanaAddresses: string[],
 *   arc: { usdc: number, eurc: number },
 *   solana: { usdc: number },
 *   pendingNear: number,
 *   byChain: { arc: number, solana: number },
 *   total: number,
 * }>}
 */
async function getUnifiedBalance(user, accountType = "personal") {
  const result = {
    accountType,
    arcAddress: null,
    solanaAddresses: [],
    arc: { usdc: 0, eurc: 0 },
    solana: { usdc: 0 },
    pendingNear: 0,
    byChain: { arc: 0, solana: 0 },
    total: 0,
  };
  if (!user) return result;

  // Arc (native USDC + EURC on the EVM address)
  const arcAddress = deriveAddress(user, accountType, "arc");
  result.arcAddress = arcAddress;
  if (arcAddress) {
    try {
      result.arc.usdc = _round2(parseFloat(walletLib.formatMicro(await walletLib.getNativeBalanceMicro(arcAddress))));
    } catch (err) {
      console.warn(`[chains] arc balance read failed for ${arcAddress}:`, err.message);
    }
    try {
      result.arc.eurc = _round2(parseFloat(walletLib.formatMicro(await tokens.getEurcBalance(arcAddress))));
    } catch (_) {}
  }

  // Solana (SPL USDC across derived + stored/legacy addresses)
  const solPrimary = deriveAddress(user, accountType, "solana");
  const solStored = accountType === "business" ? user.biz_solana_deposit_address : user.solana_deposit_address;
  const solAddrs = [...new Set([solPrimary, solStored].filter(Boolean))];
  result.solanaAddresses = solAddrs;
  let solUsdc = 0;
  for (const a of solAddrs) {
    try {
      const bal = await multichain.getSplTokenBalance(a);
      if (bal && bal.uiAmount > 0) solUsdc += bal.uiAmount;
    } catch (_) {}
  }
  result.solana.usdc = _round2(solUsdc);

  // NEAR: pending 1Click deposits not yet swept to Arc
  try {
    for (const d of db.getActiveNearDeposits()) {
      if (String(d.telegram_id) === String(user.telegram_id) && (d.account_type || "personal") === accountType) {
        result.pendingNear += Number(d.amount_usdc) || 0;
      }
    }
  } catch (err) {
    console.warn("[chains] pending near deposits note:", err.message);
  }
  result.pendingNear = _round2(result.pendingNear);

  result.byChain = { arc: result.arc.usdc, solana: result.solana.usdc };
  result.total = _round2(result.arc.usdc + result.solana.usdc);
  return result;
}

module.exports = {
  getChains,
  listChains,
  getChain,
  getPajRailChains,
  deriveAddress,
  getUnifiedBalance,
};
