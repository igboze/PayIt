# PayIT × NEAR Intents: Hackathon Submission

PayIT is an existing project. This page shows exactly which work was **added during the NEAR hackathon** and which work **already existed**. It also explains **how deeply PayIT uses NEAR infrastructure**, including what it does not use.

| | Link |
|---|---|
| Pre-hackathon baseline | tag [`pre-near-hackathon`](https://github.com/igboze/PayIt/tree/pre-near-hackathon) → commit `e95d92d` (2026-07-02) |
| Hackathon work | branch [`near-hackathon`](https://github.com/igboze/PayIt/tree/near-hackathon) |
| **Full hackathon diff** | **[`pre-near-hackathon...near-hackathon`](https://github.com/igboze/PayIt/compare/pre-near-hackathon...near-hackathon)** |

---

## 1. What existed before the hackathon

Everything up to and including tag `pre-near-hackathon` (64 commits, 2026-06-27 → 2026-07-02). It was built for **Arc testnet** (Circle's L1) and has **no NEAR code at all**:

- Non-custodial Telegram wallet (PIN-encrypted keys), Personal and Business accounts
- USDC/EURC sends on Arc testnet, Circle Gateway deposits from Sepolia/Base Sepolia/Fuji
- Invoices with HD-derived payment addresses, an on-chain settlement contract, receipts
- AI agent (text, voice, image, PDF/spreadsheet), auto-pay schedules, points/referrals
- A Naira cash-out *placeholder* (Paj Cash API not wired)

**Users and volume.** PayIT runs on Arc **testnet**. No real money has moved through it, and this submission makes no user or volume claims.

**Pre-hackathon leftovers in the diff.** The first commit on `near-hackathon` ("pre-hackathon leftovers") holds edits written on 2026-07-02 but committed later: Docker/CI tweaks, demo screenshots, and onboarding copy. **They are not NEAR work.** They are kept as a separate commit so judges can ignore them.

## 2. What was added during the hackathon

| File | Change | What it does |
|---|---|---|
| `src/near_intents.js` | **new**, 312 lines | NEAR Intents 1Click client: token registry, quotes, deposit submit, status polling, settlement-chain USDC transfer |
| `bot.js` | +~470 / −~90 | 🌐 **Send Crypto** and 🌐 **Receive Crypto** flows (chain → token → address → amount in ₦ → quote → PIN → swap → delivery notice); Naira-first amounts everywhere |
| `src/fx.js` | +62 | Reads amounts the way Nigerian users type them (`₦20,000`, `N20k`, `$50`) and converts Naira ↔ USDC |
| `agent/intent_router.js`, `agent/executor.js` | small | Naira amounts in natural-language payments; a guard that blocks un-converted currencies (before this, "send 20000 NGN" would have sent 20,000 USDC) |
| `src/offramp.js` | small | Passes the quoted Naira amount and rate to the cash-out request |
| `tests/fx.test.js`, `tests/near_intents.test.js` | **new** | 8 unit tests |
| `.env.example` | config | `NEAR_INTENTS_*` settings; the leaked deployer key replaced with a placeholder |

**The problem it solves.** PayIT's users are Nigerian. Before the hackathon they could only hold USDC on Arc testnet and had to work out the conversions themselves. Now they:

1. **type Naira**: "send ₦20,000" becomes USDC behind the scenes, and the confirm screen shows `₦20,000 (≈ $14.78)`;
2. **send to any chain in any token**: USDC, the chain's native token (ETH, SOL, BNB, TRX…), USDT, or any of ~200 NEAR Intents assets on 37 chains;
3. **get paid in any token**: the payer sends e.g. USDT on Tron and the user receives the exact Naira value they asked for, as USDC.

## 3. How deeply PayIT uses NEAR infrastructure

An honest summary: **PayIT is an API client of NEAR Intents.** NEAR is the cross-chain swap engine behind every Send/Receive Crypto action. PayIT does not, however, deploy NEAR contracts or sign NEAR transactions itself.

### What is used

| NEAR component | How PayIT uses it |
|---|---|
| **1Click API** (`1click.chaindefuser.com`) | `GET /v0/tokens` builds the chain and token pickers. `POST /v0/quote` prices every send (`EXACT_INPUT`) and receive (`EXACT_OUTPUT`) and issues one-time deposit addresses. `POST /v0/deposit/submit` reports our deposit tx. `GET /v0/status` tracks each swap until `SUCCESS`, `REFUNDED` or `FAILED`. |
| **Verifier contract `intents.near`** (indirectly) | Every swap settles here: solvers compete to fill it and the Verifier executes atomically. PayIT relies on this for pricing, slippage protection (1%) and automatic refunds. |
| **NEP-141 multi-chain assets** | Every asset PayIT handles is an `intents.near` asset ID, for example `nep141:base-0x8335…omft.near` (USDC on Base) or `nep141:sol.omft.near` (SOL), brought into NEAR Intents by the `omft.near` bridge. |

### What is NOT used (yet)

- No NEAR account per user. Users keep their existing EVM key.
- No signed intents (NEP-413/ERC-191) sent directly to the Verifier. 1Click builds the intents.
- No Chain Signatures and no custom NEAR smart contract.
- PayIT makes no calls to NEAR RPC.

### Next step for deeper integration (roadmap, not built)

Keep user balances **inside `intents.near`** (1Click `depositType: INTENTS`) and sign intents with the user's existing EVM key (the Verifier accepts ERC-191 signatures). Swaps would then be gasless and instant, and users would no longer need ETH on Base for gas, which is the biggest UX gap today.

## 4. What is verified, and what is not

| Check | Status |
|---|---|
| Unit tests (`node --test tests/fx.test.js tests/near_intents.test.js`) | ✅ 8/8 pass |
| Live **dry** quotes against mainnet 1Click (2026-10-28) | ✅ 37 chains loaded. ₦20,000 → 14.78 USDC → quoted **0.1432 SOL** to a Solana address, ~32 s ETA |
| Route limits surfaced to user | ✅ e.g. Tron USDT receive refused: "minimum swap amount is $100" |
| **Live mainnet swap with real funds** | ⚠️ <!-- PROOF: replace with the explorer link of a real swap, e.g. https://explorer.near-intents.org/?depositAddress=… --> Not executed yet |

**Live swaps are off by default** (`NEAR_INTENTS_ENABLED`), because they move real mainnet funds. Without the flag, the bot shows real quotes but moves nothing.

## 5. Known limitations

- **Arc is not a NEAR Intents chain.** The NEAR leg settles in **USDC on Base mainnet**, from the user's same address, which is separate from their Arc testnet balance. The user needs USDC and a little ETH on Base to send.
- The swap watcher is in memory, so after a restart the bot won't send the "delivered" message. The swap itself still completes.
- The Naira rate is mid-market (open.er-api.com), not the off-ramp partner's rate.
- Some routes have temporary minimums (seen: $100 for Tron USDT).

## 6. Try it

```bash
cp .env.example .env              # add TELEGRAM_BOT_TOKEN
# optional, real funds: NEAR_INTENTS_ENABLED=true
npm install && npm start
```

In Telegram: **💰 Balance → 🌐 Send Crypto / 🌐 Receive Crypto**, or **📥 Add Money → 🌐 Receive Crypto**.
