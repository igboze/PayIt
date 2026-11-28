// src/app_api/schedules.js
// Persistent scheduled payments for the mobile app.
//
// The bot's in-memory scheduler keeps the user's PIN only in RAM, so every restart drops the
// jobs. Here the user approves a schedule once with a passkey + PIN (see actions.js
// "schedule.create"); the schedule is stored in SQLite and executed by this runner with the
// server-held operational key, the same key the bot already uses for background sweeps.
// Every run is re-checked against fraud_guard limits, and repeated failures pause the schedule.

const deps = {
  get db() { return require("../db"); },
  get walletLib() { return require("../wallet"); },
  get fraudGuard() { return require("../fraud_guard"); },
  get notify() { return require("../notify"); },
  get paj() { return require("../paj"); },
  get multichain() { return require("../multichain"); },
};
const overrides = {};
const dep = (name) => (name in overrides ? overrides[name] : deps[name]);
function __setTestDeps(o = {}) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setTestDeps cannot be used in production.");
  }
  for (const k of Object.keys(overrides)) delete overrides[k];
  Object.assign(overrides, o);
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MAX_FAILURES = 3;
let _ready = false;
let _timer = null;

function ensureTable() {
  if (_ready) return;
  dep("db").db.exec(`
    CREATE TABLE IF NOT EXISTS app_schedules (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id      INTEGER NOT NULL,
      kind             TEXT NOT NULL,
      frequency        TEXT NOT NULL,
      day              TEXT,
      time             TEXT NOT NULL,
      payment_json     TEXT NOT NULL,
      next_run_at      TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'active',
      failures         INTEGER NOT NULL DEFAULT 0,
      last_run_at      TEXT,
      last_result      TEXT,
      approved_device  TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_app_schedules_due ON app_schedules(status, next_run_at);
  `);
  _ready = true;
}

/** Next run strictly after `from`, in UTC. weekly: day = weekday name; monthly: day = 1–28. */
function computeNextRun({ frequency, day, time }, from = new Date()) {
  const [h, m] = String(time || "09:00").split(":").map(Number);
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), h, m, 0, 0));
  if (frequency === "daily") {
    if (d <= from) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  if (frequency === "weekly") {
    const target = Math.max(0, DAYS.indexOf(String(day || "monday").toLowerCase()));
    let add = (target - d.getUTCDay() + 7) % 7;
    d.setUTCDate(d.getUTCDate() + add);
    if (d <= from) d.setUTCDate(d.getUTCDate() + 7);
    return d;
  }
  const dom = Math.min(Math.max(parseInt(day, 10) || 1, 1), 28);
  d.setUTCDate(dom);
  if (d <= from) d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

function describe({ frequency, day, time }) {
  const t = time || "09:00";
  if (frequency === "daily") return `daily at ${t}`;
  if (frequency === "weekly") {
    const name = String(day || "monday");
    return `every ${name.charAt(0).toUpperCase()}${name.slice(1)} at ${t}`;
  }
  return `monthly on day ${Math.min(Math.max(parseInt(day, 10) || 1, 1), 28)} at ${t}`;
}

function rowOut(r) {
  if (!r) return null;
  const payment = JSON.parse(r.payment_json);
  return {
    id: Number(r.id), kind: r.kind, status: r.status, frequency: r.frequency, day: r.day, time: r.time,
    description: describe(r), nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, lastResult: r.last_result,
    amountUsdc: payment.amountUsdc, to: payment.recipientLabel || payment.toAddress, narration: payment.narration || null,
  };
}

function createSchedule({ telegramId, kind, frequency, day, time, payment, approvedDeviceId }) {
  ensureTable();
  if (frequency === "weekly" && day && !DAYS.includes(String(day).toLowerCase())) throw new Error("Pick a weekday.");
  const next = computeNextRun({ frequency, day, time }).toISOString();
  const res = dep("db").db.prepare(`
    INSERT INTO app_schedules (telegram_id, kind, frequency, day, time, payment_json, next_run_at, approved_device)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(Number(telegramId), kind, frequency, day || null, time, JSON.stringify(payment), next, approvedDeviceId || null);
  return getSchedule(telegramId, Number(res.lastInsertRowid));
}

function getSchedule(telegramId, id) {
  ensureTable();
  return rowOut(dep("db").db.prepare("SELECT * FROM app_schedules WHERE id = ? AND telegram_id = ?").get(Number(id), Number(telegramId)));
}

function listSchedules(telegramId) {
  ensureTable();
  return dep("db").db.prepare("SELECT * FROM app_schedules WHERE telegram_id = ? AND status != 'cancelled' ORDER BY next_run_at").all(Number(telegramId)).map(rowOut);
}

function setStatus(telegramId, id, status) {
  ensureTable();
  const res = dep("db").db.prepare("UPDATE app_schedules SET status = ? WHERE id = ? AND telegram_id = ? AND status != 'cancelled'").run(status, Number(id), Number(telegramId));
  return res.changes > 0;
}

async function runOne(r, now) {
  const db = dep("db");
  const walletLib = dep("walletLib");
  const payment = JSON.parse(r.payment_json);
  const telegramId = Number(r.telegram_id);
  const amount = Number(payment.amountUsdc);
  const accountType = payment.accountType === "business" ? "business" : "personal";
  const reference = r.kind === "transfer.user" ? `user:${payment.recipientId}`
    : r.kind === "payout.ngn" ? `${payment.bankCode}:${payment.accountNumber}`
      : payment.toAddress;
  const user = db.getUser(telegramId);
  if (!user) throw new Error("account not found");
  if (accountType === "business" && !user.business_deposit_address) throw new Error("business account not found");
  if (r.kind === "transfer.user") {
    const recipient = db.getUser(payment.recipientId) || db.getUser(Number(payment.recipientId));
    if (!recipient || String(recipient.deposit_address || "").trim().toLowerCase() !== String(payment.toAddress || "").trim().toLowerCase()) throw new Error("recipient account changed");
  }
  await dep("fraudGuard").assertOutboundAllowed({ telegramId, accountType, action: "app_schedule", amountUsd: amount, reference });
  const key = db.getSystemDecryptedPrivateKey(user, accountType);
  if (!key) throw new Error("wallet key unavailable");
  if (r.kind === "payout.ngn") return runBankPayout({ telegramId, accountType, amount, payment, key });
  const signer = walletLib.walletFromPrivateKey(key);
  const amountMicro = walletLib.parseToMicro(amount.toFixed(6));
  const tx = await walletLib.sendSponsoredOrDirectTransaction(signer, payment.toAddress, amountMicro, "0x", { waitForConfirmation: false });
  const txHash = tx.txHash || tx.hash;
  db.recordTransaction(telegramId, "scheduled_transfer", String(amountMicro), "completed", txHash, accountType, 18, "arc", payment.narration || null);
  return txHash;
}

/** NGN bank payout: open a Paj off-ramp order, then fund its address from the user's wallet. */
async function runBankPayout({ telegramId, accountType, amount, payment, key }) {
  const db = dep("db");
  const walletLib = dep("walletLib");
  const multichain = dep("multichain");
  const senderName = db.resolveSenderName(telegramId, accountType);
  const order = await dep("paj").createOfframpPayout({
    amountUsdc: amount, bankCode: payment.bankCode, accountNumber: payment.accountNumber,
    accountName: payment.accountName || undefined, narration: payment.narration || undefined, senderName,
  });
  const fundingAddress = order && order.address;
  const fundingAmount = Number((order && order.amount) || amount);
  if (!fundingAddress) throw new Error("bank partner didn't return a funding address; nothing was sent");
  // Never fund more than the user approved for this schedule.
  if (!(fundingAmount > 0) || fundingAmount > amount * 1.01) throw new Error("bank partner asked for a different amount; nothing was sent");
  const offrampFeeRate = Number(process.env.OFFRAMP_PLATFORM_FEE_RATE ?? 0.01);
  const feeUsdc = Number((fundingAmount * offrampFeeRate).toFixed(4));
  const feeRecipient =
    process.env.APP_FEE_RECIPIENT_ADDRESS ||
    process.env.PAYIT_DEV_FEE_ADDRESS ||
    process.env.FEE_RECIPIENT_ADDRESS ||
    "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359";
  let txHash = null;
  let feeTxHash = null;
  let rail = "arc";
  if (multichain.isSolanaAddress(fundingAddress)) {
    rail = "solana";
    const sol = multichain.deriveSolanaFromEvmKey(key);
    const tx = await multichain.sendSolanaTransfer({ keypair: sol.keypair, recipientAddress: fundingAddress, amount: fundingAmount });
    txHash = (tx && (tx.txHash || tx.signature)) || null;
    const solFeeRecipient = (process.env.SOLANA_FEE_RECIPIENT || "").trim() || "5ba1CAazPrdYYcaTYyzTqMExgCadu2aFauW24r28dh5g";
    if (feeUsdc > 0 && solFeeRecipient && multichain.isSolanaAddress(solFeeRecipient) && sol.solanaAddress !== solFeeRecipient) {
      try {
        const feeSolTx = await multichain.sendSolanaTransfer({ keypair: sol.keypair, recipientAddress: solFeeRecipient, amount: feeUsdc });
        if (feeSolTx && feeSolTx.success !== false) feeTxHash = feeSolTx.txHash || feeSolTx.signature || null;
      } catch (feeErr) {
        console.warn("[app_api:schedules:solana_fee_note]", feeErr.message);
      }
    }
  } else if (walletLib.isValidAddress(fundingAddress)) {
    const signer = walletLib.walletFromPrivateKey(key);
    const tx = await walletLib.sendSponsoredOrDirectTransaction(signer, fundingAddress, walletLib.parseToMicro(fundingAmount.toFixed(6)), "0x", { waitForConfirmation: true });
    txHash = (tx && (tx.txHash || tx.hash)) || null;
    if (feeUsdc > 0 && feeRecipient && walletLib.isValidAddress(feeRecipient) && String(signer.address || "").toLowerCase() !== feeRecipient.toLowerCase()) {
      try {
        const feeTx = await walletLib.sendSponsoredOrDirectTransaction(signer, feeRecipient, walletLib.parseToMicro(feeUsdc.toFixed(6)), "0x", { waitForConfirmation: true });
        feeTxHash = (feeTx && (feeTx.txHash || feeTx.hash)) || null;
      } catch (feeErr) {
        console.warn("[app_api:schedules:arc_fee_note]", feeErr.message);
      }
    }
  } else {
    throw new Error("unsupported funding address from the bank partner; nothing was sent");
  }
  const orderId = order.id || order.reference || txHash;
  db.recordOfframpOrder({
    orderId, telegramId, accountType, accountNumber: String(payment.accountNumber), bankCode: String(payment.bankCode),
    bankName: order.bankName || (order.bank && order.bank.name) || null, accountName: order.accountName || payment.accountName || null,
    amountUsdc: fundingAmount, feeUsdc, netAmountUsdc: fundingAmount, fiatAmount: order.fiatAmount || null, rate: order.rate || null, rail, txHash, feeTxHash,
    narration: payment.narration || null, senderName: senderName || null, status: "submitted",
  });
  db.recordTransaction(
    telegramId,
    "offramp",
    String(walletLib.parseToMicro(fundingAmount.toFixed(6))),
    "submitted",
    txHash || orderId,
    accountType,
    18,
    rail,
    payment.narration || null,
    {
      ...(order.fiatAmount ? { sourceCurrency: "NGN", sourceAmount: Number(order.fiatAmount) } : {}),
      counterpartyName: order.accountName || payment.accountName || null,
      counterpartyBank: order.bankName || (order.bank && order.bank.name) || null,
      counterpartyAccount: String(payment.accountNumber || ""),
    }
  );
  return txHash || orderId;
}

/** Runs every due schedule once. Returns { ran, failed }. Safe to call concurrently-free (single process). */
async function runDue(now = new Date()) {
  ensureTable();
  const db = dep("db");
  const due = db.db.prepare("SELECT * FROM app_schedules WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at LIMIT 50").all(now.toISOString());
  let ran = 0;
  let failed = 0;
  for (const r of due) {
    const next = computeNextRun(r, now).toISOString();
    // Claim the run first so a crash mid-send can never cause a double payment.
    const claimed = db.db.prepare("UPDATE app_schedules SET next_run_at = ?, last_run_at = ? WHERE id = ? AND next_run_at = ?").run(next, now.toISOString(), r.id, r.next_run_at);
    if (!claimed.changes) continue;
    const payment = JSON.parse(r.payment_json);
    try {
      const txHash = await runOne(r, now);
      db.db.prepare("UPDATE app_schedules SET failures = 0, last_result = ? WHERE id = ?").run(`sent ${txHash}`, r.id);
      ran++;
      try { await dep("notify").notify(Number(r.telegram_id), { title: "Scheduled payment sent", html: `🗓️ <b>Scheduled payment sent</b>\n$${Number(payment.amountUsdc).toFixed(2)} to ${payment.recipientLabel || payment.toAddress}` }); } catch (_) { }
    } catch (err) {
      failed++;
      const failures = Number(r.failures || 0) + 1;
      const status = failures >= MAX_FAILURES ? "paused" : "active";
      db.db.prepare("UPDATE app_schedules SET failures = ?, status = ?, last_result = ? WHERE id = ?").run(failures, status, `failed: ${String(err.message).slice(0, 200)}`, r.id);
      try { await dep("notify").notify(Number(r.telegram_id), { title: "Scheduled payment didn't go through", html: `⚠️ <b>Scheduled payment didn't go through</b>\n$${Number(payment.amountUsdc).toFixed(2)} to ${payment.recipientLabel || payment.toAddress}: ${String(err.message).replace(/[<>&]/g, "")}${status === "paused" ? "\nWe've paused this schedule after 3 failures." : ""}` }); } catch (_) { }
    }
  }
  return { ran, failed };
}

function startScheduleRunner(intervalMs = 60_000) {
  if (_timer) return _timer;
  _timer = setInterval(() => { runDue().catch((e) => console.warn("[app_schedules] runner error:", e.message)); }, intervalMs);
  if (typeof _timer.unref === "function") _timer.unref();
  return _timer;
}
function stopScheduleRunner() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { computeNextRun, describe, createSchedule, getSchedule, listSchedules, setStatus, runDue, startScheduleRunner, stopScheduleRunner, __setTestDeps };
