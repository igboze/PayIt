# Alchemy Token Balances Quickstart

A minimal Node.js project that calls the Alchemy API [`alchemy_getTokenBalances`](https://docs.alchemy.com/reference/alchemy-gettokenbalances) method on Ethereum Mainnet.

## Setup Instructions

### 1. Create your `.env` file
Create a file named `.env` in this directory (`alchemy-token-balances/`):

```bash
ALCHEMY_API_KEY=your_alchemy_api_key_here
```

> **Security Note**: Never commit your `.env` file or hard-code your API key in source code. `.env` is already added to `.gitignore`.

### 2. Install dependencies
```bash
npm install
```

### 3. Run the script
Run with the default address (vitalik.eth):
```bash
npm start
```
Or pass any Ethereum address as an argument:
```bash
node index.js 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```
