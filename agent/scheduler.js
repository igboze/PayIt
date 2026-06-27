// agent/scheduler.js
// Cron-based scheduler for recurring payments.
//
// Updated to handle:
//   - Scheduled on-chain transfers (existing)
//   - Scheduled off-ramp / Naira cashouts (new)
//
// PIN security note:
//   PINs are never persisted to disk. Scheduled jobs that require PIN
//   re-confirmation on restart will prompt the user when they next interact.
//   This is intentional — it prevents any PIN from ever being written to
//   the schedules.json store.

const cron    = require("node-cron");
const { executePlan, formatResults } = require("./executor");
const { getAllSchedules }             = require("./store");
const db      = require("../src/db");

const activeJobs = {};

// ─── Cron expression builder ──────────────────────────────────────────────────

function toCronExpression(schedule) {
  if (!schedule || !schedule.frequency) return null;

  const [hourStr, minuteStr] = (schedule.time || "08:00").split(":");
  const hour   = parseInt(hourStr)   || 8;
  const minute = parseInt(minuteStr) || 0;

  if (schedule.frequency === "daily") {
    return `${minute} ${hour} * * *`;
  }

  if (schedule.frequency === "weekly") {
    const dayMap = {
      sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
      thursday: 4, friday: 5, saturday: 6,
    };
    const dayNum = dayMap[(schedule.day || "monday").toLowerCase()] ?? 1;
    return `${minute} ${hour} * * ${dayNum}`;
  }

  if (schedule.frequency === "monthly") {
    const dayOfMonth = parseInt(schedule.day) || 1;
    return `${minute} ${hour} ${dayOfMonth} * *`;
  }

  return null;
}

// ─── Job lifecycle ────────────────────────────────────────────────────────────

/**
 * Start a scheduled payment job.
 *
 * @param {string}   jobId
 * @param {string}   userId      — Telegram ID as string
 * @param {object}   plan        — payment plan from orchestrator
 * @param {string}   pin         — user PIN (not persisted — in-memory only)
 * @param {string}   context     — "personal" | "business"
 * @param {Function} onComplete  — (userId, jobId, results) => void
 * @returns {boolean}            — true if job started successfully
 */
function startJob(jobId, userId, plan, pin, context = "personal", onComplete) {
  const cronExpr = toCronExpression(plan.schedule);

  if (!cronExpr) {
    console.error(`[scheduler] No schedule found for job ${jobId}`);
    return false;
  }

  if (!cron.validate(cronExpr)) {
    console.error(`[scheduler] Invalid cron for job ${jobId}: ${cronExpr}`);
    return false;
  }

  const task = cron.schedule(cronExpr, async () => {
    console.log(`[scheduler] Running job ${jobId} for user ${userId}`);
    const user = db.getUser(parseInt(userId));

    if (!user) {
      console.error(`[scheduler] User ${userId} not found — skipping job ${jobId}`);
      return;
    }

    const results = await executePlan(plan, pin, user, context);

    if (onComplete) onComplete(userId, jobId, results);
  });

  activeJobs[jobId] = task;
  console.log(`[scheduler] Job ${jobId} scheduled: ${cronExpr} (${plan.type || "transfer"})`);
  return true;
}

/**
 * Cancel and remove a scheduled job.
 */
function cancelJob(jobId) {
  if (activeJobs[jobId]) {
    activeJobs[jobId].stop();
    delete activeJobs[jobId];
    console.log(`[scheduler] Job ${jobId} cancelled`);
    return true;
  }
  return false;
}

/**
 * On bot restart: log which jobs exist but can't be auto-resumed
 * (because PINs are never persisted). The user will re-confirm on next interaction.
 */
function reloadAll(onComplete) {
  const store   = getAllSchedules();
  let skipped   = 0;

  for (const [userId, jobs] of Object.entries(store)) {
    for (const job of jobs) {
      if (!job.plan?.schedule?.frequency) continue;
      console.warn(
        `[scheduler] Job ${job.id} for user ${userId} needs PIN re-confirmation ` +
        `— will resume when user next sends a scheduled payment.`
      );
      skipped++;
    }
  }

  if (skipped > 0) {
    console.log(`[scheduler] ${skipped} scheduled job(s) awaiting PIN re-confirmation.`);
  }
}

/**
 * Get a human-readable summary of a schedule.
 */
function describeSchedule(schedule) {
  if (!schedule?.frequency) return "one-time";

  const freq = schedule.frequency;
  const day  = schedule.day  ? ` on ${schedule.day}` : "";
  const time = schedule.time ? ` at ${schedule.time}` : "";

  return `${freq}${day}${time}`;
}

module.exports = { startJob, cancelJob, reloadAll, toCronExpression, describeSchedule };
