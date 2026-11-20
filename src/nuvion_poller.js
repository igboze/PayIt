// src/nuvion_poller.js
// Background poller & reconciler for Nuvion Phase 2+:
// 1. Interac CAD Funding Sessions: calls PATCH /funding-sessions/{id} every 3 min (up to 3 days)
//    because Interac does not push decline/expiry updates without PATCH.
// 2. Stuck Inbound Sweep Reconciler: retries any `inbound_fiat_sweep` job in `retry_pending`
//    so zero user funds ever sit stranded inside Nuvion.

const nuvion = require("./nuvion");
const db = require("./db");
const orchestrator = require("./nuvion_orchestrator");

const INTERAC_POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes per Nuvion docs
const INTERAC_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // Stop after 3 days per Nuvion docs
const TERMINAL_SESSION_STATES = new Set(["settled", "failed", "expired", "cancelled"]);
const MAX_SWEEP_RETRIES = 5;

let _timer = null;

function getBotTelegram(bot) {
  if (!bot) return null;
  if (bot.telegram && typeof bot.telegram.sendMessage === "function") return bot.telegram;
  if (bot.bot?.telegram && typeof bot.bot.telegram.sendMessage === "function") return bot.bot.telegram;
  return null;
}

/**
 * Poll all open Interac CAD funding sessions once using PATCH /funding-sessions/{id}.
 */
async function pollInteracSessionsOnce(bot = null) {
  const openStates = ["awaiting_user", "processing", "pending_settlement"];
  const jobs = [];
  for (const st of openStates) {
    jobs.push(...db.getNuvionJobsByState("interac_funding", st));
  }

  const results = [];
  const telegram = getBotTelegram(bot);

  for (const job of jobs) {
    if (!job.session_id) continue;

    // Stop polling after 3 days per Nuvion Interac spec
    const createdMs = job.created_at ? new Date(job.created_at.replace(" ", "T") + "Z").getTime() : Date.now();
    if (Number.isFinite(createdMs) && (Date.now() - createdMs) > INTERAC_MAX_AGE_MS) {
      db.updateNuvionJob(job.id, { state: "expired" });
      results.push({ jobId: job.id, status: "expired_local_ttl" });
      continue;
    }

    try {
      const updated = await nuvion.refreshInteracSession(job.session_id, job.entity_id);
      const nextStatus = String(updated?.status || job.state).toLowerCase();

      if (nextStatus !== job.state) {
        db.updateNuvionJob(job.id, { state: nextStatus });
      }

      if (nextStatus === "settled") {
        // Reconcile the settled inflow & trigger auto-sweep straight to user's main wallet
        try {
          const listed = await nuvion.listTransfers({
            entityId: job.entity_id,
            type: "inflow",
            paymentType: "funding-session",
            uniqueReference: job.unique_reference,
            limit: 5,
          });
          const inflow = (listed?.data || []).find(
            (t) => t.meta?.funding_session_id === job.session_id || t.unique_reference === job.unique_reference
          );
          if (inflow && inflow.status === "successful") {
            const entityRecord = db.getNuvionEntityByEntityId(job.entity_id);
            await orchestrator.handleInboundFiatSweep({ confirmed: inflow, entityRecord, bot });
          }
        } catch (recErr) {
          console.warn(`[nuvion_poller] Interac settled reconcile note for job ${job.id}:`, recErr.message);
        }
      } else if (TERMINAL_SESSION_STATES.has(nextStatus) && nextStatus !== "settled" && telegram && job.telegram_id) {
        const amtStr = orchestrator.formatFiatAmount(job.currency || "CAD", nuvion.fromNuvionMinor(job.amount_minor));
        await telegram.sendMessage(
          job.telegram_id,
          `⚠️ <b>Interac Payment Request ${nextStatus.toUpperCase()}</b>\n` +
          `──────────────────────────\n` +
          `Your <b>${amtStr}</b> Interac request (${job.payload?.payerEmail || "payer"}) ended with status <code>${nextStatus}</code>.\n` +
          `You can send a new request anytime from Global Banking.`,
          { parse_mode: "HTML" }
        ).catch(() => {});
      }

      results.push({ jobId: job.id, sessionId: job.session_id, status: nextStatus });
    } catch (err) {
      console.warn(`[nuvion_poller] Interac PATCH error for session ${job.session_id}:`, err.message);
      results.push({ jobId: job.id, sessionId: job.session_id, error: err.message });
    }
  }

  return results;
}

/**
 * Retry any inbound fiat sweeps that hit a transient error (ensures zero stranded funds in Nuvion).
 */
async function reconcilePendingSweepsOnce(bot = null) {
  const retryJobs = db.getNuvionJobsByState("inbound_fiat_sweep", "retry_pending");
  const results = [];

  for (const job of retryJobs) {
    if ((job.retry_count || 0) >= MAX_SWEEP_RETRIES) continue;
    const inflowId = job.payload?.inflowId || job.nuvion_transfer_id;
    if (!inflowId) continue;

    try {
      const confirmed = await nuvion.getTransfer(inflowId, job.entity_id);
      const entityRecord = db.getNuvionEntityByEntityId(job.entity_id);
      if (confirmed && entityRecord) {
        const res = await orchestrator.handleInboundFiatSweep({ confirmed, entityRecord, bot });
        results.push({ jobId: job.id, ...res });
      }
    } catch (err) {
      db.updateNuvionJob(job.id, {
        retry_count: (job.retry_count || 0) + 1,
        error_message: err.message,
      });
      results.push({ jobId: job.id, error: err.message });
    }
  }

  return results;
}

async function runNuvionPollerCycle(bot = null) {
  if (!nuvion.isNuvionConfigured()) return { skipped: true };
  const interac = await pollInteracSessionsOnce(bot);
  const sweeps = await reconcilePendingSweepsOnce(bot);
  return { interac, sweeps };
}

function startNuvionPoller(bot = null, intervalMs = INTERAC_POLL_INTERVAL_MS) {
  if (_timer || !nuvion.isNuvionConfigured()) return null;
  _timer = setInterval(() => {
    runNuvionPollerCycle(bot).catch((err) => {
      console.warn("[nuvion_poller] cycle error:", err.message);
    });
  }, intervalMs);
  if (_timer.unref) _timer.unref();
  console.log(`[nuvion_poller] Started (interval: ${Math.round(intervalMs / 1000)}s)`);
  return _timer;
}

function stopNuvionPoller() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = {
  pollInteracSessionsOnce,
  reconcilePendingSweepsOnce,
  runNuvionPollerCycle,
  startNuvionPoller,
  stopNuvionPoller,
};
