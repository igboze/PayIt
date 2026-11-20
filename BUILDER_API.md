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
| `onramp` | **Naira Onramp** | Dynamic Nigerian virtual bank accounts via Paj v2 |
| `offramp` | **Naira Offramp** | Live USD/NGN rates and Naira bank payouts via Paj v2 |
| `crypto_deposits` | **Multi-Chain EVM** | EVM deposit addresses & on-demand DEX/CCTP sweep to Arc |
| `near_intents` | **NEAR Intents & Robinhood Chain** | Cross-chain swaps across Starknet, Robinhood Chain, Solana, and NEAR |
| `bridge` | **CCTP Cross-Chain Bridge** | Native USDC bridging between Arc and Solana / EVM |
| `savings` | **Yield & Savings Vaults** | Live Circle EarnKit / ERC-4626 vaults, real on-chain deposits & withdrawals |
| `receipts` | **Proof & Receipts** | Transaction receipt JSON and HD PNG receipt cards |

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
*(If `pin` is omitted, a cryptographically random secret is generated automatically.)*

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
