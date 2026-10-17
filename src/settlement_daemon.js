// src/settlement_daemon.js
// Phase 4: one worker owns all background money movement.
//
// Replaces the scattered setInterval blocks that used to live in bot.js
// (EVM sweep monitor, CCTP inbound recovery, NEAR poller) plus the previously
// manual-only Arc→Solana burn retry.  Each task runs on its own interval,
// guarded by an in-flight flag (no overlap) and a per-run ledger row in
// `settlement_runs` (observability + crash recovery).
//
// Resume-don't-duplicate: every underlying worker is already idempotent
// (processed-tx dedupe in the sweeper, status machines in the cctp/near
// tables), so a daemon restart simply re-runs tasks against those ledgers.

const db = require("./db");
const cctpBridge = require("./cctp_bridge");
const nearLib = require("./near");
const evmSweeper = require("./evm_deposit_sweeper");
const paj = require("./paj");
const webhookServer = require("./webhook_server");
const walletLib = require("./wallet");
const multichain = require("./multichain");

const DEFAULT_TICK_MS = 5000;
const STALE_RUN_MINUTES = 15;

/**
 * Poll pending Paj on-ramp orders from local DB and query Paj v2 status.
 * If completed/paid, records in ledger and sends rich deposit notification.
 */
async function pollPendingOnrampOrders(bot) {
  const pendingOrders = db.getPendingOnrampOrders ? db.getPendingOnrampOrders() : [];
  if (!pendingOrders || pendingOrders.length === 0) return { polled: 0, completed: 0 };

  let completedCount = 0;
  for (const order of pendingOrders) {
    try {
      const liveOrder = await paj.getOnrampOrder(order.order_id);
      if (!liveOrder) continue;

      const orderData = liveOrder.data || liveOrder;
      const status = String(orderData.status || "").toLowerCase();
      if (status === "completed" || status === "successful" || status === "paid" || status === "settled") {
        const txHash = orderData.txHash || orderData.signature || orderData.hash || `paj-settle-${order.order_id}`;
        
        // 1% platform fee inside trade amount
        const amountUsdc = Number(orderData.amount || order.amount_usdc || 0);
        const feeUsdc = Number((amountUsdc * 0.01).toFixed(4));
        const netAmountUsdc = Number((amountUsdc - feeUsdc).toFixed(4));
        const feeRecipient = process.env.APP_FEE_RECIPIENT_ADDRESS || process.env.PAYIT_DEV_FEE_ADDRESS || "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359";
        let feeTxHash = null;

        const user = db.getUser(order.telegram_id);
        const isBiz = order.account_type === "business";
        const isArcOrder = (order.settlement_rail === "arc") || (order.recipient_address && order.recipient_address.startsWith("0x"));
        if (isArcOrder && user && feeUsdc > 0.0001 && feeRecipient && walletLib.isValidAddress(feeRecipient)) {
          try {
            const encryptedKey = isBiz
              ? (user.biz_system_encrypted_key || user.system_encrypted_key)
              : user.system_encrypted_key;
            if (encryptedKey) {
              const rawKey = walletLib.decryptSensitiveValue(encryptedKey);
              if (rawKey) {
                const userWallet = walletLib.walletFromPrivateKey(rawKey);
                if (userWallet.address.toLowerCase() !== feeRecipient.toLowerCase()) {
                  const feeMicro = walletLib.parseToMicro(feeUsdc.toFixed(6));
                  const feeTx = await walletLib.sendSponsoredOrDirectTransaction(userWallet, feeRecipient, feeMicro);
                  feeTxHash = feeTx?.txHash || null;
                  console.log(`[settlement_daemon:onramp] Collected 1% fee ($${feeUsdc} USDC) -> ${feeRecipient} (tx: ${feeTxHash})`);
                }
              }
            }
          } catch (feeErr) {
            console.warn("[settlement_daemon:onramp_fee_note]", feeErr.message);
          }
        } else if (!isArcOrder && user && feeUsdc > 0.0001) {
          let solFeeRecipient = process.env.SOLANA_FEE_RECIPIENT || null;
          if (!solFeeRecipient && process.env.DEPLOYER_PRIVATE_KEY) {
            try {
              solFeeRecipient = multichain.deriveSolanaFromEvmKey(process.env.DEPLOYER_PRIVATE_KEY).solanaAddress;
            } catch {}
          }
          if (solFeeRecipient && multichain.isSolanaAddress(solFeeRecipient)) {
            try {
              const encryptedKey = isBiz
                ? (user.biz_system_encrypted_key || user.system_encrypted_key)
                : user.system_encrypted_key;
              if (encryptedKey) {
                const rawKey = walletLib.decryptSensitiveValue(encryptedKey);
                if (rawKey) {
                  const solData = multichain.deriveSolanaFromEvmKey(rawKey);
                  if (solData.solanaAddress !== solFeeRecipient) {
                    const feeSolTx = await multichain.sendSolanaTransfer({
                      keypair: solData.keypair,
                      recipientAddress: solFeeRecipient,
                      amount: feeUsdc,
                    });
                    feeTxHash = feeSolTx?.txHash || feeSolTx?.signature || null;
                    console.log(`[settlement_daemon:onramp:solana] Collected 1% fee on Solana ($${feeUsdc} USDC) -> ${solFeeRecipient} (tx: ${feeTxHash})`);
                  }
                }
              }
            } catch (feeErr) {
              console.warn("[settlement_daemon:onramp:solana_fee_note]", feeErr.message);
            }
          }
        }

        const creditedAmountUsdc = feeTxHash ? netAmountUsdc : amountUsdc;
        const amountMicro = walletLib.parseToMicro(creditedAmountUsdc.toFixed(6));

        // Mark completed in DB
        db.completeOnrampOrder(order.order_id, txHash);

        // Record in ledger
        db.recordTransaction(
          order.telegram_id,
          "deposit_naira",
          amountMicro,
          "confirmed",
          txHash,
          order.account_type || "personal"
        );

        // Trigger rich notification with receipt PNG
        if (bot) {
          await webhookServer.sendOnrampDepositNotification({
            bot,
            telegramId: order.telegram_id,
            fiatAmount: orderData.fiatAmount || order.fiat_amount,
            amountUsdc: creditedAmountUsdc,
            feeUsdc: feeTxHash ? feeUsdc : 0,
            accountType: order.account_type || "personal",
            txHash,
            orderId: order.order_id,
            rate: orderData.rate || order.rate,
            network: order.settlement_rail === "arc" ? "Arc Mainnet" : "Solana Mainnet",
          });
        }
        completedCount++;
      } else if (status === "failed" || status === "cancelled" || status === "expired") {
        db.completeOnrampOrder(order.order_id, null, status);
      }
    } catch (err) {
      console.warn(`[settlement_daemon] pollPendingOnrampOrders error on ${order.order_id}:`, err.message);
    }
  }

  return { polled: pendingOrders.length, completed: completedCount };
}

/**
 * Poll pending Paj off-ramp orders from local DB and query Paj v2 status.
 * If completed/paid, records in ledger and sends rich cash-out receipt.
 */
async function pollPendingOfframpOrders(bot) {
  const pendingOrders = db.getPendingOfframpOrders ? db.getPendingOfframpOrders() : [];
  if (!pendingOrders || pendingOrders.length === 0) return { polled: 0, completed: 0 };

  let completedCount = 0;
  for (const order of pendingOrders) {
    try {
      const liveOrder = await paj.getOfframpOrder(order.order_id);
      if (!liveOrder) continue;

      const orderData = liveOrder.data || liveOrder;
      const status = String(orderData.status || "").toLowerCase();
      if (status === "completed" || status === "successful" || status === "paid" || status === "settled") {
        const txHash = orderData.txHash || orderData.hash || order.tx_hash || `paj-offramp-${order.order_id}`;

        // 1. Mark completed in DB
        db.completeOfframpOrder(order.order_id, { txHash, status: "completed" });

        // 2. Record transaction in ledger if not already recorded
        const amountUsdc = Number(orderData.amount || order.amount_usdc || 0);
        if (amountUsdc > 0 && order.telegram_id) {
          try {
            const amountMicro = walletLib.parseToMicro(amountUsdc.toFixed(6));
            db.recordTransaction(
              order.telegram_id,
              "offramp",
              amountMicro,
              "confirmed",
              txHash,
              order.account_type || "personal"
            );
          } catch (recErr) {
            console.warn("[settlement_daemon:offramp] Record tx error:", recErr.message);
          }
        }

        // 3. Send rich receipt notification to user
        if (bot && order.telegram_id) {
          try {
            const user = db.getUser(order.telegram_id);
            const isBiz = order.account_type === "business";
            const accountLabel = isBiz ? "Business Treasury" : "Personal Wallet";
            const userAddress = user
              ? (isBiz ? (user.business_deposit_address || user.deposit_address) : user.deposit_address)
              : null;
            const fiatAmount = Number(orderData.fiatAmount || order.fiat_amount || 0);
            const bankName = order.bank_name || orderData.bankName || "Bank";
            const accountNumber = String(order.account_number || orderData.accountNumber || "");

            const caption =
              `✅ <b>Cash Out Delivered (${accountLabel})!</b>\n` +
              `──────────────────────────\n` +
              `💵 <b>Delivered:</b> ₦${fiatAmount > 0 ? Number(fiatAmount).toLocaleString() : "..."}\n` +
              `🏦 <b>Destination:</b> ${bankName} <code>${accountNumber}</code>\n` +
              `💰 <b>Amount:</b> $${amountUsdc.toFixed(2)} USDC\n` +
              `💼 <b>Source:</b> ${accountLabel}\n` +
              `🔖 <b>Ref:</b> <code>${order.order_id}</code>\n\n` +
              `<i>Funds have been delivered directly to your bank account.</i>`;

            const { generateReceiptPNG } = require("./receipt_generator");
            let receiptPath = null;
            try {
              receiptPath = await generateReceiptPNG({
                receiptId: `CO-${String(order.order_id).slice(0, 10)}`,
                senderName: "Proxim Wallet",
                senderAddress: userAddress || "Proxim Wallet",
                recipientName: order.account_name || bankName,
                recipientAddress: accountNumber,
                amountUsdc: amountUsdc,
                token: "USDC",
                type: "Cash Out",
                timestamp: new Date().toISOString(),
                status: "Confirmed",
                txHash: txHash,
              });
            } catch (recErr) {
              console.warn("[settlement_daemon:offramp_receipt_err]", recErr.message);
            }

            const cleanCaption = caption.length > 950 ? caption.slice(0, 940) + "..." : caption;

            if (receiptPath && typeof bot.telegram?.sendPhoto === "function") {
              try {
                await bot.telegram.sendPhoto(
                  order.telegram_id,
                  { source: receiptPath },
                  { caption: cleanCaption, parse_mode: "HTML" }
                );
              } catch (photoErr) {
                console.warn("[settlement_daemon:sendPhoto_fallback]", photoErr.message);
                if (typeof bot.telegram?.sendMessage === "function") {
                  await bot.telegram.sendMessage(order.telegram_id, caption, { parse_mode: "HTML" });
                }
              }
            } else if (typeof bot.telegram?.sendMessage === "function") {
              await bot.telegram.sendMessage(order.telegram_id, caption, { parse_mode: "HTML" });
            }
          } catch (notifErr) {
            console.warn(`[settlement_daemon] Failed to notify user ${order.telegram_id}:`, notifErr.message);
          }
        }
        completedCount++;
      } else if (status === "failed" || status === "cancelled" || status === "rejected") {
        db.completeOfframpOrder(order.order_id, { status: "failed" });
        if (bot && order.telegram_id) {
          try {
            await bot.telegram.sendMessage(
              order.telegram_id,
              `⚠️ <b>Cash Out Failed</b>\n──────────────────────────\n` +
              `Your cash out request (<code>${order.order_id}</code>) could not be settled by the bank.\n` +
              `Reason: ${orderData.reason || "Bank payout rejected"}.\n\n` +
              `<i>Your funds remain safe in your wallet balance.</i>`,
              { parse_mode: "HTML" }
            );
          } catch (_) {}
        }
      }
    } catch (err) {
      console.warn(`[settlement_daemon] pollPendingOfframpOrders error on ${order.order_id}:`, err.message);
    }
  }

  return { polled: pendingOrders.length, completed: completedCount };
}

/**
 * Default task set.  intervalMs preserves the schedules the scattered workers
 * used to run at (EVM sweep 90s, inbound recovery 20s, NEAR 60s); the
 * Arc→Solana burn retry (previously admin-manual via /retry_cctp) now runs
 * automatically every 60s so stuck Move Funds complete without intervention;
 * Paj on-ramp and off-ramp polling runs every 15s to notify users immediately upon deposit or bank settlement.
 */
function defaultTasks() {
  return [
    {
      name: "evm_sweep",
      intervalMs: 90_000,
      run: async ({ bot }) => evmSweeper.runEvmSweepOnce({ bot }),
    },
    {
      name: "cctp_inbound_recovery",
      intervalMs: 20_000,
      run: async ({ bot }) => cctpBridge.recoverPendingInboundCctpTransfers(bot),
    },
    {
      name: "cctp_burn_retry",
      intervalMs: 60_000,
      run: async ({ bot }) => cctpBridge.retryPendingCctpBurns(null, bot),
    },
    {
      name: "near_poll",
      intervalMs: 60_000,
      run: async ({ bot }) => {
        const polled = await nearLib.pollPendingNearDeposits(bot);
        const expired = await nearLib.expireStaleNearDeposits(bot);
        return { polled, expired };
      },
    },
    {
      name: "paj_onramp_poll",
      intervalMs: 15_000,
      run: async ({ bot }) => {
        const onramp = await pollPendingOnrampOrders(bot);
        const offramp = await pollPendingOfframpOrders(bot);
        return { onramp, offramp };
      },
    },
    {
      name: "crosschain_withdrawal_sweep",
      intervalMs: 15_000,
      run: async ({ bot }) => cctpBridge.processPendingCrosschainWithdrawals(bot),
    },
  ];
}

let _timer = null;
let _bot = null;
let _tasks = [];
let _tickMs = DEFAULT_TICK_MS;
const _inflight = new Set();
const _lastRunAt = new Map();
let _runsSincePrune = 0;

function _summarize(result) {
  if (result == null) return null;
  try {
    return JSON.stringify(result).slice(0, 4000);
  } catch {
    return null;
  }
}

async function _runTask(task) {
  if (_inflight.has(task.name)) return;
  _inflight.add(task.name);
  const runId = db.beginSettlementRun(task.name);
  try {
    const result = await task.run({ bot: _bot });
    if (runId != null) db.finishSettlementRun(runId, { status: "succeeded", result: _summarize(result) });
  } catch (err) {
    console.warn(`[settlement_daemon] task ${task.name} failed:`, err.message);
    if (runId != null) db.finishSettlementRun(runId, { status: "failed", error: err.message });
  } finally {
    _inflight.delete(task.name);
  }
}

async function tick({ force = false } = {}) {
  const now = Date.now();
  for (const task of _tasks) {
    const last = _lastRunAt.get(task.name) || 0;
    if (!force && now - last < task.intervalMs) continue;
    _lastRunAt.set(task.name, now);
    await _runTask(task);
  }
}

/**
 * Start the daemon.  Idempotent — returns the existing timer if already
 * running.  Marks stale 'running' ledger rows (left by a crash) interrupted.
 */
function startSettlementDaemon({ bot = null, tasks = null, tickMs = DEFAULT_TICK_MS } = {}) {
  if (_timer) return _timer;
  _bot = bot;
  _tasks = Array.isArray(tasks) && tasks.length ? tasks : defaultTasks();
  _tickMs = tickMs || DEFAULT_TICK_MS;
  try {
    const interrupted = db.interruptStaleSettlementRuns(STALE_RUN_MINUTES);
    if (interrupted > 0) {
      console.warn(`[settlement_daemon] interrupted ${interrupted} stale run(s) from previous process`);
    }
  } catch (err) {
    console.warn("[settlement_daemon] stale-run cleanup note:", err.message);
  }
  _timer = setInterval(() => {
    tick().catch((err) => console.warn("[settlement_daemon] tick error:", err.message));
    // Periodic ledger pruning (~every hour at 5s ticks)
    if (++_runsSincePrune >= 720) {
      _runsSincePrune = 0;
      try { db.pruneSettlementRuns(500); } catch (_) {}
    }
  }, _tickMs);
  if (_timer.unref) _timer.unref();
  console.log(`[settlement_daemon] started: ${_tasks.map((t) => `${t.name}@${Math.round(t.intervalMs / 1000)}s`).join(", ")}`);
  return _timer;
}

function stopSettlementDaemon() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _bot = null;
  _tasks = [];
  _inflight.clear();
  _lastRunAt.clear();
}

/**
 * Run one task immediately (admin command, tests).  Returns false if the
 * task name is unknown.
 */
async function runTaskNow(name, { bot = _bot } = {}) {
  const task = _tasks.find((t) => t.name === name) || defaultTasks().find((t) => t.name === name);
  if (!task) return false;
  _lastRunAt.set(task.name, Date.now());
  await _runTask(task);
  return true;
}

function listTasks() {
  return (_tasks.length ? _tasks : defaultTasks()).map((t) => ({
    name: t.name,
    intervalMs: t.intervalMs,
    inflight: _inflight.has(t.name),
    lastRunAt: _lastRunAt.get(t.name) || null,
  }));
}

function isRunning() {
  return _timer != null;
}

module.exports = {
  startSettlementDaemon,
  stopSettlementDaemon,
  runTaskNow,
  listTasks,
  isRunning,
  defaultTasks,
  tick, // exposed for tests
};
