// tests/race_terminal.test.js
// Tests for RaceAlpha: Web terminal static serving, trader telemetry, volume gatekeeper, and viewing key flows

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const raceTerminal = require("../src/race_terminal");
const webhookServer = require("../src/webhook_server");

test("RaceTerminal: Trader registry returns verified masters with dual PnL", () => {
  const traders = raceTerminal.getTraders();
  assert.ok(Array.isArray(traders));
  assert.ok(traders.length >= 3);

  for (const t of traders) {
    assert.ok(t.id);
    assert.ok(t.handle.endsWith(".near"));
    assert.ok(t.volume30dUsd >= 10000, `Trader ${t.handle} must meet $10,000 30d volume threshold`);
    assert.ok(t.macro && typeof t.macro.netEquityGrowthPct === "number");
    assert.ok(t.tactical && typeof t.tactical.winRatePct === "number");
    assert.ok(t.tier1KeyPriceNear > 0);
    assert.ok(t.tier2KeyPriceNear > 0);
  }
});

test("RaceTerminal: Volume gatekeeper verifies accounts against $10k threshold", async () => {
  // Existing verified trader
  const res1 = await raceTerminal.verifyTraderVolume("vortex-intent.near");
  assert.equal(res1.verified, true);
  assert.ok(res1.volume30dUsd >= 10000);

  // Valid new near account
  const res2 = await raceTerminal.verifyTraderVolume("elite-alpha.near");
  assert.equal(res2.verified, true);

  // Invalid format
  const res3 = await raceTerminal.verifyTraderVolume("not-valid-address");
  assert.equal(res3.verified, false);
});

test("RaceTerminal: Viewing Key issuance generates cryptographically signed key record", () => {
  const keyRecord = raceTerminal.purchaseViewingKey({
    followerId: "alice_tg",
    traderId: "trader_01",
    tier: "auto_copy",
    budgetNear: 50,
    maxSlippagePct: 0.5,
  });

  assert.ok(keyRecord.viewingKey.startsWith("race_vk_"));
  assert.equal(keyRecord.traderHandle, "vortex-intent.near");
  assert.equal(keyRecord.tier, "auto_copy");
  assert.equal(keyRecord.budgetNear, 50);
  assert.equal(keyRecord.active, true);

  // Check intent feed received event
  const stream = raceTerminal.getIntentStream();
  assert.ok(stream.length > 0);
  assert.ok(stream.some((it) => it.trader === "vortex-intent.near"));
});

test("RaceTerminal: HTTP Server serves Terminal HTML, CSS, and API endpoints", async () => {
  const server = webhookServer.createWebhookServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  async function get(path) {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}${path}`, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }).on("error", reject);
    });
  }

  try {
    // 1. GET /terminal serves HTML
    const htmlRes = await get("/terminal");
    assert.equal(htmlRes.statusCode, 200);
    assert.ok(htmlRes.headers["content-type"].includes("text/html"));
    assert.ok(htmlRes.body.includes("RaceAlpha"));
    assert.ok(htmlRes.body.includes("Master Trader Registry"));

    // 2. GET /style.css serves CSS
    const cssRes = await get("/style.css");
    assert.equal(cssRes.statusCode, 200);
    assert.ok(cssRes.headers["content-type"].includes("text/css"));
    assert.ok(cssRes.body.includes("--bg-base"));

    // 3. GET /app.js serves JavaScript
    const jsRes = await get("/app.js");
    assert.equal(jsRes.statusCode, 200);
    assert.ok(jsRes.headers["content-type"].includes("application/javascript"));
    assert.ok(jsRes.body.includes("switchPnlMode"));

    // 4. GET /api/v1/race/traders returns JSON
    const apiRes = await get("/api/v1/race/traders");
    assert.equal(apiRes.statusCode, 200);
    const parsedApi = JSON.parse(apiRes.body);
    assert.equal(parsedApi.success, true);
    assert.ok(parsedApi.traders.length >= 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
