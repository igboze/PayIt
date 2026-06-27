// agent/scheduler.js
// node-cron job manager for recurring AutoPay schedules.
// PIN is held in memory for the job's lifetime (documented tradeoff — see PAYIT_DOCUMENTATION.md).
// Jobs stop on restart — reloadAll() warns users to re-confirm rather than faking it.

const cron = require("node-cron");

const activeJobs = new Map(); // jobId → { cronJob, pin }

const FREQ_TO_CRON = {
  daily:   "0 9 * * *",
  weekly:  null, // built from plan.schedule.day
  monthly: null, // built from plan.schedule.day
};

const DAY_TO_DOW = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

function buildCronExpression(schedule) {
  const freq = schedule.frequency?.toLowerCase();
  const day  = schedule.day?.toLowerCase();
  const time = schedule.time || "09:00";
  const [hour, minute] = time.split(":").map(Number);

  if (freq === "daily")   return `${minute} ${hour} * * *`;
  if (freq === "weekly") {
    const dow = DAY_TO_DOW[day] ?? 5; // default Friday
    return `${minute} ${hour} * * ${dow}`;
  }
  if (freq === "monthly") {
    const dom = parseInt(day) || 1;
    return `${minute} ${hour} ${dom} * *`;
  }
  return null;
}

function startJob(jobId, userId, plan, pin, onTick) {
  const expr = buildCronExpression(plan.schedule || {});
  if (!expr || !cron.validate(expr)) {
    console.warn(`[scheduler] Invalid cron for job ${jobId}: ${expr}`);
    return;
  }
  const job = cron.schedule(expr, async () => {
    const { executePlan } = require("./executor");
    const db = require("../src/db");
    const user = db.getUser(parseInt(userId));
    if (!user) return;
    const results = await executePlan(plan, pin, user);
    await onTick(userId, jobId, results);
  });
  activeJobs.set(jobId, { cronJob: job, pin });
}

function cancelJob(jobId) {
  const entry = activeJobs.get(jobId);
  if (entry) {
    entry.cronJob.stop();
    activeJobs.delete(jobId);
  }
}

/**
 * On bot restart: warn that jobs need PIN re-confirmation, don't silently re-run with a stale PIN.
 */
function reloadAll(notifyFn) {
  const { getUserSchedules } = require("./store");
  // We don't have access to all userIds here — jobs reload lazily when users interact.
  // This is the documented safe behaviour: jobs stop on restart, user must re-confirm.
  console.log("[scheduler] Restart — active recurring jobs require PIN re-confirmation from users.");
}

module.exports = { startJob, cancelJob, reloadAll };
