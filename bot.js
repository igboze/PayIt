// bot.js
// PayIT — non-custodial dollar wallet inside Telegram
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
const fx            = require("./src/fx");
const otp           = require("./src/otp");
const savings       = require("./src/savings");
const tokens        = require("./src/tokens");
const gateway       = require("./src/gateway");
const invoiceDb     = require("./src/invoice_db");
const bizDb         = require("./src/biz_db");
const bizProfile    = require("./src/biz_profile");
const payeeBook     = require("./src/payee_book");
const convState     = require("./src/conversation_state");
const { generateInvoicePNG }   = require("./src/invoice_generator");
const { generateReceiptPNG }   = require("./src/receipt_generator");

// ── Agent modules ─────────────────────────────────────────────────────────────
const { parsePaymentIntent }      = require("./agent/orchestrator");
const { executePlan, executeOfframp, formatResults } = require("./agent/executor");
const { startJob, cancelJob, reloadAll, describeSchedule } = require("./agent/scheduler");
const { saveSchedule, removeSchedule, getUserSchedules }   = require("./agent/store");
const { parseInvoiceIntent }      = require("./agent/invoice_parser");
const { classifyIntent, getMissingQuestion, buildConfirmationText } = require("./agent/intent_router");
const { parseImagePayment, formatExtractionPreview } = require("./agent/vision_parser");
const { parsePdf, parseSpreadsheetFile, formatFilePreview, parsePptx } = require("./agent/file_parser");
const { transcribeVoice } = require("./agent/voice_parser");
const { createHDInvoice, validateAndConfirmPayment, generateInvoiceQRData } = require("./src/invoice_hd");
const invoiceListener = require("./agent/invoice_listener");
const { safeAnswerCbQuery } = require("./src/telegram_utils");
const { getSettlementDestination } = require("./agent/invoice_listener");

const ARC_RPC_URL = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const ARC_CHAIN_ID = 5042002;
const arcProvider = new JsonRpcProvider(ARC_RPC_URL, ARC_CHAIN_ID);

// ─── Startup checks ───────────────────────────────────────────────────────────

if (!process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN.includes("PASTE_YOUR")) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN is not set in .env");
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

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
      "Welcome to PayIT!\n\nSend /start to set up your wallet in under a minute."
    );
    return null;
  }
  return user;
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
    ["🔁 Switch Account", "⚙️ Settings",   "📖 Help"],
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

const afterPaymentButtons = Markup.inlineKeyboard([
  [Markup.button.callback("💰 Check Balance", "action_balance"),
   Markup.button.callback("📋 History",       "action_history")],
  [Markup.button.callback("🏠 Main Menu", "main_menu")],
]);

// ─── /start — onboarding ──────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const existing = db.getUser(ctx.from.id);
  if (existing) {
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

  return ctx.reply(
    `👋 Welcome to PayIT.\n\n` +
    `Save in dollars. Spend in Naira.\n` +
    `Everything right here in Telegram.\n\n` +
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
  const wallet = walletLib.generateUserWallet();
  convState.setState(ctx.from.id, "onboarding_pin", {
    accountType: "personal",
    address:     wallet.address,
    privateKey:  wallet.privateKey,
    username:    ctx.from.username,
  }, "personal");
  await ctx.reply(
    `👤 Personal account — great.\n\n` +
    `We'll create your wallet now.\n\n` +
    `First, choose a 4-digit PIN. This is the only thing protecting your money — ` +
    `write it down somewhere safe.\n\n` +
    `⚠️ If you forget your PIN and haven't saved your security phrase, ` +
    `your money cannot be recovered by anyone, including us.\n\n` +
    `Type your 4-digit PIN:`
  );
});

// ── Business onboarding path — collects full profile before PIN ───────────────

bot.action("onboard_business", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  convState.setState(ctx.from.id, "onboard_biz_name", {
    username: ctx.from.username,
  }, "business");
  await ctx.reply(
    `💼 Business account — let's set up your profile.\n\n` +
    `This appears on every invoice you create.\n\n` +
    `What's your business name?`
  );
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
    convState.setState(ctx.from.id, "create_biz_wallet_pin", {}, "personal");
    return ctx.reply(
      `💼 Setting up your Business wallet.\n\nEnter your PIN to create it:`,
      Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
    );
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
        [Markup.button.callback("🌍 Add from Abroad", "action_gateway")],
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
      "No Business wallet found.",
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
        [Markup.button.callback("🌍 Add from Abroad", "action_gateway")],
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
    `📥 Add Money — ${label}\n──────────────────────────\n` +
    `Your PayIT account number (tap to copy):\n\n` +
    `${address}\n\n` +
    `Anyone can send you dollars or euros to this address from any compatible wallet.\n\n` +
    `Or use 🌍 Add from Abroad to bring money in from Binance, Coinbase, MetaMask, and others.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🌍 Add from Abroad", "action_gateway")],
      [Markup.button.callback("💰 Check Balance", "action_balance")],
      [Markup.button.callback("🏠 Main Menu",     "main_menu")],
    ])
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
    `\n\nFull history: https://testnet.arcscan.app/address/${address}`,
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

  await ctx.reply(
    `⚙️ Settings\n──────────────────────────\n` +
    `Active account: ${context === "business" ? "Business 💼" : "Personal 👤"}\n` +
    `Personal account: ${user.deposit_address}\n` +
    `Business account: ${hasBiz ? user.business_deposit_address : "not set up yet"}\n` +
    `Linked account: ${user.external_wallet_address || "none"}\n` +
    `Phone: ${phone}\n\n` +
    `PayIT never holds your money. Your PIN is the only key to your funds.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("� Switch Account",              "action_switch_account")],
      [Markup.button.callback("�🔑 Save Personal Security Phrase", "export_personal")],
      [Markup.button.callback("🔑 Save Business Security Phrase", "export_business")],
      [Markup.button.callback("🔒 Change PIN",                  "changepin")],
      [Markup.button.callback("👛 Link External Wallet",        "setwallet_prompt")],
      [Markup.button.callback("📱 Verify Phone",                "verifyphone_prompt")],
      [Markup.button.callback("💼 Business Profile",            "biz_profile_menu")],
      [Markup.button.callback("🏠 Main Menu",                   "main_menu")],
    ])
  );
}

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
    `✅ Dollar and Euro wallets\n` +
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
    const pools = await savings.getYieldPools();
    await ctx.reply(
      savings.formatYieldList(pools),
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ Start Saving",      "yield_deposit_start")],
        [Markup.button.callback("📊 My Savings",        "action_my_yield")],
        [Markup.button.callback("💵 Withdraw Savings",  "yield_withdraw_start")],
        [Markup.button.callback("🏠 Main Menu",         "main_menu")],
      ])
    );
  } catch (err) {
    console.error("[yields]", err.message);
    await ctx.reply("Couldn't fetch interest rates right now — try again shortly.");
  }
}

async function showMyYield(ctx) {
  const user     = requireUser(ctx);
  if (!user) return;
  const position = db.getOpenYieldPosition(ctx.from.id);
  if (!position) {
    return ctx.reply(
      `📊 No active savings yet.\n\nStart earning interest on your dollars.`,
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

// ─── Gateway / Add from Abroad ────────────────────────────────────────────────

bot.action("action_gateway", async (ctx) => {
  ctx.answerCbQuery();
  const user    = requireUser(ctx);
  if (!user) return;
  const arcAddress = getActiveWallet(user);

  await ctx.reply(
    `🌍 Add Money from Abroad\n──────────────────────────\n` +
    `The easy way: tap <b>Deposit USDC</b> below — PayIT handles approve + deposit for you.\n\n` +
    `Before you start:\n` +
    `1. Get testnet USDC from faucet.circle.com (pick your source chain)\n` +
    `2. Get a little gas on that chain (ETH / BASE / AVAX)\n` +
    `3. Use the <b>same PayIT address</b> on every chain:\n<code>${arcAddress}</code>\n\n` +
    `After deposit finalises, tap <b>Transfer to Arc</b> to move USDC into PayIT.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🚀 Deposit USDC (Easy)",     "gateway_easy_deposit")],
        [Markup.button.callback("⚡ Transfer to Arc",         "gateway_transfer_arc")],
        [Markup.button.callback("📋 Copy Gateway Contract",    "gateway_copy_contract")],
        [Markup.button.callback("📋 Copy Arc Depositor ID",   "gateway_copy_arc")],
        [Markup.button.callback("🔍 Check Gateway Balance",   "gateway_balance")],
        [Markup.button.callback("📖 Manual Guide (MetaMask)", "gateway_steps")],
        [Markup.button.callback("🏠 Back",                    "main_menu")],
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
        [Markup.button.url("🔎 View on Arcscan", `https://testnet.arcscan.app/address/${arcAddress}`)],
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
  let bal;
  try {
    const micro = await walletLib.getNativeBalanceMicro(user.deposit_address);
    bal         = parseFloat(walletLib.formatMicro(micro));
  } catch {
    return ctx.reply("Couldn't check your balance right now.");
  }
  convState.setState(ctx.from.id, "await_yield_amount", { balanceUsdc: bal }, getContext(ctx.from.id));
  return ctx.reply(
    `📈 Start Earning Interest\n──────────────────────────\n` +
    `Available: $${bal.toFixed(2)} · Minimum: $1.00\n\n` +
    `How much would you like to put into savings?`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_yields")]])
  );
});

bot.action("yield_withdraw_start", (ctx) => {
  ctx.answerCbQuery();
  const user     = requireUser(ctx);
  if (!user) return;
  const position = db.getOpenYieldPosition(ctx.from.id);
  if (!position) {
    return ctx.reply(
      "No active savings to withdraw.",
      Markup.inlineKeyboard([[Markup.button.callback("➕ Start Saving", "yield_deposit_start")]])
    );
  }
  const accrued = savings.calcAccruedYield(position);
  const total   = parseFloat((position.amount_usdc + accrued).toFixed(4));
  convState.setState(ctx.from.id, "confirm_yield_withdraw", { position, accrued, total }, getContext(ctx.from.id));
  return ctx.reply(
    `💵 Withdraw Savings\n──────────────────────────\n` +
    `Saved: $${position.amount_usdc.toFixed(2)}\n` +
    `Interest earned: +$${accrued.toFixed(4)}\n` +
    `Total: $${total.toFixed(4)}\n\n` +
    `Enter your PIN to withdraw:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_yields")]])
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
bot.action("action_settings", (ctx) => { ctx.answerCbQuery(); return showSettings(ctx); });
bot.action("action_swap",     (ctx) => {
  ctx.answerCbQuery();
  return ctx.reply(
    `🔄 Swap\n──────────────────────────\n` +
    `Swap between dollar and euro balances — coming very soon.`,
    backToMenu
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

  if (!isPdf && !isCsv && !isXlsx) {
    return ctx.reply(
      "I can read PDF, Excel (.xlsx), and CSV files to extract payment details.\n\n" +
      "For other files, please type the details directly."
    );
  }

  await ctx.reply(`📄 Reading your ${isPdf ? "PDF" : isCsv ? "CSV" : "spreadsheet"}...`);

  try {
    const buffer = await downloadTelegramFile(ctx, doc.file_id);
    let parsed;
    if (isPdf) parsed = await parsePdf(buffer);
    else if (isPptx) parsed = await parsePptx(buffer);
    else parsed = await parseSpreadsheetFile(buffer, isCsv);

    const preview = formatFilePreview(parsed);

    if (parsed.error && !parsed.rows.length) {
      return ctx.reply(preview, backToMenu);
    }

    convState.setState(ctx.from.id, "confirm_file_payment", { parsed }, getContext(ctx.from.id));

    await ctx.reply(
      preview,
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
  const { parsed } = state.data;
  const total      = parsed.total?.toFixed(2) || "?";

  convState.setState(ctx.from.id, "confirm_file_pay_pin", { parsed }, getContext(ctx.from.id));
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
bot.hears("⚙️ Settings",         (ctx) => showSettings(ctx));
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
bot.command("settings", showSettings);
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

bot.command("admin", (ctx) => {
  if (!ADMIN_IDS.includes(String(ctx.from.id))) return ctx.reply("Not authorised.");
  const userCount   = db.db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  const positions   = db.db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(amount_usdc),0) as t FROM yield_positions WHERE status='active'").get();
  const invoiceCount = db.db.prepare("SELECT COUNT(*) as c FROM invoices").get().c;
  const recentTx    = db.db.prepare("SELECT * FROM transactions ORDER BY id DESC LIMIT 8").all();
  const txLines     = recentTx.map(t => `#${t.id} ${t.type} · user ${t.telegram_id} · [${t.status}]`).join("\n") || "none";
  ctx.reply(
    `🛠 Admin\n──────────────────────────\n` +
    `Users: ${userCount}\n` +
    `Active savings: ${positions.c} ($${Number(positions.t).toFixed(2)})\n` +
    `Invoices: ${invoiceCount}\n\n` +
    `Recent transactions:\n${txLines}`
  );
});

// ─── Main text handler — intent router ───────────────────────────────────────
// Every text message that isn't caught above passes through here.
// The intent router classifies it, resolves payees, and routes accordingly.

bot.on("text", async (ctx) => {
  const state = convState.getState(ctx.from.id);
  const text  = ctx.message.text.trim();
  const userId = ctx.from.id;

  // ── Multi-step flow states ─────────────────────────────────────────────────

  if (state) {
    convState.touchState(userId); // keep alive

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
          isBusiness ? state.data.businessPrivateKey : null
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

    // ── Withdraw amount ──────────────────────────────────────────────────────

    if (state.type === "await_withdraw_amount") {
      const amount = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (isNaN(amount) || amount <= 0) {
        return ctx.reply("Enter a valid amount (e.g. 50):");
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
      // Parse "GTBank · 0123456789 · Emeka Johnson" or similar
      const parts      = text.split(/[·\-,|]/).map(s => s.trim());
      const bankName   = parts[0] || null;
      const acctNumber = parts[1]?.replace(/\D/g, "") || null;
      const acctName   = parts[2] || null;

      if (!acctNumber || acctNumber.length < 6) {
        return ctx.reply(
          "Please include the account number. Format:\nBank name · Account number · Account name",
          Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
        );
      }

      convState.setState(userId, "confirm_withdraw", {
        amountUsdc: state.data.amountUsdc,
        bankName, accountNumber: acctNumber, accountName: acctName,
      }, state.context);

      return ctx.reply(
        `💵 Confirm Cash Out\n──────────────────────────\n` +
        `Amount: $${state.data.amountUsdc.toFixed(2)}\n` +
        `Bank: ${bankName || "?"}\n` +
        `Account: ${acctNumber}\n` +
        `Name: ${acctName || "?"}\n\n` +
        `Enter your PIN to confirm:`,
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
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
      const result = await executeOfframp(
        userWallet,
        state.data.amountUsdc,
        { accountNumber: state.data.accountNumber, bankCode: "000", accountName: state.data.accountName },
        userId,
        "Cash Out"
      );

      if (result.success) {
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

    if (state.type === "confirm_yield_deposit") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your PIN.");
      if (!db.verifyPin(userId, text)) { convState.clearState(userId); return ctx.reply("Incorrect PIN."); }
      convState.clearState(userId);
      savings.openYieldPosition(userId, state.data.amountUsdc, state.data.pool);
      db.recordTransaction(userId, "yield_deposit", BigInt(Math.round(state.data.amountUsdc * 1e18)), "confirmed", null);
      return ctx.reply(
        `✅ Savings started!\n──────────────────────────\n` +
        `$${state.data.amountUsdc.toFixed(2)} earning at ${state.data.pool.userApy}% per year\n` +
        `Withdraw anytime from 📈 Save & Earn.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("📊 My Savings", "action_my_yield")],
          [Markup.button.callback("🏠 Main Menu",  "main_menu")],
        ])
      );
    }

    if (state.type === "confirm_yield_withdraw") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your PIN.");
      if (!db.verifyPin(userId, text)) { convState.clearState(userId); return ctx.reply("Incorrect PIN."); }
      convState.clearState(userId);
      db.closeYieldPosition(userId, state.data.total);
      db.recordTransaction(userId, "yield_withdraw", BigInt(Math.round(state.data.total * 1e18)), "confirmed", null);
      return ctx.reply(
        `✅ Savings withdrawn!\n──────────────────────────\n` +
        `Saved: $${state.data.position.amount_usdc.toFixed(2)}\n` +
        `Interest earned: +$${state.data.accrued.toFixed(4)}\n` +
        `Total returned: $${state.data.total.toFixed(4)}`,
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
        // Create HD invoice with unique derivation address
        const hdInvoice = createHDInvoice(userId, decryptedKey, {
          invoiceNumber: state.data.invoiceNumber,
          clientName: state.data.parsed.clientName,
          clientEmail: state.data.parsed.clientEmail,
          items: state.data.parsed.items,
          totalUsdc: state.data.total,
          dueDate: state.data.parsed.dueDate,
          notes: state.data.parsed.notes,
          walletAddress: user.deposit_address, // User's main address (backup)
          pngPath: null,
        });

        const issueDate = state.data.issueDate;
        const paymentAddressForQR = hdInvoice.paymentAddress;

        // Generate invoice PNG with HD payment address
        const pngPath = await generateInvoicePNG({
          invoiceNumber: hdInvoice.invoiceNumber,
          clientName: state.data.parsed.clientName,
          clientEmail: state.data.parsed.clientEmail,
          items: state.data.parsed.items,
          dueDate: state.data.parsed.dueDate,
          notes: state.data.parsed.notes,
          businessName: user.username || `User ${userId}`,
          walletAddress: paymentAddressForQR, // HD-derived address
          issueDate,
        });

        // Update invoice with PNG path
        invoiceDb.updateInvoicePngPath(hdInvoice.invoiceId, pngPath);

        const qrData = generateInvoiceQRData(paymentAddressForQR, hdInvoice.expectedAmountMicro);

        await ctx.replyWithPhoto({ source: pngPath }, {
          caption:
            `🧾 Invoice #${hdInvoice.invoiceNumber}\n` +
            `To: ${state.data.parsed.clientName}\n` +
            `Amount: $${hdInvoice.totalUsdc.toFixed(2)}\n` +
            (state.data.parsed.dueDate ? `Due: ${state.data.parsed.dueDate}\n` : "") +
            `\n📍 Unique Payment Address (for this invoice only):\n\`${paymentAddressForQR}\`\n` +
            `\nQR Code: ↑ Scan to pay\n` +
            `Index: ${hdInvoice.derivationIndex}`,
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("📋 All Invoices", "action_list_invoices")],
            [Markup.button.callback("✅ Mark as Paid", `action_paid_${hdInvoice.invoiceId}`)],
            [Markup.button.callback("🏠 Main Menu", "main_menu")],
          ]),
        });

        console.log(`[invoice_hd] Created invoice #${hdInvoice.invoiceNumber} with HD address ${paymentAddressForQR.slice(0, 10)}...`);
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
        const derivationIndex = bizDb.getNextBizDerivationIndex(userId);
      const derived = walletLib.deriveInvoiceAddress(decryptedBizKey, derivationIndex);
      const paymentAddress = derived.address;
      const invoicePrivateKeyEncrypted = walletLib.encryptSensitiveValue(
        derived.childPrivateKey,
        process.env.INVOICE_FORWARDING_SECRET
      );
      const expectedAmountMicro = walletLib.parseToMicro(String(state.data.total));
      const profile = bizProfile.getBizProfile(userId);

        const pngPath = await generateInvoicePNG({
          invoiceNumber: state.data.invoiceNumber,
          clientName:      state.data.parsed.clientName,
          clientEmail:     state.data.parsed.clientEmail,
          items:           state.data.parsed.items,
          dueDate:         state.data.parsed.dueDate,
          notes:           state.data.parsed.notes,
          businessName:    profile?.business_name || ctx.from.username || `User ${userId}`,
          businessEmail:   profile?.business_email || null,
          businessPhone:   profile?.phone || null,
          businessAddress: profile?.address || null,
          logoDataUri:     profile ? bizProfile.getLogoDataUri(userId) : null,
          walletAddress:   paymentAddress,
          issueDate:       state.data.issueDate,
        });

        const invoiceId = bizDb.createBizInvoiceWithHDAddress(userId, {
          invoiceNumber: state.data.invoiceNumber,
          clientName:    state.data.parsed.clientName,
          clientEmail:   state.data.parsed.clientEmail || null,
          items:         state.data.parsed.items,
          totalUsdc:     state.data.total,
          dueDate:       state.data.parsed.dueDate || null,
          notes:         state.data.parsed.notes || null,
          walletAddress: user.business_deposit_address || user.deposit_address,
          paymentAddress,
          invoicePrivateKeyEncrypted,
          pngPath,
          derivationIndex,
          expectedAmountMicro: expectedAmountMicro.toString(),
        });

        const goal     = bizDb.getSavingsGoal(userId);
        const goalNote = goal
          ? `\n💰 ${goal.percentage}% ($${(state.data.total * goal.percentage / 100).toFixed(2)}) will go to Business Savings on payment.`
          : "";

        await ctx.replyWithPhoto({ source: pngPath }, {
          caption:
            `🧾 Invoice #${state.data.invoiceNumber}\n` +
            `To: ${state.data.parsed.clientName}\n` +
            `Amount: $${state.data.total.toFixed(2)}\n` +
            (state.data.parsed.dueDate ? `Due: ${state.data.parsed.dueDate}\n` : "") +
            `\n📍 Unique Payment Address (for this invoice only):\n\`${paymentAddress}\`` + goalNote,
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("📋 All Invoices",  "action_list_biz_invoices")],
            [Markup.button.callback(`✅ Mark as Paid`,  `action_bizpaid_${invoiceId}`)],
            [Markup.button.callback("🏠 Main Menu",     "main_menu")],
          ]),
        });
      } catch (err) {
        console.error("[biz_invoice_hd]", err);
        await ctx.reply("❌ Failed to create business invoice. Please try again.");
      }
      return;
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
      const parsed = await parseInvoiceIntent(text, {
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
      const parsed = await parseInvoiceIntent(text, {
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

    // ── File payment PIN confirm ───────────────────────────────────────────────

    if (state.type === "confirm_file_pay_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
      if (!db.verifyPin(userId, text)) { convState.clearState(userId); return ctx.reply("Incorrect PIN."); }
      const user    = db.getUser(userId);
      const context = state.context || "personal";
      const { parsed } = state.data;
      convState.clearState(userId);
      await ctx.reply(`⏳ Processing ${parsed.rows.length} payment(s)...`);
      const plan = {
        payments: parsed.rows.map(r => ({
          to:             r.wallet_address || "__offramp__",
          amount:         r.amount,
          label:          r.name || r.description || "Payment",
          currency:       r.currency || "USDC",
          account_number: r.account_number || null,
          bank_name:      r.bank_name      || null,
          account_name:   r.account_name   || null,
        })),
      };
      const results = await executePlan(plan, text, user, context);
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
      const parsed = await parseInvoiceIntent(instruction, {
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

bot.launch().then(async () => {
  console.log(
    "PayIT is running.\n" +
    "Personal + Business · Dollar + Euro wallets · Image and file reading active."
  );
  reloadAll(() => {});
  try {
    await invoiceListener.startInvoiceListener(bot, arcProvider, 10000);
  } catch (err) {
    console.error("[bot] Failed to start invoice listener:", err.message);
  }
});

process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));