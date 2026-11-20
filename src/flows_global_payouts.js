// src/flows_global_payouts.js
// Telegram UI Flows for Nuvion Phase 3:
// - Global Payouts across ALL 27 Nuvion Fiat Currencies & ALL 24+ Local + SWIFT Rails
// - Saved Recipients (1-tap repeat payouts)
// - Live FX Quote Preview (1% FX margin baked cleanly into displayed exchange rate)
// - PIN-verified execution (auto-deletes PIN message)
// - Business Multi-Currency Global CSV Payroll (upload CSV or paste CSV -> live batch quote -> PIN confirm)

const { Markup } = require("telegraf");
const nuvion = require("./nuvion");
const corridors = require("./nuvion_corridors");
const payouts = require("./nuvion_payouts");
const db = require("./db");
const convState = require("./conversation_state");

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
  return typeof stateType === "string" && stateType.startsWith("nuvion_payout_");
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

/**
 * Entry menu for Global Payouts: choose Region (all 27 currencies), Saved Recipients, or Business Global Payroll.
 */
async function showGlobalPayoutsMenu(ctx, accountType = "personal") {
  const user = deps.requireUser ? deps.requireUser(ctx) : db.getUser(ctx.from.id);
  if (!user) return;
  if (!nuvion.isUserAllowedNuvion(ctx.from.id)) {
    return ctx.reply("🌍 International Bank & Mobile Money Transfers are currently in private beta.", deps.backToMenu || {});
  }

  const entity = db.getNuvionEntityByUser(ctx.from.id, accountType);
  if (!entity || String(entity.status).toLowerCase() !== "approved") {
    return ctx.reply(
      `🔒 <b>Tier-1 Verification Required</b>\n──────────────────────────\n` +
      `Complete your ${accountType === "business" ? "Business KYB" : "Personal KYC"} verification to send money to 27 currencies worldwide.`,
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
  const savedCount = db
    .getNuvionCounterpartiesByEntity(entity.entity_id)
    .filter((c) => {
      try {
        const s = c.summary_json ? JSON.parse(c.summary_json) : {};
        return !s.isSelf && !s.isPlatformMargin && c.currency !== "USC";
      } catch (_) {
        return c.currency !== "USC";
      }
    }).length;

  const rows = [
    [
      Markup.button.callback("🌍 Africa (NG · GH · KE · TZ · UG · ZA)", `nuvion_po_reg_${p}_africa`),
    ],
    [
      Markup.button.callback("🌎 Americas (US · CA · MX · BR)", `nuvion_po_reg_${p}_americas`),
    ],
    [
      Markup.button.callback("🇪🇺 UK & Europe (GB · EU · CH · SE · NO · DK)", `nuvion_po_reg_${p}_europe`),
    ],
    [
      Markup.button.callback("🌏 Asia-Pacific & ME (CN · AE · AU · SG · PH · HK · JP+)", `nuvion_po_reg_${p}_apac_me`),
    ],
  ];

  if (savedCount > 0) {
    rows.push([Markup.button.callback(`👥 Saved Recipients (${savedCount})`, `nuvion_po_saved_${p}`)]);
  }
  if (accountType === "business") {
    rows.push([Markup.button.callback("📄 Multi-Currency CSV Payroll", `nuvion_po_csv_start_${p}`)]);
  }
  rows.push([Markup.button.callback("« Back to Send Menu", "action_send_menu")]);

  return ctx.reply(
    `🌍 <b>Send Abroad — ${accountType === "business" ? "Business" : "Personal"}</b>\n` +
    `──────────────────────────\n` +
    `Send directly to bank accounts and mobile money wallets across <b>27 currencies</b> worldwide.\n\n` +
    `Choose a destination region below:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(rows),
    }
  );
}

/**
 * Show all supported currencies within a region (3 buttons per row).
 */
async function showRegionCurrencies(ctx, accountType, regionKey) {
  const region = corridors.REGIONS[regionKey];
  if (!region) return showGlobalPayoutsMenu(ctx, accountType);
  const p = pFlag(accountType);

  const buttons = [];
  for (let i = 0; i < region.currencies.length; i += 3) {
    const slice = region.currencies.slice(i, i + 3);
    buttons.push(
      slice.map((code) => {
        const info = corridors.CURRENCY_INFO[code];
        return Markup.button.callback(`${info.flag} ${code}`, `nuvion_po_cur_${p}_${code}`);
      })
    );
  }
  buttons.push([Markup.button.callback("« All Regions", `nuvion_po_menu_${p}`)]);

  return ctx.reply(
    `${region.label} — <b>Choose Destination Currency</b>\n` +
    `──────────────────────────\n` +
    `Select the currency your recipient should receive:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(buttons),
    }
  );
}

/**
 * Show all payout rail options for a selected currency (local rails + SWIFT fallback).
 */
async function showCurrencyRails(ctx, accountType, currency) {
  const code = String(currency || "").toUpperCase();
  const info = corridors.CURRENCY_INFO[code];
  const rails = corridors.getRailsForCurrency(code);
  if (!info || rails.length === 0) {
    return ctx.reply(`❌ Currency ${escapeHtml(code)} is not supported.`, { parse_mode: "HTML" });
  }
  const p = pFlag(accountType);

  const buttons = rails.map((r) => [
    Markup.button.callback(
      `${r.label} · ${r.settlement}`,
      `nuvion_po_rail_${p}_${code}_${r.key}`
    ),
  ]);
  buttons.push([Markup.button.callback("« Back", `nuvion_po_reg_${p}_${info.region}`)]);

  return ctx.reply(
    `${info.flag} <b>Send ${escapeHtml(info.name)} (${code})</b>\n` +
    `──────────────────────────\n` +
    `Choose the payout delivery method:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(buttons),
    }
  );
}

/**
 * Show saved external recipients for 1-tap repeat payouts.
 */
async function showSavedRecipients(ctx, accountType) {
  const entity = db.getNuvionEntityByUser(ctx.from.id, accountType);
  if (!entity) return showGlobalPayoutsMenu(ctx, accountType);
  const p = pFlag(accountType);

  const saved = db
    .getNuvionCounterpartiesByEntity(entity.entity_id)
    .filter((c) => {
      try {
        const s = c.summary_json ? JSON.parse(c.summary_json) : {};
        return !s.isSelf && !s.isPlatformMargin && c.currency !== "USC";
      } catch (_) {
        return c.currency !== "USC";
      }
    })
    .slice(0, 15);

  if (saved.length === 0) {
    return ctx.reply("You have no saved international recipients yet.", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🌍 Send to New Recipient", `nuvion_po_menu_${p}`)]]),
    });
  }

  const buttons = saved.map((c) => [
    Markup.button.callback(`👤 ${c.label}`, `nuvion_po_use_${p}_${c.id}`),
  ]);
  buttons.push([Markup.button.callback("« Back to Regions", `nuvion_po_menu_${p}`)]);

  return ctx.reply(
    `👥 <b>Saved International Recipients</b>\n` +
    `──────────────────────────\n` +
    `Tap a recipient to send again immediately:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(buttons),
    }
  );
}

/**
 * Show live quote preview & ask for PIN confirmation.
 */
async function presentPayoutQuoteAndAskPin(ctx, userId, draft) {
  await ctx.reply(`⏳ Fetching live ${draft.currency} exchange rate...`);
  try {
    const q = await payouts.quoteGlobalPayout({
      telegramId: userId,
      accountType: draft.accountType,
      railKey: draft.railKey,
      targetCurrency: draft.currency,
      targetAmountMajor: draft.amountMajor,
    });

    const p = pFlag(draft.accountType);
    const destDisplay = corridors.formatCurrencyMajor(draft.currency, draft.amountMajor);
    const recipientName = draft.savedCounterparty
      ? (draft.savedCounterparty.account_holder_name || draft.savedCounterparty.label)
      : draft.recipientDetails.account_holder_name;

    convState.setState(
      userId,
      "nuvion_payout_confirm_pin",
      {
        ...draft,
        quoteSummary: {
          userTotalUsd: q.userTotalUsd,
          effectiveRate: q.effectiveRate,
          railLabel: q.rail.label,
          recipientName,
        },
      },
      draft.accountType
    );

    const rateLine = draft.currency === "USD"
      ? ""
      : `• <b>Exchange Rate:</b> 1 USD = ${q.effectiveRate.toFixed(4)} ${draft.currency}\n`;

    return ctx.reply(
      `📋 <b>Confirm International Transfer</b>\n` +
      `──────────────────────────\n` +
      `• <b>Recipient:</b> ${escapeHtml(recipientName)}\n` +
      `• <b>Method:</b> ${escapeHtml(q.rail.label)} (${escapeHtml(q.rail.settlement)})\n` +
      `• <b>Recipient Gets:</b> <b>${destDisplay}</b>\n` +
      rateLine +
      `• <b>Total From Your Balance:</b> <b>$${q.userTotalUsd.toFixed(2)}</b>\n` +
      (draft.narration ? `• <b>Note:</b> <i>${escapeHtml(draft.narration)}</i>\n` : "") +
      `──────────────────────────\n` +
      `🔐 <b>Enter your 4-digit PIN</b> to send now (your PIN message will be auto-deleted):`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("❌ Cancel", `nuvion_po_cancel_${p}`)],
        ]),
      }
    );
  } catch (err) {
    convState.clearState(userId);
    return ctx.reply(
      `❌ ${escapeHtml(nuvion.formatUserFriendlyError(err))}`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("« Try Again", `nuvion_po_menu_${pFlag(draft.accountType)}`)]]),
      }
    );
  }
}

/**
 * Handle Business Global CSV Payroll document upload or pasted CSV text.
 */
async function handleGlobalPayrollCsv(ctx, csvText, userId, accountType = "business") {
  await ctx.reply("⏳ Validating CSV rows and fetching live exchange rates across currencies...");
  try {
    const plan = await payouts.parseAndQuoteGlobalPayroll({
      telegramId: userId,
      csvText,
      accountType,
    });

    const p = pFlag(accountType);
    const previewLines = plan.rows.slice(0, 12).map((r, idx) => {
      const dest = corridors.formatCurrencyMajor(r.currency, r.amount);
      return `${idx + 1}. <b>${escapeHtml(r.name)}</b> — ${dest} (<i>$${r.quote.userTotalUsd.toFixed(2)}</i>)`;
    });
    if (plan.rows.length > 12) {
      previewLines.push(`<i>...and ${plan.rows.length - 12} more recipients</i>`);
    }

    const warnBlock = plan.parseErrors.length > 0
      ? `\n⚠️ <b>Skipped Rows (${plan.parseErrors.length}):</b>\n${plan.parseErrors.slice(0, 3).map(escapeHtml).join("\n")}\n`
      : "";

    convState.setState(
      userId,
      "nuvion_payout_csv_confirm_pin",
      { accountType, payrollPlan: plan },
      accountType
    );

    return ctx.reply(
      `👥 <b>Global Multi-Currency Payroll Preview</b>\n` +
      `──────────────────────────\n` +
      `${previewLines.join("\n")}\n` +
      warnBlock +
      `──────────────────────────\n` +
      `• <b>Total Recipients:</b> ${plan.rows.length}\n` +
      `• <b>Total From Business Balance:</b> <b>$${plan.totalUserUsd.toFixed(2)}</b>\n` +
      `• <b>Batch ID:</b> <code>${plan.batchId}</code>\n\n` +
      `🔐 <b>Enter your 4-digit PIN</b> to execute global payroll:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `nuvion_po_cancel_${p}`)]]),
      }
    );
  } catch (err) {
    convState.clearState(userId);
    return ctx.reply(`❌ Could not parse payroll CSV: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
  }
}

/**
 * Handle text states for Global Payouts & Business CSV Payroll.
 */
async function handleGlobalPayoutsTextState(ctx, state, text, userId) {
  if (!state || !handlesState(state.type)) return false;

  const val = String(text || "").trim();
  const d = state.data || {};
  const accountType = d.accountType || "personal";
  const p = pFlag(accountType);

  // ── Step 1: Capture recipient routing details ──────────────────────────────
  if (state.type === "nuvion_payout_recipient") {
    const rail = corridors.getRailByKey(d.railKey, d.currency);
    if (!rail) {
      convState.clearState(userId);
      await ctx.reply("Session expired. Please start again.");
      return true;
    }

    const parsed = corridors.parseRecipientInputForRail(rail, val);
    if (!parsed.ok) {
      await ctx.reply(
        `⚠️ ${escapeHtml(parsed.error)}\n\n` +
        `<b>Format:</b> ${escapeHtml(rail.promptHint)}\n` +
        `<b>Example:</b> <code>${escapeHtml(rail.example)}</code>`,
        { parse_mode: "HTML" }
      );
      return true;
    }

    convState.setState(
      userId,
      "nuvion_payout_amount",
      {
        accountType,
        currency: d.currency,
        railKey: d.railKey,
        recipientDetails: parsed.details,
      },
      accountType
    );

    const limitNote = (rail.minAmount || rail.maxAmount)
      ? `\n<i>Limits: ${rail.minAmount ? `Min ${rail.minAmount.toLocaleString("en-US")}` : ""}${rail.minAmount && rail.maxAmount ? " · " : ""}${rail.maxAmount ? `Max ${rail.maxAmount.toLocaleString("en-US")}` : ""} ${d.currency}</i>`
      : "";

    await ctx.reply(
      `💵 <b>Enter Amount to Send (${d.currency})</b>\n` +
      `──────────────────────────\n` +
      `Recipient: <b>${escapeHtml(parsed.details.account_holder_name)}</b>\n\n` +
      `Enter the exact amount in <b>${d.currency}</b> (optionally add a comma + note, e.g. <code>500, Invoice 42</code>):${limitNote}`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  // ── Step 2: Capture amount (+ optional narration) ─────────────────────────
  if (state.type === "nuvion_payout_amount") {
    const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
    const amountMajor = parseFloat((parts[0] || "").replace(/[^0-9.]/g, ""));
    const narration = parts.slice(1).join(", ") || null;

    const check = corridors.validateCorridorAmount(d.railKey, amountMajor, d.currency);
    if (!check.valid) {
      await ctx.reply(`⚠️ ${escapeHtml(check.error)}\nEnter a valid <b>${d.currency}</b> amount:`, { parse_mode: "HTML" });
      return true;
    }

    await presentPayoutQuoteAndAskPin(ctx, userId, {
      ...d,
      amountMajor,
      narration,
    });
    return true;
  }

  // ── Step 3: Verify PIN and initiate pass-through payout ───────────────────
  if (state.type === "nuvion_payout_confirm_pin") {
    await deleteSensitiveMessage(ctx);
    const pin = val.replace(/\s+/g, "");
    if (!/^\d{4,8}$/.test(pin)) {
      await ctx.reply("🔐 Please enter your numeric PIN (or tap Cancel).");
      return true;
    }

    convState.clearState(userId);
    await ctx.reply("⏳ Verifying PIN and dispatching your international transfer...");

    try {
      const res = await payouts.initiateGlobalPayout({
        telegramId: userId,
        pin,
        accountType,
        railKey: d.railKey,
        targetCurrency: d.currency,
        targetAmountMajor: d.amountMajor,
        recipientDetails: d.recipientDetails || null,
        savedCounterparty: d.savedCounterparty || null,
        narration: d.narration || null,
        bot: deps.bot || null,
      });

      const destStr = corridors.formatCurrencyMajor(d.currency, d.amountMajor);
      await ctx.reply(
        `🚀 <b>Transfer Initiated!</b>\n` +
        `──────────────────────────\n` +
        `• <b>Recipient:</b> ${escapeHtml(res.job.payload?.recipientName || "Recipient")}\n` +
        `• <b>Amount:</b> ${destStr}\n` +
        `• <b>Paid:</b> $${res.quote.userTotalUsd.toFixed(2)}\n` +
        `• <b>Reference:</b> <code>${escapeHtml(res.uniqueReference)}</code>\n\n` +
        `<i>Your transfer is being delivered now. We'll send your receipt as soon as the recipient bank confirms settlement (and automatically refund your balance if the bank rejects it).</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🌍 Send Another Transfer", `nuvion_po_menu_${p}`)],
            [Markup.button.callback("🏠 Main Menu", "main_menu")],
          ]),
        }
      );
    } catch (err) {
      await ctx.reply(
        `❌ <b>Transfer Not Sent</b>\n──────────────────────────\n${escapeHtml(nuvion.formatUserFriendlyError(err))}`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("« Back to Send Abroad", `nuvion_po_menu_${p}`)]]),
        }
      );
    }
    return true;
  }

  // ── Business CSV Payroll: pasted CSV text ─────────────────────────────────
  if (state.type === "nuvion_payout_csv_upload") {
    await handleGlobalPayrollCsv(ctx, val, userId, accountType);
    return true;
  }

  // ── Business CSV Payroll: PIN confirmation ────────────────────────────────
  if (state.type === "nuvion_payout_csv_confirm_pin") {
    await deleteSensitiveMessage(ctx);
    const pin = val.replace(/\s+/g, "");
    if (!/^\d{4,8}$/.test(pin)) {
      await ctx.reply("🔐 Please enter your numeric PIN (or tap Cancel).");
      return true;
    }

    convState.clearState(userId);
    await ctx.reply("⏳ Verifying PIN and dispatching your global payroll batch...");

    try {
      const res = await payouts.executeGlobalPayrollBatch({
        telegramId: userId,
        pin,
        payrollPlan: d.payrollPlan,
        accountType,
        bot: deps.bot || null,
      });

      await ctx.reply(
        `🎉 <b>Global Payroll Batch Dispatched!</b>\n` +
        `──────────────────────────\n` +
        `• <b>Batch ID:</b> <code>${escapeHtml(res.batchId)}</code>\n` +
        `• <b>Queued Payouts:</b> ${res.queuedCount}\n` +
        (res.skippedCount > 0 ? `• <b>Duplicate Rows Skipped:</b> ${res.skippedCount}\n` : "") +
        `• <b>Total Funded:</b> $${Number(res.totalUserUsd || 0).toFixed(2)}\n\n` +
        `<i>Individual delivery receipts will arrive here as each employee's bank settles.</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "main_menu")]]),
        }
      );
    } catch (err) {
      await ctx.reply(
        `❌ <b>Payroll Failed</b>\n──────────────────────────\n${escapeHtml(nuvion.formatUserFriendlyError(err))}`,
        { parse_mode: "HTML" }
      );
    }
    return true;
  }

  return false;
}

/**
 * Handle uploaded CSV file when user is in `nuvion_payout_csv_upload` state.
 */
async function handleGlobalPayrollDocument(ctx, state, userId) {
  if (!state || state.type !== "nuvion_payout_csv_upload") return false;
  const doc = ctx.message?.document;
  if (!doc) return false;

  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const resp = await fetch(link.href || String(link));
    if (!resp.ok) throw new Error("Could not download uploaded CSV file.");
    const csvText = await resp.text();
    await handleGlobalPayrollCsv(ctx, csvText, userId, state.data?.accountType || "business");
  } catch (err) {
    await ctx.reply(`❌ Failed to read uploaded CSV: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
  }
  return true;
}

function registerGlobalPayoutsFlows(bot, depsIn = {}) {
  deps = { bot, ...depsIn };

  bot.action(/^nuvion_po_menu_(per|biz)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    return showGlobalPayoutsMenu(ctx, fromFlag(ctx.match[1]));
  });

  bot.action(/^nuvion_po_reg_(per|biz)_([a-z_]+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    return showRegionCurrencies(ctx, fromFlag(ctx.match[1]), ctx.match[2]);
  });

  bot.action(/^nuvion_po_cur_(per|biz)_([A-Z]{3})$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    return showCurrencyRails(ctx, fromFlag(ctx.match[1]), ctx.match[2]);
  });

  bot.action(/^nuvion_po_rail_(per|biz)_([A-Z]{3})_([a-z0-9_]+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const accountType = fromFlag(ctx.match[1]);
    const currency = ctx.match[2];
    const railKey = ctx.match[3];
    const rail = corridors.getRailByKey(railKey, currency);
    if (!rail) return ctx.reply("❌ Payout rail not found.");

    convState.setState(
      ctx.from.id,
      "nuvion_payout_recipient",
      { accountType, currency, railKey },
      accountType
    );

    return ctx.reply(
      `🏦 <b>${escapeHtml(rail.label)}</b>\n` +
      `──────────────────────────\n` +
      `Enter recipient details separated by commas:\n` +
      `<b>Fields:</b> ${escapeHtml(rail.promptHint)}\n\n` +
      `<b>Example:</b>\n<code>${escapeHtml(rail.example)}</code>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("❌ Cancel", `nuvion_po_cancel_${ctx.match[1]}`)],
        ]),
      }
    );
  });

  bot.action(/^nuvion_po_saved_(per|biz)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    return showSavedRecipients(ctx, fromFlag(ctx.match[1]));
  });

  bot.action(/^nuvion_po_use_(per|biz)_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const accountType = fromFlag(ctx.match[1]);
    const rowId = Number(ctx.match[2]);
    const entity = db.getNuvionEntityByUser(ctx.from.id, accountType);
    if (!entity) return showGlobalPayoutsMenu(ctx, accountType);

    const cp = db.getNuvionCounterpartiesByEntity(entity.entity_id).find((c) => Number(c.id) === rowId);
    if (!cp) return ctx.reply("❌ Saved recipient not found.");

    let summary = {};
    try { summary = cp.summary_json ? JSON.parse(cp.summary_json) : {}; } catch (_) {}
    const railKey = summary.railKey || corridors.getRailsForCurrency(cp.currency)[0]?.key || "swift_acct";

    convState.setState(
      ctx.from.id,
      "nuvion_payout_amount",
      {
        accountType,
        currency: cp.currency,
        railKey,
        savedCounterparty: cp,
      },
      accountType
    );

    return ctx.reply(
      `👤 <b>Send to ${escapeHtml(cp.account_holder_name || cp.label)}</b>\n` +
      `──────────────────────────\n` +
      `Enter the amount in <b>${cp.currency}</b> (optionally add a comma + note, e.g. <code>250, Monthly retainer</code>):`,
      { parse_mode: "HTML" }
    );
  });

  bot.action(/^nuvion_po_csv_start_(per|biz)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const accountType = fromFlag(ctx.match[1]);
    convState.setState(ctx.from.id, "nuvion_payout_csv_upload", { accountType }, accountType);

    return ctx.reply(
      `📄 <b>Business Multi-Currency Global Payroll</b>\n` +
      `──────────────────────────\n` +
      `Upload a <b>.csv</b> file (or paste CSV rows here) paying staff across any of 27 currencies in one batch!\n\n` +
      `<b>Example CSV:</b>\n` +
      `<code>name,currency,rail,amount,country,account_number,sort_code,bank_code,swift_bic,phone_number,scheme,bank_name\n` +
      `Jane Smith,GBP,gbp_fps,500,GB,12345678,040004,,,,Barclays\n` +
      `John Otieno,KES,kes_momo,25000,KE,,,,,+254712345678,mpesa,M-Pesa\n` +
      `Zhang Wei,CNY,cny_wire,3500,CN,6230810325651744,,,SYCBCNBYXXX,,,SHENGJING BANK</code>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `nuvion_po_cancel_${ctx.match[1]}`)]]),
      }
    );
  });

  bot.action(/^nuvion_po_cancel_(per|biz)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    convState.clearState(ctx.from.id);
    return ctx.reply("Cancelled.", deps.backToMenu || {});
  });
}

module.exports = {
  registerGlobalPayoutsFlows,
  showGlobalPayoutsMenu,
  showRegionCurrencies,
  showCurrencyRails,
  showSavedRecipients,
  handlesState,
  handleGlobalPayoutsTextState,
  handleGlobalPayrollDocument,
};
