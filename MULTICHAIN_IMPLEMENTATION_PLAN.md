# PayIT — Two-Chain (Arc + Solana) + NEAR Deposit Implementation Plan

**Status:** approved direction, ready to execute
**Date:** 2026-09-30
**Scope:** paj dual-chain settlement (Arc + Solana), NEAR deposits via NEAR Intents, CCTP repositioned as user-facing "Move Funds", multichain balance model

---

## 0. Product model (the target state)

One user, two standing balances, two offramp rails:

| Balance | Asset | Location | Offramp rail |
|---|---|---|---|
| **Arc** | native USDC | `deposit_address` / `business_deposit_address` | paj `chain: ARC` |
| **Solana** | SPL USDC | derived keypair + `solana_deposit_address` | paj `chain: SOLANA` |

- User sees: `$247.50 total — $182.00 on Arc · $65.50 on Solana`
- Spending always debits **one specific chain balance**. CCTP is never automatic; it is a user-consented "Move Funds" action.
- EVM-chain deposits still sweep to Arc (unchanged). Solana deposits credit the Solana balance (no forced bridge). NEAR deposits bridge via NEAR Intent and credit the Solana balance.

---

## 0.1 Open questions to confirm before Phase 1 / Phase 3

**For paj (blocking Phase 1):**
1. Exact `chain` enum value for Arc in `/onramp` and `/offramp` (string casing, e.g. `"ARC"` vs `"ARC_MAINNET"`).
2. USDC mint/address paj expects on Arc mainnet (native precompile vs ERC-20 address).
3. Does paj Arc support **both** onramp settlement and offramp funding, or offramp only?
4. Webhook payload differences for Arc-settled orders (address format in `data.recipient` / `data.txHash`).
5. Fee/rate differences for Arc vs Solana rails (affects rail auto-selection logic).

**For NEAR Intents (blocking Phase 3):**
6. Quote API endpoint + contract address for the intent (NEAR Intents / 1Click), and the exact `deposit_for_burn`-style flow for `USDC(NEAR) → USDC(Solana)`.
7. Whether the omni/deposit-address mode is available (avoids pre-funding the derived NEAR account with gas) or we must airdrop ~0.05 NEAR per user.
8. Solver liquidity at expected ticket sizes ($10–$1,000); test with real small amounts.

---

## Phase 1 — Dual-chain cash-out + per-chain balance model

**Goal:** cash out directly from whichever chain holds the funds. No more Arc→Solana CCTP burn on offramp.

### DB (`src/db.js`)

1. Add `chain TEXT NOT NULL DEFAULT 'arc'` column to `transactions` (migration for existing rows: default `arc`).
2. Add `near_deposit_address TEXT` to `users` (created in this phase even though NEAR arrives in Phase 3, so onboarding doesn't need a revisit — or defer; decide at implementation).
3. New helper functions:
   - `getChainBalanceMicro(telegramId, chain, accountType)` — on-chain reads (Arc native balance / SPL USDC), no new cache table yet.
   - `recordTransaction(..., chain)` — thread the new column through.

### paj integration (`src/paj.js`, `src/offramp.js`)

4. Make `chain` / `mint` explicit order parameters everywhere; **remove the Solana hardcoded defaults** (`chain: params.chain || "SOLANA"`, SPL mint default).
5. New env: `PAJ_ARC_CHAIN="ARC"`, `PAJ_ARC_MINT=...` (from Q1/Q2). Solana values stay as `PAJ_SOLANA_CHAIN` / `PAJ_SOLANA_MINT`.

### Executor (`agent/executor.js`)

6. `executeOfframp(...)`: add `rail` decision before order creation:
   - Arc rail → paj order with Arc chain → `walletLib.sendFromWallet` (plain native-USDC transfer).
   - Solana rail → paj order with Solana chain → `multichain.sendSolanaTransfer` from derived keypair (today's fallback becomes primary).
   - Rail selection: `options.preferredRail || auto` where auto = Arc if Arc balance covers amount, else Solana if it covers, else auto-earn liquidation + Arc.
7. **Remove** the CCTP Arc→Solana burn from the offramp path (`cctpBridge.executeArcToSolanaCctpBurn` call at the `isTargetSolana` branch). Keep `executeArcToSolanaCctpBurn` exported for Phase 2.
8. Keep the generic EVM-address branch as defensive fallback (paj returning a non-Arc EVM address).

### Bot (`bot.js`)

9. `await_withdraw_amount`: replace the Solana-balance-sum logic with per-chain display (total + breakdown). **Remove the hardcoded third-party address `wr1UudCbdBs1yEXf2dVoKnceeRWcX47Hi2Wzaz66C7j`** from the balance aggregation (appears here and in `executor.js`).
10. `confirm_withdraw`: pass chosen rail through to `executeOfframp`; receipt shows which rail was used.
11. Add rail picker inline keyboard when the user has meaningful balances on both chains ("⚡ Arc (fastest)" / "☀️ Solana").

### Onramp

12. If paj supports Arc onramp settlement (Q3): default `chain: ARC`, recipient = `deposit_address`; keep Solana as explicit user option. Webhook handler (`src/webhook_server.js`): extend the existing "directly settled" branch to Arc-settled orders — credit ledger, no bridge. If paj only supports Solana onramp for now: keep existing `autoBridgeSolanaToArc` flow untouched behind `AUTO_BRIDGE_SOLANA_TO_ARC=true` and revisit.

### Rollout

13. Feature-flag the Arc rail: `PAJ_ARC_OFFRAMP_ENABLED=true|false`. Roll back = flip flag.
14. Freeze `retryPendingCctpBurns` usage for the offramp direction; it stays for Phase 2 Move Funds recovery.

**Exit criteria:** cash out works end-to-end from an Arc-funded balance with zero Solana involvement; from a Solana-funded balance with zero Arc involvement; history shows correct `chain` per tx.

---

## Phase 2 — "Move Funds" (CCTP becomes a product feature)

**Goal:** user-initiated Arc↔Solana transfers, gasless, reusing the existing CCTP machinery.

### New flow

1. New conversation states in `bot.js`: `move_funds_amount`, `move_funds_direction`, `confirm_move`.
2. Arc → Solana: existing `executeArcToSolanaCctpBurn` + `completeCctpWithdrawalOnSolana` (fee payer funded, ATA pre-creation) — unchanged, now user-triggered.
3. Solana → Arc: existing `executeSolanaCctpBurn` + `completeInboundCctpTransferFlow` — unchanged, now user-triggered.
4. UX: show bridging status ("Burned on Arc… waiting for Circle attestation… minted ✓"), reuse the `cctp_pending_burns` / `cctp_inbound_transfers` tables and their retry/recovery paths.
5. Sanity caps: warn if amount is small relative to bridge time (e.g. "< $5 will take ~1 min to bridge").

**Exit criteria:** user can move $10 both directions from the bot UI and watch status updates; recovery cron still rescues interrupted moves after restart.

### Implementation status (2026-09-30) — DONE, tested

Delivered as designed above, with these naming/structural choices:

- `agent/executor.js` → new `moveFundsBetweenChains(userWallet, { direction, amountUsdc, telegramId, accountType, bot })`. Per-direction on-chain balance check (Arc native micro / Solana SPL), fee-payer preflight before any Solana burn, idempotency key `move:<tgId>:<direction>:<amountUsdc>` (duplicate returns the cached completed result). Records `transactions` rows of type `move_funds` on the **source** chain. For Solana→Arc the burn sig is stashed as the row's `tx_hash` so the background flow's `updateTransactionByTxHash(burnSig, "confirmed", arcTxHash)` flips it to confirmed on mint.
- `src/cctp_bridge.js` → `completeInboundCctpTransferFlow` is now exported (was internal-only). `executeArcToSolanaCctpBurn` already self-preflights the fee payer and records `cctp_pending_burns`, so Arc→Solana needed no new bridge code.
- `src/db.js` → new read helpers `getRecentCctpBurnsByUser(telegramId, limit)` / `getRecentInboundByUser(telegramId, limit)` (any status, newest first) powering the status screen.
- `bot.js` → "🔀 Move Funds" button on the balance keyboard; direction picked via `action_move_arc_to_solana` / `action_move_solana_to_arc` callbacks (buttons only shown for chains with balance); states named `move_funds_amount` → `move_funds_confirm` (PIN, wallet decrypted by context like `confirm_withdraw`); `action_move_status` renders the latest burns/inbounds with friendly labels (reuse of the NEAR status card style).
- Not reused: `autoBridgeSolanaToArc` — it burns the **whole** SPL balance; moves must burn the exact requested amount, so the executor drives `executeSolanaCctpBurn` + `completeInboundCctpTransferFlow` directly.
- Tests: `tests/move_funds.test.js` — 10 subtests (both directions, exact-amount burn, insufficient-balance guards both ways, fee-payer preflight, unknown direction, idempotent repeat, ledger linkage). Part of the 23/23 feature-suite pass with Phases 1 & 3.

---

## Phase 3 — NEAR deposits via NEAR Intents

**Goal:** user deposits USDC on NEAR; funds land via NEAR Intent on **Base** (solvers do not quote NEAR→Solana directly — verified against the live 1Click API on 2026-09-30) and are then auto-swept Base→Arc by the existing EVM sweeper. Crediting always happens through the sweeper, never in the NEAR module (no double credit).

### Flow (quote-first, one-time deposit address — 1Click quotes are per-request)

1. **Amount** — user picks "Ⓝ Deposit from NEAR" in the Receive menu and enters an amount (min $2).
2. **Quote** — `POST /v0/quote` (dry=false): origin NEAR USDC → destination Base USDC, `recipient` = user's Arc/Base address, `refundTo` = user's derived NEAR implicit account. Row persisted in `near_deposits` (`quoting → awaiting_deposit`).
3. **Instructions** — bot shows the one-time NEAR address, exact amount, memo (if any), and expiry (default 30 min) plus a live status button.
4. **Deposit** — user sends USDC on NEAR from any wallet. Solver picks it up.
5. **Status polling** — `GET /v0/status` (60s cron + manual refresh button): `PENDING_DEPOSIT → PROCESSING → SUCCESS` notifies "bridged, sweeping to Arc…"; `REFUNDED` notifies the refund address; `FAILED` points to support. Terminal rows stop polling; stale `awaiting_deposit` rows past deadline flip to `expired` (late deposits auto-refund by the solver).
6. **Credit** — USDC arriving on Base is detected and credited to the Arc balance by the existing `evm_deposit_sweeper` (CCTP/Relay path), which already watches the user's address on Base.

### Key design points

- **Refund address**: NEAR implicit account derived from the user's EVM key with a NEAR-specific HMAC salt (`PayIT-NEAR-Intent-Bridge-Salt`) — never shares keys with the Solana derivation. Computed via the system key, so no PIN is needed at deposit time.
- **No NEAR gas needed**: funds go to the 1Click deposit address, not a PayIT-controlled NEAR account; no NEAR watcher, no gas airdrop.
- **USDT option**: `nep141:usdt.tether-token.near` available as origin asset; add as a user choice later (quote availability per pair is solver-dependent).

**Exit criteria:** $5 USDC deposited on NEAR test/main account lands as Solana-balance USDC with an on-chain SPL tx the bot can point to; expired intent retries without manual intervention.

### Implementation status (2026-09-30) — DONE, tested

Delivered as designed; the live 1Click API was validated during the build (real quotes + statuses). The NEAR→Base routing note in the goal above reflects solver behavior verified against the live API. One wording fix vs. the exit criteria: funds land in the **Arc** balance (Base USDC → sweeper → CCTP → Arc), not the Solana balance — Solana remains a separate, parallel rail.

---

## Phase 4 — Settlement daemon + chain registry refactor

**Goal:** unify all background money movement; make "add a chain" a small, patterned change. Do this **after** three chains exist, so the abstraction is shaped by reality.

### `src/chains.js` registry

One entry per chain:
```js
{
  key: "BASE" | "SOLANA" | "NEAR" | ...,
  family: "evm" | "solana" | "near",
  chainId, rpcUrls, explorerUrl,
  usdc: { address/mint, decimals },
  cctp: { tokenMessenger, messageTransmitter, domain },   // if supported
  dex: { router, wNative, poolFee },                       // if swap needed
  pajRail: "ARC" | "SOLANA" | null,
}
```
Replaces the triplicated configs: `EVM_CCTP_CONTRACTS` (cctp_bridge.js), `DEX_ROUTER_CONFIGS` (evm_deposit_sweeper.js), `network.js`.

### Chain adapter interface

```js
deriveAddress(user, accountType)      // -> address on that chain
getBalances(user, accountType)        // -> { usdc, native, tokens? }
watchDeposits(user)                   // -> detected deposit payloads
sweepDeposit(deposit)                 // -> credit, via CCTP / intent / direct
```

### Settlement daemon (`src/settlement_daemon.js`)

One `node-cron`-driven worker owning: EVM sweep, Solana watch, NEAR watch, CCTP retries (both directions), intent retries. Per-run ledger row so restarts resume rather than duplicate. Replaces scattered setInterval/background-async calls.

### Also in this phase

- Centralize `getUnifiedBalance(user)` (Arc + Solana + pending NEAR) — single read path used by balance display, withdraw, executor.
- Continue `bot.js` split (commands / conversations / flows) — at minimum extract the onramp/offramp/send flows touched in Phases 1–3.

### Implementation status (2026-09-30) — DONE, tested

- **`src/chains.js`** — registry with `arc`/`solana`/`base`/`near` entries composing the existing single sources of truth (network.js, cctp_bridge contract tables, paj.RAILS, multichain) — no duplicated literals. Adapters: `deriveAddress(user, accountType, chainKey)` (arc/solana incl. stored-address fallback/near via system key) and `getUnifiedBalance(user, accountType)` — one read path returning `{ arc: {usdc, eurc}, solana: {usdc}, pendingNear, byChain, total }`, now used by showBalance, showBizBalance, the Move Funds entry point, and the cash-out rail selection. Per-chain RPC failures degrade to 0 for that chain (warning logged) instead of failing the whole read.
- **`src/settlement_daemon.js`** — one worker owns all background money movement: `evm_sweep` (90s, via new `runEvmSweepOnce` in evm_deposit_sweeper.js), `cctp_inbound_recovery` (20s), `cctp_burn_retry` (60s — previously admin-manual only, now automatic so stuck Move Funds self-heal), `near_poll` (60s, poll + expiry). Per-run ledger rows in `settlement_runs` (`beginSettlementRun` claim / `finishSettlementRun` / `interruptStaleSettlementRuns` crash recovery / `pruneSettlementRuns`); in-flight guard prevents overlap; tasks fire once immediately at boot (replacing the old immediate-start workers). bot.js `startBot()` now starts this single daemon; SIGINT/SIGTERM stop it.
- **`src/flows_multichain.js`** — the Phase 2/3 conversation flows extracted from bot.js (~420 lines): NEAR deposit actions + status, Move Funds actions + status, and the three text states (`await_near_amount`, `move_funds_amount`, `move_funds_confirm`). bot.js registers via `registerMultichainFlows(bot, deps)` and delegates text states via `handleMultichainState`; button definitions stay in bot.js. The core withdraw chain (`await_withdraw_amount` → bank → confirm) intentionally remains in bot.js for a later pass.
- **Tests** — `tests/chains_registry.test.js` (8 subtests) + `tests/settlement_daemon.test.js` (9 subtests): registry shape, rail mapping, derivation fallbacks, unified-balance summing incl. pending-NEAR gating, RPC degradation, daemon scheduling/overlap/ledger/failure capture/stale interruption. Full suite: 157 tests, 150 pass — failures identical to clean HEAD (live-paj key absence offline, yield-vault fork tests, one pre-existing yield-liquidation assertion).

---

## Cross-cutting risks & guardrails

| Risk | Mitigation |
|---|---|
| paj Arc rail instability after launch | `PAJ_ARC_OFFRAMP_ENABLED` flag; Solana rail remains fully intact |
| Stranded NEAR deposits (intent never fills) | `near_deposits` state machine, auto-requote, refund path, support alert |
| Balance inflation from third-party address | Remove hardcoded `wr1Uud...` address from balance aggregation (Phase 1) |
| Double-credit on webhook + sweeper overlap | Keep idempotency keys per `(chain, txHash, address)`; daemon ledger |
| PIN-dependent Solana keypair blocking sweeps | Existing `sweep_auth_pin` flow already solves; keep for Move Funds too |
| Solver slippage on NEAR intents | Hard max-slippage cap per quote; quote breakdown shown to user before/after |

## Test plan (per phase)

- **P1:** mocked paj orders for both rails; rail-selection unit tests; migration test for `chain` backfill.
- **P2:** both CCTP directions with mock Iris attestations; recovery-cron rescue test (kill bot mid-bridge, restart, verify completion).
- **P3:** mocked NEAR Intent quote/settle; expired-intent retry; verify SPL credit gating (no credit without on-chain proof).
- Extend existing `npm test` (`node --test`) patterns; no live-chain tests in CI.
