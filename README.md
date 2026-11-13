# Proxim — Real-World Money on Telegram via NEAR Intents

> **Built for NEAR HACKATHON 2026**  
> **Tracks:** Real-World Money (`realworld`) & Autonomous Business (`business`)  
> **Live Bot:** [@payeetbot](https://t.me/payeetbot)  
> **Demo Video:** [Watch on X](https://x.com/proximfi/status/2120615455899652534)

---

## 📊 Live Production Traction

Proxim is not a prototype or concept — it is a production neobank with real economic activity:

| Metric | Production Value | Context |
| :--- | :--- | :--- |
| **Active Users** | **600+ registered users** | Organic adoption across freelancers and individual remitters |
| **Processed Volume** | **$45,000+ USD** | Real-world liquidity settled through live payment & banking rails |
| **Active Businesses** | **7 onboarded SMEs** | Actively issuing multimodal invoices, managing payroll & ledgers |
| **Average Cash-Out Speed** | **< 35 seconds** | Instant NIBSS rail settlement into 100+ commercial bank accounts |

---

## Executive Overview

**Proxim** is a non-custodial digital neobank built directly inside Telegram. It bridges **NEAR Intents (1Click Chain Defuser)** and stablecoin liquidity directly into real-world commercial banking rails, allowing African freelancers and small-to-medium enterprises (SMEs) to receive cross-chain payments and cash out into local bank accounts in under 35 seconds.

With over 900 million Telegram users, Proxim eliminates the friction of traditional Web3 apps: zero browser extensions, zero gas token juggling, zero seed phrase anxiety, and zero P2P bank freeze risks.

---

## The Real-World Problem & The Proxim Solution

### The Problem
* **Rapid Currency Devaluation:** Emerging market businesses face double-digit annual inflation, eroding working capital held in local fiat.
* **Crypto Onboarding Friction:** Mainstream business owners struggle with seed phrases, cross-chain gas tokens, bridging delays, and exchange KYC.
* **P2P Account Freezes:** Converting stablecoins to local currency via peer-to-peer desks frequently triggers bank compliance flags and frozen merchant accounts.
* **Accounting Chaos:** Freelancers and SMEs mix personal spending with corporate income, lacking automated tax and ledger tools.

### The Solution
* **Telegram Native:** Instant onboarding with a 4-digit PIN, securing client-side non-custodial wallets via AES-256-GCM.
* **NEAR Intents Engine:** Clients pay in native NEAR or any NEP-141 token (`wNEAR`, `USDC`, `USDT`). Decentralized 1Click solvers route and fulfill the swap into digital dollar liquidity behind the scenes.
* **Dual Withdrawal Rails (Naira Fiat & Multi-Chain Crypto):** Flexible off-ramping for individuals and businesses — cash out to Naira with direct payouts to 100+ commercial banks via NIBSS rails in under 35 seconds, or withdraw crypto across 10+ blockchains (NEAR, Solana, Base, Arbitrum, Polygon, Ethereum, Bitcoin, and Tron).
* **Dual-Account Architecture:** One-tap toggle between personal spending and corporate SME business operations with independent deposit addresses, tax ledgers, and revenue reporting.
* **Multimodal Business Suite:** AI voice note & text invoicing (auto-generating PDF invoices with QR codes in USD and NGN), batch multi-rail payroll, and auto-earn vault yield.

---

## How NEAR Powers Proxim

Proxim uses **NEAR Intents** and the **1Click Chain Defuser** protocol (`src/near.js`) as its cross-chain execution backbone:

```
[ Payer / Client ]
      │ (Deposits native NEAR or NEP-141 tokens: wNEAR, USDC, USDT)
      ▼
[ NEAR 1Click Chain Defuser ] ── (Decentralized Solvers match & execute intent)
      │
      ▼
[ Base / Arc Settlement Layer ] ── (Automated Treasury Sweeper)
      │
      ▼
[ Proxim Dual Ledger Engine ] ── (Separates Personal vs Business Accounts)
      │
      ▼
[ Commercial Banking Rails ] ── (Instant NIBSS payout to 100+ Nigerian Banks in <35s)
```

### Key NEAR Integration Highlights
1. **1Click Solver Integration (`src/near.js`):** Integrates `https://1click.chaindefuser.com` to dynamically fetch solver quotes for NEP-141 assets and generate one-time solver deposit addresses.
2. **Deterministic Implicit Account Derivation (`deriveNearAddress`):** Uses domain-separated Ed25519 key derivation from the user's master secret to maintain a permanent NEAR implicit account for automated on-chain refund routing.
3. **Gasless Merchant Experience:** Freelancers and merchants never touch NEAR gas or manage bridge transactions; solvers handle execution and delivery.
4. **Real-World Off-Ramping:** Bridges cross-chain intent settlements directly to local bank clearing without exposing users to counterparty P2P risks.

---

## Architecture & Core Modules

```
PayIt-2/
├── bot.js                      # Telegram neobank interface & session orchestration
├── src/
│   ├── near.js                 # NEAR Intents & 1Click solver quote/deposit engine
│   ├── wallet.js               # Client-side non-custodial key management & AES-256-GCM
│   ├── multichain.js           # Multi-chain key derivation (NEAR, Solana, EVM)
│   ├── db.js                   # Dual-account relational ledger & idempotency store
│   ├── offramp.js              # Live commercial bank cash-out integration (NIBSS rails)
│   ├── bank_resolver.js        # Fuzzy resolution for 100+ commercial banks & neobanks
│   ├── ai_invoice_agent.js     # Multimodal AI invoice parser (voice notes & text)
│   ├── invoice_pdf_generator.js# Branded PDF generator with payment QR codes
│   ├── bulk_payroll.js         # CSV/spreadsheet multi-rail payroll processor
│   └── savings.js              # Auto-earn ERC-4626 liquidity vault manager
└── tests/                      # Automated test suite (260 passing unit & integration tests)
```

---

## Verification & Reproducibility ("Do X — See Y")

Every feature in Proxim can be evaluated and reproduced via automated test scripts and live bot interactions.

### 1. Automated Test Suite (Machine-Readable Verification)

Run the full automated test suite (requires Node.js >= 20):

```bash
# Install dependencies
npm install

# Run the complete test suite
npm test
```

**Expected Result ("See Y"):**
```
✔ Account Isolation & Multi-User Separation Suite
✔ NEAR deposit lifecycle: quote, poll transitions, terminal notifications
✔ Bank Resolver: accurately resolves Nigerian banks and neobanks to 6-digit NIBSS codes
✔ File Parser: maps mixed multi-rail payroll rows (NGN, EVM, Solana, NEAR)
✔ Idempotency Ledger: guarantees deterministic keys and prevents double spending
✔ Trade Monetization & Offramp Execution
ℹ tests 260
ℹ pass 260
ℹ fail 0
```

### 2. Verify NEAR Intents Engine Directly

Execute the dedicated NEAR Intents test suite:

```bash
node --test tests/near_deposit.test.js
```

**Expected Result ("See Y"):**
* `deriveNearAddress` returns a deterministic 64-character Ed25519 NEAR implicit account.
* `createNearDeposit` queries 1Click solvers, calculates token base units, and generates a valid solver deposit address.
* Account isolation ensures NEAR deposits route cleanly to either Personal or Business balances.

### 3. Verify Bank Resolution & Off-Ramp Engine

```bash
node --test tests/bank_resolver.test.js
```

**Expected Result ("See Y"):**
* Fuzzily resolves user bank inputs (e.g. "GTB", "Access", "Kuda", "Opay") into official 6-digit NIBSS routing codes with 0 silent fallbacks.

### 4. Interactive Live Demo via Telegram

1. Open Telegram and search for [@payeetbot](https://t.me/payeetbot).
2. Send `/start` and set a 4-digit PIN.
3. Tap **Receive** -> **NEAR Protocol** to view dynamic NEAR deposit details and solver address.
4. Tap **Switch to Business** to access SME corporate invoicing and payroll.
5. Tap **Cash Out** to test instant account verification and bank payout estimation.

---

## Hackathon Disclosures & Baseline Context (Q-002 & Q-005)

* **Hackathon Build Window (Nov 1 – Nov 14, 2026):**
  * Integrated NEAR Intents (1Click solver quoting, deposit tracking, status polling, and sweep mechanics in `src/near.js`).
  * Implemented deterministic NEAR implicit address generation and refund routing.
  * Extended multi-rail payroll and dual-account ledgers to support native NEAR and NEP-141 assets.
  * Added 260 comprehensive unit and integration tests covering cross-chain flows and idempotency.
* **Pre-existing Baseline Libraries:**
  * Core EVM smart contracts, existing Telegram session skeleton, and general cryptography utilities (`tweetnacl`, `ethers`).

---

## License

This project is open-source under the [MIT License](LICENSE).
