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

const DEFAULT_TICK_MS = 5000;
const STALE_RUN_MINUTES = 15;

/**
 * Default task set.  intervalMs preserves the schedules the scattered workers
 * used to run at (EVM sweep 90s, inbound recovery 20s, NEAR 60s); the
 * Arc→Solana burn retry (previously admin-manual via /retry_cctp) now runs
 * automatically every 60s so stuck Move Funds complete without intervention.
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
      run: async () => cctpBridge.retryPendingCctpBurns(),
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
