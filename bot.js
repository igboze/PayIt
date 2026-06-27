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

// In-memory "what is this user in the middle of doing" state.
// Fine for a single-process testnet bot; a real deployment running multiple
// instances would need this in a shared store (e.g. Redis) instead.
// NOTE: during onboarding this briefly holds a freshly generated, not-yet-
// encrypted private key in memory - never logged, cleared the moment the
// PIN is set and the encrypted version is written to disk.
const pendingAction = new Map();

const mainMenu = Markup.keyboard([
  ["\u{1F4B0} Balance", "\u{1F4E4} Send", "\u{1F501} Swap"],
  ["\u{1F4E5} Receive", "\u{1F4B0} Yields", "\u{1F4CB} History"],
  ["\u2699\uFE0F Settings", "\u{1F4D6} How to Use", "\u2728 Features"],
]).resize();

function fmt(microAmount) {
  return `${walletLib.formatMicro(microAmount)} USDC`;
}

function requireUser(ctx) {
  const user = db.getUser(ctx.from.id);
  if (!user) {
    ctx.reply("Send /start first to set up your wallet.");
    return null;
  }
  return user;
}

// Deletes a message after a delay - used for anything that briefly displays
// a private key. Best-effort: Telegram message deletion can fail (e.g. if
// the user already deleted it, or after 48h), so errors are swallowed.
function scheduleDelete(ctx, messageId, ms) {
  setTimeout(() => {
    ctx.telegram.deleteMessage(ctx.chat.id, messageId).catch(() => {});
  }, ms);
}

// ---------- Onboarding ----------

bot.start(async (ctx) => {
  const existing = db.getUser(ctx.from.id);
  if (existing) {
    return ctx.reply(`Welcome back. Your wallet:\n${existing.deposit_address}`, mainMenu);
  }

  const wallet = walletLib.generateUserWallet();
  pendingAction.set(ctx.from.id, {
    type: "onboarding_set_pin",
    address: wallet.address,
    privateKey: wallet.privateKey,
    username: ctx.from.username,
  });

  await ctx.reply(
    `Welcome to PayIT.\n\n` +
      `PayIT is non-custodial: you hold your own wallet, and we never have access to your funds without you.\n\n` +
      `First, set a 4-digit PIN. This encrypts your private key on our server and is required to confirm any ` +
      `withdrawal, send, or swap.\n\n` +
      `IMPORTANT: if you forget this PIN and haven't separately backed up your private key, your funds become ` +
      `permanently unrecoverable - there is no "forgot password" option for a non-custodial wallet. This is by ` +
      `design, not a bug.\n\n` +
      `Send me a 4-digit PIN now to continue.`
  );
});

bot.command("menu", (ctx) => ctx.reply("Menu:", mainMenu));

// ---------- Core actions ----------

async function showBalance(ctx) {
  const user = requireUser(ctx);
  if (!user) return;

  try {
    const balanceMicro = await walletLib.getNativeBalanceMicro(user.deposit_address);
    const usdcAmount = parseFloat(walletLib.formatMicro(balanceMicro));

    const rate = await fx.getUsdToNgnRate();
    const nairaLine = rate
      ? `\u2248 ${fx.formatNaira(usdcAmount * rate)} at today's rate (~\u20A6${Math.round(rate)}/USD)\n` +
        `Note: estimate only - actual Naira pay-out is set by Paj Cash at the time you off-ramp.`
      : "(Naira estimate unavailable right now)";

    await ctx.reply(
      `Wallet: ${user.deposit_address}\nBalance: ${usdcAmount.toFixed(4)} USDC\n${nairaLine}`
    );
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't check your balance right now - please try again shortly.");
  }
}

async function showDeposit(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  await ctx.reply(
    `Your wallet address (Arc Testnet):\n${user.deposit_address}\n\n` +
      `This is genuinely your own wallet. Get free testnet USDC from https://faucet.circle.com ` +
      `(select "Arc Testnet") and send it here - no sweeping, no delay, it's yours on arrival.`
  );
}

async function showHistory(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  const txs = db.getTransactions(ctx.from.id, 10);
  if (txs.length === 0) {
    return ctx.reply(
      "No PayIT-initiated transactions yet.\n\n" +
        `For full on-chain history (including deposits), check your address on ` +
        `https://testnet.arcscan.app/address/${user.deposit_address}`
    );
  }
  const lines = txs.map(
    (t) => `#${t.id} ${t.type} ${walletLib.formatMicro(t.amount_micro)} USDC [${t.status}] ${t.created_at}`
  );
  await ctx.reply(lines.join("\n"));
}

async function showSettings(ctx) {
  const user = requireUser(ctx);
  if (!user) return;
  await ctx.reply(
    `\u2699\uFE0F Settings\n\n` +
      `Wallet: ${user.deposit_address}\n` +
      `Linked external wallet: ${user.external_wallet_address || "none"}\n` +
      `Phone: ${user.phone_number ? `${user.phone_number} (${user.phone_verified ? "verified" : "not verified"})` : "not set"}\n\n` +
      `/export - show your private key (PIN required, auto-deletes after 60s)\n` +
      `/changepin - change your PIN\n` +
      `/setwallet <address> - link an external wallet\n` +
      `/verifyphone <phone> - start SMS verification (Termii)\n\n` +
      `PayIT is non-custodial: this wallet is genuinely yours. We never hold a usable copy of your ` +
      `private key without your PIN.`
  );
}

function showHelp(ctx) {
  return ctx.reply(
    "PayIT (non-custodial, Arc testnet)\n\n" +
      "\u{1F4B0} Balance - your live on-chain balance + Naira estimate\n" +
      "\u{1F4E5} Receive - your wallet address\n" +
      "\u{1F4CB} History - PayIT-initiated transactions\n" +
      "\u2699\uFE0F Settings - PIN, linked wallet, phone\n" +
      "/withdraw <amount> - cash out to Naira via Paj Cash (placeholder integration)\n" +
      "/sendout <amount> - send USDC to your linked external wallet\n" +
      "\u{1F501} Swap - not wired to a verified router address yet\n" +
      "\u{1F4B0} Yields - earn yield via Azuro Protocol (Polygon)\n" +
      "/deposit_yield <amount> - deposit USDC into Azuro yield pool\n" +
      "/my_yield - check your current yield position\n" +
      "/withdraw_yield - close your yield position and collect earnings\n\n" +
      "Bills and Bulk Send aren't built yet."
  );
}

function showFeatures(ctx) {
  return ctx.reply(
    "\u2728 What's actually live right now (Arc testnet):\n" +
      "- Your own independently-generated, non-custodial wallet\n" +
      "- PIN-encrypted private key, with a safe export flow\n" +
      "- Live on-chain balance check with Naira estimate\n" +
      "- Naira off-ramp request (placeholder - needs real Paj Cash credentials)\n" +
      "- Send to a linked external wallet\n" +
      "- SMS OTP via Termii (needs your Termii API key configured)\n" +
      "- \u{1F4C8} Yield deposits via Azuro Protocol (Polygon) - live APY, PIN-confirmed\n" +
      "  PayIT takes 10% of APY as a service fee; you keep 90%\n\n" +
      "\u{1F6A7} Not built yet:\n" +
      "- Card spending (no card issuer chosen)\n" +
      "- Real swap execution (no verified Arc router address yet)\n" +
      "- Cross-chain bridge for yield (Arc \u2192 Polygon) - yield is simulated on testnet\n" +
      "- Bills, Bulk Send"
  );
}

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
    return ctx.reply("Off-ramp isn't configured yet (PAJCASH_OFFRAMP_ADDRESS missing in .env) - see docs.");
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
      `Sent ${amountUsdcStr} USDC on-chain (tx: ${txHash}) and notified Paj Cash. ` +
        `Reference: ${result.reference || result.id}\n(Placeholder integration - needs real Paj Cash credentials.)`
    );
  } catch (err) {
    db.updateTransactionStatus(txId, "onchain_sent_notify_failed");
    await ctx.reply(
      `Your USDC was sent on-chain successfully (tx: ${txHash}), but notifying Paj Cash failed: ${err.message}\n` +
        `That transfer is real and can't be auto-reversed - contact support with this tx hash if the Naira doesn't arrive.`
    );
  }
}

async function executeSendout(ctx, user, amountMicro, pin) {
  if (!user.external_wallet_address) {
    return ctx.reply("Link a wallet first with /setwallet <address>.");
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
      `Sent ${walletLib.formatMicro(amountMicro)} USDC to ${user.external_wallet_address}\ntx: ${txHash}`
    );
  } catch (err) {
    db.updateTransactionStatus(txId, "failed");
    await ctx.reply("Transfer failed: " + err.message);
  }
}

async function showYields(ctx) {
  await ctx.reply("Fetching live Azuro yield pools...");
  try {
    const pools = await savings.getAzuroPools();
    await ctx.reply(savings.formatYieldList(pools));
  } catch (err) {
    console.error("[yields]", err.message);
    await ctx.reply("Couldn't fetch yield data right now - try again shortly.");
  }
}

// ---------- Commands ----------

bot.command("help", showHelp);
bot.command("deposit", showDeposit);
bot.command("balance", showBalance);
bot.command("history", showHistory);
bot.command("settings", showSettings);
bot.command("yields", showYields);

bot.command("export", (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  pendingAction.set(ctx.from.id, { type: "confirm_export" });
  return ctx.reply("This will show your raw private key. Enter your 4-digit PIN to confirm.");
});

bot.command("changepin", (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  pendingAction.set(ctx.from.id, { type: "changepin_old" });
  return ctx.reply("Enter your CURRENT 4-digit PIN.");
});

bot.command("setwallet", (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const parts = ctx.message.text.split(" ").slice(1);
  if (parts.length === 0) return ctx.reply("Usage: /setwallet <your Arc wallet address>");
  const address = parts[0];
  if (!walletLib.isValidAddress(address)) return ctx.reply("That doesn't look like a valid address.");
  db.setExternalWallet(ctx.from.id, address);
  return ctx.reply(`Linked external wallet: ${address}\nUse /sendout <amount> to send USDC there.`);
});

bot.command("verifyphone", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const parts = ctx.message.text.split(" ").slice(1);
  if (parts.length === 0) {
    return ctx.reply("Usage: /verifyphone <phone number with country code, no +>\nExample: /verifyphone 2348100000000");
  }
  const phone = parts[0];
  try {
    const result = await otp.sendOtp(phone);
    db.setPhoneNumber(ctx.from.id, phone);
    pendingAction.set(ctx.from.id, { type: "confirm_otp", pinId: result.pinId });
    await ctx.reply("Code sent via SMS. Enter the 4-digit code to verify.");
  } catch (err) {
    console.error(err.message);
    await ctx.reply("Couldn't send the verification code (check TERMII_API_KEY in .env): " + err.message);
  }
});

bot.command("withdraw", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const parts = ctx.message.text.split(" ").slice(1);
  if (parts.length === 0) return ctx.reply("Usage: /withdraw <amount in USDC>");

  let amountMicro;
  try {
    amountMicro = walletLib.parseToMicro(parts[0]);
  } catch {
    return ctx.reply("That doesn't look like a valid amount.");
  }

  const balance = await walletLib.getNativeBalanceMicro(user.deposit_address);
  if (balance < amountMicro) return ctx.reply(`Insufficient balance. Your balance: ${fmt(balance)}`);

  pendingAction.set(ctx.from.id, {
    type: "confirm_withdraw",
    amountMicro: amountMicro.toString(),
    amountUsdc: parts[0],
  });
  return ctx.reply("Enter your 4-digit PIN to confirm this withdrawal.");
});

bot.command("sendout", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  if (!user.external_wallet_address) return ctx.reply("Link a wallet first with /setwallet <address>.");

  const parts = ctx.message.text.split(" ").slice(1);
  if (parts.length === 0) return ctx.reply("Usage: /sendout <amount in USDC>");

  let amountMicro;
  try {
    amountMicro = walletLib.parseToMicro(parts[0]);
  } catch {
    return ctx.reply("That doesn't look like a valid amount.");
  }

  const balance = await walletLib.getNativeBalanceMicro(user.deposit_address);
  if (balance < amountMicro) return ctx.reply(`Insufficient balance. Your balance: ${fmt(balance)}`);

  pendingAction.set(ctx.from.id, { type: "confirm_sendout", amountMicro: amountMicro.toString() });
  return ctx.reply("Enter your 4-digit PIN to confirm this transfer.");
});

bot.command("deposit_yield", async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;

  const parts = ctx.message.text.split(" ").slice(1);
  if (parts.length === 0) {
    return ctx.reply(
      "Usage: /deposit_yield <amount in USDC>\n\nExample: /deposit_yield 10\n\n" +
        "Tap \u{1F4B0} Yields first to see current rates."
    );
  }

  const amount = parseFloat(parts[0]);
  if (isNaN(amount) || amount <= 0) {
    return ctx.reply("Please enter a valid amount. Example: /deposit_yield 10");
  }
  if (amount < 1) {
    return ctx.reply("Minimum deposit is 1 USDC.");
  }

  let balanceMicro;
  try {
    balanceMicro = await walletLib.getNativeBalanceMicro(user.deposit_address);
  } catch {
    return ctx.reply("Couldn't check your balance right now - try again shortly.");
  }
  const balanceUsdc = parseFloat(walletLib.formatMicro(balanceMicro));
  if (balanceUsdc < amount) {
    return ctx.reply(
      `Insufficient balance.\nYou have ${balanceUsdc.toFixed(4)} USDC, tried to deposit ${amount} USDC.`
    );
  }

  let pools;
  try {
    pools = await savings.getAzuroPools();
  } catch {
    return ctx.reply("Couldn't load yield pool data right now - try again shortly.");
  }
  const bestPool = pools[0];

  pendingAction.set(ctx.from.id, {
    type: "confirm_yield_deposit",
    amountUsdc: amount,
    pool: bestPool,
  });

  await ctx.reply(
    `\u{1F4C8} Yield Deposit Summary\n` +
      `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n` +
      `Amount: $${amount.toFixed(2)} USDC\n` +
      `Pool: ${bestPool.symbol} \u00B7 Azuro Protocol \u00B7 ${bestPool.chain}\n` +
      `Your APY: ${bestPool.userApy}%\n` +
      `Raw pool APY: ${bestPool.rawApy.toFixed(1)}%\n` +
      `PayIT service fee: ${bestPool.payitApy}% APY\n\n` +
      `\u26A0\uFE0F Testnet demo: position is recorded locally; no real bridge fires.\n\n` +
      `Enter your 4-digit PIN to confirm, or /menu to cancel.`
  );
});

bot.command("my_yield", (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;

  const position = db.getOpenYieldPosition(ctx.from.id);
  if (!position) {
    return ctx.reply(
      "You have no active yield position.\n\nUse /deposit_yield <amount> to start earning."
    );
  }

  return ctx.reply(savings.formatPosition(position));
});

bot.command("withdraw_yield", (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;

  const position = db.getOpenYieldPosition(ctx.from.id);
  if (!position) {
    return ctx.reply(
      "No active yield position to withdraw.\n\nUse /deposit_yield <amount> to open one."
    );
  }

  const accrued = savings.calcAccruedYield(position);
  const total = (position.amount_usdc + accrued).toFixed(4);

  pendingAction.set(ctx.from.id, {
    type: "confirm_yield_withdraw",
    position,
    accrued,
    total: parseFloat(total),
  });

  return ctx.reply(
    `\u{1F4B8} Withdraw Yield Position\n` +
      `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n` +
      `Principal: $${position.amount_usdc.toFixed(2)} USDC\n` +
      `Accrued yield: +$${accrued.toFixed(4)} USDC\n` +
      `Total payout: $${total} USDC\n\n` +
      `\u26A0\uFE0F Testnet demo: payout credited back to your wallet record.\n\n` +
      `Enter your 4-digit PIN to confirm withdrawal.`
  );
});

// ---------- Menu button handlers ----------

bot.hears("\u{1F4B0} Balance", showBalance);
bot.hears("\u{1F4E5} Receive", showDeposit);
bot.hears("\u{1F4CB} History", showHistory);
bot.hears("\u2699\uFE0F Settings", showSettings);
bot.hears("\u{1F4D6} How to Use", showHelp);
bot.hears("\u2728 Features", showFeatures);
bot.hears("\u{1F4B0} Yields", showYields);

bot.hears("\u{1F4E4} Send", (ctx) =>
  ctx.reply("Use /sendout <amount> (to your linked wallet) or /withdraw <amount> (to Naira).")
);
bot.hears("\u{1F501} Swap", (ctx) =>
  ctx.reply(
    "\u{1F6A7} Swap isn't wired to a real router address yet - see \u2728 Features. " +
      "Run `arc-canteen context sync` to help pin down a verified Arc testnet DEX address, then we can turn this on."
  )
);

// ---------- Catch-all: handles multi-step flows (PIN entry, etc.) ----------

bot.on("text", async (ctx) => {
  const pending = pendingAction.get(ctx.from.id);
  if (!pending) return; // not in the middle of anything - ignore stray text

  const text = ctx.message.text.trim();

  if (pending.type === "onboarding_set_pin") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("PIN must be exactly 4 digits. Try again.");
    const user = db.createUserWithWallet(ctx.from.id, pending.username, pending.address, pending.privateKey, text);
    pendingAction.delete(ctx.from.id);

    const exportMsg = await ctx.reply(
      `PIN set. Your wallet is ready:\n${user.deposit_address}\n\n` +
        `Here is your private key - this is the ONLY time it's shown automatically. Save it somewhere safe ` +
        `right now (a password manager, not a screenshot you'll forget about):\n\n` +
        `${pending.privateKey}\n\n` +
        `Anyone with this key has full control of this wallet. This message auto-deletes in 60 seconds.`
    );
    scheduleDelete(ctx, exportMsg.message_id, 60000);
    return ctx.reply("Menu:", mainMenu);
  }

  if (pending.type === "confirm_export") {
    pendingAction.delete(ctx.from.id);
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
    if (!db.verifyPin(ctx.from.id, text)) return ctx.reply("Incorrect PIN.");
    try {
      const user = db.getUser(ctx.from.id);
      const pk = db.decryptPrivateKey(text, user);
      const msg = await ctx.reply(
        `Your private key:\n\n${pk}\n\nSave it now - this message auto-deletes in 60 seconds. ` +
          `Anyone with this key controls your wallet.`
      );
      scheduleDelete(ctx, msg.message_id, 60000);
    } catch {
      await ctx.reply("Couldn't decrypt your key.");
    }
    return;
  }

  if (pending.type === "changepin_old") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your current 4-digit PIN.");
    if (!db.verifyPin(ctx.from.id, text)) {
      pendingAction.delete(ctx.from.id);
      return ctx.reply("Incorrect PIN. Run /changepin again to retry.");
    }
    const user = db.getUser(ctx.from.id);
    let pk;
    try {
      pk = db.decryptPrivateKey(text, user);
    } catch {
      pendingAction.delete(ctx.from.id);
      return ctx.reply("Couldn't unlock your wallet with that PIN.");
    }
    pendingAction.set(ctx.from.id, { type: "changepin_new", privateKey: pk });
    return ctx.reply("Now send your NEW 4-digit PIN.");
  }

  if (pending.type === "changepin_new") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("PIN must be exactly 4 digits. Try again.");
    db.updatePin(ctx.from.id, text, pending.privateKey);
    pendingAction.delete(ctx.from.id);
    return ctx.reply("PIN changed successfully.");
  }

  if (pending.type === "confirm_withdraw") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN, or /menu to cancel.");
    pendingAction.delete(ctx.from.id);
    if (!db.verifyPin(ctx.from.id, text)) return ctx.reply("Incorrect PIN. Run /withdraw again to retry.");
    const user = db.getUser(ctx.from.id);
    return executeWithdraw(ctx, user, BigInt(pending.amountMicro), pending.amountUsdc, text);
  }

  if (pending.type === "confirm_sendout") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN, or /menu to cancel.");
    pendingAction.delete(ctx.from.id);
    if (!db.verifyPin(ctx.from.id, text)) return ctx.reply("Incorrect PIN. Run /sendout again to retry.");
    const user = db.getUser(ctx.from.id);
    return executeSendout(ctx, user, BigInt(pending.amountMicro), text);
  }

  if (pending.type === "confirm_otp") {
    pendingAction.delete(ctx.from.id);
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter the 4-digit code you received.");
    try {
      const verified = await otp.verifyOtp(pending.pinId, text);
      if (verified) {
        db.setPhoneVerified(ctx.from.id, true);
        return ctx.reply("Phone verified.");
      }
      return ctx.reply("That code didn't match. Run /verifyphone again to retry.");
    } catch (err) {
      console.error(err.message);
      return ctx.reply("Couldn't verify the code right now: " + err.message);
    }
  }

  if (pending.type === "confirm_yield_deposit") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN, or /menu to cancel.");
    pendingAction.delete(ctx.from.id);
    if (!db.verifyPin(ctx.from.id, text)) return ctx.reply("Incorrect PIN. Run /deposit_yield again to retry.");

    try {
      savings.openYieldPosition(ctx.from.id, pending.amountUsdc, pending.pool);
      db.recordTransaction(
        ctx.from.id,
        "yield_deposit",
        BigInt(Math.round(pending.amountUsdc * 1e18)),
        "confirmed",
        null
      );

      await ctx.reply(
        `\u2705 Yield position opened!\n\n` +
          `$${pending.amountUsdc.toFixed(2)} USDC is now earning at ${pending.pool.userApy}% APY\n` +
          `Pool: ${pending.pool.symbol} \u00B7 Azuro \u00B7 ${pending.pool.chain}\n\n` +
          `Use /my_yield to track your accrual.\n` +
          `Use /withdraw_yield when you want to close the position.`
      );
    } catch (err) {
      console.error("[yield_deposit]", err.message);
      await ctx.reply("Something went wrong opening the yield position: " + err.message);
    }
    return;
  }

  if (pending.type === "confirm_yield_withdraw") {
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN, or /menu to cancel.");
    pendingAction.delete(ctx.from.id);
    if (!db.verifyPin(ctx.from.id, text)) return ctx.reply("Incorrect PIN. Run /withdraw_yield again to retry.");

    try {
      db.closeYieldPosition(ctx.from.id, pending.total);
      db.recordTransaction(
        ctx.from.id,
        "yield_withdraw",
        BigInt(Math.round(pending.total * 1e18)),
        "confirmed",
        null
      );

      await ctx.reply(
        `\u2705 Yield position closed.\n\n` +
          `Principal: $${pending.position.amount_usdc.toFixed(2)} USDC\n` +
          `Yield earned: +$${pending.accrued.toFixed(4)} USDC\n` +
          `Total returned: $${pending.total.toFixed(4)} USDC\n\n` +
          `\u{1F4CC} Testnet demo: funds returned to your wallet record.\n` +
          `In production, this would bridge USDC back from Polygon to Arc.`
      );
    } catch (err) {
      console.error("[yield_withdraw]", err.message);
      await ctx.reply("Something went wrong closing your position: " + err.message);
    }
    return;
  }
});

bot.launch().then(() => console.log("PayIT bot is running (Arc testnet, non-custodial)..."));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
