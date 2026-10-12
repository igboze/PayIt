// src/api_routes.js
// Proxim Builder REST API Router (/api/v1/...)
// Grants external builders access to 100% of Proxim's capabilities
// with enforced API Key authentication and customizable feature permissions.

const url = require("node:url");
const apiKeys = require("./api_keys");
const db = require("./db");
const walletLib = require("./wallet");
const multichain = require("./multichain");
const solAddrLib = require("./solana_address");
const chains = require("./chains");
const nearLib = require("./near");
const invoiceDb = require("./invoice_db");
const paj = require("./paj");
const fx = require("./fx");
const savings = require("./savings");
const cctpBridge = require("./cctp_bridge");
const evmDepositSweeper = require("./evm_deposit_sweeper");
const { generateReceiptPNG } = require("./receipt_generator");
const fs = require("node:fs");

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("Malformed JSON request body"));
      }
    });
    req.on("error", reject);
  });
}

function extractApiKey(req) {
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  if (authHeader) return authHeader;
  return req.headers["x-api-key"] || req.headers["X-API-Key"] || null;
}

/**
 * Main request router for /api/v1/*
 */
async function handleApiRequest(req, res, bot = null) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    });
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname.replace(/\/+$/, "");
  const method = req.method.toUpperCase();

  // ── 1. Public Health & Features Catalog (No Auth Required) ────────────────
  if (method === "GET" && (pathname === "/api/v1/health" || pathname === "/api/v1")) {
    return sendJson(res, 200, {
      success: true,
      service: "Proxim Builder API",
      version: "1.0.0",
      status: "operational",
      time: new Date().toISOString(),
      supportedChains: ["Arc", "Solana", "NEAR", "Robinhood Chain", "Base", "Arbitrum", "Ethereum", "Polygon", "Avalanche", "Optimism"],
      docsUrl: "/BUILDER_API.md",
    });
  }

  if (method === "GET" && pathname === "/api/v1/features") {
    return sendJson(res, 200, {
      success: true,
      features: Object.values(apiKeys.AVAILABLE_FEATURES),
      description: "Builders can enable 'all' for 100% of Proxim, or pick specific features for custom apps.",
    });
  }

  // ── 2. Authentication & Authorization ─────────────────────────────────────
  const rawKey = extractApiKey(req);
  if (!rawKey) {
    return sendJson(res, 401, {
      success: false,
      error: "Missing API Key. Include 'Authorization: Bearer prx_live_...' or 'X-API-Key: prx_live_...'",
    });
  }

  // Determine required feature based on route
  let requiredFeature = null;
  if (pathname.startsWith("/api/v1/wallets")) requiredFeature = "wallets";
  else if (pathname.startsWith("/api/v1/transfers")) requiredFeature = "transfers";
  else if (pathname.startsWith("/api/v1/invoices")) requiredFeature = "invoices";
  else if (pathname.startsWith("/api/v1/onramp")) requiredFeature = "onramp";
  else if (pathname.startsWith("/api/v1/offramp")) requiredFeature = "offramp";
  else if (pathname.startsWith("/api/v1/deposits/crypto")) requiredFeature = "crypto_deposits";
  else if (pathname.startsWith("/api/v1/intents")) requiredFeature = "near_intents";
  else if (pathname.startsWith("/api/v1/bridge")) requiredFeature = "bridge";
  else if (pathname.startsWith("/api/v1/savings")) requiredFeature = "savings";
  else if (pathname.startsWith("/api/v1/receipts")) requiredFeature = "receipts";

  const authResult = apiKeys.verifyApiKey(rawKey, requiredFeature);
  if (!authResult.valid) {
    return sendJson(res, authResult.code || 401, {
      success: false,
      error: authResult.error,
    });
  }

  const apiKey = authResult.key;

  try {
    // ── 3. /api/v1/auth/me ───────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/v1/auth/me") {
      return sendJson(res, 200, {
        success: true,
        keyId: apiKey.key_id,
        appName: apiKey.app_name,
        allowedFeatures: apiKey.allowed_features,
        rateLimitPerMin: apiKey.rate_limit_per_min,
        createdAt: apiKey.created_at,
        lastUsedAt: apiKey.last_used_at,
      });
    }

    // ── 4. Wallets (/api/v1/wallets) ────────────────────────────────────────
    if (pathname.startsWith("/api/v1/wallets")) {
      // POST /api/v1/wallets — Provision or resolve customer wallet
      if (method === "POST" && pathname === "/api/v1/wallets") {
        const body = await parseBody(req);
        const identifier = body.userId || body.externalId || body.username || `builder_user_${Date.now()}`;
        const pin = String(body.pin || "123456");

        let user = typeof identifier === "number" ? db.getUser(identifier) : db.findUserByUsername(String(identifier));
        if (!user) {
          const generated = walletLib.generateUserWallet();
          const userNumId = typeof identifier === "number" ? identifier : (Math.floor(Math.random() * 800000000) + 100000000);
          user = db.createUserWithWallet(userNumId, String(identifier), generated.address, generated.privateKey, pin);
        }

        const arcAddress = user.deposit_address;
        const solAddress = chains.deriveAddress(user, "personal", "solana") || user.solana_deposit_address || user.solana_address;

        let nearAddress = null;
        try {
          const sysKey = db.getSystemDecryptedPrivateKey(user);
          nearAddress = nearLib.deriveNearAddress(sysKey).nearAddress;
        } catch (_) {}

        return sendJson(res, 201, {
          success: true,
          userId: user.telegram_id,
          username: user.username,
          addresses: {
            arc: arcAddress,
            solana: solAddress,
            near: nearAddress,
            robinhood: arcAddress, // Robinhood Chain uses standard EVM address
          },
        });
      }

      // GET /api/v1/wallets/:id/balance
      const balanceMatch = pathname.match(/^\/api\/v1\/wallets\/([^/]+)\/balance$/);
      if (method === "GET" && balanceMatch) {
        const id = decodeURIComponent(balanceMatch[1]);
        const user = !isNaN(Number(id)) ? db.getUser(Number(id)) : db.findUserByUsername(id);
        if (!user) return sendJson(res, 404, { success: false, error: "Wallet not found" });

        const unified = await chains.getUnifiedBalance(user, user.active_context || "personal");
        return sendJson(res, 200, {
          success: true,
          userId: user.telegram_id,
          totalUsdc: unified.totalUsdc,
          arcUsdc: unified.arcUsdc,
          solanaSplUsdc: unified.solanaSplUsdc,
          pendingBridgeUsdc: unified.pendingNearUsdc,
        });
      }

      // GET /api/v1/wallets/:id/addresses
      const addrMatch = pathname.match(/^\/api\/v1\/wallets\/([^/]+)\/addresses$/);
      if (method === "GET" && addrMatch) {
        const id = decodeURIComponent(addrMatch[1]);
        const user = !isNaN(Number(id)) ? db.getUser(Number(id)) : db.findUserByUsername(id);
        if (!user) return sendJson(res, 404, { success: false, error: "Wallet not found" });

        const arcAddress = user.deposit_address;
        const solAddress = chains.deriveAddress(user, user.active_context || "personal", "solana") || user.solana_deposit_address || user.solana_address;
        let nearAddress = null;
        try {
          const sysKey = db.getSystemDecryptedPrivateKey(user);
          nearAddress = nearLib.deriveNearAddress(sysKey).nearAddress;
        } catch (_) {}

        return sendJson(res, 200, {
          success: true,
          userId: user.telegram_id,
          addresses: {
            arc: arcAddress,
            solana: solAddress,
            near: nearAddress,
            robinhood: arcAddress,
          },
        });
      }
    }

    // ── 5. Transfers (/api/v1/transfers) ────────────────────────────────────
    if (pathname.startsWith("/api/v1/transfers")) {
      if (method === "POST" && pathname === "/api/v1/transfers") {
        const body = await parseBody(req);
        const { fromUserId, toAddress, amountUsdc, pin } = body;
        if (!fromUserId || !toAddress || !amountUsdc) {
          return sendJson(res, 400, { success: false, error: "fromUserId, toAddress, and amountUsdc are required" });
        }

        const user = db.getUser(Number(fromUserId));
        if (!user) return sendJson(res, 404, { success: false, error: "User wallet not found" });

        let privateKey;
        if (pin) {
          privateKey = db.decryptPrivateKey(user, String(pin));
        } else {
          privateKey = db.getSystemDecryptedPrivateKey(user);
        }

        const txRes = await walletLib.sendTransaction(user.deposit_address, toAddress, Number(amountUsdc), privateKey);
        db.recordTransaction(user.telegram_id, "transfer", String(amountUsdc), "completed", txRes.hash || txRes.txHash);

        return sendJson(res, 200, {
          success: true,
          txHash: txRes.hash || txRes.txHash,
          amountUsdc: Number(amountUsdc),
          recipient: toAddress,
        });
      }
    }

    // ── 6. Invoices (/api/v1/invoices) ──────────────────────────────────────
    if (pathname.startsWith("/api/v1/invoices")) {
      if (method === "POST" && pathname === "/api/v1/invoices") {
        const body = await parseBody(req);
        const { clientName, amount, currency = "USDC", items = [], memo = "", telegramId = 0 } = body;
        if (!clientName || !amount) {
          return sendJson(res, 400, { success: false, error: "clientName and amount are required" });
        }

        const invoiceNumber = `INV-${Date.now().toString(36).toUpperCase()}`;
        const ownerId = Number(telegramId) || apiKey.telegram_id || 100000000;
        const invItems = items.length ? items : [{ description: memo || "Invoice item", amount: Number(amount) }];
        const rowId = invoiceDb.createInvoice(ownerId, {
          invoiceNumber,
          clientName,
          clientEmail: body.clientEmail || null,
          items: invItems,
          totalUsdc: Number(amount),
          dueDate: body.dueDate || null,
          notes: memo,
          walletAddress: body.walletAddress || null,
        });
        const invoice = invoiceDb.getInvoiceByNumber(invoiceNumber) || invoiceDb.getInvoiceById(rowId);

        return sendJson(res, 201, {
          success: true,
          invoice,
          paymentUrl: `https://payit.app/invoice/${invoice?.invoice_number || invoiceNumber}`,
        });
      }

      const invMatch = pathname.match(/^\/api\/v1\/invoices\/([^/]+)$/);
      if (method === "GET" && invMatch) {
        const num = decodeURIComponent(invMatch[1]);
        const inv = invoiceDb.getInvoiceByNumber(num) || invoiceDb.getInvoiceById(Number(num));
        if (!inv) return sendJson(res, 404, { success: false, error: "Invoice not found" });
        return sendJson(res, 200, { success: true, invoice: inv });
      }

      if (method === "GET" && pathname === "/api/v1/invoices") {
        const invs = invoiceDb.getInvoices(apiKey.telegram_id || 0, 50);
        return sendJson(res, 200, { success: true, invoices: invs });
      }
    }

    // ── 7. Fiat Onramp & Offramp ─────────────────────────────────────────────
    if (pathname.startsWith("/api/v1/onramp")) {
      if (method === "POST" && pathname === "/api/v1/onramp/bank-transfer") {
        const body = await parseBody(req);
        const { amountNgn, recipientAddress, customerEmail, customerName } = body;
        if (!amountNgn || !recipientAddress) {
          return sendJson(res, 400, { success: false, error: "amountNgn and recipientAddress are required" });
        }

        const order = await paj.createOnrampOrder({
          amountFiat: Number(amountNgn),
          fiatCurrency: "NGN",
          cryptoCurrency: "USDC",
          recipientAddress,
          customerEmail: customerEmail || "customer@example.com",
          customerName: customerName || "Customer",
        });

        return sendJson(res, 200, {
          success: true,
          orderId: order.id || order.reference,
          virtualAccount: {
            bankName: order.bankName || order.paymentDetails?.bankName,
            accountNumber: order.accountNumber || order.paymentDetails?.accountNumber,
            accountName: order.accountName || order.paymentDetails?.accountName,
            amountNgn: Number(amountNgn),
            expiresAt: order.expiresAt,
          },
        });
      }

      const onrampStatusMatch = pathname.match(/^\/api\/v1\/onramp\/status\/([^/]+)$/);
      if (method === "GET" && onrampStatusMatch) {
        const orderId = decodeURIComponent(onrampStatusMatch[1]);
        const status = await paj.getOrderStatus(orderId);
        return sendJson(res, 200, { success: true, status });
      }
    }

    if (pathname.startsWith("/api/v1/offramp")) {
      if (method === "GET" && pathname === "/api/v1/offramp/rates") {
        const rates = await fx.getRates();
        return sendJson(res, 200, {
          success: true,
          ngnPerUsdc: rates.usdNgn,
          eurPerUsdc: rates.eurUsd,
          updatedAt: new Date().toISOString(),
        });
      }

      if (method === "POST" && pathname === "/api/v1/offramp/bank-transfer") {
        const body = await parseBody(req);
        const { amountUsdc, bankCode, accountNumber, accountName } = body;
        if (!amountUsdc || !bankCode || !accountNumber) {
          return sendJson(res, 400, { success: false, error: "amountUsdc, bankCode, and accountNumber are required" });
        }

        const payout = await paj.createOfframpPayout({
          amountUsdc: Number(amountUsdc),
          bankCode,
          accountNumber,
          accountName,
        });

        return sendJson(res, 200, { success: true, payout });
      }
    }

    // ── 8. NEAR Intents & Robinhood Chain (/api/v1/intents) ──────────────────
    if (pathname.startsWith("/api/v1/intents")) {
      // GET /api/v1/intents/tokens
      if (method === "GET" && pathname === "/api/v1/intents/tokens") {
        const nearTokens = await nearLib.getSupportedNearTokens();
        const solTokens = await nearLib.getSupportedSolanaTokens();
        const hoodTokens = await nearLib.getSupportedRobinhoodTokens();
        const starkTokens = await nearLib.getSupportedStarknetTokens();

        return sendJson(res, 200, {
          success: true,
          chains: {
            starknet: starkTokens,
            robinhood: hoodTokens,
            near: nearTokens,
            solana: solTokens,
          },
        });
      }

      // POST /api/v1/intents/quote
      if (method === "POST" && pathname === "/api/v1/intents/quote") {
        const body = await parseBody(req);
        const { originAsset, amount, recipient, refundTo } = body;
        if (!originAsset || !amount || !recipient) {
          return sendJson(res, 400, { success: false, error: "originAsset, amount, and recipient are required" });
        }

        const quote = await nearLib.getQuote({
          originAsset,
          destinationAsset: nearLib.ASSETS.BASE_USDC,
          amount: String(amount),
          recipient,
          refundTo: refundTo || recipient,
          dry: true,
        });

        return sendJson(res, 200, { success: true, quote });
      }

      // POST /api/v1/intents/deposits/starknet
      if (method === "POST" && pathname === "/api/v1/intents/deposits/starknet") {
        const body = await parseBody(req);
        const { originSymbol = "STRK", amount, recipientAddress, refundTo, telegramId = 0 } = body;
        if (!amount || !recipientAddress) {
          return sendJson(res, 400, { success: false, error: "amount and recipientAddress are required" });
        }

        const token = await nearLib.resolveStarknetToken(originSymbol);
        if (!token) return sendJson(res, 400, { success: false, error: `Starknet token '${originSymbol}' not recognized` });

        const row = await nearLib.createStarknetDeposit({
          telegramId: Number(telegramId) || apiKey.telegram_id || 0,
          originAsset: token.assetId,
          originSymbol: token.symbol,
          originDecimals: token.decimals,
          amount: Number(amount),
          recipientAddress,
          refundTo: refundTo || recipientAddress,
        });

        return sendJson(res, 201, {
          success: true,
          depositId: row.id,
          depositAddress: row.deposit_address,
          estimatedAmountOutUsdc: row.amount_out,
          deadline: row.deadline,
          status: row.status,
          instructions: `Send exactly ${amount} ${token.symbol} on Starknet to ${row.deposit_address}`,
        });
      }

      // POST /api/v1/intents/deposits/robinhood
      if (method === "POST" && pathname === "/api/v1/intents/deposits/robinhood") {
        const body = await parseBody(req);
        const { originSymbol = "USDG", amount, recipientAddress, refundTo, telegramId = 0 } = body;
        if (!amount || !recipientAddress) {
          return sendJson(res, 400, { success: false, error: "amount and recipientAddress are required" });
        }

        const token = await nearLib.resolveRobinhoodToken(originSymbol);
        if (!token) return sendJson(res, 400, { success: false, error: `Robinhood token '${originSymbol}' not recognized` });

        const row = await nearLib.createRobinhoodDeposit({
          telegramId: Number(telegramId) || apiKey.telegram_id || 0,
          originAsset: token.assetId,
          originSymbol: token.symbol,
          originDecimals: token.decimals,
          amount: Number(amount),
          recipientAddress,
          refundTo: refundTo || recipientAddress,
        });

        return sendJson(res, 201, {
          success: true,
          depositId: row.id,
          depositAddress: row.deposit_address,
          estimatedAmountOutUsdc: row.amount_out,
          deadline: row.deadline,
          status: row.status,
          instructions: `Send exactly ${amount} ${token.symbol} on Robinhood Chain to ${row.deposit_address}`,
        });
      }

      // POST /api/v1/intents/deposits/near
      if (method === "POST" && pathname === "/api/v1/intents/deposits/near") {
        const body = await parseBody(req);
        const { originSymbol = "USDC", amount, recipientAddress, refundTo, telegramId = 0 } = body;
        if (!amount || !recipientAddress || !refundTo) {
          return sendJson(res, 400, { success: false, error: "amount, recipientAddress, and refundTo are required" });
        }

        const token = await nearLib.resolveNearToken(originSymbol);
        if (!token) return sendJson(res, 400, { success: false, error: `NEAR token '${originSymbol}' not recognized` });

        const row = await nearLib.createNearDeposit({
          telegramId: Number(telegramId) || apiKey.telegram_id || 0,
          originAsset: token.assetId,
          originSymbol: token.symbol,
          originDecimals: token.decimals,
          amount: Number(amount),
          recipientAddress,
          refundTo,
        });

        return sendJson(res, 201, {
          success: true,
          depositId: row.id,
          depositAddress: row.deposit_address,
          depositMemo: row.deposit_memo,
          estimatedAmountOutUsdc: row.amount_out,
          status: row.status,
        });
      }

      // POST /api/v1/intents/deposits/solana
      if (method === "POST" && pathname === "/api/v1/intents/deposits/solana") {
        const body = await parseBody(req);
        const { originSymbol = "SOL", amount, recipientAddress, refundTo, telegramId = 0 } = body;
        if (!amount || !recipientAddress || !refundTo) {
          return sendJson(res, 400, { success: false, error: "amount, recipientAddress, and refundTo are required" });
        }

        const token = await nearLib.resolveSolanaToken(originSymbol);
        if (!token) return sendJson(res, 400, { success: false, error: `Solana token '${originSymbol}' not recognized` });

        const row = await nearLib.createSolanaDeposit({
          telegramId: Number(telegramId) || apiKey.telegram_id || 0,
          originAsset: token.assetId,
          originSymbol: token.symbol,
          originDecimals: token.decimals,
          amount: Number(amount),
          recipientAddress,
          refundTo,
        });

        return sendJson(res, 201, {
          success: true,
          depositId: row.id,
          depositAddress: row.deposit_address,
          estimatedAmountOutUsdc: row.amount_out,
          status: row.status,
        });
      }

      // GET /api/v1/intents/deposits/:id
      const depositStatusMatch = pathname.match(/^\/api\/v1\/intents\/deposits\/([^/]+)$/);
      if (method === "GET" && depositStatusMatch) {
        const depId = Number(depositStatusMatch[1]);
        const dep = db.getNearDepositById(depId);
        if (!dep) return sendJson(res, 404, { success: false, error: "Deposit not found" });

        let liveStatus = null;
        if (dep.deposit_address) {
          try {
            liveStatus = await nearLib.getExecutionStatus(dep.deposit_address, dep.deposit_memo);
          } catch (_) {}
        }

        return sendJson(res, 200, {
          success: true,
          deposit: dep,
          liveSolverStatus: liveStatus,
        });
      }
    }

    // ── 9. Savings & Yield (/api/v1/savings) ─────────────────────────────────
    if (pathname.startsWith("/api/v1/savings")) {
      if (method === "GET" && pathname === "/api/v1/savings/rates") {
        return sendJson(res, 200, {
          success: true,
          apy: 0.082, // 8.2% APY
          vault: "Morpho USDC Prime Vault (ERC-4626)",
          autoEarnThresholdHours: 2,
        });
      }

      if (method === "POST" && pathname === "/api/v1/savings/deposit") {
        const body = await parseBody(req);
        const { userId, amountUsdc } = body;
        if (!userId || !amountUsdc) {
          return sendJson(res, 400, { success: false, error: "userId and amountUsdc required" });
        }

        const pos = db.openYieldPosition(Number(userId), Number(amountUsdc), 0.082, "Morpho", "USDC", "arc");
        return sendJson(res, 200, { success: true, position: pos });
      }

      if (method === "POST" && pathname === "/api/v1/savings/withdraw") {
        const body = await parseBody(req);
        const { userId } = body;
        if (!userId) return sendJson(res, 400, { success: false, error: "userId required" });

        const open = db.getOpenYieldPosition(Number(userId));
        if (!open) return sendJson(res, 404, { success: false, error: "No active savings position found" });

        const closed = db.closeYieldPosition(open.id, open.amount_usdc);
        return sendJson(res, 200, { success: true, withdrawnAmount: open.amount_usdc, position: closed });
      }
    }

    // ── 10. Multi-Chain EVM Deposits (/api/v1/deposits/crypto) ───────────────
    if (pathname.startsWith("/api/v1/deposits/crypto")) {
      // GET /api/v1/deposits/crypto/chains
      if (method === "GET" && pathname === "/api/v1/deposits/crypto/chains") {
        const chainsList = Object.entries(evmDepositSweeper.DEX_ROUTER_CONFIGS).map(([k, cfg]) => ({
          chainKey: k,
          name: cfg.name,
          chainId: cfg.chainId,
          nativeSymbol: cfg.nativeSymbol,
          usdcAddress: cfg.usdcAddress,
          isRelayIntent: !!cfg.isRelayIntent,
        }));
        return sendJson(res, 200, { success: true, chains: chainsList });
      }

      // GET /api/v1/deposits/crypto/address/:userId
      const addrMatch = pathname.match(/^\/api\/v1\/deposits\/crypto\/address\/([^/]+)$/);
      if (method === "GET" && addrMatch) {
        const userId = decodeURIComponent(addrMatch[1]);
        const user = !isNaN(Number(userId)) ? db.getUser(Number(userId)) : db.findUserByUsername(userId);
        if (!user) return sendJson(res, 404, { success: false, error: "User wallet not found" });

        return sendJson(res, 200, {
          success: true,
          userId: user.telegram_id,
          depositAddress: user.deposit_address,
          supportedChains: ["Base", "Arbitrum", "Ethereum", "Optimism", "Polygon", "Avalanche", "Robinhood Chain"],
          note: "Incoming deposits of ETH/AVAX/MATIC or USDC on any supported chain are automatically detected, converted to USDC, and swept to Arc.",
        });
      }

      // POST /api/v1/deposits/crypto/sweep
      if (method === "POST" && pathname === "/api/v1/deposits/crypto/sweep") {
        const body = await parseBody(req);
        const { userId } = body;
        if (!userId) return sendJson(res, 400, { success: false, error: "userId required" });

        const user = db.getUser(Number(userId));
        if (!user) return sendJson(res, 404, { success: false, error: "User not found" });

        const sweepResult = await evmDepositSweeper.sweepUserDeposits(user.telegram_id, bot);
        return sendJson(res, 200, { success: true, sweepResult });
      }
    }

    // ── 11. CCTP Cross-Chain Bridge (/api/v1/bridge) ─────────────────────────
    if (pathname.startsWith("/api/v1/bridge")) {
      // GET /api/v1/bridge/supported
      if (method === "GET" && pathname === "/api/v1/bridge/supported") {
        return sendJson(res, 200, {
          success: true,
          protocol: "Circle CCTP",
          domains: cctpBridge.CCTP_DOMAINS,
          supportedChains: ["Arc", "Solana", "Base", "Arbitrum", "Optimism", "Polygon", "Avalanche", "Ethereum"],
        });
      }

      // POST /api/v1/bridge/transfer
      if (method === "POST" && pathname === "/api/v1/bridge/transfer") {
        const body = await parseBody(req);
        const { userId, destinationChain, destinationAddress, amountUsdc, pin } = body;
        if (!userId || !destinationChain || !destinationAddress || !amountUsdc) {
          return sendJson(res, 400, { success: false, error: "userId, destinationChain, destinationAddress, and amountUsdc required" });
        }

        const user = db.getUser(Number(userId));
        if (!user) return sendJson(res, 404, { success: false, error: "User not found" });

        let privateKey;
        if (pin) {
          privateKey = db.decryptPrivateKey(user, String(pin));
        } else {
          privateKey = db.getSystemDecryptedPrivateKey(user);
        }

        const { Wallet } = require("ethers");
        const userWallet = new Wallet(privateKey);

        const result = await cctpBridge.executeArcCrossChainWithdrawal({
          userWallet,
          destinationChain,
          destinationAddress,
          amountUsdc: Number(amountUsdc),
          telegramId: user.telegram_id,
        });

        return sendJson(res, 200, { success: true, result });
      }
    }

    // ── 12. Receipts (/api/v1/receipts) ──────────────────────────────────────
    if (pathname.startsWith("/api/v1/receipts")) {
      const receiptMatch = pathname.match(/^\/api\/v1\/receipts\/([^/]+)$/);
      if (method === "GET" && receiptMatch) {
        const txHash = decodeURIComponent(receiptMatch[1]);
        const tx = db.prepare("SELECT * FROM transactions WHERE tx_hash = ?").get(txHash);
        if (!tx) return sendJson(res, 404, { success: false, error: "Transaction receipt not found" });

        const decimals = tx.decimals !== undefined && tx.decimals !== null ? Number(tx.decimals) : 6;
        const amountUsdc = tx.amount_micro ? Number(tx.amount_micro) / Math.pow(10, decimals) : null;

        // If client requested PNG image format, render and return binary PNG
        if (parsedUrl.query && (parsedUrl.query.format === "png" || parsedUrl.query.download === "true")) {
          try {
            const pngPath = await generateReceiptPNG({
              receiptId: (tx.tx_hash || String(tx.id)).slice(0, 12),
              senderName: "Proxim Wallet",
              senderAddress: "0x...",
              recipientName: "Payee",
              recipientAddress: "0x...",
              amountUsdc: amountUsdc || 0,
              type: tx.type || "Payment",
              timestamp: tx.created_at || new Date().toISOString(),
              status: tx.status === "completed" || tx.status === "confirmed" ? "Confirmed" : "Pending",
              txHash: tx.tx_hash,
            });
            const pngBuf = fs.readFileSync(pngPath);
            try { fs.unlinkSync(pngPath); } catch (_) {}
            res.writeHead(200, {
              "Content-Type": "image/png",
              "Content-Length": pngBuf.length,
            });
            return res.end(pngBuf);
          } catch (err) {
            console.warn("[api_routes:receipt_png_error]", err.message);
          }
        }

        return sendJson(res, 200, {
          success: true,
          receipt: {
            id: tx.id,
            txHash: tx.tx_hash,
            amountUsdc,
            status: tx.status,
            type: tx.type,
            createdAt: tx.created_at,
            pngUrl: `/api/v1/receipts/${encodeURIComponent(tx.tx_hash)}?format=png`,
          },
        });
      }
    }

    // Fallthrough: 404 for unknown endpoint
    return sendJson(res, 404, {
      success: false,
      error: `Endpoint '${method} ${pathname}' not found. Review BUILDER_API.md for available routes.`,
    });
  } catch (err) {
    console.error("[api_routes] Error handling API request:", err);
    return sendJson(res, 500, {
      success: false,
      error: err.message || "Internal server error",
    });
  }
}

module.exports = {
  handleApiRequest,
  sendJson,
  parseBody,
  extractApiKey,
};
