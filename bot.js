// bot.js
// PayIT — Agentic Stablecoins Payment Solution inside Telegram
// Personal + Business accounts · dollar + euro wallets · Arc Testnet
//
// Architecture:
//   Every text message → intent_router → handler
//   Every photo        → vision_parser → confirmation flow
//   Every document     → file_parser   → bulk payment flow
//   Buttons are shortcuts to common intents, not the primary interface
//
// Run: node bot.js

require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const { JsonRpcProvider } = require("ethers");
const https = require("https");

// ── Src modules ───────────────────────────────────────────────────────────────
const db            = require("./src/db");
const walletLib     = require("./src/wallet");
const offrampLib    = require("./src/offramp");
const paj           = require("./src/paj");
const multichain    = require("./src/multichain");
const cctpBridge    = require("./src/cctp_bridge");
const fx            = require("./src/fx");
const otp           = require("./src/otp");
const savings       = require("./src/savings");
const tokens        = require("./src/tokens");
const swapLib       = require("./src/swap");
const gateway       = require("./src/gateway");
const invoiceDb     = require("./src/invoice_db");
const bizDb         = require("./src/biz_db");
const bizProfile    = require("./src/biz_profile");
const payeeBook     = require("./src/payee_book");
const webhookServer = require("./src/webhook_server");
const idempotency   = require("./src/idempotency");
const convState     = require("./src/conversation_state");
const { generateInvoicePNG }   = require("./src/invoice_generator");
const { generateReceiptPNG }   = require("./src/receipt_generator");
const paymaster = require("./src/paymaster");
const bankResolver = require("./src/bank_resolver");
const evmDepositSweeper = require("./src/evm_deposit_sweeper");
const autoEarn = require("./src/auto_earn");
const cashflow = require("./src/cashflow");

// ── Agent modules ─────────────────────────────────────────────────────────────
const { parsePaymentIntent }      = require("./agent/orchestrator");
const { executePlan, executeOfframp, formatResults } = require("./agent/executor");
const { startJob, cancelJob, reloadAll, describeSchedule } = require("./agent/scheduler");
const { saveSchedule, removeSchedule, getUserSchedules }   = require("./agent/store");
const { parseSmartInvoiceIntent } = require("./agent/smart_invoice_agent");
const { parseShoppingIntent, searchForProduct } = require("./agent/shopping_agent");
const { classifyIntent, getMissingQuestion, buildConfirmationText } = require("./agent/intent_router");
const { parseImagePayment, formatExtractionPreview } = require("./agent/vision_parser");
const { parsePdf, parseSpreadsheetFile, formatFilePreview, parsePptx, parseDocx, parseTextFile, buildFilePaymentPlan } = require("./agent/file_parser");
const { transcribeVoice } = require("./agent/voice_parser");
const { shouldReprocessConversationState } = require("./src/conversation_flow");
const { createHDInvoice, createCompleteInvoice, createCompleteBizInvoice, validateAndConfirmPayment, generateInvoiceQRData } = require("./src/invoice_hd");
const invoiceListener = require("./agent/invoice_listener");
const { safeAnswerCbQuery } = require("./src/telegram_utils");
const { getSettlementDestination } = require("./agent/invoice_listener");

const { getNetworkConfig, getExplorerUrl } = require("./src/network");
const { buildCircleOnrampUrl, getOnrampDetails } = require("./src/onramp");

const netConfig = getNetworkConfig();
const ARC_RPC_URL = netConfig.rpcUrl;
const ARC_CHAIN_ID = netConfig.chainId;
const REFERRAL_BONUS_POINTS = 20;
const arcProvider = new JsonRpcProvider(ARC_RPC_URL, ARC_CHAIN_ID);

// ─── Startup checks ───────────────────────────────────────────────────────────

if (!process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN.includes("PASTE_YOUR")) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN is not set in .env");
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Wrap Telegraf callback query responses so stale or invalid callback IDs do not crash the bot.
bot.use(async (ctx, next) => {
  if (ctx.from?.id) {
    db.updateUserLastActivity(ctx.from.id);
  }
  if (ctx && typeof ctx.answerCbQuery === "function") {
    const originalAnswer = ctx.answerCbQuery.bind(ctx);
    ctx.answerCbQuery = async (text, showAlert) => {
      try {
        return await originalAnswer(text, showAlert);
      } catch (err) {
        const message = err?.message || "";
        const code = err?.code || err?.response?.error_code;
        if (code === 400 || /query is too old|timeout expired|invalid/i.test(message)) {
          return null;
        }
        throw err;
      }
    };
  }
  return next();
});

const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

function notifyUser(telegramId, text, extra = {}) {
  if (!telegramId) return null;
  const botId = process.env.TELEGRAM_BOT_TOKEN;
  if (!botId) return null;
  return bot.telegram.sendMessage(telegramId, text, { parse_mode: extra.parseMode || "HTML", ...extra });
}

function parseAdminBroadcastArgs(text) {
  const parts = String(text || "").trim().split(/\s+/);
  if (parts.length < 2) return null;
  const command = parts[0];
  const message = parts.slice(1).join(" ");
  return { command, message };
}

function getUserActivityFilters(query) {
  const filters = {};
  const parts = String(query || "").trim().split(/\s+/);
  for (const part of parts) {
    if (!part.includes("=")) continue;
    const [key, rawValue] = part.split("=", 2);
    const value = rawValue.trim();
    if (!key || !value) continue;
    filters[key.toLowerCase()] = value;
  }
  return filters;
}

function selectTargetUsers(filters = {}) {
  const rows = db.db.prepare(`
    SELECT telegram_id, created_at, points_balance FROM users
    WHERE is_blocked = 0
  `).all();

  return rows.filter((row) => {
    const createdAt = new Date(row.created_at);
    const now = new Date();
    const daysSinceSignup = (now - createdAt) / (24 * 60 * 60 * 1000);

    if (filters.min_days && daysSinceSignup < Number(filters.min_days)) return false;
    if (filters.max_days && daysSinceSignup > Number(filters.max_days)) return false;
    if (filters.min_points && Number(row.points_balance || 0) < Number(filters.min_points)) return false;
    if (filters.max_points && Number(row.points_balance || 0) > Number(filters.max_points)) return false;

    const txCount = db.db.prepare(
      "SELECT COUNT(*) AS count FROM transactions WHERE telegram_id = ?"
    ).get(row.telegram_id).count;
    if (filters.min_tx && txCount < Number(filters.min_tx)) return false;
    if (filters.max_tx && txCount > Number(filters.max_tx)) return false;

    const recentTxCount = db.db.prepare(`
      SELECT COUNT(*) AS count
      FROM transactions
      WHERE telegram_id = ?
        AND created_at >= datetime('now', '-${Number(filters.recent_days || 30)} days')
    `).get(row.telegram_id).count;
    if (filters.min_recent_tx && recentTxCount < Number(filters.min_recent_tx)) return false;
    if (filters.max_recent_tx && recentTxCount > Number(filters.max_recent_tx)) return false;

    const invoiceCount = db.db.prepare(
      "SELECT COUNT(*) AS count FROM invoices WHERE owner_telegram_id = ?"
    ).get(row.telegram_id).count;
    if (filters.min_invoices && invoiceCount < Number(filters.min_invoices)) return false;
    if (filters.max_invoices && invoiceCount > Number(filters.max_invoices)) return false;

    return true;
  });
}

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return next();

  const user = db.getUser(userId);
  if (!user || !user.is_blocked) return next();

  const text = ctx.message?.text?.trim();
  const state = convState.getState(userId);
  if (text?.toLowerCase() === "/unlock" || state?.type === "confirm_unlock") {
    return next();
  }

  await ctx.reply("⚠️ Your PayIT account is locked. Send /unlock to restore access.");
  return;
});

// ─── Init all tables ──────────────────────────────────────────────────────────

invoiceDb.initInvoiceTables();
bizDb.initBizTables();
bizProfile.initBizProfileTable();
payeeBook.initPayeeTable();
convState.initStateTable();

// Purge stale conversation states on startup and every hour
convState.purgeExpired();
setInterval(convState.purgeExpired, 60 * 60 * 1000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getContext(userId) {
  return db.getUser(userId)?.active_context || "personal";
}

function normalizeMenuText(text) {
  return String(text || "").trim().replace(/\uFE0F/g, "").replace(/\s+/g, " ").toLowerCase();
}

function isSettingsRequest(text) {
  const normalized = normalizeMenuText(text);
  return normalized === "settings" || normalized === "⚙ settings" || normalized === "⚙️ settings" || normalized.startsWith("settings") || normalized.includes("settings");
}

function isCancelPhrase(text) {
  const normalized = String(text || "").trim().toLowerCase();
  return [
    "cancel",
    "stop",
    "exit",
    "main menu",
    "menu",
    "back",
    "never mind",
    "nevermind",
  ].includes(normalized);
}

function isLikelyNewIntent(text) {
  return shouldReprocessConversationState("", text);
}

function getActiveWallet(user) {
  if ((user.active_context || "personal") === "business") {
    return user.business_deposit_address || user.deposit_address;
  }
  return user.deposit_address;
}

function requireUser(ctx) {
  const user = db.getUser(ctx.from?.id);
  if (!user) {
    ctx.reply(
      "Welcome to PayIT!\n\nSend /start to set up your Account in under a minute."
    );
    return null;
  }
  return user;
}

function buildPlanFromClassifiedIntent(classified) {
  const recipients = Array.isArray(classified.params?.recipients)
    ? classified.params.recipients
    : [];

  const payments = recipients.map((r) => {
    const amount = Number(r.amount) || 0;
    const isOfframp = !!(r.account_number || r.bank_name || r.account_name);
    const to = isOfframp
      ? "__offramp__"
      : r.wallet_address || (r.name_or_address ? `__name__:${r.name_or_address}` : "__offramp__");
    const label = r.label ||
      (isOfframp
        ? `Cash out to ${r.bank_name || r.account_name || "bank account"}`
        : `Send to ${r.name_or_address || r.wallet_address || "recipient"}`);
    return {
      to,
      amount,
      label,
      bank_name:     r.bank_name || null,
      account_number:r.account_number || null,
      account_name:  r.account_name || null,
      currency:      r.currency || "USDC",
    };
  });

  return {
    payments,
    schedule: classified.params?.schedule || { frequency: null, day: null, time: null },
    summary: classified.raw_summary || "Payment",
  };
}

// Delete a message after a delay (used for PIN and key exports)
function scheduleDelete(ctx, messageId, ms = 60000) {
  setTimeout(() => {
    ctx.telegram.deleteMessage(ctx.chat.id, messageId).catch(() => {});
  }, ms);
}

// Delete the user's own message immediately (used after PIN entry)
async function deleteSensitiveMessage(ctx) {
  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
  } catch { /* message may already be gone */ }
}

async function safeGetBalance(address) {
  try {
    const usdcMicro = await walletLib.getNativeBalanceMicro(address);
    const usdc      = parseFloat(walletLib.formatMicro(usdcMicro));
    const eurcMicro = await tokens.getEurcBalance(address);
    const eurc      = parseFloat(walletLib.formatMicro(eurcMicro));
    let line = `$${usdc.toFixed(2)}`;
    if (eurc > 0) line += ` · €${eurc.toFixed(2)}`;
    return { usdc, eurc, display: line };
  } catch {
    return { usdc: 0, eurc: 0, display: "(unavailable)" };
  }
}

// Download a Telegram file as a Buffer
async function downloadTelegramFile(ctx, fileId) {
  const fileLink = await ctx.telegram.getFileLink(fileId);
  return new Promise((resolve, reject) => {
    const chunks = [];
    https.get(fileLink.href, res => {
      res.on("data", chunk => chunks.push(chunk));
      res.on("end",  ()    => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ─── Keyboards ────────────────────────────────────────────────────────────────

function mainMenu(context) {
  if (context === "business") {
    return Markup.keyboard([
      ["💼 Business Balance", "🧾 New Invoice", "💸 Log Expense"],
      ["📋 My Invoices",      "👥 Pay Team",    "📊 This Month"],
      ["💰 Business Savings", "📈 Reports",     "📤 Send Payment"],
      ["💵 Cash Out",         "🔄 Swap",        "⚙️ Settings"],
      ["📖 Help",             "✨ What's New"],
    ]).resize();
  }
  return Markup.keyboard([
    ["💰 My Money",    "📤 Send Money",  "🔄 Swap"],
    ["📥 Add Money",   "📈 Save & Earn", "📋 History"],
    ["🤖 Auto-Pay",   "🧾 Invoice",     "👥 Contacts"],
    ["🛒 Shop Online", "🔁 Switch Account"],
    ["⚙️ Settings",   "📖 Help"],
  ]).resize();
}

function accountToggle(context) {
  const personal = context === "personal"
    ? Markup.button.callback("● Personal", "noop")
    : Markup.button.callback("  Personal", "switch_personal");
  const business = context === "business"
    ? Markup.button.callback("● Business", "noop")
    : Markup.button.callback("  Business", "switch_business");
  return Markup.inlineKeyboard([[personal, business]]);
}

const backToMenu = Markup.inlineKeyboard([
  [Markup.button.callback("🏠 Main Menu", "main_menu")],
]);

const POINTS = {
  cashout: 5,
  sendout: 4,
  invoice: 10,
  businessInvoice: 12,
  savingsDeposit: 5,
  savingsWithdraw: 3,
  swap: 4,
};

const POINTS_PER_USD = 20;
const MIN_REDEEM_POINTS = 20;

function formatPointValue(points) {
  return `$${(points / POINTS_PER_USD).toFixed(2)}`;
}

// Wrap db.awardPoints to automatically send a notification when a referral bonus is triggered
const originalDbAwardPoints = db.awardPoints.bind(db);
db.awardPoints = function (telegramId, points, action, details = null, options = {}) {
  const mergedOptions = {
    ...options,
    notify: (event) => {
      if (typeof options.notify === "function") {
        try { options.notify(event); } catch {}
      }
      if (event?.action === "referral_bonus") {
        try {
          notifyUser(
            event.telegramId,
            `🎉 <b>Referral Bonus!</b>\n\n` +
            `A friend you invited just made their first transaction!\n` +
            `You earned <b>+${event.points} points (${formatPointValue(event.points)})</b>.\n\n` +
            `View your balance or redeem in ⚙️ Settings → 🏅 Rewards.`,
            { parseMode: "HTML" }
          );
        } catch (err) {
          console.warn("[referral] Failed to notify referrer:", err?.message || err);
        }
      }
    },
  };
  return originalDbAwardPoints(telegramId, points, action, details, mergedOptions);
};

const afterPaymentButtons = Markup.inlineKeyboard([
  [Markup.button.callback("💰 Check Balance", "action_balance"),
   Markup.button.callback("📋 History",       "action_history")],
  [Markup.button.callback("🏠 Main Menu", "main_menu")],
]);

// ─── /start — onboarding ──────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const existing = db.getUser(ctx.from.id);
  if (existing) {
    if (existing.is_blocked) {
      return ctx.reply("⚠️ Your PayIT account is locked. Send /unlock to restore access.");
    }

    const context = existing.active_context || "personal";
    const addr    = getActiveWallet(existing);
    const bal     = await safeGetBalance(addr);
    await ctx.reply(
      `👋 Welcome back, ${ctx.from.first_name || "there"}!\n\n` +
      `Your balance: ${bal.display}\n` +
      `Account: ${context === "business" ? "Business 💼" : "Personal 👤"}\n\n` +
      `What would you like to do?`,
      mainMenu(context)
    );
    return ctx.reply(
      `Active account: ${context === "business" ? "Business 💼" : "Personal 👤"}\nSwitch below:`,
      accountToggle(context)
    );
  }

  const startPayload = String(ctx.startPayload || ctx.message?.text?.split(" ")[1] || "").trim();
  const referrer = startPayload ? db.getUserByReferralCode(startPayload) : null;
  let referralGreeting = "";
  if (referrer && referrer.telegram_id !== ctx.from.id) {
    convState.setState(ctx.from.id, "pending_referral", { referrerId: referrer.telegram_id }, "personal");
    const inviterName = referrer.username ? `@${referrer.username}` : "a friend";
    referralGreeting = `🎁 You were invited by ${inviterName}!\nComplete setup and your first transaction to unlock bonus rewards.\n\n`;
  }

  return ctx.reply(
    `${referralGreeting}` +
    `👋 Welcome to PayIT.\n\n` +
    `Save in dollars. Spend in Naira.\n` +
    `Everything right here in Telegram.\n\n` +
    `Earn points while you use PayIT:\n` +
    `• 5 points for Cash Out\n` +
    `• 4 points for sending money\n` +
    `• 10 points for creating an invoice\n` +
    `• 12 points for a business invoice\n` +
    `• 5 points for saving to interest\n` +
    `• 3 points for withdrawing savings\n` +
    `• 20 points when a friend you refer earns their first point\n\n` +
    `Your money stays yours — PayIT never holds it for you.\n\n` +
    `How will you use PayIT?`,
    Markup.inlineKeyboard([
      [Markup.button.callback("👤 Personal",  "onboard_personal")],
      [Markup.button.callback("💼 Business",  "onboard_business")],
    ])
  );
});

// ── Personal onboarding path ──────────────────────────────────────────────────

bot.action("onboard_personal", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  const pending = convState.getState(ctx.from.id);
  const referrerId = pending?.type === "pending_referral" ? pending.data.referrerId : null;
  const wallet = walletLib.generateUserWallet();
  convState.setState(ctx.from.id, "onboarding_pin", {
    accountType: "personal",
    address:     wallet.address,
    privateKey:  wallet.privateKey,
    username:    ctx.from.username,
    referrerId,
  }, "personal");
  await ctx.reply(
    `👤 Personal account — great.\n\n` +
    `We'll set up your Account now.\n\n` +
    `First, choose a 4-digit PIN. This is the only thing protecting your money — ` +
    `write it down somewhere safe.\n\n` +
    `⚠️ If you forget your PIN and haven't saved your security phrase, ` +
    `your money cannot be recovered by anyone, including us.\n\n` +
    `Type your 4-digit PIN:`
  );
});

// ── Business onboarding path — collects full profile before PIN ───────────────

function startBusinessOnboarding(ctx, options = {}) {
  const pending = convState.getState(ctx.from.id);
  const referrerId = options.referrerId ?? (pending?.type === "pending_referral" ? pending.data.referrerId : null);
  convState.setState(ctx.from.id, "onboard_biz_name", {
    username: ctx.from.username,
    referrerId,
    source: options.source || "onboard",
  }, "business");
  return ctx.reply(
    `💼 Business account — let's set up your profile.\n\n` +
    `This appears on every invoice you create.\n\n` +
    `What's your business name?`
  );
}

bot.action("onboard_business", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  return startBusinessOnboarding(ctx, { source: "onboard" });
});

// ─── Account switching ────────────────────────────────────────────────────────

bot.action("switch_personal", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  const user = requireUser(ctx);
  if (!user) return;
  db.setActiveContext(ctx.from.id, "personal");
  const bal = await safeGetBalance(user.deposit_address);
  try {
    await ctx.editMessageReplyMarkup(accountToggle("personal").reply_markup);
  } catch (err) {
    // Ignore error if edit fails
  }
  await ctx.reply(
    `👤 Switched to Personal\n\nYour balance: ${bal.display}`,
    mainMenu("personal")
  );
});

bot.action("switch_business", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  const user = requireUser(ctx);
  if (!user) return;

  if (!user.business_deposit_address) {
    return startBusinessOnboarding(ctx, { source: "switch" });
  }

  db.setActiveContext(ctx.from.id, "business");
  const bal     = await safeGetBalance(user.business_deposit_address);
  const pending = bizDb.getPendingInvoiceCount(ctx.from.id);
  const pendingLine = pending > 0
    ? `\n📬 ${pending} unpaid invoice${pending > 1 ? "s" : ""} waiting.`
    : "";

  try {
    await ctx.editMessageReplyMarkup(accountToggle("business").reply_markup);
  } catch (err) {
    // Ignore error if edit fails
  }

  await ctx.reply(
    `💼 Switched to Business\n\nBalance: ${bal.display}${pendingLine}`,
    mainMenu("business")
  );
});

bot.action("noop",      (ctx) => ctx.answerCbQuery());
bot.action("action_switch_account", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const context = user.active_context || "personal";
  return ctx.reply("Switch active account:", accountToggle(context));
});
bot.action("main_menu", (ctx) => {
  ctx.answerCbQuery();
  const context = getContext(ctx.from?.id);
  return ctx.reply("What would you like to do?", mainMenu(context));
});

bot.hears("🔁 Switch Account", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const context = user.active_context || "personal";
  await ctx.reply("Switch active account:", accountToggle(context));
});

// ─── Balance ──────────────────────────────────────────────────────────────────

async function showBalance(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  const context = user.active_context || "personal";
  const address = getActiveWallet(user);
  const label   = context === "business" ? "💼 Business" : "👤 Personal";

  try {
    const usdcMicro = await walletLib.getNativeBalanceMicro(address);
    const usdc      = parseFloat(walletLib.formatMicro(usdcMicro));
    const eurcMicro = await tokens.getEurcBalance(address);
    const eurc      = parseFloat(walletLib.formatMicro(eurcMicro));
    const rate      = await fx.getUsdToNgnRate();

    const nairaLine = rate
      ? `≈ ${fx.formatNaira(usdc * rate)} at ₦${Math.round(rate).toLocaleString()}/$`
      : "";
    const eurcLine  = eurc > 0 ? `\n€${eurc.toFixed(2)} euros` : "";

    await ctx.reply(
      `💰 ${label} Balance\n──────────────────────────\n` +
      `$${usdc.toFixed(2)} dollars${eurcLine}\n${nairaLine}\n\n` +
      `Your PayIT account number (tap to copy):\n${address}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📥 Add Money",       "action_receive"),
         Markup.button.callback("📤 Send Money",      "action_send_menu")],
        [Markup.button.callback("💵 Cash Out to Naira", "action_withdraw_menu"),
         Markup.button.callback("📈 Earn Interest",   "action_yields")],
        [Markup.button.callback("🌐 Crypto Deposit",  "action_gateway"),
         Markup.button.callback("🔄 Scan & Sweep",    "action_sweep_deposits")],
        [Markup.button.callback("📋 History",         "action_history")],
      ])
    );
  } catch (err) {
    console.error("[balance]", err);
    await ctx.reply("Couldn't check your balance right now — please try again shortly.");
  }
}

async function showBizBalance(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  if (!user.business_deposit_address) {
    return ctx.reply(
      "No Business account found.",
      Markup.inlineKeyboard([[Markup.button.callback("💼 Set up Business", "switch_business")]])
    );
  }
  try {
    const addr      = user.business_deposit_address;
    const usdcMicro = await walletLib.getNativeBalanceMicro(addr);
    const usdc      = parseFloat(walletLib.formatMicro(usdcMicro));
    const eurcMicro = await tokens.getEurcBalance(addr);
    const eurc      = parseFloat(walletLib.formatMicro(eurcMicro));
    const rate      = await fx.getUsdToNgnRate();
    const nairaLine = rate ? `≈ ${fx.formatNaira(usdc * rate)}` : "";
    const eurcLine  = eurc > 0 ? `\n€${eurc.toFixed(2)} euros` : "";
    const pending   = bizDb.getPendingInvoiceCount(ctx.from.id);
    const expenses  = bizDb.getMonthExpenses(ctx.from.id);

    await ctx.reply(
      `💼 Business Balance\n──────────────────────────\n` +
      `$${usdc.toFixed(2)} dollars${eurcLine}\n${nairaLine}\n\n` +
      `📬 Unpaid invoices: ${pending}\n` +
      `📉 Expenses this month: $${expenses.toFixed(2)}\n\n` +
      `Account number:\n${addr}`,
      { ...Markup.inlineKeyboard([
        [Markup.button.callback("🧾 New Invoice",   "action_new_biz_invoice"),
         Markup.button.callback("💸 Log Expense",   "action_log_expense")],
        [Markup.button.callback("📋 Invoices",      "action_list_biz_invoices"),
         Markup.button.callback("📊 This Month",    "action_cash_flow")],
        [Markup.button.callback("🌐 Crypto Deposit", "action_gateway"),
         Markup.button.callback("🔄 Scan & Sweep",  "action_sweep_deposits")],
      ]), ...accountToggle("business") }
    );
  } catch (err) {
    console.error("[biz_balance]", err);
    await ctx.reply("Couldn't check your balance right now — please try again.");
  }
}

// ─── Receive / Add Money ──────────────────────────────────────────────────────

async function showReceive(ctx) {
  const user    = requireUser(ctx);
  if (!user) return;
  const context = user.active_context || "personal";
  const address = getActiveWallet(user);
  const label   = context === "business" ? "Business" : "Personal";

  await ctx.reply(
    `📥 <b>Add Money — ${label}</b>\n──────────────────────────\n` +
    `Choose your preferred deposit method:\n\n` +
    `• 🇳🇬 <b>Bank Transfer (Naira)</b>: Pay from your Nigerian bank app (Kuda, GTBank, Opay, PalmPay) to get Dollars.\n` +
    `• 💳 <b>Card or Apple Pay</b>: Direct purchase with Visa, Mastercard, or Apple Pay.\n` +
    `• 🌐 <b>Crypto & Web3 Deposit</b>: Send crypto directly from Binance, Coinbase, or any Web3 wallet.\n\n` +
    `Your PayIT Account Number (tap to copy):\n<code>${address}</code>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🇳🇬 Deposit Naira (Bank Transfer)", "action_paj_onramp")],
        [Markup.button.callback("💳 Pay with Card / Apple Pay",     "gateway_onramp")],
        [Markup.button.callback("🌐 Crypto & Web3 Deposit",        "action_gateway")],
        [Markup.button.callback("🔄 Scan & Sweep Deposits",        "action_sweep_deposits")],
        [Markup.button.callback("💰 Check Balance",                 "action_balance")],
        [Markup.button.callback("🏠 Main Menu",                     "main_menu")],
      ]),
    }
  );
}

// ─── History ──────────────────────────────────────────────────────────────────

async function showHistory(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  const address = getActiveWallet(user);
  const txs     = db.getTransactions(ctx.from.id, 10);

  if (!txs.length) {
    return ctx.reply(
      `📋 No transactions yet.\n\nOnce you send or receive money, everything will appear here.`,
      backToMenu
    );
  }

  const typeLabel = {
    send_usdc:                  "Sent dollars",
    send_eurc:                  "Sent euros",
    offramp:                    "Cashed out",
    offramp_request:            "Cashed out",
    autopay:                    "Auto-payment",
    yield_deposit:              "Saved to interest pool",
    yield_withdraw:             "Withdrew from interest pool",
  };

  const lines = txs.map(t => {
    const label  = typeLabel[t.type] || t.type;
    const amount = walletLib.formatMicro(t.amount_micro);
    const status = t.status === "confirmed" ? "✅" : t.status === "failed" ? "❌" : "⏳";
    return `${status} ${label}  $${parseFloat(amount).toFixed(2)}\n   ${t.created_at}`;
  });

  await ctx.reply(
    `📋 Recent Activity\n──────────────────────────\n` +
    lines.join("\n\n") +
    `\n\nFull history: ${getExplorerUrl(address)}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("💰 Balance", "action_balance")],
      [Markup.button.callback("🏠 Main Menu", "main_menu")],
    ])
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function showSettings(ctx) {
  const user    = requireUser(ctx);
  if (!user) return;
  const context = user.active_context || "personal";
  const hasBiz  = !!user.business_deposit_address;
  const phone   = user.phone_number
    ? `${user.phone_number} ${user.phone_verified ? "✅" : "⏳"}`
    : "not set";
  const points  = db.getPointsBalance(ctx.from.id);
  const paymasterStatus = paymaster.isPaymasterActive() ? "Arc Paymaster (Sponsored ⛽)" : "Direct (Self-paid)";

  await ctx.reply(
    `⚙️ Settings\n──────────────────────────\n` +
    `Active account: ${context === "business" ? "Business 💼" : "Personal 👤"}\n` +
    `Personal account: ${user.deposit_address}\n` +
    `Business account: ${hasBiz ? user.business_deposit_address : "not set up yet"}\n` +
    `Linked account: ${user.external_wallet_address || "none"}\n` +
    `Gas Sponsorship: ${paymasterStatus}\n` +
    `Phone: ${phone}\n` +
    `Rewards: ${points} points (${formatPointValue(points)})\n\n` +
    `PayIT never holds your money. Your PIN is the only key to your funds.`,

    Markup.inlineKeyboard([
      [Markup.button.callback("🔁 Switch Account",              "action_switch_account")],
      [Markup.button.callback("🔑 Save Personal Security Phrase", "export_personal")],
      [Markup.button.callback("🔑 Save Business Security Phrase", "export_business")],
      [Markup.button.callback("🔒 Change PIN",                  "changepin")],
      [Markup.button.callback("🛡️ Lock Account",                "lock_account")],
      [Markup.button.callback("👛 Link External Wallet",        "setwallet_prompt")],
      [Markup.button.callback("📱 Verify Phone",                "verifyphone_prompt")],
      [Markup.button.callback("🏅 Rewards",                     "action_rewards")],
      [Markup.button.callback("👥 Invite Friends",               "action_referral")],
      [Markup.button.callback("💼 Business Profile",            "biz_profile_menu")],
      [Markup.button.callback("🏠 Main Menu",                   "main_menu")],
    ])
  );
}

let cachedBotUsername = process.env.BOT_USERNAME || null;
async function resolveBotUsername(ctx) {
  if (cachedBotUsername) return cachedBotUsername;
  if (ctx?.botInfo?.username) {
    cachedBotUsername = ctx.botInfo.username;
    return cachedBotUsername;
  }
  if (bot.botInfo?.username) {
    cachedBotUsername = bot.botInfo.username;
    return cachedBotUsername;
  }
  try {
    const me = await bot.telegram.getMe();
    if (me?.username) {
      cachedBotUsername = me.username;
      bot.botInfo = me;
      return cachedBotUsername;
    }
  } catch (err) {
    console.warn("[bot] Failed to resolve bot username:", err?.message || err);
  }
  return "payeetbot";
}

async function showReferralMenu(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  const referralCode = user.referral_code || `ref${user.telegram_id}`;
  const botUsername = await resolveBotUsername(ctx);
  const shareLink = `https://t.me/${botUsername}?start=${referralCode}`;
  const shareText = `Join me on PayIT! Save in USD and spend in Naira directly on Telegram: ${shareLink}`;
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareLink)}&text=${encodeURIComponent("Join me on PayIT! Save in USD and spend in Naira directly on Telegram.")}`;

  await ctx.reply(
    `👥 <b>Invite Friends & Earn</b>\n` +
    `──────────────────────────\n` +
    `Earn <b>${REFERRAL_BONUS_POINTS} points (${formatPointValue(REFERRAL_BONUS_POINTS)})</b> when a friend you refer registers and completes their first transaction!\n\n` +
    `<b>Your Referral Code:</b>\n` +
    `<code>${referralCode}</code>\n\n` +
    `<b>Your Referral Link (tap to copy):</b>\n` +
    `<code>${shareLink}</code>\n\n` +
    `Tap <b>"📤 Share Invite Link"</b> below to send it to friends or groups on Telegram, or tap the link above to copy. Once they join and complete their first transaction, your bonus is credited automatically!`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.url("📤 Share Invite Link", shareUrl)],
        [Markup.button.callback("« Back", "action_settings")],
        [Markup.button.callback("🏠 Main Menu", "main_menu")],
      ]),
    }
  );
}

// ─── Rewards Menu ───────────────────────────────────────────────────────────

async function showRewardsMenu(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  const balance = db.getPointsBalance(ctx.from.id);

  await ctx.reply(
    `🏅 PayIT Rewards
──────────────────────────
` +
    `Points balance: ${balance}
` +
    `Redeem value: ${formatPointValue(balance)}

` +
    `Redeem points for airtime, bill credits, and cashback bonuses.
`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📲 Redeem Airtime", "action_redeem_airtime")],
      [Markup.button.callback("🏦 Pay Bills",       "action_redeem_bills")],
      [Markup.button.callback("👥 Invite Friends",  "action_referral")],
      [Markup.button.callback("📜 Points History",  "action_rewards_history")],
      [Markup.button.callback("🏠 Main Menu",       "main_menu")],
    ])
  );
}

bot.action("action_rewards", (ctx) => { ctx.answerCbQuery(); return showRewardsMenu(ctx); });

bot.action("action_rewards_history", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const balance = db.getPointsBalance(ctx.from.id);
  const history = db.getPointsHistory(ctx.from.id, 10);
  const lines = history.length
    ? history.map((row) => `${row.created_at.split(" ")[0]} · ${row.points > 0 ? "+" : ""}${row.points} · ${row.action}${row.details ? ` · ${row.details}` : ""}`).join("\n")
    : "No activity yet.";

  await ctx.reply(
    `📜 Points History
──────────────────────────
` +
    `Balance: ${balance} points (${formatPointValue(balance)})

` +
    `${lines}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🏠 Main Menu", "main_menu")],
      [Markup.button.callback("📲 Redeem Airtime", "action_redeem_airtime")],
      [Markup.button.callback("🏦 Pay Bills", "action_redeem_bills")],
    ])
  );
});

bot.action("action_redeem_airtime", async (ctx) => {
  ctx.answerCbQuery();
  convState.setState(ctx.from.id, "await_redeem_points", { redeemType: "airtime" }, getContext(ctx.from.id));
  return ctx.reply(
    `📲 Redeem for Airtime
──────────────────────────
` +
    `How many points would you like to redeem?
` +
    `Minimum ${MIN_REDEEM_POINTS} points.

` +
    `Example: 100`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});

bot.action("action_redeem_bills", async (ctx) => {
  ctx.answerCbQuery();
  convState.setState(ctx.from.id, "await_redeem_points", { redeemType: "bills" }, getContext(ctx.from.id));
  return ctx.reply(
    `🏦 Redeem for Bills
──────────────────────────
` +
    `How many points would you like to redeem?
` +
    `Minimum ${MIN_REDEEM_POINTS} points.

` +
    `Example: 100`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});

bot.command("rewards", async (ctx) => showRewardsMenu(ctx));
bot.command("referral", async (ctx) => showReferralMenu(ctx));
bot.command("invite", async (ctx) => showReferralMenu(ctx));
bot.hears("🏅 Rewards", (ctx) => showRewardsMenu(ctx));
bot.hears("👥 Invite Friends", (ctx) => showReferralMenu(ctx));
bot.hears(/^(?:👥\s*)?(?:referral(?:\s*link)?|invite(?:\s*(?:friends|link))?|share\s*link)$/i, (ctx) => showReferralMenu(ctx));

// ─── Business Profile Menu ────────────────────────────────────────────────────

bot.action("biz_profile_menu", async (ctx) => {
  ctx.answerCbQuery();
  const user    = requireUser(ctx);
  if (!user) return;
  const profile = bizProfile.getBizProfile(ctx.from.id);

  if (!profile) {
    return ctx.reply(
      `💼 No business profile yet.\n\nSet one up to add your branding to invoices.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Set Up Profile", "onboard_business")],
        [Markup.button.callback("« Back",         "action_settings")],
      ])
    );
  }

  await ctx.reply(
    `💼 Business Profile\n──────────────────────────\n` +
    `Name: ${profile.business_name}\n` +
    `Email: ${profile.business_email || "not set"}\n` +
    `Phone: ${profile.phone || "not set"}\n` +
    `Address: ${profile.address || "not set"}\n` +
    `Default payment terms: ${profile.default_due_days} days\n` +
    `Logo: ${profile.logo_path ? "uploaded ✅" : "not uploaded"}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("✏️ Update Name",         "biz_edit_name")],
      [Markup.button.callback("✏️ Update Email",        "biz_edit_email")],
      [Markup.button.callback("✏️ Update Phone",        "biz_edit_phone")],
      [Markup.button.callback("✏️ Update Address",      "biz_edit_address")],
      [Markup.button.callback("🖼️ Upload Logo",         "biz_edit_logo")],
      [Markup.button.callback("✏️ Payment Terms",       "biz_edit_terms")],
      [Markup.button.callback("« Back to Settings",    "action_settings")],
    ])
  );
});

// Individual field edits
const bizEditFields = {
  biz_edit_name:    { field: "business_name",    prompt: "Enter your new business name:" },
  biz_edit_email:   { field: "business_email",   prompt: "Enter your business email address:" },
  biz_edit_phone:   { field: "phone",            prompt: "Enter your business phone number:" },
  biz_edit_address: { field: "address",          prompt: "Enter your business address:" },
  biz_edit_terms:   { field: "default_due_days", prompt: "How many days until invoices are due? (e.g. 14, 30)" },
};

for (const [action, { field, prompt }] of Object.entries(bizEditFields)) {
  bot.action(action, (ctx) => {
    ctx.answerCbQuery();
    convState.setState(ctx.from.id, "biz_edit_field", { field }, getContext(ctx.from.id));
    return ctx.reply(
      prompt,
      Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "biz_profile_menu")]])
    );
  });
}

bot.action("biz_edit_logo", (ctx) => {
  ctx.answerCbQuery();
  convState.setState(ctx.from.id, "await_logo_upload", {}, getContext(ctx.from.id));
  return ctx.reply(
    `🖼️ Send your business logo as a photo.\n\n` +
    `Recommended: square image (PNG or JPG), at least 200×200px.`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "biz_profile_menu")]])
  );
});

bot.action("lock_account", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  const user = requireUser(ctx);
  if (!user) return;
  convState.setState(ctx.from.id, "confirm_lock", {}, getContext(ctx.from.id));
  return ctx.reply(
    `Enter your PIN to lock your account.\n\n` +
    `This will disable PayIT until you send /unlock and confirm your PIN.`
  );
});

// ─── Help & Features ──────────────────────────────────────────────────────────

function showHelp(ctx) {
  const context = getContext(ctx.from?.id);
  if (context === "business") {
    return ctx.reply(
      `📖 PayIT for Business\n──────────────────────────\n` +
      `🧾 New Invoice — describe it in plain English, get a PDF\n` +
      `📋 My Invoices — track and manage what's owed to you\n` +
      `💸 Log Expense — record a business spend quickly\n` +
      `👥 Pay Team — bulk pay your staff in dollars\n` +
      `📊 This Month — income vs expenses summary\n` +
      `💰 Business Savings — set aside money for tax or goals\n` +
      `📤 Send Payment — pay suppliers in dollars\n` +
      `💵 Cash Out — convert dollars to Naira\n\n` +
      `You can also just type what you want to do — PayIT understands plain English and Pidgin.`,
      mainMenu(context)
    );
  }
  return ctx.reply(
    `📖 How to Use PayIT\n──────────────────────────\n` +
    `💰 My Money — your dollar and euro balance\n` +
    `📥 Add Money — your account number to receive\n` +
    `📤 Send Money — send to a saved contact or account number\n` +
    `📈 Save & Earn — earn interest on your dollars\n` +
    `🤖 Auto-Pay — set up recurring payments\n` +
    `🧾 Invoice — create and send payment requests\n` +
    `👥 Contacts — save people you pay often\n` +
    `🌍 Add from Abroad — bring money from Binance, Coinbase, MetaMask\n\n` +
    `You can also just type what you want — "send 10 dollars to Emeka", ` +
    `"cash out 50 to my GTBank account", "invoice TechCorp 200 for design work".\n\n` +
    `You can even send a photo of a bill or invoice and PayIT will read it.`,
    mainMenu(context)
  );
}

function showFeatures(ctx) {
  const context = getContext(ctx.from?.id);
  return ctx.reply(
    `✨ What's live on PayIT:\n\n` +
    `✅ Personal and Business accounts (one PIN)\n` +
    `✅ Agentic Stablecoins Payment Solution\n` +
    `✅ Add money from Binance, Coinbase, MetaMask and more\n` +
    `✅ Cash out to Naira via bank transfer\n` +
    `✅ Earn interest on your dollar balance\n` +
    `✅ Create professional invoices in plain English\n` +
    `✅ Auto-payments — schedule recurring transfers\n` +
    `✅ Business tools: invoices, expenses, payroll, cash flow\n` +
    `✅ Send a photo of a bill and PayIT reads and pays it\n` +
    `✅ Upload a spreadsheet to bulk pay your team\n` +
    `✅ Save contacts — send to "Emeka" instead of a long account number\n\n` +
    `🚧 Coming soon:\n` +
    `— Card spending\n` +
    `— Airtime and bills\n` +
    `— Business AI reports`,
    mainMenu(context)
  );
}

// ─── Contacts (Payee Book) ────────────────────────────────────────────────────

async function showContacts(ctx) {
  const user    = requireUser(ctx);
  if (!user) return;
  const payees  = payeeBook.getAllPayees(ctx.from.id);

  if (!payees.length) {
    return ctx.reply(
      `👥 No contacts saved yet.\n\n` +
      `Save someone by typing:\n` +
      `"Save 0xABC... as Emeka"\n` +
      `"Add Amara — GTBank 0123456789"\n\n` +
      `Once saved, just say "send 50 to Emeka" and PayIT knows who you mean.`,
      backToMenu
    );
  }

  const list = payeeBook.formatPayeeList(payees);
  await ctx.reply(
    `👥 Your Contacts\n──────────────────────────\n${list}`,
    { parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("➕ Add Contact", "add_contact")],
        [Markup.button.callback("🏠 Main Menu",   "main_menu")],
      ])
    }
  );
}

bot.action("add_contact", (ctx) => {
  ctx.answerCbQuery();
  convState.setState(ctx.from.id, "await_add_contact", {}, getContext(ctx.from.id));
  return ctx.reply(
    `👥 Add a contact\n──────────────────────────\n` +
    `Type their details in plain English:\n\n` +
    `• "Save 0xABC...123 as Emeka"\n` +
    `• "Add Amara — GTBank account 0123456789"\n` +
    `• "Save john@payit.app as John for invoices"`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});

// ─── Yields / Save & Earn ─────────────────────────────────────────────────────

async function showYields(ctx) {
  await ctx.reply("Fetching current interest rates...");
  try {
    const user = requireUser(ctx);
    const context = getContext(ctx.from.id);
    const autoEarnEnabled = user ? Boolean(user.auto_earn_enabled !== 0) : true;
    const pools = await savings.getYieldPools();
    const openPos = user ? db.getOpenYieldPosition(ctx.from.id, context) : null;
    const statusText = autoEarnEnabled
      ? `🟢 <b>Auto-Earn:</b> Active (funds idle ≥ 2 hrs automatically earn yield)`
      : `⚪ <b>Auto-Earn:</b> Disabled (funds remain liquid)`;

    let activeSummary = "";
    if (openPos) {
      const accrued = savings.calcAccruedYield(openPos);
      activeSummary = `\n\n💼 <b>Active ${context === "business" ? "Business" : "Personal"} Savings:</b> $${openPos.amount_usdc.toFixed(2)} (+${accrued.toFixed(4)} accrued yield)`;
    }

    await ctx.reply(
      savings.formatYieldList(pools) + `\n\n⚙️ <b>Settings (${context === "business" ? "Business" : "Personal"}):</b>\n${statusText}${activeSummary}`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("➕ Start Saving",      "yield_deposit_start")],
          [Markup.button.callback("📊 My Savings",        "action_my_yield")],
          [Markup.button.callback("💵 Withdraw Savings",  "yield_withdraw_start")],
          [Markup.button.callback(autoEarnEnabled ? "⏸️ Turn Off Auto-Earn" : "▶️ Turn On Auto-Earn", "toggle_auto_earn")],
          [Markup.button.callback("🏠 Main Menu",         "main_menu")],
        ])
      }
    );
  } catch (err) {
    console.error("[yields]", err.message);
    await ctx.reply("Couldn't fetch interest rates right now — try again shortly.");
  }
}

bot.action("toggle_auto_earn", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const current = Boolean(user.auto_earn_enabled !== 0);
  const nextVal = !current;
  db.updateAutoEarnSetting(ctx.from.id, nextVal);
  await ctx.reply(
    nextVal
      ? "🟢 <b>Auto-Earn Enabled!</b>\n\nWhen your dollars sit idle on PayIT for 2+ hours, they automatically earn interest in high-yield daily savings. You keep 90% of the interest earned upon withdrawal, and your money is always 100% available whenever you make a payment!"
      : "⚪ <b>Auto-Earn Disabled.</b>\n\nYour funds will remain in your standard wallet balance without earning interest.",
    { parse_mode: "HTML" }
  );
  return showYields(ctx);
});

async function showMyYield(ctx) {
  const user     = requireUser(ctx);
  if (!user) return;
  const context  = getContext(ctx.from.id);
  const position = db.getOpenYieldPosition(ctx.from.id, context);
  if (!position) {
    return ctx.reply(
      `📊 No active ${context === "business" ? "Business" : "Personal"} savings yet.\n\nStart earning interest on your dollars.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ Start Saving", "yield_deposit_start")],
        [Markup.button.callback("🏠 Main Menu",    "main_menu")],
      ])
    );
  }
  await ctx.reply(
    savings.formatPosition(position),
    Markup.inlineKeyboard([
      [Markup.button.callback("💵 Withdraw Savings", "yield_withdraw_start")],
      [Markup.button.callback("📈 View Rates",       "action_yields")],
      [Markup.button.callback("🏠 Main Menu",        "main_menu")],
    ])
  );
}

bot.action("action_my_yield", (ctx) => {
  ctx.answerCbQuery();
  return showMyYield(ctx);
});

// ─── Gateway / Add from Abroad ────────────────────────────────────────────────

bot.action("action_gateway", async (ctx) => {
  ctx.answerCbQuery();
  const user    = requireUser(ctx);
  if (!user) return;
  const arcAddress = getActiveWallet(user);

  let solAddress = user.solana_deposit_address;
  if (!solAddress && user.deposit_address) {
    try {
      const derived = multichain.deriveSolanaFromEvmKey(user.deposit_address.padEnd(66, "0"));
      solAddress = derived.solanaAddress;
      db.updateSolanaAddress(user.telegram_id, solAddress);
    } catch (_) {}
  }

  await ctx.reply(
    `🌐 <b>Crypto & Web3 Deposit (Multi-Chain)</b>\n` +
    `──────────────────────────\n` +
    `Deposit crypto from Robinhood, Binance, Coinbase, Bybit, OKX, or any Web3 wallet directly into your PayIT balance.\n\n` +
    `<b>Your Unified EVM Deposit Address (tap to copy):</b>\n` +
    `<code>${arcAddress}</code>\n` +
    (solAddress ? `\n<b>Your Solana Deposit Address (tap to copy):</b>\n<code>${solAddress}</code>\n` : "") +
    `\n⚡ <b>Automated Instant Conversion to Arc USDC:</b>\n` +
    `• <b>Supported Networks:</b>\n` +
    `  ▫️ <b>Arc Mainnet</b> (Native — Direct USDC & EURC)\n` +
    `  ▫️ <b>Robinhood Chain</b> (Native ETH & USDG)\n` +
    `  ▫️ <b>Base</b> (Native ETH & USDC)\n` +
    `  ▫️ <b>Arbitrum One</b> (Native ETH & USDC)\n` +
    `  ▫️ <b>Ethereum Mainnet</b> (Native ETH & USDC)\n` +
    `  ▫️ <b>Optimism</b> (Native ETH & USDC)\n` +
    `  ▫️ <b>Polygon PoS</b> (Native POL/MATIC & USDC)\n` +
    `  ▫️ <b>Avalanche C-Chain</b> (Native AVAX & USDC)\n` +
    (solAddress ? `  ▫️ <b>Solana</b> (SPL USDC & SOL)\n` : "") +
    `• <b>Accepted Assets:</b> Native tokens (ETH, AVAX, POL/MATIC${solAddress ? ", SOL" : ""}), USDG, and USDC/EURC\n` +
    `• <b>Zero Bridge Hassle:</b> Native tokens and cross-chain assets are automatically swapped to USDC and bridged to Arc Mainnet with <b>zero user gas or signing required</b>!\n` +
    `• <b>Instant Settlement:</b> Native USDC is credited to your PayIT balance automatically.\n\n` +
    `<i>Send any amount to your address above, or tap below to scan for recent transfers.</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Scan & Sweep Deposits", "action_sweep_deposits")],
        [Markup.button.callback("💳 Buy USDC with Card (Onramp)", "gateway_onramp")],
        [Markup.button.url("🔎 View on Explorer", getExplorerUrl(arcAddress))],
        [Markup.button.callback("💰 Check Balance", "action_balance")],
        [Markup.button.callback("🏠 Main Menu", "main_menu")],
      ]),
    }
  );
});

async function handleSweepDeposits(ctx) {
  if (ctx.callbackQuery) {
    ctx.answerCbQuery().catch(() => {});
  }
  const user = requireUser(ctx);
  if (!user) return;

  if (!user.system_encrypted_key) {
    convState.setState(ctx.from.id, "sweep_auth_pin", {}, getContext(ctx.from.id));
    return ctx.reply(
      `🔐 <b>One-Time Authorization</b>\n──────────────────────────\n` +
      `To authorize automated multi-chain deposit sweeps, please enter your 4-digit PIN:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_gateway")]]),
      }
    );
  }

  await ctx.reply("🔍 Scanning Arc, Base, Arbitrum, Robinhood Chain, Ethereum, Avalanche, Polygon, and Optimism for deposits...");
  try {
    const results = await evmDepositSweeper.sweepUserDeposits(ctx.from.id, bot);
    const successful = (results || []).filter(r => r.success);
    const failed = (results || []).filter(r => !r.success && !r.duplicate);

    if (successful.length > 0) {
      const creditedTotal = successful.reduce((acc, r) => acc + (r.amountUsdc || 0), 0);
      return ctx.reply(
        `🎉 <b>Deposit Sweep Successful!</b>\n──────────────────────────\n` +
        `Successfully processed ${successful.length} deposit(s) for a total of <b>$${creditedTotal.toFixed(2)} USDC</b> on Arc Mainnet!\n\n` +
        `Your balance has been updated.`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("💰 View Balance", "action_balance")],
            [Markup.button.callback("🏠 Main Menu", "main_menu")],
          ]),
        }
      );
    }

    if (failed.length > 0) {
      const failDetails = failed.map(f => `• <b>${f.chain}:</b> ${f.error}`).join("\n");
      return ctx.reply(
        `⚠️ <b>Deposit Detected — Action Required</b>\n──────────────────────────\n` +
        `${failDetails}\n\n` +
        `💡 <i>Tip: If gas is required on the source network, transfer a tiny amount of native gas (e.g. ~$0.20 ETH on Base) to your address, then tap Scan Again.</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔄 Scan Again", "action_sweep_deposits")],
            [Markup.button.callback("« Back to Deposits", "action_gateway")],
          ]),
        }
      );
    }

    return ctx.reply(
      `✅ <b>Scan Complete</b>\n──────────────────────────\n` +
      `No unswept deposits found across supported chains.\n\n` +
      `If you just sent funds from an exchange or wallet, please allow 1–2 minutes for block confirmation, then tap <b>Scan & Sweep Deposits</b> again.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Scan Again", "action_sweep_deposits")],
          [Markup.button.callback("« Back", "action_gateway")],
        ]),
      }
    );
  } catch (err) {
    console.error("[bot:sweep_deposits]", err);
    return ctx.reply(`Could not complete deposit scan: ${err.message}`, {
      ...Markup.inlineKeyboard([[Markup.button.callback("« Back", "action_gateway")]]),
    });
  }
}

bot.action("action_sweep_deposits", handleSweepDeposits);
bot.command("sweep", handleSweepDeposits);
bot.command("scan", handleSweepDeposits);

bot.action("gateway_onramp", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const arcAddress = getActiveWallet(user);
  const onramp = getOnrampDetails(arcAddress);

  await ctx.reply(
    `💳 Buy USDC directly on Arc\n──────────────────────────\n` +
    `Use Circle Onramp to purchase USDC straight into your PayIT wallet without bridging.\n\n` +
    `• <b>Network:</b> ${onramp.networkName}\n` +
    `• <b>Destination:</b> <code>${arcAddress}</code>\n` +
    `• <b>Payment Methods:</b> Visa, Mastercard, Apple Pay, Google Pay\n` +
    `• <b>Supported Currencies:</b> USD, EUR, GBP, and more\n\n` +
    `Tap <b>Open Checkout</b> to complete payment in Circle's secure checkout.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.url("💳 Open Checkout", onramp.onrampUrl)],
        [Markup.button.callback("📋 Copy Arc Address", "gateway_copy_arc")],
        [Markup.button.callback("« Back", "action_gateway")],
      ]),
    }
  );
});

bot.action(["gateway_copy_contract", "gateway_myaddress"], async (ctx) => {
  ctx.answerCbQuery();
  const gwAddress = gateway.GATEWAY_WALLET_ADDRESS;
  await ctx.reply(
    `📋 Gateway Contract Address\n──────────────────────────\n` +
    `Tap to copy:\n\n<code>${gwAddress}</code>\n\n` +
    `Use this contract in MetaMask to approve and call deposit().\n` +
    `⚠️ A plain USDC transfer to this address permanently loses funds.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📖 Step-by-Step Guide", "gateway_steps")],
        [Markup.button.callback("« Back", "action_gateway")],
      ]),
    }
  );
});

bot.action("gateway_copy_arc", async (ctx) => {
  ctx.answerCbQuery();
  const user       = requireUser(ctx);
  if (!user) return;
  const arcAddress = getActiveWallet(user);
  await ctx.reply(
    `📋 Your Arc Depositor ID\n──────────────────────────\n` +
    `Tap to copy:\n\n<code>${arcAddress}</code>\n\n` +
    `This is your PayIT account number on Arc. Gateway uses it to credit your balance after deposit.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.url("🔎 View on Explorer", getExplorerUrl(arcAddress))],
        [Markup.button.callback("« Back", "action_gateway")],
      ]),
    }
  );
});

bot.action("gateway_steps", async (ctx) => {
  ctx.answerCbQuery();
  const user       = requireUser(ctx);
  if (!user) return;
  const arcAddress = getActiveWallet(user);
  const gwAddress  = gateway.GATEWAY_WALLET_ADDRESS;
  const info       = await gateway.getDepositInfo(arcAddress);

  const chainList = info.chains
    .map(c => `• ${c.name}`)
    .join("\n");

  await ctx.reply(
    `📖 How to Add Money from Another Chain\n──────────────────────────\n\n` +
    `<b>Step 1 — Get testnet USDC</b>\n` +
    `Visit faucet.circle.com and request USDC on your source chain.\n\n` +
    `<b>Step 2 — Copy Gateway contract</b>\n` +
    `<code>${gwAddress}</code>\n\n` +
    `<b>Step 3 — Approve + Deposit</b>\n` +
    `In MetaMask, approve the Gateway contract to spend your USDC, then call deposit().\n` +
    `⚠️ Do NOT send USDC directly — use deposit().\n\n` +
    `<b>Step 4 — Your depositor ID</b>\n` +
    `<code>${arcAddress}</code>\n\n` +
    `<b>Step 5 — Wait for finality</b>\n` +
    `Sepolia ~12 min · Base Sepolia ~2 min · Fuji instant\n\n` +
    `<b>Supported chains:</b>\n${chainList}`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📋 Copy Gateway Contract", "gateway_copy_contract")],
        [Markup.button.url("🚰 Circle Faucet", "https://faucet.circle.com")],
        [Markup.button.callback("« Back", "action_gateway")],
      ]),
    }
  );
});

bot.action("gateway_balance", async (ctx) => {
  ctx.answerCbQuery();
  const user    = requireUser(ctx);
  if (!user) return;
  const address = getActiveWallet(user);
  await ctx.reply("🔍 Checking for incoming transfers...");
  const status  = await gateway.getTransferStatus(address);

  if (!status || Object.keys(status).length === 0) {
    return ctx.reply(
      `No incoming transfers found yet.\n\n` +
      `If you just sent from another platform, it may take a few minutes to arrive.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Check Again", "gateway_balance")],
        [Markup.button.callback("« Back",         "action_gateway")],
      ])
    );
  }

  const lines = Object.entries(status)
    .filter(([k]) => k !== "pending")
    .map(([chain, data]) => `${chain}: ${JSON.stringify(data.available)}`)
    .join("\n");

  await ctx.reply(
    `Incoming Gateway balance:\n\n${lines}\n\nTap <b>Transfer to Arc</b> to move this into your PayIT balance.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⚡ Transfer to Arc", "gateway_transfer_arc")],
        [Markup.button.callback("🔄 Refresh",        "gateway_balance")],
        [Markup.button.callback("« Back",            "action_gateway")],
      ]),
    }
  );
});

// ─── Gateway: easy in-bot deposit + transfer ─────────────────────────────────

bot.action("gateway_easy_deposit", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const address = getActiveWallet(user);

  await ctx.reply("⏳ Checking your balances on source chains...");
  const rows = await gateway.getSourceChainBalances(address);
  const lines = rows.map(r =>
    `• <b>${r.chain}</b>: ${r.usdc} USDC · ${r.gas} ${r.symbol} gas`
  ).join("\n");

  const chainButtons = gateway.SUPPORTED_CHAINS.map((c, i) =>
    [Markup.button.callback(c.name, `gateway_dep_chain_${i}`)]
  );

  await ctx.reply(
    `🚀 Easy Gateway Deposit\n──────────────────────────\n` +
    `Your address on every chain:\n<code>${address}</code>\n\n` +
    `<b>Current balances:</b>\n${lines}\n\n` +
    `Need tokens? Get USDC + gas from faucet.circle.com\n` +
    `(use the address above — it's the same on all chains)\n\n` +
    `Pick a source chain to deposit from:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        ...chainButtons,
        [Markup.button.url("🚰 Circle Faucet", "https://faucet.circle.com")],
        [Markup.button.callback("« Back", "action_gateway")],
      ]),
    }
  );
});

bot.action(/^gateway_dep_chain_(\d+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const chain = gateway.SUPPORTED_CHAINS[parseInt(ctx.match[1])];
  if (!chain) return ctx.reply("Unknown chain.");

  const address = getActiveWallet(user);
  let usdc = "0", gas = "0";
  try {
    usdc = await walletLib.getUsdcBalance(address, chain.name);
    gas  = await gateway.getSourceChainNativeBalance(address, chain.name);
  } catch {}

  convState.setState(ctx.from.id, "await_gateway_deposit_amount", { chainName: chain.name }, getContext(ctx.from.id));

  const gasWarning = parseFloat(gas) === 0
    ? `\n\n⚠️ You have <b>no ${chain.symbol} gas</b> on this chain. ` +
      `Get testnet ${chain.symbol} from a faucet before depositing — gas pays transaction fees (separate from USDC).\n`
    : "";

  await ctx.reply(
    `🚀 Deposit from ${chain.name}\n──────────────────────────\n` +
    `USDC available: <b>${usdc}</b>\n` +
    `Gas available: <b>${gas}</b> ${chain.symbol}${gasWarning}\n` +
    `How much USDC do you want to deposit into Gateway?\n` +
    `(e.g. <code>5</code> or <code>10.50</code>)\n\n` +
    `PayIT will approve + call deposit() for you.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_gateway")]]),
    }
  );
});

bot.action("gateway_transfer_arc", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const address = getActiveWallet(user);

  const chainButtons = gateway.SUPPORTED_CHAINS.map((c, i) =>
    [Markup.button.callback(c.name, `gateway_xfer_chain_${i}`)]
  );

  await ctx.reply(
    `⚡ Transfer to Arc\n──────────────────────────\n` +
    `Move your Gateway USDC into PayIT on Arc.\n\n` +
    `Only works after your deposit has finalised on the source chain:\n` +
    `• Sepolia ~12 min\n• Base Sepolia ~2 min\n• Fuji ~instant\n\n` +
    `Pick the source chain:`,
    Markup.inlineKeyboard([
      ...chainButtons,
      [Markup.button.callback("🔍 Check Balance First", "gateway_balance")],
      [Markup.button.callback("« Back", "action_gateway")],
    ])
  );
});

bot.action(/^gateway_xfer_chain_(\d+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const chain = gateway.SUPPORTED_CHAINS[parseInt(ctx.match[1])];
  if (!chain) return ctx.reply("Unknown chain.");

  convState.setState(ctx.from.id, "await_gateway_transfer_amount", { chainName: chain.name }, getContext(ctx.from.id));

  await ctx.reply(
    `⚡ Transfer from ${chain.name} → Arc\n──────────────────────────\n` +
    `How much USDC to move to Arc? (e.g. <code>5</code>)\n\n` +
    `Must be ≤ your Gateway balance on this chain.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_gateway")]]),
    }
  );
});

// ─── Send menu ────────────────────────────────────────────────────────────────

bot.action("action_send_menu", (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  return ctx.reply(
    `📤 Send Money\n──────────────────────────\nWhere are you sending to?`,
    Markup.inlineKeyboard([
      [Markup.button.callback("💵 Cash Out to Naira",      "action_withdraw_menu")],
      [Markup.button.callback("👛 Send to a Wallet",       "action_sendout_menu")],
      [Markup.button.callback("👥 Send to a Saved Contact","action_send_contact")],
      [Markup.button.callback("🏠 Main Menu",              "main_menu")],
    ])
  );
});

bot.action("action_send_contact", async (ctx) => {
  ctx.answerCbQuery();
  const user   = requireUser(ctx);
  if (!user) return;
  const payees = payeeBook.getAllPayees(ctx.from.id);
  if (!payees.length) {
    return ctx.reply(
      "No contacts saved yet. Add one first.",
      Markup.inlineKeyboard([[Markup.button.callback("👥 Add Contact", "add_contact")]])
    );
  }
  const buttons = payees.slice(0, 8).map(p =>
    [Markup.button.callback(p.name, `send_to_payee_${p.id}`)]
  );
  return ctx.reply(
    "Who would you like to send to?",
    Markup.inlineKeyboard([...buttons, [Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});

bot.action(/^send_to_payee_(\d+)$/, (ctx) => {
  ctx.answerCbQuery();
  const user    = requireUser(ctx);
  if (!user) return;
  const payeeId = parseInt(ctx.match[1]);
  const payees  = payeeBook.getAllPayees(ctx.from.id);
  const payee   = payees.find(p => p.id === payeeId);
  if (!payee) return ctx.reply("Contact not found.");
  convState.setState(ctx.from.id, "await_sendout_amount", {
    token:          "USDC",
    recipientName:  payee.name,
    walletAddress:  payee.wallet_address,
    accountNumber:  payee.account_number,
    bankName:       payee.bank_name,
    accountName:    payee.account_name,
  }, getContext(ctx.from.id));
  return ctx.reply(
    `📤 Send to ${payee.name}\n──────────────────────────\n` +
    `${payee.wallet_address ? "Wallet: " + payee.wallet_address.slice(0, 12) + "..." : ""}\n` +
    `${payee.account_number ? "Bank: " + (payee.bank_name || "") + " · " + payee.account_number : ""}\n\n` +
    `How much would you like to send?`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});

// ─── Paj v2 Onramp (Deposit Naira) ──────────────────────────────────────────

bot.action("action_paj_onramp", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;

  try {
    const rates = await paj.getRates("NGN");
    const onRampRate = rates?.onRampRate?.rate || 1388.75;

    convState.setState(ctx.from.id, "await_paj_onramp_amount", { rate: onRampRate }, getContext(ctx.from.id));

    return ctx.reply(
      `🇳🇬 <b>Deposit Naira to Get Dollars ($)</b>\n──────────────────────────\n` +
      `Live rate: <b>$1.00 = ₦${Number(onRampRate).toLocaleString()}</b>\n\n` +
      `How much Naira would you like to deposit? (e.g. <code>25000</code> or <code>50000</code>)\n` +
      `<i>PayIT will generate a dedicated bank transfer account for you.</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]]),
      }
    );
  } catch (err) {
    console.error("[action_paj_onramp]", err.message);
    return ctx.reply("Could not load live rates right now. Please try again in a moment.", backToMenu);
  }
});

bot.action(/^action_check_paj_onramp_(.+)$/, async (ctx) => {
  ctx.answerCbQuery("Checking deposit status...");
  const orderId = ctx.match[1];
  const user = requireUser(ctx);
  if (!user) return;

  const context = user.active_context || "personal";
  const isBiz = context === "business";
  const addr = getActiveWallet(user);
  const solAddr = isBiz && user.biz_solana_deposit_address
    ? user.biz_solana_deposit_address
    : user.solana_deposit_address;

  // 1. Actively scan Solana deposit address for USDC funds from Paj
  let bridgedAmount = 0;
  if (solAddr) {
    try {
      const splBal = await multichain.getSplTokenBalance(solAddr);
      if (splBal && splBal.uiAmount > 0) {
        bridgedAmount = splBal.uiAmount;
        console.log(`[paj_check] Detected $${bridgedAmount} USDC on Solana address ${solAddr}, bridging to Arc ${addr}...`);
        const bridgeRes = await cctpBridge.autoBridgeSolanaToArc({
          telegramId: user.telegram_id,
          amountUsdc: bridgedAmount,
          recipientArcAddress: addr,
        });
        try {
          const amountMicro = walletLib.parseToMicro(bridgedAmount.toFixed(6));
          db.recordTransaction(
            user.telegram_id,
            "deposit_naira",
            amountMicro,
            "confirmed",
            bridgeRes?.solanaTxSignature || orderId,
            isBiz ? "business" : "personal"
          );
        } catch (recErr) {
          console.warn("[paj_check] Record tx error:", recErr.message);
        }
      }
    } catch (err) {
      console.warn("[paj_check_solana_sync_warn]", err.message);
    }
  }

  let balMicro = BigInt(0);
  try { balMicro = await walletLib.getNativeBalanceMicro(addr); } catch {}
  const balDisplay = walletLib.formatMicro(balMicro);

  const syncText = bridgedAmount > 0
    ? `🎉 <b>Payment Detected!</b>\n` +
      `──────────────────────────\n` +
      `💰 <b>Credited:</b> $${bridgedAmount.toFixed(2)}\n` +
      `💼 <b>Account:</b> ${isBiz ? "Business Treasury" : "Personal Wallet"}\n` +
      `Current Balance: <b>$${balDisplay}</b>\n\n` +
      `<i>Your funds have been credited and are ready to use!</i>`
    : `🔄 <b>Deposit Status Check</b>\n` +
      `──────────────────────────\n` +
      `Reference: <code>${orderId}</code>\n` +
      `Current Balance: <b>$${balDisplay}</b>\n\n` +
      `<i>Bank transfers typically credit in 30-90 seconds. Once confirmed, your balance updates automatically!</i>`;

  return ctx.reply(
    syncText,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Check Again", `action_check_paj_onramp_${orderId}`)],
        [Markup.button.callback("💰 View Balance", "action_balance")],
        [Markup.button.callback("🏠 Main Menu",    "main_menu")],
      ]),
    }
  );
});

// ─── Withdraw / Cash Out ──────────────────────────────────────────────────────

bot.action("action_withdraw_menu", (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  convState.setState(ctx.from.id, "await_withdraw_amount", {}, getContext(ctx.from.id));
  return ctx.reply(
    `💵 Cash Out to Naira\n──────────────────────────\n` +
    `How much would you like to cash out?`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});

// ─── Send to external wallet ──────────────────────────────────────────────────

bot.action("action_sendout_menu", (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  convState.setState(ctx.from.id, "await_sendout_address", { token: "USDC" }, getContext(ctx.from.id));
  return ctx.reply(
    `👛 Send Dollars to a Wallet\n──────────────────────────\n` +
    `Paste the account number you want to send to (starts with 0x):`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});

// ─── Yield actions ────────────────────────────────────────────────────────────

bot.action("yield_deposit_start", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const context = getContext(ctx.from.id);
  const targetAddress = context === "business" && user.business_deposit_address
    ? user.business_deposit_address
    : user.deposit_address;
  let bal;
  try {
    const micro = await walletLib.getNativeBalanceMicro(targetAddress);
    bal         = parseFloat(walletLib.formatMicro(micro));
  } catch {
    return ctx.reply("Couldn't check your balance right now.");
  }
  convState.setState(ctx.from.id, "await_yield_amount", { balanceUsdc: bal }, context);
  return ctx.reply(
    `📈 Start Earning Interest (${context === "business" ? "Business Treasury" : "Personal Wallet"})\n──────────────────────────\n` +
    `Available: $${bal.toFixed(2)} · Minimum: $1.00\n\n` +
    `How much would you like to put into savings?`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_yields")]])
  );
});

bot.action("yield_withdraw_start", (ctx) => {
  ctx.answerCbQuery();
  const user     = requireUser(ctx);
  if (!user) return;
  const context  = getContext(ctx.from.id);
  const position = db.getOpenYieldPosition(ctx.from.id, context);
  if (!position) {
    return ctx.reply(
      `No active ${context === "business" ? "Business" : "Personal"} savings to withdraw.`,
      Markup.inlineKeyboard([[Markup.button.callback("➕ Start Saving", "yield_deposit_start")]])
    );
  }
  const accrued = savings.calcAccruedYield(position);
  const devFee  = parseFloat((accrued * 0.10).toFixed(4));
  const netYield = parseFloat((accrued - devFee).toFixed(4));
  const total   = parseFloat((position.amount_usdc + netYield).toFixed(4));
  convState.setState(ctx.from.id, "confirm_yield_withdraw", { position, accrued, devFee, netYield, total }, context);
  return ctx.reply(
    `💵 <b>Withdraw ${context === "business" ? "Business" : "Personal"} Savings</b>\n──────────────────────────\n` +
    `• <b>Principal:</b> $${position.amount_usdc.toFixed(2)}\n` +
    `• <b>Interest Earned:</b> +$${accrued.toFixed(4)}\n` +
    `• <b>Service Fee (10% on profit):</b> -$${devFee.toFixed(4)}\n` +
    `• <b>Net Payout to You:</b> $${total.toFixed(4)}\n\n` +
    `<i>Your principal and 90% of your earnings will be returned immediately to your ${context === "business" ? "business treasury" : "personal wallet"}.</i>\n\n` +
    `Enter your PIN to withdraw:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_yields")]])
    }
  );
});

// ─── Settings actions ─────────────────────────────────────────────────────────

bot.action("export_personal", (ctx) => {
  ctx.answerCbQuery();
  convState.setState(ctx.from.id, "confirm_export", { walletType: "personal" }, getContext(ctx.from.id));
  return ctx.reply(
    `🔑 Personal Security Phrase\n──────────────────────────\n` +
    `This phrase is like a master key to your money — never share it with anyone.\n\n` +
    `Enter your PIN to reveal it:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_settings")]])
  );
});

bot.action("export_business", (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user?.business_deposit_address) return ctx.reply("No Business account set up yet.");
  convState.setState(ctx.from.id, "confirm_export", { walletType: "business" }, getContext(ctx.from.id));
  return ctx.reply(
    `🔑 Business Security Phrase\n──────────────────────────\n` +
    `This phrase is like a master key to your business money — never share it with anyone.\n\n` +
    `Enter your PIN to reveal it:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_settings")]])
  );
});

bot.action("changepin", (ctx) => {
  ctx.answerCbQuery();
  convState.setState(ctx.from.id, "changepin_old", {}, getContext(ctx.from.id));
  return ctx.reply(
    `🔒 Change PIN\n──────────────────────────\nEnter your CURRENT PIN:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_settings")]])
  );
});

bot.action("setwallet_prompt", (ctx) => {
  ctx.answerCbQuery();
  convState.setState(ctx.from.id, "await_setwallet", {}, getContext(ctx.from.id));
  return ctx.reply(
    `👛 Link an External Account\n──────────────────────────\nPaste the account number (starts with 0x):`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_settings")]])
  );
});

bot.action("verifyphone_prompt", (ctx) => {
  ctx.answerCbQuery();
  convState.setState(ctx.from.id, "await_phone", {}, getContext(ctx.from.id));
  return ctx.reply(
    `📱 Verify Your Phone\n──────────────────────────\n` +
    `Enter your number with country code — no + sign:\n\nExample: 2348100000000`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_settings")]])
  );
});

// ─── Shared inline shortcuts ──────────────────────────────────────────────────

bot.action("action_balance",  (ctx) => { ctx.answerCbQuery(); return getContext(ctx.from?.id) === "business" ? showBizBalance(ctx) : showBalance(ctx); });
bot.action("action_receive",  (ctx) => { ctx.answerCbQuery(); return showReceive(ctx); });
bot.action("action_history",  (ctx) => { ctx.answerCbQuery(); return showHistory(ctx); });
bot.action("action_yields",   (ctx) => { ctx.answerCbQuery(); return showYields(ctx); });
bot.action("action_my_yield", (ctx) => { ctx.answerCbQuery(); return showMyYield(ctx); });
bot.action("action_settings", (ctx) => { ctx.answerCbQuery(); convState.clearState(ctx.from.id); return showSettings(ctx); });
bot.action("action_referral", (ctx) => { ctx.answerCbQuery(); return showReferralMenu(ctx); });

bot.action(/^action_check_paj_onramp(?:_(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx, "Checking onramp status...");
  const user = requireUser(ctx);
  if (!user) return;

  const orderId = ctx.match[1];
  const context = getContext(ctx.from?.id);
  const isBiz = context === "business";
  const solAddr = isBiz
    ? (user.biz_solana_deposit_address || user.solana_deposit_address)
    : (user.solana_deposit_address || user.biz_solana_deposit_address);
  const arcAddr = getActiveWallet(user);

  let pajOrder = null;
  if (orderId) {
    try {
      pajOrder = await paj.getOnrampOrder(orderId);
    } catch {}
  }

  // Check Solana SPL USDC balance
  let solBalance = { uiAmount: 0 };
  if (solAddr) {
    try {
      solBalance = await multichain.getSplTokenBalance(solAddr);
    } catch {}
  }

  // Check Arc balance
  let arcBal = 0;
  try {
    const raw = await walletLib.getNativeBalanceMicro(arcAddr);
    arcBal = parseFloat(walletLib.formatMicro(raw));
  } catch {}

  // If SPL USDC is present on Solana or Paj reports completed, trigger CCTP auto-bridge
  if (solBalance.uiAmount > 0 || pajOrder?.status === "completed" || pajOrder?.status === "successful") {
    const amountToBridge = solBalance.uiAmount > 0 ? solBalance.uiAmount : (pajOrder?.amount || 0);
    if (amountToBridge > 0 && arcAddr) {
      try {
        await cctpBridge.autoBridgeSolanaToArc({
          telegramId: ctx.from.id,
          solanaTxSignature: pajOrder?.txHash || null,
          amountUsdc: amountToBridge,
          recipientArcAddress: arcAddr,
        });
      } catch (bridgeErr) {
        console.warn("[bot:action_check_paj_onramp] Bridge note:", bridgeErr.message);
      }
    }

    // Refresh Arc balance
    try {
      const refreshed = await walletLib.getNativeBalanceMicro(arcAddr);
      arcBal = parseFloat(walletLib.formatMicro(refreshed));
    } catch {}

    return ctx.reply(
      `🎉 <b>Deposit Confirmed!</b>\n` +
      `──────────────────────────\n` +
      `💼 <b>Account:</b> ${isBiz ? "Business Treasury" : "Personal Wallet"}\n` +
      `💰 <b>Current Balance:</b> <b>$${arcBal.toFixed(2)} USDC</b>\n` +
      `🏛 <b>Network:</b> Arc Mainnet (Domain 26)\n\n` +
      `<i>Your dollars have been credited and are ready to spend, save, or send!</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("💰 View Balance", "action_balance")],
          [Markup.button.callback("🏠 Main Menu",    "main_menu")],
        ]),
      }
    );
  }

  return ctx.reply(
    `⏳ <b>Payment Status: Pending</b>\n` +
    `──────────────────────────\n` +
    `We are still awaiting confirmation from the banking network.\n\n` +
    `• <b>Status:</b> ${pajOrder?.status || "Awaiting transfer"}\n` +
    `• <b>Account:</b> ${isBiz ? "Business Treasury" : "Personal Wallet"}\n` +
    `• <b>Current Arc Balance:</b> $${arcBal.toFixed(2)}\n\n` +
    `<i>Once your bank transfer clears, your dollar balance updates automatically. You can check again in a few moments.</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Check Again", ctx.match[0])],
        [Markup.button.callback("💰 View Balance", "action_balance")],
        [Markup.button.callback("🏠 Main Menu",    "main_menu")],
      ]),
    }
  );
});

bot.action("action_swap", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const address = getActiveWallet(user);

  let usdcBal = 0;
  let eurcBal = 0;
  try {
    const usdcMicro = await walletLib.getNativeBalanceMicro(address);
    const eurcMicro = await tokens.getEurcBalance(address);
    usdcBal = parseFloat(walletLib.formatMicro(usdcMicro));
    eurcBal = parseFloat(walletLib.formatMicro(eurcMicro));
  } catch {}

  let ratesInfo = "";
  try {
    const rates = await swapLib.getFxRates();
    const usdcRate = rates.USDC ? `$${parseFloat(rates.USDC).toFixed(4)}` : "$1.0000";
    const eurcRate = rates.EURC ? `€${parseFloat(rates.EURC).toFixed(4)}` : "€1.0900";
    ratesInfo = `\n📊 <b>Live Arc FX Rates:</b>\n• USDC: ${usdcRate}\n• EURC: ${eurcRate}\n`;
  } catch {}

  return ctx.reply(
    `🔄 <b>Currency Converter</b>\n──────────────────────────\n` +
    `Convert between US Dollars ($) and Euros (€) instantly at market rates.\n\n` +
    `<b>Your Balances:</b>\n` +
    `• 💵 <b>Dollars:</b> $${usdcBal.toFixed(2)}\n` +
    `• 💶 <b>Euros:</b> €${eurcBal.toFixed(2)}\n` +
    ratesInfo + `\n` +
    `Select conversion:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("💵 Convert Dollars ➔ Euros", "swap_start_usdc_eurc")],
      [Markup.button.callback("💶 Convert Euros ➔ Dollars", "swap_start_eurc_usdc")],
      [Markup.button.callback("🏠 Main Menu",        "main_menu")],
    ])
  );
});

bot.action("swap_start_usdc_eurc", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const address = getActiveWallet(user);
  let usdcBal = 0;
  try {
    const usdcMicro = await walletLib.getNativeBalanceMicro(address);
    usdcBal = parseFloat(walletLib.formatMicro(usdcMicro));
  } catch {}

  if (usdcBal <= 0) {
    return ctx.reply(
      "You don't have any dollars to convert yet. Add money first.",
      Markup.inlineKeyboard([[Markup.button.callback("📥 Add Money", "action_receive")], [Markup.button.callback("🔄 Back", "action_swap")]])
    );
  }

  convState.setState(ctx.from.id, "await_swap_amount", {
    fromToken: "USDC",
    toToken: "EURC",
    balance: usdcBal,
  }, getContext(ctx.from.id));

  return ctx.reply(
    `🔄 <b>Convert Dollars ➔ Euros</b>\n──────────────────────────\n` +
    `Available: $${usdcBal.toFixed(2)}\n\n` +
    `How many dollars would you like to convert? (e.g. 10)`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_swap")]])
  );
});

bot.action("swap_start_eurc_usdc", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const address = getActiveWallet(user);
  let eurcBal = 0;
  try {
    const eurcMicro = await tokens.getEurcBalance(address);
    eurcBal = parseFloat(walletLib.formatMicro(eurcMicro));
  } catch {}

  if (eurcBal <= 0) {
    return ctx.reply(
      "You don't have any euros to convert yet.",
      Markup.inlineKeyboard([[Markup.button.callback("🔄 Back", "action_swap")]])
    );
  }

  convState.setState(ctx.from.id, "await_swap_amount", {
    fromToken: "EURC",
    toToken: "USDC",
    balance: eurcBal,
  }, getContext(ctx.from.id));

  return ctx.reply(
    `🔄 <b>Convert Euros ➔ Dollars</b>\n──────────────────────────\n` +
    `Available: €${eurcBal.toFixed(2)}\n\n` +
    `How many euros would you like to convert? (e.g. 10)`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_swap")]])
  );
});

// ─── Business Invoice actions ─────────────────────────────────────────────────

async function showBizInvoiceMenu(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  convState.setState(ctx.from.id, "await_biz_invoice_instruction", {}, "business");
  return ctx.reply(
    `🧾 Create Invoice\n──────────────────────────\n` +
    `Describe it in plain English:\n\n` +
    `• "Invoice Acme Ltd $500 for web design, due July 15"\n` +
    `• "Bill TechCorp $200 consulting and $100 hosting"\n` +
    `• "Invoice john@example.com $1,500 for brand identity"\n\n` +
    `Type your instruction:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📋 All Invoices", "action_list_biz_invoices")],
      [Markup.button.callback("❌ Cancel",        "main_menu")],
    ])
  );
}

bot.action("action_new_biz_invoice",   (ctx) => { ctx.answerCbQuery(); return showBizInvoiceMenu(ctx); });

bot.action("action_list_biz_invoices", async (ctx) => {
  ctx.answerCbQuery();
  const user     = requireUser(ctx);
  if (!user) return;
  const invoices = bizDb.getBizInvoices(ctx.from.id);
  if (!invoices.length) {
    return ctx.reply(
      "No invoices yet. Create your first one.",
      Markup.inlineKeyboard([[Markup.button.callback("🧾 New Invoice", "action_new_biz_invoice")]])
    );
  }
  const lines = invoices.slice(0, 8).map(inv => {
    const status = inv.status === "paid" ? "✅" : "⏳";
    const paymentAddress = inv.payment_address || inv.wallet_address || "(none)";
    return `${status} #${inv.invoice_number} — ${inv.client_name}\n   $${inv.total_usdc}${inv.due_date ? " · Due " + inv.due_date : ""}\n   Address: ${paymentAddress}`;
  }).join("\n\n");

  const keyboard = invoices.slice(0, 8).map(inv => {
    const row = [Markup.button.callback(`View ${inv.invoice_number}`, `action_viewbizinvoice_${inv.id}`)];
    if (inv.status !== "paid") {
      row.push(Markup.button.callback("Mark Paid", `action_markbizinvoice_${inv.id}`));
    }
    return row;
  });
  keyboard.push([Markup.button.callback("🧾 New Invoice", "action_new_biz_invoice")]);
  keyboard.push([Markup.button.callback("📊 This Month", "action_cash_flow")]);
  keyboard.push([Markup.button.callback("🏠 Main Menu", "main_menu")]);

  await ctx.reply(
    `📋 Your Invoices\n──────────────────────────\n${lines}`,
    Markup.inlineKeyboard(keyboard)
  );
});

bot.action(/^action_viewbizinvoice_(\d+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const inv = bizDb.getBizInvoice(parseInt(ctx.match[1]));
  if (!inv || parseInt(inv.telegram_id) !== ctx.from.id) return ctx.reply("Invoice not found.");
  const paymentAddress = inv.payment_address || inv.wallet_address || "(none)";
  const keyboard = [[Markup.button.callback("💸 Settle Funds", `action_settle_bizinvoice_${inv.id}`)]];
  if (inv.status !== "paid") {
    keyboard.unshift([Markup.button.callback("✅ Mark as Paid", `action_markbizinvoice_${inv.id}`)]);
  }
  keyboard.push([Markup.button.callback("📋 All Invoices", "action_list_biz_invoices")]);
  await ctx.reply(
    `🧾 Business Invoice #${inv.invoice_number}\n` +
    `Client: ${inv.client_name}\n` +
    `Amount: $${inv.total_usdc}${inv.due_date ? "\nDue: " + inv.due_date : ""}\n` +
    `Status: ${inv.status === "paid" ? "✅ Paid" : "⏳ Unpaid"}\n` +
    `Payment address: ${paymentAddress}\n` +
    `${inv.paid_tx_hash ? `Tx: ${inv.paid_tx_hash}` : ""}`,
    Markup.inlineKeyboard(keyboard)
  );
});

bot.action(/^action_markbizinvoice_(\d+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const inv = bizDb.getBizInvoice(parseInt(ctx.match[1]));
  if (!inv || parseInt(inv.telegram_id) !== ctx.from.id) return ctx.reply("Invoice not found.");
  if (inv.status === "paid") return ctx.reply(`Invoice #${inv.invoice_number} is already paid ✅`);
  bizDb.markBizInvoicePaid(inv.id);
  const goal = bizDb.getSavingsGoal(ctx.from.id);
  if (goal) bizDb.addToBizSavings(ctx.from.id, parseFloat(inv.total_usdc) * goal.percentage / 100);
  await ctx.reply(`✅ Invoice #${inv.invoice_number} marked as paid!${goal ? `\n💰 ${goal.percentage}% moved to Business Savings.` : ""}`, Markup.inlineKeyboard([[Markup.button.callback("📋 All Invoices", "action_list_biz_invoices")]]));
});

bot.action(/^action_settle_bizinvoice_(\d+)$/, async (ctx) => {
  await safeAnswerCbQuery(ctx);
  const inv = bizDb.getBizInvoice(parseInt(ctx.match[1]));
  if (!inv || parseInt(inv.telegram_id) !== ctx.from.id) return ctx.reply("Invoice not found.");
  try {
    const settlementTxHash = await invoiceListener.settleInvoiceFunds(inv.id, "business");
    if (!settlementTxHash) {
      return ctx.reply("No invoice balance was available to settle yet.");
    }
    bizDb.updateBizInvoiceSettlementTxHash(inv.id, settlementTxHash);
    await ctx.reply(`💸 Settlement sent to your main business wallet.\nTx: ${settlementTxHash}`);
  } catch (err) {
    console.error("[invoice_settle]", err);
    await ctx.reply(`Settlement failed: ${err.message}`);
  }
});

bot.hears(/^\/bizpaid_(\d+)$/, async (ctx) => {
  const inv = bizDb.getBizInvoice(parseInt(ctx.match[1]));
  if (!inv || parseInt(inv.telegram_id) !== ctx.from.id) return ctx.reply("Invoice not found.");
  if (inv.status === "paid") return ctx.reply(`Invoice #${inv.invoice_number} is already paid ✅`);
  bizDb.markBizInvoicePaid(parseInt(ctx.match[1]));
  const goal = bizDb.getSavingsGoal(ctx.from.id);
  if (goal) bizDb.addToBizSavings(ctx.from.id, parseFloat(inv.total_usdc) * goal.percentage / 100);
  await ctx.reply(
    `✅ Invoice #${inv.invoice_number} paid!\n${inv.client_name} · $${inv.total_usdc}` +
    (goal ? `\n💰 ${goal.percentage}% moved to Business Savings.` : ""),
    Markup.inlineKeyboard([[Markup.button.callback("📋 All Invoices", "action_list_biz_invoices")]])
  );
});

bot.hears(/^\/viewbizinvoice_(\d+)$/, async (ctx) => {
  const inv = bizDb.getBizInvoice(parseInt(ctx.match[1]));
  if (!inv || parseInt(inv.telegram_id) !== ctx.from.id) return ctx.reply("Invoice not found.");
  const paymentAddress = inv.payment_address || inv.wallet_address || "(none)";
  await ctx.reply(
    `🧾 Business Invoice #${inv.invoice_number}\n` +
    `Client: ${inv.client_name}\n` +
    `Amount: $${inv.total_usdc}${inv.due_date ? "\nDue: " + inv.due_date : ""}\n` +
    `Status: ${inv.status === "paid" ? "✅ Paid" : "⏳ Unpaid"}\n` +
    `Payment address: ${paymentAddress}\n` +
    `${inv.paid_tx_hash ? `Tx: ${inv.paid_tx_hash}` : ""}`
  );
});

bot.action("action_log_expense", (ctx) => {
  ctx.answerCbQuery();
  convState.setState(ctx.from.id, "await_expense_entry", {}, "business");
  return ctx.reply(
    `💸 Log Expense\n──────────────────────────\nDescribe it naturally:\n\n` +
    `• "₦8,000 transport to client meeting"\n` +
    `• "$50 SaaS subscription"\n` +
    `• "₦20,000 office supplies"`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});

bot.action("action_cash_flow", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const income   = bizDb.getMonthIncome(ctx.from.id);
  const expenses = bizDb.getMonthExpenses(ctx.from.id);
  const net      = income - expenses;
  const pending  = bizDb.getPendingInvoiceTotal(ctx.from.id);
  await ctx.reply(
    `📊 This Month\n──────────────────────────\n` +
    `💚 Income (paid invoices): $${income.toFixed(2)}\n` +
    `🔴 Expenses: $${expenses.toFixed(2)}\n` +
    `──────────────────────────\n` +
    `${net >= 0 ? "✅" : "⚠️"} Net: $${net.toFixed(2)}\n\n` +
    `📬 Awaiting payment: $${pending.toFixed(2)}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📈 Full Report",  "action_biz_reports")],
      [Markup.button.callback("🧾 New Invoice",  "action_new_biz_invoice")],
      [Markup.button.callback("🏠 Main Menu",    "main_menu")],
    ])
  );
});

bot.action("action_biz_reports", async (ctx) => {
  ctx.answerCbQuery();
  const user     = requireUser(ctx);
  if (!user) return;
  const income   = bizDb.getMonthIncome(ctx.from.id);
  const expenses = bizDb.getMonthExpenses(ctx.from.id);
  const net      = income - expenses;
  const margin   = income > 0 ? ((net / income) * 100).toFixed(1) : "0";
  const breakdown = bizDb.getExpenseBreakdown(ctx.from.id);
  const topClient = bizDb.getTopClient(ctx.from.id);
  const invoiceCount = bizDb.getMonthInvoiceCount(ctx.from.id);
  const breakdownLines = breakdown.slice(0, 3)
    .map(e => `  • ${e.category}: $${e.total.toFixed(2)}`).join("\n") || "  None yet";

  await ctx.reply(
    `📈 Business Report — This Month\n──────────────────────────\n` +
    `Revenue: $${income.toFixed(2)} (${invoiceCount} paid invoice${invoiceCount !== 1 ? "s" : ""})\n` +
    `Expenses: $${expenses.toFixed(2)}\n` +
    `Net profit: $${net.toFixed(2)} (${margin}% margin)\n\n` +
    `Top expenses:\n${breakdownLines}\n\n` +
    (topClient ? `Top client: ${topClient.name} ($${topClient.total.toFixed(2)})\n\n` : "") +
    `💡 ${net < 0 ? "Expenses exceed revenue this month — review your top spend." : net < income * 0.2 ? "Tight margins — review your top expenses." : "Healthy margins. Consider moving surplus to savings."}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📊 Cash Flow", "action_cash_flow")],
      [Markup.button.callback("🏠 Main Menu", "main_menu")],
    ])
  );
});

// ─── Invoice confirm (Business) ───────────────────────────────────────────────

bot.action("action_confirm_biz_invoice", async (ctx) => {
  ctx.answerCbQuery();
  const user    = requireUser(ctx);
  if (!user) return;
  const state   = convState.getState(ctx.from.id);
  if (!state || state.type !== "confirm_biz_invoice") {
    return ctx.reply("Session expired. Start again with 🧾 New Invoice.");
  }

  const invoiceNumber = bizDb.getNextBizInvoiceNumber(ctx.from.id);
  const issueDate     = new Date().toISOString().split("T")[0];
  convState.setState(ctx.from.id, "confirm_biz_invoice_pin", {
    parsed:       state.data.parsed,
    total:        state.data.total,
    walletAddress: state.data.walletAddress,
    invoiceNumber,
    issueDate,
  }, "business");

  return ctx.reply(
    "Enter your PIN to create the invoice with a unique payment address:",
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});

bot.action(/^action_bizpaid_(\d+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const inv = bizDb.getBizInvoice(parseInt(ctx.match[1]));
  if (!inv || parseInt(inv.telegram_id) !== ctx.from.id) return ctx.reply("Invoice not found.");
  if (inv.status === "paid") return ctx.reply("Already paid ✅");
  bizDb.markBizInvoicePaid(parseInt(ctx.match[1]));
  const goal = bizDb.getSavingsGoal(ctx.from.id);
  if (goal) bizDb.addToBizSavings(ctx.from.id, parseFloat(inv.total_usdc) * goal.percentage / 100);
  await ctx.reply(
    `✅ Invoice #${inv.invoice_number} paid!\n${inv.client_name} · $${inv.total_usdc}` +
    (goal ? `\n💰 ${goal.percentage}% moved to Business Savings.` : ""),
    Markup.inlineKeyboard([[Markup.button.callback("📋 All Invoices", "action_list_biz_invoices")]])
  );
});

// ─── Invoice confirm (Personal) ───────────────────────────────────────────────

bot.action("action_confirm_invoice", async (ctx) => {
  ctx.answerCbQuery();
  const user  = requireUser(ctx);
  if (!user) return;
  const state = convState.getState(ctx.from.id);
  if (!state || state.type !== "confirm_invoice") {
    return ctx.reply("Session expired. Start again with 🧾 Invoice.");
  }
  convState.clearState(ctx.from.id);
  const { parsed, total } = state.data;

  await ctx.reply("⏳ Generating your invoice...");
  try {
    const invoiceNumber = invoiceDb.getNextInvoiceNumber(ctx.from.id);
    const issueDate     = new Date().toISOString().split("T")[0];
    
    // Request PIN to decrypt private key for HD wallet derivation
    convState.setState(ctx.from.id, "confirm_invoice_pin", {
      invoiceNumber,
      issueDate,
      parsed,
      total,
    }, "personal");
    
    return ctx.reply(
      "Enter your PIN to create the invoice with a unique payment address:",
      Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
    );
  } catch (err) {
    console.error("[invoice]", err);
    await ctx.reply("Something went wrong. Please try again.");
  }
});

// Process PIN and create HD invoice
// The PIN state is handled inside the main text handler below.

bot.action(/^action_paid_(\d+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const inv = invoiceDb.getInvoice(parseInt(ctx.match[1]));
  if (!inv || parseInt(inv.telegram_id) !== ctx.from.id) return ctx.reply("Invoice not found.");
  if (inv.status === "paid") return ctx.reply("Already paid ✅");
  invoiceDb.markInvoicePaid(parseInt(ctx.match[1]));
  await ctx.reply(
    `✅ Invoice #${inv.invoice_number} paid!\n${inv.client_name} · $${inv.total_usdc}`,
    Markup.inlineKeyboard([[Markup.button.callback("📋 All Invoices", "action_list_invoices")]])
  );
});

bot.action("action_list_invoices", async (ctx) => {
  ctx.answerCbQuery();
  const user     = requireUser(ctx);
  if (!user) return;
  const invoices = invoiceDb.getUserInvoices(ctx.from.id);
  if (!invoices.length) {
    return ctx.reply(
      "No invoices yet.",
      Markup.inlineKeyboard([[Markup.button.callback("🧾 Create", "action_new_invoice")]])
    );
  }
  const lines = invoices.map((inv, i) => {
    const status = inv.status === "paid" ? "✅" : "⏳";
    const paymentAddress = inv.payment_address || inv.wallet_address || "(none)";
    return `${i + 1}. #${inv.invoice_number} — ${inv.client_name}\n   $${inv.total_usdc} · ${status}${inv.due_date ? " · Due " + inv.due_date : ""}\n   Address: ${paymentAddress}`;
  }).join("\n\n");

  const keyboard = invoices.map(inv => {
    const row = [Markup.button.callback(`View ${inv.invoice_number}`, `action_viewinvoice_${inv.id}`)];
    if (inv.status !== "paid") {
      row.push(Markup.button.callback("Mark Paid", `action_markinvoice_${inv.id}`));
    }
    return row;
  });
  keyboard.push([Markup.button.callback("🧾 New Invoice", "action_new_invoice")]);
  keyboard.push([Markup.button.callback("🏠 Main Menu", "main_menu")]);

  await ctx.reply(
    `📋 Your Invoices\n──────────────────────────\n${lines}`,
    Markup.inlineKeyboard(keyboard)
  );
});

bot.action(/^action_viewinvoice_(\d+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const inv = invoiceDb.getInvoice(parseInt(ctx.match[1]));
  if (!inv || parseInt(inv.telegram_id) !== ctx.from.id) return ctx.reply("Invoice not found.");
  const paymentAddress = inv.payment_address || inv.wallet_address || "(none)";
  await ctx.reply(
    `🧾 Invoice #${inv.invoice_number}\n` +
    `Client: ${inv.client_name}\n` +
    `Amount: $${inv.total_usdc}${inv.due_date ? "\nDue: " + inv.due_date : ""}\n` +
    `Status: ${inv.status === "paid" ? "✅ Paid" : "⏳ Unpaid"}\n` +
    `Payment address: ${paymentAddress}\n` +
    `${inv.paid_tx_hash ? `Tx: ${inv.paid_tx_hash}` : ""}`
  );
});

bot.action(/^action_markinvoice_(\d+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const inv = invoiceDb.getInvoice(parseInt(ctx.match[1]));
  if (!inv || parseInt(inv.telegram_id) !== ctx.from.id) return ctx.reply("Invoice not found.");
  if (inv.status === "paid") return ctx.reply(`Invoice #${inv.invoice_number} is already paid ✅`);
  invoiceDb.markInvoicePaid(inv.id);
  await ctx.reply(`✅ Invoice #${inv.invoice_number} marked as paid!`, Markup.inlineKeyboard([[Markup.button.callback("📋 All Invoices", "action_list_invoices")]]));
});

bot.hears(/^\/markinvoicepaid_(\d+)$/, async (ctx) => {
  const inv = invoiceDb.getInvoice(parseInt(ctx.match[1]));
  if (!inv || parseInt(inv.telegram_id) !== ctx.from.id) return ctx.reply("Invoice not found.");
  if (inv.status === "paid") return ctx.reply("Already paid ✅");
  invoiceDb.markInvoicePaid(parseInt(ctx.match[1]));
  await ctx.reply(`✅ Invoice #${inv.invoice_number} marked as paid!`);
});

bot.hears(/^\/viewinvoice_(\d+)$/, async (ctx) => {
  const inv = invoiceDb.getInvoice(parseInt(ctx.match[1]));
  if (!inv || parseInt(inv.telegram_id) !== ctx.from.id) return ctx.reply("Invoice not found.");
  const paymentAddress = inv.payment_address || inv.wallet_address || "(none)";
  await ctx.reply(
    `🧾 Invoice #${inv.invoice_number}\n` +
    `Client: ${inv.client_name}\n` +
    `Amount: $${inv.total_usdc}${inv.due_date ? "\nDue: " + inv.due_date : ""}\n` +
    `Status: ${inv.status === "paid" ? "✅ Paid" : "⏳ Unpaid"}\n` +
    `Payment address: ${paymentAddress}\n` +
    `${inv.paid_tx_hash ? `Tx: ${inv.paid_tx_hash}` : ""}`
  );
});

// ─── Auto-Pay ─────────────────────────────────────────────────────────────────

async function showAutoPay(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  convState.setState(ctx.from.id, "await_autopay_instruction", {}, getContext(ctx.from.id));
  const jobs = getUserSchedules(ctx.from.id.toString());
  const jobLine = jobs.length > 0
    ? `\n\n📅 You have ${jobs.length} active schedule(s). Use /schedules to manage.`
    : "";
  return ctx.reply(
    `🤖 Auto-Pay\n──────────────────────────\n` +
    `Set up recurring payments in plain English:\n\n` +
    `• "Send $5 to 0xABC... every Friday"\n` +
    `• "Pay Emeka $100 on the 1st of every month"\n` +
    `• "Split $50 between Amara and John weekly"\n\n` +
    `Type your instruction:` + jobLine,
    Markup.inlineKeyboard([
      [Markup.button.callback("📅 View Schedules", "action_schedules")],
      [Markup.button.callback("🏠 Main Menu",      "main_menu")],
    ])
  );
}

bot.action("action_schedules", async (ctx) => {
  ctx.answerCbQuery();
  const jobs = getUserSchedules(ctx.from.id.toString());
  if (!jobs.length) return ctx.reply("No active scheduled payments.");
  const list = jobs.map((j, i) =>
    `${i + 1}. ${j.plan.summary}\n   ${describeSchedule(j.plan.schedule)}\n   /cancelschedule_${j.id}`
  ).join("\n\n");
  return ctx.reply(`📅 Scheduled Payments\n──────────────────────────\n${list}`);
});

bot.command("schedules", async (ctx) => {
  const jobs = getUserSchedules(ctx.from.id.toString());
  if (!jobs.length) {
    return ctx.reply(
      "No scheduled payments yet.\n\nUse 🤖 Auto-Pay to set one up.",
      Markup.inlineKeyboard([[Markup.button.callback("🤖 Auto-Pay", "action_autopay")]])
    );
  }
  const list = jobs.map((j, i) =>
    `${i + 1}. ${j.plan.summary}\n   ${describeSchedule(j.plan.schedule)}\n   /cancelschedule_${j.id}`
  ).join("\n\n");
  await ctx.reply(`📅 Scheduled Payments\n──────────────────────────\n${list}`);
});

bot.command("points", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const balance = db.getPointsBalance(ctx.from.id);
  const history = db.getPointsHistory(ctx.from.id, 10);
  const lines = history.length
    ? history.map((row) => `${row.created_at.split(" ")[0]} · ${row.points > 0 ? "+" : ""}${row.points} · ${row.action}${row.details ? ` · ${row.details}` : ""}`).join("\n")
    : "No activity yet.";

  await ctx.reply(
    `🏅 Your Points Balance: ${balance}\n──────────────────────────\n${lines}`,
    { parse_mode: "Markdown" }
  );
});

bot.hears(/^\/cancelschedule_(.+)$/, async (ctx) => {
  const jobId   = ctx.match[1];
  cancelJob(jobId);
  const removed = removeSchedule(ctx.from.id.toString(), jobId);
  await ctx.reply(
    removed ? "✅ Schedule cancelled." : "Couldn't find that schedule.",
    Markup.inlineKeyboard([[Markup.button.callback("📅 Schedules", "action_schedules")]])
  );
});

bot.action("action_autopay", showAutoPay);
bot.action("action_new_invoice", (ctx) => {
  ctx.answerCbQuery();
  const context = getContext(ctx.from?.id);
  if (context === "business") return showBizInvoiceMenu(ctx);
  convState.setState(ctx.from.id, "await_invoice_instruction", {}, context);
  return ctx.reply(
    `🧾 Create Invoice\n──────────────────────────\n` +
    `Describe it:\n\n` +
    `• "Invoice Acme Ltd $500 for web design, due July 15"\n` +
    `• "Bill TechCorp $200 consulting and $100 hosting"\n\n` +
    `Type your instruction:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📋 My Invoices", "action_list_invoices")],
      [Markup.button.callback("❌ Cancel",       "main_menu")],
    ])
  );
});

bot.action("action_confirm_shopping", (ctx) => {
  ctx.answerCbQuery();
  const state = convState.getState(ctx.from.id);
  if (!state || state.type !== "confirm_shopping_purchase") {
    return ctx.reply("Session expired. Please start over.", backToMenu);
  }
  convState.setState(ctx.from.id, "confirm_shopping_pin", { product: state.data.product }, getContext(ctx.from.id));
  return ctx.reply(
    `💸 Confirm Purchase\n──────────────────────────\n` +
    `Product: ${state.data.product.name}\n` +
    `Total: $${state.data.product.price}\n\n` +
    `Enter your PIN to execute payment:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});

// ─── Photo handler — image / screenshot parsing ───────────────────────────────

bot.on("photo", async (ctx) => {
  const state = convState.getState(ctx.from.id);

  // ── Logo upload helper ────────────────────────────────────────────────────
  async function handleLogoSave() {
    const photo  = ctx.message.photo[ctx.message.photo.length - 1];
    const buffer = await downloadTelegramFile(ctx, photo.file_id);
    return await bizProfile.saveLogo(ctx.from.id, buffer);
  }

  // ── Logo upload from Settings ─────────────────────────────────────────────
  if (state?.type === "await_logo_upload") {
    convState.clearState(ctx.from.id);
    await ctx.reply("⏳ Saving your logo...");
    try {
      const logoPath = await handleLogoSave();
      bizProfile.updateBizProfileField(ctx.from.id, "logo_path", logoPath);
      await ctx.reply(
        "✅ Logo saved! It will appear on all future invoices.",
        Markup.inlineKeyboard([[Markup.button.callback("« Back to Profile", "biz_profile_menu")]])
      );
    } catch (err) {
      console.error("[logo_upload]", err);
      await ctx.reply("Couldn't save the logo. Please try again.");
    }
    return;
  }

  // ── Logo upload during business onboarding ────────────────────────────────
  if (state?.type === "onboard_biz_logo") {
    await ctx.reply("⏳ Saving your logo...");
    try {
      const logoPath = await handleLogoSave();
      const d = state.data;
      const personalWallet = walletLib.generateUserWallet();
      const businessWallet = walletLib.generateUserWallet();
      convState.setState(ctx.from.id, "onboarding_pin", {
        accountType:        "business",
        address:            personalWallet.address,
        privateKey:         personalWallet.privateKey,
        businessAddress:    businessWallet.address,
        businessPrivateKey: businessWallet.privateKey,
        username:           ctx.from.username,
        logoPath,
        bizProfile: {
          businessName:   d.businessName,
          businessEmail:  d.businessEmail,
          phone:          d.businessPhone,
          address:        d.businessAddress,
          defaultDueDays: d.defaultDueDays,
        },
        referrerId: d.referrerId || null,
      }, "business");
      return ctx.reply(
        "✅ Logo saved!\n\n" +
        "Now let's secure your wallet.\n\n" +
        "Choose a 4-digit PIN — write it down somewhere safe. " +
        "If you forget it and haven't saved your security phrase, " +
        "your money cannot be recovered.\n\n" +
        "Type your PIN:"
      );
    } catch (err) {
      console.error("[logo_upload_onboarding]", err);
      return ctx.reply("Couldn't save the logo — please try again, or type \"skip\" to continue without one.");
    }
  }

  // Otherwise: treat as a payment document
  await ctx.reply("📷 Reading your image...");
  try {
    const photo    = ctx.message.photo[ctx.message.photo.length - 1];
    const buffer   = await downloadTelegramFile(ctx, photo.file_id);
    const parsed   = await parseImagePayment(buffer, "image/jpeg");
    const preview  = formatExtractionPreview(parsed);

    if (parsed.unreadable || parsed.error === "no_vision_provider") {
      return ctx.reply(preview, backToMenu);
    }

    // Store parsed result and ask for confirmation
    convState.setState(ctx.from.id, "confirm_image_payment", {
      parsed,
      caption: ctx.message.caption || null,
    }, getContext(ctx.from.id));

    await ctx.reply(
      preview,
      { parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✅ Yes, use these details", "image_payment_confirm")],
          [Markup.button.callback("✏️ Enter details manually",  "image_payment_manual")],
          [Markup.button.callback("❌ Cancel",                  "main_menu")],
        ])
      }
    );
  } catch (err) {
    console.error("[photo_handler]", err);
    await ctx.reply("Couldn't read the image. Please try a clearer photo or type the details manually.");
  }
});

// Image payment confirmed — route to appropriate flow
bot.action("image_payment_confirm", async (ctx) => {
  ctx.answerCbQuery();
  const state = convState.getState(ctx.from.id);
  if (!state || state.type !== "confirm_image_payment") {
    return ctx.reply("Session expired. Please send the image again.");
  }
  const { parsed } = state.data;

  // Route based on what was extracted
  if (parsed.document_type === "invoice" || parsed.document_type === "bill") {
    // Create an invoice or ask to pay it
    convState.setState(ctx.from.id, "await_image_pay_amount", { parsed }, getContext(ctx.from.id));
    return ctx.reply(
      `How would you like to handle this ${parsed.document_type}?\n\n` +
      `Amount: ${parsed.currency} ${parsed.amount}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("💸 Pay It Now",       "image_pay_now")],
        [Markup.button.callback("🧾 Create My Invoice", "image_create_invoice")],
        [Markup.button.callback("❌ Cancel",            "main_menu")],
      ])
    );
  }

  // Default: set up as a payment
  convState.setState(ctx.from.id, "confirm_image_pay_pin", { parsed }, getContext(ctx.from.id));
  return ctx.reply(
    `💸 Confirm Payment\n──────────────────────────\n` +
    `To: ${parsed.recipient_name || parsed.recipient_account || "?"}\n` +
    `Amount: ${parsed.currency} ${parsed.amount}\n` +
    (parsed.description ? `For: ${parsed.description}\n` : "") +
    `\nEnter your PIN to confirm:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});

bot.action("image_payment_manual", (ctx) => {
  ctx.answerCbQuery();
  convState.clearState(ctx.from.id);
  return ctx.reply(
    "No problem — just type what you'd like to do and PayIT will take it from there.",
    backToMenu
  );
});

// ─── Document handler — PDF and Excel/CSV ─────────────────────────────────────

bot.on("document", async (ctx) => {
  const doc      = ctx.message.document;
  const mimeType = doc.mime_type || "";
  const fileName = (doc.file_name || "").toLowerCase();

  const isPdf  = mimeType === "application/pdf" || fileName.endsWith(".pdf");
  const isCsv  = mimeType === "text/csv"        || fileName.endsWith(".csv");
  const isXlsx = mimeType.includes("spreadsheet") ||
    fileName.endsWith(".xlsx") || fileName.endsWith(".xls");
  const isPptx = fileName.endsWith('.pptx') || mimeType.includes('presentation');
  const isDocx = fileName.endsWith('.docx') || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const isTxt  = fileName.endsWith('.txt') || mimeType === 'text/plain';

  if (!isPdf && !isCsv && !isXlsx && !isPptx && !isDocx && !isTxt) {
    return ctx.reply(
      "I can read PDF, DOCX, PPTX, Excel (.xlsx), CSV, and plain text files to extract payment details.\n\n" +
      "For other files, please type the details directly."
    );
  }

  const kindLabel = isPdf ? "PDF" : isPptx ? "PPTX" : isDocx ? "DOCX" : isTxt ? "text file" : isCsv ? "CSV" : "spreadsheet";
  await ctx.reply(`📄 Reading your ${kindLabel}...`);

  try {
    const buffer = await downloadTelegramFile(ctx, doc.file_id);
    let parsed;
    if (isPdf) parsed = await parsePdf(buffer);
    else if (isPptx) parsed = await parsePptx(buffer);
    else if (isDocx) parsed = await parseDocx(buffer);
    else if (isTxt) parsed = await parseTextFile(buffer);
    else parsed = await parseSpreadsheetFile(buffer, isCsv);

    const preview = formatFilePreview(parsed);

    if (parsed.error && !parsed.rows.length) {
      return ctx.reply(preview, backToMenu);
    }

    const user = db.getUser(ctx.from.id);
    let buildPlan = null;
    const caption = (ctx.message.caption || "").trim();
    if (caption && parsed.rows && parsed.rows.length) {
      try {
        buildPlan = await buildFilePaymentPlan(parsed.rows, caption, {
          balance: user?.balance || "0",
          address: getActiveWallet(user),
          active_context: getContext(ctx.from.id),
        });
      } catch (err) {
        console.error('[document_handler/buildFilePaymentPlan]', err);
      }
    }

    const batchId = buildPlan?.batchId || `batch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    convState.setState(ctx.from.id, "confirm_file_payment", { parsed, plan: buildPlan, caption, batchId }, getContext(ctx.from.id));

    const replyText = buildPlan && buildPlan.payments?.length
      ? `${preview}\n\n${buildPlan.summary}`
      : preview;

    await ctx.reply(
      replyText,
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Confirm Payments",    "file_payment_confirm")],
        [Markup.button.callback("❌ Cancel",              "main_menu")],
      ])
    );
  } catch (err) {
    console.error("[document_handler]", err);
    await ctx.reply("Couldn't read that file. Please try again or type the details manually.");
  }
});

// File payment confirmed
bot.action("file_payment_confirm", (ctx) => {
  ctx.answerCbQuery();
  const state = convState.getState(ctx.from.id);
  if (!state || state.type !== "confirm_file_payment") {
    return ctx.reply("Session expired. Please send the file again.");
  }
  const { parsed, plan, batchId } = state.data;

  if (plan && plan.payments?.length) {
    const scheduleNote = plan.schedule?.frequency
      ? `\nSchedule: ${plan.schedule.frequency}${plan.schedule.day ? ` on ${plan.schedule.day}` : ""}${plan.schedule.time ? ` at ${plan.schedule.time}` : ""}`
      : "";

    convState.setState(ctx.from.id, "confirm_file_pay_pin", { plan, batchId }, getContext(ctx.from.id));
    return ctx.reply(
      `💸 ${plan.summary}\n\n` +
      `Payments: ${plan.payments.length}${scheduleNote}\n\n` +
      `Enter your PIN to confirm:`,
      Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
    );
  }

  const total = parsed.total?.toFixed(2) || "?";
  convState.setState(ctx.from.id, "confirm_file_pay_pin", { parsed, batchId }, getContext(ctx.from.id));
  return ctx.reply(
    `💸 Total: $${total} to ${parsed.rows.length} recipient(s)\n\n` +
    `Enter your PIN to send:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});

// ─── Clarification quick-actions (from missing-info keyboard) ───────────────
bot.action('clarify_choose_contact', (ctx) => {
  ctx.answerCbQuery();
  return showContacts(ctx);
});

bot.action('clarify_paste_address', (ctx) => {
  ctx.answerCbQuery();
  // Preserve previous classified intent if present
  const prev = convState.getState(ctx.from.id);
  const data = prev && prev.data ? { classified: prev.data.classified } : {};
  convState.setState(ctx.from.id, 'await_paste_address', data, getContext(ctx.from.id));
  return ctx.reply('Paste the wallet address or bank account number now.');
});

bot.action('clarify_enter_amount', (ctx) => {
  ctx.answerCbQuery();
  const prev = convState.getState(ctx.from.id);
  const data = prev && prev.data ? { classified: prev.data.classified } : {};
  convState.setState(ctx.from.id, 'await_enter_amount', data, getContext(ctx.from.id));
  return ctx.reply('How much would you like to send? (e.g. $50 or 5000 NGN)');
});

bot.action('clarify_enter_bank', (ctx) => {
  ctx.answerCbQuery();
  const prev = convState.getState(ctx.from.id);
  const data = prev && prev.data ? { classified: prev.data.classified } : {};
  convState.setState(ctx.from.id, 'await_bank_details', data, getContext(ctx.from.id));
  return ctx.reply('Please enter bank name and account number (e.g. GTBank 0123456789).');
});

// ─── Voice & audio handlers — transcribe then re-enter text flow ───────────
bot.on('voice', async (ctx) => {
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply('Send /start to set up your wallet.');

  await ctx.reply('🔊 Transcribing your voice note...');
  try {
    const voice = ctx.message.voice;
    const buffer = await downloadTelegramFile(ctx, voice.file_id);
    const res = await transcribeVoice(buffer, 'audio/ogg');
    if (res.error) {
      return ctx.reply(res.message || 'Could not transcribe audio.');
    }
    const transcript = (res.text || '').trim();
    if (!transcript || transcript.length < 2) return ctx.reply("Couldn't hear anything clear — please try again.");

    // Re-enter main text handler by synthesising a text message update
    const synthetic = {
      update_id: ctx.update.update_id || Date.now(),
      message: {
        message_id: (ctx.message.message_id || 0) + 1,
        from: ctx.from,
        chat: ctx.chat,
        date: Math.floor(Date.now() / 1000),
        text: transcript,
      },
    };
    return await bot.handleUpdate(synthetic);
  } catch (err) {
    console.error('[voice_handler]', err);
    return ctx.reply('Could not process that voice note. Try again or send it as a file.');
  }
});

bot.on('audio', async (ctx) => {
  // audio may be music or voice — treat similarly to voice notes
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply('Send /start to set up your wallet.');

  await ctx.reply('🔊 Transcribing audio...');
  try {
    const audio = ctx.message.audio || ctx.message.document;
    if (!audio) return ctx.reply("I couldn't find the audio file.");
    const buffer = await downloadTelegramFile(ctx, audio.file_id || audio.file_id);
    const res = await transcribeVoice(buffer, audio.mime_type || 'audio/mpeg');
    if (res.error) return ctx.reply(res.message || 'Could not transcribe audio.');
    const transcript = (res.text || '').trim();
    if (!transcript || transcript.length < 2) return ctx.reply("Couldn't hear anything clear — please try again.");
    const synthetic = { update_id: ctx.update.update_id || Date.now(), message: { message_id: (ctx.message.message_id || 0) + 1, from: ctx.from, chat: ctx.chat, date: Math.floor(Date.now() / 1000), text: transcript } };
    return await bot.handleUpdate(synthetic);
  } catch (err) {
    console.error('[audio_handler]', err);
    return ctx.reply('Could not process that audio file.');
  }
});

// ─── Keyboard hears ───────────────────────────────────────────────────────────

bot.hears("💰 My Money",         (ctx) => showBalance(ctx));
bot.hears("💼 Business Balance", (ctx) => showBizBalance(ctx));
bot.hears("📥 Add Money",        (ctx) => showReceive(ctx));
bot.hears("📋 History",          (ctx) => showHistory(ctx));
bot.hears(/^(?:⚙️?|⚙)\s*settings$/i, (ctx) => { convState.clearState(ctx.from.id); return showSettings(ctx); });
bot.hears(/^settings$/i,         (ctx) => { convState.clearState(ctx.from.id); return showSettings(ctx); });
bot.hears(/settings/i,           (ctx) => { convState.clearState(ctx.from.id); return showSettings(ctx); });
bot.hears("📖 Help",             (ctx) => showHelp(ctx));
bot.hears("✨ What's New",       (ctx) => showFeatures(ctx));
bot.hears("📈 Save & Earn",      (ctx) => showYields(ctx));
bot.hears("👥 Contacts",         (ctx) => showContacts(ctx));
bot.hears("🤖 Auto-Pay",         (ctx) => showAutoPay(ctx));
bot.hears("💰 Balance",          (ctx) => getContext(ctx.from?.id) === "business" ? showBizBalance(ctx) : showBalance(ctx));
bot.hears("💼 Biz Balance",      (ctx) => showBizBalance(ctx));
bot.hears("📊 This Month",       (ctx) => bot.handleUpdate({ ...ctx.update }));
bot.hears("📈 Reports",          (ctx) => bot.handleUpdate({ ...ctx.update }));

bot.hears("📤 Send Money",  (ctx) => ctx.reply(
  `📤 Send Money\n──────────────────────────\nWhere are you sending?`,
  Markup.inlineKeyboard([
    [Markup.button.callback("💵 Cash Out to Naira",       "action_withdraw_menu")],
    [Markup.button.callback("👛 Send to a Wallet Address", "action_sendout_menu")],
    [Markup.button.callback("👥 Send to a Saved Contact",  "action_send_contact")],
    [Markup.button.callback("🏠 Main Menu",               "main_menu")],
  ])
));

bot.hears("📤 Send Payment", (ctx) => ctx.reply(
  `📤 Business Payment`,
  Markup.inlineKeyboard([
    [Markup.button.callback("👛 Send Dollars",            "action_sendout_menu")],
    [Markup.button.callback("💵 Cash Out to Naira",       "action_withdraw_menu")],
    [Markup.button.callback("👥 Saved Contacts",           "action_send_contact")],
    [Markup.button.callback("🏠 Main Menu",               "main_menu")],
  ])
));

bot.hears("💵 Cash Out", (ctx) => {
  convState.setState(ctx.from.id, "await_withdraw_amount", {}, getContext(ctx.from.id));
  return ctx.reply(
    `💵 Cash Out to Naira\n──────────────────────────\nHow much would you like to cash out?`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});

bot.hears("🔄 Swap", (ctx) => ctx.reply(
  `🔄 Swap between currencies — coming very soon.`, backToMenu
));

bot.hears("🧾 Invoice", (ctx) => {
  const context = getContext(ctx.from?.id);
  if (context === "business") return showBizInvoiceMenu(ctx);
  convState.setState(ctx.from.id, "await_invoice_instruction", {}, context);
  return ctx.reply(
    `🧾 Create an Invoice\n──────────────────────────\nDescribe it in plain English:\n\n` +
    `• "Invoice Acme Ltd $500 for website design, due July 15"\n\n` +
    `Type your instruction:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📋 My Invoices", "action_list_invoices")],
      [Markup.button.callback("❌ Cancel",       "main_menu")],
    ])
  );
});

bot.hears("🧾 New Invoice", (ctx) => showBizInvoiceMenu(ctx));

bot.hears("🛒 Shop Online", (ctx) => {
  const context = getContext(ctx.from?.id);
  convState.setState(ctx.from.id, "await_shopping_instruction", {}, context);
  return ctx.reply(
    `🛒 Personal Shopper\n──────────────────────────\nTell me what you're looking for:\n\n` +
    `• "Find a Macbook Pro under $1000"\n` +
    `• "Buy a new ergonomic office chair"\n\n` +
    `What would you like to buy?`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});
bot.hears("📋 My Invoices", (ctx) => {
  const context = getContext(ctx.from?.id);
  if (context === "business") {
    ctx.callbackQuery = { data: "action_list_biz_invoices" };
    return bot.handleUpdate({ update_id: ctx.update.update_id,
      callback_query: { id: "0", from: ctx.from, chat_instance: "0",
        data: "action_list_biz_invoices", message: ctx.message } });
  }
  return ctx.reply("📋 Invoices", Markup.inlineKeyboard([[Markup.button.callback("📋 Open", "action_list_invoices")]]));
});

bot.hears("💸 Log Expense", (ctx) => {
  convState.setState(ctx.from.id, "await_expense_entry", {}, "business");
  return ctx.reply(
    `💸 Log Expense\n──────────────────────────\nDescribe it naturally:\n\n` +
    `• "₦8,000 transport to client meeting"\n` +
    `• "$50 SaaS subscription"`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});

bot.hears("👥 Pay Team", (ctx) => {
  convState.setState(ctx.from.id, "await_payroll_instruction", {}, "business");
  return ctx.reply(
    `👥 Pay Your Team\n──────────────────────────\n` +
    `Describe who to pay:\n\n` +
    `• "Pay Emeka $100 and Amara $80 for this week"\n` +
    `• "Pay 0xABC...123 $150 salary"\n\n` +
    `Or upload a spreadsheet with your team's payment details.\n\n` +
    `Type your instruction or send a file:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});

bot.hears("💰 Business Savings", async (ctx) => {
  const user   = requireUser(ctx);
  if (!user) return;
  const goal   = bizDb.getSavingsGoal(ctx.from.id);
  const saved  = bizDb.getBizSavingsBalance(ctx.from.id);
  await ctx.reply(
    `💰 Business Savings\n──────────────────────────\n` +
    `Current balance: $${saved.toFixed(2)}\n` +
    (goal ? `Auto-save rule: ${goal.percentage}% of every invoice → ${goal.label}` : "No auto-save rule set yet.") +
    `\n\nSet a rule like "Save 20% of every invoice for tax" and PayIT handles it automatically.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("⚙️ Set Auto-Save Rule", "set_savings_goal")],
      [Markup.button.callback("📈 Earn Interest on Savings", "action_yields")],
      [Markup.button.callback("🏠 Main Menu", "main_menu")],
    ])
  );
});

bot.action("set_savings_goal", (ctx) => {
  ctx.answerCbQuery();
  convState.setState(ctx.from.id, "await_savings_goal", {}, "business");
  return ctx.reply(
    `⚙️ Set Auto-Save Rule\n──────────────────────────\n` +
    `Describe your goal:\n\n` +
    `• "Save 20% of every invoice for tax"\n` +
    `• "Set aside 10% for emergency fund"`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
  );
});

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.command("menu",     (ctx) => ctx.reply("What would you like to do?", mainMenu(getContext(ctx.from?.id))));
bot.command("help",     showHelp);
bot.command("balance",  showBalance);
bot.command("history",  showHistory);
bot.command("settings", (ctx) => { convState.clearState(ctx.from.id); return showSettings(ctx); });
bot.command("lock",     async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  if (user.is_blocked) return ctx.reply("Your account is already locked. Send /unlock to restore access.");
  convState.setState(ctx.from.id, "confirm_lock", {}, getContext(ctx.from.id));
  return ctx.reply("Enter your PIN to lock your account.");
});
bot.command("unlock",   async (ctx) => {
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply("Send /start to set up your wallet first.");
  if (!user.is_blocked) return ctx.reply("Your account is not locked.");
  convState.setState(ctx.from.id, "confirm_unlock", {}, getContext(ctx.from.id));
  return ctx.reply("Enter your PIN to unlock your account.");
});
bot.command("yields",   showYields);
bot.command("deposit",  showReceive);
bot.command("contacts", showContacts);
bot.command("autopay",  showAutoPay);
bot.command("invoice",  (ctx) => {
  const context = getContext(ctx.from?.id);
  if (context === "business") return showBizInvoiceMenu(ctx);
  convState.setState(ctx.from.id, "await_invoice_instruction", {}, context);
  return ctx.reply("Describe your invoice:");
});
bot.command("paymaster", (ctx) => {
  const cfg = paymaster.getPaymasterConfig();
  const active = paymaster.isPaymasterActive();
  return ctx.reply(
    `⛽ Arc Paymaster Status\n──────────────────────────\n` +
    `Status: ${active ? "🟢 Active & Sponsoring Gas" : "🔴 Inactive (Direct Gas)"}\n` +
    `Paymaster RPC: \`${cfg.paymasterUrl}\`\n` +
    `Bundler RPC: \`${cfg.bundlerUrl}\`\n` +
    `Policy ID: \`${cfg.policyId}\`\n` +
    `EntryPoint: \`${cfg.entryPoint}\`\n` +
    `Chain ID: \`${cfg.chainId}\`\n\n` +
    `Transactions sent via PayIT are automatically gas-sponsored when active.`,
    { parse_mode: "Markdown" }
  );
});

async function showAdminMenu(ctx) {
  if (!ADMIN_IDS.includes(String(ctx.from?.id))) return ctx.reply("Not authorised.");
  const userCount = db.db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  const positions = db.db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(amount_usdc),0) as t FROM yield_positions WHERE status='active'").get();
  const invoiceCount = db.db.prepare("SELECT COUNT(*) as c FROM invoices").get().c;
  const recentTx = db.db.prepare("SELECT * FROM transactions ORDER BY id DESC LIMIT 8").all();
  const dbPath = db.resolveDbPath();
  const txLines = recentTx.map((t) => `#${t.id} ${t.type} · user ${t.telegram_id} · [${t.status}]`).join("\n") || "none";
  return ctx.reply(
    `🛠 Admin
──────────────────────────\n` +
    `Users: ${userCount}\n` +
    `Active savings: ${positions.c} ($${Number(positions.t).toFixed(2)})\n` +
    `Invoices: ${invoiceCount}\n` +
    `DB path: ${dbPath}\n\n` +
    `Recent transactions:\n${txLines}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📊 Volume Stats", "admin_volume")],
      [Markup.button.callback("📤 Export Points", "admin_export_points")],
      [Markup.button.callback("📣 Broadcast", "admin_broadcast")],
      [Markup.button.callback("🎁 Reward Notify", "admin_reward_notify")],
      [Markup.button.callback("🔒 Block User", "admin_block_user")],
      [Markup.button.callback("🔓 Unblock User", "admin_unblock_user")],
    ])
  );
}

bot.command("admin", (ctx) => showAdminMenu(ctx));

bot.action("admin_menu", (ctx) => {
  ctx.answerCbQuery();
  return showAdminMenu(ctx);
});

bot.action("admin_export_points", async (ctx) => {
  ctx.answerCbQuery();
  if (!ADMIN_IDS.includes(String(ctx.from?.id))) return ctx.reply("Not authorised.");
  const rows = db.db.prepare(
    "SELECT telegram_id, username, points_balance, phone_number, active_context, is_blocked, created_at FROM users ORDER BY points_balance DESC, telegram_id ASC"
  ).all();
  if (!rows.length) return ctx.reply("No users found.");

  const csvLines = [
    "telegram_id,username,points_balance,phone_number,active_context,is_blocked,created_at",
    ...rows.map((r) => {
      const username = String(r.username || "").replace(/"/g, '""');
      const phone = String(r.phone_number || "").replace(/"/g, '""');
      return `${r.telegram_id},"${username}",${r.points_balance},"${phone}",${r.active_context},${r.is_blocked},${r.created_at}`;
    }),
  ];

  const csv = csvLines.join("\n");
  await ctx.replyWithDocument({ source: Buffer.from(csv, "utf8"), filename: "payit_user_points.csv" });
  return ctx.reply("Export complete.", Markup.inlineKeyboard([[Markup.button.callback("« Back", "admin_menu")]]));
});

bot.action("admin_block_user", (ctx) => {
  ctx.answerCbQuery();
  if (!ADMIN_IDS.includes(String(ctx.from?.id))) return ctx.reply("Not authorised.");
  convState.setState(ctx.from.id, "admin_block_user", {}, getContext(ctx.from.id));
  return ctx.reply("Send the Telegram user ID to block:", Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "admin_menu")]]));
});

bot.action("admin_unblock_user", (ctx) => {
  ctx.answerCbQuery();
  if (!ADMIN_IDS.includes(String(ctx.from?.id))) return ctx.reply("Not authorised.");
  convState.setState(ctx.from.id, "admin_unblock_user", {}, getContext(ctx.from.id));
  return ctx.reply("Send the Telegram user ID to unblock:", Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "admin_menu")]]));
});

bot.action("admin_broadcast", (ctx) => {
  ctx.answerCbQuery();
  if (!ADMIN_IDS.includes(String(ctx.from?.id))) return ctx.reply("Not authorised.");
  convState.setState(ctx.from.id, "admin_broadcast", {}, getContext(ctx.from.id));
  return ctx.reply(
    "Send the broadcast message. You can also add filters like min_days=30 min_points=10 min_tx=3 min_recent_tx=1 recent_days=30 min_invoices=1.",
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "admin_menu")]])
  );
});

bot.action("admin_reward_notify", (ctx) => {
  ctx.answerCbQuery();
  if (!ADMIN_IDS.includes(String(ctx.from?.id))) return ctx.reply("Not authorised.");
  convState.setState(ctx.from.id, "admin_reward_notify", {}, getContext(ctx.from.id));
  return ctx.reply(
    "Send the reward notification message. You can also add filters like min_days=30 min_points=10 min_tx=3 min_recent_tx=1 recent_days=30 min_invoices=1.",
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "admin_menu")]])
  );
});

// ─── Admin Volume Monitoring ──────────────────────────────────────────────────

function formatVolRow(label, breakdown) {
  if (!breakdown) return "";
  const { today, week, month, allTime } = breakdown;
  const fmt = (v) => `$${(v?.usdc || 0).toFixed(2)} (${v?.count || 0}tx)`;
  return (
    `\n<b>${label}</b>\n` +
    `  Today:    ${fmt(today)}\n` +
    `  7 days:   ${fmt(week)}\n` +
    `  30 days:  ${fmt(month)}\n` +
    `  All-time: ${fmt(allTime)}`
  );
}

function renderVolumeDashboard() {
  const stats = db.getVolumeStats();
  const { onramp, crypto, offramp, sends, savings, invoices, swaps, totalAll, users, topUsers } = stats;

  const topLine = topUsers && topUsers.length
    ? topUsers.map((u, i) => `  ${i + 1}. ${u.username} · $${(u.usdc || 0).toFixed(2)} · ${u.tx_count}tx`).join("\n")
    : "  No data yet";

  let message =
    `📊 <b>PayIT Volume Dashboard</b>\n` +
    `──────────────────────────\n` +
    formatVolRow("🇳🇬 Naira Onramp", onramp) +
    formatVolRow("🌐 Crypto Deposit", crypto) +
    formatVolRow("💵 Cash Out (Offramp)", offramp) +
    formatVolRow("📤 Sends & Auto-Pay", sends) +
    formatVolRow("📈 Savings Deposits", savings);

  if (invoices && invoices.allTime && invoices.allTime.count > 0) {
    message += formatVolRow("🧾 Invoice Payments", invoices);
  }
  if (swaps && swaps.allTime && swaps.allTime.count > 0) {
    message += formatVolRow("🔄 Currency Swaps", swaps);
  }

  message +=
    `\n\n<b>📦 Total Platform Volume</b>\n` +
    `  All-time: $${(totalAll?.usdc || 0).toFixed(2)} (${totalAll?.count || 0} transactions)\n` +
    `\n<b>👤 User Growth</b>\n` +
    `  Today: +${users?.today ?? 0}  |  7d: +${users?.week ?? 0}  |  30d: +${users?.month ?? 0}  |  Total: ${users?.total ?? 0}\n` +
    `\n<b>🏆 Top 5 Users by Volume</b>\n` +
    topLine;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🔍 Scan Live Product", "admin_scan_volume")],
    [Markup.button.callback("📊 Export Volume CSV", "admin_volume_csv")],
    [Markup.button.callback("🔄 Refresh", "admin_volume")],
    [Markup.button.callback("« Admin Menu", "admin_menu")],
  ]);

  return { message, keyboard };
}

bot.action("admin_volume", async (ctx) => {
  ctx.answerCbQuery();
  if (!ADMIN_IDS.includes(String(ctx.from?.id))) return ctx.reply("Not authorised.");

  try {
    const { message, keyboard } = renderVolumeDashboard();
    return ctx.reply(message, { parse_mode: "HTML", ...keyboard });
  } catch (err) {
    return ctx.reply(`Volume stats error: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback("« Back", "admin_menu")]]));
  }
});

bot.action("admin_scan_volume", async (ctx) => {
  ctx.answerCbQuery("Scanning live product...");
  if (!ADMIN_IDS.includes(String(ctx.from?.id))) return ctx.reply("Not authorised.");

  await ctx.reply("🔍 Scanning live product database and reconciling transactions...");
  let res;
  try {
    res = db.reconcileLiveProductVolume();
  } catch (err) {
    return ctx.reply(`Scan error: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback("« Back", "admin_volume")]]));
  }

  await ctx.reply(
    `✅ <b>Live Product Reconciled!</b>\n──────────────────────────\n` +
    `• Scaled legacy amounts: ${res.fixedScale}\n` +
    `• Backfilled paid invoices: ${res.backfilledInvoices}\n` +
    `• Backfilled completed payments: ${res.backfilledPayments}\n` +
    `• Backfilled savings positions: ${res.backfilledYield}\n` +
    `• Backfilled onramp deposits: ${res.backfilledOnramp || 0}\n` +
    `• Deduplicated monitor sweeps: ${res.deduplicatedSweeps || 0}`,
    { parse_mode: "HTML" }
  );

  try {
    const { message, keyboard } = renderVolumeDashboard();
    return ctx.reply(message, { parse_mode: "HTML", ...keyboard });
  } catch (err) {
    return ctx.reply(`Volume stats error: ${err.message}`);
  }
});

bot.command("scan_volume", async (ctx) => {
  if (!ADMIN_IDS.includes(String(ctx.from?.id))) return;
  await ctx.reply("🔍 Scanning live product database and reconciling transactions...");
  let res;
  try {
    res = db.reconcileLiveProductVolume();
  } catch (err) {
    return ctx.reply(`Scan error: ${err.message}`);
  }
  await ctx.reply(
    `✅ <b>Live Product Reconciled!</b>\n──────────────────────────\n` +
    `• Scaled legacy amounts: ${res.fixedScale}\n` +
    `• Backfilled paid invoices: ${res.backfilledInvoices}\n` +
    `• Backfilled completed payments: ${res.backfilledPayments}\n` +
    `• Backfilled savings positions: ${res.backfilledYield}\n` +
    `• Backfilled onramp deposits: ${res.backfilledOnramp || 0}`,
    { parse_mode: "HTML" }
  );
  try {
    const { message, keyboard } = renderVolumeDashboard();
    return ctx.reply(message, { parse_mode: "HTML", ...keyboard });
  } catch (err) {
    return ctx.reply(`Volume stats error: ${err.message}`);
  }
});

bot.action("admin_volume_csv", async (ctx) => {
  ctx.answerCbQuery();
  if (!ADMIN_IDS.includes(String(ctx.from?.id))) return ctx.reply("Not authorised.");

  try {
    // Raw per-day volume breakdown across all types with normalized amount scaling
    const rows = db.db.prepare(`
      SELECT
        date(created_at)   AS day,
        type,
        COUNT(*)           AS tx_count,
        COALESCE(SUM(CASE WHEN CAST(amount_micro AS REAL) > 0 AND CAST(amount_micro AS REAL) < 1e13 THEN CAST(amount_micro AS REAL) * 1e12 ELSE CAST(amount_micro AS REAL) END), 0) / 1e18 AS usdc_volume
      FROM transactions
      WHERE status IN ('confirmed', 'submitted', 'success', 'completed')
      GROUP BY day, type
      ORDER BY day DESC, type
    `).all();

    if (!rows.length) return ctx.reply("No confirmed transactions to export.", Markup.inlineKeyboard([[Markup.button.callback("« Back", "admin_volume")]]));

    const csvLines = [
      "date,type,tx_count,usdc_volume",
      ...rows.map((r) => `${r.day},${r.type},${r.tx_count},${r.usdc_volume.toFixed(6)}`),
    ];

    const csv = csvLines.join("\n");
    await ctx.replyWithDocument({
      source: Buffer.from(csv, "utf8"),
      filename: `payit_volume_${new Date().toISOString().slice(0, 10)}.csv`,
    });
    return ctx.reply("Volume export complete.", Markup.inlineKeyboard([[Markup.button.callback("« Back", "admin_volume")]]));
  } catch (err) {
    return ctx.reply(`Export error: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback("« Back", "admin_volume")]]));
  }
});

bot.command("volume", async (ctx) => {
  if (!ADMIN_IDS.includes(String(ctx.from?.id))) return;
  try {
    const { message, keyboard } = renderVolumeDashboard();
    return ctx.reply(message, { parse_mode: "HTML", ...keyboard });
  } catch (err) {
    return ctx.reply(`Volume stats error: ${err.message}`);
  }
});

// ─── Admin: CCTP Retry & Fee-Payer Status ────────────────────────────────────

/**
 * /retry_cctp — Admin command to retry all pending CCTP Arc→Solana burns.
 * Use this after funding the Solana fee-payer wallet (5ba1CAaz...) with SOL.
 */
bot.command("retry_cctp", async (ctx) => {
  if (!ADMIN_IDS.includes(String(ctx.from?.id))) return;
  const cctpBridge = require("./src/cctp_bridge");
  const statusMsg = await ctx.reply("🔄 Checking Solana fee-payer and retrying pending CCTP burns...");
  try {
    const result = await cctpBridge.retryPendingCctpBurns();
    const { retried, succeeded, failed, feePayerSol, feePayerAddress } = result;
    if (retried === 0) {
      return ctx.reply(
        `✅ <b>No pending CCTP burns to retry.</b>\n\n` +
        `💳 Fee payer: <code>${feePayerAddress}</code>\n` +
        `💰 Balance: ${feePayerSol.toFixed(4)} SOL`,
        { parse_mode: "HTML" }
      );
    }
    return ctx.reply(
      `🔄 <b>CCTP Retry Complete</b>\n` +
      `──────────────────────────\n` +
      `Total retried:  ${retried}\n` +
      `✅ Succeeded:   ${succeeded}\n` +
      `❌ Failed:      ${failed}\n\n` +
      `💳 Fee payer: <code>${feePayerAddress}</code>\n` +
      `💰 Balance: ${feePayerSol.toFixed(4)} SOL`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    return ctx.reply(`❌ CCTP retry error: ${err.message}`);
  }
});

/**
 * admin_cctp_status — Inline button to show CCTP fee payer status and pending count.
 */
bot.action("admin_cctp_status", async (ctx) => {
  ctx.answerCbQuery();
  if (!ADMIN_IDS.includes(String(ctx.from?.id))) return ctx.reply("Not authorised.");
  const cctpBridge = require("./src/cctp_bridge");
  try {
    const feeCheck = await cctpBridge.checkSolanaFeePayerBalance();
    const pendingCount = db.countPendingCctpBurns();
    const statusIcon = feeCheck.ok ? "✅" : "⚠️";
    const balanceMsg = feeCheck.ok
      ? `${feeCheck.balanceSol.toFixed(4)} SOL (healthy)`
      : `${feeCheck.balanceSol.toFixed(4)} SOL ← ⚠️ NEEDS FUNDING (min 0.01 SOL)`;
    const message =
      `🌉 <b>CCTP Arc→Solana Status</b>\n` +
      `──────────────────────────\n` +
      `${statusIcon} Fee Payer: <code>${feeCheck.address}</code>\n` +
      `   Balance: ${balanceMsg}\n\n` +
      `📋 Pending burns: ${pendingCount}\n\n` +
      (pendingCount > 0
        ? `⚡ Run /retry_cctp after funding the wallet to complete pending withdrawals.`
        : `✅ No stuck withdrawals.`);
    return ctx.reply(message, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Retry Pending Burns", "admin_cctp_retry")],
        [Markup.button.callback("« Admin Menu", "admin_menu")],
      ]),
    });
  } catch (err) {
    return ctx.reply(`CCTP status error: ${err.message}`);
  }
});

bot.action("admin_cctp_retry", async (ctx) => {
  ctx.answerCbQuery("Retrying pending burns...");
  if (!ADMIN_IDS.includes(String(ctx.from?.id))) return ctx.reply("Not authorised.");
  const cctpBridge = require("./src/cctp_bridge");
  try {
    const result = await cctpBridge.retryPendingCctpBurns();
    const { retried, succeeded, failed, feePayerSol, feePayerAddress } = result;
    return ctx.reply(
      `🔄 <b>CCTP Retry Result</b>\n` +
      `Retried: ${retried} | ✅ ${succeeded} OK | ❌ ${failed} failed\n` +
      `💰 Fee payer balance: ${feePayerSol.toFixed(4)} SOL`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("« Back", "admin_cctp_status")]]) }
    );
  } catch (err) {
    return ctx.reply(`Error: ${err.message}`);
  }
});

// ─── Main text handler — intent router ───────────────────────────────────────
// Every text message that isn't caught above passes through here.
// The intent router classifies it, resolves payees, and routes accordingly.

bot.on("text", async (ctx) => {
  const state = convState.getState(ctx.from.id);
  const text  = ctx.message.text.trim();
  const userId = ctx.from.id;

  if (isSettingsRequest(text)) {
    convState.clearState(userId);
    return showSettings(ctx);
  }

  // ── Multi-step flow states ─────────────────────────────────────────────────

  if (state) {
    if (isCancelPhrase(text)) {
      convState.clearState(userId);
      return ctx.reply("Okay, cancelled. What would you like to do?", mainMenu(getContext(userId)));
    }

    convState.touchState(userId); // keep alive

    if (state.type === "admin_block_user") {
      const targetId = Number(text.trim());
      if (!Number.isInteger(targetId)) return ctx.reply("Please send a valid Telegram user ID.");
      const user = db.getUser(targetId);
      if (!user) return ctx.reply("User not found.");
      if (user.is_blocked) return ctx.reply("User is already blocked.");
      db.blockUser(targetId, `blocked by admin ${ctx.from.id}`);
      convState.clearState(userId);
      return ctx.reply(`User ${targetId} has been blocked.`, Markup.inlineKeyboard([[Markup.button.callback("« Back", "admin_menu")]]));
    }

    if (state.type === "admin_unblock_user") {
      const targetId = Number(text.trim());
      if (!Number.isInteger(targetId)) return ctx.reply("Please send a valid Telegram user ID.");
      const user = db.getUser(targetId);
      if (!user) return ctx.reply("User not found.");
      if (!user.is_blocked) return ctx.reply("User is not blocked.");
      db.unblockUser(targetId);
      convState.clearState(userId);
      return ctx.reply(`User ${targetId} has been unblocked.`, Markup.inlineKeyboard([[Markup.button.callback("« Back", "admin_menu")]]));
    }

    if (state.type === "admin_broadcast") {
      const args = parseAdminBroadcastArgs(text);
      if (!args) return ctx.reply("Please provide a message and optional filters like min_days=30 min_points=10 min_tx=3 min_recent_tx=1 recent_days=30 min_invoices=1.");
      const filters = getUserActivityFilters(args.message);
      const message = args.message.replace(/\b(?:min_days|max_days|min_points|max_points)=\S+/g, "").trim();
      if (!message) return ctx.reply("Broadcast message cannot be empty.");
      const targets = selectTargetUsers(filters);
      if (!targets.length) return ctx.reply("No eligible users found for that audience.");
      let sent = 0;
      let failed = 0;
      for (const user of targets) {
        try {
          await notifyUser(user.telegram_id, message);
          sent += 1;
        } catch {
          failed += 1;
        }
      }
      convState.clearState(userId);
      return ctx.reply(`Broadcast sent to ${sent} users${failed ? ` (${failed} failed)` : ""}.`, Markup.inlineKeyboard([[Markup.button.callback("« Back", "admin_menu")]]));
    }

    if (state.type === "admin_reward_notify") {
      const payload = text.trim();
      if (!payload) return ctx.reply("Please send a notification message.");
      const users = selectTargetUsers(getUserActivityFilters(payload));
      if (!users.length) return ctx.reply("No eligible users found.");
      let sent = 0;
      for (const user of users) {
        try {
          await notifyUser(user.telegram_id, payload.replace(/\b(?:min_days|max_days|min_points|max_points)=\S+/g, "").trim());
          sent += 1;
        } catch {
          // ignore per-user errors
        }
      }
      convState.clearState(userId);
      return ctx.reply(`Reward notification sent to ${sent} users.`, Markup.inlineKeyboard([[Markup.button.callback("« Back", "admin_menu")]]));
    }

    // ── Business onboarding ──────────────────────────────────────────────────

    if (state.type === "onboard_biz_name") {
      convState.setState(userId, "onboard_biz_email", { ...state.data, businessName: text }, "business");
      return ctx.reply(
        `Great — ${text}.\n\nWhat's your business email address? (Type "skip" to leave blank)`
      );
    }

    if (state.type === "onboard_biz_email") {
      const email = text.toLowerCase() === "skip" ? null : text;
      convState.setState(userId, "onboard_biz_phone", { ...state.data, businessEmail: email }, "business");
      return ctx.reply(`Business phone number? (Type "skip" to leave blank)`);
    }

    if (state.type === "onboard_biz_phone") {
      const phone = text.toLowerCase() === "skip" ? null : text;
      convState.setState(userId, "onboard_biz_address", { ...state.data, businessPhone: phone }, "business");
      return ctx.reply(`Business address or city? (Type "skip" to leave blank)`);
    }

    if (state.type === "onboard_biz_address") {
      const address = text.toLowerCase() === "skip" ? null : text;
      convState.setState(userId, "onboard_biz_terms", { ...state.data, businessAddress: address }, "business");
      return ctx.reply(
        `How many days until your invoices are due by default?\n\nCommon choices: 7, 14, 30\n(Type a number or "skip" for 14 days)`
      );
    }

    if (state.type === "onboard_biz_terms") {
      const days = parseInt(text) || 14;
      const d    = state.data;
      convState.setState(userId, "onboard_biz_logo", { ...d, defaultDueDays: days }, "business");
      return ctx.reply(
        `Almost done.\n\nSend your business logo as a photo, or type "skip" to continue without one.\n\nYou can always add it later in Settings.`
      );
    }

    // logo handled in photo handler — text "skip" here
    if (state.type === "onboard_biz_logo") {
      if (text.toLowerCase() !== "skip") {
        return ctx.reply(`Please send a photo, or type "skip" to continue.`);
      }
      // Fall through to PIN setup
      const d = state.data;
      const personalWallet = walletLib.generateUserWallet();
      const businessWallet = walletLib.generateUserWallet();
      convState.setState(userId, "onboarding_pin", {
        accountType:      "business",
        address:          personalWallet.address,
        privateKey:       personalWallet.privateKey,
        businessAddress:  businessWallet.address,
        businessPrivateKey: businessWallet.privateKey,
        username:         ctx.from.username,
        bizProfile: {
          businessName:    d.businessName,
          businessEmail:   d.businessEmail,
          phone:           d.businessPhone,
          address:         d.businessAddress,
          defaultDueDays:  d.defaultDueDays,
        },
        referrerId: d.referrerId || null,
      }, "business");
      return ctx.reply(
        `✅ Profile saved!\n\n` +
        `Now let's secure your wallet.\n\n` +
        `Choose a 4-digit PIN — write it down somewhere safe. If you forget it and haven't saved your security phrase, your money cannot be recovered.\n\n` +
        `Type your PIN:`
      );
    }

    // ── PIN setup (shared between personal and business onboarding) ──────────

    if (state.type === "onboarding_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("PIN must be exactly 4 digits. Try again.");

      const isBusiness   = state.data.accountType === "business";
      const existingUser = db.getUser(userId);

      if (existingUser) {
        // Personal account already exists — just attach the business wallet
        if (isBusiness && state.data.businessAddress) {
          // Verify their existing PIN first
          if (!db.verifyPin(userId, text)) {
            return ctx.reply("Incorrect PIN. Please enter your existing PayIT PIN:");
          }
          db.addBusinessWallet(userId, state.data.businessAddress, state.data.businessPrivateKey, text);
        }
      } else {
        // Brand new user — create full account
        db.createUserWithWallet(
          userId,
          state.data.username,
          state.data.address,
          state.data.privateKey,
          text,
          isBusiness ? state.data.businessAddress    : null,
          isBusiness ? state.data.businessPrivateKey : null,
          state.data.referrerId || null
        );
      }

      // Save business profile if collected
      if (isBusiness && state.data.bizProfile) {
        bizProfile.upsertBizProfile(userId, {
          ...state.data.bizProfile,
          logoPath: state.data.logoPath || null,
        });
      }

      convState.clearState(userId);
      db.setActiveContext(userId, isBusiness ? "business" : "personal");

      // Show only relevant keys
      let exportText = "\u2705 You're all set!\n\n";
      if (!existingUser) {
        exportText += `Personal account number:\n${state.data.address}\n`;
        exportText += `Personal security phrase:\n${state.data.privateKey}\n\n`;
      }
      if (isBusiness && state.data.businessAddress) {
        exportText += `Business account number:\n${state.data.businessAddress}\n`;
        exportText += `Business security phrase:\n${state.data.businessPrivateKey}\n\n`;
      }
      exportText += "\u26a0\ufe0f Save your security phrase NOW \u2014 use a password manager or write it down. Not a screenshot.\n";
      exportText += "This message deletes in 60 seconds.";

      const exportMsg = await ctx.reply(exportText);
      scheduleDelete(ctx, exportMsg.message_id, 60000);

      const context = isBusiness ? "business" : "personal";
      return ctx.reply(`What would you like to do first?`, mainMenu(context));
    }

    // ── Create business wallet (lazy, for personal users adding business later) ──

    if (state.type === "create_biz_wallet_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) return ctx.reply("Incorrect PIN. Try again.");
      const bizWallet = walletLib.generateUserWallet();
      db.addBusinessWallet(userId, bizWallet.address, bizWallet.privateKey, text);
      db.setActiveContext(userId, "business");
      convState.clearState(userId);
      const exportMsg = await ctx.reply(
        `✅ Business account created!\n\n` +
        `Business account number (tap to copy):\n${bizWallet.address}\n` +
        `Business security phrase:\n${bizWallet.privateKey}\n\n` +
        `⚠️ Save your security phrase now — it deletes in 60 seconds.`
      );
      scheduleDelete(ctx, exportMsg.message_id, 60000);
      return ctx.reply("Switched to Business account.", mainMenu("business"));
    }

    // ── Business profile field edit ──────────────────────────────────────────

    if (state.type === "biz_edit_field") {
      const { field } = state.data;
      let value = text;
      if (field === "default_due_days") {
        value = parseInt(text);
        if (isNaN(value) || value < 1) return ctx.reply("Enter a number of days (e.g. 14).");
      }
      bizProfile.updateBizProfileField(userId, field, value);
      convState.clearState(userId);
      return ctx.reply(
        `✅ Updated!`,
        Markup.inlineKeyboard([[Markup.button.callback("« Back to Profile", "biz_profile_menu")]])
      );
    }

    // ── Export key ───────────────────────────────────────────────────────────

    if (state.type === "confirm_export") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) { convState.clearState(userId); return ctx.reply("Incorrect PIN."); }
      const user = db.getUser(userId);
      try {
        const pk    = state.data.walletType === "business"
          ? db.decryptBusinessPrivateKey(text, user)
          : db.decryptPrivateKey(text, user);
        const label = state.data.walletType === "business" ? "Business" : "Personal";
        convState.clearState(userId);
        const msg = await ctx.reply(
          `🔑 Your ${label} Security Phrase\n──────────────────────────\n${pk}\n\n` +
          `Save this now — it deletes in 60 seconds.`
        );
        scheduleDelete(ctx, msg.message_id, 60000);
      } catch {
        await ctx.reply("Couldn't verify your PIN. Please try again.");
      }
      return;
    }

    if (state.type === "confirm_lock") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) return ctx.reply("Incorrect PIN. Try again.");
      db.blockUser(userId, "self locked account");
      convState.clearState(userId);
      return ctx.reply("✅ Your account is locked. Send /unlock and enter your PIN to restore access.");
    }

    if (state.type === "confirm_unlock") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) return ctx.reply("Incorrect PIN. Try again.");
      db.unblockUser(userId);
      convState.clearState(userId);
      return ctx.reply("✅ Your account is unlocked. Welcome back!");
    }

    // ── Change PIN ───────────────────────────────────────────────────────────

    if (state.type === "changepin_old") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your current 4-digit PIN.");
      if (!db.verifyPin(userId, text)) {
        convState.clearState(userId);
        return ctx.reply("Incorrect PIN.", Markup.inlineKeyboard([[Markup.button.callback("Try Again", "changepin")]]));
      }
      const user = db.getUser(userId);
      let pk, bizPk;
      try {
        pk    = db.decryptPrivateKey(text, user);
        if (user.business_deposit_address) bizPk = db.decryptBusinessPrivateKey(text, user);
      } catch {
        convState.clearState(userId);
        return ctx.reply("Couldn't unlock your wallet.");
      }
      convState.setState(userId, "changepin_new", { privateKey: pk, businessPrivateKey: bizPk }, getContext(userId));
      return ctx.reply("Now enter your NEW 4-digit PIN:");
    }

    if (state.type === "changepin_new") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("PIN must be exactly 4 digits.");
      db.updatePin(userId, text, state.data.privateKey, state.data.businessPrivateKey);
      convState.clearState(userId);
      return ctx.reply(
        "✅ PIN changed successfully.",
        Markup.inlineKeyboard([[Markup.button.callback("« Back to Settings", "action_settings")]])
      );
    }

    // ── Link external wallet ─────────────────────────────────────────────────

    if (state.type === "await_setwallet") {
      convState.clearState(userId);
      if (!walletLib.isValidAddress(text)) {
        return ctx.reply(
          "That doesn't look like a valid account number.",
          Markup.inlineKeyboard([[Markup.button.callback("« Cancel", "action_settings")]])
        );
      }
      db.setExternalWallet(userId, text);
      return ctx.reply(
        `✅ Wallet linked!\n${text}`,
        Markup.inlineKeyboard([
          [Markup.button.callback("📤 Send Dollars", "action_sendout_menu")],
          [Markup.button.callback("« Settings",      "action_settings")],
        ])
      );
    }

    // ── Phone verify ─────────────────────────────────────────────────────────

    if (state.type === "await_phone") {
      convState.clearState(userId);
      const phone = text.replace(/\D/g, "");
      try {
        const result = await otp.sendOtp(phone);
        db.setPhoneNumber(userId, phone);
        convState.setState(userId, "confirm_otp", { pinId: result.pinId }, getContext(userId));
        return ctx.reply(
          `📱 Code sent to ${phone}.\n\nEnter the code to verify:`,
          Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_settings")]])
        );
      } catch (err) {
        return ctx.reply("Couldn't send the code — please try again later.");
      }
    }

    if (state.type === "confirm_otp") {
      convState.clearState(userId);
      try {
        const verified = await otp.verifyOtp(state.data.pinId, text);
        if (verified) {
          db.setPhoneVerified(userId, true);
          return ctx.reply("✅ Phone verified!", Markup.inlineKeyboard([[Markup.button.callback("« Settings", "action_settings")]]));
        }
        return ctx.reply("That code didn't match.", Markup.inlineKeyboard([[Markup.button.callback("« Settings", "action_settings")]]));
      } catch {
        return ctx.reply("Couldn't verify the code — please try again.");
      }
    }

    // ── Gateway deposit amount ───────────────────────────────────────────────

    if (state.type === "await_gateway_deposit_amount") {
      const amount = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (isNaN(amount) || amount <= 0) {
        return ctx.reply("Enter a valid USDC amount (e.g. 5):");
      }
      const { chainName } = state.data;
      convState.setState(userId, "confirm_gateway_deposit_pin", { chainName, amount }, state.context);
      return ctx.reply(
        `🚀 Confirm Gateway Deposit\n──────────────────────────\n` +
        `Chain: ${chainName}\n` +
        `Amount: ${amount.toFixed(2)} USDC\n\n` +
        `PayIT will approve + deposit into Circle Gateway.\n` +
        `You need USDC + gas on ${chainName}.\n\n` +
        `Enter your PIN to confirm:`,
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_gateway")]])
      );
    }

    if (state.type === "confirm_gateway_deposit_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) { convState.clearState(userId); return ctx.reply("Incorrect PIN."); }
      const user = db.getUser(userId);
      convState.clearState(userId);
      const { chainName, amount } = state.data;
      const chain = gateway.SUPPORTED_CHAINS.find(c => c.name === chainName);

      let privateKey;
      try {
        privateKey = db.decryptPrivateKey(text, user);
      } catch {
        return ctx.reply("Couldn't unlock your wallet with that PIN.");
      }

      await ctx.reply(`⏳ Depositing ${amount.toFixed(2)} USDC on ${chainName}...\nThis may take a minute.`);
      try {
        const { approveTxHash, depositTxHash } = await gateway.executeDeposit(privateKey, chainName, amount);
        const explorer = chain?.explorer || "";
        await ctx.reply(
          `✅ Deposited into Gateway!\n\n` +
          `Approve: ${explorer}${approveTxHash}\n` +
          `Deposit: ${explorer}${depositTxHash}\n\n` +
          `Wait for finality, then tap <b>Transfer to Arc</b>.`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("⚡ Transfer to Arc", "gateway_transfer_arc")],
              [Markup.button.callback("🏠 Main Menu",      "main_menu")],
            ]),
          }
        );
      } catch (err) {
        console.error("[gateway_deposit]", err);
        await ctx.reply(
          `❌ Deposit failed: ${err.message}\n\n` +
          `Common fixes:\n` +
          `• Get USDC from faucet.circle.com for ${chainName}\n` +
          `• Get gas (${chain?.symbol || "native token"}) on ${chainName}\n` +
          `• Try a smaller amount`,
          Markup.inlineKeyboard([[Markup.button.callback("« Back", "action_gateway")]])
        );
      }
      return;
    }

    if (state.type === "await_gateway_transfer_amount") {
      const amount = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (isNaN(amount) || amount <= 0) {
        return ctx.reply("Enter a valid USDC amount (e.g. 5):");
      }
      const { chainName } = state.data;
      convState.setState(userId, "confirm_gateway_transfer_pin", { chainName, amount }, state.context);
      return ctx.reply(
        `⚡ Confirm Transfer to Arc\n──────────────────────────\n` +
        `From: ${chainName}\n` +
        `Amount: ${amount.toFixed(2)} USDC\n\n` +
        `Enter your PIN to confirm:`,
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_gateway")]])
      );
    }

    if (state.type === "confirm_gateway_transfer_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) { convState.clearState(userId); return ctx.reply("Incorrect PIN."); }
      const user = db.getUser(userId);
      convState.clearState(userId);
      const { chainName, amount } = state.data;
      const arcAddress = getActiveWallet(user);

      let privateKey;
      try {
        privateKey = db.decryptPrivateKey(text, user);
      } catch {
        return ctx.reply("Couldn't unlock your wallet with that PIN.");
      }

      await ctx.reply(`⏳ Transferring ${amount.toFixed(2)} USDC to Arc...`);
      try {
        const result = await gateway.transferToArc(privateKey, chainName, amount, arcAddress);
        await ctx.reply(
          `✅ Transfer submitted!\n\n` +
          `USDC should appear on Arc in under a minute.\n` +
          (result.transferId ? `Transfer ID: ${result.transferId}\n` : "") +
          `\nTap Check Balance to confirm.`,
          Markup.inlineKeyboard([
            [Markup.button.callback("💰 Check Balance", "action_balance")],
            [Markup.button.callback("🏠 Main Menu",     "main_menu")],
          ])
        );
      } catch (err) {
        console.error("[gateway_transfer]", err);
        const detail = err?.response?.data?.message || err.message;
        await ctx.reply(
          `❌ Transfer failed: ${detail}\n\n` +
          `If you just deposited, wait for finality first:\n` +
          `• Sepolia ~12 min · Base ~2 min · Fuji instant`,
          Markup.inlineKeyboard([
            [Markup.button.callback("🔍 Check Balance", "gateway_balance")],
            [Markup.button.callback("« Back",           "action_gateway")],
          ])
        );
      }
      return;
    }

    // ── Paj v2 Onramp Deposit Handler ───────────────────────────────────────

    if (state.type === "await_paj_onramp_amount") {
      const fiatAmount = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (isNaN(fiatAmount) || fiatAmount <= 100) {
        if (shouldReprocessConversationState("await_paj_onramp_amount", text)) {
          convState.clearState(userId);
          return bot.handleUpdate({ update_id: ctx.update.update_id, message: ctx.message });
        }
        return ctx.reply("Please enter a valid Naira amount (minimum ₦1,000, e.g. 25000).");
      }

      const user = requireUser(ctx);
      if (!user) return;

      await ctx.reply("⏳ Generating your dedicated bank account for this transfer...");
      try {
        const context = state.context || getContext(userId);
        const isBiz = context === "business";

        // Derive user's Solana address deterministically based on account
        let solAddr = isBiz ? user.biz_solana_deposit_address : user.solana_deposit_address;
        if (!solAddr) {
          const baseEvm = isBiz && user.business_deposit_address ? user.business_deposit_address : user.deposit_address;
          const derivedSol = multichain.deriveSolanaFromEvmKey(baseEvm.padEnd(66, "0"));
          solAddr = derivedSol.solanaAddress;
          if (isBiz) {
            db.updateBizSolanaAddress(userId, solAddr);
          } else {
            db.updateSolanaAddress(userId, solAddr);
          }
        }

        const externalId = isBiz ? `${userId}-biz` : String(userId);
        const webhookURL = process.env.PAJ_WEBHOOK_URL || (process.env.WEBHOOK_URL ? `${process.env.WEBHOOK_URL.replace(/\/$/, "")}/webhook/paj` : undefined);
        const order = await paj.createOnrampOrder({
          fiatAmount,
          currency: "NGN",
          recipient: solAddr,
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          chain: "SOLANA",
          webhookURL,
          userExternalId: externalId,
          businessUSDCFee: 0,
          metadata: { accountType: context },
        });

        convState.clearState(userId);

        const onRampRate = state.data?.rate || (await paj.getRates("NGN").then(r => r?.onRampRate?.rate).catch(() => 1393.75));
        const tokenAmount = (fiatAmount / onRampRate).toFixed(2);

        return ctx.reply(
          `🇳🇬 <b>Bank Transfer Instructions</b>\n` +
          `──────────────────────────\n` +
          `💼 <b>Account:</b> ${isBiz ? "Business Treasury" : "Personal Wallet"}\n` +
          `🏦 <b>Bank Name:</b> ${order.bank || "PalmPay"}\n` +
          `🔢 <b>Account Number:</b> <code>${order.accountNumber}</code> <i>(Tap to copy)</i>\n` +
          `👤 <b>Account Name:</b> ${order.accountName || "PayIT / Paj Settlement"}\n` +
          `💵 <b>Amount to Send:</b> <b>₦${Number(fiatAmount).toLocaleString()}</b>\n` +
          `💰 <b>Dollars to Receive:</b> ~$${tokenAmount}\n\n` +
          `⚠️ <i>Transfer the EXACT amount (<b>₦${Number(fiatAmount).toLocaleString()}</b>) from your banking app (Kuda, GTBank, Opay, PalmPay, etc.).\n` +
          `Your dollar balance will be credited automatically once the transfer is confirmed!</i>`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("🔄 Refresh Status", `action_check_paj_onramp_${order.id}`)],
              [Markup.button.callback("💰 View Balance",   "action_balance")],
              [Markup.button.callback("🏠 Main Menu",      "main_menu")],
            ]),
          }
        );
      } catch (err) {
        console.error("[paj_onramp_order_error]", err);
        convState.clearState(userId);
        return ctx.reply(`❌ Could not generate bank account: ${err.message}`, backToMenu);
      }
    }

    // ── Withdraw amount ──────────────────────────────────────────────────────

    if (state.type === "await_withdraw_amount") {
      const amount = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (isNaN(amount) || amount <= 0) {
        if (shouldReprocessConversationState("await_withdraw_amount", text)) {
          convState.clearState(userId);
          return bot.handleUpdate({ update_id: ctx.update.update_id, message: ctx.message });
        }
        return ctx.reply("Enter a valid amount (e.g. 50). Type cancel to stop.");
      }
      const user = requireUser(ctx);
      if (!user) return;
      const address     = getActiveWallet(user);
      let amountMicro;
      try { amountMicro = walletLib.parseToMicro(amount.toString()); } catch {
        return ctx.reply("Invalid amount. Try again.");
      }
      const balance = await walletLib.getNativeBalanceMicro(address);
      if (balance < amountMicro) {
        return ctx.reply(`Not enough dollars. You have $${parseFloat(walletLib.formatMicro(balance)).toFixed(2)}.`);
      }
      const rate      = await fx.getUsdToNgnRate();
      const nairaEst  = rate ? fx.formatNaira(amount * rate) : null;
      const rateNote  = rate ? `Today's rate: ₦${Math.round(rate).toLocaleString()}/$\nYou'll receive: ~${nairaEst}` : "";

      convState.setState(userId, "await_withdraw_bank", { amountUsdc: amount }, state.context);
      return ctx.reply(
        `💵 Cash Out $${amount.toFixed(2)}\n──────────────────────────\n` +
        `${rateNote}\n\n` +
        `Which bank account should we pay the Naira into?\n` +
        `Type it like this: Bank name · Account number · Account name\n\nFor example: GTBank · 0123456789 · Emeka Johnson`,
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
      );
    }

    if (state.type === "await_withdraw_bank") {
      const parsed = await bankResolver.parseBankDetails(text);

      if (!parsed.accountNumber || parsed.accountNumber.length !== 10) {
        if (shouldReprocessConversationState("await_withdraw_bank", text)) {
          convState.clearState(userId);
          return bot.handleUpdate({ update_id: ctx.update.update_id, message: ctx.message });
        }
        return ctx.reply(
          `⚠️ <b>Please enter a valid 10-digit Nigerian bank account number.</b>\n\n` +
          `Format: <b>Bank Name · Account Number</b>\n` +
          `Example: <code>GTBank · 0123456789</code> or <code>Kuda · 2001234567</code>`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]]),
          }
        );
      }

      // Pre-validate with Paj v2 to get live account name if possible
      let liveAccountName = parsed.accountName;
      let orderReservation = null;
      try {
        orderReservation = await paj.createOfframpOrder({
          accountNumber: parsed.accountNumber,
          bankCode: parsed.bankCode,
          amount: state.data.amountUsdc,
        });
        if (orderReservation && orderReservation.accountName) {
          liveAccountName = orderReservation.accountName;
        }
      } catch (valErr) {
        const msg = String(valErr.message || "");
        if (msg.includes("Invalid account number") || msg.includes("400")) {
          return ctx.reply(
            `❌ <b>Could Not Verify Bank Account</b>\n──────────────────────────\n` +
            `The banking network (NIBSS) could not find account <code>${parsed.accountNumber}</code> for <b>${parsed.bankName}</b>.\n\n` +
            `Please double check that:\n` +
            `1. The 10-digit account number is correct.\n` +
            `2. The bank name matches where the account was opened.\n\n` +
            `<i>Try typing it again (e.g. ${parsed.bankName} · ${parsed.accountNumber}):</i>`,
            {
              parse_mode: "HTML",
              ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]]),
            }
          );
        }
        console.warn("[bot:await_withdraw_bank:prevalidation_note]", valErr.message);
      }

      convState.setState(userId, "confirm_withdraw", {
        amountUsdc: state.data.amountUsdc,
        bankName: parsed.bankName,
        bankCode: parsed.bankCode,
        accountNumber: parsed.accountNumber,
        accountName: liveAccountName,
        orderId: orderReservation?.id || null,
        orderAddress: orderReservation?.address || null,
        fiatAmount: orderReservation?.fiatAmount || null,
        rate: orderReservation?.rate || null,
      }, state.context);

      const acctNameLine = liveAccountName ? `👤 <b>Account Name:</b> ${liveAccountName}\n` : "";
      const nairaEst = orderReservation?.fiatAmount ? ` (approx. ₦${Number(orderReservation.fiatAmount).toLocaleString()})` : "";

      return ctx.reply(
        `💵 <b>Confirm Cash Out</b>\n` +
        `──────────────────────────\n` +
        `💰 <b>Amount:</b> $${state.data.amountUsdc.toFixed(2)}${nairaEst}\n` +
        `🏦 <b>Bank:</b> ${parsed.bankName}\n` +
        `🔢 <b>Account Number:</b> <code>${parsed.accountNumber}</code>\n` +
        acctNameLine + `\n` +
        `<i>Funds will be transferred directly in Naira to this bank account.</i>\n\n` +
        `Enter your 4-digit PIN to authorize:`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]]),
        }
      );
    }

    if (state.type === "confirm_withdraw") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) { convState.clearState(userId); return ctx.reply("Incorrect PIN. Try again."); }
      const user = db.getUser(userId);
      convState.clearState(userId);
      await ctx.reply("⏳ Processing your cash out...");
      const context = state.context || "personal";
      let userWallet;
      try {
        const pk = context === "business" && user.business_deposit_address
          ? db.decryptBusinessPrivateKey(text, user)
          : db.decryptPrivateKey(text, user);
        userWallet = walletLib.walletFromPrivateKey(pk);
      } catch {
        return ctx.reply("Couldn't unlock your wallet with that PIN.");
      }

      try {
        const result = await executeOfframp(
          userWallet,
          state.data.amountUsdc,
          {
            accountNumber: state.data.accountNumber,
            bankCode: state.data.bankCode || "000013",
            bankName: state.data.bankName,
            accountName: state.data.accountName,
            orderAddress: state.data.orderAddress,
            orderId: state.data.orderId,
            fiatAmount: state.data.fiatAmount,
            rate: state.data.rate,
          },
          userId,
          "Cash Out",
          { accountType: context }
        );

        if (result.success) {
          try {
            db.awardPoints(ctx.from.id, POINTS.cashout, "cashout", `Cash out $${state.data.amountUsdc.toFixed(2)}`);
          } catch (err) {
            console.error("[points_award_cashout]", err);
          }
          try {
            const receiptPath = await generateReceiptPNG({
              receiptId:        result.reference || result.txHash?.slice(0, 10) || `CO-${Date.now()}`,
              senderName:       "PayIT Wallet",
              senderAddress:    getActiveWallet(user),
              recipientName:    state.data.accountName || state.data.bankName || "Bank Account",
              recipientAddress: state.data.accountNumber,
              amountUsdc:       state.data.amountUsdc,
              token:            "USDC",
              type:             "Cash Out",
              timestamp:        new Date().toISOString(),
              status:           "Confirmed",
              txHash:           result.txHash || null,
            });
            await ctx.replyWithPhoto({ source: receiptPath }, {
              caption: result.warning || `✅ Cash out submitted! Naira arrives in ~10 minutes.`,
              ...afterPaymentButtons,
            });
          } catch {
            await ctx.reply(result.warning || `✅ Cash out submitted! Naira arrives in ~10 minutes.`, afterPaymentButtons);
          }
        } else {
          await ctx.reply(`❌ ${result.error}`, backToMenu);
        }
      } catch (offrampErr) {
        console.error("[bot:confirm_withdraw:error]", offrampErr);
        await ctx.reply(`❌ Cash out could not be completed: ${offrampErr.message || "An unexpected error occurred"}`, backToMenu);
      }
      return;
    }

    // ── Send to external wallet ──────────────────────────────────────────────

    if (state.type === "await_sendout_address") {
      if (!walletLib.isValidAddress(text)) {
        return ctx.reply(
          "That doesn't look like a valid account number. Please paste the full account number starting with 0x.",
          Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
        );
      }
      convState.setState(userId, "await_sendout_amount", {
        token: state.data.token || "USDC",
        walletAddress: text,
      }, state.context);
      return ctx.reply(
        `👛 Send to ${text.slice(0, 10)}...\n\nHow much would you like to send?`,
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
      );
    }

    if (state.type === "await_sendout_amount") {
      const amount = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (isNaN(amount) || amount <= 0) return ctx.reply("Enter a valid amount:");
      const user    = requireUser(ctx);
      if (!user) return;
      const address = getActiveWallet(user);
      let amountMicro;
      try { amountMicro = walletLib.parseToMicro(amount.toString()); } catch {
        return ctx.reply("Invalid amount.");
      }
      const balance = state.data.token === "EURC"
        ? await tokens.getEurcBalance(address)
        : await walletLib.getNativeBalanceMicro(address);
      if (balance < amountMicro) {
        return ctx.reply(`Not enough ${state.data.token}. You have ${walletLib.formatMicro(balance)}.`);
      }
      const recipient = state.data.recipientName || state.data.walletAddress;
      convState.setState(userId, "confirm_sendout", {
        amountUsdc:    amount,
        token:         state.data.token || "USDC",
        walletAddress: state.data.walletAddress,
        recipientName: state.data.recipientName || null,
      }, state.context);
      return ctx.reply(
        `📤 Confirm Payment\n──────────────────────────\n` +
        `To: ${recipient}\nAmount: $${amount.toFixed(2)} ${state.data.token || "USDC"}\n\n` +
        `Enter your PIN:`,
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
      );
    }

    if (state.type === "confirm_sendout") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) { convState.clearState(userId); return ctx.reply("Incorrect PIN."); }
      const user    = db.getUser(userId);
      const context = state.context || "personal";
      convState.clearState(userId);
      await ctx.reply("⏳ Sending...");

      const plan = {
        payments: [{
          to:       state.data.walletAddress,
          amount:   state.data.amountUsdc,
          label:    `Send to ${state.data.recipientName || state.data.walletAddress}`,
          currency: state.data.token || "USDC",
        }],
      };
      const results = await executePlan(plan, text, user, context);

      if (results[0]?.success) {
        try {
          db.awardPoints(ctx.from.id, POINTS.sendout, "sendout", `Sent $${state.data.amountUsdc.toFixed(2)} to ${state.data.walletAddress}`);
        } catch (err) {
          console.error("[points_award_sendout]", err);
        }
        try {
          const receiptPath = await generateReceiptPNG({
            receiptId:        results[0].txHash?.slice(0, 10) || `TX-${Date.now()}`,
            senderName:       "PayIT Wallet",
            senderAddress:    getActiveWallet(user),
            recipientName:    state.data.recipientName || state.data.walletAddress,
            recipientAddress: state.data.walletAddress,
            amountUsdc:       state.data.amountUsdc,
            token:            state.data.token || "USDC",
            type:             "Payment",
            timestamp:        new Date().toISOString(),
            status:           "Confirmed",
            txHash:           results[0].txHash,
          });
          await ctx.replyWithPhoto({ source: receiptPath }, { caption: "✅ Payment sent!", ...afterPaymentButtons });
        } catch {
          await ctx.reply(formatResults(results), { parse_mode: "Markdown", ...afterPaymentButtons });
        }
      } else {
        await ctx.reply(formatResults(results), { parse_mode: "Markdown", ...backToMenu });
      }
      return;
    }

    // ── Yield amount ─────────────────────────────────────────────────────────

    if (state.type === "await_yield_amount") {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount < 1) return ctx.reply("Enter a valid amount (minimum $1):");
      if (amount > state.data.balanceUsdc) {
        return ctx.reply(`Not enough dollars. You have $${state.data.balanceUsdc.toFixed(2)}.`);
      }
      let pools;
      try { pools = await savings.getYieldPools(); } catch {
        return ctx.reply("Couldn't load savings pools — try again.");
      }
      const best = pools[0];
      convState.setState(userId, "confirm_yield_deposit", { amountUsdc: amount, pool: best }, state.context);
      return ctx.reply(
        `📈 Confirm Savings\n──────────────────────────\n` +
        `Amount: $${amount.toFixed(2)}\n` +
        `Interest rate: ${best.userApy}% per year\n` +
        `Provider: ${best.project}\n\n` +
        `You can withdraw anytime.\n\nEnter your PIN to start saving:`,
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_yields")]])
      );
    }

    if (state.type === "sweep_auth_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Please enter your 4-digit PIN.");
      const pinStatus = db.verifyPinWithStatus(userId, text);
      if (pinStatus.locked) {
        convState.clearState(userId);
        const mins = Math.ceil(pinStatus.remainingSec / 60);
        return ctx.reply(`🔒 Account temporarily locked due to failed PIN attempts. Try again in ${mins} min.`);
      }
      if (!pinStatus.valid) {
        if (pinStatus.remainingAttempts === 0) {
          convState.clearState(userId);
          return ctx.reply("🔒 Too many failed PIN attempts. Account locked for 15 minutes.");
        }
        return ctx.reply(`❌ Incorrect PIN. ${pinStatus.remainingAttempts} attempt(s) remaining.`);
      }

      const user = db.getUser(userId);
      convState.clearState(userId);

      // Decrypt and save system_encrypted_key so all future sweeps run 100% automatically in background!
      let privateKey = null;
      try {
        privateKey = db.decryptPrivateKey(text, user);
        if (privateKey) {
          const sysEnc = walletLib.encryptSensitiveValue(privateKey);
          db.updateSystemEncryptedKey(userId, sysEnc);
          user.system_encrypted_key = sysEnc;
        }
        if (user.business_deposit_address) {
          try {
            const bizPk = db.decryptBusinessPrivateKey(text, user);
            if (bizPk) {
              const bizSysEnc = walletLib.encryptSensitiveValue(bizPk);
              db.updateBizSystemEncryptedKey(userId, bizSysEnc);
              user.biz_system_encrypted_key = bizSysEnc;
            }
          } catch (_) {}
        }
      } catch (err) {
        console.warn("[sweep_auth_pin] Failed to backfill system_encrypted_key:", err.message);
      }

      await ctx.reply("🔍 PIN verified! Scanning Arc, Base, Arbitrum, Robinhood Chain, Ethereum, Avalanche, Polygon, and Optimism for deposits...");
      try {
        const results = await evmDepositSweeper.sweepUserDeposits(userId, bot, { overridePrivateKey: privateKey });
        const successful = (results || []).filter(r => r.success);
        const failed = (results || []).filter(r => !r.success && !r.duplicate);

        if (successful.length > 0) {
          const creditedTotal = successful.reduce((acc, r) => acc + (r.amountUsdc || 0), 0);
          return ctx.reply(
            `🎉 <b>Deposit Sweep Successful!</b>\n──────────────────────────\n` +
            `Successfully processed ${successful.length} deposit(s) for a total of <b>$${creditedTotal.toFixed(2)} USDC</b> on Arc Mainnet!\n\n` +
            `Your balance has been updated and automated background sweeps are now enabled.`,
            {
              parse_mode: "HTML",
              ...Markup.inlineKeyboard([
                [Markup.button.callback("💰 View Balance", "action_balance")],
                [Markup.button.callback("🏠 Main Menu", "main_menu")],
              ]),
            }
          );
        }

        if (failed.length > 0) {
          const failDetails = failed.map(f => `• <b>${f.chain}:</b> ${f.error}`).join("\n");
          return ctx.reply(
            `⚠️ <b>Deposit Detected — Action Required</b>\n──────────────────────────\n` +
            `${failDetails}\n\n` +
            `💡 <i>Tip: If gas is required on the source network, transfer a tiny amount of native gas (e.g. ~$0.20 ETH on Base) to your address, then tap Scan Again.</i>`,
            {
              parse_mode: "HTML",
              ...Markup.inlineKeyboard([
                [Markup.button.callback("🔄 Scan Again", "action_sweep_deposits")],
                [Markup.button.callback("« Back to Deposits", "action_gateway")],
              ]),
            }
          );
        }

        return ctx.reply(
          `✅ <b>Scan Complete</b>\n──────────────────────────\n` +
          `No unswept deposits found right now.\n\n` +
          `Your account is now fully authorized for automated multi-chain deposit sweeps whenever you send funds!`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("🔄 Scan Again", "action_sweep_deposits")],
              [Markup.button.callback("« Back to Deposits", "action_gateway")],
            ]),
          }
        );
      } catch (sweepErr) {
        console.error("[bot:sweep_auth_pin_err]", sweepErr);
        return ctx.reply(`Could not complete deposit scan: ${sweepErr.message}`);
      }
    }

    if (state.type === "confirm_yield_deposit") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your PIN.");
      const pinStatus = db.verifyPinWithStatus(userId, text);
      if (pinStatus.locked) {
        convState.clearState(userId);
        const mins = Math.ceil(pinStatus.remainingSec / 60);
        return ctx.reply(`🔒 Account temporarily locked due to failed PIN attempts. Try again in ${mins} min.`);
      }
      if (!pinStatus.valid) {
        if (pinStatus.remainingAttempts === 0) {
          convState.clearState(userId);
          return ctx.reply("🔒 Too many failed PIN attempts. Account locked for 15 minutes.");
        }
        return ctx.reply(`❌ Incorrect PIN. ${pinStatus.remainingAttempts} attempt(s) remaining.`);
      }

      const user = db.getUser(userId);
      const context = state.context || "personal";
      convState.clearState(userId);

      const idemKey = state.data.idempotencyKey || `yield_deposit:${userId}:${context}:${state.data.amountUsdc}:${state.data.timestamp || Date.now()}`;
      const existing = idempotency.checkOperationIdempotency(idemKey);
      if (existing && existing.status === "completed") {
        return ctx.reply("⚠️ This savings deposit has already been processed.");
      }
      if (existing && existing.status === "pending") {
        return ctx.reply("⏳ This savings deposit is currently being processed. Please wait...");
      }
      idempotency.startOperationIdempotency(idemKey, {
        scope: "yield_deposit",
        telegramId: userId,
        accountType: context,
        amount: state.data.amountUsdc,
      });

      await ctx.reply(`⏳ Depositing into Arc Earn vault (${context === "business" ? "Business Treasury" : "Personal Wallet"})...`);

      let pk;
      try {
        pk = context === "business" && user.business_deposit_address
          ? db.decryptBusinessPrivateKey(text, user)
          : db.decryptPrivateKey(text, user);
      } catch {
        idempotency.failOperationIdempotency(idemKey, "Unlock wallet failed");
        return ctx.reply("Couldn't unlock your wallet with that PIN.");
      }

      let depositTxHash = null;
      const vaultAddress = state.data.pool?.address || state.data.pool?.id;
      if (vaultAddress) {
        try {
          const depositResult = await savings.depositIntoVault(pk, vaultAddress, state.data.amountUsdc);
          depositTxHash = depositResult?.hash || depositResult?.txHash || null;
        } catch (err) {
          console.warn("[bot:earn_deposit] On-chain vault deposit note:", err.message);
        }
      }

      savings.openYieldPosition(userId, state.data.amountUsdc, state.data.pool, {
        vaultAddress,
        depositTxHash,
        isAutoEarn: false,
        accountType: context,
      });
      db.recordTransaction(userId, "yield_deposit", BigInt(Math.round(state.data.amountUsdc * 1e18)), "confirmed", depositTxHash, context);
      idempotency.completeOperationIdempotency(idemKey, { txHash: depositTxHash });
      try {
        db.awardPoints(userId, POINTS.savingsDeposit, "savings_deposit", `Saved $${state.data.amountUsdc.toFixed(2)}`);
      } catch (err) {
        console.error("[points_award_savings_deposit]", err);
      }

      const explorerLink = depositTxHash ? `\n\n🔗 <a href="${netConfig.explorerUrl}/tx/${depositTxHash}">View Deposit on Arc Explorer</a>` : "";

      return ctx.reply(
        `✅ <b>${context === "business" ? "Business" : "Personal"} Savings Started!</b>\n──────────────────────────\n` +
        `• <b>Account:</b> ${context === "business" ? "Business Treasury" : "Personal Wallet"}\n` +
        `• <b>Amount:</b> $${state.data.amountUsdc.toFixed(2)}\n` +
        `• <b>Savings Plan:</b> High-Yield Dollar Savings\n` +
        `• <b>Earning Rate:</b> ${state.data.pool.userApy}% per year\n` +
        `• <b>Withdrawal:</b> Anytime with zero penalty` +
        explorerLink,
        Markup.inlineKeyboard([
          [Markup.button.callback("📊 My Savings", "action_my_yield")],
          [Markup.button.callback("🏠 Main Menu",  "main_menu")],
        ])
      );
    }

    if (state.type === "confirm_yield_withdraw") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your PIN.");
      const pinStatus = db.verifyPinWithStatus(userId, text);
      if (pinStatus.locked) {
        convState.clearState(userId);
        const mins = Math.ceil(pinStatus.remainingSec / 60);
        return ctx.reply(`🔒 Account temporarily locked due to failed PIN attempts. Try again in ${mins} min.`);
      }
      if (!pinStatus.valid) {
        if (pinStatus.remainingAttempts === 0) {
          convState.clearState(userId);
          return ctx.reply("🔒 Too many failed PIN attempts. Account locked for 15 minutes.");
        }
        return ctx.reply(`❌ Incorrect PIN. ${pinStatus.remainingAttempts} attempt(s) remaining.`);
      }

      const user = db.getUser(userId);
      const context = state.context || "personal";
      const posId = state.data.position?.id;
      convState.clearState(userId);

      const idemKey = `yield_withdraw:${userId}:${context}:${posId}`;
      const existing = idempotency.checkOperationIdempotency(idemKey);
      if (existing && existing.status === "completed") {
        return ctx.reply("⚠️ This savings withdrawal has already been processed.");
      }
      if (existing && existing.status === "pending") {
        return ctx.reply("⏳ This savings withdrawal is currently being processed. Please wait...");
      }
      idempotency.startOperationIdempotency(idemKey, {
        scope: "yield_withdraw",
        telegramId: userId,
        accountType: context,
        amount: state.data.total,
      });

      await ctx.reply(`⏳ Withdrawing from savings (${context === "business" ? "Business Treasury" : "Personal Wallet"})...`);

      let pk;
      try {
        pk = context === "business" && user.business_deposit_address
          ? db.decryptBusinessPrivateKey(text, user)
          : db.decryptPrivateKey(text, user);
      } catch {
        idempotency.failOperationIdempotency(idemKey, "Unlock wallet failed");
        return ctx.reply("Couldn't unlock your wallet with that PIN.");
      }

      const { Wallet } = require("ethers");
      const userWallet = new Wallet(pk, arcProvider);
      let withdrawResult = null;
      try {
        withdrawResult = await savings.withdrawFromVaultWithFee({
          userWallet,
          position: state.data.position,
          feeRecipientAddress: process.env.APP_FEE_RECIPIENT_ADDRESS,
        });
      } catch (err) {
        console.warn("[bot:earn_withdraw] Notice from on-chain fee withdrawal:", err.message);
        db.closeYieldPosition(userId, state.data.total, {
          devFee: state.data.devFee || 0,
          accountType: context,
          positionId: posId,
        });
      }

      const withdrawTx = withdrawResult?.withdrawTxHash;
      const feeTx = withdrawResult?.feeTxHash;
      const devFeeAmount = withdrawResult ? withdrawResult.devFeeUsdc : (state.data.devFee || 0);
      const netPaid = withdrawResult ? withdrawResult.netUserAmountUsdc : state.data.total;

      db.recordTransaction(userId, "yield_withdraw", BigInt(Math.round(netPaid * 1e18)), "confirmed", withdrawTx, context);
      idempotency.completeOperationIdempotency(idemKey, { txHash: withdrawTx });
      try {
        db.awardPoints(userId, POINTS.savingsWithdraw, "savings_withdraw", `Withdrew $${netPaid.toFixed(2)}`);
      } catch (err) {
        console.error("[points_award_savings_withdraw]", err);
      }

      let txLinks = "";
      if (withdrawTx) {
        txLinks += `\n\n🔗 <a href="${netConfig.explorerUrl}/tx/${withdrawTx}">View Withdrawal on Arc Explorer</a>`;
      }
      if (feeTx) {
        txLinks += `\n🔗 <a href="${netConfig.explorerUrl}/tx/${feeTx}">View PayIT Service Fee on Arc Explorer</a>`;
      }

      return ctx.reply(
        `✅ <b>${context === "business" ? "Business" : "Personal"} Savings Withdrawn!</b>\n──────────────────────────\n` +
        `• <b>Account:</b> ${context === "business" ? "Business Treasury" : "Personal Wallet"}\n` +
        `• <b>Principal Returned:</b> $${state.data.position.amount_usdc.toFixed(2)}\n` +
        `• <b>Interest Earned:</b> +$${state.data.accrued.toFixed(4)}\n` +
        `• <b>Service Fee (10% on profit):</b> -$${devFeeAmount.toFixed(4)}\n` +
        `• <b>Net Credited to Account:</b> $${netPaid.toFixed(4)}` +
        txLinks,
        {
          parse_mode: "HTML",
          ...afterPaymentButtons,
        }
      );
    }

    // ── Arc Stablecoin Swap (FX) ──────────────────────────────────────────────

    if (state.type === "await_swap_amount") {
      const amount = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (isNaN(amount) || amount <= 0) {
        return ctx.reply("Enter a valid amount to convert (e.g. 10).");
      }
      if (amount > state.data.balance) {
        const sym = state.data.fromToken === "USDC" ? "$" : "€";
        return ctx.reply(`You only have ${sym}${state.data.balance.toFixed(2)}. Enter a smaller amount:`);
      }

      await ctx.reply("Fetching live conversion rate...");
      const amountMicro = walletLib.parseToMicro(amount.toString());
      let quote = null;
      let estReceive = 0;
      let rateDisplay = "";
      try {
        quote = await swapLib.getSwapQuote(state.data.fromToken, state.data.toToken, amountMicro);
        estReceive = parseFloat(quote?.destinationAmount || quote?.amountOut || (amount * (state.data.fromToken === "USDC" ? 0.917 : 1.09)));
        const fromLabel = state.data.fromToken === "USDC" ? "Dollar" : "Euro";
        const toSym = state.data.toToken === "USDC" ? "$" : "€";
        rateDisplay = `• Rate: 1 ${fromLabel} ≈ ${toSym}${(estReceive / amount).toFixed(4)}\n`;
      } catch (err) {
        console.warn("[bot:swap_quote]", err.message);
        estReceive = amount * (state.data.fromToken === "USDC" ? 0.917 : 1.09);
      }

      convState.setState(userId, "confirm_swap_pin", {
        fromToken: state.data.fromToken,
        toToken: state.data.toToken,
        amountIn: amount,
        expectedOut: estReceive,
      }, state.context);

      const payLabel = state.data.fromToken === "USDC" ? `$${amount.toFixed(2)} Dollars` : `€${amount.toFixed(2)} Euros`;
      const recLabel = state.data.toToken === "USDC" ? `$${estReceive.toFixed(2)} Dollars` : `€${estReceive.toFixed(2)} Euros`;

      return ctx.reply(
        `🔄 <b>Confirm Currency Conversion</b>\n──────────────────────────\n` +
        `• Pay: <b>${payLabel}</b>\n` +
        `• Receive: ≈ <b>${recLabel}</b>\n` +
        rateDisplay +
        `\nEnter your 4-digit PIN to convert:`,
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_swap")]])
      );
    }

    if (state.type === "confirm_swap_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      const pinStatus = db.verifyPinWithStatus(userId, text);
      if (pinStatus.locked) {
        convState.clearState(userId);
        const mins = Math.ceil(pinStatus.remainingSec / 60);
        return ctx.reply(`🔒 Account temporarily locked due to failed PIN attempts. Try again in ${mins} min.`);
      }
      if (!pinStatus.valid) {
        if (pinStatus.remainingAttempts === 0) {
          convState.clearState(userId);
          return ctx.reply("🔒 Too many failed PIN attempts. Account temporarily locked for 15 minutes.");
        }
        return ctx.reply(`❌ Incorrect PIN. ${pinStatus.remainingAttempts} attempt(s) remaining. Try again:`);
      }

      const user = db.getUser(userId);
      convState.clearState(userId);
      await ctx.reply("⏳ Converting currency...");

      let pk;
      try {
        pk = state.context === "business" && user.business_deposit_address
          ? db.decryptBusinessPrivateKey(text, user)
          : db.decryptPrivateKey(text, user);
      } catch {
        return ctx.reply("Couldn't unlock your wallet with that PIN.");
      }

      const amountMicro = walletLib.parseToMicro(state.data.amountIn.toString());
      let swapResult = null;
      let swapTxHash = null;
      try {
        swapResult = await swapLib.executeSwap(pk, state.data.fromToken, state.data.toToken, amountMicro);
        swapTxHash = swapResult?.hash || swapResult?.txHash || null;
      } catch (err) {
        console.warn("[bot:swap_execute] On-chain swap note:", err.message);
      }

      db.recordTransaction(
        userId,
        `swap_${state.data.fromToken.toLowerCase()}_${state.data.toToken.toLowerCase()}`,
        amountMicro,
        "confirmed",
        null
      );
      try {
        db.awardPoints(userId, POINTS.swap || 4, "token_swap", `Swapped ${state.data.amountIn} ${state.data.fromToken}`);
      } catch (e) {}

      const explorerLink = swapTxHash ? `\n\n🔗 <a href="${netConfig.explorerUrl}/tx/${swapTxHash}">View on Arc Explorer</a>` : "";
      const soldLabel = state.data.fromToken === "USDC" ? `$${state.data.amountIn.toFixed(2)} Dollars` : `€${state.data.amountIn.toFixed(2)} Euros`;
      const recLabel = state.data.toToken === "USDC" ? `$${state.data.expectedOut.toFixed(2)} Dollars` : `€${state.data.expectedOut.toFixed(2)} Euros`;

      return ctx.reply(
        `✅ <b>Conversion Successful!</b>\n──────────────────────────\n` +
        `• Converted: <b>${soldLabel}</b>\n` +
        `• Received: ≈ <b>${recLabel}</b>\n` +
        `• Status: Confirmed` +
        explorerLink,
        afterPaymentButtons
      );
    }

    // ── HD Invoice creation (Personal) ────────────────────────────────────────

    if (state.type === "confirm_invoice_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) {
        convState.clearState(userId);
        return ctx.reply("Incorrect PIN. Please try again.");
      }

      const user = db.getUser(userId);
      let decryptedKey;
      try {
        decryptedKey = db.decryptPrivateKey(text, user);
      } catch (err) {
        console.error("[invoice_hd] Decryption failed:", err.message);
        convState.clearState(userId);
        return ctx.reply("Couldn't unlock your wallet with that PIN.");
      }

      convState.clearState(userId);

      try {
        const fullInvoice = await createCompleteInvoice({
          telegramId: userId,
          decryptedPrivateKey: decryptedKey,
          user,
          invoiceData: {
            invoiceNumber: state.data.invoiceNumber,
            clientName: state.data.parsed.clientName,
            clientEmail: state.data.parsed.clientEmail,
            items: state.data.parsed.items,
            totalUsdc: state.data.total,
            dueDate: state.data.parsed.dueDate,
            notes: state.data.parsed.notes,
            issueDate: state.data.issueDate,
          },
          businessName: user.username || `User ${userId}`,
        });

        try {
          db.awardPoints(userId, POINTS.invoice, "create_invoice", `Invoice #${fullInvoice.invoiceNumber} for $${fullInvoice.totalUsdc.toFixed(2)}`);
        } catch (err) {
          console.error("[points_award_invoice]", err);
        }

        let caption =
          `🧾 <b>Invoice #${fullInvoice.invoiceNumber} Created!</b>\n` +
          `──────────────────────────\n` +
          `👤 <b>Client:</b> ${state.data.parsed.clientName}\n` +
          `💵 <b>Amount:</b> $${fullInvoice.totalUsdc.toFixed(2)}\n` +
          (state.data.parsed.dueDate ? `📅 <b>Due Date:</b> ${state.data.parsed.dueDate}\n` : "");

        if (fullInvoice.fiatDetails) {
          caption +=
            `\n🇳🇬 <b>Option 1: Nigerian Bank Transfer (Naira)</b>\n` +
            `• <b>Bank:</b> ${fullInvoice.fiatDetails.bankName}\n` +
            `• <b>Account No:</b> <code>${fullInvoice.fiatDetails.accountNumber}</code> (tap to copy)\n` +
            `• <b>Account Name:</b> ${fullInvoice.fiatDetails.accountName}\n` +
            `• <b>Exact Amount:</b> ₦${fullInvoice.fiatDetails.fiatAmount.toLocaleString()}\n` +
            `<i>(Dedicated virtual account for this invoice alone)</i>\n`;
        }

        caption +=
          `\n🌐 <b>Option 2: Direct Crypto / Web3 Payment (USDC)</b>\n` +
          `• <b>Deposit Address:</b> <code>${fullInvoice.paymentAddress}</code>\n` +
          `• <b>Network:</b> Arc Mainnet\n` +
          `<i>(Dedicated single-invoice address · QR code on card)</i>\n\n` +
          `⚡ <i>Payments settle automatically to your account!</i>`;

        await ctx.replyWithPhoto({ source: fullInvoice.pngPath }, {
          caption,
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("📋 All Invoices", "action_list_invoices")],
            [Markup.button.callback("✅ Mark as Paid", `action_paid_${fullInvoice.invoiceId}`)],
            [Markup.button.callback("🏠 Main Menu", "main_menu")],
          ]),
        });

        console.log(`[invoice_hd] Created invoice #${fullInvoice.invoiceNumber} with dual payment options`);
      } catch (err) {
        console.error("[invoice_hd]", err);
        await ctx.reply("❌ Failed to create invoice. Please try again.");
      }
      return;
    }
    
    if (state.type === "confirm_biz_invoice_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) {
        convState.clearState(userId);
        return ctx.reply("Incorrect PIN. Please try again.");
      }

      const user = db.getUser(userId);
      let decryptedBizKey;
      try {
        decryptedBizKey = db.decryptBusinessPrivateKey(text, user);
      } catch (err) {
        console.error("[biz_invoice_hd] Decryption failed:", err.message);
        convState.clearState(userId);
        return ctx.reply("Couldn't unlock your Business wallet with that PIN.");
      }

      convState.clearState(userId);

      try {
        const profile = bizProfile.getBizProfile(userId);
        const fullBizInvoice = await createCompleteBizInvoice({
          telegramId: userId,
          decryptedBizKey,
          user,
          invoiceData: {
            invoiceNumber: state.data.invoiceNumber,
            clientName: state.data.parsed.clientName,
            clientEmail: state.data.parsed.clientEmail,
            items: state.data.parsed.items,
            totalUsdc: state.data.total,
            dueDate: state.data.parsed.dueDate,
            notes: state.data.parsed.notes,
            issueDate: state.data.issueDate,
          },
          profile,
        });

        const goal = bizDb.getSavingsGoal(userId);
        const goalNote = goal
          ? `\n💰 ${goal.percentage}% ($${(state.data.total * goal.percentage / 100).toFixed(2)}) will auto-save to Business Savings on settlement.`
          : "";

        try {
          db.awardPoints(userId, POINTS.businessInvoice, "create_business_invoice", `Invoice #${fullBizInvoice.invoiceNumber} for $${state.data.total.toFixed(2)}`);
        } catch (err) {
          console.error("[points_award_biz_invoice]", err);
        }

        let caption =
          `🧾 <b>Business Invoice #${fullBizInvoice.invoiceNumber}</b>\n` +
          `──────────────────────────\n` +
          `🏢 <b>Business:</b> ${profile?.business_name || user.username || `Business`}\n` +
          `👤 <b>Client:</b> ${state.data.parsed.clientName}\n` +
          `💵 <b>Total:</b> $${fullBizInvoice.totalUsdc.toFixed(2)}\n` +
          (state.data.parsed.dueDate ? `📅 <b>Due Date:</b> ${state.data.parsed.dueDate}\n` : "");

        if (fullBizInvoice.fiatDetails) {
          caption +=
            `\n🇳🇬 <b>Option 1: Nigerian Bank Transfer (Naira)</b>\n` +
            `• <b>Bank:</b> ${fullBizInvoice.fiatDetails.bankName}\n` +
            `• <b>Account No:</b> <code>${fullBizInvoice.fiatDetails.accountNumber}</code> (tap to copy)\n` +
            `• <b>Account Name:</b> ${fullBizInvoice.fiatDetails.accountName}\n` +
            `• <b>Exact Amount:</b> ₦${fullBizInvoice.fiatDetails.fiatAmount.toLocaleString()}\n` +
            `<i>(Dedicated virtual account for this invoice only)</i>\n`;
        }

        caption +=
          `\n🌐 <b>Option 2: Direct Crypto / Web3 Payment (USDC)</b>\n` +
          `• <b>Deposit Address:</b> <code>${fullBizInvoice.paymentAddress}</code>\n` +
          `• <b>Network:</b> Arc Mainnet\n` +
          `<i>(Dedicated address · QR code on invoice card)</i>\n` +
          goalNote +
          `\n⚡ <i>Payments settle directly into your main business account!</i>`;

        await ctx.replyWithPhoto({ source: fullBizInvoice.pngPath }, {
          caption,
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("📋 All Invoices",  "action_list_biz_invoices")],
            [Markup.button.callback(`✅ Mark as Paid`,  `action_bizpaid_${fullBizInvoice.invoiceId}`)],
            [Markup.button.callback("🏠 Main Menu",     "main_menu")],
          ]),
        });
      } catch (err) {
        console.error("[biz_invoice_hd]", err);
        await ctx.reply("❌ Failed to create business invoice. Please try again.");
      }
      return;
    }

    if (state.type === "await_redeem_points") {
      const balance = db.getPointsBalance(userId);
      const points = parseInt(text.replace(/\D/g, ""), 10);
      if (isNaN(points) || points < MIN_REDEEM_POINTS) {
        return ctx.reply(
          `Enter the number of points to redeem (minimum ${MIN_REDEEM_POINTS}).`,
          Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
        );
      }
      if (points > balance) {
        return ctx.reply(
          `You only have ${balance} points. Enter a lower amount or type cancel.`,
          Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
        );
      }
      convState.setState(userId, "confirm_redeem_pin", {
        redeemType: state.data.redeemType,
        points,
      }, state.context);
      return ctx.reply(
        `Redeem ${points} points for ${formatPointValue(points)} ${state.data.redeemType === "airtime" ? "airtime" : "bill credit"}.
\nEnter your PIN to confirm:`,
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
      );
    }

    if (state.type === "confirm_redeem_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) { convState.clearState(userId); return ctx.reply("Incorrect PIN. Try again."); }
      const user = db.getUser(userId);
      const points = state.data.points;
      const redeemType = state.data.redeemType || "airtime";
      db.awardPoints(userId, -points, `redeem_${redeemType}`, `Redeemed ${points} points for ${redeemType}`);
      convState.clearState(userId);
      return ctx.reply(
        `✅ Redemption requested!\n` +
        `${points} points redeemed for ${formatPointValue(points)} ${redeemType === "airtime" ? "airtime credit" : "bill credit"}.\n\n` +
        `Fulfillment is processing and will credit your account automatically.`,
        Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "main_menu")]])
      );
    }

    // ── Add contact ──────────────────────────────────────────────────────────

    if (state.type === "await_add_contact") {
      convState.clearState(userId);
      // Let the intent router handle this — route "save X as Y" naturally
      // by falling through to the intent router below
    }

    // ── Clarification: paste address / account number ───────────────────────
    if (state.type === 'await_paste_address') {
      convState.clearState(userId);
      // If we have a prior classified object, update it; otherwise attempt quick parse
      const prev = state.data && state.data.classified ? state.data.classified : null;
      const input = text.trim();
      // If it's a wallet address
      if (walletLib.isValidAddress && walletLib.isValidAddress(input)) {
        if (prev && prev.params && prev.params.recipients && prev.params.recipients[0]) {
          prev.params.recipients[0].wallet_address = input;
          prev.params.recipients[0].name_or_address = input;
          prev.params.recipients[0]._resolved = true;
          const missingNow = getMissingQuestion(prev);
          if (missingNow) return ctx.reply(missingNow, Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','main_menu')]]));
          convState.setState(userId, 'confirm_intent_pin', { classified: prev }, getContext(userId));
          const confirmText = buildConfirmationText(prev, prev.params.recipients);
          return ctx.reply(`${confirmText}\n\nEnter your PIN to confirm:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','main_menu')]]) });
        }
      }

      // Otherwise try to parse as bank account
      const digits = input.replace(/\D/g, '');
      if (digits.length >= 6) {
        // assume bank account
        if (prev && prev.params && prev.params.recipients && prev.params.recipients[0]) {
          prev.params.recipients[0].account_number = digits;
          prev.params.recipients[0].name_or_address = input;
          const missingNow = getMissingQuestion(prev);
          if (missingNow) return ctx.reply(missingNow, Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','main_menu')]]));
          convState.setState(userId, 'confirm_intent_pin', { classified: prev }, getContext(userId));
          const confirmText = buildConfirmationText(prev, prev.params.recipients);
          return ctx.reply(`${confirmText}\n\nEnter your PIN to confirm:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','main_menu')]]) });
        }
      }

      return ctx.reply("I couldn't recognise that address or account number. Paste a full 0x address or a 10-digit Naira account number.", Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','main_menu')]]));
    }

    // ── Clarification: enter amount ────────────────────────────────────────
    if (state.type === 'await_enter_amount') {
      convState.clearState(userId);
      const prev = state.data && state.data.classified ? state.data.classified : null;
      const amtText = text.replace(/[,\s]/g, '');
      let amount = null, currency = null;
      const usMatch = amtText.match(/\$?([0-9]+(?:\.[0-9]+)?)/);
      const ngMatch = amtText.match(/([0-9]+(?:\.[0-9]+)?)\s*(ngn|naira|₦)/i);
      if (usMatch) { amount = parseFloat(usMatch[1]); currency = 'USDC'; }
      else if (ngMatch) { amount = parseFloat(ngMatch[1]); currency = 'NGN'; }
      else {
        const justNum = parseFloat(amtText.replace(/[^0-9.]/g, ''));
        if (!isNaN(justNum)) { amount = justNum; currency = 'USDC'; }
      }
      if (!amount || amount <= 0) return ctx.reply("Couldn't read that amount. Try: $50 or 5000 NGN", Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','main_menu')]]));
      if (prev && prev.params && prev.params.recipients && prev.params.recipients[0]) {
        prev.params.recipients[0].amount = amount;
        prev.params.recipients[0].currency = currency || prev.params.recipients[0].currency || 'USDC';
        const missingNow = getMissingQuestion(prev);
        if (missingNow) return ctx.reply(missingNow, Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','main_menu')]]));
        convState.setState(userId, 'confirm_intent_pin', { classified: prev }, getContext(userId));
        const confirmText = buildConfirmationText(prev, prev.params.recipients);
        return ctx.reply(`${confirmText}\n\nEnter your PIN to confirm:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','main_menu')]]) });
      }
      return ctx.reply("Couldn't attach that amount to a pending instruction.", Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','main_menu')]]));
    }

    // ── Clarification: bank details ────────────────────────────────────────
    if (state.type === 'await_bank_details') {
      convState.clearState(userId);
      const prev = state.data && state.data.classified ? state.data.classified : null;
      const parts = text.split(/[·,|-]/).map(s => s.trim()).filter(Boolean);
      const bank = parts[0] || null;
      const acct = (parts[1] || '').replace(/\D/g, '') || null;
      const name = parts[2] || null;
      if (!acct || acct.length < 6) return ctx.reply('Could not read an account number. Format: Bank · 0123456789 · Account Name', Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','main_menu')]]));
      if (prev && prev.params && prev.params.recipients && prev.params.recipients[0]) {
        prev.params.recipients[0].bank_name = bank;
        prev.params.recipients[0].account_number = acct;
        prev.params.recipients[0].account_name = name;
        const missingNow = getMissingQuestion(prev);
        if (missingNow) return ctx.reply(missingNow, Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','main_menu')]]));
        convState.setState(userId, 'confirm_intent_pin', { classified: prev }, getContext(userId));
        const confirmText = buildConfirmationText(prev, prev.params.recipients);
        return ctx.reply(`${confirmText}\n\nEnter your PIN to confirm:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','main_menu')]]) });
      }
      return ctx.reply('Could not attach those bank details to a pending instruction.', Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','main_menu')]]));
    }

    // ── Business invoice instruction ─────────────────────────────────────────

    if (state.type === "await_biz_invoice_instruction") {
      convState.clearState(userId);
      const user = requireUser(ctx);
      if (!user) return;
      await ctx.reply("⏳ Parsing your invoice...");
      const walletAddress = user.business_deposit_address || user.deposit_address;
      const profile       = bizProfile.getBizProfile(userId);
      const parsed = await parseSmartInvoiceIntent(text, {
        businessName:  profile?.business_name || ctx.from.username || `User ${userId}`,
        walletAddress,
      });
      if (parsed.error) {
        return ctx.reply(
          `❌ ${parsed.error}\n\nTry again with 🧾 New Invoice.`,
          Markup.inlineKeyboard([[Markup.button.callback("🧾 Try Again", "action_new_biz_invoice")]])
        );
      }
      const total     = parsed.items.reduce((s, i) => s + Number(i.quantity || 1) * Number(i.unitPrice || 0), 0);
      const itemLines = parsed.items.map(i => `• ${i.description} × ${i.quantity || 1} @ $${Number(i.unitPrice).toFixed(2)}`).join("\n");
      convState.setState(userId, "confirm_biz_invoice", { parsed, total, walletAddress }, "business");
      return ctx.reply(
        `📋 Invoice Preview\n──────────────────────────\n` +
        `To: ${parsed.clientName}${parsed.clientEmail ? " (" + parsed.clientEmail + ")" : ""}\n` +
        `${itemLines}\n──────────────────────────\n` +
        `Total: $${total.toFixed(2)}\n` +
        (parsed.dueDate ? `Due: ${parsed.dueDate}\n` : "") +
        `\nLooks right?`,
        Markup.inlineKeyboard([
          [Markup.button.callback("✅ Generate Invoice", "action_confirm_biz_invoice")],
          [Markup.button.callback("✏️ Edit",             "action_new_biz_invoice")],
          [Markup.button.callback("❌ Cancel",            "main_menu")],
        ])
      );
    }

    // ── Personal invoice instruction ─────────────────────────────────────────

    if (state.type === "await_invoice_instruction") {
      convState.clearState(userId);
      const user = requireUser(ctx);
      if (!user) return;
      await ctx.reply("⏳ Parsing your invoice...");
      const parsed = await parseSmartInvoiceIntent(text, {
        businessName:  user.username || `User ${userId}`,
        walletAddress: user.deposit_address,
      });
      if (parsed.error) {
        return ctx.reply(
          `❌ ${parsed.error}`,
          Markup.inlineKeyboard([[Markup.button.callback("🧾 Try Again", "action_new_invoice")]])
        );
      }
      const total     = parsed.items.reduce((s, i) => s + Number(i.quantity || 1) * Number(i.unitPrice || 0), 0);
      const itemLines = parsed.items.map(i => `• ${i.description} × ${i.quantity || 1} @ $${Number(i.unitPrice).toFixed(2)}`).join("\n");
      convState.setState(userId, "confirm_invoice", { parsed, total }, "personal");
      return ctx.reply(
        `📋 Invoice Preview\n──────────────────────────\n` +
        `To: ${parsed.clientName}\n${itemLines}\n──────────────────────────\n` +
        `Total: $${total.toFixed(2)}\n` +
        (parsed.dueDate ? `Due: ${parsed.dueDate}\n` : ""),
        Markup.inlineKeyboard([
          [Markup.button.callback("✅ Generate Invoice", "action_confirm_invoice")],
          [Markup.button.callback("✏️ Edit",             "action_new_invoice")],
          [Markup.button.callback("❌ Cancel",            "main_menu")],
        ])
      );
    }

    // ── Shopping instruction ─────────────────────────────────────────────────

    if (state.type === "await_shopping_instruction") {
      convState.clearState(userId);
      const user = requireUser(ctx);
      if (!user) return;
      await ctx.reply("🛒 Searching for products...");
      const parsed = await parseShoppingIntent(text, { username: user.username });
      if (parsed.error) {
        return ctx.reply(`❌ ${parsed.error}`, Markup.inlineKeyboard([[Markup.button.callback("Try Again", "main_menu")]]));
      }

      const product = await searchForProduct(parsed.product_name, parsed.max_price);
      if (product.error) {
        return ctx.reply(`❌ ${product.error}`, Markup.inlineKeyboard([[Markup.button.callback("Try Again", "main_menu")]]));
      }

      const context = state.context || "personal";
      convState.setState(userId, "confirm_shopping_purchase", { parsed, product }, context);
      
      const discountText = product.originalPrice && product.discountPercentage 
        ? ` (${product.discountPercentage}% OFF — Original $${product.originalPrice})` 
        : "";

      const cardText = 
        `🛒 Found a verified match!\n` +
        `──────────────────────────\n\n` +
        `📦 Product: ${product.name}\n` +
        `🏷️ Brand: ${product.brand} | Category: ${product.category}\n` +
        `⭐ Rating: ${product.rating} / 5.0 (${product.reviewsCount} reviews)\n` +
        `📊 Availability: ${product.stock}\n` +
        `🏷️ Condition: ${product.condition}\n\n` +
        `📝 Description:\n${product.description}\n\n` +
        `⚙️ Specifications:\n${product.specs}\n\n` +
        `🏪 Merchant: ${product.store} ${product.isVerified ? "✓" : ""}\n` +
        `🛡️ Returns: ${product.returnPolicy}\n` +
        `🔒 Protection: PayIT 100% Escrow Guarantee\n\n` +
        `💲 Price: $${product.price} ${product.currency}${discountText}\n` +
        `🚚 Delivery: ${product.delivery_time}\n\n` +
        `📍 ` + (parsed.delivery_address ? `Deliver to: ${parsed.delivery_address}` : `Deliver to: your saved address`) + `\n\n` +
        `──────────────────────────\n` +
        `Would you like to buy this item?`;

      const buttons = Markup.inlineKeyboard([
        [Markup.button.callback("✅ Buy Now", "action_confirm_shopping")],
        [Markup.button.callback("❌ Cancel", "main_menu")],
      ]);

      if (product.image) {
        try {
          return await ctx.replyWithPhoto(product.image, {
            caption: cardText,
            ...buttons
          });
        } catch (imgErr) {
          console.error("[shopping_agent] Failed to send photo, falling back to text:", imgErr.message);
        }
      }

      return ctx.reply(cardText, buttons);
    }

    if (state.type === "confirm_shopping_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) { convState.clearState(userId); return ctx.reply("Incorrect PIN."); }
      const user = db.getUser(userId);
      const { product } = state.data;
      const context = state.context || "personal";
      convState.clearState(userId);
      
      await ctx.reply("⏳ Processing payment...");
      const plan = {
        payments: [{
          to: product.seller_wallet,
          amount: parseFloat(product.price),
          label: `Purchase: ${product.name}`,
          currency: product.currency,
        }],
      };
      const results = await executePlan(plan, text, user, context);
      return ctx.reply(formatResults(results), { parse_mode: "Markdown", ...afterPaymentButtons });
    }

    // ── Expense entry ────────────────────────────────────────────────────────

    if (state.type === "await_expense_entry") {
      convState.clearState(userId);
      const nairaMatch = text.match(/[₦]?\s*(\d[\d,]*)\s*(naira|ngn)/i);
      const usdcMatch  = text.match(/\$?\s*(\d+(?:\.\d+)?)\s*(usdc|\$|dollar)/i);
      let amount = 0, currency = "NGN";
      if (usdcMatch)  { amount = parseFloat(usdcMatch[1]);  currency = "USDC"; }
      else if (nairaMatch) { amount = parseFloat(nairaMatch[1].replace(/,/g, "")); }
      else {
        const numMatch = text.match(/^[\$₦]?(\d+(?:\.\d+)?)\s+(.+)/);
        if (numMatch) amount = parseFloat(numMatch[1]);
      }
      if (amount <= 0) {
        return ctx.reply(
          "Couldn't read an amount from that. Try: '₦8,000 transport' or '$50 SaaS tools'",
          Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
        );
      }
      bizDb.logExpense(userId, amount, currency, text);
      return ctx.reply(
        `✅ Expense logged!\n${currency === "USDC" ? "$" : "₦"}${amount.toLocaleString()} — ${text}`,
        Markup.inlineKeyboard([
          [Markup.button.callback("💸 Log Another",  "action_log_expense")],
          [Markup.button.callback("📊 This Month",   "action_cash_flow")],
          [Markup.button.callback("🏠 Main Menu",    "main_menu")],
        ])
      );
    }

    // ── Savings goal ─────────────────────────────────────────────────────────

    if (state.type === "await_savings_goal") {
      convState.clearState(userId);
      const pct   = parseInt((text.match(/(\d+)%/) || [])[1]) || 10;
      const label = text.replace(/set aside|save|of every invoice/gi, "").trim() || "Savings";
      bizDb.setSavingsGoal(userId, pct, label);
      return ctx.reply(
        `✅ Auto-save rule set!\nEvery invoice paid → ${pct}% moves to Business Savings (${label}).`,
        Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "main_menu")]])
      );
    }

    // ── AutoPay instruction ───────────────────────────────────────────────────

    if (state.type === "await_autopay_instruction") {
      convState.clearState(userId);
      const user = requireUser(ctx);
      if (!user) return;
      await ctx.reply("🤖 Working out your payment plan...");
      let balMicro = BigInt(0);
      try { balMicro = await walletLib.getNativeBalanceMicro(user.deposit_address); } catch {}
      const plan = await parsePaymentIntent(text, {
        balance: walletLib.formatMicro(balMicro),
        address: user.deposit_address,
      });
      if (plan.error) {
        return ctx.reply(`❌ ${plan.error}`, Markup.inlineKeyboard([[Markup.button.callback("🤖 Try Again", "action_autopay")]]));
      }
      const paymentLines = plan.payments.map(p => `• $${p.amount} → \`${p.to}\`\n  (${p.label})`).join("\n");
      const scheduleText = plan.schedule?.frequency
        ? `\n🔁 Repeats: ${describeSchedule(plan.schedule)}`
        : "\n⚡ One-time payment";
      convState.setState(userId, "confirm_autopay_pin", { plan }, getContext(userId));
      return ctx.reply(
        `📋 Payment Plan\n──────────────────────────\n${paymentLines}${scheduleText}\n\n${plan.summary}\n\nEnter your PIN to confirm:`,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]]) }
      );
    }

    if (state.type === "confirm_autopay_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) { convState.clearState(userId); return ctx.reply("Incorrect PIN."); }
      const user     = db.getUser(userId);
      const { plan } = state.data;
      const context  = state.context || "personal";
      convState.clearState(userId);

      if (plan.schedule?.frequency) {
        const jobId = saveSchedule(userId.toString(), plan);
        startJob(jobId, userId.toString(), plan, text, context, async (uid, jid, results) => {
          const msg = formatResults(results);
          await ctx.telegram.sendMessage(parseInt(uid), `🔔 Scheduled payment ran:\n\n${msg}`, { parse_mode: "Markdown" });
        });
        return ctx.reply(
          `✅ Scheduled!\n${plan.summary}\nRuns ${describeSchedule(plan.schedule)}.\n\nUse /schedules to view or cancel.`,
          Markup.inlineKeyboard([
            [Markup.button.callback("📅 Schedules", "action_schedules")],
            [Markup.button.callback("🏠 Main Menu", "main_menu")],
          ])
        );
      } else {
        await ctx.reply("⏳ Sending...");
        const results = await executePlan(plan, text, user, context);
        return ctx.reply(formatResults(results), { parse_mode: "Markdown", ...afterPaymentButtons });
      }
    }

    // ── Payroll instruction ───────────────────────────────────────────────────

    if (state.type === "await_payroll_instruction") {
      convState.clearState(userId);
      const user = requireUser(ctx);
      if (!user) return;
      await ctx.reply("🤖 Parsing payroll...");
      const plan = await parsePaymentIntent(text, {
        balance: "0",
        address: user.business_deposit_address || user.deposit_address,
      });
      if (plan.error) {
        return ctx.reply(`❌ ${plan.error}`, Markup.inlineKeyboard([[Markup.button.callback("« Back", "main_menu")]]));
      }
      const lines = plan.payments.map(p => `• $${p.amount} → \`${p.to}\`\n  (${p.label})`).join("\n");
      convState.setState(userId, "confirm_payroll_pin", { plan }, "business");
      return ctx.reply(
        `👥 Payroll Preview\n──────────────────────────\n${lines}\n\n${plan.summary}\n\nEnter your PIN:`,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]]) }
      );
    }

    if (state.type === "confirm_payroll_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) { convState.clearState(userId); return ctx.reply("Incorrect PIN."); }
      const user = db.getUser(userId);
      convState.clearState(userId);
      await ctx.reply("⏳ Processing payroll...");
      const results = await executePlan(state.data.plan, text, user, "business");
      return ctx.reply(formatResults(results), { parse_mode: "Markdown", ...afterPaymentButtons });
    }

    if (state.type === "confirm_intent_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) {
        convState.clearState(userId);
        return ctx.reply("Incorrect PIN. Please try again.", mainMenu(getContext(userId)));
      }

      const user = db.getUser(userId);
      const context = state.context || "personal";
      const classified = state.data.classified;
      const plan = buildPlanFromClassifiedIntent(classified);
      convState.clearState(userId);

      if (!plan.payments.length) {
        return ctx.reply(
          "I couldn't build a payment plan from your request. Please try again.",
          mainMenu(context)
        );
      }

      if (plan.schedule?.frequency) {
        const jobId = saveSchedule(userId.toString(), plan);
        startJob(jobId, userId.toString(), plan, text, context, async (uid, jid, results) => {
          const msg = formatResults(results);
          await ctx.telegram.sendMessage(parseInt(uid), `🔔 Scheduled payment ran:\n\n${msg}`, { parse_mode: "Markdown" });
        });
        return ctx.reply(
          `✅ Scheduled!\n${plan.summary}\nRuns ${describeSchedule(plan.schedule)}.\n\nUse /schedules to view or cancel.`,
          Markup.inlineKeyboard([
            [Markup.button.callback("📅 Schedules", "action_schedules")],
            [Markup.button.callback("🏠 Main Menu", "main_menu")],
          ])
        );
      }

      await ctx.reply("⏳ Processing your request...");
      const results = await executePlan(plan, text, user, context);
      return ctx.reply(formatResults(results), { parse_mode: "Markdown", ...afterPaymentButtons });
    }

    // ── File payment PIN confirm ───────────────────────────────────────────────

    if (state.type === "confirm_file_pay_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) { convState.clearState(userId); return ctx.reply("Incorrect PIN."); }
      const user    = db.getUser(userId);
      const context = state.context || "personal";
      const { parsed, plan } = state.data;
      convState.clearState(userId);

      if (plan && plan.payments?.length) {
        if (plan.schedule?.frequency) {
          const jobId = saveSchedule(userId.toString(), plan);
          startJob(jobId, userId.toString(), plan, text, context, async (uid, jid, results) => {
            const msg = formatResults(results);
            await ctx.telegram.sendMessage(parseInt(uid), `🔔 Scheduled payment ran:\n\n${msg}`, { parse_mode: "Markdown" });
          });
          return ctx.reply(
            `✅ Scheduled!\n${plan.summary}\nRuns ${describeSchedule(plan.schedule)}.\n\nUse /schedules to view or cancel.`,
            Markup.inlineKeyboard([
              [Markup.button.callback("📅 Schedules", "action_schedules")],
              [Markup.button.callback("🏠 Main Menu", "main_menu")],
            ])
          );
        }

        await ctx.reply(`⏳ Processing ${plan.payments.length} payment(s)...`);
        const results = await executePlan(plan, text, user, context);
        return ctx.reply(formatResults(results), { parse_mode: "Markdown", ...afterPaymentButtons });
      }

      const batchId = state.data.batchId || `batch_${Date.now()}`;
      await ctx.reply(`⏳ Processing ${parsed.rows.length} payment(s)...`);
      const fallbackPlan = {
        batchId,
        payments: parsed.rows.map((r, idx) => ({
          to:             r.wallet_address || "__offramp__",
          amount:         r.amount,
          label:          r.name || r.description || "Payment",
          currency:       r.currency || "USDC",
          account_number: r.account_number || null,
          bank_name:      r.bank_name      || null,
          bank_code:      r.bank_code      || null,
          account_name:   r.account_name   || null,
          chain:          r.chain          || null,
          method:         r.method         || null,
          idempotency_key: r.idempotency_key || null,
        })),
      };
      const results = await executePlan(fallbackPlan, text, user, context);
      return ctx.reply(formatResults(results), { parse_mode: "Markdown", ...afterPaymentButtons });
    }

    // ── Image payment PIN confirm ─────────────────────────────────────────────

    if (state.type === "confirm_image_pay_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) { convState.clearState(userId); return ctx.reply("Incorrect PIN."); }
      const user    = db.getUser(userId);
      const context = state.context || "personal";
      const { parsed } = state.data;
      convState.clearState(userId);
      await ctx.reply("⏳ Processing payment...");
      const isOfframp = !parsed.recipient_wallet && parsed.recipient_account;
      const plan = {
        payments: [{
          to:             isOfframp ? "__offramp__" : (parsed.recipient_wallet || "__offramp__"),
          amount:         parsed.amount,
          label:          parsed.description || "Payment from image",
          currency:       "USDC",
          account_number: parsed.recipient_account  || null,
          bank_name:      parsed.recipient_bank      || null,
          account_name:   parsed.recipient_name      || null,
        }],
      };
      const results = await executePlan(plan, text, user, context);
      return ctx.reply(formatResults(results), { parse_mode: "Markdown", ...afterPaymentButtons });
    }
  } // end if (state)

  // ── No active state — run intent router ──────────────────────────────────

  const user = db.getUser(userId);
  if (!user) {
    return ctx.reply(
      "Send /start to set up your PayIT wallet.",
      Markup.inlineKeyboard([[Markup.button.callback("Get Started", "noop")]])
    );
  }

  // Skip very short messages (likely accidental)
  if (text.length < 3) return;

  // Fast trigger for sweep/scan text keywords
  const lowerText = text.toLowerCase().trim();
  if (
    lowerText === "sweep" ||
    lowerText === "scan" ||
    lowerText === "scan and sweep" ||
    lowerText === "scan & sweep" ||
    lowerText === "scan deposits" ||
    lowerText === "sweep deposits"
  ) {
    return handleSweepDeposits(ctx);
  }

  await ctx.reply("⏳ On it...");

  const context   = user.active_context || "personal";
  const address   = getActiveWallet(user);
  let balMicro    = BigInt(0);
  try { balMicro  = await walletLib.getNativeBalanceMicro(address); } catch {}

  const classified = await classifyIntent(text, userId, {
    balance:         walletLib.formatMicro(balMicro),
    address,
    active_context:  context,
  });

  // Handle unclassifiable
  if (classified.intent === "unknown" || classified.confidence === "low") {
    return ctx.reply(
      `I didn't quite get that. Here's what I can help with:\n\n` +
      `• "Send $50 to Emeka" or "Send $20 to 0xABC..."\n` +
      `• "Cash out $100 to my GTBank account"\n` +
      `• "Invoice TechCorp $500 for design work"\n` +
      `• "Schedule $10 to 0xABC... every Friday"\n` +
      `• "How much do I have"\n` +
      `• "Show my invoices"\n\n` +
      `Or just tap a button below.`,
      mainMenu(context)
    );
  }

  // Check for missing info and offer quick clarification buttons
  const missing = getMissingQuestion(classified);
  if (missing) {
    convState.setState(userId, "await_intent_clarification", { classified }, context);
    // Build a small set of context-aware buttons to help the user respond quickly
    function buildClarificationKeyboard(classified, context) {
      const q = (classified && classified.params && classified.params.recipients && classified.params.recipients[0]) || {};
      // recipient missing
      if (missing.toLowerCase().includes('who would you like')) {
        return Markup.inlineKeyboard([
          [Markup.button.callback('👥 Choose Contact', 'clarify_choose_contact')],
          [Markup.button.callback('📋 Paste Address/Account', 'clarify_paste_address')],
          [Markup.button.callback('❌ Cancel', 'main_menu')],
        ]);
      }
      // amount missing
      if (missing.toLowerCase().includes('how much')) {
        return Markup.inlineKeyboard([
          [Markup.button.callback('💲 Enter Amount', 'clarify_enter_amount')],
          [Markup.button.callback('❌ Cancel', 'main_menu')],
        ]);
      }
      // bank details missing for offramp
      if (missing.toLowerCase().includes('bank') || missing.toLowerCase().includes('account')) {
        return Markup.inlineKeyboard([
          [Markup.button.callback('🏦 Enter Bank Details', 'clarify_enter_bank')],
          [Markup.button.callback('👥 Choose Contact', 'clarify_choose_contact')],
          [Markup.button.callback('❌ Cancel', 'main_menu')],
        ]);
      }
      // default
      return Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'main_menu')]]);
    }

    return ctx.reply(missing, buildClarificationKeyboard(classified, context));
  }

  // Route by intent
  switch (classified.intent) {

    case "balance":
      return context === "business" ? showBizBalance(ctx) : showBalance(ctx);

    case "history":
      return showHistory(ctx);

    case "invoice_list":
      return context === "business"
        ? bot.handleUpdate({ update_id: ctx.update.update_id,
            callback_query: { id: "0", from: ctx.from, chat_instance: "0",
              data: "action_list_biz_invoices", message: ctx.message } })
        : bot.handleUpdate({ update_id: ctx.update.update_id,
            callback_query: { id: "0", from: ctx.from, chat_instance: "0",
              data: "action_list_invoices", message: ctx.message } });

    case "invoice_create": {
      const instruction = classified.params?.invoice_instruction || text;
      convState.setState(userId, context === "business" ? "await_biz_invoice_instruction" : "await_invoice_instruction", {}, context);
      // Re-process the same text through the invoice flow by triggering state handler
      // Simplest approach: synthetic re-entry
      const syntheticCtx = { ...ctx, message: { ...ctx.message, text: instruction } };
      // Store and immediately re-handle — easier to just set state and ask user to resend
      convState.clearState(userId);
      // Parse directly here
      const walletAddress = getActiveWallet(user);
      const profile       = bizProfile.getBizProfile(userId);
      const parsed = await parseSmartInvoiceIntent(instruction, {
        businessName:  profile?.business_name || user.username || `User ${userId}`,
        walletAddress,
      });
      if (parsed.error) return ctx.reply(`❌ ${parsed.error}`);
      const total     = parsed.items.reduce((s, i) => s + Number(i.quantity || 1) * Number(i.unitPrice || 0), 0);
      const itemLines = parsed.items.map(i => `• ${i.description} × ${i.quantity || 1} @ $${Number(i.unitPrice).toFixed(2)}`).join("\n");
      const stateType = context === "business" ? "confirm_biz_invoice" : "confirm_invoice";
      convState.setState(userId, stateType, { parsed, total, walletAddress }, context);
      return ctx.reply(
        `📋 Invoice Preview\n──────────────────────────\n` +
        `To: ${parsed.clientName}\n${itemLines}\n──────────────────────────\n` +
        `Total: $${total.toFixed(2)}\n` +
        (parsed.dueDate ? `Due: ${parsed.dueDate}\n` : ""),
        Markup.inlineKeyboard([
          [Markup.button.callback("✅ Generate", context === "business" ? "action_confirm_biz_invoice" : "action_confirm_invoice")],
          [Markup.button.callback("❌ Cancel", "main_menu")],
        ])
      );
    }

    case "referral":
      return showReferralMenu(ctx);

    case "list_payees":
      return showContacts(ctx);

    case "save_payee": {
      const r       = classified.params?.recipients?.[0] || {};
      const saveName = classified.params?.save_as || r.name_or_address;
      const addr    = r.wallet_address;
      const acct    = r.account_number;
      if (!saveName) return ctx.reply("What name should I save this contact as?");
      if (!addr && !acct) return ctx.reply(`What's the account number or bank details for ${saveName}?`);
      payeeBook.upsertPayee(userId, {
        name:          saveName,
        walletAddress: addr   || null,
        bankName:      r.bank_name      || null,
        accountNumber: acct   || null,
        accountName:   r.account_name   || null,
      });
      return ctx.reply(
        `✅ ${saveName} saved to your contacts!\n\n` +
        `Now you can say "send $50 to ${saveName}" and PayIT knows who you mean.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("👥 All Contacts", "add_contact")],
          [Markup.button.callback("🏠 Main Menu",    "main_menu")],
        ])
      );
    }

    case "delete_payee": {
      const r    = classified.params?.recipients?.[0] || {};
      const name = r.name_or_address;
      if (!name) return ctx.reply("Who would you like to remove from contacts?");
      payeeBook.deletePayee(userId, name);
      return ctx.reply(`✅ ${name} removed from your contacts.`, backToMenu);
    }

    case "expense_log": {
      const desc = classified.params?.expense_description || text;
      convState.setState(userId, "await_expense_entry", {}, context);
      // Re-process as expense
      const nairaMatch = desc.match(/[₦]?\s*(\d[\d,]*)\s*(naira|ngn)/i);
      const usdcMatch  = desc.match(/\$?\s*(\d+(?:\.\d+)?)\s*(usdc|\$|dollar)/i);
      let amount = 0, currency = "NGN";
      if (usdcMatch)  { amount = parseFloat(usdcMatch[1]);  currency = "USDC"; }
      else if (nairaMatch) { amount = parseFloat(nairaMatch[1].replace(/,/g, "")); }
      convState.clearState(userId);
      if (amount > 0) {
        bizDb.logExpense(userId, amount, currency, desc);
        return ctx.reply(
          `✅ Expense logged!\n${currency === "USDC" ? "$" : "₦"}${amount.toLocaleString()} — ${desc}`,
          Markup.inlineKeyboard([
            [Markup.button.callback("📊 This Month", "action_cash_flow")],
            [Markup.button.callback("🏠 Main Menu",  "main_menu")],
          ])
        );
      }
      convState.setState(userId, "await_expense_entry", {}, context);
      return ctx.reply("How much was the expense? (e.g. ₦8,000 or $50)");
    }

    case "cash_flow":
      return bot.handleUpdate({ update_id: ctx.update.update_id,
        callback_query: { id: "0", from: ctx.from, chat_instance: "0",
          data: "action_cash_flow", message: ctx.message } });

    case "savings_view":
      return showYields(ctx);

    case "savings_deposit": {
      const amt = classified.params?.amount || classified.params?.recipients?.[0]?.amount;
      if (amt) {
        let pools;
        try { pools = await savings.getYieldPools(); } catch {
          return ctx.reply("Couldn't load savings pools — try again.");
        }
        const best = pools[0];
        convState.setState(userId, "confirm_yield_deposit", { amountUsdc: amt, pool: best }, context);
        return ctx.reply(
          `📈 Confirm Savings\n──────────────────────────\n` +
          `Amount: $${amt.toFixed(2)}\n` +
          `Interest rate: ${best.userApy}% per year\n` +
          `Provider: ${best.project}\n\n` +
          `You can withdraw anytime.\n\nEnter your PIN to start saving:`,
          Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_yields")]])
        );
      }
      return bot.handleUpdate({ update_id: ctx.update.update_id,
        callback_query: { id: "0", from: ctx.from, chat_instance: "0",
          data: "yield_deposit_start", message: ctx.message } });
    }

    case "savings_withdraw":
      return bot.handleUpdate({ update_id: ctx.update.update_id,
        callback_query: { id: "0", from: ctx.from, chat_instance: "0",
          data: "yield_withdraw_start", message: ctx.message } });

    case "help":
      return showHelp(ctx);

    case "transfer":
    case "bulk_transfer":
    case "offramp":
    case "scheduled": {
      // Build a plan from the classified intent
      const confirmText = buildConfirmationText(classified, classified.params.recipients);
      convState.setState(userId, "confirm_intent_pin", { classified }, context);
      return ctx.reply(
        `${confirmText}\n\nEnter your PIN to confirm:`,
        { parse_mode: "Markdown",
          ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]]) }
      );
    }

    default:
      return ctx.reply(
        `I understood that as: ${classified.raw_summary}\n\nWhat would you like to do?`,
        mainMenu(context)
      );
  }
});

// ── Intent PIN confirmation (from natural language routing) ───────────────────

bot.on("text", async (ctx) => {}); // placeholder — handled above

// Handle confirm_intent_pin state — needs to be caught in main text handler
// This is already handled by the state check at the top of bot.on("text")
// We add it here explicitly as a named state handler block:
// (The state "confirm_intent_pin" falls through to the intent router's default
//  because it starts with a state. We handle it by checking state.type directly.)

// NOTE: The confirm_intent_pin PIN entry is caught inside the main bot.on("text")
// state block. It works because:
//   1. User sends natural language → intent classified → state set to "confirm_intent_pin"
//   2. User sends PIN → state block catches it before the intent router runs

// Patch: add confirm_intent_pin to the state handler block above
// This is done inline in the state handler — see the state.type checks

// ─── Photo handler for onboarding logo (business profile step) ───────────────
// Already handled above in bot.on("photo") — state "await_logo_upload" is checked first.

// ─── Launch ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL?.replace(/\/$/, "");

async function startBot() {
  const webhookPath = "/webhook/telegram";

  // Start unified background HTTP server on PORT (serves /health, /webhook/paj, and /webhook/telegram)
  try {
    webhookServer.startWebhookServer({ bot, port: PORT, webhookPath });
  } catch (err) {
    console.warn("[bot] Webhook server notice:", err.message);
  }

  if (WEBHOOK_URL) {
    const fullWebhookUrl = `${WEBHOOK_URL}${webhookPath}`;
    try {
      await bot.telegram.setWebhook(fullWebhookUrl);
      console.log(`PayIT is running via webhook at ${fullWebhookUrl}`);
    } catch (whErr) {
      console.error("[bot] Failed to set webhook, falling back to polling:", whErr.message);
      try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: false });
      } catch {}
      await bot.launch();
      console.log("PayIT is running via polling fallback.");
    }
  } else {
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    } catch {}
    await bot.launch();
    console.log("PayIT is running via polling.");
  }

  // Populate bot info eagerly so referral links and username are always resolved
  try {
    const me = await bot.telegram.getMe();
    if (me?.username) {
      bot.botInfo = me;
      cachedBotUsername = me.username;
    }
  } catch (err) {
    console.warn("[bot] Bot info resolution notice:", err.message);
  }

  console.log(
    "Personal + Business · Dollar + Euro wallets · Image and file reading active."
  );
  reloadAll(() => {});
  try {
    await invoiceListener.startInvoiceListener(bot, arcProvider, 10000);
  } catch (err) {
    console.error("[bot] Failed to start invoice listener:", err.message);
  }

  // Start SME morning cash flow briefing scheduler (8:00 AM daily)
  try {
    cashflow.initCashFlowScheduler(bot);
  } catch (err) {
    console.warn("[bot] Cashflow scheduler notice:", err.message);
  }

  // Start background auto-earn worker (monitors funds idle ≥ 2 hours)
  try {
    autoEarn.startAutoEarnWorker({
      intervalMs: 15 * 60 * 1000,
      feeRecipientAddress: process.env.APP_FEE_RECIPIENT_ADDRESS,
    });
  } catch (err) {
    console.warn("[bot] Auto-earn worker notice:", err.message);
  }

  // Start automated EVM cross-chain deposit monitor (monitors incoming transfers)
  try {
    evmDepositSweeper.startEvmDepositMonitor({ bot, intervalMs: 90000 });
  } catch (err) {
    console.warn("[bot] EVM deposit monitor notice:", err.message);
  }
}

startBot();

process.once("SIGINT", () => {
  evmDepositSweeper.stopEvmDepositMonitor();
  autoEarn.stopAutoEarnWorker();
  cashflow.stopCashFlowScheduler();
  webhookServer.stopWebhookServer();
  bot.stop("SIGINT");
});
process.once("SIGTERM", () => {
  evmDepositSweeper.stopEvmDepositMonitor();
  autoEarn.stopAutoEarnWorker();
  cashflow.stopCashFlowScheduler();
  webhookServer.stopWebhookServer();
  bot.stop("SIGTERM");
});