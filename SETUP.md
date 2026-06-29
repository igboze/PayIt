# PayIT — Setup Guide

## What's new in this version

- **Personal + Business accounts** — dual wallets, one PIN, context toggle
- **EURC support** — send and receive Euro Coin alongside USDC
- **Circle Gateway** — add USDC from Ethereum, Base, Polygon, Arbitrum without manual bridging
- **Business SME hub** — invoices, expenses, payroll, cash flow, savings, reports

---

## 0. Revoke any previously shared bot token

If you've pasted your bot token in a chat at any point, revoke it now:

1. Open Telegram → message **@BotFather**
2. `/mybots` → select your bot → **API Token** → **Revoke current token**
3. Copy the new token — it goes into `.env`, never into chat again

---

## 1. Install Node.js (v22.5 or newer)

Download from https://nodejs.org (LTS). Confirm after install:
```
node -v
```

---

## 2. Get the project onto your machine

Copy the `payit/` folder to somewhere like `C:\payit` (Windows) or `~/payit` (Mac/Linux).

---

## 3. Install dependencies

```
cd C:\payit
npm install
```

This installs: telegraf, ethers, better-sqlite3, sharp, openai, @anthropic-ai/sdk, @google/generative-ai, axios, node-cron, uuid.

---

## 4. Set up your `.env`

1. Copy `.env.example` to `.env` (make sure it's `.env` not `.env.txt`)
2. Open in a text editor and fill in at minimum:
   - `TELEGRAM_BOT_TOKEN` — from Step 0
   - `ADMIN_TELEGRAM_IDS` — your own Telegram numeric ID (get from @userinfobot)
   - `ANTHROPIC_API_KEY` — for AutoPay and Payroll parsing (get from console.anthropic.com)
   - `OPENAI_API_KEY` or `GEMINI_API_KEY` — for Invoice parsing
   - `INVOICE_FORWARDING_SECRET` — set a long random secret in production so invoice settlement can decrypt payments reliably
   - `PAYIT_DB_PATH` — use a persistent path such as `/app/payit.db` in hosted deployments

Everything else is optional until you're ready to enable that feature:
- `PAJCASH_OFFRAMP_ADDRESS` + `PAJCASH_API_KEY` — for real Naira cashout
- `TERMII_API_KEY` — for SMS phone verification
- `GATEWAY_API_KEY` — for Gateway transfer status tracking (not required for basic deposit)
- `SWAP_ROUTER_ADDRESS` — for live token swaps (blocked until a verified Arc DEX address is available)

---

## 5. Run the bot

```
npm start
```

You should see:
```
PayIT bot is running (Arc testnet, non-custodial) — Personal + Business accounts, USDC + EURC, Gateway enabled...
```

---

## 6. First-time flow in Telegram

1. Send `/start` to your bot
2. Choose **Personal** or **Business** account
3. Set a 4-digit PIN
4. **Save your private key(s) immediately** — the bot shows them once, auto-deletes after 60 seconds. Business onboarding shows two keys (Personal + Business). Save both separately in a password manager.

### Getting testnet funds

- USDC: https://faucet.circle.com → select **Arc Testnet** → USDC
- EURC: same faucet → select **Arc Testnet** → EURC
- Or use **Gateway** inside the bot to bring USDC from Ethereum/Base/Polygon

---

## 7. Switching between Personal and Business

Tap the **Personal / Business** toggle that appears at the top of balance and menu screens. No PIN re-entry needed — the session is already authenticated.

If you onboarded as Personal and want to add Business later, tap the Business button in the toggle and enter your PIN once to encrypt the new Business wallet.

---

## 8. Business features

All accessible from the Business context menu:

| Feature | How to use |
|---|---|
| New Invoice | Tap 🧾 New Invoice → type in plain English |
| Log Expense | Tap 💸 Log Expense → describe it naturally |
| Cash Flow | Tap 📊 Cash Flow → see income vs expenses |
| Payroll | Tap 👥 Payroll → describe who to pay |
| Biz Savings | Tap 💰 Biz Savings → set % auto-save rule |
| Reports | Tap 📈 Reports → P&L + top expenses |

---

## 9. What's not live yet

- Real swap execution (needs a verified Arc DEX router address)
- Real yield deposits (DB simulation only — no real funds move)
- Card spending
- Bills & bulk send
- KYC/AML gating
- Paj Cash Naira off-ramp (needs their API credentials)
- PIN rate-limiting / lockout after failed attempts

---

## Stopping the bot

Press `Ctrl + C` in the terminal window.
