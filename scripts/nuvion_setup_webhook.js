#!/usr/bin/env node
// scripts/nuvion_setup_webhook.js
// Production-Safe Nuvion Phase 5 Setup, Webhook Registration & Zero-Custody Audit CLI
//
// Usage:
//   node scripts/nuvion_setup_webhook.js --check                (Read-only API, webhook & DB check — default)
//   node scripts/nuvion_setup_webhook.js --check --quote        (Also runs indicative non-mutating USD->NGN FX quote)
//   node scripts/nuvion_setup_webhook.js --register-webhook     (Idempotently registers or reactivates /webhook/nuvion)
//   node scripts/nuvion_setup_webhook.js --register-webhook --url=https://payit-production.up.railway.app/webhook/nuvion
//   node scripts/nuvion_setup_webhook.js --test-webhook         (Sends live POST /webhook-tests ping to verify 200 OK + HMAC)
//   node scripts/nuvion_setup_webhook.js --check-stranded       (Audits approved entities for any idle non-card Nuvion funds)
//
// SAFETY: NEVER submits dummy KYC or transfers funds. Safe to run against live https://api.nuvion.co.

require("dotenv").config();
const nuvionHealth = require("../src/nuvion_health");

function parseArgs(argv) {
  const args = {
    check: false,
    quote: false,
    registerWebhook: false,
    testWebhook: false,
    checkStranded: false,
    url: null,
    webhookId: null,
  };
  for (const a of argv.slice(2)) {
    if (a === "--check") args.check = true;
    else if (a === "--quote") args.quote = true;
    else if (a === "--register-webhook") args.registerWebhook = true;
    else if (a === "--test-webhook") args.testWebhook = true;
    else if (a === "--check-stranded") args.checkStranded = true;
    else if (a.startsWith("--url=")) args.url = a.slice("--url=".length).trim();
    else if (a.startsWith("--webhook-id=")) args.webhookId = a.slice("--webhook-id=".length).trim();
  }
  if (!args.check && !args.registerWebhook && !args.testWebhook && !args.checkStranded) {
    args.check = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log("=== Proxim x Nuvion Phase 5 Operator CLI ===");
  const launch = nuvionHealth.getLaunchModeSummary();
  console.log(`Environment : ${launch.env} (${launch.baseUrl}, X-API-Version: ${launch.apiVersion})`);
  console.log(`Launch Mode : ${launch.launchModeLabel}`);
  console.log(`FX Margin   : ${launch.fxMarginPct} (${launch.fxMarginBps} bps)`);
  console.log(`Webhook URL : ${args.url || launch.expectedWebhookUrl}`);
  console.log(`WH Secret   : ${launch.webhookSecretSet ? "SET" : "NOT SET"}`);
  console.log("");

  if (!launch.configured) {
    console.error("ERROR: NUVION_API_KEY is not set in .env or environment. Aborting.");
    process.exit(1);
  }

  if (args.registerWebhook) {
    console.log("[1] Ensuring Nuvion webhook is registered and active...");
    const res = await nuvionHealth.ensureProductionWebhook({ url: args.url });
    console.log(`    Action : ${res.action}`);
    console.log(`    ID     : ${res.webhook?.id}`);
    console.log(`    URL    : ${res.webhook?.url}`);
    console.log(`    Status : ${res.webhook?.status}`);
    if (res.secret) {
      console.log("");
      console.log("==================================================================");
      console.log("IMPORTANT: COPY THIS SIGNING SECRET NOW (SHOWN ONLY ONCE BY NUVION)");
      console.log(`NUVION_WEBHOOK_SECRET=${res.secret}`);
      console.log("Save it in Railway Variables & your local .env, then restart!");
      console.log("==================================================================");
    }
    console.log("");
  }

  if (args.testWebhook) {
    console.log("[2] Sending live Nuvion test webhook event (inflows.completed)...");
    const testRes = await nuvionHealth.dispatchWebhookTest({ webhookId: args.webhookId });
    console.log(`    Webhook ID : ${testRes.webhookId}`);
    console.log(`    Response   : ${JSON.stringify(testRes.response)}`);
    console.log("");
  }

  if (args.check) {
    console.log("[3] Running read-only Nuvion production health check...");
    const snap = await nuvionHealth.collectNuvionHealthSnapshot({ includeQuote: args.quote });
    console.log(`    API Reachable     : ${snap.apiReachable ? "YES" : `NO (${snap.apiError})`}`);
    console.log(`    Root Accounts     : ${snap.rootAccountsCount}`);
    console.log(`    Registered Hooks  : ${snap.webhooks.length}`);
    for (const wh of snap.webhooks) {
      console.log(`      - ${wh.id} | ${wh.status} | ${wh.url}${wh.statusReason ? ` (${wh.statusReason})` : ""}`);
    }
    console.log(`    Recent Deliveries : ${snap.recentLogs.succeeded}/${snap.recentLogs.total} OK (${snap.recentLogs.failed} failed)`);
    if (snap.indicativeQuote) {
      console.log(`    Indicative Quote  : $${snap.indicativeQuote.amountFrom} USD -> ₦${snap.indicativeQuote.amountTo.toLocaleString("en-NG")} (rate: ${snap.indicativeQuote.rate})`);
    }
    console.log(`    Local Entities    : ${JSON.stringify(snap.local.entities)}`);
    console.log(`    Active USD Cards  : ${snap.local.activeCards}`);
    console.log(`    Job Queue         : ${JSON.stringify(snap.local.jobs)}`);
    console.log("");
  }

  if (args.checkStranded) {
    console.log("[4] Auditing approved entities for stranded non-card balances (Zero-Custody Check)...");
    const audit = await nuvionHealth.auditStrandedNuvionBalances();
    console.log(`    Entities Audited   : ${audit.checkedEntities}`);
    console.log(`    Card Sub-Accts USD : $${audit.cardAllocatedUsd.toFixed(2)} (intentional Load-to-Spend)`);
    console.log(`    Stranded Non-Card  : ${audit.strandedCount}`);
    if (audit.cleanZeroCustody) {
      console.log("    RESULT             : PASS — Zero stranded funds in Nuvion!");
    } else {
      console.log("    RESULT             : WARNING — Non-zero idle balances found:");
      for (const s of audit.stranded) {
        console.log(`      - TG:${s.telegramId} (${s.entityId}) | ${s.currency || "ERR"} ${s.availableMajor ?? s.error}`);
      }
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
