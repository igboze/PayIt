// src/near.js
// NEAR Intents (1Click) integration — NEAR deposits bridged to Base USDC,
// then auto-swept to Arc by the existing EVM deposit sweeper.
//
// Routing reality (verified 2026-09-30 against the live 1Click API):
//   NEAR USDC -> Solana USDC  : NOT quoted by solvers
//   NEAR USDC -> Base USDC    : quoted (~4.997/5.00)  <- our route
//   NEAR USDC -> Arbitrum USDC: quoted (~4.994/5.00)  <- fallback
// The one-time depositAddress comes from POST /v0/quote (dry=false).
// Settlement is tracked with GET /v0/status — crediting itself always happens
// through the EVM sweeper (Base -> Arc CCTP), never here, to avoid double credit.
//
// Refunds: refundTo is the user's derived NEAR implicit account (same ed25519
// secret material as their Solana key, domain-separated salt). Refunded USDC
// sits there until the user requests a manual/assisted recovery.

const crypto = require("crypto");
const tweetnacl = require("tweetnacl");
const db = require("./db");

const DEFAULT_API_URL = "https://1click.chaindefuser.com";

// Asset IDs on the 1Click token registry (overridable via env).
const ASSETS = {
  NEAR_USDC: process.env.NEAR_INTENTS_USDC || "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  NEAR_USDT: process.env.NEAR_INTENTS_USDT || "nep141:usdt.tether-token.near",
  BASE_USDC: process.env.NEAR_INTENTS_BASE_USDC || "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  ARB_USDC: process.env.NEAR_INTENTS_ARB_USDC || "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
};

const TERMINAL_STATUSES = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

function getApiKey() {
  return process.env.NEAR_INTENTS_API_KEY || "";
}

function getApiBaseUrl() {
  return (process.env.NEAR_INTENTS_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

async function apiRequest(method, path, body) {
  const key = getApiKey();
  if (!key) throw new Error("NEAR_INTENTS_API_KEY is not configured");
  const axios = require("axios");
  const res = await axios({
    method,
    url: `${getApiBaseUrl()}${path}`,
    ...(body ? { data: body } : {}),
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });
  return res.data;
}

/**
 * Derive the user's NEAR implicit account from their EVM private key.
 * Same construction as multichain.deriveSolanaFromEvmKey but with a
 * NEAR-specific domain-separation salt — the two chains never share keys.
 *
 * NEAR implicit account = lowercase hex of the 32-byte ed25519 public key.
 *
 * @param {string} evmPrivateKey - hex private key (0x-prefixed or not)
 * @returns {{ nearAddress: string, publicKeyHex: string, secretKeyHex: string }}
 */
function deriveNearAddress(evmPrivateKey) {
  if (!evmPrivateKey) throw new Error("EVM private key required to derive NEAR address");
  const cleanHex = evmPrivateKey.startsWith("0x") ? evmPrivateKey.slice(2) : evmPrivateKey;
  const keyBuffer = Buffer.from(cleanHex, "hex");

  const hmac = crypto.createHmac("sha512", Buffer.from("PayIT-NEAR-Intent-Bridge-Salt", "utf8"));
  hmac.update(keyBuffer);
  const seed32 = hmac.digest().subarray(0, 32);

  const naclKeypair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(seed32));
  const publicKeyHex = Buffer.from(naclKeypair.publicKey).toString("hex");
  return {
    nearAddress: publicKeyHex.toLowerCase(),
    publicKeyHex: publicKeyHex.toLowerCase(),
    secretKeyHex: Buffer.from(naclKeypair.secretKey).toString("hex"),
  };
}

function defaultDeadline() {
  const mins = Number(process.env.NEAR_INTENT_DEADLINE_MIN || 30);
  return new Date(Date.now() + mins * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Request a 1Click quote (dry or real).
 *
 * @param {object} p
 * @param {string} p.originAsset     - e.g. ASSETS.NEAR_USDC
 * @param {string} p.destinationAsset- e.g. ASSETS.BASE_USDC
 * @param {string} p.amount          - base units as integer string (6 decimals for USDC)
 * @param {string} p.recipient       - destination-chain address (user's Arc/Base address)
 * @param {string} p.refundTo        - origin-chain refund address (user's derived NEAR account)
 * @param {boolean} [p.dry=false]
 */
async function getQuote({ originAsset, destinationAsset, amount, recipient, refundTo, dry = false }) {
  return apiRequest("POST", "/v0/quote", {
    dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: Number(process.env.NEAR_INTENT_SLIPPAGE_BPS || 100),
    originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset,
    amount: String(amount),
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: defaultDeadline(),
  });
}

/**
 * Check swap execution status for a deposit address.
 * @returns {Promise<{status: string, swapDetails?: object}>}
 */
async function getExecutionStatus(depositAddress, depositMemo) {
  const qs = new URLSearchParams({ depositAddress });
  if (depositMemo) qs.set("depositMemo", depositMemo);
  return apiRequest("GET", `/v0/status?${qs.toString()}`);
}

/**
 * Create a NEAR deposit intent: persist the row first, then fetch a real quote
 * and store the one-time deposit address. If quoting fails, the row is marked
 * failed immediately so nothing dangles.
 *
 * @returns {Promise<object>} near_deposits row (with quote fields)
 */
async function createNearDeposit({ telegramId, accountType = "personal", originAsset, amountUsdc, recipientAddress, refundTo }) {
  const id = db.createNearDeposit({
    telegramId,
    accountType,
    originAsset,
    amountUsdc,
    recipientAddress,
    refundTo,
    status: "quoting",
  });

  try {
    // Routed via module.exports so tests can stub the API layer.
    const quoteRes = await module.exports.getQuote({
      originAsset,
      destinationAsset: ASSETS.BASE_USDC,
      amount: Math.round(Number(amountUsdc) * 1e6).toString(),
      recipient: recipientAddress,
      refundTo,
      dry: false,
    });
    const q = quoteRes?.quote || {};
    db.updateNearDeposit(id, {
      status: "awaiting_deposit",
      deposit_address: q.depositAddress || null,
      deposit_memo: q.depositMemo || null,
      amount_out: q.amountOut ? Number(q.amountOut) / 1e6 : null,
      quote_json: JSON.stringify(quoteRes),
      deadline: quoteRes?.quoteRequest?.deadline || null,
      correlation_id: quoteRes?.correlationId || null,
    });
    return db.getNearDepositById(id);
  } catch (err) {
    db.updateNearDeposit(id, { status: "failed", error: String(err.message).slice(0, 500) });
    throw err;
  }
}

/**
 * Poll all non-terminal NEAR deposits, update statuses, and notify users on
 * terminal transitions. SUCCESS means funds landed on Base — the EVM sweeper
 * detects that balance and credits Arc independently; this function only
 * reports progress, it never credits.
 *
 * @param {object} [bot] - Telegraf bot for notifications
 * @returns {Promise<{updated: number, terminal: number}>}
 */
async function pollPendingNearDeposits(bot = null) {
  const pending = db.getActiveNearDeposits();
  let updated = 0;
  let terminal = 0;

  for (const row of pending) {
    if (!row.deposit_address) continue;
    try {
      // Routed via module.exports so tests can stub the API layer.
      const st = await module.exports.getExecutionStatus(row.deposit_address, row.deposit_memo);
      const status = String(st?.status || "").toUpperCase();
      if (!status || status === row.status) continue;

      db.updateNearDeposit(row.id, { status });
      updated++;

      if (TERMINAL_STATUSES.has(status)) {
        terminal++;
        if (bot && row.telegram_id) {
          const swap = st?.swapDetails || {};
          if (status === "SUCCESS") {
            const out = row.amount_out ? `$${row.amount_out.toFixed(2)}` : "your USDC";
            await bot.telegram.sendMessage(
              row.telegram_id,
              `🎉 <b>NEAR Deposit Bridged!</b>\n` +
              `──────────────────────────\n` +
              `💰 <b>Amount:</b> ${out} USDC arriving on Base\n` +
              `🌉 <b>Route:</b> NEAR Intents (1Click) → Base\n` +
              `⏳ <b>Next:</b> Auto-sweeping to your Arc balance — you'll get a credit confirmation in about a minute.\n\n` +
              `<i>No action needed.</i>`,
              { parse_mode: "HTML" }
            ).catch(() => {});
          } else if (status === "REFUNDED") {
            await bot.telegram.sendMessage(
              row.telegram_id,
              `↩️ <b>NEAR Deposit Refunded</b>\n` +
              `──────────────────────────\n` +
              `Your deposit of $${Number(row.amount_usdc).toFixed(2)} was refunded to your NEAR refund address:\n` +
              `<code>${row.refund_to}</code>\n\n` +
              `<i>Contact support if you need help moving it back.</i>`,
              { parse_mode: "HTML" }
            ).catch(() => {});
          } else {
            await bot.telegram.sendMessage(
              row.telegram_id,
              `❌ <b>NEAR Deposit Failed</b>\n──────────────────────────\n` +
              `The bridge could not complete. Your funds were not lost — contact support with reference <code>${row.correlation_id || row.id}</code>.`,
              { parse_mode: "HTML" }
            ).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.warn(`[near] Status poll note for deposit #${row.id}:`, err.message);
    }
  }

  return { updated, terminal };
}

/**
 * Recover deposits stuck in `awaiting_deposit` past their deadline:
 * keep polling (the solver auto-refunds by deadline, which the status poll
 * will pick up), but nudge the user once.
 */
async function expireStaleNearDeposits(bot = null) {
  const stale = db.getStaleNearDeposits();
  for (const row of stale) {
    db.updateNearDeposit(row.id, { status: "expired" });
    if (bot && row.telegram_id) {
      await bot.telegram.sendMessage(
        row.telegram_id,
        `⏰ <b>NEAR Deposit Window Expired</b>\n──────────────────────────\n` +
        `The deposit address for $${Number(row.amount_usdc).toFixed(2)} was one-time and has expired.\n` +
        `<i>If you already sent funds, don't worry — they refund automatically to your NEAR refund address.</i>`,
        { parse_mode: "HTML" }
      ).catch(() => {});
    }
  }
  return stale.length;
}

module.exports = {
  ASSETS,
  TERMINAL_STATUSES,
  deriveNearAddress,
  getQuote,
  getExecutionStatus,
  createNearDeposit,
  pollPendingNearDeposits,
  expireStaleNearDeposits,
};
