// bot.js
// PayIT - non-custodial Telegram USDC wallet bot on Arc (testnet)
// Run with: node bot.js   (after npm install and setting up .env)

require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const db = require("./src/db");
const walletLib = require("./src/wallet");
const offramp = require("./src/offramp");
const fx = require("./src/fx");
const otp = require("./src/otp");
const swap = require("./src/swap");
const savings = require("./src/savings");

if (!process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN.includes("PASTE_YOUR")) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN is not set in .env");
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const pendingAction = new Map();

// ─── Persistent bottom keyboard ───────────────────────────────────────────────
const mainMenu = Markup.keyboard([
  ["💰 Balance", "📤 Send", "🔄 Swap"],
  ["📥 Receive", "📈 Yields", "📋 History"],
  ["⚙️ Settings", "📖 How to Use", "✨ Features"],
]).resize();

// ─── Inline keyboards (buttons that appear inside the chat) ───────────────────

const balanceButtons = Markup.inlineKeyboard([
  [Markup.button.callback("📥 Receive USDC", "action_receive"),
   Markup.button.callback("📤 Send USDC", "action_send_menu")],
  [Markup.button.callback("💸 Cash Out to Naira", "action_withdraw_menu"),
   Markup.button.callback("📈 Earn Yield", "action_yields")],
  [Markup.button.callback("📋 Transaction History", "action_history")],
]);

const sendButtons = Markup.inlineKeyboard([
  [Markup.button.callback("🏦 Cash Out to Naira (Paj Cash)", "action_withdraw_menu")],
  [Markup.button.callback("👛 Send to External Wallet", "action_sendout_menu")],
  [Markup.button.callback("« Back to Menu", "action_main_menu")],
]);

const yieldButtons = Markup.inlineKeyboard([
  [Markup.button.callback("➕ Deposit into Yield Pool", "action_yield_deposit_start")],
  [Markup.button.callback("📊 My Current Position", "action_my_yield")],
  [Markup.button.callback("💵 Withdraw Yield", "action_yield_withdraw_start")],
  [Markup.button.callback("« Back to Menu", "action_main_menu")],
]);

const settingsButtons = Markup.inlineKeyboard([
  [Markup.button.callback("🔑 Export Private Key", "action_export")],
  [Markup.button.callback("🔒 Change PIN", "action_changepin")],
  [Markup.button.callback("👛 Link External Wallet", "action_setwallet_prompt")],
  [Markup.button.callback("📱 Verify Phone Number", "action_verifyphone_prompt")],
  [Markup.button.callback("« Back to Menu", "action_main_menu")],
]);

const receiveButtons = Markup.inlineKeyboard([
  [Markup.button.callback("💰 Check Balance", "action_balance")],
  [Markup.button.callback("« Back to Menu", "action_main_menu")],
]);

const historyButtons = Markup.inlineKeyboard([
  [Markup.button.callback("💰 Check Balance", "action_balance")],
  [Markup.button.callback("« Back to Menu", "action_main_menu")],
]);

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(microAmount) {
  return `${walletLib.formatMicro(microAmount)} USDC`;
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

// ─── Onboarding ───────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const existing = db.getUser(ctx.from.id);
  if (existing) {
    return ctx.reply(
      `👋 Welcome back, ${ctx.from.first_name || "there"}!\n\nYour wallet:\n${existing.deposit_address}`,
      mainMenu
    );
  }

  const wallet = walletLib.generateUserWallet();
  pendingAction.set(ctx.from.id, {
    type: "onboarding_set_pin",
    address: wallet.address,
    privateKey: wallet.privateKey,
    username: ctx.from.username,
  });

  await ctx.reply(
    `👋 Welcome to PayIT.\n\n` +
    `PayIT is non-custodial — you hold your own wallet and we never have access to your funds without you.\n\n` +
    `First, set a 4-digit PIN. This encrypts your private key and is required to confirm any withdrawal, send, or swap.\n\n` +
    `⚠️ If you forget your PIN and haven't backed up your private key, your funds become permanently unrecoverable. ` +
    `This is by design — it's what non-custodial actually means.\n\n` +
    `Type a 4-digit PIN now to continue.`
  );
});

bot.command("menu", (ctx) => ctx.reply("Choose an option:", mainMenu));

// ─── Core action functions ─────────────────────────────────────────────────────

async function showBalance(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  try {
    const balanceMicro = await walletLib.getNativeBalanceMicro(user.deposit_address);
    const usdcAmount = parseFloat(walletLib.formatMicro(balanceMicro));
    const rate = await fx.getUsdToNgnRate();
    const nairaLine = rate
      ? `≈ ${fx.formatNaira(usdcAmount * rate)} at today's rate (~₦${Math.round(rate)}/USD)\n` +
        `(Estimate only — actual payout set by Paj Cash at off-ramp time.)`
      : "(Naira estimate unavailable right now)";

    await ctx.reply(
      `💰 Your Balance\n──────────────────────────\n` +
      `${usdcAmount.toFixed(4)} USDC\n${nairaLine}\n\n` +
      `Wallet: ${user.deposit_address}`,
      balanceButtons
    );
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't check your balance right now — please try again shortly.");
  }
}

async function showReceive(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  await ctx.reply(
    `📥 Receive USDC\n──────────────────────────\n` +
    `Your wallet address (Arc Testnet):\n\n` +
    `${user.deposit_address}\n\n` +
    `Get free testnet USDC at https://faucet.circle.com (select "Arc Testnet") and send it here — no sweeping, no delay.`,
    receiveButtons
  );
}

async function showHistory(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  const txs = db.getTransactions(ctx.from.id, 10);
  if (txs.length === 0) {
    return ctx.reply(
      `📋 Transaction History\n──────────────────────────\n` +
      `No PayIT-initiated transactions yet.\n\n` +
      `Full on-chain history (including deposits):\n` +
      `https://testnet.arcscan.app/address/${user.deposit_address}`,
      historyButtons
    );
  }
  const lines = txs.map(
    (t) => `• ${t.type}  ${walletLib.formatMicro(t.amount_micro)} USDC  [${t.status}]\n  ${t.created_at}`
  );
  await ctx.reply(
    `📋 Last ${txs.length} Transactions\n──────────────────────────\n` + lines.join("\n\n"),
    historyButtons
  );
}

async function showSettings(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  const phoneStatus = user.phone_number
    ? `${user.phone_number} (${user.phone_verified ? "✅ verified" : "⏳ not verified"})`
    : "not set";
  await ctx.reply(
    `⚙️ Settings\n──────────────────────────\n` +
    `Wallet: ${user.deposit_address}\n` +
    `Linked wallet: ${user.external_wallet_address || "none"}\n` +
    `Phone: ${phoneStatus}\n\n` +
    `PayIT is non-custodial — we never hold a usable copy of your private key without your PIN.`,
    settingsButtons
  );
}

function showHelp(ctx) {
  return ctx.reply(
    `📖 How to Use PayIT\n──────────────────────────\n` +
    `💰 Balance — live on-chain balance + Naira estimate\n` +
    `📥 Receive — your wallet address\n` +
    `📤 Send — send to Naira or external wallet\n` +
    `📈 Yields — earn yield via Azuro Protocol\n` +
    `📋 History — your transaction log\n` +
    `⚙️ Settings — PIN, wallet, phone\n\n` +
    `Everything is button-driven — tap any option to get started.`,
    mainMenu
  );
}

function showFeatures(ctx) {
  return ctx.reply(
    `✨ What's live right now (Arc testnet):\n` +
    `✅ Non-custodial wallet (independently generated)\n` +
    `✅ PIN-encrypted private key + safe export\n` +
    `✅ Live on-chain balance with Naira estimate\n` +
    `✅ Naira off-ramp via Paj Cash (needs credentials)\n` +
    `✅ Send to linked external wallet\n` +
    `✅ SMS OTP via Termii (needs API key)\n` +
    `✅ Yield deposits via Azuro Protocol (Polygon)\n` +
    `   └ PayIT keeps 10% of APY; you earn 90%\n\n` +
    `🚧 Coming soon:\n` +
    `— Card spending\n` +
    `— Real swap execution\n` +
    `— Cross-chain bridge (Arc → Polygon)\n` +
    `— Bills & Bulk Send`,
    mainMenu
  );
}

async function showYields(ctx) {
  await ctx.reply("Fetching live Azuro yield pools...");
  try {
    const pools = await savings.getAzuroPools();
    await ctx.reply(savings.formatYieldList(pools), yieldButtons);
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
  await ctx.reply(savings.formatPosition(position), Markup.inlineKeyboard([
    [Markup.button.callback("💵 Withdraw Position", "action_yield_withdraw_start")],
    [Markup.button.callback("📈 View Pools", "action_yields")],
    [Markup.button.callback("« Back to Menu", "action_main_menu")],
  ]));
}

// ─── Inline button actions ─────────────────────────────────────────────────────

bot.action("action_main_menu", (ctx) => {
  ctx.answerCbQuery();
  return ctx.reply("Choose an option:", mainMenu);
});

bot.action("action_balance", (ctx) => {
  ctx.answerCbQuery();
  return showBalance(ctx);
});

bot.action("action_receive", (ctx) => {
  ctx.answerCbQuery();
  return showReceive(ctx);
});

bot.action("action_history", (ctx) => {
  ctx.answerCbQuery();
  return showHistory(ctx);
});

bot.action("action_yields", (ctx) => {
  ctx.answerCbQuery();
  return showYields(ctx);
});

bot.action("action_my_yield", (ctx) => {
  ctx.answerCbQuery();
  return showMyYield(ctx);
});

// Send sub-menu
bot.action("action_send_menu", (ctx) => {
  ctx.answerCbQuery();
  return ctx.reply(
    `📤 Send USDC\n──────────────────────────\nWhere would you like to send?`,
    sendButtons
  );
});

// Withdraw to Naira — prompt for amount
bot.action("action_withdraw_menu", (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  pendingAction.set(ctx.from.id, { type: "await_withdraw_amount" });
  return ctx.reply(
    `💸 Cash Out to Naira\n──────────────────────────\n` +
    `How much USDC would you like to cash out?\n\nType the amount (e.g. 10):`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
  );
});

// Sendout — prompt for amount
bot.action("action_sendout_menu", (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  if (!user.external_wallet_address) {
    return ctx.reply(
      `👛 No Linked Wallet\n──────────────────────────\n` +
      `You haven't linked an external wallet yet. Tap below to add one.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔗 Link a Wallet", "action_setwallet_prompt")],
        [Markup.button.callback("❌ Cancel", "action_main_menu")],
      ])
    );
  }
  pendingAction.set(ctx.from.id, { type: "await_sendout_amount" });
  return ctx.reply(
    `👛 Send to External Wallet\n──────────────────────────\n` +
    `Sending to: ${user.external_wallet_address}\n\nHow much USDC? Type the amount:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
  );
});

// Yield deposit — prompt for amount
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
    `Available balance: ${balanceUsdc.toFixed(4)} USDC\nMinimum deposit: 1 USDC\n\n` +
    `How much would you like to deposit? Type the amount:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_yields")]])
  );
});

// Yield withdraw — show summary then ask for PIN
bot.action("action_yield_withdraw_start", (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;

  const position = db.getOpenYieldPosition(ctx.from.id);
  if (!position) {
    return ctx.reply(
      "No active yield position to withdraw.",
      Markup.inlineKeyboard([[Markup.button.callback("➕ Open One", "action_yield_deposit_start")]])
    );
  }

  const accrued = savings.calcAccruedYield(position);
  const total = parseFloat((position.amount_usdc + accrued).toFixed(4));

  pendingAction.set(ctx.from.id, {
    type: "confirm_yield_withdraw",
    position,
    accrued,
    total,
  });

  return ctx.reply(
    `💵 Withdraw Yield Position\n──────────────────────────\n` +
    `Principal: $${position.amount_usdc.toFixed(2)} USDC\n` +
    `Accrued yield: +$${accrued.toFixed(4)} USDC\n` +
    `Total payout: $${total.toFixed(4)} USDC\n\n` +
    `⚠️ Testnet demo — payout credited to your wallet record.\n\n` +
    `Type your 4-digit PIN to confirm:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_yields")]])
  );
});

// Settings actions
bot.action("action_export", (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
  pendingAction.set(ctx.from.id, { type: "confirm_export" });
  return ctx.reply(
    `🔑 Export Private Key\n──────────────────────────\n` +
    `This will show your raw private key. Anyone with it controls your wallet.\n\n` +
    `Type your 4-digit PIN to proceed:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_settings")]])
  );
});

bot.action("action_settings", (ctx) => {
  ctx.answerCbQuery();
  return showSettings(ctx);
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
  const user = requireUser(ctx);
  if (!user) return;
  pendingAction.set(ctx.from.id, { type: "await_setwallet" });
  return ctx.reply(
    `🔗 Link External Wallet\n──────────────────────────\nType your Arc wallet address:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_settings")]])
  );
});

bot.action("action_verifyphone_prompt", (ctx) => {
  ctx.answerCbQuery();
  const user = requireUser(ctx);
  if (!user) return;
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
    `🔄 Swap\n──────────────────────────\n` +
    `Swap isn't wired to a verified router address yet.\n` +
    `Once a confirmed Arc testnet DEX address is available, this will be live.`,
    Markup.inlineKeyboard([[Markup.button.callback("« Back to Menu", "action_main_menu")]])
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
    return ctx.reply(
      "Off-ramp isn't configured yet (PAJCASH_OFFRAMP_ADDRESS missing in .env).",
      Markup.inlineKeyboard([[Markup.button.callback("« Back to Menu", "action_main_menu")]])
    );
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
      accountNumber: "0000000000",
      bankCode: "000",
      accountName: ctx.from.first_name || "PayIT User",
    });
    db.updateTransactionStatus(txId, "submitted");
    await ctx.reply(
      `✅ Cash Out Submitted\n──────────────────────────\n` +
      `Sent ${amountUsdcStr} USDC on-chain\nTx: ${txHash}\nRef: ${result.reference || result.id}\n\n` +
      `(Placeholder — needs real Paj Cash credentials.)`,
      afterSuccessButtons
    );
  } catch (err) {
    db.updateTransactionStatus(txId, "onchain_sent_notify_failed");
    await ctx.reply(
      `⚠️ USDC sent on-chain (tx: ${txHash}), but Paj Cash notification failed: ${err.message}\n` +
      `Contact support with this tx hash if Naira doesn't arrive.`,
      afterSuccessButtons
    );
  }
}

async function executeSendout(ctx, user, amountMicro, pin) {
  if (!user.external_wallet_address) {
    return ctx.reply(
      "Link a wallet first.",
      Markup.inlineKeyboard([[Markup.button.callback("🔗 Link Wallet", "action_setwallet_prompt")]])
    );
  }
  let userWallet;
  try {
    const pk = db.decryptPrivateKey(pin, user);
    userWallet = walletLib.walletFromPrivateKey(pk);
  } catch {
    return ctx.reply("Couldn't unlock your wallet with that PIN.");
  }

  const txId = db.recordTransaction(user.telegram_id, "sendout", amountMicro, "pending", null);
  try {
    const txHash = await walletLib.sendFromWallet(userWallet, user.external_wallet_address, amountMicro);
    db.updateTransactionStatus(txId, "confirmed");
    await ctx.reply(
      `✅ Sent!\n──────────────────────────\n` +
      `${walletLib.formatMicro(amountMicro)} USDC → ${user.external_wallet_address}\nTx: ${txHash}`,
      afterSuccessButtons
    );
  } catch (err) {
    db.updateTransactionStatus(txId, "failed");
    await ctx.reply("Transfer failed: " + err.message);
  }
}

// ─── Bottom keyboard button handlers ──────────────────────────────────────────

bot.hears("💰 Balance", showBalance);
bot.hears("📥 Receive", showReceive);
bot.hears("📋 History", showHistory);
bot.hears("⚙️ Settings", showSettings);
bot.hears("📖 How to Use", showHelp);
bot.hears("✨ Features", showFeatures);
bot.hears("📈 Yields", showYields);

bot.hears("📤 Send", (ctx) =>
  ctx.reply(
    `📤 Send USDC\n──────────────────────────\nWhere would you like to send?`,
    sendButtons
  )
);

bot.hears("🔄 Swap", (ctx) =>
  ctx.reply(
    `🔄 Swap\n──────────────────────────\n` +
    `Swap isn't wired to a verified router address yet.`,
    Markup.inlineKeyboard([[Markup.button.callback("« Back to Menu", "action_main_menu")]])
  )
);

// ─── Slash commands (kept as shortcuts) ───────────────────────────────────────

bot.command("help", showHelp);
bot.command("balance", showBalance);
bot.command("history", showHistory);
bot.command("settings", showSettings);
bot.command("yields", showYields);
bot.command("deposit", showReceive);

// ─── Text catch-all: multi-step flows ─────────────────────────────────────────

bot.on("text", async (ctx) => {
  const pending = pendingAction.get(ctx.from.id);
  if (!pending) return;

  const text = ctx.message.text.trim();

  // ── Onboarding PIN ──
  if (pending.type === "onboarding_set_pin") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("PIN must be exactly 4 digits. Try again.");
    const user = db.createUserWithWallet(ctx.from.id, pending.username, pending.address, pending.privateKey, text);
    pendingAction.delete(ctx.from.id);
    const exportMsg = await ctx.reply(
      `✅ PIN set. Your wallet is ready!\n\n${user.deposit_address}\n\n` +
      `Here is your private key — save it NOW in a password manager:\n\n${pending.privateKey}\n\n` +
      `⚠️ Anyone with this key controls your wallet. This message auto-deletes in 60 seconds.`
    );
    scheduleDelete(ctx, exportMsg.message_id, 60000);
    return ctx.reply("What would you like to do?", mainMenu);
  }

  // ── Export key PIN confirm ──
  if (pending.type === "confirm_export") {
    pendingAction.delete(ctx.from.id);
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
    if (!db.verifyPin(ctx.from.id, text)) return ctx.reply("Incorrect PIN.");
    try {
      const user = db.getUser(ctx.from.id);
      const pk = db.decryptPrivateKey(text, user);
      const msg = await ctx.reply(
        `🔑 Your Private Key\n──────────────────────────\n${pk}\n\n` +
        `Save it now — this message auto-deletes in 60 seconds.`
      );
      scheduleDelete(ctx, msg.message_id, 60000);
    } catch {
      await ctx.reply("Couldn't decrypt your key.");
    }
    return;
  }

  // ── Change PIN (old) ──
  if (pending.type === "changepin_old") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your current 4-digit PIN.");
    if (!db.verifyPin(ctx.from.id, text)) {
      pendingAction.delete(ctx.from.id);
      return ctx.reply(
        "Incorrect PIN.",
        Markup.inlineKeyboard([[Markup.button.callback("Try Again", "action_changepin")]])
      );
    }
    const user = db.getUser(ctx.from.id);
    let pk;
    try { pk = db.decryptPrivateKey(text, user); } catch {
      pendingAction.delete(ctx.from.id);
      return ctx.reply("Couldn't unlock your wallet.");
    }
    pendingAction.set(ctx.from.id, { type: "changepin_new", privateKey: pk });
    return ctx.reply("Now type your NEW 4-digit PIN:");
  }

  // ── Change PIN (new) ──
  if (pending.type === "changepin_new") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("PIN must be exactly 4 digits. Try again.");
    db.updatePin(ctx.from.id, text, pending.privateKey);
    pendingAction.delete(ctx.from.id);
    return ctx.reply(
      "✅ PIN changed successfully.",
      Markup.inlineKeyboard([[Markup.button.callback("« Back to Settings", "action_settings")]])
    );
  }

  // ── Link external wallet ──
  if (pending.type === "await_setwallet") {
    pendingAction.delete(ctx.from.id);
    if (!walletLib.isValidAddress(text)) {
      return ctx.reply(
        "That doesn't look like a valid address. Try again.",
        Markup.inlineKeyboard([[Markup.button.callback("« Cancel", "action_settings")]])
      );
    }
    db.setExternalWallet(ctx.from.id, text);
    return ctx.reply(
      `✅ Wallet linked!\n${text}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📤 Send to this Wallet", "action_sendout_menu")],
        [Markup.button.callback("« Back to Settings", "action_settings")],
      ])
    );
  }

  // ── Verify phone ──
  if (pending.type === "await_phone") {
    pendingAction.delete(ctx.from.id);
    const phone = text.replace(/\D/g, "");
    try {
      const result = await otp.sendOtp(phone);
      db.setPhoneNumber(ctx.from.id, phone);
      pendingAction.set(ctx.from.id, { type: "confirm_otp", pinId: result.pinId });
      return ctx.reply(
        `📱 Code sent to ${phone}.\n\nType the 4-digit code to verify:`,
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_settings")]])
      );
    } catch (err) {
      return ctx.reply("Couldn't send the code (check TERMII_API_KEY in .env): " + err.message);
    }
  }

  // ── OTP confirm ──
  if (pending.type === "confirm_otp") {
    pendingAction.delete(ctx.from.id);
    if (!/^\d{4,6}$/.test(text)) return ctx.reply("Enter the code you received.");
    try {
      const verified = await otp.verifyOtp(pending.pinId, text);
      if (verified) {
        db.setPhoneVerified(ctx.from.id, true);
        return ctx.reply(
          "✅ Phone verified!",
          Markup.inlineKeyboard([[Markup.button.callback("« Back to Settings", "action_settings")]])
        );
      }
      return ctx.reply(
        "That code didn't match.",
        Markup.inlineKeyboard([[Markup.button.callback("« Back to Settings", "action_settings")]])
      );
    } catch (err) {
      return ctx.reply("Couldn't verify the code: " + err.message);
    }
  }

  // ── Withdraw amount entry ──
  if (pending.type === "await_withdraw_amount") {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply(
        "Please enter a valid amount (e.g. 10):",
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
      );
    }
    let amountMicro;
    try { amountMicro = walletLib.parseToMicro(text); } catch {
      return ctx.reply("Invalid amount. Try again.");
    }
    const user = requireUser(ctx);
    if (!user) return;
    const balance = await walletLib.getNativeBalanceMicro(user.deposit_address);
    if (balance < amountMicro) {
      return ctx.reply(
        `Insufficient balance. You have ${fmt(balance)}.`,
        Markup.inlineKeyboard([[Markup.button.callback("« Back", "action_main_menu")]])
      );
    }
    pendingAction.set(ctx.from.id, {
      type: "confirm_withdraw",
      amountMicro: amountMicro.toString(),
      amountUsdc: text,
    });
    return ctx.reply(
      `💸 Confirm Cash Out\n──────────────────────────\n` +
      `Amount: ${text} USDC → Naira via Paj Cash\n\nType your 4-digit PIN to confirm:`,
      Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
    );
  }

  // ── Withdraw PIN confirm ──
  if (pending.type === "confirm_withdraw") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
    pendingAction.delete(ctx.from.id);
    if (!db.verifyPin(ctx.from.id, text)) return ctx.reply("Incorrect PIN. Try again.");
    const user = db.getUser(ctx.from.id);
    return executeWithdraw(ctx, user, BigInt(pending.amountMicro), pending.amountUsdc, text);
  }

  // ── Sendout amount entry ──
  if (pending.type === "await_sendout_amount") {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply(
        "Please enter a valid amount (e.g. 10):",
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
      );
    }
    let amountMicro;
    try { amountMicro = walletLib.parseToMicro(text); } catch {
      return ctx.reply("Invalid amount. Try again.");
    }
    const user = requireUser(ctx);
    if (!user) return;
    const balance = await walletLib.getNativeBalanceMicro(user.deposit_address);
    if (balance < amountMicro) {
      return ctx.reply(
        `Insufficient balance. You have ${fmt(balance)}.`,
        Markup.inlineKeyboard([[Markup.button.callback("« Back", "action_main_menu")]])
      );
    }
    pendingAction.set(ctx.from.id, {
      type: "confirm_sendout",
      amountMicro: amountMicro.toString(),
    });
    return ctx.reply(
      `👛 Confirm Send\n──────────────────────────\n` +
      `Amount: ${text} USDC\nTo: ${user.external_wallet_address}\n\nType your 4-digit PIN to confirm:`,
      Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_main_menu")]])
    );
  }

  // ── Sendout PIN confirm ──
  if (pending.type === "confirm_sendout") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
    pendingAction.delete(ctx.from.id);
    if (!db.verifyPin(ctx.from.id, text)) return ctx.reply("Incorrect PIN. Try again.");
    const user = db.getUser(ctx.from.id);
    return executeSendout(ctx, user, BigInt(pending.amountMicro), text);
  }

  // ── Yield deposit amount entry ──
  if (pending.type === "await_yield_amount") {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount < 1) {
      return ctx.reply(
        "Please enter a valid amount (minimum 1 USDC):",
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_yields")]])
      );
    }
    if (amount > pending.balanceUsdc) {
      return ctx.reply(
        `Insufficient balance. You have ${pending.balanceUsdc.toFixed(4)} USDC.`,
        Markup.inlineKeyboard([[Markup.button.callback("« Back", "action_yields")]])
      );
    }
    let pools;
    try { pools = await savings.getAzuroPools(); } catch {
      return ctx.reply("Couldn't load pool data right now — try again.");
    }
    const bestPool = pools[0];
    pendingAction.set(ctx.from.id, {
      type: "confirm_yield_deposit",
      amountUsdc: amount,
      pool: bestPool,
    });
    return ctx.reply(
      `📈 Confirm Yield Deposit\n──────────────────────────\n` +
      `Amount: $${amount.toFixed(2)} USDC\n` +
      `Pool: ${bestPool.symbol} · Azuro · ${bestPool.chain}\n` +
      `Your APY: ${bestPool.userApy}%  (raw: ${bestPool.rawApy.toFixed(1)}%)\n` +
      `PayIT fee: ${bestPool.payitApy}% APY\n\n` +
      `⚠️ Testnet demo — no real bridge fires.\n\nType your 4-digit PIN to confirm:`,
      Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_yields")]])
    );
  }

  // ── Yield deposit PIN confirm ──
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
        `Pool: ${pending.pool.symbol} · Azuro · ${pending.pool.chain}`,
        afterYieldOpenButtons
      );
    } catch (err) {
      await ctx.reply("Something went wrong: " + err.message);
    }
    return;
  }

  // ── Yield withdraw PIN confirm ──
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
        `📌 Testnet demo — funds returned to your wallet record.`,
        afterSuccessButtons
      );
    } catch (err) {
      await ctx.reply("Something went wrong: " + err.message);
    }
    return;
  }
});

bot.launch().then(() => console.log("PayIT bot is running (Arc testnet, non-custodial)..."));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
