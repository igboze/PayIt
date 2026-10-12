# 🛠️ Proxim Builder API Documentation

The **Proxim Builder API** allows developers to build their own fintech, payment, commerce, and cross-chain applications powered by **100% of Proxim's infrastructure**.

Builders can access all capabilities via secure API keys, and can **customize their keys** to only enable the specific features their application needs.

---

## 🚀 Quickstart & Key Lifecycle

### 1. Generating an API Key

API keys can be generated directly inside the Proxim Telegram Bot with custom permission scoping:

1. **Open Developer Portal**:
   - Send `/developer` or `/api` to the bot (or tap **[🛠️ Developer API]** in the main menu).
2. **Create New Key**:
   - Tap **[➕ Generate New API Key]** and enter your application name (e.g. `My Checkout Bot`, `Crypto Wallet App`).
3. **Choose Permissions Profile**:
   - **🌟 100% Full Access (`all`)**: Grants unrestricted access to all current and future Proxim features.
   - **⚙️ Custom Scoped Features**: Select only the exact modules needed for your app (e.g. only `wallets` and `invoices`). Features can be toggled on/off interactively.
4. **Copy Secret Key**:
   - Your secret key format is `prx_live_<48_hex_chars>` (e.g. `prx_live_a9b1c2d3...`).
   - ⚠️ **Important**: For security, secret keys are hashed with **SHA-256** and never stored in plain text. The raw key is displayed **only once** upon generation. Store it securely in your `.env` file.

### 2. Managing & Revoking Keys
- Run `/developer` anytime to inspect your active keys, see last-used timestamps, edit allowed features, or revoke keys immediately if compromised.

### 3. Authentication & Headers
Include your key in the HTTP headers of every request using either:
```http
Authorization: Bearer prx_live_YOUR_SECRET_KEY
```
or
```http
X-API-Key: prx_live_YOUR_SECRET_KEY
```

### 4. Rate Limiting
- Default rate limit: **120 requests per minute** per API key.
- If exceeded, the server returns HTTP `429 Too Many Requests`.

### 5. Base URL
```
https://api.proxim.finance/api/v1
```
*(Or your local/self-hosted deployment: `http://localhost:3000/api/v1`)*

---

## ⚙️ Customizable Feature Permissions

Each API key can have full access (`"all"`), or a customized list of features:

| Feature Identifier | Description | Capabilities |
| :--- | :--- | :--- |
| `all` | **100% Full Access** | Access all current and future endpoints |
| `wallets` | **Multichain Wallets** | Create customer wallets, get addresses, check unified balances |
| `transfers` | **Instant Transfers** | Send gasless USDC and tokens on Arc Mainnet |
| `invoices` | **Invoicing & Checkout** | Generate personal/business invoices, QR codes, payment tracking |
| `onramp` | **Naira Onramp** | Dynamic Nigerian virtual bank accounts for fiat deposits |
| `offramp` | **Naira Offramp** | Payout USDC to any Nigerian commercial bank account |
| `crypto_deposits` | **Multi-Chain EVM** | Deposit addresses on Ethereum, Base, Arbitrum, Polygon, Avalanche |
| `near_intents` | **NEAR Intents & Robinhood Chain** | Cross-chain swaps for Robinhood Chain, Solana, and NEAR tokens |
| `bridge` | **CCTP Cross-Chain Bridge** | Native USDC bridging between Arc and Solana / EVM |
| `savings` | **Yield & Savings Vaults** | ERC-4626 USDC deposits, interest accrual, withdrawals |
| `receipts` | **Proof & Receipts** | Cryptographic payment proofs and PNG receipts |

*If an API key attempts to call an endpoint for a feature that is not enabled, the API returns `403 Forbidden`.*

---

## 📡 API Endpoints Reference

### 1. System & Authentication

#### Health & Status
```http
GET /api/v1/health
```
**Response:**
```json
{
  "success": true,
  "service": "Proxim Builder API",
  "version": "1.0.0",
  "status": "operational",
  "supportedChains": ["Arc", "Solana", "NEAR", "Robinhood Chain", "Starknet", "Base", "Arbitrum", "Ethereum", "Polygon", "Avalanche"]
}
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
**Response:**
```json
{
  "success": true,
  "keyId": "key_9f83b211a4c2",
  "appName": "Acme Pay",
  "allowedFeatures": ["all"],
  "rateLimitPerMin": 120,
  "createdAt": "2026-10-11 06:45:00"
}
```

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
  "amountUsdc": 25.50
}
```
**Response (200 OK):**
```json
{
  "success": true,
  "txHash": "0x98f3b20c91823746192837465102938475610293847561029384756102938475",
  "amountUsdc": 25.50,
  "recipient": "0x8888888888888888888888888888888888888888"
}
```

---

### 4. Invoices & Checkout (`feature: "invoices"`)

#### Create Payment Invoice
```http
POST /api/v1/invoices
```
**Request Body:**
```json
{
  "clientName": "Globex Inc",
  "amount": 250.00,
  "currency": "USDC",
  "items": [
    { "description": "Software Subscription", "amount": 250.00 }
  ],
  "memo": "October Billing"
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
    "status": "draft"
  },
  "paymentUrl": "https://payit.app/invoice/INV-M39K10A"
}
```

#### Get Invoice Status
```http
GET /api/v1/invoices/:invoiceNumber
```

---

### 5. NEAR Intents & Robinhood Chain (`feature: "near_intents"`)

NEAR Intents allows your users to send **any token from Robinhood Chain, Solana, or NEAR**, automatically swap it to Base USDC, and bridge it to Arc USDC without manual bridging steps.

#### Get Supported Tokens
```http
GET /api/v1/intents/tokens
```
Returns tokens for `starknet`, `robinhood`, `solana`, and `near`.

#### Create Starknet Deposit
```http
POST /api/v1/intents/deposits/starknet
```
**Request Body:**
```json
{
  "originSymbol": "STRK",
  "amount": 100.00,
  "recipientAddress": "0x4b78a99268f7d983411b0e5192b45100a738491c"
}
```
*Supported Starknet tokens: `STRK`, `ETH`, `ZEC`, `XRP`.*

**Response (201 Created):**
```json
{
  "success": true,
  "depositId": 143,
  "depositAddress": "0x05342a...",
  "estimatedAmountOutUsdc": 10.45,
  "status": "awaiting_deposit",
  "instructions": "Send exactly 100 STRK on Starknet to 0x05342a..."
}
```

#### Create Robinhood Chain Deposit
```http
POST /api/v1/intents/deposits/robinhood
```
**Request Body:**
```json
{
  "originSymbol": "USDG",
  "amount": 10.00,
  "recipientAddress": "0x4b78a99268f7d983411b0e5192b45100a738491c"
}
```
*Supported Robinhood Chain tokens: `USDG`, `ETH`, `WETH`, `USDe`, `PONS`, `CASHCAT`.*

**Response (201 Created):**
```json
{
  "success": true,
  "depositId": 142,
  "depositAddress": "0x38a0A25058938332A1912135394d3E560325e902",
  "estimatedAmountOutUsdc": 9.967,
  "status": "awaiting_deposit",
  "instructions": "Send exactly 10 USDG on Robinhood Chain to 0x38a0A25058938332A1912135394d3E560325e902"
}
```

#### Track Intent Deposit Status
```http
GET /api/v1/intents/deposits/:depositId
```

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
  "recipientAddress": "0x4b78a99268f7d983411b0e5192b45100a738491c",
  "customerEmail": "customer@example.com",
  "customerName": "Alice Johnson"
}
```
**Response (200 OK):**
```json
{
  "success": true,
  "orderId": "ord_9381023",
  "virtualAccount": {
    "bankName": "Wema Bank / Paj",
    "accountNumber": "9827361829",
    "accountName": "Proxim / Alice Johnson",
    "amountNgn": 50000,
    "expiresAt": "2026-10-11T08:00:00Z"
  }
}
```

#### Withdraw to Nigerian Bank (Offramp)
```http
POST /api/v1/offramp/bank-transfer
```
**Request Body:**
```json
{
  "amountUsdc": 35.00,
  "bankCode": "058",
  "accountNumber": "0123456789",
  "accountName": "Alice Johnson"
}
```

---

### 7. Savings & Yield (`feature: "savings"`)

#### Get Current Yield APY
```http
GET /api/v1/savings/rates
```
**Response:**
```json
{
  "success": true,
  "apy": 0.082,
  "vault": "Morpho USDC Prime Vault (ERC-4626)"
}
```

#### Deposit into Savings Vault
```http
POST /api/v1/savings/deposit
```
**Request Body:**
```json
{
  "userId": 583920194,
  "amountUsdc": 100.00
}
```

---

### 8. Multi-Chain EVM Deposits (`feature: "crypto_deposits"`)

Enables customer deposit addresses on external EVM chains with automated DEX swap (native token → USDC) and CCTP auto-sweep directly to Arc USDC.

#### Supported Chains & DEX Configurations
```http
GET /api/v1/deposits/crypto/chains
```
**Response (200 OK):**
```json
{
  "success": true,
  "chains": [
    { "chainKey": "BASE", "name": "Base", "chainId": 8453, "nativeSymbol": "ETH", "usdcAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    { "chainKey": "ARBITRUM", "name": "Arbitrum", "chainId": 42161, "nativeSymbol": "ETH", "usdcAddress": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
    { "chainKey": "ETHEREUM", "name": "Ethereum", "chainId": 1, "nativeSymbol": "ETH", "usdcAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    { "chainKey": "ROBINHOOD", "name": "Robinhood Chain", "chainId": 4663, "nativeSymbol": "ETH" }
  ]
}
```

#### Get Customer Multi-Chain Deposit Address
```http
GET /api/v1/deposits/crypto/address/:userId
```
**Response:**
```json
{
  "success": true,
  "userId": 583920194,
  "depositAddress": "0x4b78a99268f7d983411b0e5192b45100a738491c",
  "supportedChains": ["Base", "Arbitrum", "Ethereum", "Optimism", "Polygon", "Avalanche", "Robinhood Chain"],
  "note": "Incoming deposits of ETH/AVAX/MATIC or USDC on any supported chain are automatically detected, converted to USDC, and swept to Arc."
}
```

#### Trigger On-Demand Deposit Sweep
```http
POST /api/v1/deposits/crypto/sweep
```
**Request Body:**
```json
{
  "userId": 583920194
}
```

---

### 9. Circle CCTP Cross-Chain Bridge (`feature: "bridge"`)

Bridge native USDC with zero slippage between Arc Mainnet, Solana, and EVM chains using Circle CCTP.

#### Supported CCTP Domains
```http
GET /api/v1/bridge/supported
```
**Response:**
```json
{
  "success": true,
  "protocol": "Circle CCTP",
  "supportedChains": ["Arc", "Solana", "Base", "Arbitrum", "Optimism", "Polygon", "Avalanche", "Ethereum"]
}
```

#### Execute Cross-Chain USDC Transfer / Withdrawal
```http
POST /api/v1/bridge/transfer
```
**Request Body:**
```json
{
  "userId": 583920194,
  "destinationChain": "Solana",
  "destinationAddress": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  "amountUsdc": 50.00
}
```

---

### 10. Proofs & Payment Receipts (`feature: "receipts"`)

Query transaction receipts and fetch downloadable cryptographic PNG receipt cards.

#### Query Receipt (JSON)
```http
GET /api/v1/receipts/:txHash
```
**Response:**
```json
{
  "success": true,
  "receipt": {
    "id": 1024,
    "txHash": "0x7a8b9c...",
    "amountUsdc": 50.00,
    "status": "completed",
    "type": "transfer",
    "createdAt": "2026-10-11T09:15:00Z",
    "pngUrl": "/api/v1/receipts/0x7a8b9c...?format=png"
  }
}
```

#### Download Receipt Image (PNG)
```http
GET /api/v1/receipts/:txHash?format=png
```
Returns a high-resolution, branded PNG receipt card (`image/png`) suitable for direct rendering or customer download.

## 💻 Code Examples

### Node.js / JavaScript
```javascript
const axios = require("axios");

const proxim = axios.create({
  baseURL: "https://api.proxim.finance/api/v1",
  headers: {
    Authorization: `Bearer prx_live_YOUR_API_KEY`,
    "Content-Type": "application/json",
  },
});

async function main() {
  // 1. Verify API Key
  const me = await proxim.get("/auth/me");
  console.log("Connected to Proxim as:", me.data.appName);

  // 2. Create customer wallet
  const wallet = await proxim.post("/wallets", {
    username: "john_doe",
  });
  console.log("Customer Arc Address:", wallet.data.addresses.arc);
  console.log("Customer Robinhood Address:", wallet.data.addresses.robinhood);

  // 3. Create a Robinhood Chain deposit quote
  const deposit = await proxim.post("/intents/deposits/robinhood", {
    originSymbol: "USDG",
    amount: 50,
    recipientAddress: wallet.data.addresses.arc,
  });
  console.log("Deposit Address:", deposit.data.depositAddress);
}

main();
```

### Python
```python
import requests

PROXIM_URL = "https://api.proxim.finance/api/v1"
HEADERS = {
    "Authorization": "Bearer prx_live_YOUR_API_KEY",
    "Content-Type": "application/json"
}

# Check API health & active features
res = requests.get(f"{PROXIM_URL}/auth/me", headers=HEADERS)
print("Builder Info:", res.json())

# Create a Robinhood Chain deposit
hood_deposit = requests.post(f"{PROXIM_URL}/intents/deposits/robinhood", headers=HEADERS, json={
    "originSymbol": "USDG",
    "amount": 20,
    "recipientAddress": "0x4b78a99268f7d983411b0e5192b45100a738491c"
})
print("Deposit Instructions:", hood_deposit.json())
```
