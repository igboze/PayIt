# PayIT Multichain — Live Smoke Test Script (~$5)

**Date prepared:** 2026-09-30 · **Codebase state:** Phases 1–4 complete (dual-chain cash-out, Move Funds, NEAR deposits, settlement daemon)
**Environment pre-flight (already run, read-only):**

| Check | Result |
|---|---|
| paj credentials (`PAJCASH_API_KEY`) — live `getRates` | ✅ OK |
| NEAR 1Click key — partner `payit`, JWT exp **2027-09-30** | ✅ OK |
| Solana fee payer `5ba1CAaz…8dh5g` balance | ⚠️ **0.0089 SOL — below 0.01 minimum. Top up ~0.05 SOL before the Arc→Solana leg** |
| NEAR→Base quoting | ⚠️ **"Quoting for this pair is not available" at 13:21 UTC** — solver liquidity is intermittent; retry when testing |
| Arc rail for paj (`PAJ_ARC_OFFRAMP_ENABLED`) | ⏸️ Not set → stays `false`. Cash-out tests use the **Solana rail**; Arc rail goes live only after paj confirms the chain enum + USDC mint |

---

## Step 0 — Start the bot & confirm the daemon

1. Deploy/start the bot on the latest code (`node bot.js` or your process manager).
2. In the server logs you should see one line:
   `[settlement_daemon] started: evm_sweep@90s, cctp_inbound_recovery@20s, cctp_burn_retry@60s, near_poll@60s`
3. Fund the Solana fee payer: send **~0.05 SOL** to `5ba1CAazPrdYYcaTYyzTqMExgCadu2aFauW24r28dh5g`.

**Observer** (run on the server any time):
```bash
node -e "process.env.PAYIT_DB_PATH='./payit.db'; const db=require('./src/db');
console.log(db.getRecentSettlementRuns(null,8).map(r=>r.task+':'+r.status).join(' | '))"
```
Expect steady `succeeded` rows for all four tasks; `failed` rows show the error.

---

## Step 1 — NEAR deposit ($5)

1. Open the bot → **💰 My Money → 📥 Add Money → Ⓝ Deposit from NEAR**.
2. Enter `5`. The bot replies with a **one-time NEAR address** (+ memo), valid 30 min.
3. From any NEAR wallet (Meteor/Here/Ref), send **exactly 5.00 USDC** to that address (memo if shown).
4. Tap **🔄 Check Bridge Status** as it progresses:
   `Waiting for deposit… → Deposit seen → Bridging to Base → SUCCESS`

**Expected:** within ~2–5 min of the NEAR confirm, the EVM sweeper picks up the Base USDC, CCTPs it to Arc, and you get a "🎉 Deposit Settled & Credited!" message. **💰 My Money** shows $5 (minus any slippage) on **Arc**.

**If quoting was unavailable** (as at prep time): the bot says the bridge couldn't quote — wait a few minutes and retry Step 1. No funds move until a quote succeeds.

**Verify on-chain:**
```bash
node -e "process.env.PAYIT_DB_PATH='./payit.db'; const db=require('./src/db');
console.log(db.getRecentNearDeposits ? db.getRecentNearDeposits() : db._db.prepare('SELECT id,amount_usdc,status,deposit_address FROM near_deposits ORDER BY id DESC LIMIT 3').all())"
```

---

## Step 2 — Move Funds Arc → Solana ($2)

1. **💰 My Money → 🔀 Move Funds → ⚡ Arc → Solana**.
2. Enter `2`, confirm with PIN.
3. Expect: `✅ Move Submitted` with an Arc tx hash, then a "Deposit Settled"-style confirmation on Solana within ~1–5 min.
4. **💰 My Money** should now show the split (e.g. Arc ~$3 | Solana ~$2).

**Verify:** the fee payer must be funded (Step 0.3) or the burn is refused *before* any funds move — fund it and the daemon's `cctp_burn_retry` completes it automatically within 60s. Watch with:
```bash
node -e "process.env.PAYIT_DB_PATH='./payit.db'; const db=require('./src/db');
console.log(db.getRecentCctpBurnsByUser(<YOUR_TG_ID>,3))"
```

---

## Step 3 — Move Funds Solana → Arc ($1)

1. **🔀 Move Funds → ☀️ Solana → Arc**, amount `1`, PIN.
2. Expect `✅ Move Submitted` with a Solana burn sig; Arc credit confirmation follows in ~1–5 min.
```bash
node -e "process.env.PAYIT_DB_PATH='./payit.db'; const db=require('./src/db');
console.log(db.getRecentInboundByUser(<YOUR_TG_ID>,3))"
```

---

## Step 4 — Cash out via paj (Solana rail)

1. **💵 Cash Out to Naira** → amount `1` (or your test amount) → since Arc rail is disabled, the flow uses **☀️ Solana** automatically (or pick it if asked).
2. Enter your bank (`Bank · Account number · Account name`), confirm PIN.
3. Expect: `✅ Cash out submitted! Naira arrives in ~1–2 minutes.` Check your bank account / paj dashboard for the NGN credit.

---

## Sign-off

| # | Test | Pass criteria |
|---|---|---|
| 1 | NEAR deposit | $5 lands on Arc with credit message; `near_deposits` row `SUCCESS`; sweeper tx on Arcscan |
| 2 | Arc→Solana move | Solana balance increases by $2 within 5 min; burn row `completed` |
| 3 | Solana→Arc move | Arc balance increases by $1 within 5 min; inbound row `completed` |
| 4 | Cash out | NGN arrives; paj order settles from the Solana rail |
| 5 | Daemon | all four tasks `succeeded` in `settlement_runs`; no `interrupted` rows |

## If something fails

- **NEAR side:** funds auto-refund to your derived NEAR refund address on failure/expiry (bot shows `↩️ Refunded`).
- **Stuck Arc→Solana mint:** fund the fee payer → daemon retries within 60s, or run `/retry_cctp` (admin).
- **Stuck Solana→Arc mint:** `cctp_inbound_recovery` retries automatically every 20s (up to 30 attempts).
- **Anything else:** `settlement_runs` + `cctp_pending_burns` / `cctp_inbound_transfers` / `near_deposits` rows give the exact state to report.
