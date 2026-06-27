// bot.js
// PayIT - non-custodial Telegram wallet bot on Arc (testnet)
// Supports: USDC (native), EURC (ERC-20), Gateway (cross-chain USDC inflow)
// Accounts: Personal + Business (dual wallet, one PIN, context switch)
// Run with: node bot.js  (after npm install and setting up .env)

require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const db = require("./src/db");
const walletLib = require("./src/wallet");
const offramp = require("./src/offramp");
const fx = require("./src/fx");
const otp = require("./src/otp");
const swap = require("./src/swap");
const savings = require("./src/savings");
const tokens = require("./src/tokens");       // NEW: multi-token (USDC + EURC) balances & sends
const gateway = require("./src/gateway");     // NEW: Circle Gateway cross-chain inflow
const { parsePaymentIntent } = require("./agent/orchestrator");
const { executePlan, formatResults } = require("./agent/executor");
const { startJob, cancelJob, reloadAll } = require("./agent/scheduler");
const { saveSchedule, removeSchedule, getUserSchedules } = require("./agent/store");
const { parseInvoiceIntent } = require("./agent/invoice_parser");
const { generateInvoicePNG } = require("./src/invoice_generator");
const invoiceDb = require("./src/invoice_db");

// ── Business modules (NEW) ────────────────────────────────────────────────────
const bizDb = require("./src/biz_db");        // business invoices, expenses, cash flow, payroll

if (!process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN.includes("PASTE_YOUR")) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN is not set in .env");
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// In-memory state maps
const pendingAction = new Map();

// ─── Context helpers ──────────────────────────────────────────────────────────
// active_context is stored per-user in DB: 'personal' | 'business'

function getContext(userId) {
  const user = db.getUser(userId);
  return user?.active_context || "personal";
}

function getActiveWallet(user) {
  // Returns the wallet address for the current context
  if ((user.active_context || "personal") === "business") {
    return user.business_deposit_address || user.deposit_address;
  }
  return user.deposit_address;
}

function requireUser(ctx) {
  const userId = ctx.from?.id;
  const user = db.getUser(userId);
  if (!user) {
    ctx.reply("Send /start first to set up your wallet.");
    return null;
  }
  return user;
}

function scheduleDelete(ctx, messageId, ms) {
  setTimeout(() => {
    ctx.telegram.deleteMessage(ctx.chat.id, messageId).catch(() => {});
  }, ms);
}

// ─── Keyboard builders (context-aware) ───────────────────────────────────────

function buildMainMenu(context) {
  if (context === "business") {
    return Markup.keyboard([
      ["🏢 Biz Balance", "🧾 New Invoice", "💸 Log Expense"],
      ["📋 Invoices", "👥 Payroll", "📊 Cash Flow"],
      ["💰 Biz Savings", "📈 Reports", "📤 Send Payment"],
      ["💵 Cash Out", "🔄 Swap", "⚙️ Settings"],
      ["📖 How to Use", "✨ Features"],
      ["👤 Switch to Personal"],
    ]).resize();
  }
  // Personal
  return Markup.keyboard([
    ["💰 Balance", "📤 Send", "🔄 Swap"],
    ["📥 Receive", "📈 Yields", "📋 History"],
    ["🤖 AutoPay", "🧾 Invoice", "⚙️ Settings"],
    ["📖 How to Use", "✨ Features"],
    ["🏢 Switch to Business"],
  ]).resize();
}

// The account toggle — appears as inline keyboard on every main screen
function accountToggle(currentContext) {
  const personal = currentContext === "personal"
    ? Markup.button.callback("● Personal", "noop")
    : Markup.button.callback("  Personal", "action_switch_personal");
  const business = currentContext === "business"
    ? Markup.button.callback("● Business", "noop")
    : Markup.button.callback("  Business", "action_switch_business");
  return Markup.inlineKeyboard([[personal, business]]);
}

// ─── Shared inline button sets ────────────────────────────────────────────────

const afterSuccessButtons = Markup.inlineKeyboard([
  [Markup.button.callback("💰 Check Balance", "action_balance")],
  [Markup.button.callback("📋 Transaction History", "action_history")],
  [Markup.button.callback("🏠 Main Menu", "action_main_menu")],
]);

const afterYieldOpenButtons = Markup.inlineKeyboard([
  [Markup.button.callback("📊 View My Position", "action_my_yield")],
  [Markup.button.callback("💵 Withdraw Yield", "action_yield_withdraw_start")],
  [Markup.button.callback("🏠 Main Menu", "action_main_menu")],
]);

// ─── Startup ──────────────────────────────────────────────────────────────────

invoiceDb.initInvoiceTables();
bizDb.initBizTables();        // NEW: business tables

// ─── /start — Onboarding with account type selection ─────────────────────────

bot.start(async (ctx) => {
  const existing = db.getUser(ctx.from.id);
  if (existing) {
    const context = existing.active_context || "personal";
    const addr = getActiveWallet(existing);
    const label = context === "business" ? "Business" : "Personal";
    return ctx.reply(
      `👋 Welcome back, ${ctx.from.first_name || "there"}!\n\n` +
      `Active account: ${label}\n` +
      `Wallet: ${addr}\n\n` +
      `Use the toggle below to switch accounts.`,
      { ...buildMainMenu(context), ...accountToggle(context) }
    );
  }

  // New user: ask account type first
  return ctx.reply(
    `👋 Welcome to PayIT.\n\n` +
    `PayIT gives you a self-custodial wallet on Arc — you hold your own funds and we never have access without your PIN.\n\n` +
    `How will you use PayIT?`,
    Markup.inlineKeyboard([
      [Markup.button.callback("👤 Personal account", "onboard_personal")],
      [Markup.button.callback("🏢 Business account", "onboard_business")],
    ])
  );
});

// Onboarding: Personal path
bot.action("onboard_personal", async (ctx) => {
  ctx.answerCbQuery();
  const wallet = walletLib.generateUserWallet();
  pendingAction.set(ctx.from.id, {
    type: "onboarding_set_pin",
    accountType: "personal",
    address: wallet.address,
    privateKey: wallet.privateKey,
    username: ctx.from.username,
  });
  await ctx.reply(
    `👤 Personal account selected.\n\n` +
    `We'll create your wallet now. First, set a 4-digit PIN — this encrypts your private key.\n\n` +
    `⚠️ If you forget your PIN and haven't backed up your key, funds are permanently unrecoverable. That's what non-custodial means.\n\n` +
    `Type a 4-digit PIN to continue:`
  );
});

// Onboarding: Business path (creates both wallets)
bot.action("onboard_business", async (ctx) => {
  ctx.answerCbQuery();
  const personalWallet = walletLib.generateUserWallet();
  const businessWallet = walletLib.generateUserWallet();
  pendingAction.set(ctx.from.id, {
    type: "onboarding_set_pin",
    accountType: "business",
    address: personalWallet.address,
    privateKey: personalWallet.privateKey,
    businessAddress: businessWallet.address,
    businessPrivateKey: businessWallet.privateKey,
    username: ctx.from.username,
  });
  await ctx.reply(
    `🏢 Business account selected.\n\n` +
    `We'll create two wallets — one Personal, one Business. Same PIN unlocks both.\n\n` +
    `⚠️ Back up both private keys separately. If you lose your PIN with no backup, funds are permanently unrecoverable.\n\n` +
    `Type a 4-digit PIN to continue:`
  );
});

// ─── Account switching ─────────────────────────────────────────────────────────

bot.action("action_switch_personal", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  db.setActiveContext(ctx.from.id, "personal");
  const balance = await safeGetBalance(user.deposit_address);
  await ctx.reply(
    `👤 Switched to Personal account.\n\nBalance: ${balance}\nWallet: ${user.deposit_address}`,
    { ...buildMainMenu("personal"), ...accountToggle("personal") }
  );
});

bot.action("action_switch_business", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;

  // If no business wallet yet (personal-first user switching for first time), create one now
  if (!user.business_deposit_address) {
    const bizWallet = walletLib.generateUserWallet();
    // Re-decrypt personal key with PIN — need PIN to encrypt business key with same PIN
    // We store it temporarily as needing PIN confirmation
    pendingAction.set(ctx.from.id, {
      type: "create_business_wallet",
      businessAddress: bizWallet.address,
      businessPrivateKey: bizWallet.privateKey,
    });
    return ctx.reply(
      `🏢 Setting up your Business account.\n\nEnter your PIN to create and encrypt your Business wallet:`,
      Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
    );
  }

  db.setActiveContext(ctx.from.id, "business");
  const balance = await safeGetBalance(user.business_deposit_address);
  const pendingInvoices = bizDb.getPendingInvoiceCount(ctx.from.id);
  const pendingLine = pendingInvoices > 0
    ? `\n📬 ${pendingInvoices} unpaid invoice${pendingInvoices > 1 ? "s" : ""} pending.`
    : "";

  await ctx.reply(
    `🏢 Switched to Business account.\n\nBalance: ${balance}${pendingLine}\nWallet: ${user.business_deposit_address}`,
    { ...buildMainMenu("business"), ...accountToggle("business") }
  );
});

bot.action("noop", (ctx) => ctx.answerCbQuery());

// ─── Balance helpers ───────────────────────────────────────────────────────────

async function safeGetBalance(address) {
  try {
    const usdcMicro = await walletLib.getNativeBalanceMicro(address);
    const usdc = parseFloat(walletLib.formatMicro(usdcMicro));
    const eurcMicro = await tokens.getEurcBalance(address);
    const eurc = parseFloat(walletLib.formatMicro(eurcMicro));
    let line = `${usdc.toFixed(4)} USDC`;
    if (eurc > 0) line += ` · ${eurc.toFixed(4)} EURC`;
    return line;
  } catch {
    return "(unavailable)";
  }
}

// ─── Core display functions ───────────────────────────────────────────────────

async function showBalance(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  const context = user.active_context || "personal";
  const address = getActiveWallet(user);
  const label = context === "business" ? "🏢 Business" : "👤 Personal";

  try {
    // USDC (native)
    const usdcMicro = await walletLib.getNativeBalanceMicro(address);
    const usdcAmount = parseFloat(walletLib.formatMicro(usdcMicro));

    // EURC (ERC-20)
    const eurcMicro = await tokens.getEurcBalance(address);
    const eurcAmount = parseFloat(walletLib.formatMicro(eurcMicro));

    // Naira estimate on USDC
    const rate = await fx.getUsdToNgnRate();
    const nairaLine = rate
      ? `≈ ${fx.formatNaira(usdcAmount * rate)} at ~₦${Math.round(rate)}/USD\n(Estimate — actual rate set by Paj Cash at payout)`
      : "(Naira estimate unavailable)";

    const eurcLine = eurcAmount > 0
      ? `\n${eurcAmount.toFixed(4)} EURC`
      : "";

    await ctx.reply(
      `💰 ${label} Balance\n──────────────────────────\n` +
      `${usdcAmount.toFixed(4)} USDC${eurcLine}\n${nairaLine}\n\n` +
      `Wallet: ${address}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📥 Receive", "action_receive"),
         Markup.button.callback("📤 Send", "action_send_menu")],
        [Markup.button.callback("💵 Cash Out to Naira", "action_withdraw_menu"),
         Markup.button.callback("📈 Earn Yield", "action_yields")],
        [Markup.button.callback("🌉 Add Funds via Gateway", "action_gateway")],
        [Markup.button.callback("📋 History", "action_history")],
      ])
    );
  } catch (err) {
    console.error("[balance]", err);
    await ctx.reply("Couldn't check your balance right now — please try again shortly.");
  }
}

async function showReceive(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  const context = user.active_context || "personal";
  const address = getActiveWallet(user);
  const label = context === "business" ? "Business" : "Personal";
  await ctx.reply(
    `📥 Receive — ${label} Wallet\n──────────────────────────\n` +
    `Your Arc Testnet address:\n\n` +
    `${address}\n\n` +
    `Accepts: USDC (native) · EURC (ERC-20)\n\n` +
    `Get free testnet tokens at https://faucet.circle.com (select Arc Testnet).\n` +
    `Or use 🌉 Gateway to bring USDC from another chain (Ethereum, Base, Polygon, etc).`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🌉 Add via Gateway (cross-chain)", "action_gateway")],
      [Markup.button.callback("💰 Check Balance", "action_balance")],
      [Markup.button.callback("« Back", "action_main_menu")],
    ])
  );
}

async function showHistory(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  const context = user.active_context || "personal";
  const address = getActiveWallet(user);
  const txs = db.getTransactions(ctx.from.id, 10);
  if (txs.length === 0) {
    return ctx.reply(
      `📋 Transaction History\n──────────────────────────\n` +
      `No PayIT-initiated transactions yet.\n\n` +
      `Full on-chain history:\nhttps://testnet.arcscan.app/address/${address}`,
      Markup.inlineKeyboard([[Markup.button.callback("« Back", "action_main_menu")]])
    );
  }
  const lines = txs.map(
    (t) => `• ${t.type}  ${walletLib.formatMicro(t.amount_micro)} USDC  [${t.status}]\n  ${t.created_at}`
  );
  await ctx.reply(
    `📋 Last ${txs.length} Transactions\n──────────────────────────\n` + lines.join("\n\n"),
    Markup.inlineKeyboard([
      [Markup.button.callback("💰 Check Balance", "action_balance")],
      [Markup.button.callback("« Back", "action_main_menu")],
    ])
  );
}

async function showSettings(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  const context = user.active_context || "personal";
  const phoneStatus = user.phone_number
    ? `${user.phone_number} (${user.phone_verified ? "✅ verified" : "⏳ unverified"})`
    : "not set";
  const hasBiz = !!user.business_deposit_address;
  await ctx.reply(
    `⚙️ Settings\n──────────────────────────\n` +
    `Active account: ${context === "business" ? "🏢 Business" : "👤 Personal"}\n` +
    `Personal wallet: ${user.deposit_address}\n` +
    `Business wallet: ${hasBiz ? user.business_deposit_address : "not created yet"}\n` +
    `Linked external wallet: ${user.external_wallet_address || "none"}\n` +
    `Phone: ${phoneStatus}\n\n` +
    `PayIT is non-custodial — your PIN never leaves your device.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🔑 Export Personal Key", "action_export_personal")],
      [Markup.button.callback("🔑 Export Business Key", "action_export_business")],
      [Markup.button.callback("🔒 Change PIN", "action_changepin")],
      [Markup.button.callback("👛 Link External Wallet", "action_setwallet_prompt")],
      [Markup.button.callback("📱 Verify Phone", "action_verifyphone_prompt")],
      [Markup.button.callback("« Back", "action_main_menu")],
    ])
  );
}

function showHelp(ctx) {
  const user = db.getUser(ctx.from?.id);
  const context = user?.active_context || "personal";
  const menu = buildMainMenu(context);
  if (context === "business") {
    return ctx.reply(
      `📖 Business Account — How to Use\n──────────────────────────\n` +
      `🧾 New Invoice — create a USDC invoice in plain English\n` +
      `📋 Invoices — view, track and remind unpaid invoices\n` +
      `💸 Log Expense — record a business expense quickly\n` +
      `👥 Payroll — bulk pay your team in USDC\n` +
      `📊 Cash Flow — income vs expenses, runway estimate\n` +
      `💰 Biz Savings — set aside funds for tax/goals\n` +
      `📈 Reports — AI-generated P&L and summaries\n` +
      `📤 Send Payment — pay suppliers or partners\n` +
      `💵 Cash Out — convert USDC to Naira\n\n` +
      `Switch to Personal at the top of any screen.`,
      menu
    );
  }
  return ctx.reply(
    `📖 How to Use PayIT\n──────────────────────────\n` +
    `💰 Balance — live balance (USDC + EURC)\n` +
    `📥 Receive — your wallet address\n` +
    `📤 Send — to Naira or external wallet\n` +
    `📈 Yields — earn yield via lending protocols\n` +
    `🤖 AutoPay — natural language payment scheduling\n` +
    `🧾 Invoice — create invoices in plain English\n` +
    `🌉 Gateway — add USDC from Ethereum, Base, Polygon\n` +
    `⚙️ Settings — PIN, wallets, phone\n\n` +
    `Switch to Business for SME features.`,
    menu
  );
}

function showFeatures(ctx) {
  const user = db.getUser(ctx.from?.id);
  const context = user?.active_context || "personal";
  return ctx.reply(
    `✨ What's live (Arc testnet):\n` +
    `✅ Personal + Business dual wallets (one PIN)\n` +
    `✅ USDC (native) + EURC (ERC-20) balances and sends\n` +
    `✅ Gateway: fund from Ethereum, Base, Polygon, Arbitrum\n` +
    `✅ Naira off-ramp via Paj Cash (needs credentials)\n` +
    `✅ Yield deposits (Aave/Compound/Spark/Morpho/Sky)\n` +
    `✅ AI invoicing — USDC invoices from plain English\n` +
    `✅ AutoPay — natural language recurring payments\n` +
    `✅ Business: invoices, expenses, payroll, cash flow\n` +
    `✅ SMS OTP via Termii (needs API key)\n\n` +
    `🚧 Coming soon:\n` +
    `— Real swap execution (verified router pending)\n` +
    `— Card spending\n` +
    `— Bills & Bulk Send\n` +
    `— Business AI reports (P&L, tax summary)`,
    buildMainMenu(context)
  );
}

// ─── Yield / Savings (Personal context) ───────────────────────────────────────

async function showYields(ctx) {
  await ctx.reply("Fetching live lending-pool yields...");
  try {
    const pools = await savings.getYieldPools();
    await ctx.reply(
      savings.formatYieldList(pools),
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ Deposit into Yield Pool", "action_yield_deposit_start")],
        [Markup.button.callback("📊 My Current Position", "action_my_yield")],
        [Markup.button.callback("💵 Withdraw Yield", "action_yield_withdraw_start")],
        [Markup.button.callback("« Back", "action_main_menu")],
      ])
    );
  } catch (err) {
    console.error("[yields]", err.message);
    await ctx.reply("Couldn't fetch yield data right now — try again shortly.");
  }
}

async function showMyYield(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  const position = db.getOpenYieldPosition(ctx.from.id);
  if (!position) {
    return ctx.reply(
      `📊 No Active Position\n──────────────────────────\n` +
      `You don't have an open yield position yet.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ Start Earning", "action_yield_deposit_start")],
        [Markup.button.callback("« Back", "action_yields")],
      ])
    );
  }
  await ctx.reply(
    savings.formatPosition(position),
    Markup.inlineKeyboard([
      [Markup.button.callback("💵 Withdraw Position", "action_yield_withdraw_start")],
      [Markup.button.callback("📈 View Pools", "action_yields")],
      [Markup.button.callback("« Back", "action_main_menu")],
    ])
  );
}

// ─── Gateway ──────────────────────────────────────────────────────────────────

bot.action("action_gateway", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const context = user.active_context || "personal";
  const address = getActiveWallet(user);
  try {
    const info = await gateway.getDepositInfo(address);
    await ctx.reply(
      `🌉 Add Funds via Gateway\n──────────────────────────\n` +
      `Circle Gateway lets you bring USDC from another chain — no manual bridging, no crypto knowledge needed.\n\n` +
      `Supported source chains:\n` +
      `• Ethereum • Base • Polygon • Arbitrum • Avalanche • OP Mainnet\n\n` +
      `Your Arc deposit address:\n${address}\n\n` +
      `${info.instructions}\n\n` +
      `Transfers typically arrive in under 500ms after source confirmation.\n` +
      `Fee: ~0.05% (0.5 basis points).`,
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Done — Check Balance", "action_balance")],
        [Markup.button.callback("« Back", "action_main_menu")],
      ])
    );
  } catch (err) {
    console.error("[gateway]", err.message);
    await ctx.reply(
      `🌉 Add Funds via Gateway\n──────────────────────────\n` +
      `Send USDC from any supported chain (Ethereum, Base, Polygon, Arbitrum, Avalanche, OP Mainnet) to:\n\n` +
      `${address}\n\n` +
      `Gateway auto-converts and delivers to your Arc wallet.\n` +
      `Fee: ~0.05%. Typically arrives in under 500ms.\n\n` +
      `(GATEWAY_API_KEY not set — configure in .env for full status tracking.)`,
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Done — Check Balance", "action_balance")],
        [Markup.button.callback("« Back", "action_main_menu")],
      ])
    );
  }
});

// ─── Send (token-aware) ───────────────────────────────────────────────────────

bot.action("action_send_menu", (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  return ctx.reply(
    `📤 Send\n──────────────────────────\nWhat would you like to send and where?`,
    Markup.inlineKeyboard([
      [Markup.button.callback("💵 Cash Out to Naira (Paj Cash)", "action_withdraw_menu")],
      [Markup.button.callback("👛 Send USDC to External Wallet", "action_sendout_menu")],
      [Markup.button.callback("💶 Send EURC to External Wallet", "action_sendout_eurc_menu")],
      [Markup.button.callback("« Back", "action_main_menu")],
    ])
  );
});

// ─── Business Account Screens ──────────────────────────────────────────────────

async function showBizBalance(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  if (!user.business_deposit_address) {
    return ctx.reply(
      "No Business wallet found. Switch to Business account to set one up.",
      Markup.inlineKeyboard([[Markup.button.callback("🏢 Switch to Business", "action_switch_business")]])
    );
  }
  try {
    const usdcMicro = await walletLib.getNativeBalanceMicro(user.business_deposit_address);
    const usdc = parseFloat(walletLib.formatMicro(usdcMicro));
    const eurcMicro = await tokens.getEurcBalance(user.business_deposit_address);
    const eurc = parseFloat(walletLib.formatMicro(eurcMicro));
    const rate = await fx.getUsdToNgnRate();
    const nairaLine = rate ? `≈ ${fx.formatNaira(usdc * rate)}` : "";
    const eurcLine = eurc > 0 ? `\n${eurc.toFixed(4)} EURC` : "";
    const pending = bizDb.getPendingInvoiceCount(ctx.from.id);
    const expenses = bizDb.getMonthExpenses(ctx.from.id);

    await ctx.reply(
      `🏢 Business Balance\n──────────────────────────\n` +
      `${usdc.toFixed(4)} USDC${eurcLine}\n${nairaLine}\n\n` +
      `📬 Unpaid invoices: ${pending}\n` +
      `📉 This month's expenses: $${expenses.toFixed(2)} USDC\n\n` +
      `Wallet: ${user.business_deposit_address}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🧾 New Invoice", "action_new_biz_invoice"),
         Markup.button.callback("💸 Log Expense", "action_log_expense")],
        [Markup.button.callback("📋 View Invoices", "action_list_biz_invoices"),
         Markup.button.callback("📊 Cash Flow", "action_cash_flow")],
        [Markup.button.callback("🌉 Add Funds via Gateway", "action_gateway")],
      ])
    );
  } catch (err) {
    console.error("[biz_balance]", err);
    await ctx.reply("Couldn't check Business balance right now — try again shortly.");
  }
}

// ─── Business Invoice Flow ─────────────────────────────────────────────────────

async function showBizInvoiceMenu(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  const recentClients = bizDb.getRecentClients(ctx.from.id, 3);
  const clientButtons = recentClients.length > 0
    ? recentClients.map(c => [Markup.button.callback(c, `action_biz_client_${encodeURIComponent(c)}`)])
    : [];

  pendingAction.set(ctx.from.id, { type: "await_biz_invoice_instruction" });
  return ctx.reply(
    `🧾 Create Business Invoice\n──────────────────────────\n` +
    `Describe the invoice in plain English:\n\n` +
    `• "Invoice Acme Ltd 500 USDC for web design, due July 15"\n` +
    `• "Bill TechCorp for 200 USDC consulting and 100 USDC hosting"\n` +
    `• "Invoice john@example.com 1500 USDC for brand identity"\n\n` +
    `Type your instruction:`,
    Markup.inlineKeyboard([
      ...clientButtons,
      [Markup.button.callback("📋 All Business Invoices", "action_list_biz_invoices")],
      [Markup.button.callback("« Back", "action_main_menu")],
    ])
  );
}

bot.action("action_new_biz_invoice", (ctx) => { ctx.answerCbQuery(); return showBizInvoiceMenu(ctx); });

bot.action("action_list_biz_invoices", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const invoices = bizDb.getBizInvoices(ctx.from.id);
  if (!invoices.length) {
    return ctx.reply(
      "📋 No business invoices yet.\n\nTap below to create your first one.",
      Markup.inlineKeyboard([[Markup.button.callback("🧾 Create Invoice", "action_new_biz_invoice")]])
    );
  }
  const lines = invoices.slice(0, 8).map((inv) => {
    const status = inv.status === "paid" ? "✅" : "⏳";
    return `${status} #${inv.invoice_number} — ${inv.client_name}\n   ${inv.total_usdc} USDC${inv.due_date ? " · Due " + inv.due_date : ""}\n   /bizpaid_${inv.id}`;
  }).join("\n\n");
  await ctx.reply(
    `📋 Business Invoices\n──────────────────────────\n${lines}\n\nTap a /bizpaid_ link to mark as paid.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🧾 New Invoice", "action_new_biz_invoice")],
      [Markup.button.callback("📊 Cash Flow", "action_cash_flow")],
      [Markup.button.callback("« Back", "action_main_menu")],
    ])
  );
});

bot.hears(/^\/bizpaid_(\d+)$/, async (ctx) => {
  const invoiceId = parseInt(ctx.match[1]);
  const inv = bizDb.getBizInvoice(invoiceId);
  if (!inv || parseInt(inv.telegram_id) !== ctx.from.id) return ctx.reply("Invoice not found.");
  if (inv.status === "paid") return ctx.reply(`Invoice #${inv.invoice_number} is already paid ✅`);
  bizDb.markBizInvoicePaid(invoiceId);
  await ctx.reply(
    `✅ Invoice #${inv.invoice_number} marked as paid!\nClient: ${inv.client_name} · ${inv.total_usdc} USDC`,
    Markup.inlineKeyboard([[Markup.button.callback("📋 All Invoices", "action_list_biz_invoices")]])
  );
});

// ─── Expense Logging ──────────────────────────────────────────────────────────

bot.action("action_log_expense", (ctx) => {
  ctx.answerCbQuery();
  pendingAction.set(ctx.from.id, { type: "await_expense_entry" });
  return ctx.reply(
    `💸 Log Expense\n──────────────────────────\n` +
    `Just describe it naturally:\n\n` +
    `• "8000 naira transport to client meeting"\n` +
    `• "50 USDC SaaS subscription"\n` +
    `• "20000 NGN office supplies"\n\n` +
    `Type it below:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("❌ Cancel", "action_main_menu")],
    ])
  );
});

// ─── Cash Flow ───────────────────────────────────────────────────────────────

bot.action("action_cash_flow", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  try {
    const income = bizDb.getMonthIncome(ctx.from.id);
    const expenses = bizDb.getMonthExpenses(ctx.from.id);
    const net = income - expenses;
    const pending = bizDb.getPendingInvoiceTotal(ctx.from.id);
    await ctx.reply(
      `📊 Cash Flow — This Month\n──────────────────────────\n` +
      `💚 Income (paid invoices): $${income.toFixed(2)} USDC\n` +
      `🔴 Expenses: $${expenses.toFixed(2)} USDC\n` +
      `──────────────────────────\n` +
      `${net >= 0 ? "✅" : "⚠️"} Net: $${net.toFixed(2)} USDC\n\n` +
      `📬 Pending (unpaid invoices): $${pending.toFixed(2)} USDC`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📈 Reports", "action_biz_reports"),
         Markup.button.callback("🧾 New Invoice", "action_new_biz_invoice")],
        [Markup.button.callback("« Back", "action_main_menu")],
      ])
    );
  } catch (err) {
    await ctx.reply("Couldn't load cash flow data right now.");
  }
});

// ─── Payroll ─────────────────────────────────────────────────────────────────

bot.hears("👥 Payroll", (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  pendingAction.set(ctx.from.id, { type: "await_payroll_instruction" });
  return ctx.reply(
    `👥 Payroll — Bulk Pay Team\n──────────────────────────\n` +
    `Describe who to pay in plain English:\n\n` +
    `• "Pay Emeka 100 USDC and Amara 80 USDC for this week"\n` +
    `• "Pay 0xABC... 150 USDC salary"\n\n` +
    `Amounts are confirmed before sending. Type your instruction:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
  );
});

// ─── Business Savings ────────────────────────────────────────────────────────

bot.hears("💰 Biz Savings", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const goal = bizDb.getSavingsGoal(ctx.from.id);
  const saved = bizDb.getBizSavingsBalance(ctx.from.id);
  await ctx.reply(
    `💰 Business Savings\n──────────────────────────\n` +
    `Current balance: $${saved.toFixed(2)} USDC\n` +
    (goal ? `Goal: ${goal.percentage}% of each invoice → ${goal.label}\n` : `No auto-save rule set.\n`) +
    `\nSet a rule like "Save 20% of every invoice for tax" and PayIT splits it automatically on each payment.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("⚙️ Set Auto-Save Rule", "action_set_savings_goal")],
      [Markup.button.callback("📈 Earn Yield on Savings", "action_yields")],
      [Markup.button.callback("« Back", "action_main_menu")],
    ])
  );
});

bot.action("action_set_savings_goal", (ctx) => {
  ctx.answerCbQuery();
  pendingAction.set(ctx.from.id, { type: "await_savings_goal" });
  return ctx.reply(
    `⚙️ Set Auto-Save Rule\n──────────────────────────\n` +
    `Describe your goal:\n\n` +
    `• "Save 20% of every invoice for tax"\n` +
    `• "Set aside 10% for emergency fund"\n\n` +
    `Type your rule:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
  );
});

// ─── Business Reports ─────────────────────────────────────────────────────────

bot.action("action_biz_reports", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  try {
    const income = bizDb.getMonthIncome(ctx.from.id);
    const expenses = bizDb.getMonthExpenses(ctx.from.id);
    const expenseBreakdown = bizDb.getExpenseBreakdown(ctx.from.id);
    const topClient = bizDb.getTopClient(ctx.from.id);
    const invoiceCount = bizDb.getMonthInvoiceCount(ctx.from.id);
    const net = income - expenses;
    const margin = income > 0 ? ((net / income) * 100).toFixed(1) : "0";
    const breakdownLines = expenseBreakdown.slice(0, 3)
      .map(e => `  • ${e.category}: $${e.total.toFixed(2)}`)
      .join("\n") || "  None yet";

    await ctx.reply(
      `📈 Business Report — This Month\n──────────────────────────\n` +
      `Revenue: $${income.toFixed(2)} USDC (${invoiceCount} paid invoice${invoiceCount !== 1 ? "s" : ""})\n` +
      `Expenses: $${expenses.toFixed(2)} USDC\n` +
      `Net profit: $${net.toFixed(2)} USDC (${margin}% margin)\n\n` +
      `Top expenses:\n${breakdownLines}\n\n` +
      (topClient ? `Top client: ${topClient.name} ($${topClient.total.toFixed(2)} USDC)\n\n` : "") +
      `💡 Tip: ${net < 0 ? "Expenses exceed revenue this month." : net < income * 0.2 ? "Margins are tight — review top expenses." : "Healthy margins. Consider moving surplus to savings."}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📊 Cash Flow", "action_cash_flow")],
        [Markup.button.callback("💰 Biz Savings", "action_main_menu")],
        [Markup.button.callback("« Back", "action_main_menu")],
      ])
    );
  } catch (err) {
    await ctx.reply("Couldn't generate report right now — try again shortly.");
  }
});
bot.hears("📈 Reports", (ctx) => {
  ctx.answerCbQuery && ctx.answerCbQuery();
  return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: "action_biz_reports" } });
});

// ─── Inline actions (shared) ──────────────────────────────────────────────────

bot.action("action_main_menu", (ctx) => {
  ctx.answerCbQuery();
  const user = db.getUser(ctx.from?.id);
  const context = user?.active_context || "personal";
  return ctx.reply("Choose an option:", buildMainMenu(context));
});

bot.action("action_balance", (ctx) => {
  ctx.answerCbQuery();
  const user = db.getUser(ctx.from?.id);
  if (user?.active_context === "business") return showBizBalance(ctx);
  return showBalance(ctx);
});
bot.action("action_receive", (ctx) => { ctx.answerCbQuery(); return showReceive(ctx); });
bot.action("action_history", (ctx) => { ctx.answerCbQuery(); return showHistory(ctx); });
bot.action("action_yields", (ctx) => { ctx.answerCbQuery(); return showYields(ctx); });
bot.action("action_my_yield", (ctx) => { ctx.answerCbQuery(); return showMyYield(ctx); });
bot.action("action_settings", (ctx) => { ctx.answerCbQuery(); return showSettings(ctx); });

// Withdraw to Naira
bot.action("action_withdraw_menu", (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  pendingAction.set(ctx.from.id, { type: "await_withdraw_amount" });
  return ctx.reply(
    `💸 Cash Out to Naira\n──────────────────────────\nHow much USDC to cash out? Type the amount:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
  );
});

// Send USDC to external wallet
bot.action("action_sendout_menu", (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  if (!user.external_wallet_address) {
    return ctx.reply(
      `👛 No Linked Wallet\n──────────────────────────\nLink an external wallet first.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔗 Link a Wallet", "action_setwallet_prompt")],
        [Markup.button.callback("❌ Cancel", "action_main_menu")],
      ])
    );
  }
  pendingAction.set(ctx.from.id, { type: "await_sendout_amount", token: "USDC" });
  return ctx.reply(
    `👛 Send USDC to External Wallet\n──────────────────────────\nSending to: ${user.external_wallet_address}\n\nHow much USDC?`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
  );
});

// Send EURC to external wallet
bot.action("action_sendout_eurc_menu", (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  if (!user.external_wallet_address) {
    return ctx.reply(
      `👛 No Linked Wallet\n──────────────────────────\nLink an external wallet first.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔗 Link a Wallet", "action_setwallet_prompt")],
        [Markup.button.callback("❌ Cancel", "action_main_menu")],
      ])
    );
  }
  pendingAction.set(ctx.from.id, { type: "await_sendout_amount", token: "EURC" });
  return ctx.reply(
    `💶 Send EURC to External Wallet\n──────────────────────────\nSending to: ${user.external_wallet_address}\n\nHow much EURC?`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
  );
});

// Yield deposit
bot.action("action_yield_deposit_start", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  let balanceMicro;
  try {
    balanceMicro = await walletLib.getNativeBalanceMicro(user.deposit_address);
  } catch {
    return ctx.reply("Couldn't check your balance right now — try again shortly.");
  }
  const balanceUsdc = parseFloat(walletLib.formatMicro(balanceMicro));
  pendingAction.set(ctx.from.id, { type: "await_yield_amount", balanceUsdc });
  return ctx.reply(
    `➕ Deposit into Yield Pool\n──────────────────────────\n` +
    `Available: ${balanceUsdc.toFixed(4)} USDC · Minimum: 1 USDC\n\nHow much to deposit?`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_yields")]])
  );
});

// Yield withdraw
bot.action("action_yield_withdraw_start", (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const position = db.getOpenYieldPosition(ctx.from.id);
  if (!position) {
    return ctx.reply("No active yield position to withdraw.",
      Markup.inlineKeyboard([[Markup.button.callback("➕ Open One", "action_yield_deposit_start")]])
    );
  }
  const accrued = savings.calcAccruedYield(position);
  const total = parseFloat((position.amount_usdc + accrued).toFixed(4));
  pendingAction.set(ctx.from.id, { type: "confirm_yield_withdraw", position, accrued, total });
  return ctx.reply(
    `💵 Withdraw Yield Position\n──────────────────────────\n` +
    `Principal: $${position.amount_usdc.toFixed(2)} USDC\n` +
    `Yield earned: +$${accrued.toFixed(4)} USDC\n` +
    `Total: $${total.toFixed(4)} USDC\n\n` +
    `⚠️ Testnet demo — no real funds move.\n\nType your PIN to confirm:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_yields")]])
  );
});

// Settings
bot.action("action_export_personal", (ctx) => {
  ctx.answerCbQuery();
  pendingAction.set(ctx.from.id, { type: "confirm_export", walletType: "personal" });
  return ctx.reply(
    `🔑 Export Personal Private Key\n──────────────────────────\nAnyone with this key controls your wallet.\n\nType your PIN to proceed:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_settings")]])
  );
});

bot.action("action_export_business", (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user?.business_deposit_address) {
    return ctx.reply("No Business wallet to export yet.");
  }
  pendingAction.set(ctx.from.id, { type: "confirm_export", walletType: "business" });
  return ctx.reply(
    `🔑 Export Business Private Key\n──────────────────────────\nAnyone with this key controls your business wallet.\n\nType your PIN to proceed:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_settings")]])
  );
});

bot.action("action_changepin", (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  pendingAction.set(ctx.from.id, { type: "changepin_old" });
  return ctx.reply(
    `🔒 Change PIN\n──────────────────────────\nType your CURRENT 4-digit PIN:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_settings")]])
  );
});

bot.action("action_setwallet_prompt", (ctx) => {
  ctx.answerCbQuery();
  pendingAction.set(ctx.from.id, { type: "await_setwallet" });
  return ctx.reply(
    `🔗 Link External Wallet\n──────────────────────────\nType your Arc wallet address (0x...):`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_settings")]])
  );
});

bot.action("action_verifyphone_prompt", (ctx) => {
  ctx.answerCbQuery();
  pendingAction.set(ctx.from.id, { type: "await_phone" });
  return ctx.reply(
    `📱 Verify Phone\n──────────────────────────\nType your phone number with country code (no +):\n\nExample: 2348100000000`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_settings")]])
  );
});

// Swap placeholder
bot.action("action_swap", (ctx) => {
  ctx.answerCbQuery();
  return ctx.reply(
    `🔄 Swap\n──────────────────────────\nSwap isn't wired to a verified Arc DEX router yet.\nOnce a confirmed address is available, this will go live.`,
    Markup.inlineKeyboard([[Markup.button.callback("« Back", "action_main_menu")]])
  );
});

bot.action("action_autopay", (ctx) => { ctx.answerCbQuery(); return showAutoPay(ctx); });
bot.action("action_schedules", async (ctx) => {
  ctx.answerCbQuery();
  const jobs = getUserSchedules(ctx.from.id.toString());
  if (jobs.length === 0) return ctx.reply("📅 No active schedules yet.");
  const list = jobs.map((j, i) => `${i + 1}. ${j.plan.summary}\n   /cancelschedule_${j.id}`).join("\n\n");
  return ctx.reply(`📅 Your Schedules\n──────────────────────────\n${list}`);
});

bot.action("action_new_invoice", (ctx) => { ctx.answerCbQuery(); return showInvoiceMenu(ctx); });
bot.action("action_list_invoices", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const invoices = invoiceDb.getUserInvoices(ctx.from.id);
  if (!invoices.length) {
    return ctx.reply("📋 No invoices yet.", Markup.inlineKeyboard([[Markup.button.callback("🧾 Create", "action_new_invoice")]]));
  }
  const lines = invoices.map((inv, i) => {
    const status = inv.status === "paid" ? "✅ Paid" : "⏳ Unpaid";
    return `${i + 1}. #${inv.invoice_number} — ${inv.client_name}\n   ${inv.total_usdc} USDC · ${status}${inv.due_date ? " · Due " + inv.due_date : ""}\n   /markinvoicepaid_${inv.id}`;
  }).join("\n\n");
  await ctx.reply(
    `📋 Your Invoices\n──────────────────────────\n${lines}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🧾 New Invoice", "action_new_invoice")],
      [Markup.button.callback("🏠 Main Menu", "action_main_menu")],
    ])
  );
});

// ─── Transaction execution helpers ────────────────────────────────────────────

async function executeWithdraw(ctx, user, amountMicro, amountUsdcStr, pin) {
  let userWallet;
  try {
    const pk = db.decryptPrivateKey(pin, user);
    userWallet = walletLib.walletFromPrivateKey(pk);
  } catch {
    return ctx.reply("Couldn't unlock your wallet with that PIN.");
  }
  const offrampAddress = process.env.PAJCASH_OFFRAMP_ADDRESS;
  if (!offrampAddress || !walletLib.isValidAddress(offrampAddress)) {
    return ctx.reply("Off-ramp not configured yet (PAJCASH_OFFRAMP_ADDRESS missing in .env).",
      Markup.inlineKeyboard([[Markup.button.callback("« Back", "action_main_menu")]]) );
  }
  const txId = db.recordTransaction(user.telegram_id, "offramp_request", amountMicro, "pending", null);
  let txHash;
  try {
    txHash = await walletLib.sendFromWallet(userWallet, offrampAddress, amountMicro);
  } catch (err) {
    db.updateTransactionStatus(txId, "failed");
    return ctx.reply("On-chain transfer failed: " + err.message);
  }
  try {
    const result = await offramp.requestOfframp(user.telegram_id, amountMicro, {
      accountNumber: "0000000000", bankCode: "000", accountName: ctx.from.first_name || "PayIT User",
    });
    db.updateTransactionStatus(txId, "submitted");
    await ctx.reply(
      `✅ Cash Out Submitted\n──────────────────────────\nSent ${amountUsdcStr} USDC on-chain\nTx: ${txHash}\nRef: ${result.reference || result.id}\n\n(Needs real Paj Cash credentials for Naira payout.)`,
      afterSuccessButtons
    );
  } catch (err) {
    db.updateTransactionStatus(txId, "onchain_sent_notify_failed");
    await ctx.reply(
      `⚠️ USDC sent on-chain (tx: ${txHash}), but Paj Cash notification failed: ${err.message}\nContact support with this tx hash if Naira doesn't arrive.`,
      afterSuccessButtons
    );
  }
}

async function executeSendout(ctx, user, amountMicro, pin, token = "USDC") {
  if (!user.external_wallet_address) {
    return ctx.reply("Link a wallet first.",
      Markup.inlineKeyboard([[Markup.button.callback("🔗 Link Wallet", "action_setwallet_prompt")]]) );
  }
  // Use active context wallet as source
  const context = user.active_context || "personal";
  let userWallet;
  try {
    const pk = context === "business"
      ? db.decryptBusinessPrivateKey(pin, user)
      : db.decryptPrivateKey(pin, user);
    userWallet = walletLib.walletFromPrivateKey(pk);
  } catch {
    return ctx.reply("Couldn't unlock your wallet with that PIN.");
  }
  const txId = db.recordTransaction(user.telegram_id, `sendout_${token.toLowerCase()}`, amountMicro, "pending", null);
  try {
    let txHash;
    if (token === "EURC") {
      txHash = await tokens.sendEurc(userWallet, user.external_wallet_address, amountMicro);
    } else {
      txHash = await walletLib.sendFromWallet(userWallet, user.external_wallet_address, amountMicro);
    }
    db.updateTransactionStatus(txId, "confirmed");
    await ctx.reply(
      `✅ Sent!\n──────────────────────────\n${walletLib.formatMicro(amountMicro)} ${token} → ${user.external_wallet_address}\nTx: ${txHash}`,
      afterSuccessButtons
    );
  } catch (err) {
    db.updateTransactionStatus(txId, "failed");
    await ctx.reply("Transfer failed: " + err.message);
  }
}

// ─── Account switch helpers ────────────────────────────────────────────────────

async function switchToPersonal(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  db.setActiveContext(ctx.from.id, "personal");
  const balance = await safeGetBalance(user.deposit_address);
  return ctx.reply(
    `👤 Switched to Personal account.\n\nBalance: ${balance}\nWallet: ${user.deposit_address}`,
    buildMainMenu("personal")
  );
}

async function switchToBusiness(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  if (!user.business_deposit_address) {
    pendingAction.set(ctx.from.id, {
      type: "create_business_wallet",
      businessAddress: walletLib.generateUserWallet().address,
      businessPrivateKey: walletLib.generateUserWallet().privateKey,
    });
    return ctx.reply(
      `🏢 Setting up your Business account.\n\nEnter your PIN to create and encrypt your Business wallet:`,
      Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
    );
  }
  db.setActiveContext(ctx.from.id, "business");
  const balance = await safeGetBalance(user.business_deposit_address);
  const pendingInvoices = bizDb.getPendingInvoiceCount(ctx.from.id);
  const pendingLine = pendingInvoices > 0
    ? `\n📬 ${pendingInvoices} unpaid invoice${pendingInvoices > 1 ? "s" : ""} pending.`
    : "";
  return ctx.reply(
    `🏢 Switched to Business account.\n\nBalance: ${balance}${pendingLine}\nWallet: ${user.business_deposit_address}`,
    buildMainMenu("business")
  );
}

bot.hears("🏢 Switch to Business", switchToBusiness);
bot.hears("👤 Switch to Personal", switchToPersonal);

// /switch command — works from anywhere anytime
bot.command("switch", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const current = user.active_context || "personal";
  if (current === "personal") {
    return switchToBusiness(ctx);
  } else {
    return switchToPersonal(ctx);
  }
});

// ─── Bottom keyboard listeners ─────────────────────────────────────────────────

bot.hears("💰 Balance", (ctx) => {
  const user = db.getUser(ctx.from?.id);
  if (user?.active_context === "business") return showBizBalance(ctx);
  return showBalance(ctx);
});
bot.hears("🏢 Biz Balance", showBizBalance);
bot.hears("📥 Receive", showReceive);
bot.hears("📋 History", showHistory);
bot.hears("⚙️ Settings", showSettings);
bot.hears("📖 How to Use", showHelp);
bot.hears("✨ Features", showFeatures);
bot.hears("📈 Yields", showYields);
bot.hears("📊 Cash Flow", (ctx) => { ctx.answerCbQuery && ctx.answerCbQuery(); bot.action("action_cash_flow")(ctx); });

bot.hears("📤 Send", (ctx) => ctx.reply(
  `📤 Send\n──────────────────────────\nWhere would you like to send?`,
  Markup.inlineKeyboard([
    [Markup.button.callback("💵 Cash Out to Naira", "action_withdraw_menu")],
    [Markup.button.callback("👛 Send USDC to Wallet", "action_sendout_menu")],
    [Markup.button.callback("💶 Send EURC to Wallet", "action_sendout_eurc_menu")],
    [Markup.button.callback("« Back", "action_main_menu")],
  ])
));

bot.hears("📤 Send Payment", (ctx) => ctx.reply(
  `📤 Business Payment\n──────────────────────────\nPay a supplier, partner, or contractor.`,
  Markup.inlineKeyboard([
    [Markup.button.callback("👛 Send USDC", "action_sendout_menu")],
    [Markup.button.callback("💶 Send EURC", "action_sendout_eurc_menu")],
    [Markup.button.callback("💵 Cash Out to Naira", "action_withdraw_menu")],
    [Markup.button.callback("« Back", "action_main_menu")],
  ])
));

bot.hears("💵 Cash Out", (ctx) => {
  pendingAction.set(ctx.from.id, { type: "await_withdraw_amount" });
  return ctx.reply(
    `💵 Cash Out to Naira\n──────────────────────────\nHow much USDC to cash out?`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
  );
});

bot.hears("🔄 Swap", (ctx) => ctx.reply(
  `🔄 Swap\n──────────────────────────\nSwap isn't wired to a verified Arc DEX router yet.`,
  Markup.inlineKeyboard([[Markup.button.callback("« Back", "action_main_menu")]])
));

// ─── Invoice hears ─────────────────────────────────────────────────────────────

async function showInvoiceMenu(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  pendingAction.set(ctx.from.id, { type: "await_invoice_instruction" });
  return ctx.reply(
    `🧾 Invoice Manager\n──────────────────────────\n` +
    `Create USDC invoices in plain English:\n\n` +
    `• "Invoice Acme Ltd 500 USDC for website design, due July 15"\n` +
    `• "Bill TechCorp 200 USDC consulting and 100 USDC hosting"\n\n` +
    `Type your instruction:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📋 My Invoices", "action_list_invoices")],
      [Markup.button.callback("« Back", "action_main_menu")],
    ])
  );
}

bot.hears("🧾 Invoice", (ctx) => {
  // Route to business invoice if in business context
  const user = db.getUser(ctx.from?.id);
  if (user?.active_context === "business") return showBizInvoiceMenu(ctx);
  return showInvoiceMenu(ctx);
});
bot.hears("🧾 New Invoice", showBizInvoiceMenu);
bot.hears("📋 Invoices", (ctx) => {
  const user = db.getUser(ctx.from?.id);
  if (user?.active_context === "business") {
    return bot.handleUpdate({ update_id: ctx.update.update_id, callback_query: { id: "0", from: ctx.from, chat_instance: "0", data: "action_list_biz_invoices", message: ctx.message } });
  }
  return showInvoiceMenu(ctx);
});
bot.command("invoice", (ctx) => {
  const user = db.getUser(ctx.from?.id);
  if (user?.active_context === "business") return showBizInvoiceMenu(ctx);
  return showInvoiceMenu(ctx);
});

bot.hears(/^\/markinvoicepaid_(\d+)$/, async (ctx) => {
  const invoiceId = parseInt(ctx.match[1]);
  const inv = invoiceDb.getInvoice(invoiceId);
  if (!inv || parseInt(inv.telegram_id) !== ctx.from.id) return ctx.reply("Invoice not found.");
  if (inv.status === "paid") return ctx.reply(`Invoice #${inv.invoice_number} is already marked as paid ✅`);
  invoiceDb.markInvoicePaid(invoiceId);
  await ctx.reply(`✅ Invoice #${inv.invoice_number} marked as paid!\nClient: ${inv.client_name} · ${inv.total_usdc} USDC`,
    Markup.inlineKeyboard([[Markup.button.callback("📋 All Invoices", "action_list_invoices")]])
  );
});

// ─── AutoPay ──────────────────────────────────────────────────────────────────

async function showAutoPay(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  pendingAction.set(ctx.from.id, { type: "await_autopay_instruction" });
  const jobs = getUserSchedules(ctx.from.id.toString());
  const jobSummary = jobs.length > 0
    ? `\n\n📅 You have ${jobs.length} active schedule(s). Use /schedules to manage.`
    : "";
  return ctx.reply(
    `🤖 AutoPay — AI Payment Orchestration\n──────────────────────────\n` +
    `Tell me what to do in plain English:\n\n` +
    `• Send 5 USDC to 0xABC...123 every Friday\n` +
    `• Pay 2 USDC to 0xDEF...456 now\n` +
    `• Split 10 USDC between 0xAAA... and 0xBBB... monthly\n\n` +
    `Type your instruction:` + jobSummary,
    Markup.inlineKeyboard([
      [Markup.button.callback("📅 View Schedules", "action_schedules")],
      [Markup.button.callback("« Back", "action_main_menu")],
    ])
  );
}

bot.hears("🤖 AutoPay", showAutoPay);
bot.command("autopay", showAutoPay);

bot.command("schedules", async (ctx) => {
  const jobs = getUserSchedules(ctx.from.id.toString());
  if (jobs.length === 0) {
    return ctx.reply("📅 No active scheduled payments.\n\nUse 🤖 AutoPay to set one up.",
      Markup.inlineKeyboard([[Markup.button.callback("🤖 AutoPay", "action_autopay")]]) );
  }
  const list = jobs.map((j, i) =>
    `${i + 1}. ${j.plan.summary}\n   Freq: ${j.plan.schedule.frequency}` +
    (j.plan.schedule.day ? ` on ${j.plan.schedule.day}` : "") +
    `\n   /cancelschedule_${j.id}`
  ).join("\n\n");
  await ctx.reply(`📅 Your Scheduled Payments\n──────────────────────────\n${list}`);
});

bot.hears(/^\/cancelschedule_(.+)$/, async (ctx) => {
  const jobId = ctx.match[1];
  cancelJob(jobId);
  const removed = removeSchedule(ctx.from.id.toString(), jobId);
  if (removed) {
    await ctx.reply("✅ Schedule cancelled.",
      Markup.inlineKeyboard([[Markup.button.callback("📅 Schedules", "action_schedules")]]) );
  } else {
    await ctx.reply("Couldn't find that schedule.");
  }
});

// ─── Admin ────────────────────────────────────────────────────────────────────

bot.command("menu", (ctx) => {
  const user = db.getUser(ctx.from?.id);
  const context = user?.active_context || "personal";
  return ctx.reply("Choose an option:", buildMainMenu(context));
});

bot.command("admin", (ctx) => {
  if (!ADMIN_IDS.includes(String(ctx.from.id))) return ctx.reply("Not authorized.");
  const userCount = db.db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  const activePositions = db.db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(amount_usdc), 0) as total FROM yield_positions WHERE status = 'active'").get();
  const invoiceCount = db.db.prepare("SELECT COUNT(*) as c FROM invoices").get().c;
  const paidInvoices = db.db.prepare("SELECT COUNT(*) as c FROM invoices WHERE status = 'paid'").get().c;
  const recentTx = db.db.prepare("SELECT * FROM transactions ORDER BY id DESC LIMIT 8").all();
  const txLines = recentTx.map((t) => `#${t.id} ${t.type} · user ${t.telegram_id} · [${t.status}]`).join("\n") || "none yet";
  ctx.reply(
    `🛠 Admin Stats\n──────────────────────────\n` +
    `Users: ${userCount}\n` +
    `Active yield positions: ${activePositions.c} ($${activePositions.total.toFixed(2)} USDC tracked)\n` +
    `Invoices: ${invoiceCount} (${paidInvoices} paid)\n\n` +
    `Recent transactions:\n${txLines}`
  );
});

bot.command("help", showHelp);
bot.command("balance", showBalance);
bot.command("history", showHistory);
bot.command("settings", showSettings);
bot.command("yields", showYields);
bot.command("deposit", showReceive);

// ─── Invoice confirm action (Personal) ────────────────────────────────────────

bot.action("action_confirm_invoice", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const pending = pendingAction.get(ctx.from.id);
  if (!pending || pending.type !== "confirm_invoice") {
    return ctx.reply("Session expired. Start again with 🧾 Invoice.");
  }
  pendingAction.delete(ctx.from.id);
  const { parsed, total } = pending;
  await ctx.reply("⏳ Generating invoice image...");
  try {
    const invoiceNumber = invoiceDb.getNextInvoiceNumber(ctx.from.id);
    const issueDate = new Date().toISOString().split("T")[0];
    const walletAddress = user.deposit_address; // Personal invoices use personal wallet
    const pngPath = await generateInvoicePNG({
      invoiceNumber, clientName: parsed.clientName, clientEmail: parsed.clientEmail,
      items: parsed.items, dueDate: parsed.dueDate, notes: parsed.notes,
      businessName: user.username || `User ${ctx.from.id}`,
      walletAddress, issueDate,
    });
    const invoiceId = invoiceDb.createInvoice(ctx.from.id, {
      invoiceNumber, clientName: parsed.clientName, clientEmail: parsed.clientEmail || null,
      items: parsed.items, totalUsdc: total, dueDate: parsed.dueDate || null,
      notes: parsed.notes || null, walletAddress, pngPath,
    });
    await ctx.replyWithPhoto({ source: pngPath }, {
      caption: `🧾 Invoice #${invoiceNumber}\nClient: ${parsed.clientName}\nAmount: ${total.toFixed(2)} USDC\n` +
        (parsed.dueDate ? `Due: ${parsed.dueDate}\n` : "") +
        `\nPayment address:\n\`${walletAddress}\``,
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📋 All Invoices", "action_list_invoices")],
        [Markup.button.callback("✅ Mark as Paid", `action_paid_${invoiceId}`)],
        [Markup.button.callback("🏠 Main Menu", "action_main_menu")],
      ]),
    });
  } catch (err) {
    console.error("[invoice]", err);
    await ctx.reply("Something went wrong generating the invoice. Please try again.");
  }
});

bot.action(/^action_paid_(\d+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const invoiceId = parseInt(ctx.match[1]);
  const inv = invoiceDb.getInvoice(invoiceId);
  if (!inv || parseInt(inv.telegram_id) !== ctx.from.id) return ctx.reply("Invoice not found.");
  if (inv.status === "paid") return ctx.reply("Already marked as paid ✅");
  invoiceDb.markInvoicePaid(invoiceId);
  await ctx.reply(`✅ Invoice #${inv.invoice_number} marked as paid!\nClient: ${inv.client_name} · ${inv.total_usdc} USDC`,
    Markup.inlineKeyboard([[Markup.button.callback("📋 All Invoices", "action_list_invoices")]])
  );
});

// ─── Text catch-all: multi-step flows ─────────────────────────────────────────

bot.on("text", async (ctx) => {
  const pending = pendingAction.get(ctx.from.id);
  if (!pending) return;
  const text = ctx.message.text.trim();

  // ── Onboarding PIN ──
  if (pending.type === "onboarding_set_pin") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("PIN must be exactly 4 digits. Try again.");
    const isBusinessOnboard = pending.accountType === "business";
    const user = db.createUserWithWallet(
      ctx.from.id, pending.username, pending.address, pending.privateKey, text,
      isBusinessOnboard ? pending.businessAddress : null,
      isBusinessOnboard ? pending.businessPrivateKey : null
    );
    pendingAction.delete(ctx.from.id);
    const exportMsg = await ctx.reply(
      `✅ PIN set! Your wallet${isBusinessOnboard ? "s are" : " is"} ready.\n\n` +
      `Personal wallet:\n${pending.address}\n` +
      `Private key:\n${pending.privateKey}\n\n` +
      (isBusinessOnboard
        ? `Business wallet:\n${pending.businessAddress}\n` +
          `Business private key:\n${pending.businessPrivateKey}\n\n`
        : "") +
      `⚠️ Save these NOW — a password manager, not a screenshot. Auto-deletes in 60 seconds.`
    );
    scheduleDelete(ctx, exportMsg.message_id, 60000);
    const context = isBusinessOnboard ? "business" : "personal";
    db.setActiveContext(ctx.from.id, context);
    return ctx.reply("What would you like to do?", buildMainMenu(context));
  }

  // ── Create business wallet (lazy, PIN-gated) ──
  if (pending.type === "create_business_wallet") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
    if (!db.verifyPin(ctx.from.id, text)) return ctx.reply("Incorrect PIN. Try again.");
    const user = db.getUser(ctx.from.id);
    // Encrypt business key with same PIN
    db.addBusinessWallet(ctx.from.id, pending.businessAddress, pending.businessPrivateKey, text);
    db.setActiveContext(ctx.from.id, "business");
    pendingAction.delete(ctx.from.id);
    const exportMsg = await ctx.reply(
      `✅ Business wallet created!\n\n${pending.businessAddress}\n\nBusiness private key:\n${pending.businessPrivateKey}\n\n` +
      `⚠️ Save this now — auto-deletes in 60 seconds.`
    );
    scheduleDelete(ctx, exportMsg.message_id, 60000);
    return ctx.reply("Switched to Business account. What would you like to do?", buildMainMenu("business"));
  }

  // ── Export key PIN confirm ──
  if (pending.type === "confirm_export") {
    pendingAction.delete(ctx.from.id);
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
    if (!db.verifyPin(ctx.from.id, text)) return ctx.reply("Incorrect PIN.");
    try {
      const user = db.getUser(ctx.from.id);
      const pk = pending.walletType === "business"
        ? db.decryptBusinessPrivateKey(text, user)
        : db.decryptPrivateKey(text, user);
      const label = pending.walletType === "business" ? "Business" : "Personal";
      const msg = await ctx.reply(
        `🔑 Your ${label} Private Key\n──────────────────────────\n${pk}\n\nSave it now — auto-deletes in 60 seconds.`
      );
      scheduleDelete(ctx, msg.message_id, 60000);
    } catch {
      await ctx.reply("Couldn't decrypt your key.");
    }
    return;
  }

  // ── Change PIN ──
  if (pending.type === "changepin_old") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your current 4-digit PIN.");
    if (!db.verifyPin(ctx.from.id, text)) {
      pendingAction.delete(ctx.from.id);
      return ctx.reply("Incorrect PIN.", Markup.inlineKeyboard([[Markup.button.callback("Try Again", "action_changepin")]]));
    }
    const user = db.getUser(ctx.from.id);
    let pk, bizPk;
    try {
      pk = db.decryptPrivateKey(text, user);
      if (user.business_deposit_address) bizPk = db.decryptBusinessPrivateKey(text, user);
    } catch {
      pendingAction.delete(ctx.from.id);
      return ctx.reply("Couldn't unlock your wallet.");
    }
    pendingAction.set(ctx.from.id, { type: "changepin_new", privateKey: pk, businessPrivateKey: bizPk });
    return ctx.reply("Now type your NEW 4-digit PIN:");
  }

  if (pending.type === "changepin_new") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("PIN must be exactly 4 digits.");
    db.updatePin(ctx.from.id, text, pending.privateKey, pending.businessPrivateKey);
    pendingAction.delete(ctx.from.id);
    return ctx.reply("✅ PIN changed. Both wallets re-encrypted with new PIN.",
      Markup.inlineKeyboard([[Markup.button.callback("« Back to Settings", "action_settings")]])
    );
  }

  // ── Link external wallet ──
  if (pending.type === "await_setwallet") {
    pendingAction.delete(ctx.from.id);
    if (!walletLib.isValidAddress(text)) {
      return ctx.reply("That doesn't look like a valid address.",
        Markup.inlineKeyboard([[Markup.button.callback("« Cancel", "action_settings")]])
      );
    }
    db.setExternalWallet(ctx.from.id, text);
    return ctx.reply(`✅ Wallet linked!\n${text}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📤 Send USDC", "action_sendout_menu")],
        [Markup.button.callback("« Back to Settings", "action_settings")],
      ])
    );
  }

  // ── Phone verify ──
  if (pending.type === "await_phone") {
    pendingAction.delete(ctx.from.id);
    const phone = text.replace(/\D/g, "");
    try {
      const result = await otp.sendOtp(phone);
      db.setPhoneNumber(ctx.from.id, phone);
      pendingAction.set(ctx.from.id, { type: "confirm_otp", pinId: result.pinId });
      return ctx.reply(`📱 Code sent to ${phone}.\n\nType the code to verify:`,
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_settings")]])
      );
    } catch (err) {
      return ctx.reply("Couldn't send the code (check TERMII_API_KEY in .env): " + err.message);
    }
  }

  if (pending.type === "confirm_otp") {
    pendingAction.delete(ctx.from.id);
    if (!/^\d{4,6}$/.test(text)) return ctx.reply("Enter the code you received.");
    try {
      const verified = await otp.verifyOtp(pending.pinId, text);
      if (verified) {
        db.setPhoneVerified(ctx.from.id, true);
        return ctx.reply("✅ Phone verified!",
          Markup.inlineKeyboard([[Markup.button.callback("« Back to Settings", "action_settings")]])
        );
      }
      return ctx.reply("That code didn't match.",
        Markup.inlineKeyboard([[Markup.button.callback("« Back to Settings", "action_settings")]])
      );
    } catch (err) {
      return ctx.reply("Couldn't verify the code: " + err.message);
    }
  }

  // ── Withdraw amount ──
  if (pending.type === "await_withdraw_amount") {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply("Enter a valid amount (e.g. 10):",
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
      );
    }
    let amountMicro;
    try { amountMicro = walletLib.parseToMicro(text); } catch {
      return ctx.reply("Invalid amount. Try again.");
    }
    const user = requireUser(ctx);
    if (!user) return;
    const address = getActiveWallet(user);
    const balance = await walletLib.getNativeBalanceMicro(address);
    if (balance < amountMicro) {
      return ctx.reply(`Insufficient balance. You have ${walletLib.formatMicro(balance)} USDC.`,
        Markup.inlineKeyboard([[Markup.button.callback("« Back", "action_main_menu")]])
      );
    }
    pendingAction.set(ctx.from.id, { type: "confirm_withdraw", amountMicro: amountMicro.toString(), amountUsdc: text });
    return ctx.reply(
      `💸 Confirm Cash Out\n──────────────────────────\nAmount: ${text} USDC → Naira via Paj Cash\n\nType your PIN:`,
      Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
    );
  }

  if (pending.type === "confirm_withdraw") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
    pendingAction.delete(ctx.from.id);
    if (!db.verifyPin(ctx.from.id, text)) return ctx.reply("Incorrect PIN. Try again.");
    const user = db.getUser(ctx.from.id);
    return executeWithdraw(ctx, user, BigInt(pending.amountMicro), pending.amountUsdc, text);
  }

  // ── Sendout amount (USDC or EURC) ──
  if (pending.type === "await_sendout_amount") {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply("Enter a valid amount:",
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
      );
    }
    let amountMicro;
    try { amountMicro = walletLib.parseToMicro(text); } catch {
      return ctx.reply("Invalid amount.");
    }
    const user = requireUser(ctx);
    if (!user) return;
    const address = getActiveWallet(user);
    // Check correct token balance
    let balance;
    if (pending.token === "EURC") {
      balance = await tokens.getEurcBalance(address);
    } else {
      balance = await walletLib.getNativeBalanceMicro(address);
    }
    if (balance < amountMicro) {
      return ctx.reply(`Insufficient ${pending.token} balance. You have ${walletLib.formatMicro(balance)} ${pending.token}.`,
        Markup.inlineKeyboard([[Markup.button.callback("« Back", "action_main_menu")]])
      );
    }
    pendingAction.set(ctx.from.id, { type: "confirm_sendout", amountMicro: amountMicro.toString(), token: pending.token });
    return ctx.reply(
      `👛 Confirm Send\n──────────────────────────\n` +
      `Amount: ${text} ${pending.token}\nTo: ${user.external_wallet_address}\n\nType your PIN:`,
      Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
    );
  }

  if (pending.type === "confirm_sendout") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
    pendingAction.delete(ctx.from.id);
    if (!db.verifyPin(ctx.from.id, text)) return ctx.reply("Incorrect PIN. Try again.");
    const user = db.getUser(ctx.from.id);
    return executeSendout(ctx, user, BigInt(pending.amountMicro), text, pending.token || "USDC");
  }

  // ── Yield deposit amount ──
  if (pending.type === "await_yield_amount") {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount < 1) {
      return ctx.reply("Enter a valid amount (minimum 1 USDC):",
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_yields")]])
      );
    }
    if (amount > pending.balanceUsdc) {
      return ctx.reply(`Insufficient balance. You have ${pending.balanceUsdc.toFixed(4)} USDC.`,
        Markup.inlineKeyboard([[Markup.button.callback("« Back", "action_yields")]])
      );
    }
    let pools;
    try { pools = await savings.getYieldPools(); } catch {
      return ctx.reply("Couldn't load pool data — try again.");
    }
    const bestPool = pools[0];
    pendingAction.set(ctx.from.id, { type: "confirm_yield_deposit", amountUsdc: amount, pool: bestPool });
    return ctx.reply(
      `📈 Confirm Yield Deposit\n──────────────────────────\n` +
      `Amount: $${amount.toFixed(2)} USDC\n` +
      `Pool: ${bestPool.symbol} · ${bestPool.project} · ${bestPool.chain}\n` +
      `Your APY: ${bestPool.userApy}%  (raw: ${bestPool.rawApy.toFixed(1)}%)\n` +
      `PayIT fee: ${bestPool.payitApy}% APY\n\n` +
      `⚠️ Testnet demo — no real bridge fires.\n\nType your PIN:`,
      Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_yields")]])
    );
  }

  if (pending.type === "confirm_yield_deposit") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
    pendingAction.delete(ctx.from.id);
    if (!db.verifyPin(ctx.from.id, text)) return ctx.reply("Incorrect PIN. Try again.");
    try {
      savings.openYieldPosition(ctx.from.id, pending.amountUsdc, pending.pool);
      db.recordTransaction(ctx.from.id, "yield_deposit", BigInt(Math.round(pending.amountUsdc * 1e18)), "confirmed", null);
      await ctx.reply(
        `✅ Yield Position Opened!\n──────────────────────────\n` +
        `$${pending.amountUsdc.toFixed(2)} USDC earning at ${pending.pool.userApy}% APY\n` +
        `Pool: ${pending.pool.symbol} · ${pending.pool.project} · ${pending.pool.chain}`,
        afterYieldOpenButtons
      );
    } catch (err) {
      await ctx.reply("Something went wrong: " + err.message);
    }
    return;
  }

  if (pending.type === "confirm_yield_withdraw") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
    pendingAction.delete(ctx.from.id);
    if (!db.verifyPin(ctx.from.id, text)) return ctx.reply("Incorrect PIN. Try again.");
    try {
      db.closeYieldPosition(ctx.from.id, pending.total);
      db.recordTransaction(ctx.from.id, "yield_withdraw", BigInt(Math.round(pending.total * 1e18)), "confirmed", null);
      await ctx.reply(
        `✅ Yield Position Closed\n──────────────────────────\n` +
        `Principal: $${pending.position.amount_usdc.toFixed(2)} USDC\n` +
        `Yield earned: +$${pending.accrued.toFixed(4)} USDC\n` +
        `Total returned: $${pending.total.toFixed(4)} USDC\n\n` +
        `📌 Testnet demo — funds returned to wallet record.`,
        afterSuccessButtons
      );
    } catch (err) {
      await ctx.reply("Something went wrong: " + err.message);
    }
    return;
  }

  // ── Business invoice instruction ──
  if (pending.type === "await_biz_invoice_instruction") {
    pendingAction.delete(ctx.from.id);
    const user = requireUser(ctx);
    if (!user) return;
    await ctx.reply("🧾 Generating your invoice...");
    const walletAddress = user.business_deposit_address || user.deposit_address;
    const parsed = await parseInvoiceIntent(text, {
      businessName: user.username || `User ${ctx.from.id}`,
      walletAddress,
    });
    if (parsed.error) {
      return ctx.reply(`❌ ${parsed.error}\n\nTry again with 🧾 New Invoice.`,
        Markup.inlineKeyboard([[Markup.button.callback("🧾 Try Again", "action_new_biz_invoice")]])
      );
    }
    const total = parsed.items.reduce((s, i) => s + Number(i.quantity || 1) * Number(i.unitPrice || 0), 0);
    const itemLines = parsed.items.map(i => `• ${i.description} × ${i.quantity || 1} @ ${Number(i.unitPrice).toFixed(2)} USDC`).join("\n");
    const preview =
      `📋 Invoice Preview\n──────────────────────────\n` +
      `To: ${parsed.clientName}${parsed.clientEmail ? " (" + parsed.clientEmail + ")" : ""}\n` +
      `${itemLines}\n──────────────────────────\n` +
      `Total: ${total.toFixed(2)} USDC\n` +
      (parsed.dueDate ? `Due: ${parsed.dueDate}\n` : "") +
      `\nLooks right? Confirm to generate the invoice.`;
    pendingAction.set(ctx.from.id, { type: "confirm_biz_invoice", parsed, total, walletAddress });
    return ctx.reply(preview, Markup.inlineKeyboard([
      [Markup.button.callback("✅ Generate Invoice", "action_confirm_biz_invoice")],
      [Markup.button.callback("✏️ Edit", "action_new_biz_invoice")],
      [Markup.button.callback("❌ Cancel", "action_main_menu")],
    ]));
  }

  // ── Expense entry ──
  if (pending.type === "await_expense_entry") {
    pendingAction.delete(ctx.from.id);
    // Simple NL parse: extract amount and description
    const nairaMatch = text.match(/(\d[\d,]*)\s*(naira|ngn|₦)/i);
    const usdcMatch = text.match(/(\d+(?:\.\d+)?)\s*usdc/i);
    let amount = 0, currency = "NGN", description = text;
    if (usdcMatch) { amount = parseFloat(usdcMatch[1]); currency = "USDC"; }
    else if (nairaMatch) { amount = parseFloat(nairaMatch[1].replace(/,/g, "")); currency = "NGN"; }
    else {
      const numMatch = text.match(/^(\d+(?:\.\d+)?)\s+(.+)/);
      if (numMatch) { amount = parseFloat(numMatch[1]); description = numMatch[2]; }
    }
    if (amount <= 0) {
      return ctx.reply("Couldn't parse an amount from that. Try: '8000 naira transport' or '50 USDC SaaS tools'",
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
      );
    }
    bizDb.logExpense(ctx.from.id, amount, currency, description);
    return ctx.reply(
      `✅ Expense logged!\n${currency === "USDC" ? "$" : "₦"}${amount.toLocaleString()} ${currency} — ${description}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("💸 Log Another", "action_log_expense")],
        [Markup.button.callback("📊 Cash Flow", "action_cash_flow")],
        [Markup.button.callback("🏠 Main Menu", "action_main_menu")],
      ])
    );
  }

  // ── Savings goal ──
  if (pending.type === "await_savings_goal") {
    pendingAction.delete(ctx.from.id);
    const pctMatch = text.match(/(\d+)%/);
    const percentage = pctMatch ? parseInt(pctMatch[1]) : 10;
    const label = text.replace(/set aside|save|of every invoice/gi, "").trim() || "Savings";
    bizDb.setSavingsGoal(ctx.from.id, percentage, label);
    return ctx.reply(
      `✅ Auto-save rule set!\nEvery time a business invoice is paid, ${percentage}% moves to your Business Savings.\nGoal: ${label}`,
      Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "action_main_menu")]])
    );
  }

  // ── Payroll instruction ──
  if (pending.type === "await_payroll_instruction") {
    pendingAction.delete(ctx.from.id);
    const user = requireUser(ctx);
    if (!user) return;
    await ctx.reply("🤖 Parsing payroll instruction...");
    const plan = await parsePaymentIntent(text, {
      balance: "0",
      address: user.business_deposit_address || user.deposit_address,
    });
    if (plan.error) {
      return ctx.reply(`❌ ${plan.error}\n\nTry: "Pay Emeka 100 USDC and Amara 80 USDC"`,
        Markup.inlineKeyboard([[Markup.button.callback("« Back", "action_main_menu")]])
      );
    }
    const paymentLines = plan.payments.map(p => `• ${p.amount} USDC → \`${p.to}\`\n  (${p.label})`).join("\n");
    pendingAction.set(ctx.from.id, { type: "confirm_payroll_pin", plan });
    return ctx.reply(
      `👥 Payroll Preview\n──────────────────────────\n${paymentLines}\n\n${plan.summary}\n\nType your PIN to confirm:`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]]) }
    );
  }

  if (pending.type === "confirm_payroll_pin") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
    pendingAction.delete(ctx.from.id);
    if (!db.verifyPin(ctx.from.id, text)) return ctx.reply("Incorrect PIN. Try again.");
    const user = db.getUser(ctx.from.id);
    await ctx.reply("⏳ Processing payroll...");
    const results = await executePlan(pending.plan, text, user);
    const msg = formatResults(results);
    return ctx.reply(msg, { parse_mode: "Markdown", ...afterSuccessButtons });
  }

  // ── Personal invoice instruction ──
  if (pending.type === "await_invoice_instruction") {
    pendingAction.delete(ctx.from.id);
    const user = requireUser(ctx);
    if (!user) return;
    await ctx.reply("🧾 Generating your invoice...");
    const parsed = await parseInvoiceIntent(text, {
      businessName: user.username || `User ${ctx.from.id}`,
      walletAddress: user.deposit_address,
    });
    if (parsed.error) {
      return ctx.reply(`❌ ${parsed.error}\n\nTry again with 🧾 Invoice.`,
        Markup.inlineKeyboard([[Markup.button.callback("🧾 Try Again", "action_new_invoice")]])
      );
    }
    const total = parsed.items.reduce((s, i) => s + Number(i.quantity || 1) * Number(i.unitPrice || 0), 0);
    const itemLines = parsed.items.map(i => `• ${i.description} × ${i.quantity || 1} @ ${Number(i.unitPrice).toFixed(2)} USDC`).join("\n");
    const preview =
      `📋 Invoice Preview\n──────────────────────────\n` +
      `To: ${parsed.clientName}${parsed.clientEmail ? " (" + parsed.clientEmail + ")" : ""}\n` +
      `${itemLines}\n──────────────────────────\n` +
      `Total: ${total.toFixed(2)} USDC\n` +
      (parsed.dueDate ? `Due: ${parsed.dueDate}\n` : "") +
      `\nLooks right?`;
    pendingAction.set(ctx.from.id, { type: "confirm_invoice", parsed, total });
    return ctx.reply(preview, Markup.inlineKeyboard([
      [Markup.button.callback("✅ Generate Invoice", "action_confirm_invoice")],
      [Markup.button.callback("✏️ Edit", "action_new_invoice")],
      [Markup.button.callback("❌ Cancel", "action_main_menu")],
    ]));
  }

  // ── AutoPay instruction ──
  if (pending.type === "await_autopay_instruction") {
    pendingAction.delete(ctx.from.id);
    const user = requireUser(ctx);
    if (!user) return;
    await ctx.reply("🤖 Analysing your instruction...");
    let balanceMicro = BigInt(0);
    try { balanceMicro = await walletLib.getNativeBalanceMicro(user.deposit_address); } catch {}
    const plan = await parsePaymentIntent(text, {
      balance: walletLib.formatMicro(balanceMicro),
      address: user.deposit_address,
    });
    if (plan.error) {
      return ctx.reply(`❌ ${plan.error}\n\nTry again with 🤖 AutoPay.`,
        Markup.inlineKeyboard([[Markup.button.callback("🤖 Try Again", "action_autopay")]])
      );
    }
    const paymentLines = plan.payments.map(p => `• ${p.amount} USDC → \`${p.to}\`\n  (${p.label})`).join("\n");
    const scheduleText = plan.schedule?.frequency
      ? `\n🔁 Repeats: ${plan.schedule.frequency}` +
        (plan.schedule.day ? ` on ${plan.schedule.day}` : "") +
        (plan.schedule.time ? ` at ${plan.schedule.time}` : "")
      : "\n⚡ One-time payment";
    pendingAction.set(ctx.from.id, { type: "confirm_autopay_pin", plan });
    return ctx.reply(
      `📋 Payment Plan\n──────────────────────────\n${paymentLines}${scheduleText}\n\n${plan.summary}\n\nType your PIN to confirm:`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]]) }
    );
  }

  if (pending.type === "confirm_autopay_pin") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
    pendingAction.delete(ctx.from.id);
    if (!db.verifyPin(ctx.from.id, text)) return ctx.reply("Incorrect PIN. Try again.");
    const user = db.getUser(ctx.from.id);
    const { plan } = pending;
    if (plan.schedule?.frequency) {
      const jobId = saveSchedule(ctx.from.id.toString(), plan);
      startJob(jobId, ctx.from.id.toString(), plan, text, async (userId, jId, results) => {
        const msg = formatResults(results);
        await ctx.telegram.sendMessage(parseInt(userId), `🔔 Scheduled payment ran:\n\n${msg}`, { parse_mode: "Markdown" });
      });
      return ctx.reply(
        `✅ Scheduled!\n──────────────────────────\n${plan.summary}\n\nRuns ${plan.schedule.frequency}` +
        (plan.schedule.day ? ` on ${plan.schedule.day}` : "") +
        `.\n\nUse /schedules to view or cancel.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("📅 View Schedules", "action_schedules")],
          [Markup.button.callback("🏠 Main Menu", "action_main_menu")],
        ])
      );
    } else {
      await ctx.reply("⏳ Executing payment...");
      const results = await executePlan(plan, text, user);
      const msg = formatResults(results);
      return ctx.reply(msg, { parse_mode: "Markdown", ...afterSuccessButtons });
    }
  }
});

// ─── Business invoice confirm action ─────────────────────────────────────────

bot.action("action_confirm_biz_invoice", async (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  const pending = pendingAction.get(ctx.from.id);
  if (!pending || pending.type !== "confirm_biz_invoice") {
    return ctx.reply("Session expired. Start again with 🧾 New Invoice.");
  }
  pendingAction.delete(ctx.from.id);
  const { parsed, total, walletAddress } = pending;
  await ctx.reply("⏳ Generating invoice image...");
  try {
    const invoiceNumber = bizDb.getNextBizInvoiceNumber(ctx.from.id);
    const issueDate = new Date().toISOString().split("T")[0];
    const pngPath = await generateInvoicePNG({
      invoiceNumber, clientName: parsed.clientName, clientEmail: parsed.clientEmail,
      items: parsed.items, dueDate: parsed.dueDate, notes: parsed.notes,
      businessName: user.username || `User ${ctx.from.id}`,
      walletAddress, issueDate,
    });
    const invoiceId = bizDb.createBizInvoice(ctx.from.id, {
      invoiceNumber, clientName: parsed.clientName, clientEmail: parsed.clientEmail || null,
      items: parsed.items, totalUsdc: total, dueDate: parsed.dueDate || null,
      notes: parsed.notes || null, walletAddress, pngPath,
    });

    // Auto-savings split if goal set
    const goal = bizDb.getSavingsGoal(ctx.from.id);
    const goalNote = goal ? `\n💰 ${goal.percentage}% (${(total * goal.percentage / 100).toFixed(2)} USDC) will move to Biz Savings on payment.` : "";

    await ctx.replyWithPhoto({ source: pngPath }, {
      caption: `🧾 Invoice #${invoiceNumber}\nClient: ${parsed.clientName}\nAmount: ${total.toFixed(2)} USDC\n` +
        (parsed.dueDate ? `Due: ${parsed.dueDate}\n` : "") +
        `\nPayment address:\n\`${walletAddress}\`` + goalNote,
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📋 All Invoices", "action_list_biz_invoices")],
        [Markup.button.callback("✅ Mark as Paid", `action_bizpaid_${invoiceId}`)],
        [Markup.button.callback("🏠 Main Menu", "action_main_menu")],
      ]),
    });
  } catch (err) {
    console.error("[biz_invoice]", err);
    await ctx.reply("Something went wrong generating the invoice. Please try again.");
  }
});

bot.action(/^action_bizpaid_(\d+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const invoiceId = parseInt(ctx.match[1]);
  const inv = bizDb.getBizInvoice(invoiceId);
  if (!inv || parseInt(inv.telegram_id) !== ctx.from.id) return ctx.reply("Invoice not found.");
  if (inv.status === "paid") return ctx.reply("Already marked as paid ✅");
  bizDb.markBizInvoicePaid(invoiceId);
  // Apply auto-savings split
  const goal = bizDb.getSavingsGoal(ctx.from.id);
  if (goal) {
    const savingsAmount = parseFloat(inv.total_usdc) * goal.percentage / 100;
    bizDb.addToBizSavings(ctx.from.id, savingsAmount);
  }
  await ctx.reply(
    `✅ Invoice #${inv.invoice_number} paid!\n${inv.client_name} · ${inv.total_usdc} USDC` +
    (goal ? `\n💰 ${goal.percentage}% moved to Biz Savings.` : ""),
    Markup.inlineKeyboard([[Markup.button.callback("📋 All Invoices", "action_list_biz_invoices")]])
  );
});

// ─── Launch ───────────────────────────────────────────────────────────────────

bot.launch().then(() => {
  console.log("PayIT bot is running (Arc testnet, non-custodial) — Personal + Business accounts, USDC + EURC, Gateway enabled...");
  reloadAll(() => {});
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));