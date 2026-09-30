// tests/settlement_daemon.test.js
// Phase 4: src/settlement_daemon.js — scheduling, overlap guard, ledger rows.
// Uses injected fake tasks only; no network, no real workers.

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/db");
const daemon = require("../src/settlement_daemon");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanupRuns() {
  db.db.prepare("DELETE FROM settlement_runs WHERE task LIKE 'fake_%'").run();
}

test("settlement daemon: schedule, overlap guard, ledger, failure capture", async (t) => {
  cleanupRuns();

  try {
    await t.test("runs tasks on interval and writes succeeded ledger rows", async () => {
      let count = 0;
      daemon.startSettlementDaemon({
        bot: null,
        tasks: [{ name: "fake_tick", intervalMs: 40, run: async () => { count++; return { count }; } }],
        tickMs: 20,
      });
      await sleep(250);
      daemon.stopSettlementDaemon();
      assert.ok(count >= 3, `expected >=3 runs, got ${count}`);
      const rows = db.getRecentSettlementRuns("fake_tick", 50);
      assert.ok(rows.length >= 3, "ledger should record every run");
      assert.ok(rows.every((r) => r.status === "succeeded"), "all runs should succeed");
      assert.ok(rows.every((r) => r.result && r.result.includes("count")), "result payload stored");
      assert.ok(rows.every((r) => r.finished_at), "finished_at stamped");
    });

    await t.test("a slow task never overlaps itself (in-flight guard)", async () => {
      let active = 0;
      let maxActive = 0;
      daemon.startSettlementDaemon({
        bot: null,
        tasks: [{
          name: "fake_slow",
          intervalMs: 20,
          run: async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await sleep(120);
            active--;
          },
        }],
        tickMs: 20,
      });
      await sleep(400);
      daemon.stopSettlementDaemon();
      assert.equal(maxActive, 1, `task overlapped itself (maxActive=${maxActive})`);
    });

    await t.test("a failing task records a failed ledger row and the daemon keeps ticking", async () => {
      let attempts = 0;
      daemon.startSettlementDaemon({
        bot: null,
        tasks: [{
          name: "fake_fail",
          intervalMs: 40,
          run: async () => { attempts++; throw new Error("boom"); },
        }],
        tickMs: 20,
      });
      await sleep(200);
      daemon.stopSettlementDaemon();
      assert.ok(attempts >= 1);
      const rows = db.getRecentSettlementRuns("fake_fail", 10);
      assert.ok(rows.length >= 1);
      assert.equal(rows[0].status, "failed");
      assert.match(rows[0].error, /boom/);
    });

    await t.test("start is idempotent and runTaskNow executes on demand", async () => {
      let count = 0;
      const timer = daemon.startSettlementDaemon({
        bot: null,
        tasks: [{ name: "fake_manual", intervalMs: 60000, run: async () => { count++; } }],
        tickMs: 50,
      });
      const again = daemon.startSettlementDaemon({ bot: null });
      assert.equal(again, timer, "second start must return the existing timer");
      // Tasks fire once immediately at startup (boot recovery), then respect the interval.
      await sleep(120);
      assert.equal(count, 1, "immediate first run at startup, then interval-gated");
      const ok = await daemon.runTaskNow("fake_manual");
      assert.equal(ok, true);
      assert.equal(count, 2, "runTaskNow executes immediately");
      assert.equal(await daemon.runTaskNow("no_such_task"), false);
      daemon.stopSettlementDaemon();
      assert.equal(daemon.isRunning(), false);
      // After stop, listTasks reports the default task set (usable pre-start).
      const tasks = daemon.listTasks();
      assert.equal(tasks.length, 4);
      assert.ok(tasks.every((t) => !t.inflight));
    });

    await t.test("default task set covers the four settlement responsibilities", () => {
      const names = daemon.defaultTasks().map((t) => t.name).sort();
      assert.deepEqual(names, ["cctp_burn_retry", "cctp_inbound_recovery", "evm_sweep", "near_poll"]);
    });

    await t.test("stale running ledger rows are interruptible (crash recovery)", () => {
      const id = db.beginSettlementRun("fake_stale");
      assert.ok(id != null);
      // force the row old
      db.db.prepare("UPDATE settlement_runs SET started_at = datetime('now', '-1 hour') WHERE id = ?").run(id);
      const n = db.interruptStaleSettlementRuns(15);
      assert.ok(n >= 1);
      const row = db.getRecentSettlementRuns("fake_stale", 1)[0];
      assert.equal(row.status, "interrupted");
      // after interruption a new run can be claimed
      const id2 = db.beginSettlementRun("fake_stale");
      assert.ok(id2 != null);
      db.finishSettlementRun(id2, { status: "succeeded" });
    });
  } finally {
    daemon.stopSettlementDaemon();
    cleanupRuns();
  }
});
