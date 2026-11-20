// src/api_routes.js
// Proxim Builder REST API Router (/api/v1/...)
// Grants external builders access to Proxim's real on-chain & fiat infrastructure
// with enforced API Key authentication, customizable feature permissions, and strict tenant isolation.

const url = require("node:url");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const apiKeys = require("./api_keys");
const db = require("./db");
const walletLib = require("./wallet");
const multichain = require("./multichain");
const chains = require("./chains");
const nearLib = require("./near");
const invoiceDb = require("./invoice_db");
const paj = require("./paj");
const fx = require("./fx");
const savings = require("./savings");
const cctpBridge = require("./cctp_bridge");
const evmDepositSweeper = require("./evm_deposit_sweeper");
const { generateReceiptPNG } = require("./receipt_generator");

const DOCS_PATH = path.join(__dirname, "..", "BUILDER_API.md");

function getPublicBaseUrl(req = null) {
  if (process.env.PUBLIC_API_URL && process.env.PUBLIC_API_URL.trim()) {
    return process.env.PUBLIC_API_URL.trim().replace(/\/+$/, "");
  }
  if (process.env.WEBHOOK_URL && process.env.WEBHOOK_URL.trim()) {
    try {
      return new URL(process.env.WEBHOOK_URL.trim()).origin;
    } catch (_) {
      return process.env.WEBHOOK_URL.trim().replace(/\/+$/, "");
    }
  }
  if (process.env.RAILWAY_PUBLIC_DOMAIN && process.env.RAILWAY_PUBLIC_DOMAIN.trim()) {
    const dom = process.env.RAILWAY_PUBLIC_DOMAIN.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    return `https://${dom}`;
  }
  if (req && req.headers && req.headers.host) {
    const proto = req.headers["x-forwarded-proto"] || "http";
    return `${proto}://${req.headers.host}`.replace(/\/+$/, "");
  }
  return `http://localhost:${process.env.PORT || 3000}`;
}

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
 * Enforce strict tenant isolation: an API key can only operate on wallets it
 * provisioned (tracked in api_key_wallets) or the key creator's own account.
 */
function assertWalletAccess(apiKey, targetTelegramId, res) {
  if (!db.isWalletOwnedByApiKey(apiKey.key_id, targetTelegramId, apiKey.telegram_id)) {
    sendJson(res, 403, {
      success: false,
      error: "Forbidden: this API key does not have access to the requested wallet or resource",
    });
    return false;
  }
  return true;
}

/**
 * Unlock a user's custodial EVM private key using either their PIN or the
 * server-managed encrypted key.
 */
function resolvePrivateKey(user, pin) {
  let privateKey = null;
  if (pin !== undefined && pin !== null && String(pin).trim() !== "") {
    privateKey = db.decryptPrivateKey(String(pin), user);
  } else {
    privateKey = db.getSystemDecryptedPrivateKey(user);
  }
  if (!privateKey) {
    throw new Error("Unable to unlock wallet private key — provide a valid pin");
  }
  return privateKey;
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
  const baseUrl = getPublicBaseUrl(req);

  // ── 1. Public Health, Features & Live Docs (No Auth Required) ─────────────
  if (method === "GET" && (pathname === "/api/v1/health" || pathname === "/api/v1")) {
    return sendJson(res, 200, {
      success: true,
      service: "Proxim Builder API",
      version: "1.1.0",
      status: "operational",
      time: new Date().toISOString(),
      baseUrl: `${baseUrl}/api/v1`,
      supportedChains: ["Arc", "Solana", "NEAR", "Robinhood Chain", "Starknet", "Base", "Arbitrum", "Ethereum", "Polygon", "Avalanche", "Optimism"],
      docsUrl: `${baseUrl}/api/v1/docs`,
    });
  }

  if (method === "GET" && pathname === "/api/v1/features") {
    return sendJson(res, 200, {
      success: true,
      features: Object.values(apiKeys.AVAILABLE_FEATURES),
      description: "Builders can enable 'all' for full access, or pick specific features for custom apps.",
    });
  }

  if (method === "GET" && (pathname === "/api/v1/docs" || pathname === "/api/v1/BUILDER_API.md")) {
    try {
      const md = fs.readFileSync(DOCS_PATH, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(md);
    } catch (err) {
      return sendJson(res, 404, { success: false, error: "Documentation file not available" });
    }
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
        baseUrl: `${baseUrl}/api/v1`,
        createdAt: apiKey.created_at,
        lastUsedAt: apiKey.last_used_at,
      });
    }

    // ── 4. Wallets (/api/v1/wallets) ────────────────────────────────────────
    if (pathname.startsWith("/api/v1/wallets")) {
      // POST /api/v1/wallets — Provision or resolve customer wallet owned by this API key
      if (method === "POST" && pathname === "/api/v1/wallets") {
        const body = await parseBody(req);
        const identifier = body.userId || body.externalId || body.username || `builder_user_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
        const pin = body.pin ? String(body.pin) : crypto.randomBytes(12).toString("hex");

        let user = typeof identifier === "number" ? db.getUser(identifier) : db.findUserByUsername(String(identifier));
        if (user) {
          // Do not allow an API key to hijack another user's or another tenant's existing wallet
          if (!db.isWalletOwnedByApiKey(apiKey.key_id, user.telegram_id, apiKey.telegram_id)) {
            return sendJson(res, 409, {
              success: false,
              error: "Wallet identifier already belongs to another account",
            });
          }
        } else {
          const generated = walletLib.generateUserWallet();
          const userNumId = typeof identifier === "number"
            ? identifier
            : (100000000 + crypto.randomInt(800000000));
          user = db.createUserWithWallet(userNumId, String(identifier), generated.address, generated.privateKey, pin);
          db.registerApiKeyWallet(apiKey.key_id, user.telegram_id);
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
            robinhood: arcAddress,
          },
        });
      }

      // GET /api/v1/wallets/:id/balance
      const balanceMatch = pathname.match(/^\/api\/v1\/wallets\/([^/]+)\/balance$/);
      if (method === "GET" && balanceMatch) {
        const id = decodeURIComponent(balanceMatch[1]);
        const user = !isNaN(Number(id)) ? db.getUser(Number(id)) : db.findUserByUsername(id);
        if (!user) return sendJson(res, 404, { success: false, error: "Wallet not found" });
        if (!assertWalletAccess(apiKey, user.telegram_id, res)) return;

        const unified = await chains.getUnifiedBalance(user, user.active_context || "personal");
        return sendJson(res, 200, {
          success: true,
          userId: user.telegram_id,
          totalUsdc: unified.total,
          arcUsdc: unified.arc.usdc,
          arcEurc: unified.arc.eurc,
          solanaSplUsdc: unified.solana.usdc,
          pendingBridgeUsdc: unified.pendingNear,
        });
      }

      // GET /api/v1/wallets/:id/addresses
      const addrMatch = pathname.match(/^\/api\/v1\/wallets\/([^/]+)\/addresses$/);
      if (method === "GET" && addrMatch) {
        const id = decodeURIComponent(addrMatch[1]);
        const user = !isNaN(Number(id)) ? db.getUser(Number(id)) : db.findUserByUsername(id);
        if (!user) return sendJson(res, 404, { success: false, error: "Wallet not found" });
        if (!assertWalletAccess(apiKey, user.telegram_id, res)) return;

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
        const parsedAmount = Number(amountUsdc);
        if (!fromUserId || !toAddress || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
          return sendJson(res, 400, { success: false, error: "fromUserId, toAddress, and positive amountUsdc are required" });
        }
        if (!walletLib.isValidAddress(toAddress)) {
          return sendJson(res, 400, { success: false, error: "Invalid recipient EVM address" });
        }

        const user = db.getUser(Number(fromUserId));
        if (!user) return sendJson(res, 404, { success: false, error: "User wallet not found" });
        if (!assertWalletAccess(apiKey, user.telegram_id, res)) return;

        const privateKey = resolvePrivateKey(user, pin);
        const signer = walletLib.walletFromPrivateKey(privateKey);
        const amountMicro = walletLib.parseToMicro(parsedAmount.toFixed(6));

        const txRes = await walletLib.sendSponsoredOrDirectTransaction(
          signer,
          toAddress,
          amountMicro,
          "0x",
          { waitForConfirmation: Boolean(body.waitForConfirmation) }
        );
        const txHash = txRes.txHash || txRes.hash;
        db.recordTransaction(
          user.telegram_id,
          "transfer",
          String(amountMicro),
          "completed",
          txHash,
          "personal",
          18,
          "arc",
          body.narration || body.memo || null
        );

        return sendJson(res, 200, {
          success: true,
          txHash,
          sponsored: Boolean(txRes.sponsored),
          amountUsdc: parsedAmount,
          recipient: toAddress,
        });
      }
    }

    // ── 6. Invoices (/api/v1/invoices) ──────────────────────────────────────
    if (pathname.startsWith("/api/v1/invoices")) {
      if (method === "POST" && pathname === "/api/v1/invoices") {
        const body = await parseBody(req);
        const { clientName, amount, items = [], memo = "", telegramId = 0, userId = 0 } = body;
        const parsedAmount = Number(amount);
        if (!clientName || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
          return sendJson(res, 400, { success: false, error: "clientName and positive amount are required" });
        }

        const requestedOwner = Number(userId || telegramId || 0);
        let ownerId = apiKey.telegram_id || 0;
        if (requestedOwner > 0) {
          if (!assertWalletAccess(apiKey, requestedOwner, res)) return;
          ownerId = requestedOwner;
        }
        const ownerUser = ownerId ? db.getUser(ownerId) : null;
        const walletAddress = body.walletAddress || ownerUser?.deposit_address || "";

        const invoiceNumber = `INV-${Date.now().toString(36).toUpperCase()}`;
        const invItems = items.length ? items : [{ description: memo || "Invoice item", amount: parsedAmount }];
        const rowId = invoiceDb.createInvoice(ownerId, {
          invoiceNumber,
          clientName,
          clientEmail: body.clientEmail || null,
          items: invItems,
          totalUsdc: parsedAmount,
          dueDate: body.dueDate || null,
          notes: memo,
          walletAddress,
        });
        const invoice = invoiceDb.getInvoiceByNumber(invoiceNumber) || invoiceDb.getInvoice(rowId);
        const invNum = invoice?.invoice_number || invoiceNumber;

        return sendJson(res, 201, {
          success: true,
          invoice,
          paymentAddress: invoice?.payment_address || invoice?.wallet_address || walletAddress || null,
          statusUrl: `${baseUrl}/api/v1/invoices/${encodeURIComponent(invNum)}`,
        });
      }

      const invMatch = pathname.match(/^\/api\/v1\/invoices\/([^/]+)$/);
      if (method === "GET" && invMatch) {
        const num = decodeURIComponent(invMatch[1]);
        const inv = invoiceDb.getInvoiceByNumber(num) || (!isNaN(Number(num)) ? invoiceDb.getInvoice(Number(num)) : null);
        if (!inv) return sendJson(res, 404, { success: false, error: "Invoice not found" });

        const invOwner = inv.telegram_id ?? inv.owner_telegram_id;
        if (invOwner && !assertWalletAccess(apiKey, invOwner, res)) return;

        return sendJson(res, 200, { success: true, invoice: inv });
      }

      if (method === "GET" && pathname === "/api/v1/invoices") {
        const ownerIds = new Set();
        if (apiKey.telegram_id) ownerIds.add(Number(apiKey.telegram_id));
        for (const wid of db.getApiKeyWallets(apiKey.key_id)) ownerIds.add(Number(wid));

        const seen = new Set();
        const invs = [];
        for (const oid of ownerIds) {
          for (const row of invoiceDb.getUserInvoices(oid, 50)) {
            if (!seen.has(row.id)) {
              seen.add(row.id);
              invs.push(row);
            }
          }
        }
        invs.sort((a, b) => (b.id || 0) - (a.id || 0));
        return sendJson(res, 200, { success: true, invoices: invs.slice(0, 50) });
      }
    }

    // ── 7. Fiat Onramp & Offramp ─────────────────────────────────────────────
    if (pathname.startsWith("/api/v1/onramp")) {
      if (method === "POST" && pathname === "/api/v1/onramp/bank-transfer") {
        const body = await parseBody(req);
        const { amountNgn, recipientAddress, userId } = body;
        const parsedNgn = Number(amountNgn);
        if (!Number.isFinite(parsedNgn) || parsedNgn <= 0 || !recipientAddress) {
          return sendJson(res, 400, { success: false, error: "positive amountNgn and recipientAddress are required" });
        }
        if (userId && !assertWalletAccess(apiKey, Number(userId), res)) return;

        const order = await paj.createOnrampOrder({
          fiatAmount: parsedNgn,
          currency: "NGN",
          recipient: recipientAddress,
          chain: body.chain || undefined,
          mint: body.mint || undefined,
          userExternalId: userId ? String(userId) : (apiKey.telegram_id ? String(apiKey.telegram_id) : undefined),
        });

        return sendJson(res, 200, {
          success: true,
          orderId: order.id || order.reference || null,
          status: order.status || "pending",
          estimatedUsdc: order.amount || null,
          rate: order.rate || null,
          virtualAccount: {
            bankName: order.bank || order.bankName || order.paymentDetails?.bankName || null,
            accountNumber: order.accountNumber || order.paymentDetails?.accountNumber || null,
            accountName: order.accountName || order.paymentDetails?.accountName || null,
            amountNgn: Number(order.fiatAmount || parsedNgn),
            expiresAt: order.expiresAt || null,
          },
        });
      }

      const onrampStatusMatch = pathname.match(/^\/api\/v1\/onramp\/status\/([^/]+)$/);
      if (method === "GET" && onrampStatusMatch) {
        const orderId = decodeURIComponent(onrampStatusMatch[1]);
        const status = await paj.getOnrampOrder(orderId);
        if (!status) {
          return sendJson(res, 404, { success: false, error: "Onramp order not found" });
        }
        return sendJson(res, 200, { success: true, order: status });
      }
    }

    if (pathname.startsWith("/api/v1/offramp")) {
      if (method === "GET" && pathname === "/api/v1/offramp/rates") {
        let onRampRate = null;
        let offRampRate = null;
        let ngnPerUsdc = null;
        try {
          const pajRates = await paj.getRates("NGN");
          onRampRate = pajRates?.onRampRate?.rate || pajRates?.onRampRate?.rawRate || null;
          offRampRate = pajRates?.offRampRate?.rate || null;
          ngnPerUsdc = offRampRate || onRampRate;
        } catch (_) {}

        if (!ngnPerUsdc) {
          ngnPerUsdc = await fx.getUsdToNgnRate();
          offRampRate = ngnPerUsdc;
        }

        return sendJson(res, 200, {
          success: true,
          ngnPerUsdc: Number(ngnPerUsdc),
          onRampRate: onRampRate ? Number(onRampRate) : null,
          offRampRate: offRampRate ? Number(offRampRate) : Number(ngnPerUsdc),
          updatedAt: new Date().toISOString(),
        });
      }

      const offrampStatusMatch = pathname.match(/^\/api\/v1\/offramp\/status\/([^/]+)$/);
      if (method === "GET" && offrampStatusMatch) {
        const orderId = decodeURIComponent(offrampStatusMatch[1]);
        const order = await paj.getOfframpOrder(orderId);
        if (!order) {
          return sendJson(res, 404, { success: false, error: "Offramp order not found" });
        }
        return sendJson(res, 200, { success: true, order });
      }

      if (method === "POST" && pathname === "/api/v1/offramp/bank-transfer") {
        const body = await parseBody(req);
        const { userId, pin, amountUsdc, bankCode, accountNumber, accountName, narration, senderName } = body;
        const parsedUsdc = Number(amountUsdc);
        if (!Number.isFinite(parsedUsdc) || parsedUsdc <= 0 || !bankCode || !accountNumber) {
          return sendJson(res, 400, { success: false, error: "positive amountUsdc, bankCode, and accountNumber are required" });
        }

        let user = null;
        if (userId) {
          user = db.getUser(Number(userId));
          if (!user) return sendJson(res, 404, { success: false, error: "User wallet not found" });
          if (!assertWalletAccess(apiKey, user.telegram_id, res)) return;
        }

        const effectiveSenderName = senderName || body.sender_name || (user ? db.resolveSenderName(user.telegram_id, "personal") : undefined);
        const effectiveNarration = narration || body.description || undefined;

        const order = await paj.createOfframpPayout({
          amountUsdc: parsedUsdc,
          bankCode,
          accountNumber,
          accountName,
          narration: effectiveNarration,
          senderName: effectiveSenderName,
        });

        const fundingAddress = order.address || null;
        const fundingAmount = Number(order.amount || parsedUsdc);

        // Mode A: Custodial execution — actually debit user's wallet and fund Paj's one-time deposit address
        if (user) {
          if (!fundingAddress) {
            return sendJson(res, 502, { success: false, error: "Paj did not return a funding address for this offramp order" });
          }

          const privateKey = resolvePrivateKey(user, pin);
          let txHash = null;
          let rail = "arc";

          if (multichain.isSolanaAddress(fundingAddress)) {
            rail = "solana";
            const solData = multichain.deriveSolanaFromEvmKey(privateKey);
            const solTx = await multichain.sendSolanaTransfer({
              keypair: solData.keypair,
              recipientAddress: fundingAddress,
              amount: fundingAmount,
            });
            txHash = solTx?.txHash || solTx?.signature || null;
          } else if (walletLib.isValidAddress(fundingAddress)) {
            rail = "arc";
            const signer = walletLib.walletFromPrivateKey(privateKey);
            const amountMicro = walletLib.parseToMicro(fundingAmount.toFixed(6));
            const evmTx = await walletLib.sendSponsoredOrDirectTransaction(signer, fundingAddress, amountMicro);
            txHash = evmTx?.txHash || null;
          } else {
            return sendJson(res, 502, { success: false, error: `Unsupported Paj funding address format: ${fundingAddress}` });
          }

          const orderId = order.id || order.reference || txHash;
          db.recordOfframpOrder({
            orderId,
            telegramId: user.telegram_id,
            accountType: "personal",
            accountNumber: String(accountNumber),
            bankCode: String(bankCode),
            bankName: order.bankName || order.bank?.name || null,
            accountName: order.accountName || accountName || null,
            amountUsdc: fundingAmount,
            fiatAmount: order.fiatAmount || null,
            rate: order.rate || null,
            rail,
            txHash,
            narration: effectiveNarration || null,
            senderName: effectiveSenderName || null,
            status: "submitted",
          });
          db.recordTransaction(
            user.telegram_id,
            "offramp",
            String(walletLib.parseToMicro(fundingAmount.toFixed(6))),
            "submitted",
            txHash || orderId,
            "personal",
            18,
            rail,
            narration || null
          );

          return sendJson(res, 200, {
            success: true,
            mode: "executed",
            orderId,
            txHash,
            rail,
            payout: order,
          });
        }

        // Mode B: Self-funded quote/order — clearly instruct caller to send USDC to fundingAddress
        return sendJson(res, 200, {
          success: true,
          mode: "awaiting_funding",
          orderId: order.id || order.reference || null,
          fundingAddress,
          fundingChain: order.chain || (multichain.isSolanaAddress(fundingAddress) ? "SOLANA" : "ARC"),
          fundingAmountUsdc: fundingAmount,
          estimatedNgn: order.fiatAmount || null,
          rate: order.rate || null,
          instructions: fundingAddress
            ? `Send exactly ${fundingAmount} USDC to ${fundingAddress} to complete the Naira bank payout.`
            : null,
          payout: order,
        });
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
        const { originSymbol = "STRK", amount, recipientAddress, refundTo, telegramId = 0, userId = 0 } = body;
        if (!amount || !recipientAddress) {
          return sendJson(res, 400, { success: false, error: "amount and recipientAddress are required" });
        }
        const targetOwner = Number(userId || telegramId || 0);
        if (targetOwner > 0 && !assertWalletAccess(apiKey, targetOwner, res)) return;

        const token = await nearLib.resolveStarknetToken(originSymbol);
        if (!token) return sendJson(res, 400, { success: false, error: `Starknet token '${originSymbol}' not recognized` });

        const row = await nearLib.createStarknetDeposit({
          telegramId: targetOwner || apiKey.telegram_id || 0,
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
        const { originSymbol = "USDG", amount, recipientAddress, refundTo, telegramId = 0, userId = 0 } = body;
        if (!amount || !recipientAddress) {
          return sendJson(res, 400, { success: false, error: "amount and recipientAddress are required" });
        }
        const targetOwner = Number(userId || telegramId || 0);
        if (targetOwner > 0 && !assertWalletAccess(apiKey, targetOwner, res)) return;

        const token = await nearLib.resolveRobinhoodToken(originSymbol);
        if (!token) return sendJson(res, 400, { success: false, error: `Robinhood token '${originSymbol}' not recognized` });

        const row = await nearLib.createRobinhoodDeposit({
          telegramId: targetOwner || apiKey.telegram_id || 0,
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
        const { originSymbol = "USDC", amount, recipientAddress, refundTo, telegramId = 0, userId = 0 } = body;
        if (!amount || !recipientAddress || !refundTo) {
          return sendJson(res, 400, { success: false, error: "amount, recipientAddress, and refundTo are required" });
        }
        const targetOwner = Number(userId || telegramId || 0);
        if (targetOwner > 0 && !assertWalletAccess(apiKey, targetOwner, res)) return;

        const token = await nearLib.resolveNearToken(originSymbol);
        if (!token) return sendJson(res, 400, { success: false, error: `NEAR token '${originSymbol}' not recognized` });

        const row = await nearLib.createNearDeposit({
          telegramId: targetOwner || apiKey.telegram_id || 0,
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
        const { originSymbol = "SOL", amount, recipientAddress, refundTo, telegramId = 0, userId = 0 } = body;
        if (!amount || !recipientAddress || !refundTo) {
          return sendJson(res, 400, { success: false, error: "amount, recipientAddress, and refundTo are required" });
        }
        const targetOwner = Number(userId || telegramId || 0);
        if (targetOwner > 0 && !assertWalletAccess(apiKey, targetOwner, res)) return;

        const token = await nearLib.resolveSolanaToken(originSymbol);
        if (!token) return sendJson(res, 400, { success: false, error: `Solana token '${originSymbol}' not recognized` });

        const row = await nearLib.createSolanaDeposit({
          telegramId: targetOwner || apiKey.telegram_id || 0,
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
        if (dep.telegram_id && !assertWalletAccess(apiKey, dep.telegram_id, res)) return;

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

    // ── 9. Savings & Yield (/api/v1/savings) — Real Circle EarnKit / ERC-4626 ─
    if (pathname.startsWith("/api/v1/savings")) {
      // GET /api/v1/savings/rates — Live EarnKit vaults on Arc
      if (method === "GET" && pathname === "/api/v1/savings/rates") {
        const pools = await savings.getYieldPools();
        const top = pools.find((p) => p.symbol === "USDC") || pools[0] || null;

        return sendJson(res, 200, {
          success: true,
          apy: top ? Number((top.userApy / 100).toFixed(6)) : 0,
          apyPercent: top ? top.userApy : 0,
          rawApyPercent: top ? top.rawApy : 0,
          vault: top ? top.project : null,
          vaultAddress: top ? top.vaultAddress : null,
          chain: top ? top.chain : "Arc",
          feeFraction: savings.PAYIT_FEE_FRACTION,
          vaults: pools,
        });
      }

      // GET /api/v1/savings/position/:userId — Active savings position & live accrued yield
      const posMatch = pathname.match(/^\/api\/v1\/savings\/position\/([^/]+)$/);
      if (method === "GET" && posMatch) {
        const id = decodeURIComponent(posMatch[1]);
        const user = !isNaN(Number(id)) ? db.getUser(Number(id)) : db.findUserByUsername(id);
        if (!user) return sendJson(res, 404, { success: false, error: "User wallet not found" });
        if (!assertWalletAccess(apiKey, user.telegram_id, res)) return;

        const accountType = (parsedUrl.query && parsedUrl.query.accountType) || "personal";
        const pos = db.getOpenYieldPosition(user.telegram_id, accountType);
        if (!pos) {
          return sendJson(res, 200, { success: true, active: false, position: null });
        }

        const grossYield = savings.calcAccruedYield(pos);
        const devFee = grossYield * savings.PAYIT_FEE_FRACTION;
        const netYield = grossYield - devFee;
        return sendJson(res, 200, {
          success: true,
          active: true,
          position: {
            ...pos,
            accruedGrossUsdc: Number(grossYield.toFixed(6)),
            accruedNetUsdc: Number(netYield.toFixed(6)),
            currentTotalUsdc: Number((Number(pos.amount_usdc || 0) + netYield).toFixed(6)),
          },
        });
      }

      // POST /api/v1/savings/deposit — Real on-chain ERC-4626 / EarnKit deposit
      if (method === "POST" && pathname === "/api/v1/savings/deposit") {
        const body = await parseBody(req);
        const { userId, amountUsdc, vaultAddress, pin, accountType = "personal" } = body;
        const parsedAmount = Number(amountUsdc);
        if (!userId || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
          return sendJson(res, 400, { success: false, error: "userId and positive amountUsdc are required" });
        }

        const user = db.getUser(Number(userId));
        if (!user) return sendJson(res, 404, { success: false, error: "User wallet not found" });
        if (!assertWalletAccess(apiKey, user.telegram_id, res)) return;

        const pools = await savings.getYieldPools();
        let pool = null;
        if (vaultAddress) {
          if (!walletLib.isValidAddress(vaultAddress)) {
            return sendJson(res, 400, { success: false, error: "Invalid vaultAddress" });
          }
          pool = pools.find((p) => p.vaultAddress && p.vaultAddress.toLowerCase() === vaultAddress.toLowerCase()) || {
            symbol: "USDC",
            project: "Custom Arc ERC-4626 Vault",
            chain: "Arc",
            vaultAddress,
            rawApy: 0,
            userApy: 0,
            payitApy: 0,
          };
        } else {
          pool = pools.find((p) => p.symbol === "USDC") || pools[0];
        }

        if (!pool || !pool.vaultAddress) {
          return sendJson(res, 503, { success: false, error: "No active savings vaults available" });
        }

        const privateKey = resolvePrivateKey(user, pin);
        const depositRes = await savings.depositIntoVault(privateKey, pool.vaultAddress, parsedAmount);
        if (!depositRes || !depositRes.success) {
          return sendJson(res, 502, {
            success: false,
            error: depositRes?.error || "On-chain vault deposit failed",
          });
        }

        savings.openYieldPosition(user.telegram_id, parsedAmount, pool, {
          vaultAddress: pool.vaultAddress,
          depositTxHash: depositRes.txHash || depositRes.hash || null,
          accountType,
        });
        const position = db.getOpenYieldPosition(user.telegram_id, accountType);

        return sendJson(res, 200, {
          success: true,
          txHash: depositRes.txHash || depositRes.hash || null,
          vault: pool,
          position,
        });
      }

      // POST /api/v1/savings/withdraw — Real on-chain ERC-4626 / EarnKit redemption
      if (method === "POST" && pathname === "/api/v1/savings/withdraw") {
        const body = await parseBody(req);
        const { userId, pin, accountType = "personal" } = body;
        if (!userId) return sendJson(res, 400, { success: false, error: "userId is required" });

        const user = db.getUser(Number(userId));
        if (!user) return sendJson(res, 404, { success: false, error: "User wallet not found" });
        if (!assertWalletAccess(apiKey, user.telegram_id, res)) return;

        const open = db.getOpenYieldPosition(user.telegram_id, accountType);
        if (!open) return sendJson(res, 404, { success: false, error: "No active savings position found" });

        const privateKey = resolvePrivateKey(user, pin);
        const userWallet = walletLib.walletFromPrivateKey(privateKey);
        userWallet.telegramId = user.telegram_id;

        const result = await savings.withdrawFromVaultWithFee({
          userWallet,
          position: open,
        });

        return sendJson(res, 200, {
          success: true,
          withdrawnAmount: result.totalUserPayout,
          principalUsdc: result.principalUsdc,
          grossYieldUsdc: result.grossYieldUsdc,
          netYieldUsdc: result.netYieldUsdc,
          devFeeUsdc: result.devFeeUsdc,
          withdrawTxHash: result.withdrawTxHash,
          feeTxHash: result.feeTxHash,
        });
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
        if (!assertWalletAccess(apiKey, user.telegram_id, res)) return;

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
        if (!userId) return sendJson(res, 400, { success: false, error: "userId is required" });

        const user = db.getUser(Number(userId));
        if (!user) return sendJson(res, 404, { success: false, error: "User not found" });
        if (!assertWalletAccess(apiKey, user.telegram_id, res)) return;

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
        const parsedAmount = Number(amountUsdc);
        if (!userId || !destinationChain || !destinationAddress || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
          return sendJson(res, 400, { success: false, error: "userId, destinationChain, destinationAddress, and positive amountUsdc are required" });
        }

        const user = db.getUser(Number(userId));
        if (!user) return sendJson(res, 404, { success: false, error: "User not found" });
        if (!assertWalletAccess(apiKey, user.telegram_id, res)) return;

        const privateKey = resolvePrivateKey(user, pin);
        const userWallet = walletLib.walletFromPrivateKey(privateKey);

        const result = await cctpBridge.executeArcCrossChainWithdrawal({
          userWallet,
          destinationChain,
          destinationAddress,
          amountUsdc: parsedAmount,
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
        if (tx.telegram_id && !assertWalletAccess(apiKey, tx.telegram_id, res)) return;

        const decimals = tx.decimals !== undefined && tx.decimals !== null ? Number(tx.decimals) : 6;
        const amountUsdc = tx.amount_micro ? Number(tx.amount_micro) / Math.pow(10, decimals) : null;
        const txUser = tx.telegram_id ? db.getUser(tx.telegram_id) : null;
        const ownerName = txUser
          ? (txUser.username ? `@${txUser.username}` : `Account #${txUser.telegram_id}`)
          : "Proxim Account";
        const ownerAddress = txUser
          ? (tx.account_type === "business" ? (txUser.business_deposit_address || txUser.deposit_address) : txUser.deposit_address)
          : null;

        // Check if this transaction touches Naira (onramp/offramp) for real participant + Naira-only display
        const offrampOrder = tx.type === "offramp" ? db.getOfframpOrderByOrderId(tx.tx_hash) : null;
        const onrampOrder = tx.type === "deposit_naira" ? db.getOnrampOrderByOrderId(tx.tx_hash) : null;
        const nairaFiatAmount = offrampOrder?.fiat_amount || onrampOrder?.fiat_amount || null;
        const isNairaTx = Boolean(nairaFiatAmount && Number(nairaFiatAmount) > 0);

        // If client requested PNG image format, render and return binary PNG
        if (parsedUrl.query && (parsedUrl.query.format === "png" || parsedUrl.query.download === "true")) {
          try {
            const receiptParams = {
              receiptId: (tx.tx_hash || String(tx.id)).slice(0, 12),
              senderName: tx.type === "deposit_naira" ? "Bank Transfer (NGN)" : ownerName,
              senderAddress: tx.type === "deposit_naira" ? null : ownerAddress,
              recipientName: offrampOrder
                ? (offrampOrder.account_name || offrampOrder.bank_name || "Bank Account")
                : (tx.type === "deposit_naira" ? ownerName : "Recipient"),
              recipientAddress: offrampOrder
                ? `${offrampOrder.bank_name || "Bank"} • ${offrampOrder.account_number || ""}`.trim()
                : (tx.type === "deposit_naira" ? ownerAddress : null),
              amountUsdc: amountUsdc || 0,
              token: "USDC",
              displayCurrency: isNairaTx ? "NGN" : "USDC",
              fiatAmountDisplay: isNairaTx ? `₦${Math.round(Number(nairaFiatAmount)).toLocaleString("en-NG")}` : null,
              type: tx.type || "Payment",
              timestamp: tx.created_at || new Date().toISOString(),
              status: tx.status === "completed" || tx.status === "confirmed" ? "Confirmed" : (tx.status || "Pending"),
              txHash: tx.tx_hash,
              narration: tx.narration || null,
            };

            const pngPath = await generateReceiptPNG(receiptParams);
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
            fiatAmountNgn: nairaFiatAmount ? Number(nairaFiatAmount) : null,
            status: tx.status,
            type: tx.type,
            chain: tx.chain || "arc",
            narration: tx.narration || null,
            createdAt: tx.created_at,
            pngUrl: `${baseUrl}/api/v1/receipts/${encodeURIComponent(tx.tx_hash)}?format=png`,
          },
        });
      }
    }

    // Fallthrough: 404 for unknown endpoint
    return sendJson(res, 404, {
      success: false,
      error: `Endpoint '${method} ${pathname}' not found. Review GET /api/v1/docs for available routes.`,
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
  getPublicBaseUrl,
  sendJson,
  parseBody,
  extractApiKey,
};
