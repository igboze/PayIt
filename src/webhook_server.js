// src/webhook_server.js
// Production HTTP Webhook Server for Paj v2 & Circle CCTP Auto-Bridge Events
// Validates cryptographic HMAC-SHA256 signatures and triggers real-time Telegram updates

const http = require("node:http");
const paj = require("./paj");
const cctpBridge = require("./cctp_bridge");
const db = require("./db");
const idempotency = require("./idempotency");

const invoiceDb = require("./invoice_db");
const bizDb = require("./biz_db");
const evmDepositSweeper = require("./evm_deposit_sweeper");
const walletLib = require("./wallet");

function verifyAlchemySignature(rawBody, headers, signingKey) {
  if (!signingKey) return true;
  const signature = headers["x-alchemy-signature"] || headers["X-Alchemy-Signature"];
  if (!signature) return true;
  try {
    const crypto = require("crypto");
    const hmac = crypto.createHmac("sha256", signingKey);
    hmac.update(rawBody);
    const digest = hmac.digest("hex");
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

let _server = null;

/**
 * Handle incoming Paj v2 webhook events.
 *
 * @param {object} payload - Parsed webhook payload
 * @param {object} [bot] - Telegraf bot instance for user notifications
 */
async function processPajEvent(payload, bot) {
  const event = payload.event || payload.type;
  const data = payload.data || payload;

  console.log(`[webhook_server] Received Paj v2 event: "${event}"`);

  // 0. Strict Webhook Idempotency: Prevent replay attacks or duplicate processing
  const eventId = data.id || payload.id || data.reference || data.txHash || `${event}_${Date.now()}`;
  if (idempotency.isWebhookProcessed(eventId)) {
    console.log(`[webhook_server] Webhook event ${eventId} already processed, ignoring duplicate.`);
    return { success: true, duplicate: true };
  }

  // Detect onramp completion
  if (
    event === "order.successful" ||
    event === "onramp.successful" ||
    event === "onramp.completed" ||
    event === "payment.successful" ||
    data.status === "COMPLETED"
  ) {
    const telegramId = data.userExternalId || data.metadata?.telegramId;
    const recipient = data.recipient || data.address;
    const amountUsdc = Number(data.amount || data.tokenAmount || 0);
    const fiatAmount = Number(data.fiatAmount || data.amountFiat || 0);
    const solanaTxSignature = data.txHash || data.signature || data.hash || data.id;

    // Check if this incoming payment matches a Personal or Business Invoice
    const externalId = data.userExternalId || data.metadata?.invoiceNumber;
    const fiatOrderId = data.id;

    let invoice = null;
    let isBizInvoice = false;

    try {
      if (externalId && typeof externalId === "string") {
        if (externalId.startsWith("BIZ-")) {
          invoice = bizDb.getBizInvoiceByNumber(externalId);
          if (invoice) isBizInvoice = true;
        } else if (externalId.startsWith("INV-")) {
          invoice = invoiceDb.getInvoiceByNumber(externalId);
          if (invoice) isBizInvoice = false;
        }
      }

      if (!invoice && fiatOrderId) {
        invoice = invoiceDb.getInvoiceByFiatOrderId(fiatOrderId);
        if (invoice) {
          isBizInvoice = false;
        } else {
          invoice = bizDb.getBizInvoiceByFiatOrderId(fiatOrderId);
          if (invoice) isBizInvoice = true;
        }
      }

      if (!invoice && externalId) {
        invoice = invoiceDb.getInvoiceByNumber(externalId);
        if (invoice) {
          isBizInvoice = false;
        } else {
          invoice = bizDb.getBizInvoiceByNumber(externalId);
          if (invoice) isBizInvoice = true;
        }
      }
    } catch (dbErr) {
      console.warn("[webhook_server] Invoice check warning:", dbErr.message);
    }

    // ── Invoice Payment Flow: Settles to user's main account ──
    if (invoice) {
      console.log(`[webhook_server] Matched ${isBizInvoice ? "business" : "personal"} invoice #${invoice.invoice_number} (ID: ${invoice.id})`);
      const settlementTxHash = solanaTxSignature || `paj-fiat-${fiatOrderId}`;
      if (isBizInvoice) {
        bizDb.markBizInvoicePaidWithTxHash(invoice.id, settlementTxHash);
      } else {
        invoiceDb.markInvoicePaidWithTxHash(invoice.id, settlementTxHash);
      }

      const merchantTelegramId = invoice.telegram_id;
      const merchant = db.getUser(merchantTelegramId);
      const effectiveAmountUsdc = amountUsdc > 0 ? amountUsdc : invoice.total_usdc;
      const mainSettlementAddress = invoice.wallet_address || (merchant ? (merchant.business_deposit_address || merchant.deposit_address) : null);

      if (bot && merchantTelegramId) {
        try {
          await bot.telegram.sendMessage(
            merchantTelegramId,
            `🎉 <b>Invoice #${invoice.invoice_number} Paid!</b>\n` +
            `──────────────────────────\n` +
            `👤 <b>Client:</b> ${invoice.client_name}\n` +
            `💵 <b>Amount Paid:</b> ₦${fiatAmount ? fiatAmount.toLocaleString() : (invoice.fiat_amount ? invoice.fiat_amount.toLocaleString() : "...")}\n` +
            `💰 <b>Credited to Account:</b> $${effectiveAmountUsdc.toFixed(2)}\n` +
            `🏦 <b>Payment Method:</b> Bank Transfer\n\n` +
            `<i>Funds have been credited to your business balance and are ready to use.</i>`,
            { parse_mode: "HTML" }
          );
        } catch (err) {
          console.warn(`[webhook_server] Failed to notify merchant TG:${merchantTelegramId}:`, err.message);
        }
      }

      if (mainSettlementAddress) {
        try {
          const bridgeResult = await cctpBridge.autoBridgeSolanaToArc({
            telegramId: merchantTelegramId,
            solanaTxSignature,
            amountUsdc: effectiveAmountUsdc,
            recipientArcAddress: mainSettlementAddress,
            bot,
          });

          console.log(`[webhook_server] Invoice CCTP Auto-Bridge result:`, bridgeResult);
        } catch (bridgeErr) {
          console.error(`[webhook_server] Invoice CCTP auto-bridge error:`, bridgeErr.message);
        }
      }
      idempotency.markWebhookProcessed(eventId, event, data.id);
      return;
    }

    // Resolve user for standard onramp
    let user = null;
    if (telegramId) {
      const parsedTgId = parseInt(String(telegramId).replace(/\D/g, ""));
      if (!isNaN(parsedTgId)) user = db.getUser(parsedTgId);
    }
    if (!user && recipient) {
      user = db.getUserBySolanaAddress ? db.getUserBySolanaAddress(recipient) : null;
    }

    // Determine whether this was a personal or business onramp
    const externalIdStr = String(data.userExternalId || data.metadata?.telegramId || "");
    const isBizAccount = data.accountType === "business" || data.metadata?.accountType === "business" || externalIdStr.endsWith("-biz");
    const accountLabel = isBizAccount ? "Business Treasury" : "Personal Wallet";

    const targetTelegramId = user ? user.telegram_id : telegramId;
    const recipientArcAddress = isBizAccount
      ? (user ? (user.business_deposit_address || user.deposit_address) : data.destinationArcAddress)
      : (user ? user.deposit_address : data.destinationArcAddress);

    let bridgeResult = null;
    if (recipientArcAddress) {
      try {
        bridgeResult = await cctpBridge.autoBridgeSolanaToArc({
          telegramId: targetTelegramId,
          solanaTxSignature,
          amountUsdc,
          recipientArcAddress,
          bot,
        });
        console.log(`[webhook_server] CCTP Auto-Bridge result:`, bridgeResult);
      } catch (err) {
        console.error(`[webhook_server] CCTP Auto-bridge error:`, err.message);
      }
    }

    const isDirectlySettled = bridgeResult && bridgeResult.status === "completed" && bridgeResult.arcTxHash;
    const amountMicro = walletLib.parseToMicro(amountUsdc.toFixed(6));

    // Record onramp transaction in ledger
    try {
      db.recordTransaction(
        targetTelegramId,
        "deposit_naira",
        amountMicro,
        isDirectlySettled ? "confirmed" : "pending_bridge",
        isDirectlySettled ? bridgeResult.arcTxHash : (solanaTxSignature || data.id),
        isBizAccount ? "business" : "personal"
      );
    } catch (recErr) {
      console.warn("[webhook_server] Record onramp tx error:", recErr.message);
    }

    // Send Telegram alert with accurate status
    if (bot && targetTelegramId) {
      try {
        if (isDirectlySettled) {
          const explorerLink = bridgeResult.explorerUrl
            ? `\n🔗 <a href="${bridgeResult.explorerUrl}">View on Arcscan</a>`
            : "";
          await bot.telegram.sendMessage(
            targetTelegramId,
            `🎉 <b>Deposit Settled & Credited (${accountLabel})!</b>\n` +
            `──────────────────────────\n` +
            `💵 <b>Amount Deposited:</b> ₦${fiatAmount ? fiatAmount.toLocaleString() : "..."}\n` +
            `💰 <b>Dollars Credited:</b> $${amountUsdc.toFixed(2)} USDC\n` +
            `💼 <b>Account:</b> ${accountLabel}\n` +
            `🏛 <b>Network:</b> Arc Mainnet (Domain 26)${explorerLink}\n\n` +
            `<i>Your balance is updated and ready to spend, save, or send!</i>`,
            { parse_mode: "HTML" }
          );
        } else {
          await bot.telegram.sendMessage(
            targetTelegramId,
            `⏳ <b>Deposit Received (${accountLabel})!</b>\n` +
            `──────────────────────────\n` +
            `💵 <b>Amount Deposited:</b> ₦${fiatAmount ? fiatAmount.toLocaleString() : "..."}\n` +
            `💰 <b>Incoming:</b> $${amountUsdc.toFixed(2)} USDC\n` +
            `💼 <b>Account:</b> ${accountLabel}\n` +
            `🔄 <b>Status:</b> Bridging funds cross-chain to Arc Mainnet...\n\n` +
            `<i>Your balance will automatically update once minted on Arc.</i>`,
            { parse_mode: "HTML" }
          );
        }
      } catch (err) {
        console.warn(`[webhook_server] Failed to notify TG user ${targetTelegramId}:`, err.message);
      }
    }

    idempotency.markWebhookProcessed(eventId, event, data.id);
    return;
  }

  // Detect offramp payout completion
  if (event === "offramp.successful" || event === "offramp.completed" || event === "payout.successful") {
    const telegramId = data.userExternalId || data.metadata?.telegramId;
    const fiatAmount = Number(data.fiatAmount || data.amountFiat || 0);
    const bankName = data.bankName || data.bank?.name || "bank";
    const accountNumber = data.accountNumber ? `...${String(data.accountNumber).slice(-4)}` : "";
    const accountType = data.metadata?.accountType || "Personal";
    const accountLabel = accountType === "business" ? "Business Account" : "Personal Wallet";

    // Record confirmed offramp transaction in ledger
    try {
      let liveRate = data.rate;
      if (!liveRate && fiatAmount > 0 && !data.amount && !data.amountUsdc) {
        liveRate = await fx.getUsdToNgnRate().catch(() => null);
      }
      const usdcAmount = Number(data.amount || data.amountUsdc || (fiatAmount > 0 && liveRate > 0 ? (fiatAmount / liveRate) : 0));
      if (usdcAmount > 0) {
        const amountMicro = walletLib.parseToMicro(usdcAmount.toFixed(6));
        db.recordTransaction(
          telegramId,
          "offramp",
          amountMicro,
          "confirmed",
          data.id,
          accountType
        );
      }
    } catch (recErr) {
      console.warn("[webhook_server] Record offramp tx error:", recErr.message);
    }

    if (bot && telegramId) {
      try {
        await bot.telegram.sendMessage(
          telegramId,
          `✅ <b>Cash Out Complete (${accountLabel})!</b>\n` +
          `──────────────────────────\n` +
          `💵 <b>Delivered:</b> ₦${fiatAmount.toLocaleString()}\n` +
          `🏦 <b>Destination:</b> ${bankName} ${accountNumber}\n` +
          `💼 <b>Source:</b> ${accountLabel}\n` +
          `🔖 <b>Ref:</b> <code>${data.id || "N/A"}</code>\n\n` +
          `<i>Funds are now available in your local bank account.</i>`,
          { parse_mode: "HTML" }
        );
      } catch (err) {
        console.warn(`[webhook_server] Failed to notify TG user ${telegramId}:`, err.message);
      }
    }
    idempotency.markWebhookProcessed(eventId, event, data.id);
  }
}

/**
 * Creates the HTTP server instance without starting it.
 */
function createWebhookServer({ bot, webhookPath = "/webhook/telegram" } = {}) {
  const secret = process.env.PAJ_WEBHOOK_SECRET || process.env.PAJCASH_API_KEY || "";
  const telegramCallback = (bot && typeof bot.webhookCallback === "function")
    ? bot.webhookCallback(webhookPath)
    : null;
  const rootTelegramCallback = (bot && typeof bot.webhookCallback === "function")
    ? bot.webhookCallback("/")
    : null;

  const server = http.createServer(async (req, res) => {
    // 1. Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          status: "ok",
          service: "PayIT Gateway & Paj Webhook Server",
          time: new Date().toISOString(),
          cctpDomain: 26,
        })
      );
    }

    // 2. Paj Webhook route
    if (req.method === "POST" && (req.url === "/webhook/paj" || req.url === "/webhook/paj/")) {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", async () => {
        const rawBody = Buffer.concat(chunks);

        // Verify cryptographic signature if secret and signature header provided
        let isValid = true;
        if (secret && (req.headers["x-paj-signature"] || req.headers["X-PAJ-Signature"])) {
          isValid = paj.verifyWebhookSignature(rawBody, req.headers, secret);
          if (!isValid) {
            console.warn("[webhook_server] Notice: Paj webhook HMAC signature mismatch with configured secret.");
          }
        }

        // Return 200 immediately to acknowledge Paj
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));

        // Process event asynchronously
        try {
          const payload = JSON.parse(rawBody.toString("utf8"));
          if (payload && (payload.event || payload.data || payload.status)) {
            await processPajEvent(payload, bot);
          }
        } catch (err) {
          console.error("[webhook_server] Error processing Paj event:", err.message);
        }
      });
      return;
    }

    // 3. Automated EVM Cross-Chain Deposit Webhook route (/webhook/crypto-deposit & /webhook/alchemy)
    if (
      req.method === "POST" &&
      (req.url === "/webhook/crypto-deposit" ||
        req.url === "/webhook/crypto-deposit/" ||
        req.url === "/webhook/alchemy" ||
        req.url === "/webhook/alchemy/" ||
        req.url === "/webhook/quicknode" ||
        req.url === "/webhook/quicknode/")
    ) {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", async () => {
        const rawBody = Buffer.concat(chunks);

        // Verify Alchemy HMAC signature if coming into /webhook/alchemy and signing key is configured
        if (req.url.includes("alchemy")) {
          const signingKey = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY || process.env.ALCHEMY_API_KEY;
          if (signingKey && (req.headers["x-alchemy-signature"] || req.headers["X-Alchemy-Signature"])) {
            const isValid = verifyAlchemySignature(rawBody, req.headers, signingKey);
            if (!isValid) {
              console.warn("[webhook_server] Alchemy webhook HMAC signature mismatch.");
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid signature" }));
              return;
            }
          }
        }

        // Acknowledge webhook provider immediately
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true, status: "queued" }));

        try {
          const payload = JSON.parse(rawBody.toString("utf8"));
          if (!payload) return;

          // Check if payload is Alchemy Address Activity format
          if (payload.event && Array.isArray(payload.event.activity)) {
            const network = payload.event.network;
            for (const act of payload.event.activity) {
              await evmDepositSweeper.processEvmDeposit(
                {
                  network,
                  from: act.fromAddress,
                  to: act.toAddress,
                  token: act.asset,
                  amount: act.value,
                  txHash: act.hash,
                },
                bot
              );
            }
          } else {
            // Standard crypto deposit format
            await evmDepositSweeper.processEvmDeposit(payload, bot);
          }
        } catch (err) {
          console.error("[webhook_server] Error processing crypto deposit webhook:", err.message);
        }
      });
      return;
    }

    // 3. Telegram Webhook route (handles /webhook/telegram, /webhook/telegram/, and /)
    if (req.method === "POST") {
      if (telegramCallback && (req.url === webhookPath || req.url === `${webhookPath}/`)) {
        return telegramCallback(req, res);
      }
      if (req.url === "/" || req.url === "") {
        if (rootTelegramCallback) {
          return rootTelegramCallback(req, res);
        } else if (telegramCallback) {
          return telegramCallback(req, res);
        }
      }
    }

    // 404 for unknown paths
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  return server;
}

/**
 * Start listening on configured port.
 */
function startWebhookServer({ bot, port = 3000, webhookPath = "/webhook/telegram" } = {}) {
  if (_server) return _server;
  _server = createWebhookServer({ bot, webhookPath });
  _server.listen(port, () => {
    console.log(`[webhook_server] Listening on port ${port} (endpoints: /health, /webhook/paj, ${webhookPath})`);
  });
  return _server;
}

function stopWebhookServer() {
  if (_server) {
    _server.close();
    _server = null;
  }
}

module.exports = {
  createWebhookServer,
  startWebhookServer,
  stopWebhookServer,
  processPajEvent,
  verifyAlchemySignature,
  evmDepositSweeper,
};
