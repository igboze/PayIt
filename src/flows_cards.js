// src/flows_cards.js
// Telegram UI Flows for Nuvion Phase 4:
// - Load-to-Spend Virtual & Disposable USD Cards (Personal + Business Team Cards)
// - PIN-Gated 60-Second Self-Destructing PAN / CVV Reveal (ZERO PAN/CVV stored or logged!)
// - 1-Tap Top Up, Unload to Main Balance, Freeze, Unfreeze, Transactions & Safe Delete (with auto-unload)

const { Markup } = require("telegraf");
const nuvion = require("./nuvion");
const cardsLib = require("./nuvion_cards");
const db = require("./db");
const convState = require("./conversation_state");

const CARD_REVEAL_TTL_MS = 60 * 1000; // Auto-delete sensitive PAN/CVV message after 60 seconds!
let deps = {};

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function handlesState(stateType) {
  return typeof stateType === "string" && stateType.startsWith("nuvion_card_");
}

function pFlag(accountType) {
  return accountType === "business" ? "biz" : "per";
}

function fromFlag(flag) {
  return flag === "biz" ? "business" : "personal";
}

async function deleteSensitiveMessage(ctx) {
  try {
    if (ctx.message?.message_id && ctx.chat?.id) {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
    }
  } catch (_) {}
}

function formatPanSpaced(pan) {
  if (!pan) return "Unavailable";
  return String(pan).replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}

function statusBadge(status) {
  const s = String(status || "").toLowerCase();
  if (s === "active") return "🟢 Active";
  if (s === "blocked") return "❄️ Frozen";
  if (s === "deactivated") return "⚪ Used";
  if (s === "fraud") return "🚨 Flagged";
  return s || "Unknown";
}

/**
 * Show the user's Personal or Business USD Cards dashboard.
 */
async function showCardsMenu(ctx, accountType = "personal") {
  const user = deps.requireUser ? deps.requireUser(ctx) : db.getUser(ctx.from.id);
  if (!user) return;
  if (!nuvion.isUserAllowedNuvion(ctx.from.id)) {
    return ctx.reply("💳 Virtual & Disposable USD Cards are currently in private beta.", deps.backToMenu || {});
  }

  const entity = db.getNuvionEntityByUser(ctx.from.id, accountType);
  if (!entity || String(entity.status).toLowerCase() !== "approved") {
    return ctx.reply(
      `🔒 <b>Tier-1 Verification Required</b>\n──────────────────────────\n` +
      `Complete your ${accountType === "business" ? "Business KYB" : "Personal KYC"} verification to issue Virtual &amp; Disposable USD cards.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🪪 Open Global Banking", accountType === "business" ? "biz_nuvion_portal" : "action_nuvion_portal")],
          [Markup.button.callback("🏠 Main Menu", "main_menu")],
        ]),
      }
    );
  }

  const p = pFlag(accountType);
  const { cards, totalCardBalanceUsd } = await cardsLib.getUserCardsWithBalances(ctx.from.id, accountType);
  const title = accountType === "business" ? "Business & Team USD Cards" : "Virtual & Disposable USD Cards";

  const lines = [
    `💳 <b>${title}</b>`,
    `──────────────────────────`,
  ];

  if (cards.length === 0) {
    lines.push(`You haven't issued any USD cards yet.\n`);
    lines.push(`• <b>Virtual Card:</b> Reusable USD card for subscriptions, ads &amp; cloud bills — top up or unload anytime.`);
    lines.push(`• <b>Disposable Card:</b> Single-use card that locks after 1 purchase and auto-sweeps leftover cents back to your main balance!`);
  } else {
    lines.push(`<b>Total Loaded Across Cards:</b> $${totalCardBalanceUsd.toFixed(2)}\n`);
    for (const c of cards.slice(0, 10)) {
      const icon = c.card_type === "disposable" ? "⚡" : "💳";
      const tail = c.last4 ? ` ••••${c.last4}` : "";
      lines.push(`${icon} <b>${escapeHtml(c.card_name || "USD Card")}</b>${tail} — <b>$${c.availableUsd.toFixed(2)}</b> (${statusBadge(c.status)})`);
    }
    lines.push(`\n<i>Tap any card below to reveal details, top up, unload, freeze, or view transactions.</i>`);
  }

  const buttons = [];
  for (const c of cards.slice(0, 10)) {
    const icon = c.card_type === "disposable" ? "⚡" : "💳";
    const tail = c.last4 ? ` ••${c.last4}` : "";
    buttons.push([
      Markup.button.callback(
        `${icon} ${c.card_name || "Card"}${tail} ($${c.availableUsd.toFixed(2)})`,
        `nuvion_card_view_${p}_${c.id}`
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback("➕ New Virtual Card", `nuvion_card_new_${p}_virtual`),
    Markup.button.callback("⚡ 1-Time Disposable", `nuvion_card_new_${p}_disposable`),
  ]);
  if (accountType === "business") {
    buttons.push([Markup.button.callback("👥 Issue Team Member Card", `nuvion_card_new_${p}_team`)]);
  }
  buttons.push([Markup.button.callback("« Global Banking Portal", accountType === "business" ? "biz_nuvion_portal" : "action_nuvion_portal")]);

  return ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(buttons),
  });
}

/**
 * Show individual card control panel (Reveal, Top Up, Unload, Freeze/Unfreeze, Transactions, Delete).
 */
async function showCardControlPanel(ctx, accountType, localRowId) {
  const entity = db.getNuvionEntityByUser(ctx.from.id, accountType);
  if (!entity) return showCardsMenu(ctx, accountType);
  const p = pFlag(accountType);

  const card = db.getNuvionCardsByEntity(entity.entity_id).find((c) => Number(c.id) === Number(localRowId));
  if (!card) return ctx.reply("❌ Card not found.", Markup.inlineKeyboard([[Markup.button.callback("« All Cards", `nuvion_cards_menu_${p}`)]]));

  let availableUsd = 0;
  try {
    const liveAcc = await nuvion.getAccount(card.account_id, entity.entity_id);
    availableUsd = nuvion.fromNuvionMinor(liveAcc?.balance?.available || 0);
  } catch (_) {}

  const isDisposable = card.card_type === "disposable";
  const isFrozen = String(card.status).toLowerCase() === "blocked";
  const isUsed = String(card.status).toLowerCase() === "deactivated";

  const rows = [];
  if (!isUsed) {
    rows.push([Markup.button.callback("👁️ Reveal Card Details (PIN · 60s)", `nuvion_card_reveal_${p}_${card.id}`)]);
  }
  if (!isDisposable && !isUsed) {
    rows.push([
      Markup.button.callback("➕ Top Up Card", `nuvion_card_topup_${p}_${card.id}`),
      Markup.button.callback("↩️ Unload to Balance", `nuvion_card_unload_${p}_${card.id}`),
    ]);
    rows.push([
      isFrozen
        ? Markup.button.callback("🔥 Unfreeze Card", `nuvion_card_unfreeze_${p}_${card.id}`)
        : Markup.button.callback("❄️ Freeze Card", `nuvion_card_freeze_${p}_${card.id}`),
      Markup.button.callback("📋 Transactions", `nuvion_card_txs_${p}_${card.id}`),
    ]);
  } else {
    if (availableUsd >= 0.5) {
      rows.push([Markup.button.callback("↩️ Sweep Leftover to Balance", `nuvion_card_unload_${p}_${card.id}`)]);
    }
    rows.push([Markup.button.callback("📋 Transactions", `nuvion_card_txs_${p}_${card.id}`)]);
  }
  rows.push([
    Markup.button.callback("🗑️ Delete Card", `nuvion_card_del_ask_${p}_${card.id}`),
    Markup.button.callback("« All Cards", `nuvion_cards_menu_${p}`),
  ]);

  return ctx.reply(
    `${isDisposable ? "⚡" : "💳"} <b>${escapeHtml(card.card_name || "USD Card")}</b>\n` +
    `──────────────────────────\n` +
    `• <b>Type:</b> ${isDisposable ? "Disposable (Single-Use)" : "Virtual (Reusable)"}\n` +
    `• <b>Number:</b> <code>•••• •••• •••• ${escapeHtml(card.last4 || "••••")}</code>\n` +
    `• <b>Status:</b> ${statusBadge(card.status)}\n` +
    `• <b>Loaded Spend Limit:</b> <b>$${availableUsd.toFixed(2)}</b>\n\n` +
    `<i>Only funds loaded onto this card can be spent. Your main Proxim balance is completely isolated.</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(rows),
    }
  );
}

/**
 * Handle text states for Cards (Issue, Team Cardholder, Top Up, PIN confirmations).
 */
async function handleCardsTextState(ctx, state, text, userId) {
  if (!state || !handlesState(state.type)) return false;

  const val = String(text || "").trim();
  const d = state.data || {};
  const accountType = d.accountType || "personal";
  const p = pFlag(accountType);

  // ── Business Team Card: Capture Cardholder Details First ──────────────────
  if (state.type === "nuvion_card_team_holder") {
    const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
    const fullName = parts[0] || "";
    const email = parts[1] || "";
    const phone = parts[2] || "";
    if (!fullName || !email.includes("@") || phone.replace(/\D/g, "").length < 8) {
      await ctx.reply(
        `Please enter: <b>Full Name, Email, Phone (+...)</b>\n` +
        `Example: <code>Amara Obi, amara@company.com, +2348012345678</code>`,
        { parse_mode: "HTML" }
      );
      return true;
    }
    const nameParts = fullName.split(/\s+/);
    const cardholderOverrides = {
      first_name: nameParts[0],
      last_name: nameParts.slice(1).join(" ") || nameParts[0],
      email: email.toLowerCase(),
      phone_number: phone.startsWith("+") ? phone : `+${phone.replace(/\D/g, "")}`,
    };

    convState.setState(
      userId,
      "nuvion_card_create_input",
      { accountType, cardType: "virtual", cardholderOverrides },
      accountType
    );
    await ctx.reply(
      `👥 <b>Team Cardholder Saved:</b> ${escapeHtml(fullName)}\n──────────────────────────\n` +
      `Now enter <b>Initial USD Load, Card Nickname</b>:\n` +
      `Example: <code>100, Marketing Ads Card</code>`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  // ── Capture Card Initial Load Amount + Nickname -> Live Fee Quote Preview ──
  if (state.type === "nuvion_card_create_input") {
    const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
    const loadAmountUsd = parseFloat((parts[0] || "").replace(/[^0-9.]/g, ""));
    const cardName = parts.slice(1).join(", ") || (d.cardType === "disposable" ? "Disposable Card" : "Proxim USD Card");

    if (!Number.isFinite(loadAmountUsd) || loadAmountUsd < 1) {
      await ctx.reply(
        `Please enter a valid USD amount (minimum $1) and card name.\n` +
        `Example: <code>25, Netflix & Cloud</code>`,
        { parse_mode: "HTML" }
      );
      return true;
    }

    await ctx.reply("⏳ Checking live card issuance fee and preparing your quote...");
    try {
      const q = await cardsLib.quoteCardIssuance({
        telegramId: userId,
        accountType,
        cardType: d.cardType || "virtual",
        loadAmountUsd,
        cardName,
      });

      convState.setState(
        userId,
        "nuvion_card_create_pin",
        {
          accountType,
          cardType: d.cardType || "virtual",
          cardName,
          loadAmountUsd,
          cardholderOverrides: d.cardholderOverrides || null,
          quoteSummary: {
            creationFeeUsd: q.creationFeeUsd,
            marginUsd: q.marginUsd,
            userTotalUsd: q.userTotalUsd,
          },
        },
        accountType
      );

      const kindLabel = d.cardType === "disposable" ? "Disposable 1-Time USD Card" : "Virtual USD Card";
      await ctx.reply(
        `💳 <b>Confirm ${kindLabel}</b>\n` +
        `──────────────────────────\n` +
        `• <b>Card Name:</b> ${escapeHtml(cardName)}\n` +
        `• <b>Loaded Spend Cap:</b> <b>$${q.loadAmountUsd.toFixed(2)}</b>\n` +
        (q.creationFeeUsd > 0 ? `• <b>Card Issuance Fee:</b> $${q.creationFeeUsd.toFixed(2)}\n` : "") +
        (q.marginUsd > 0 ? `• <b>Load / FX Spread (1%):</b> $${q.marginUsd.toFixed(2)}\n` : "") +
        `• <b>Total From Your Balance:</b> <b>$${q.userTotalUsd.toFixed(2)}</b>\n` +
        (d.cardType === "disposable"
          ? `\n<i>Single-use card: auto-deactivates after 1 purchase &amp; sweeps any leftover balance back to your main Proxim balance.</i>\n`
          : `\n<i>Reusable card: top up or unload unused funds back to your main balance anytime.</i>\n`) +
        `\n🔐 <b>Enter your 4-digit PIN</b> to issue &amp; load now:`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `nuvion_card_cancel_${p}`)]]),
        }
      );
    } catch (err) {
      convState.clearState(userId);
      await ctx.reply(`❌ ${escapeHtml(nuvion.formatUserFriendlyError(err))}`, { parse_mode: "HTML" });
    }
    return true;
  }

  // ── PIN Confirm: Issue & Load Card ────────────────────────────────────────
  if (state.type === "nuvion_card_create_pin") {
    await deleteSensitiveMessage(ctx);
    const pin = val.replace(/\s+/g, "");
    if (!/^\d{4,8}$/.test(pin)) {
      await ctx.reply("🔐 Please enter your numeric PIN (or tap Cancel).");
      return true;
    }

    convState.clearState(userId);
    await ctx.reply("⏳ Funding your card sub-account and issuing your USD card...");

    try {
      const res = await cardsLib.initiateCardIssuance({
        telegramId: userId,
        pin,
        accountType,
        cardType: d.cardType || "virtual",
        cardName: d.cardName,
        loadAmountUsd: d.loadAmountUsd,
        cardholderOverrides: d.cardholderOverrides || null,
        bot: deps.bot || null,
      });

      await ctx.reply(
        `🚀 <b>Card Funding Initiated!</b>\n` +
        `──────────────────────────\n` +
        `• <b>Card:</b> ${escapeHtml(d.cardName)}\n` +
        `• <b>Load Amount:</b> $${res.loadAmountUsd.toFixed(2)}\n` +
        `• <b>Reference:</b> <code>${escapeHtml(res.uniqueReference)}</code>\n\n` +
        `<i>Your card will activate automatically in moments and appear in 💳 Cards!</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("💳 Open Cards", `nuvion_cards_menu_${p}`)]]),
        }
      );
    } catch (err) {
      await ctx.reply(`❌ ${escapeHtml(nuvion.formatUserFriendlyError(err))}`, { parse_mode: "HTML" });
    }
    return true;
  }

  // ── Top Up Existing Virtual Card: Enter Amount ────────────────────────────
  if (state.type === "nuvion_card_topup_amt") {
    const loadAmountUsd = parseFloat(val.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(loadAmountUsd) || loadAmountUsd < 1) {
      await ctx.reply("Please enter a valid USD amount (minimum $1, e.g. <code>50</code>):", { parse_mode: "HTML" });
      return true;
    }

    try {
      const q = await cardsLib.quoteCardTopUp({
        telegramId: userId,
        accountType,
        cardId: d.cardId,
        loadAmountUsd,
      });

      convState.setState(
        userId,
        "nuvion_card_topup_pin",
        { accountType, cardId: d.cardId, cardName: q.card.card_name, loadAmountUsd },
        accountType
      );

      await ctx.reply(
        `➕ <b>Confirm Card Top-Up</b>\n` +
        `──────────────────────────\n` +
        `• <b>Card:</b> ${escapeHtml(q.card.card_name || "Virtual Card")}\n` +
        `• <b>Add to Card Limit:</b> <b>+$${q.loadAmountUsd.toFixed(2)}</b>\n` +
        (q.marginUsd > 0 ? `• <b>Load / FX Spread (1%):</b> $${q.marginUsd.toFixed(2)}\n` : "") +
        `• <b>Total From Your Balance:</b> <b>$${q.userTotalUsd.toFixed(2)}</b>\n\n` +
        `🔐 <b>Enter your 4-digit PIN</b> to top up:`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `nuvion_card_cancel_${p}`)]]),
        }
      );
    } catch (err) {
      convState.clearState(userId);
      await ctx.reply(`❌ ${escapeHtml(nuvion.formatUserFriendlyError(err))}`, { parse_mode: "HTML" });
    }
    return true;
  }

  // ── PIN Confirm: Top Up Virtual Card ──────────────────────────────────────
  if (state.type === "nuvion_card_topup_pin") {
    await deleteSensitiveMessage(ctx);
    const pin = val.replace(/\s+/g, "");
    if (!/^\d{4,8}$/.test(pin)) {
      await ctx.reply("🔐 Please enter your numeric PIN (or tap Cancel).");
      return true;
    }

    convState.clearState(userId);
    await ctx.reply("⏳ Loading funds onto your card...");

    try {
      const res = await cardsLib.initiateCardTopUp({
        telegramId: userId,
        pin,
        accountType,
        cardId: d.cardId,
        loadAmountUsd: d.loadAmountUsd,
        bot: deps.bot || null,
      });

      await ctx.reply(
        `🚀 <b>Card Top-Up Submitted!</b>\n` +
        `──────────────────────────\n` +
        `• <b>Card:</b> ${escapeHtml(d.cardName || "Virtual Card")}\n` +
        `• <b>Adding:</b> +$${res.quote.loadAmountUsd.toFixed(2)}\n` +
        `<i>We'll alert you here as soon as your updated card limit is live.</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("💳 Open Cards", `nuvion_cards_menu_${p}`)]]),
        }
      );
    } catch (err) {
      await ctx.reply(`❌ ${escapeHtml(nuvion.formatUserFriendlyError(err))}`, { parse_mode: "HTML" });
    }
    return true;
  }

  // ── PIN Confirm: Reveal Card Details (Auto-Deletes After 60 Seconds!) ─────
  if (state.type === "nuvion_card_reveal_pin") {
    await deleteSensitiveMessage(ctx);
    const pin = val.replace(/\s+/g, "");
    if (!/^\d{4,8}$/.test(pin)) {
      await ctx.reply("🔐 Please enter your numeric PIN (or tap Cancel).");
      return true;
    }

    convState.clearState(userId);
    try {
      const details = await cardsLib.revealCardDetailsWithPin({
        telegramId: userId,
        pin,
        accountType,
        cardId: d.cardId,
      });

      const billingLines = [];
      if (details.billing) {
        const b = details.billing;
        const addr = [b.address_line_1, b.address_line_2, b.city, b.state, b.postal_code].filter(Boolean).join(", ");
        if (addr) billingLines.push(`• <b>Billing Address:</b> ${escapeHtml(addr)}`);
      }

      const sent = await ctx.reply(
        `🔐 <b>Card Details (Auto-Deletes in 60s)</b>\n` +
        `──────────────────────────\n` +
        `• <b>Card Name:</b> ${escapeHtml(details.name || "USD Card")}\n` +
        `• <b>Cardholder:</b> ${escapeHtml(details.cardholderName || "Proxim Member")}\n` +
        `• <b>Card Number:</b> <code>${escapeHtml(formatPanSpaced(details.number))}</code>\n` +
        `• <b>Expiry:</b> <code>${escapeHtml(details.expirationMonth || "--")}/${escapeHtml(details.expirationYear || "--")}</code>\n` +
        `• <b>CVV:</b> <code>${escapeHtml(details.cvv || "---")}</code>\n` +
        `• <b>Spendable Limit:</b> $${details.availableUsd.toFixed(2)}\n` +
        (billingLines.length ? `${billingLines.join("\n")}\n` : "") +
        `\n<i>⚠️ For your security, this message will disappear automatically in 60 seconds and is never saved on our servers.</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("🗑️ Hide Details Now", "nuvion_card_hide_msg")]]),
        }
      );

      // Schedule automatic 60-second deletion of the sensitive PAN/CVV Telegram message
      if (sent?.message_id && ctx.chat?.id) {
        const chatId = ctx.chat.id;
        const msgId = sent.message_id;
        const t = setTimeout(() => {
          ctx.telegram.deleteMessage(chatId, msgId).catch(() => {});
        }, CARD_REVEAL_TTL_MS);
        if (t.unref) t.unref();
      }
    } catch (err) {
      await ctx.reply(`❌ ${escapeHtml(nuvion.formatUserFriendlyError(err))}`, { parse_mode: "HTML" });
    }
    return true;
  }

  return false;
}

function registerCardsFlows(bot, depsIn = {}) {
  deps = { bot, ...depsIn };

  bot.action(/^nuvion_cards_menu_(per|biz)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    return showCardsMenu(ctx, fromFlag(ctx.match[1]));
  });

  bot.action(/^nuvion_card_view_(per|biz)_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    return showCardControlPanel(ctx, fromFlag(ctx.match[1]), Number(ctx.match[2]));
  });

  bot.action(/^nuvion_card_new_(per|biz)_(virtual|disposable|team)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const accountType = fromFlag(ctx.match[1]);
    const mode = ctx.match[2];
    const p = ctx.match[1];

    if (mode === "team") {
      convState.setState(ctx.from.id, "nuvion_card_team_holder", { accountType }, accountType);
      return ctx.reply(
        `👥 <b>New Business Team Card</b>\n──────────────────────────\n` +
        `Enter your team member's details separated by commas:\n` +
        `<b>Full Name, Email, Phone (+...)</b>\n` +
        `Example: <code>Amara Obi, amara@company.com, +2348012345678</code>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `nuvion_card_cancel_${p}`)]]),
        }
      );
    }

    convState.setState(
      ctx.from.id,
      "nuvion_card_create_input",
      { accountType, cardType: mode },
      accountType
    );
    const label = mode === "disposable" ? "⚡ New 1-Time Disposable USD Card" : "💳 New Virtual USD Card";
    return ctx.reply(
      `<b>${label}</b>\n──────────────────────────\n` +
      `Enter <b>Initial USD Load, Card Name</b> separated by a comma:\n` +
      `Example: <code>${mode === "disposable" ? "20, One-Time Software Trial" : "50, Subscriptions Card"}</code>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `nuvion_card_cancel_${p}`)]]),
      }
    );
  });

  bot.action(/^nuvion_card_reveal_(per|biz)_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const accountType = fromFlag(ctx.match[1]);
    const entity = db.getNuvionEntityByUser(ctx.from.id, accountType);
    const card = entity ? db.getNuvionCardsByEntity(entity.entity_id).find((c) => Number(c.id) === Number(ctx.match[2])) : null;
    if (!card) return ctx.reply("❌ Card not found.");

    convState.setState(ctx.from.id, "nuvion_card_reveal_pin", { accountType, cardId: card.card_id }, accountType);
    return ctx.reply(
      `🔐 <b>Enter your 4-digit PIN</b> to reveal card details for <b>${escapeHtml(card.card_name || "USD Card")}</b>\n` +
      `<i>(Your PIN message will be deleted immediately and card details will self-destruct after 60 seconds.)</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `nuvion_card_cancel_${ctx.match[1]}`)]]),
      }
    );
  });

  bot.action("nuvion_card_hide_msg", async (ctx) => {
    ctx.answerCbQuery("Card details hidden").catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch (_) {}
  });

  bot.action(/^nuvion_card_topup_(per|biz)_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const accountType = fromFlag(ctx.match[1]);
    const entity = db.getNuvionEntityByUser(ctx.from.id, accountType);
    const card = entity ? db.getNuvionCardsByEntity(entity.entity_id).find((c) => Number(c.id) === Number(ctx.match[2])) : null;
    if (!card) return ctx.reply("❌ Card not found.");

    convState.setState(ctx.from.id, "nuvion_card_topup_amt", { accountType, cardId: card.card_id }, accountType);
    return ctx.reply(
      `➕ <b>Top Up ${escapeHtml(card.card_name || "Virtual Card")}</b>\n──────────────────────────\n` +
      `How much USD would you like to add to this card's spend limit? (e.g. <code>25</code>)`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `nuvion_card_cancel_${ctx.match[1]}`)]]),
      }
    );
  });

  bot.action(/^nuvion_card_unload_(per|biz)_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const accountType = fromFlag(ctx.match[1]);
    const p = ctx.match[1];
    const entity = db.getNuvionEntityByUser(ctx.from.id, accountType);
    const card = entity ? db.getNuvionCardsByEntity(entity.entity_id).find((c) => Number(c.id) === Number(ctx.match[2])) : null;
    if (!card) return ctx.reply("❌ Card not found.");

    await ctx.reply("⏳ Sweeping remaining card funds back to your main Proxim balance...");
    try {
      const res = await cardsLib.unloadCardToMainWallet({
        telegramId: ctx.from.id,
        accountType,
        cardId: card.card_id,
        bot,
      });
      if (!res.unloaded) {
        return ctx.reply(`ℹ️ This card currently has $${Number(res.availableUsd || 0).toFixed(2)} available to unload.`, {
          ...Markup.inlineKeyboard([[Markup.button.callback("« Back to Card", `nuvion_card_view_${p}_${card.id}`)]]),
        });
      }
      return ctx.reply(
        `✅ <b>Card Unloaded to Main Balance!</b>\n──────────────────────────\n` +
        `• <b>Returned:</b> $${res.unloadedUsd.toFixed(2)}\n` +
        `• <b>Card:</b> ${escapeHtml(card.card_name || "USD Card")}\n` +
        `<i>Funds are settling straight back into your main Proxim balance!</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("💳 Open Cards", `nuvion_cards_menu_${p}`)]]),
        }
      );
    } catch (err) {
      return ctx.reply(`❌ ${escapeHtml(nuvion.formatUserFriendlyError(err))}`, { parse_mode: "HTML" });
    }
  });

  bot.action(/^nuvion_card_(freeze|unfreeze)_(per|biz)_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const freeze = ctx.match[1] === "freeze";
    const accountType = fromFlag(ctx.match[2]);
    const p = ctx.match[2];
    const entity = db.getNuvionEntityByUser(ctx.from.id, accountType);
    const card = entity ? db.getNuvionCardsByEntity(entity.entity_id).find((c) => Number(c.id) === Number(ctx.match[3])) : null;
    if (!card) return ctx.reply("❌ Card not found.");

    try {
      await cardsLib.setCardFrozen({ telegramId: ctx.from.id, accountType, cardId: card.card_id, freeze });
      await ctx.reply(freeze ? `❄️ <b>${escapeHtml(card.card_name)}</b> is now frozen.` : `🔥 <b>${escapeHtml(card.card_name)}</b> is active again!`, {
        parse_mode: "HTML",
      });
      return showCardControlPanel(ctx, accountType, card.id);
    } catch (err) {
      return ctx.reply(`❌ ${escapeHtml(nuvion.formatUserFriendlyError(err))}`, { parse_mode: "HTML" });
    }
  });

  bot.action(/^nuvion_card_txs_(per|biz)_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const accountType = fromFlag(ctx.match[1]);
    const p = ctx.match[1];
    const entity = db.getNuvionEntityByUser(ctx.from.id, accountType);
    const card = entity ? db.getNuvionCardsByEntity(entity.entity_id).find((c) => Number(c.id) === Number(ctx.match[2])) : null;
    if (!card) return ctx.reply("❌ Card not found.");

    try {
      const txs = await cardsLib.fetchCardTransactions({ telegramId: ctx.from.id, accountType, cardId: card.card_id, limit: 10 });
      if (!txs.length) {
        return ctx.reply(`📋 No transactions yet on <b>${escapeHtml(card.card_name || "this card")}</b>.`, {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("« Back to Card", `nuvion_card_view_${p}_${card.id}`)]]),
        });
      }
      const lines = [
        `📋 <b>Recent Activity — ${escapeHtml(card.card_name || "USD Card")}</b>`,
        `──────────────────────────`,
      ];
      for (const tx of txs.slice(0, 10)) {
        const amt = nuvion.fromNuvionMinor(tx.amount || 0).toFixed(2);
        const isRev = tx.payment_type === "card-debit-reversal" || tx.type === "inflow";
        const sign = isRev ? "+" : "-";
        const merchant = tx.recipient?.name || tx.narration || "Card Charge";
        lines.push(`${isRev ? "🔄" : "💳"} <b>${sign}$${amt}</b> · ${escapeHtml(merchant)} <i>(${escapeHtml(tx.status || "")})</i>`);
      }
      return ctx.reply(lines.join("\n"), {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("« Back to Card", `nuvion_card_view_${p}_${card.id}`)]]),
      });
    } catch (err) {
      return ctx.reply(`❌ ${escapeHtml(nuvion.formatUserFriendlyError(err))}`, { parse_mode: "HTML" });
    }
  });

  bot.action(/^nuvion_card_del_ask_(per|biz)_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const p = ctx.match[1];
    const rowId = ctx.match[2];
    return ctx.reply(
      `⚠️ <b>Permanently Delete This Card?</b>\n──────────────────────────\n` +
      `Deleting a card cannot be undone. Any remaining balance on the card will automatically sweep back to your main Proxim balance.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🗑️ Yes, Delete & Sweep Balance", `nuvion_card_del_confirm_${p}_${rowId}`)],
          [Markup.button.callback("« Cancel", `nuvion_card_view_${p}_${rowId}`)],
        ]),
      }
    );
  });

  bot.action(/^nuvion_card_del_confirm_(per|biz)_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const accountType = fromFlag(ctx.match[1]);
    const p = ctx.match[1];
    const entity = db.getNuvionEntityByUser(ctx.from.id, accountType);
    const card = entity ? db.getNuvionCardsByEntity(entity.entity_id).find((c) => Number(c.id) === Number(ctx.match[2])) : null;
    if (!card) return ctx.reply("❌ Card not found.");

    try {
      const res = await cardsLib.deleteCardAndUnload({
        telegramId: ctx.from.id,
        accountType,
        cardId: card.card_id,
        bot,
      });
      const sweepLine = res.unloadedUsd > 0 ? `\n↩️ <b>Swept to Main Balance:</b> $${res.unloadedUsd.toFixed(2)}` : "";
      return ctx.reply(
        `🗑️ <b>Card Deleted</b>\n──────────────────────────\n` +
        `<b>${escapeHtml(card.card_name || "Card")}</b> has been permanently deactivated.${sweepLine}`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("💳 Open Cards", `nuvion_cards_menu_${p}`)]]),
        }
      );
    } catch (err) {
      return ctx.reply(`❌ ${escapeHtml(nuvion.formatUserFriendlyError(err))}`, { parse_mode: "HTML" });
    }
  });

  bot.action(/^nuvion_card_cancel_(per|biz)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    convState.clearState(ctx.from.id);
    return ctx.reply("Cancelled.", deps.backToMenu || {});
  });
}

module.exports = {
  CARD_REVEAL_TTL_MS,
  registerCardsFlows,
  showCardsMenu,
  showCardControlPanel,
  handlesState,
  handleCardsTextState,
};
