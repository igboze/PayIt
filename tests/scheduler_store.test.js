const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const store = require("../agent/store");
const scheduler = require("../agent/scheduler");

describe("Scheduler & Store Suite", () => {
  it("getAllSchedules returns an object", () => {
    assert.strictEqual(typeof store.getAllSchedules, "function");
    const all = store.getAllSchedules();
    assert.strictEqual(typeof all, "object");
  });

  it("reloadAll executes without throwing", () => {
    assert.strictEqual(typeof scheduler.reloadAll, "function");
    assert.doesNotThrow(() => {
      scheduler.reloadAll(() => {});
    });
  });
});
