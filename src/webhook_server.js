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
const solAddrLib = require("./solana_address");
const { generateReceiptPNG } = require("./receipt_generator");
const apiRoutes = require("./api_routes");

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
 * Send rich on-ramp deposit notification to Telegram user with optional receipt PNG.
 */
async function sendOnrampDepositNotification({
  bot,
  telegramId,
  fiatAmount,
  amountUsdc,
  feeUsdc = 0,
  accountType = "personal",
  txHash = null,
  orderId = null,
  rate = null,
  network = "Arc Mainnet",
}) {
  if (!bot || !telegramId) return;

  const isBiz = accountType === "business";
  const accountLabel = isBiz ? "Business Treasury" : "Personal Wallet";
  const user = db.getUser(telegramId);
  const userAddress = isBiz
    ? (user ? (user.business_deposit_address || user.deposit_address) : null)
    : (user ? user.deposit_address : null);

  let currentBalanceStr = "...";
  if (userAddress) {
    try {
      const bal = await walletLib.getArcBalance(userAddress);
      if (bal != null && !isNaN(bal)) {
        currentBalanceStr = `$${Number(bal).toFixed(2)} USDC`;
      }
    } catch {}
  }

  const effectiveFiat = Number(fiatAmount || 0);
  const effectiveUsdc = Number(amountUsdc || 0);
  const formattedFiat = effectiveFiat > 0 ? `₦${effectiveFiat.toLocaleString()}` : "N/A";
  const formattedUsdc = `${effectiveUsdc.toFixed(2)} USDC`;

  const title = network.includes("Solana")
    ? `🎉 <b>Deposit Settled on Solana!</b>`
    : `🎉 <b>Deposit Received & Settled!</b>`;

  let caption =
    `${title}\n` +
    `──────────────────────────\n` +
    `💵 <b>Amount Deposited:</b> ${formattedFiat}\n`;

  if (feeUsdc && Number(feeUsdc) > 0) {
    caption += `🏷️ <b>Platform Fee (1%):</b> $${Number(feeUsdc).toFixed(2)}\n`;
  }

  caption += `💰 <b>Credited to Account:</b> +$${formattedUsdc}\n`;

  if (rate && Number(rate) > 0) {
    caption += `📈 <b>Exchange Rate:</b> ₦${Number(rate).toLocaleString()}/$\n`;
  }

  caption +=
    `💼 <b>Account:</b> ${accountLabel}\n` +
    `💳 <b>New Balance:</b> ${currentBalanceStr}\n` +
    `🏛 <b>Network:</b> ${network}\n`;

  if (txHash) {
    caption += `🔗 <b>Transaction:</b> <code>${txHash}</code>\n`;
  }
  if (orderId) {
    caption += `🔖 <b>Order Ref:</b> <code>${orderId}</code>\n`;
  }

  caption +=
    `──────────────────────────\n` +
    `<i>Your funds are ready to spend, transfer, or withdraw!</i>`;

  const inlineKeyboard = [
    [
      { text: "💰 View Balance", callback_data: isBiz ? "biz_balance" : "action_balance" },
      { text: "💸 Send / Withdraw", callback_data: isBiz ? "biz_withdraw" : "action_withdraw" },
    ],
    [
      { text: "🏠 Main Menu", callback_data: isBiz ? "biz_menu" : "action_main_menu" },
    ],
  ];

  let receiptPath = null;
  try {
    receiptPath = await generateReceiptPNG({
      receiptId: `DEP-${String(orderId || txHash || Date.now()).slice(0, 10)}`,
      senderName: "Bank Transfer (Naira On-Ramp)",
      recipientName: user ? (isBiz ? (user.business_name || "Business Account") : (user.first_name || "Personal Account")) : "Proxim Account",
      recipientAddress: userAddress || null,
      amountUsdc: effectiveUsdc,
      token: "USDC",
      type: "Deposit",
      timestamp: new Date().toISOString(),
      status: "Confirmed",
      txHash: txHash || orderId || null,
    });
  } catch (recErr) {
    // Best-effort PNG generation
  }

  if (receiptPath && typeof bot.telegram.sendPhoto === "function") {
    try {
      await bot.telegram.sendPhoto(
        telegramId,
        { source: receiptPath },
        {
          caption,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: inlineKeyboard },
        }
      );
      return;
    } catch (photoErr) {
      // Fall through to sendMessage
    }
  }

  if (typeof bot.telegram.sendMessage === "function") {
    await bot.telegram.sendMessage(telegramId, caption, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  }
}

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
  const eventId = data.id || payload.id || data.reference || data.txHash;
  if (!eventId) {
    console.error("[webhook_server] Cannot process event: no stable identifier present", payload);
    return { success: false, error: "missing stable event id" };
  }
  if (idempotency.isWebhookProcessed(eventId)) {
    console.log(`[webhook_server] Webhook event ${eventId} already processed, ignoring duplicate.`);
    return { success: true, duplicate: true };
  }
  idempotency.markWebhookProcessed(eventId, event, data.id);

  // Detect onramp completion
  const statusStr = String(data.status || "").toLowerCase();
  const eventStr = String(event || "").toLowerCase();
  if (
    eventStr === "order.successful" ||
    eventStr === "onramp.successful" ||
    eventStr === "onramp.completed" ||
    eventStr === "payment.successful" ||
    statusStr === "completed" ||
    statusStr === "successful" ||
    statusStr === "paid" ||
    statusStr === "settled"
  ) {
    const telegramId = data.userExternalId || data.metadata?.telegramId;
    const recipient = data.recipient || data.address;
    const amountUsdc = Number(data.amount || data.tokenAmount || 0);
    const fiatAmount = Number(data.fiatAmount || data.amountFiat || 0);
    const solanaTxSignature = data.txHash || data.signature || data.hash || data.id;

    // Check if this incoming payment matches a Personal or Business Invoice
    const externalId = data.userExternalId || data.metadata?.invoiceNumber;
    const fiatOrderId = data.id || data.orderId || payload.id || payload.orderId || null;

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

      const isDirectArcInvoice = recipient && recipient.startsWith("0x");
      if (!isDirectArcInvoice && mainSettlementAddress) {
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

    // Lookup tracked onramp order in DB first (source of truth for order initiated in bot)
    const trackedOrder = fiatOrderId ? db.getOnrampOrderByOrderId(fiatOrderId) : null;

    // Resolve user for standard onramp
    let user = null;
    let targetTelegramId = null;

    if (telegramId) {
      const parsedTgId = parseInt(String(telegramId).replace(/\D/g, ""));
      if (!isNaN(parsedTgId)) user = db.getUser(parsedTgId);
    }
    if (!user && trackedOrder && trackedOrder.telegram_id) {
      user = db.getUser(trackedOrder.telegram_id);
    }
    if (!user && recipient) {
      if (recipient.startsWith("0x") && db.getUserByDepositAddress) {
        user = db.getUserByDepositAddress(recipient);
      }
      if (!user && db.getUserBySolanaAddress) {
        user = db.getUserBySolanaAddress(recipient);
      }
    }

    targetTelegramId = user ? user.telegram_id : (trackedOrder?.telegram_id || (telegramId ? parseInt(String(telegramId).replace(/\D/g, "")) : null));

    // Determine whether this was a personal or business onramp
    const externalIdStr = String(data.userExternalId || data.metadata?.telegramId || trackedOrder?.account_type || "");
    const isBizAccount = data.accountType === "business" || data.metadata?.accountType === "business" || externalIdStr.endsWith("-biz") || trackedOrder?.account_type === "business";
    const accountLabel = isBizAccount ? "Business Treasury" : "Personal Wallet";

    // Safety net: Paj reports the exact address it paid. It must be the address our key controls.
    if (user && recipient) {
      const isArcRecipient = recipient.startsWith("0x");
      if (isArcRecipient) {
        const expectedArc = isBizAccount
          ? (user.business_deposit_address || user.deposit_address)
          : user.deposit_address;
        if (expectedArc && recipient.toLowerCase() !== expectedArc.toLowerCase()) {
          console.error(
            `[webhook_server:ADDRESS_MISMATCH] TG:${user.telegram_id} Paj paid Arc address ${recipient} but user wallet is ${expectedArc} (order ${data.id}, $${amountUsdc})`
          );
          if (solAddrLib && typeof solAddrLib.alertAdmins === "function") {
            await solAddrLib.alertAdmins(
              bot,
              `⚠️ Paj on-ramp paid an Arc address the bot cannot sign for.\nTG: ${user.telegram_id}\nOrder: ${data.id}\nAmount: $${amountUsdc}\nPaid to: ${recipient}\nExpected: ${expectedArc}`
            );
          }
        }
      } else {
        const expectedSol = solAddrLib.getDerivedSolanaAddress(user, { isBiz: isBizAccount });
        if (expectedSol && recipient !== expectedSol) {
          console.error(
            `[webhook_server:ADDRESS_MISMATCH] TG:${user.telegram_id} Paj paid ${recipient} but the bot controls ${expectedSol} (order ${data.id}, $${amountUsdc})`
          );
          if (solAddrLib && typeof solAddrLib.alertAdmins === "function") {
            await solAddrLib.alertAdmins(
              bot,
              `⚠️ Paj on-ramp paid an address the bot cannot sign for.\nTG: ${user.telegram_id}\nOrder: ${data.id}\nAmount: $${amountUsdc}\nPaid to: ${recipient}\nExpected: ${expectedSol}`
            );
          }
        }
      }
    }

    const effectiveFiatAmount = fiatAmount > 0 ? fiatAmount : (trackedOrder?.fiat_amount || 0);
    const effectiveAmountUsdc = amountUsdc > 0 ? amountUsdc : (trackedOrder?.amount_usdc || 0);
    const orderRate = data.rate || trackedOrder?.rate || (effectiveFiatAmount > 0 && effectiveAmountUsdc > 0 ? Math.round(effectiveFiatAmount / effectiveAmountUsdc) : null);

    const recipientArcAddress = isBizAccount
      ? (user ? (user.business_deposit_address || user.deposit_address) : data.destinationArcAddress)
      : (user ? user.deposit_address : data.destinationArcAddress);

    let bridgeResult = null;
    const isDirectArcDeposit = recipient && recipient.startsWith("0x");
    if (!isDirectArcDeposit && recipientArcAddress && process.env.AUTO_BRIDGE_SOLANA_TO_ARC === "true") {
      try {
        bridgeResult = await cctpBridge.autoBridgeSolanaToArc({
          telegramId: targetTelegramId,
          solanaTxSignature,
          amountUsdc: effectiveAmountUsdc,
          recipientArcAddress,
          bot,
        });
        console.log(`[webhook_server] CCTP Auto-Bridge result:`, bridgeResult);
      } catch (err) {
        console.error(`[webhook_server] CCTP Auto-bridge error:`, err.message);
      }
    }

    const isDirectlySettled = isDirectArcDeposit || (bridgeResult && bridgeResult.status === "completed" && bridgeResult.arcTxHash);

    // 1% platform fee inside the trade amount
    const feeUsdc = Number((effectiveAmountUsdc * 0.01).toFixed(4));
    const netAmountUsdc = Number((effectiveAmountUsdc - feeUsdc).toFixed(4));
    const feeRecipient = process.env.APP_FEE_RECIPIENT_ADDRESS || process.env.PAYIT_DEV_FEE_ADDRESS || "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359";
    let feeTxHash = null;

    if (isDirectlySettled && user && feeUsdc > 0.0001 && feeRecipient && walletLib.isValidAddress(feeRecipient)) {
      try {
        const encryptedKey = isBizAccount
          ? (user.biz_system_encrypted_key || user.system_encrypted_key)
          : user.system_encrypted_key;
        if (encryptedKey) {
          const rawKey = walletLib.decryptSensitiveValue(encryptedKey);
          if (rawKey) {
            const userWallet = walletLib.walletFromPrivateKey(rawKey);
            if (userWallet.address.toLowerCase() !== feeRecipient.toLowerCase()) {
              const feeMicro = walletLib.parseToMicro(feeUsdc.toFixed(6));
              const feeTx = await walletLib.sendSponsoredOrDirectTransaction(userWallet, feeRecipient, feeMicro);
              feeTxHash = feeTx?.txHash || null;
              console.log(`[webhook_server:onramp] Collected 1% trade fee ($${feeUsdc} USDC) -> ${feeRecipient} (tx: ${feeTxHash})`);
            }
          }
        }
      } catch (feeErr) {
        console.warn("[webhook_server:onramp_fee_note]", feeErr.message);
      }
    }

    const creditedAmountUsdc = feeTxHash ? netAmountUsdc : effectiveAmountUsdc;
    const amountMicro = walletLib.parseToMicro(creditedAmountUsdc.toFixed(6));

    // Record onramp transaction in ledger
    const settlementTxHash = (bridgeResult && bridgeResult.arcTxHash) || solanaTxSignature || data.id;
    try {
      db.recordTransaction(
        targetTelegramId,
        "deposit_naira",
        amountMicro,
        isDirectlySettled ? "confirmed" : "pending_bridge",
        settlementTxHash,
        isBizAccount ? "business" : "personal"
      );
      if (fiatOrderId) {
        db.completeOnrampOrder(fiatOrderId, settlementTxHash);
      }
    } catch (recErr) {
      console.warn("[webhook_server] Record onramp tx error:", recErr.message);
    }

    // Send Telegram alert with accurate status, new balance, and PNG receipt when settled
    if (bot && targetTelegramId) {
      try {
        if (isDirectlySettled) {
          await sendOnrampDepositNotification({
            bot,
            telegramId: targetTelegramId,
            fiatAmount: effectiveFiatAmount,
            amountUsdc: creditedAmountUsdc,
            feeUsdc: feeTxHash ? feeUsdc : 0,
            accountType: isBizAccount ? "business" : "personal",
            txHash: settlementTxHash,
            orderId: fiatOrderId,
            rate: orderRate,
            network: "Arc Mainnet",
          });
        } else if (process.env.AUTO_BRIDGE_SOLANA_TO_ARC !== "true") {
          await sendOnrampDepositNotification({
            bot,
            telegramId: targetTelegramId,
            fiatAmount: effectiveFiatAmount,
            amountUsdc: creditedAmountUsdc,
            feeUsdc: feeTxHash ? feeUsdc : 0,
            accountType: isBizAccount ? "business" : "personal",
            txHash: settlementTxHash,
            orderId: fiatOrderId,
            rate: orderRate,
            network: "Solana Mainnet",
          });
        } else {
          await bot.telegram.sendMessage(
            targetTelegramId,
            `⏳ <b>Transaction in Progress (${accountLabel})</b>\n` +
            `──────────────────────────\n` +
            `💵 <b>Amount Deposited:</b> ₦${effectiveFiatAmount ? effectiveFiatAmount.toLocaleString() : "..."}\n` +
            `💰 <b>Incoming:</b> $${effectiveAmountUsdc.toFixed(2)} USDC\n` +
            `💼 <b>Account:</b> ${accountLabel}\n` +
            `🔄 <b>Status:</b> Processing deposit & transferring to your Proxim account on Arc...\n\n` +
            `<i>Your balance will automatically update once received on Arc.</i>`,
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
    // 0. Builder REST API routes (/api/v1/*)
    if (req.url && (req.url.startsWith("/api/v1") || req.url.startsWith("/api/v1/"))) {
      return apiRoutes.handleApiRequest(req, res, bot);
    }

    // 1. Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          status: "ok",
          service: "Proxim Gateway & Paj Webhook Server",
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

        // Reject unsigned or badly signed webhooks. Without this, anyone who knows the URL can
        // POST a fake "order.successful" event. Enforced when PAJ_WEBHOOK_SECRET (whsec_...) is set.
        const strictSecret = process.env.PAJ_WEBHOOK_SECRET || "";
        if (strictSecret) {
          if (!paj.verifyWebhookSignature(rawBody, req.headers, strictSecret)) {
            console.warn("[webhook_server] Rejected Paj webhook: missing or invalid signature.");
            res.writeHead(401, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "invalid signature" }));
          }
        } else {
          console.warn("[webhook_server] WARNING: PAJ_WEBHOOK_SECRET is not set. Paj webhooks are NOT authenticated.");
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
  sendOnrampDepositNotification,
  verifyAlchemySignature,
  evmDepositSweeper,
};
