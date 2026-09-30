// src/flows_multichain.js
// Phase 4: multichain conversation flows extracted from bot.js —
//   • NEAR Intents deposits (Phase 3)
//   • Move Funds CCTP rebalancing Arc↔Solana (Phase 2)
//
// Two entry points:
//   registerMultichainFlows(bot, deps)  — callback-button action handlers
//   handleMultichainState(bot, ctx, state, text, userId) — text-state handlers
// bot.js keeps only the thin registration/delegation wiring.

const { Markup } = require("telegraf");

const db = require("./db");
const walletLib = require("./wallet");
const multichain = require("./multichain");
const fx = require("./fx");
const nearLib = require("./near");
const chains = require("./chains");
const convState = require("./conversation_state");
const { shouldReprocessConversationState } = require("./conversation_flow");
const { moveFundsBetweenChains } = require("../agent/executor");

// Bot-local helpers, injected by bot.js at registration time.
let deps = {};

function registerMultichainFlows(bot, depsIn = {}) {
  deps = { bot, ...depsIn };
  registerNearDepositActions(bot);
  registerMoveFundsActions(bot);
}

// ─── NEAR Intents deposit (Phase 3) ──────────────────────────────────────────

function registerNearDepositActions(bot) {
  const { requireUser, getContext } = deps;

  bot.action("action_near_deposit", async (ctx) => {
    ctx.answerCbQuery();
    const user = requireUser(ctx);
    if (!user) return;
    convState.setState(ctx.from.id, "await_near_amount", {}, getContext(ctx.from.id));
    return ctx.reply(
      `Ⓝ <b>Deposit from NEAR</b>\n──────────────────────────\n` +
      `Send USDC from any NEAR wallet and it lands in your PayIT balance automatically ` +
      `(via NEAR Intents → Base → Arc, ~2–5 minutes).\n\n` +
      `How much USDC would you like to deposit? (minimum $2)`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]]),
      }
    );
  });

  bot.action(/^action_near_status_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery();
    const row = db.getNearDepositById(Number(ctx.match[1]));
    if (!row) return ctx.reply("Deposit request not found.", deps.backToMenu);

    let status = row.status;
    if (row.deposit_address && !nearLib.TERMINAL_STATUSES.has(status) && status !== "expired") {
      try {
        const st = await nearLib.getExecutionStatus(row.deposit_address, row.deposit_memo);
        if (st?.status) {
          status = String(st.status).toUpperCase();
          if (status !== row.status) db.updateNearDeposit(row.id, { status });
        }
      } catch (_) {}
    }

    const labels = {
      quoting: "⏳ Preparing your deposit address…",
      awaiting_deposit: "⏳ Waiting for your NEAR deposit…",
      PENDING_DEPOSIT: "⏳ Waiting for deposit confirmation on NEAR…",
      KNOWN_DEPOSIT_TX: "✅ Deposit seen — confirming…",
      INCOMPLETE_DEPOSIT: "⚠️ Deposit amount didn't match exactly — refunding the difference…",
      PROCESSING: "🌉 Bridging to Base…",
      SUCCESS: "✅ Bridged to Base — sweeping into your Arc balance…",
      REFUNDED: "↩️ Refunded to your NEAR refund address.",
      FAILED: "❌ Bridge failed — contact support.",
      expired: "⏰ Deposit window expired.",
    };

    return ctx.reply(
      `Ⓝ <b>NEAR Deposit Status</b>\n──────────────────────────\n` +
      `💰 <b>Amount:</b> $${Number(row.amount_usdc).toFixed(2)} USDC\n` +
      (row.amount_out ? `💵 <b>You receive:</b> ~$${Number(row.amount_out).toFixed(2)} USDC\n` : "") +
      `📊 <b>Status:</b> ${labels[status] || status}\n\n` +
      (status === "SUCCESS"
        ? `<i>Your Arc credit confirmation arrives separately once the sweep completes.</i>`
        : `<i>Check again in a minute — this updates automatically.</i>`),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Refresh", `action_near_status_${row.id}`)],
          [Markup.button.callback("💰 Check Balance", "action_balance")],
          [Markup.button.callback("🏠 Main Menu", "main_menu")],
        ]),
      }
    );
  });
}

// ─── Move Funds: CCTP rebalancing between Arc and Solana (Phase 2) ───────────

function registerMoveFundsActions(bot) {
  const { requireUser, getContext } = deps;

  bot.action("action_move_funds", async (ctx) => {
    ctx.answerCbQuery();
    const user = requireUser(ctx);
    if (!user) return;
    const context = getContext(ctx.from.id);

    // Unified balance read path (Phase 4)
    let arcUsdc = 0;
    let solUsdc = 0;
    try {
      const unified = await chains.getUnifiedBalance(user, context);
      arcUsdc = unified.arc.usdc;
      solUsdc = unified.solana.usdc;
    } catch (_) {}

    const buttons = [];
    if (arcUsdc > 0) {
      buttons.push([Markup.button.callback(`⚡ Arc → Solana  ($${arcUsdc.toFixed(2)} avail)`, "action_move_arc_to_solana")]);
    }
    if (solUsdc > 0) {
      buttons.push([Markup.button.callback(`☀️ Solana → Arc  ($${solUsdc.toFixed(2)} avail)`, "action_move_solana_to_arc")]);
    }
    buttons.push([Markup.button.callback("🔄 Move Status", "action_move_status")]);
    buttons.push([Markup.button.callback("❌ Cancel", "main_menu")]);

    return ctx.reply(
      `🔀 <b>Move Funds Between Chains</b>\n──────────────────────────\n` +
      `⚡ <b>Arc:</b> $${arcUsdc.toFixed(2)}\n` +
      `☀️ <b>Solana:</b> $${solUsdc.toFixed(2)}\n\n` +
      `<i>Moves use Circle CCTP — funds arrive on the other chain in ~1–5 minutes. ` +
      `No PayIT fee (network gas only).</i>`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) }
    );
  });

  for (const [direction, fromLabel, toLabel] of [
    ["arc_to_solana", "⚡ Arc", "☀️ Solana"],
    ["solana_to_arc", "☀️ Solana", "⚡ Arc"],
  ]) {
    bot.action(`action_move_${direction}`, (ctx) => {
      ctx.answerCbQuery();
      const user = requireUser(ctx);
      if (!user) return;
      convState.setState(ctx.from.id, "move_funds_amount", { direction }, getContext(ctx.from.id));
      return ctx.reply(
        `🔀 Move Funds: ${fromLabel} → ${toLabel}\n──────────────────────────\n` +
        `How much USDC would you like to move?`,
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]])
      );
    });
  }

  bot.action("action_move_status", async (ctx) => {
    ctx.answerCbQuery();
    const burns = db.getRecentCctpBurnsByUser(ctx.from.id, 3);
    const inbounds = db.getRecentInboundByUser(ctx.from.id, 3);

    if (!burns.length && !inbounds.length) {
      return ctx.reply("No recent moves found.", deps.backToMenu);
    }

    const burnLabels = {
      pending: "🌉 Burned on Arc — minting on Solana…",
      failed: "❌ Mint on Solana failed — retrying automatically",
      completed: "✅ Arrived on Solana",
    };
    const inboundLabels = {
      initiated: "⏳ Preparing…",
      burned: "🌉 Burned on Solana — minting on Arc…",
      attested: "🌉 Attested — minting on Arc…",
      pending_retry: "🔄 Retrying mint on Arc…",
      failed_burn: "❌ Burn failed — funds still safe on Solana",
      completed: "✅ Arrived on Arc",
    };

    const lines = [];
    for (const b of burns) {
      lines.push(
        `⚡→☀️ $${Number(b.amount_usdc).toFixed(2)} · ${burnLabels[b.status] || b.status}` +
        (b.status === "completed" && b.solana_tx_sig ? `\n   <code>${b.solana_tx_sig}</code>` : "")
      );
    }
    for (const t of inbounds) {
      lines.push(
        `☀️→⚡ $${Number(t.amount_usdc).toFixed(2)} · ${inboundLabels[t.status] || t.status}` +
        (t.status === "completed" && t.arc_tx_hash ? `\n   <code>${t.arc_tx_hash}</code>` : "")
      );
    }

    return ctx.reply(
      `🔀 <b>Recent Moves</b>\n──────────────────────────\n` + lines.join("\n\n") +
      `\n\n<i>Mints typically complete in 1–5 minutes. You also get a confirmation message when funds land.</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Refresh", "action_move_status")],
          [Markup.button.callback("💰 Check Balance", "action_balance")],
          [Markup.button.callback("🏠 Main Menu", "main_menu")],
        ]),
      }
    );
  });
}

// ─── Text-state handlers (called from bot.js's text middleware) ───────────────

const HANDLED_STATES = new Set(["await_near_amount", "move_funds_amount", "move_funds_confirm"]);

function handlesState(stateType) {
  return HANDLED_STATES.has(stateType);
}

async function handleMultichainState(bot, ctx, state, text, userId) {
  const { requireUser, getContext, getActiveWallet, getOrDeriveSolanaAddress, deleteSensitiveMessage } = deps;

  // ── NEAR deposit amount ──────────────────────────────────────────────────

  if (state.type === "await_near_amount") {
    const amount = parseFloat(text.replace(/[^0-9.]/g, ""));
    if (isNaN(amount) || amount < 2) {
      if (shouldReprocessConversationState("await_near_amount", text)) {
        convState.clearState(userId);
        return bot.handleUpdate({ update_id: ctx.update.update_id, message: ctx.message });
      }
      return ctx.reply("Enter a valid amount (minimum $2). Type cancel to stop.");
    }
    const user = requireUser(ctx);
    if (!user) return;
    const context = state.context || "personal";
    const recipientAddress = getActiveWallet(user);

    // Refund address: the user's derived NEAR implicit account (system key,
    // no PIN needed). Refunds from failed/expired bridges land here.
    let refundTo;
    try {
      const sysKey = db.getSystemDecryptedPrivateKey(user);
      refundTo = nearLib.deriveNearAddress(sysKey).nearAddress;
    } catch (_) {
      convState.clearState(userId);
      return ctx.reply(
        "🔐 For your safety, we must verify your wallet before creating a NEAR deposit. " +
        "Complete one PIN-confirmed action and try again."
      );
    }

    await ctx.reply("⏳ Generating your one-time NEAR deposit address…");
    let row;
    try {
      row = await nearLib.createNearDeposit({
        telegramId: userId,
        accountType: context,
        originAsset: nearLib.ASSETS.NEAR_USDC,
        amountUsdc: amount,
        recipientAddress,
        refundTo,
      });
    } catch (err) {
      convState.clearState(userId);
      return ctx.reply(`❌ Could not open a NEAR deposit for this amount: ${err.message}`, deps.backToMenu);
    }
    convState.clearState(userId);

    if (!row || !row.deposit_address) {
      return ctx.reply("❌ The bridge could not quote this amount right now. Try again in a few minutes.", deps.backToMenu);
    }

    const expireIn = process.env.NEAR_INTENT_DEADLINE_MIN || 30;
    return ctx.reply(
      `Ⓝ <b>NEAR Deposit Instructions</b>\n──────────────────────────\n` +
      `💰 <b>Send exactly:</b> $${amount.toFixed(2)} USDC\n` +
      (row.amount_out ? `💵 <b>You receive:</b> ~$${Number(row.amount_out).toFixed(2)} USDC\n` : "") +
      `📍 <b>NEAR address (one-time):</b> <code>${row.deposit_address}</code>\n` +
      (row.deposit_memo ? `📝 <b>Memo (required):</b> <code>${row.deposit_memo}</code>\n` : "") +
      `⏰ <b>Valid for:</b> ${expireIn} minutes\n\n` +
      `⚠️ <i>Send USDC on NEAR only, exact amount, before expiry. ` +
      `If anything goes wrong, funds auto-refund to your NEAR address.</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Check Bridge Status", `action_near_status_${row.id}`)],
          [Markup.button.callback("💰 Check Balance", "action_balance")],
          [Markup.button.callback("🏠 Main Menu", "main_menu")],
        ]),
      }
    );
  }

  // ── Move Funds: amount + PIN confirmation ────────────────────────────────

  if (state.type === "move_funds_amount") {
    const amount = parseFloat(text.replace(/[^0-9.]/g, ""));
    if (isNaN(amount) || amount <= 0) {
      if (shouldReprocessConversationState("move_funds_amount", text)) {
        convState.clearState(userId);
        return bot.handleUpdate({ update_id: ctx.update.update_id, message: ctx.message });
      }
      return ctx.reply("Enter a valid amount (e.g. 25). Type cancel to stop.");
    }
    const user = requireUser(ctx);
    if (!user) return;
    const direction = state.data?.direction;

    // Source-chain balance check before asking for a PIN.
    let available = 0;
    try {
      if (direction === "arc_to_solana") {
        available = parseFloat(walletLib.formatMicro(await walletLib.getNativeBalanceMicro(getActiveWallet(user))));
      } else {
        const solAddress = getOrDeriveSolanaAddress(user);
        if (solAddress) {
          const bal = await multichain.getSplTokenBalance(solAddress);
          if (bal && bal.uiAmount > 0) available = bal.uiAmount;
        }
      }
    } catch (_) {}
    if (available < amount) {
      return ctx.reply(
        `Not enough USDC on the source chain. You have $${available.toFixed(2)} ` +
        `${direction === "arc_to_solana" ? "on Arc" : "on Solana"}. Enter a smaller amount or type cancel.`
      );
    }

    convState.setState(userId, "move_funds_confirm", { direction, amountUsdc: amount }, state.context);
    const dirLabel = direction === "arc_to_solana" ? "⚡ Arc → ☀️ Solana" : "☀️ Solana → ⚡ Arc";
    return ctx.reply(
      `🔀 <b>Confirm Move</b>\n──────────────────────────\n` +
      `Route: ${dirLabel}\nAmount: $${amount.toFixed(2)} USDC\n\n` +
      `<i>Uses Circle CCTP. Funds arrive in ~1–5 minutes. Network gas only — no PayIT fee.</i>\n\n` +
      `Enter your PIN to confirm:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]]),
      }
    );
  }

  if (state.type === "move_funds_confirm") {
    await deleteSensitiveMessage(ctx);
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
    if (!db.verifyPin(userId, text)) { convState.clearState(userId); return ctx.reply("Incorrect PIN. Try again."); }
    const user = db.getUser(userId);
    convState.clearState(userId);
    await ctx.reply("⏳ Moving your funds…");
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
      const result = await moveFundsBetweenChains(userWallet, {
        direction: state.data.direction,
        amountUsdc: state.data.amountUsdc,
        telegramId: userId,
        accountType: context,
        bot,
      });
      if (result.success) {
        const dirLabel = result.fromChain === "arc" ? "⚡ Arc → ☀️ Solana" : "☀️ Solana → ⚡ Arc";
        return ctx.reply(
          `✅ <b>Move Submitted</b>\n──────────────────────────\n` +
          `Route: ${dirLabel}\nAmount: $${Number(result.amount).toFixed(2)} USDC\n` +
          (result.txHash ? `🔗 <code>${result.txHash}</code>\n` : "") +
          `\n<i>You'll get a confirmation message when the funds land on the other chain (~1–5 min).</i>`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("🔄 Check Move Status", "action_move_status")],
              [Markup.button.callback("💰 Check Balance", "action_balance")],
              [Markup.button.callback("🏠 Main Menu", "main_menu")],
            ]),
          }
        );
      }
      return ctx.reply(`❌ ${result.error}`, deps.backToMenu);
    } catch (err) {
      console.error("[flows_multichain:move_funds_confirm:error]", err);
      return ctx.reply(`❌ Move could not be completed: ${err.message || "An unexpected error occurred"}`, deps.backToMenu);
    }
  }

  return false;
}

module.exports = {
  registerMultichainFlows,
  handleMultichainState,
  handlesState,
};
