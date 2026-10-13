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

      const status = String(liveOrder.status || "").toLowerCase();
      if (status === "completed" || status === "successful" || status === "paid" || status === "settled") {
        const txHash = liveOrder.txHash || liveOrder.signature || liveOrder.hash || `paj-settle-${order.order_id}`;
        
        // Mark completed in DB
        db.completeOnrampOrder(order.order_id, txHash);

        // Record in ledger
        const amountUsdc = Number(liveOrder.amount || order.amount_usdc || 0);
        const amountMicro = walletLib.parseToMicro(amountUsdc.toFixed(6));
        db.recordTransaction(
          order.telegram_id,
          "deposit_naira",
          amountMicro,
          "confirmed",
          txHash,
          order.account_type || "personal"
        );

        // Trigger rich notification
        if (bot) {
          await webhookServer.sendOnrampDepositNotification({
            bot,
            telegramId: order.telegram_id,
            fiatAmount: liveOrder.fiatAmount || order.fiat_amount,
            amountUsdc: amountUsdc,
            accountType: order.account_type || "personal",
            txHash,
            orderId: order.order_id,
            rate: liveOrder.rate || order.rate,
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
 * Default task set.  intervalMs preserves the schedules the scattered workers
 * used to run at (EVM sweep 90s, inbound recovery 20s, NEAR 60s); the
 * Arc→Solana burn retry (previously admin-manual via /retry_cctp) now runs
 * automatically every 60s so stuck Move Funds complete without intervention;
 * Paj on-ramp polling runs every 15s to notify users immediately upon deposit.
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
      run: async ({ bot }) => pollPendingOnrampOrders(bot),
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
