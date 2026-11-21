// tests/nuvion_phase5.test.js
// 100% Offline Verification Suite for Nuvion Phase 5:
// - Idempotent webhook registration + blacklisted webhook reactivation
// - Test webhook dispatch + `webhook.health` ping handling
// - Read-only production health snapshot + indicative FX quote + Admin HTML card
// - Zero-Custody stranded-balance auditor (ignores intentional `purpose: "card"` sub-accounts, flags idle fiat/USC)
// - Non-sensitive public health summary (zero secret leakage)
// ZERO calls are made to live https://api.nuvion.co!

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const tmpDbPath = path.join(os.tmpdir(), `test_nuvion_phase5_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = tmpDbPath;
process.env.NODE_ENV = "test";
process.env.NUVION_ENV = "production";
process.env.NUVION_API_KEY = "nv_live_test_phase5_secret_should_never_leak";
process.env.NUVION_WEBHOOK_SECRET = "nv_wsk_test_phase5_secret_should_never_leak";
process.env.NUVION_FX_MARGIN_BPS = "100";
process.env.NUVION_BETA_IDS = "111222333";
process.env.NUVION_PUBLIC_LAUNCH = "false";
process.env.WEBHOOK_URL = "https://payit-production.up.railway.app";

const db = require("../src/db");
const nuvionWebhooks = require("../src/nuvion_webhooks");
const nuvionHealth = require("../src/nuvion_health");

function startPhase5MockNuvion() {
  const store = {
    webhooks: new Map(),
    webhookLogs: [
      { id: "log1", event: "inflows.completed", status: "delivered", response_status: 200 },
      { id: "log2", event: "entities.updated", status: "delivered", response_status: 200 },
      { id: "log3", event: "outflows.completed", status: "failed", response_status: 500 },
    ],
    childAccounts: new Map(),
    testDispatches: [],
  };
  let seq = 1;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : {};
      const parsed = new URL(req.url, "http://127.0.0.1");
      const pathname = parsed.pathname;
      const query = Object.fromEntries(parsed.searchParams.entries());
      const send = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      if (req.headers.authorization !== `Bearer ${process.env.NUVION_API_KEY}`) {
        return send(401, { status: "error", type: "error_auth_credentials_invalid", message: "Invalid key" });
      }

      if (req.method === "GET" && pathname === "/accounts") {
        if (query.entity_id) {
          const rows = store.childAccounts.get(query.entity_id) || [];
          return send(200, { status: "success", data: { data: rows } });
        }
        return send(200, { status: "success", data: { data: [{ id: "01ROOT_USD", currency: "USD", balance: { available: 0 } }] } });
      }

      if (req.method === "GET" && pathname === "/entity-webhooks") {
        return send(200, { status: "success", data: { data: [...store.webhooks.values()] } });
      }

      if (req.method === "POST" && pathname === "/entity-webhooks") {
        const id = `01P5WH${String(seq++).padStart(18, "0")}`;
        const wh = {
          id,
          url: body.url,
          description: body.description,
          enabled_events: body.enabled_events,
          status: "active",
          secret: "nv_wsk_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        };
        store.webhooks.set(id, wh);
        return send(201, { status: "success", data: wh });
      }

      const whMatch = pathname.match(/^\/entity-webhooks\/([^/]+)$/);
      if (req.method === "PATCH" && whMatch) {
        const wh = store.webhooks.get(whMatch[1]);
        if (!wh) return send(404, { status: "error", type: "error_resource_not_found", message: "Not found" });
        if (body.status) wh.status = body.status;
        wh.status_reason = undefined;
        return send(200, { status: "success", data: wh });
      }

      if (req.method === "GET" && pathname === "/webhook-logs") {
        return send(200, { status: "success", data: { data: store.webhookLogs } });
      }

      if (req.method === "POST" && pathname === "/webhook-tests") {
        store.testDispatches.push(body);
        return send(200, { status: "success", message: "Test webhook dispatched" });
      }

      if (req.method === "POST" && pathname === "/fx-quotes") {
        return send(201, {
          status: "success",
          data: {
            id: "01P5FXQUOTE",
            from: body.from_currency,
            to: body.to_currency,
            amount_from: body.amount_from || 1000,
            amount_to: 1450000,
            rate: 1450,
            quote: { status: "active", valid_for: 180 },
          },
        });
      }

      return send(404, { status: "error", type: "error_resource_not_found", message: `Unhandled ${req.method} ${pathname}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, store, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test("Phase 5: Webhook registration/reactivation, health ping, production snapshot, and zero-custody audit", async () => {
  const mock = await startPhase5MockNuvion();
  process.env.NUVION_BASE_URL = mock.baseUrl;

  try {
    const targetUrl = "https://payit-production.up.railway.app/webhook/nuvion";
    assert.equal(nuvionHealth.getDefaultNuvionWebhookUrl(), targetUrl);

    // 1. First registration creates webhook & returns one-time nv_wsk_ secret
    const reg1 = await nuvionHealth.ensureProductionWebhook();
    assert.equal(reg1.action, "created");
    assert.ok(reg1.secret.startsWith("nv_wsk_"));

    // 2. Second registration is idempotent (no duplicate webhook created!)
    const reg2 = await nuvionHealth.ensureProductionWebhook();
    assert.equal(reg2.action, "already_active");
    assert.equal(mock.store.webhooks.size, 1);

    // 3. Simulate Nuvion blacklisting -> ensureProductionWebhook reactivates it via PATCH!
    const storedWh = mock.store.webhooks.get(reg1.webhook.id);
    storedWh.status = "blacklisted";
    storedWh.status_reason = "Webhook delivery failure threshold exceeded";

    const reg3 = await nuvionHealth.ensureProductionWebhook();
    assert.equal(reg3.action, "reactivated");
    assert.equal(reg3.webhook.status, "active");

    // 4. Test webhook dispatch + `webhook.health` ping handling
    const testRes = await nuvionHealth.dispatchWebhookTest();
    assert.equal(testRes.webhookId, reg1.webhook.id);
    assert.equal(mock.store.testDispatches.length, 1);

    const pingRes = await nuvionWebhooks.processNuvionEvent({ event: "webhook.health", data: {} });
    assert.equal(pingRes.healthPing, true);

    // 5. Production health snapshot + Admin HTML card + zero secret leaks
    const snap = await nuvionHealth.collectNuvionHealthSnapshot({ includeQuote: true });
    assert.equal(snap.apiReachable, true);
    assert.equal(snap.primaryWebhook.status, "active");
    assert.equal(snap.recentLogs.succeeded, 2);
    assert.equal(snap.recentLogs.failed, 1);
    assert.equal(snap.indicativeQuote.rate, 1450);

    const cardHtml = nuvionHealth.formatAdminHealthCard(snap);
    assert.ok(cardHtml.includes("Nuvion Global Infrastructure Health"));
    assert.ok(cardHtml.includes("Beta Gate"));
    assert.ok(!cardHtml.includes(process.env.NUVION_API_KEY), "API key must NEVER appear in admin health card");
    assert.ok(!cardHtml.includes(process.env.NUVION_WEBHOOK_SECRET), "Webhook secret must NEVER appear in admin health card");

    const pub = nuvionHealth.getPublicHealthSummary();
    assert.equal(pub.configured, true);
    assert.equal(pub.publicLaunch, false);
    assert.ok(!JSON.stringify(pub).includes("nv_live_"));
    assert.ok(!JSON.stringify(pub).includes("nv_wsk_"));

    // 6. Zero-Custody Stranded-Balance Audit:
    //    - Intentional Card USD sub-account ($45.00) -> ALLOWED (not stranded!)
    //    - Idle GBP receiving account (£12.00) -> FLAGGED as stranded!
    const entId = "01P5ENT_AUDIT_1";
    db.upsertNuvionEntity({
      telegramId: 111222333,
      accountType: "personal",
      entityId: entId,
      entityType: "individual",
      legalName: "Beta Founder",
      email: "beta@proxim.local",
      status: "approved",
    });

    // Clean state first: only card USD balance exists
    mock.store.childAccounts.set(entId, [
      { id: "01ACC_CARD", currency: "USD", balance: { available: 4500 }, meta: { purpose: "card" } },
      { id: "01ACC_GBP", currency: "GBP", balance: { available: 0 }, meta: { purpose: "receiving" } },
    ]);
    const cleanAudit = await nuvionHealth.auditStrandedNuvionBalances();
    assert.equal(cleanAudit.cleanZeroCustody, true);
    assert.equal(cleanAudit.cardAllocatedUsd, 45);
    assert.equal(cleanAudit.strandedCount, 0);

    // Now simulate £12.00 stranded in GBP receiving account
    mock.store.childAccounts.set(entId, [
      { id: "01ACC_CARD", currency: "USD", balance: { available: 4500 }, meta: { purpose: "card" } },
      { id: "01ACC_GBP", currency: "GBP", balance: { available: 1200 }, meta: { purpose: "receiving" } },
    ]);
    const warnAudit = await nuvionHealth.auditStrandedNuvionBalances();
    assert.equal(warnAudit.cleanZeroCustody, false);
    assert.equal(warnAudit.strandedCount, 1);
    assert.equal(warnAudit.stranded[0].currency, "GBP");
    assert.equal(warnAudit.stranded[0].availableMajor, 12);
  } finally {
    mock.server.close();
  }
});

test.after(() => {
  try { fs.unlinkSync(tmpDbPath); } catch (_) {}
});
