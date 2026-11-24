# 🛠️ Proxim Builder API Documentation

The **Proxim Builder API** lets developers build fintech, payment, commerce, and cross-chain applications powered by Proxim's real on-chain and fiat infrastructure.

Builders authenticate with scoped API keys and are strictly isolated to wallets provisioned by their own API key (plus the key creator's own account).

---

## 🚀 Quickstart & Key Lifecycle

### 1. Generating an API Key

API keys can be generated directly inside the Proxim Telegram Bot with custom permission scoping:

1. **Open Developer Portal**:
   - Send `/developer` or `/api` to the bot.
2. **Create New Key**:
   - Tap **[➕ Generate New API Key]** and enter your application name (e.g. `My Checkout Bot`, `Crypto Wallet App`).
3. **Choose Permissions Profile**:
   - **🌟 Full Access (`all`)**: Grants access to all enabled API modules.
   - **⚙️ Custom Scoped Features**: Select only the exact modules needed for your app (e.g. `wallets`, `invoices`, `bridge`). Features can be edited at any time.
4. **Copy Secret Key**:
   - Format: `prx_live_<48_hex_chars>`.
   - ⚠️ **Important**: Keys are stored as **SHA-256 hashes** only. The raw secret is shown **once** at creation.

### 2. Authentication & Headers
Include your key in every authenticated request:
```http
Authorization: Bearer prx_live_YOUR_SECRET_KEY
```
or
```http
X-API-Key: prx_live_YOUR_SECRET_KEY
```

### 3. Tenant Isolation & Security
- Every wallet created via `POST /api/v1/wallets` is permanently bound to the creating API key (`api_key_wallets`).
- An API key can **only** read balances, send transfers, bridge funds, open/close savings vaults, view invoices, or fetch receipts for wallets it created (or the key owner's own Telegram account).
- Attempting to access another user's or another API key's wallet returns `403 Forbidden`.

### 4. Rate Limiting
- Default rate limit: **120 requests per minute** per API key (`429 Too Many Requests` when exceeded).

### 5. Base URL
Use your deployed Proxim server URL (configured via `PUBLIC_API_URL`, `WEBHOOK_URL`, or `RAILWAY_PUBLIC_DOMAIN`):
```
https://<your-deployed-host>/api/v1
```
*(Local development default: `http://localhost:3000/api/v1`)*

Live documentation is always available at:
```http
GET /api/v1/docs
```

---

## ⚙️ Customizable Feature Permissions

| Feature Identifier | Description | Capabilities |
| :--- | :--- | :--- |
| `all` | **Full Access** | Access all API modules |
| `wallets` | **Multichain Wallets** | Create customer wallets, get addresses, check unified balances |
| `transfers` | **Instant Transfers** | Send Arc USDC transfers (Paymaster-sponsored or direct) |
| `invoices` | **Invoicing & Checkout** | Create, list, and check status of payment invoices |
| `checkout` | **Merchant Checkout & Payment Links** | Accept customer payments on any website/app via headless API, white-labeled hosted checkout, drop-in JS modal SDK, or reusable payment links |
| `onramp` | **Naira Onramp** | Dynamic Nigerian virtual bank accounts via Paj v2 |
| `offramp` | **Naira Offramp** | Live USD/NGN rates and Naira bank payouts via Paj v2 |
| `crypto_deposits` | **Multi-Chain EVM** | EVM deposit addresses & on-demand DEX/CCTP sweep to Arc |
| `near_intents` | **NEAR Intents & Robinhood Chain** | Cross-chain swaps across Starknet, Robinhood Chain, Solana, and NEAR |
| `bridge` | **CCTP Cross-Chain Bridge** | Native USDC bridging between Arc and Solana / EVM |
| `savings` | **Yield & Savings Vaults** | Live Circle EarnKit / ERC-4626 vaults, real on-chain deposits & withdrawals |
| `receipts` | **Proof & Receipts** | Transaction receipt JSON and HD PNG receipt cards |
| `global_payouts` | **Global Banking & 27-Currency Payouts** | Tier-1 virtual bank accounts & 27-currency payouts with transfer fees captured upfront |
| `virtual_cards` | **Virtual USD Cards** | Quote, issue, and top up Virtual USD Cards with fees included |

*Calling an endpoint outside the key's enabled features returns `403 Forbidden`.*

---

## 📡 API Endpoints Reference

### 1. System, Docs & Authentication

#### Health & Status
```http
GET /api/v1/health
```
Returns service status, live `baseUrl`, `docsUrl`, and `supportedChains`.

#### Live API Documentation (Markdown)
```http
GET /api/v1/docs
```

#### List Available Features
```http
GET /api/v1/features
```

#### Authenticated Builder Profile
```http
GET /api/v1/auth/me
```
**Headers:** `Authorization: Bearer prx_live_...`

---

### 2. Multichain Wallets (`feature: "wallets"`)

#### Create / Resolve Customer Wallet
```http
POST /api/v1/wallets
```
**Request Body:**
```json
{
  "username": "customer_alice",
  "pin": "1234"
}
```
*(If `pin` is omitted, a cryptographically random secret is generated automatically — pass an explicit `pin` if you plan to call `POST /api/v1/global/payouts` or `POST /api/v1/global/cards/issue` for this wallet.)*

**Response (201 Created):**
```json
{
  "success": true,
  "userId": 583920194,
  "username": "customer_alice",
  "addresses": {
    "arc": "0x4b78a99268f7d983411b0e5192b45100a738491c",
    "solana": "8F3bNqm8e734tXpG82bM9rC1zP5qK93h12aBsJ83dKL4",
    "near": "e8392b4c10293847561029384756102938475610293847561029384756102938",
    "robinhood": "0x4b78a99268f7d983411b0e5192b45100a738491c"
  }
}
```

#### Get Unified Balance
```http
GET /api/v1/wallets/:identifier/balance
```
**Response (200 OK):**
```json
{
  "success": true,
  "userId": 583920194,
  "totalUsdc": 150.25,
  "arcUsdc": 100.25,
  "arcEurc": 0,
  "solanaSplUsdc": 50.00,
  "pendingBridgeUsdc": 0.00
}
```

#### Get Wallet Addresses
```http
GET /api/v1/wallets/:identifier/addresses
```

---

### 3. Instant Transfers (`feature: "transfers"`)

#### Send USDC on Arc
```http
POST /api/v1/transfers
```
**Request Body:**
```json
{
  "fromUserId": 583920194,
  "toAddress": "0x8888888888888888888888888888888888888888",
  "amountUsdc": 25.50,
  "pin": "1234",
  "narration": "Order #1024"
}
```
*(Omit `pin` to sign with the server-managed key if available.)*

**Response (200 OK):**
```json
{
  "success": true,
  "txHash": "0x98f3b20c...",
  "sponsored": true,
  "amountUsdc": 25.50,
  "recipient": "0x8888888888888888888888888888888888888888"
}
```

---

### 4. Invoices (`feature: "invoices"`)

#### Create Payment Invoice
```http
POST /api/v1/invoices
```
**Request Body:**
```json
{
  "clientName": "Globex Inc",
  "amount": 250.00,
  "items": [
    { "description": "Software Subscription", "amount": 250.00 }
  ],
  "memo": "October Billing",
  "walletAddress": "0x4b78a99268f7d983411b0e5192b45100a738491c"
}
```
**Response (201 Created):**
```json
{
  "success": true,
  "invoice": {
    "invoice_number": "INV-M39K10A",
    "client_name": "Globex Inc",
    "total": 250.00,
    "status": "unpaid"
  },
  "paymentAddress": "0x4b78a99268f7d983411b0e5192b45100a738491c",
  "statusUrl": "https://<your-host>/api/v1/invoices/INV-M39K10A"
}
```

#### List Invoices
```http
GET /api/v1/invoices
```

#### Get Invoice by Number or ID
```http
GET /api/v1/invoices/:invoiceNumberOrId
```

---

### 5. NEAR Intents & Cross-Chain Swaps (`feature: "near_intents"`)

- `GET /api/v1/intents/tokens` — Live supported tokens on Starknet, Robinhood Chain, NEAR, and Solana.
- `POST /api/v1/intents/quote` — Dry-run quote to Base USDC.
- `POST /api/v1/intents/deposits/starknet` — Create Starknet deposit (`STRK`, `ETH`, `ZEC`, `XRP`).
- `POST /api/v1/intents/deposits/robinhood` — Create Robinhood Chain deposit (`USDG`, `ETH`, `WETH`, `USDe`, etc.).
- `POST /api/v1/intents/deposits/near` — Create NEAR deposit (`originSymbol`, `amount`, `recipientAddress`, `refundTo`).
- `POST /api/v1/intents/deposits/solana` — Create Solana deposit (`originSymbol`, `amount`, `recipientAddress`, `refundTo`).
- `GET /api/v1/intents/deposits/:depositId` — Track deposit & live 1Click solver status.

---

### 6. Fiat Onramp & Offramp (`features: "onramp"`, `"offramp"`)

#### Generate Nigerian Virtual Bank Account (Onramp)
```http
POST /api/v1/onramp/bank-transfer
```
**Request Body:**
```json
{
  "amountNgn": 50000,
  "recipientAddress": "8F3bNqm8e734tXpG82bM9rC1zP5qK93h12aBsJ83dKL4"
}
```
**Response (200 OK):**
```json
{
  "success": true,
  "orderId": "ord_9381023",
  "status": "pending",
  "estimatedUsdc": 34.5,
  "rate": 1450,
  "virtualAccount": {
    "bankName": "Wema Bank",
    "accountNumber": "9827361829",
    "accountName": "Paj / Proxim",
    "amountNgn": 50000,
    "expiresAt": "2026-11-20T13:00:00Z"
  }
}
```

#### Check Onramp Order Status
```http
GET /api/v1/onramp/status/:orderId
```

#### Get Live Naira Exchange Rates
```http
GET /api/v1/offramp/rates
```

#### Withdraw to Nigerian Bank (Offramp)
```http
POST /api/v1/offramp/bank-transfer
```
- **Custodial mode** (pass `userId` + optional `pin`): creates the Paj order **and** sends the exact USDC from that tenant wallet on-chain (`mode: "executed"`).
- **Self-funded quote mode** (omit `userId`): creates the Paj order and returns `fundingAddress`, `fundingChain`, and `fundingAmountUsdc` (`mode: "awaiting_funding"`).

#### Check Offramp Payout Status
```http
GET /api/v1/offramp/status/:orderId
```

---

### 7. Savings & Yield (`feature: "savings"`)

Powered by **Circle EarnKit** & live **ERC-4626 Morpho Vaults** on Arc.

#### Get Live Yield Vaults & APYs
```http
GET /api/v1/savings/rates
```
Returns live filtered vaults (`vaults[]`) plus the top USDC vault summary (`apy`, `apyPercent`, `vault`, `vaultAddress`, `chain`, `feeFraction`).

#### Check Active Savings Position
```http
GET /api/v1/savings/position/:userId
```
Returns active principal, live accrued gross/net yield, and vault metadata.

#### Deposit USDC into Vault (On-Chain)
```http
POST /api/v1/savings/deposit
```
**Request Body:**
```json
{
  "userId": 583920194,
  "amountUsdc": 100.00,
  "vaultAddress": "0xa8fd51b78370c7ca948566d7ba97d252bc325124"
}
```
*(Omit `vaultAddress` to use the top active USDC vault.)* Executes an actual on-chain EarnKit / ERC-4626 deposit and returns `txHash`, `vault`, and `position`.

#### Withdraw Principal + Accrued Yield (On-Chain)
```http
POST /api/v1/savings/withdraw
```
**Request Body:**
```json
{
  "userId": 583920194
}
```
Redeems all on-chain vault shares, routes the 10% performance fee on profits, and returns `withdrawnAmount`, `principalUsdc`, `netYieldUsdc`, `devFeeUsdc`, and `withdrawTxHash`.

---

### 8. Multi-Chain EVM Deposits (`feature: "crypto_deposits"`)

- `GET /api/v1/deposits/crypto/chains` — Supported EVM chains & DEX router configs.
- `GET /api/v1/deposits/crypto/address/:userId` — Customer multi-chain EVM deposit address.
- `POST /api/v1/deposits/crypto/sweep` — Trigger on-demand swap + CCTP sweep to Arc.

---

### 9. Circle CCTP Cross-Chain Bridge (`feature: "bridge"`)

- `GET /api/v1/bridge/supported` — Supported Circle CCTP domains and chains.
- `POST /api/v1/bridge/transfer` — Burn native USDC on Arc and mint on Solana, Base, Arbitrum, Optimism, Polygon, Avalanche, or Ethereum.

---

### 10. Proofs & Payment Receipts (`feature: "receipts"`)

- `GET /api/v1/receipts/:txHash` — Transaction receipt metadata JSON.
- `GET /api/v1/receipts/:txHash?format=png` — Downloadable HD branded PNG receipt card (`image/png`) with real account & counterparty details.

---

### 11. Global Banking & 27-Currency Payouts (`feature: "global_payouts"`)

All international payouts require **Tier-1 KYC/KYB verification** and automatically capture **transfer fees upfront** (`transferAmountUsd + transferFeeUsd = totalDebitUsd`).

#### Tier-1 KYC / KYB Submission (For API-Only Integrations)
- `POST /api/v1/global/kyc` — Submit Personal Tier-1 KYC (`userId`, `countryCode`, `firstName`, `lastName`, `email`, `phoneNumber`, `dateOfBirth`, `address`, `idDocument`).
- `POST /api/v1/global/kyb` — Submit Business Tier-1 KYB (`userId`, `incorporationCountry`, `legalName`, `registrationNumber`, `email`, `phoneNumber`, `address`, `officer`).
> Note: Always pass a `pin` when calling `POST /api/v1/wallets` if you plan to execute payouts or issue cards for that wallet via API.

#### List Supported Corridors & Rails
```http
GET /api/v1/global/corridors
```
Returns all 27 fiat currencies (`USD`, `GBP`, `EUR`, `CAD`, `NGN`, `GHS`, `KES`, `AED`, `CNY`, etc.), local/SWIFT rail keys, limits, and required recipient fields.

#### Quote an International Payout (Fees Included)
```http
POST /api/v1/global/payouts/quote
```
```json
{
  "userId": 123456789,
  "railKey": "gbp_fps",
  "targetCurrency": "GBP",
  "targetAmountMajor": 50
}
```
Response includes:
```json
{
  "success": true,
  "quote": {
    "quoteId": "01M8...",
    "railKey": "gbp_fps",
    "targetCurrency": "GBP",
    "targetAmountMajor": 50,
    "transferAmountUsd": 66.98,
    "transferFeeUsd": 7.37,
    "totalDebitUsd": 74.35,
    "effectiveRate": 0.6725
  }
}
```

#### Execute an International Payout
```http
POST /api/v1/global/payouts
```
```json
{
  "userId": 123456789,
  "pin": "1234",
  "railKey": "gbp_fps",
  "targetCurrency": "GBP",
  "targetAmountMajor": 50,
  "recipientDetails": {
    "account_holder_name": "Jane Doe",
    "sort_code": "040075",
    "account_number": "12345678"
  },
  "narration": "Invoice 42"
}
```

#### Check Payout Status & Global Accounts
- `GET /api/v1/global/payouts/:reference` — Live settlement status (`funding_in_transit`, `dispatched`, `completed`, `refunded`, `failed`).
- `GET /api/v1/global/accounts/:userId` — List Tier-1 verified Global Virtual Bank Accounts (USD, GBP, EUR, CAD, AED, NGN, etc.).

---

### 12. Virtual USD Cards (`feature: "virtual_cards"`)

- `GET /api/v1/global/cards/:userId` — List Virtual USD Cards and live balances.
- `POST /api/v1/global/cards/quote` — Quote card issuance or top-up (`{ userId, action: "issue"|"topup", loadAmountUsd, cardType?: "virtual"|"disposable" }`, fees included).
- `POST /api/v1/global/cards/issue` — Issue a Virtual USD Card (`{ userId, pin, loadAmountUsd, cardType?: "virtual"|"disposable", cardName? }`).
- `POST /api/v1/global/cards/:cardId/topup` — Top up an existing card (`{ userId, pin, amountUsd }`).

---

## 🛡️ Production Security Guarantees (Public Railway Host)

1. **Tenant Isolation:** Every API key is strictly bound to wallets it provisioned (`api_key_wallets`) plus its owner's account. Cross-tenant access returns `403 Forbidden`.
2. **Tier-1 KYC Enforcement:** Unverified wallets cannot call global banking, 27-currency payouts, or virtual card issuance endpoints (`403 Forbidden`).
3. **Anti-Fraud & Velocity Limits:** All transfers and payouts pass through Proxim's burst velocity tripwire, Tier-0/Tier-1 daily limits, and global circuit breaker (`429 Too Many Requests`).
4. **Payload & Rate Limits:** Requests are capped at **1 MB** (`413 Payload Too Large`) and **120 req/min** per API key (`429 Too Many Requests`).
5. **Webhook Signature Verification:** Production inbound webhooks (`/webhook/paj`, `/webhook/nuvion`, `/webhook/alchemy`) are fail-closed (`401` on missing/invalid HMAC signatures). Outbound builder webhooks (when `webhookUrl` is configured) include `X-Proxim-Event` and `X-Proxim-Signature` (HMAC-SHA256 of the raw JSON body keyed by `sha256(your_api_key)`).

---

## 💻 Code Example (Node.js)

```javascript
const axios = require("axios");

const proxim = axios.create({
  baseURL: `${process.env.PROXIM_API_BASE_URL}/api/v1`,
  headers: {
    Authorization: `Bearer ${process.env.PROXIM_API_KEY}`,
    "Content-Type": "application/json",
  },
});

async function main() {
  const me = await proxim.get("/auth/me");
  console.log("Connected as:", me.data.appName);

  const wallet = await proxim.post("/wallets", { username: "john_doe" });
  console.log("Arc address:", wallet.data.addresses.arc);

  const bal = await proxim.get(`/wallets/${wallet.data.userId}/balance`);
  console.log("Total USDC:", bal.data.totalUsdc);

  const rates = await proxim.get("/savings/rates");
  console.log("Top vault:", rates.data.vault, `${rates.data.apyPercent}% APY`);
}

main();
```


---

## 🛒 Merchant Payment Acceptance (Checkout Sessions, Hosted Page, Drop-In SDK & Payment Links)

Businesses and developers can accept customer payments directly inside their own website, SaaS, store, or mobile app — **without sending customers to Telegram** — using either:
- **Headless API:** Render your own 100% custom checkout UI using the returned bank & crypto coordinates.
- **White-Labeled Hosted Checkout (`/checkout/:sessionId`):** Redirect customers to a branded Proxim checkout page styled with your `businessName`, `logoUrl`, `primaryColor`, and `accentColor`.
- **Drop-in Inline JS Modal (`/sdk/proxim-checkout.js`):** Open the branded checkout inside a modal overlay on your website in 4 lines of code.
- **Reusable Payment Links (`/pay/:slug`):** Shareable links for products, subscriptions, or flexible-amount payments.

### 1. Create a Checkout Session (`feature: "checkout"`)
```http
POST /api/v1/checkout/sessions
Authorization: Bearer prx_live_YOUR_SECRET_KEY
Content-Type: application/json
```
```json
{
  "amount": 150000,
  "currency": "NGN",
  "channels": ["ngn_bank", "crypto"],
  "cryptoChain": "sol_usdc",
  "reference": "ORDER-99421",
  "description": "Pro Annual Subscription",
  "customerName": "Ada Lovelace",
  "customerEmail": "ada@example.com",
  "brand": {
    "businessName": "Acme Cloud",
    "logoUrl": "https://acme.com/logo.png",
    "primaryColor": "#1e3a8a",
    "accentColor": "#10b981"
  },
  "successUrl": "https://acme.com/thank-you",
  "webhookUrl": "https://acme.com/webhooks/proxim"
}
```
Returns `session.sessionId`, `session.checkoutUrl` (hosted branded page), and `session.paymentMethods` (`ngnBank`, `globalBank`, `crypto` with QR data URI).

### 2. Embed Checkout Inline on Your Website (Drop-In JS SDK)
```html
<script src="https://<your-proxim-host>/sdk/proxim-checkout.js"></script>
<script>
  ProximCheckout.open({
    sessionId: "cs_live_...",
    onSuccess: (session) => console.log("Paid!", session),
    onClose: () => console.log("Closed"),
  });
</script>
```

### 3. Check / List / Cancel Checkout Sessions
- `GET /api/v1/checkout/sessions/:sessionId` — Verify live payment status (`open`, `paid`, `expired`, `cancelled`).
- `GET /api/v1/checkout/sessions?status=paid&reference=ORDER-99421` — List sessions.
- `POST /api/v1/checkout/sessions/:sessionId/cancel` — Cancel an unpaid session.

### 4. Reusable Payment Links
- `POST /api/v1/payment-links` — Create a fixed or flexible-amount link (`https://<host>/pay/<slug>`).
- `GET /api/v1/payment-links` — List your payment links.
- `DELETE /api/v1/payment-links/:linkId` — Deactivate a payment link.

### 5. White-Label Merchant Profile & Unified Analytics
Configure your business branding, default payment channels (Paj NGN, Tier-1 Global Banks, NEAR Intents Crypto), webhook URL, and redirect URLs **once** via API — every Checkout Session and Payment Link inherits them automatically:
- `GET /api/v1/merchant/profile` — Read saved white-label branding & default rails.
- `PUT /api/v1/merchant/profile` — Update `businessName`, `logoUrl`, `primaryColor`, `accentColor`, `defaultChannels`, `defaultCryptoChain`, `defaultGlobalBankCurrency`, `webhookUrl`, `successUrl`, `cancelUrl`.
- `GET /api/v1/merchant/analytics` — Unified revenue & settlement breakdown across all rails (`ngn_bank`, `global_bank_*`, `crypto_*`).

### 6. Real-Time Multi-Rail Settlement Webhook (`checkout.session.completed`)
When a customer completes payment on **any** Proxim rail (**Paj Naira Bank**, **Tier-1 Global Bank USD/GBP/EUR/NGN**, **NEAR Intents Solana/NEAR/Robinhood/Starknet**, or **Direct Arc/Base EVM**), Proxim automatically marks the session `paid` and sends an **HMAC-SHA256 signed** `POST` webhook (`X-Proxim-Signature`) to your `webhookUrl` with `{ "event": "checkout.session.completed", "data": { ...session } }`.
