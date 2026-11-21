// src/nuvion_health.js
// Nuvion Phase 5 — Production Health Monitor, Webhook Lifecycle Manager & Zero-Custody Auditor
//
// Used by BOTH:
//  - CLI script: `scripts/nuvion_setup_webhook.js`
//  - Admin-only Telegram command: `/nuvion_health` (restricted to ADMIN_TELEGRAM_IDS)
//  - `GET /health` non-sensitive summary
//
// Zero secrets or raw PAN/CVV are ever returned or logged.

const nuvion = require("./nuvion");
const db = require("./db");
const apiRoutes = require("./api_routes");

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getDefaultNuvionWebhookUrl() {
  const base = apiRoutes.getPublicBaseUrl().replace(/\/+$/, "");
  return `${base}/webhook/nuvion`;
}

function getLaunchModeSummary() {
  const configured = nuvion.isNuvionConfigured();
  const publicLaunch = String(process.env.NUVION_PUBLIC_LAUNCH || "").toLowerCase() === "true";
  const betaIds = String(process.env.NUVION_BETA_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const webhookSecretSet = Boolean((process.env.NUVION_WEBHOOK_SECRET || "").trim());
  const fxMarginBps = nuvion.getFxMarginBps();

  return {
    configured,
    env: nuvion.getEnvironment(),
    baseUrl: nuvion.getBaseUrl(),
    apiVersion: nuvion.getApiVersion(),
    publicLaunch,
    launchModeLabel: !configured ? "Not Configured" : publicLaunch ? "PUBLIC LIVE" : `Beta Gate (${betaIds.length} beta IDs)`,
    webhookSecretSet,
    fxMarginBps,
    fxMarginPct: `${(fxMarginBps / 100).toFixed(2)}%`,
    expectedWebhookUrl: getDefaultNuvionWebhookUrl(),
  };
}

/**
 * Local SQLite snapshot of Nuvion entities, active cards, and job queues (100% read-only).
 */
function getLocalNuvionStats() {
  db.ensureNuvionSchema();

  const entityCounts = {};
  try {
    const rows = db.prepare("SELECT status, COUNT(*) AS cnt FROM nuvion_entities GROUP BY status").all();
    for (const r of rows) entityCounts[String(r.status || "unknown")] = Number(r.cnt || 0);
  } catch (_) {}

  let activeCards = 0;
  try {
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM nuvion_cards WHERE status IN ('active', 'blocked')").get();
    activeCards = Number(row?.cnt || 0);
  } catch (_) {}

  const jobCounts = {
    funding_in_transit: 0,
    retry_pending: 0,
    refund_pending: 0,
    interac_open: 0,
    completed: 0,
    failed: 0,
  };
  try {
    const rows = db.prepare("SELECT job_type, state, COUNT(*) AS cnt FROM nuvion_jobs GROUP BY job_type, state").all();
    for (const r of rows) {
      const cnt = Number(r.cnt || 0);
      if (r.state === "funding_in_transit") jobCounts.funding_in_transit += cnt;
      else if (r.state === "retry_pending") jobCounts.retry_pending += cnt;
      else if (r.state === "refund_pending") jobCounts.refund_pending += cnt;
      else if (r.state === "completed") jobCounts.completed += cnt;
      else if (r.state === "failed") jobCounts.failed += cnt;
      if (r.job_type === "interac_funding" && ["awaiting_user", "processing", "pending_settlement"].includes(r.state)) {
        jobCounts.interac_open += cnt;
      }
    }
  } catch (_) {}

  return {
    entities: entityCounts,
    activeCards,
    jobs: jobCounts,
  };
}

/**
 * Lightweight non-sensitive Nuvion summary for `GET /health`.
 */
function getPublicHealthSummary() {
  const launch = getLaunchModeSummary();
  let pendingRetries = 0;
  try {
    const local = getLocalNuvionStats();
    pendingRetries = (local.jobs.retry_pending || 0) + (local.jobs.refund_pending || 0);
  } catch (_) {}

  return {
    configured: launch.configured,
    env: launch.env,
    publicLaunch: launch.publicLaunch,
    webhookSecretSet: launch.webhookSecretSet,
    pendingRetries,
  };
}

/**
 * Full read-only production health check against Nuvion API:
 *  - GET /accounts?limit=5 (connectivity + root operational accounts)
 *  - GET /entity-webhooks?limit=20 (active vs blacklisted status!)
 *  - GET /webhook-logs?limit=10 (recent delivery success/fail metrics)
 *  - Optional non-mutating indicative FX quote (`includeQuote: true`)
 */
async function collectNuvionHealthSnapshot({ includeQuote = false } = {}) {
  const launch = getLaunchModeSummary();
  const local = getLocalNuvionStats();
  const snapshot = {
    launch,
    local,
    apiReachable: false,
    apiError: null,
    rootAccountsCount: 0,
    webhooks: [],
    primaryWebhook: null,
    recentLogs: { total: 0, succeeded: 0, failed: 0, latest: [] },
    indicativeQuote: null,
  };

  if (!launch.configured) {
    snapshot.apiError = "NUVION_API_KEY is not configured.";
    return snapshot;
  }

  // 1. Read-only connectivity check via GET /accounts?limit=5
  try {
    const accRes = await nuvion.listAccounts({ limit: 5 });
    const rows = accRes?.data || [];
    snapshot.apiReachable = true;
    snapshot.rootAccountsCount = rows.length;
  } catch (err) {
    snapshot.apiError = err.message;
    return snapshot;
  }

  // 2. Read-only webhook inspection via GET /entity-webhooks
  try {
    const whRes = await nuvion.listWebhooks({ limit: 20 });
    const list = whRes?.data || [];
    snapshot.webhooks = list.map((w) => ({
      id: w.id,
      url: w.url,
      status: w.status,
      statusReason: w.status_reason || null,
      allEvents: Boolean(w.enabled_events?.all),
    }));
    snapshot.primaryWebhook =
      snapshot.webhooks.find((w) => w.url === launch.expectedWebhookUrl) ||
      snapshot.webhooks[0] ||
      null;
  } catch (err) {
    snapshot.webhooksError = err.message;
  }

  // 3. Read-only delivery log inspection via GET /webhook-logs
  try {
    const logRes = await nuvion.listWebhookLogs({
      entityWebhookId: snapshot.primaryWebhook?.id || null,
      limit: 10,
    });
    const logs = logRes?.data || [];
    let succeeded = 0;
    let failed = 0;
    for (const l of logs) {
      const code = Number(l.response_status || l.status_code || 0);
      const ok = l.status === "delivered" || l.status === "success" || (code >= 200 && code < 300);
      if (ok) succeeded++;
      else failed++;
    }
    snapshot.recentLogs = {
      total: logs.length,
      succeeded,
      failed,
      latest: logs.slice(0, 5).map((l) => ({
        event: l.event || l.event_type || "unknown",
        status: l.status || l.response_status || "n/a",
        created: l.created || l.created_at || null,
      })),
    };
  } catch (err) {
    snapshot.logsError = err.message;
  }

  // 4. Optional indicative FX quote (zero balance mutation)
  if (includeQuote) {
    try {
      const q = await nuvion.createFxQuote({
        fromCurrency: "USD",
        toCurrency: "NGN",
        amountFrom: 1000, // $10.00 indicative quote
      });
      snapshot.indicativeQuote = {
        pair: "USD -> NGN",
        rate: q.rate,
        amountFrom: nuvion.fromNuvionMinor(q.amount_from),
        amountTo: nuvion.fromNuvionMinor(q.amount_to),
      };
    } catch (err) {
      snapshot.indicativeQuoteError = err.message;
    }
  }

  return snapshot;
}

/**
 * Idempotently ensure the Proxim webhook URL is registered and `active` on Nuvion:
 *  - If already registered and `active` -> returns existing webhook (no duplicate!)
 *  - If already registered and `blacklisted` or `inactive` -> reactivates via PATCH /entity-webhooks/{id} ({ status: "active" })
 *  - If not registered yet -> creates via POST /entity-webhooks ({ url, enabled_events: { all: true } })
 *    and returns the one-time `secret` (`nv_wsk_...`) so the operator can save it to NUVION_WEBHOOK_SECRET!
 */
async function ensureProductionWebhook({ url = null, description = "Proxim Global Production Webhook" } = {}) {
  const targetUrl = String(url || getDefaultNuvionWebhookUrl()).trim();
  if (!targetUrl.startsWith("https://") && !targetUrl.startsWith("http://127.0.0.1")) {
    throw new Error(`Nuvion webhooks require an HTTPS URL (got: ${targetUrl}).`);
  }

  const listed = await nuvion.listWebhooks({ limit: 50 });
  const existing = (listed?.data || []).find((w) => String(w.url || "").replace(/\/+$/, "") === targetUrl.replace(/\/+$/, ""));

  if (existing) {
    if (String(existing.status || "").toLowerCase() === "active") {
      return { action: "already_active", webhook: existing, secret: null };
    }
    const reactivated = await nuvion.updateWebhook(existing.id, { status: "active" });
    return { action: "reactivated", webhook: reactivated, secret: null };
  }

  const created = await nuvion.createWebhook({
    url: targetUrl,
    enabledEvents: { all: true },
    description,
  });
  return {
    action: "created",
    webhook: created,
    secret: created?.secret || null,
  };
}

/**
 * Send a live test event (`inflows.completed`) via POST /webhook-tests to verify
 * HTTPS reachability, HMAC-SHA256 verification, and immediate 200 OK acknowledgement.
 */
async function dispatchWebhookTest({ webhookId = null, eventGroup = "inflows", eventName = "completed" } = {}) {
  let targetId = webhookId;
  if (!targetId) {
    const listed = await nuvion.listWebhooks({ limit: 20 });
    const expected = getDefaultNuvionWebhookUrl().replace(/\/+$/, "");
    const match = (listed?.data || []).find((w) => String(w.url || "").replace(/\/+$/, "") === expected) || (listed?.data || [])[0];
    if (!match?.id) {
      throw new Error("No registered Nuvion webhook found. Run --register-webhook first.");
    }
    targetId = match.id;
  }
  const res = await nuvion.sendTestWebhook({ entityWebhookId: targetId, eventGroup, eventName });
  return { webhookId: targetId, response: res };
}

/**
 * Zero-Custody Audit: inspect every approved child entity's live Nuvion accounts and flag
 * any non-zero idle balance OUTSIDE intentional Load-to-Spend card USD sub-accounts (`purpose: "card"`).
 */
async function auditStrandedNuvionBalances() {
  db.ensureNuvionSchema();
  const approvedEntities = db
    .prepare("SELECT * FROM nuvion_entities WHERE status = 'approved' ORDER BY id ASC")
    .all();

  const cardAccountIds = new Set(
    db.prepare("SELECT account_id FROM nuvion_accounts WHERE purpose = 'card'").all().map((r) => r.account_id)
  );
  for (const row of db.prepare("SELECT account_id FROM nuvion_cards WHERE status != 'deleted'").all()) {
    cardAccountIds.add(row.account_id);
  }

  const stranded = [];
  let checkedEntities = 0;
  let cardAllocatedUsd = 0;

  for (const ent of approvedEntities) {
    checkedEntities++;
    try {
      const accRes = await nuvion.listAccounts({ entityId: ent.entity_id, limit: 50 });
      const accounts = accRes?.data || [];
      for (const acc of accounts) {
        const availMinor = Math.round(Number(acc?.balance?.available || 0));
        if (availMinor <= 0) continue;

        const isCardSubAccount =
          acc?.meta?.purpose === "card" || cardAccountIds.has(acc.id);

        if (isCardSubAccount) {
          cardAllocatedUsd += nuvion.fromNuvionMinor(availMinor);
          continue;
        }

        stranded.push({
          telegramId: ent.telegram_id,
          accountType: ent.account_type,
          entityId: ent.entity_id,
          accountId: acc.id,
          currency: acc.currency,
          availableMinor: availMinor,
          availableMajor: nuvion.fromNuvionMinor(availMinor),
        });
      }
    } catch (err) {
      stranded.push({
        telegramId: ent.telegram_id,
        entityId: ent.entity_id,
        error: err.message,
      });
    }
  }

  return {
    checkedEntities,
    strandedCount: stranded.filter((s) => !s.error).length,
    stranded,
    cardAllocatedUsd: Math.round((cardAllocatedUsd + Number.EPSILON) * 100) / 100,
    cleanZeroCustody: stranded.length === 0,
  };
}

/**
 * Render a clean Telegram HTML status card for `/nuvion_health`.
 */
function formatAdminHealthCard(snapshot) {
  const l = snapshot.launch;
  const loc = snapshot.local;
  const wh = snapshot.primaryWebhook;

  const whStatus = !wh
    ? "⚠️ Not registered"
    : wh.status === "active"
      ? `✅ Active (<code>${escapeHtml(wh.id)}</code>)`
      : `🚨 <b>${escapeHtml(String(wh.status).toUpperCase())}</b>${wh.statusReason ? ` — ${escapeHtml(wh.statusReason)}` : ""}`;

  const approvedCount = loc.entities.approved || 0;
  const pendingCount = (loc.entities.pending || 0) + (loc.entities.in_review || 0) + (loc.entities.submitted || 0);
  const stuckCount = (loc.jobs.retry_pending || 0) + (loc.jobs.refund_pending || 0);

  const lines = [
    `🛰️ <b>Nuvion Global Infrastructure Health</b>`,
    `──────────────────────────`,
    `• <b>Environment:</b> <code>${escapeHtml(l.env)}</code> (${escapeHtml(l.apiVersion)})`,
    `• <b>Launch Mode:</b> <b>${escapeHtml(l.launchModeLabel)}</b>`,
    `• <b>FX Margin:</b> ${escapeHtml(l.fxMarginPct)} (${l.fxMarginBps} bps)`,
    `• <b>API Connectivity:</b> ${snapshot.apiReachable ? `✅ Connected (${snapshot.rootAccountsCount} root accounts)` : `❌ ${escapeHtml(snapshot.apiError || "Unavailable")}`}`,
    `• <b>Webhook Secret:</b> ${l.webhookSecretSet ? "✅ Configured" : "⚠️ Missing NUVION_WEBHOOK_SECRET"}`,
    `• <b>Webhook Status:</b> ${whStatus}`,
    `• <b>Recent Deliveries:</b> ${snapshot.recentLogs.succeeded}/${snapshot.recentLogs.total} OK (${snapshot.recentLogs.failed} failed)`,
    `──────────────────────────`,
    `• <b>Entities:</b> ${approvedCount} approved · ${pendingCount} pending`,
    `• <b>Active USD Cards:</b> ${loc.activeCards}`,
    `• <b>Jobs:</b> ${loc.jobs.funding_in_transit} in-transit · ${loc.jobs.interac_open} open Interac · ${stuckCount > 0 ? `⚠️ ${stuckCount} retry/refund pending` : "✅ 0 stuck"}`,
  ];

  if (snapshot.indicativeQuote) {
    lines.push(`• <b>Live Indicative FX:</b> 1 USD = ₦${Number(snapshot.indicativeQuote.rate || 0).toLocaleString("en-NG")}`);
  }

  return lines.join("\n");
}

module.exports = {
  getDefaultNuvionWebhookUrl,
  getLaunchModeSummary,
  getLocalNuvionStats,
  getPublicHealthSummary,
  collectNuvionHealthSnapshot,
  ensureProductionWebhook,
  dispatchWebhookTest,
  auditStrandedNuvionBalances,
  formatAdminHealthCard,
};
