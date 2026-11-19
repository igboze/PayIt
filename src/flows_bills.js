// src/flows_bills.js
// Telegram UI & Conversation Flows for Airbills Utility Payments
// Supports all 6 Airbills products:
//   - Airtime (100)
//   - Electricity (101)
//   - Internet Data (102)
//   - Betting (103)
//   - Cable TV (104)
//   - Transport (105)

const { Markup } = require("telegraf");
const db = require("./db");
const convState = require("./conversation_state");
const airbills = require("./airbills");

const PAGE_SIZE = 8;

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function registerBillsFlows(bot, helpers) {
  const {
    requireUser,
    getContext,
    getActiveWallet,
    safeGetBalance,
    deleteSensitiveMessage,
    btnPrimary,
    btnSuccess,
    btnDefault,
    backToMenu,
    afterPaymentButtons,
  } = helpers;

  // ── Bills Main Menu ────────────────────────────────────────────────────────

  async function showBillsMenu(ctx) {
    const user = requireUser(ctx);
    if (!user) return;
    convState.clearState(ctx.from.id);
    const context = user.active_context || getContext(ctx.from.id);
    const addr = getActiveWallet(user);
    let balDisplay = "$0.00";
    try {
      const bal = await safeGetBalance(addr);
      balDisplay = bal.display;
    } catch (_) {}

    const keyboard = Markup.inlineKeyboard([
      [
        btnPrimary("📱 Airtime",       "bill_start_airtime"),
        btnPrimary("📶 Internet Data", "bill_start_data"),
      ],
      [
        btnPrimary("⚡ Electricity",   "bill_start_electricity"),
        btnPrimary("📺 Cable TV",      "bill_start_cable"),
      ],
      [
        btnPrimary("🎰 Betting",       "bill_start_betting"),
        btnPrimary("🚌 Transport",     "bill_start_transport"),
      ],
      [btnDefault("📋 My Bill History", "bill_history")],
      [btnDefault("🏠 Main Menu",       "main_menu")],
    ]);

    const msg =
      `💡 <b>Pay Nigerian Bills with Dollars</b>\n` +
      `──────────────────────────\n` +
      `Available Balance: <b>${balDisplay}</b>\n\n` +
      `Pay everyday Nigerian bills straight from your Proxim wallet — no Naira bank account needed:\n\n` +
      `📱 <b>Airtime</b> · 📶 <b>Data</b> · ⚡ <b>Electricity</b>\n` +
      `📺 <b>Cable TV</b> · 🎰 <b>Betting</b> · 🚌 <b>Transport</b>\n\n` +
      `Choose a bill category below:`;

    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(msg, { parse_mode: "HTML", ...keyboard });
        return;
      } catch (_) {}
    }
    return ctx.reply(msg, { parse_mode: "HTML", ...keyboard });
  }

  bot.action("action_bills_menu", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    return showBillsMenu(ctx);
  });

  bot.command("bills", async (ctx) => showBillsMenu(ctx));

  // ── Bill History ───────────────────────────────────────────────────────────

  bot.action("bill_history", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const user = requireUser(ctx);
    if (!user) return;
    const rows = db.getUserBillPayments(ctx.from.id, 8);
    if (!rows.length) {
      return ctx.reply(
        `📋 <b>Bill History</b>\n──────────────────────────\nNo bills paid yet. Tap below to pay your first bill!`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[btnSuccess("💡 Pay a Bill", "action_bills_menu")]]),
        }
      );
    }

    const lines = rows.map(r => {
      const icon = r.status === "successful" ? "✅" : r.status === "failed" ? "❌" : "⏳";
      const tokenLine = r.meter_token ? `\n   🔑 Token: <code>${escapeHtml(r.meter_token)}</code>` : "";
      return (
        `${icon} <b>${escapeHtml(r.provider_name || r.category)}</b> — ₦${Number(r.amount_ngn).toLocaleString()} ($${Number(r.amount_usdc).toFixed(2)})\n` +
        `   To: <code>${escapeHtml(r.recipient)}</code> · ${r.status}${tokenLine}`
      );
    }).join("\n\n");

    return ctx.reply(
      `📋 <b>Recent Bills</b>\n──────────────────────────\n${lines}`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [btnSuccess("💡 Pay Another Bill", "action_bills_menu")],
          [btnDefault("🏠 Main Menu", "main_menu")],
        ]),
      }
    );
  });

  // ── Shared Confirmation Prompt ─────────────────────────────────────────────

  async function promptBillConfirmation(ctx, userId, context, summary) {
    const estUsdc = await airbills.estimateBillUsdc(summary.amountNgn);
    convState.setState(
      userId,
      "bill_confirm_pin",
      {
        ...summary,
        estimatedUsdc: estUsdc,
      },
      context
    );

    const extraLine = summary.customerName
      ? `• <b>Account Name:</b> ${escapeHtml(summary.customerName)}\n`
      : "";
    const descLine = summary.description
      ? `• <b>Plan:</b> ${escapeHtml(summary.description)}\n`
      : "";

    return ctx.reply(
      `${summary.emoji || "💡"} <b>Confirm ${escapeHtml(summary.label)} Payment</b>\n` +
      `──────────────────────────\n` +
      `• <b>Provider:</b> ${escapeHtml(summary.providerName)}\n` +
      descLine +
      `• <b>Recipient:</b> <code>${escapeHtml(summary.recipient)}</code>\n` +
      extraLine +
      `• <b>Amount:</b> <b>₦${Number(summary.amountNgn).toLocaleString()}</b> (~<b>$${estUsdc.toFixed(2)}</b>)\n\n` +
      `🔐 <i>Enter your 4-digit PIN to pay:</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_bills_menu")]]),
      }
    );
  }

  // ── 1. AIRTIME (Product 100) ───────────────────────────────────────────────

  bot.action("bill_start_airtime", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const user = requireUser(ctx);
    if (!user) return;
    convState.setState(ctx.from.id, "bill_airtime_phone", {}, getContext(ctx.from.id));
    return ctx.reply(
      `📱 <b>Buy Airtime</b>\n──────────────────────────\n` +
      `Enter the Nigerian phone number to top up:\n\n` +
      `💬 <i>Example: <b>08012345678</b></i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_bills_menu")]]),
      }
    );
  });

  bot.action(/^bill_airtime_net_(\d{2})$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;
    const state = convState.getState(userId);
    if (!state || !state.data?.phoneNumber) {
      return ctx.reply("Session expired. Start again.", Markup.inlineKeyboard([[btnPrimary("💡 Pay Bills", "action_bills_menu")]]));
    }
    const networkId = ctx.match[1];
    const networkName = airbills.getNetworkName(networkId);
    convState.setState(userId, "bill_airtime_amount", { ...state.data, networkId, networkName }, state.context);
    return ctx.reply(
      `📱 <b>${networkName} Airtime — ${state.data.phoneNumber}</b>\n──────────────────────────\n` +
      `How much airtime (in Naira ₦) would you like to buy?\n` +
      `<i>Range: ₦50 – ₦50,000</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("₦500",   "bill_airtime_amt_500"),
            Markup.button.callback("₦1,000", "bill_airtime_amt_1000"),
          ],
          [
            Markup.button.callback("₦2,000", "bill_airtime_amt_2000"),
            Markup.button.callback("₦5,000", "bill_airtime_amt_5000"),
          ],
          [Markup.button.callback("❌ Cancel", "action_bills_menu")],
        ]),
      }
    );
  });

  bot.action(/^bill_airtime_amt_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;
    const state = convState.getState(userId);
    if (!state || state.type !== "bill_airtime_amount") {
      return ctx.reply("Session expired.", Markup.inlineKeyboard([[btnPrimary("💡 Pay Bills", "action_bills_menu")]]));
    }
    const amountNgn = parseInt(ctx.match[1], 10);
    return promptBillConfirmation(ctx, userId, state.context, {
      productCode: airbills.PRODUCTS.AIRTIME.code,
      category: "airtime",
      label: "Airtime",
      emoji: "📱",
      providerName: state.data.networkName,
      recipient: state.data.phoneNumber,
      amountNgn,
      billData: {
        phoneNumber: state.data.phoneNumber,
        networkId: state.data.networkId,
      },
    });
  });

  // ── 2. INTERNET DATA (Product 102) ─────────────────────────────────────────

  bot.action("bill_start_data", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const user = requireUser(ctx);
    if (!user) return;
    convState.clearState(ctx.from.id);
    const buttons = airbills.NETWORKS.map(n => [
      Markup.button.callback(`${n.emoji} ${n.name} Data`, `bill_data_net_${n.id}_0`),
    ]);
    buttons.push([Markup.button.callback("❌ Cancel", "action_bills_menu")]);
    return ctx.reply(
      `📶 <b>Buy Internet Data</b>\n──────────────────────────\nChoose a network:`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) }
    );
  });

  bot.action(/^bill_data_net_(\d{2})_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const user = requireUser(ctx);
    if (!user) return;
    const networkId = ctx.match[1];
    const page = parseInt(ctx.match[2], 10) || 0;
    const networkName = airbills.getNetworkName(networkId);

    try {
      const plans = await airbills.listDataPlans(networkId);
      if (!plans.length) {
        return ctx.reply(`No data plans available for ${networkName} right now.`, Markup.inlineKeyboard([[btnDefault("« Back", "bill_start_data")]]));
      }
      const start = page * PAGE_SIZE;
      const slice = plans.slice(start, start + PAGE_SIZE);
      convState.setState(ctx.from.id, "bill_data_pick", { networkId, networkName, plans }, getContext(ctx.from.id));

      const rows = slice.map((p, idx) => [
        Markup.button.callback(
          `${p.description || p.prodId} — ₦${Number(p.prodAmount).toLocaleString()}`,
          `bill_data_plan_${start + idx}`
        ),
      ]);
      const nav = [];
      if (page > 0) nav.push(Markup.button.callback("⬅️ Prev", `bill_data_net_${networkId}_${page - 1}`));
      if (start + PAGE_SIZE < plans.length) nav.push(Markup.button.callback("Next ➡️", `bill_data_net_${networkId}_${page + 1}`));
      if (nav.length) rows.push(nav);
      rows.push([Markup.button.callback("« Networks", "bill_start_data")]);

      return ctx.reply(
        `📶 <b>${networkName} Data Bundles</b> (Page ${page + 1})\n──────────────────────────\nSelect a bundle:`,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) }
      );
    } catch (err) {
      return ctx.reply(`⚠️ Couldn't load ${networkName} data plans: ${err.message}`, Markup.inlineKeyboard([[btnDefault("« Back", "action_bills_menu")]]));
    }
  });

  bot.action(/^bill_data_plan_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;
    const state = convState.getState(userId);
    const idx = parseInt(ctx.match[1], 10);
    const plan = state?.data?.plans?.[idx];
    if (!state || !plan) {
      return ctx.reply("Session expired. Please select your data bundle again.", Markup.inlineKeyboard([[btnPrimary("📶 Data Bundles", "bill_start_data")]]));
    }
    convState.setState(userId, "bill_data_phone", {
      networkId: state.data.networkId,
      networkName: state.data.networkName,
      prodId: plan.prodId,
      amountNgn: Number(plan.prodAmount),
      description: plan.description || plan.prodId,
    }, state.context);
    return ctx.reply(
      `📶 <b>${escapeHtml(plan.description || plan.prodId)}</b> (₦${Number(plan.prodAmount).toLocaleString()})\n──────────────────────────\n` +
      `Enter the recipient phone number:\n💬 <i>Example: <b>08012345678</b></i>`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_bills_menu")]]) }
    );
  });

  // ── 3. ELECTRICITY (Product 101) ───────────────────────────────────────────

  async function renderElectricityPage(ctx, page = 0) {
    try {
      const discos = await airbills.listElectricityProviders();
      if (!discos.length) {
        return ctx.reply("No electricity providers available right now.", Markup.inlineKeyboard([[btnDefault("« Back", "action_bills_menu")]]));
      }
      const start = page * PAGE_SIZE;
      const slice = discos.slice(start, start + PAGE_SIZE);
      convState.setState(ctx.from.id, "bill_elect_pick", { discos }, getContext(ctx.from.id));
      const rows = slice.map((d, idx) => [
        Markup.button.callback(`⚡ ${d.name || d.electId}`, `bill_elect_disco_${start + idx}`),
      ]);
      const nav = [];
      if (page > 0) nav.push(Markup.button.callback("⬅️ Prev", `bill_elect_page_${page - 1}`));
      if (start + PAGE_SIZE < discos.length) nav.push(Markup.button.callback("Next ➡️", `bill_elect_page_${page + 1}`));
      if (nav.length) rows.push(nav);
      rows.push([Markup.button.callback("❌ Cancel", "action_bills_menu")]);
      return ctx.reply(
        `⚡ <b>Pay Electricity Bill</b> (Page ${page + 1})\n──────────────────────────\nChoose your electricity provider (DISCO):`,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) }
      );
    } catch (err) {
      return ctx.reply(`⚠️ Couldn't load electricity providers: ${err.message}`, Markup.inlineKeyboard([[btnDefault("« Back", "action_bills_menu")]]));
    }
  }

  bot.action("bill_start_electricity", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const user = requireUser(ctx);
    if (!user) return;
    return renderElectricityPage(ctx, 0);
  });

  bot.action(/^bill_elect_page_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const user = requireUser(ctx);
    if (!user) return;
    return renderElectricityPage(ctx, parseInt(ctx.match[1], 10) || 0);
  });

  bot.action(/^bill_elect_disco_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;
    const state = convState.getState(userId);
    const disco = state?.data?.discos?.[parseInt(ctx.match[1], 10)];
    if (!state || !disco) {
      return ctx.reply("Session expired.", Markup.inlineKeyboard([[btnPrimary("⚡ Electricity", "bill_start_electricity")]]));
    }
    if (disco.prodId) {
      convState.setState(userId, "bill_elect_meter", {
        electId: disco.electId,
        providerName: disco.name || disco.electId,
        prodId: disco.prodId,
      }, state.context);
      return ctx.reply(
        `⚡ <b>${escapeHtml(disco.name || disco.electId)}</b>\n──────────────────────────\n` +
        `Enter your <b>meter number</b>:\n<i>We'll verify your account name before you pay.</i>`,
        { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_bills_menu")]]) }
      );
    }
    convState.setState(userId, "bill_elect_type", {
      electId: disco.electId,
      providerName: disco.name || disco.electId,
    }, state.context);
    return ctx.reply(
      `⚡ <b>${escapeHtml(disco.name || disco.electId)}</b>\n──────────────────────────\nSelect your meter type:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            btnPrimary("🔋 Prepaid Meter",  "bill_elect_type_prepaid"),
            btnPrimary("📄 Postpaid Meter", "bill_elect_type_postpaid"),
          ],
          [Markup.button.callback("❌ Cancel", "action_bills_menu")],
        ]),
      }
    );
  });

  bot.action(/^bill_elect_type_(prepaid|postpaid)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;
    const state = convState.getState(userId);
    if (!state || !state.data?.electId) {
      return ctx.reply("Session expired.", Markup.inlineKeyboard([[btnPrimary("⚡ Electricity", "bill_start_electricity")]]));
    }
    const meterType = ctx.match[1];
    convState.setState(userId, "bill_elect_meter", { ...state.data, prodId: meterType }, state.context);
    return ctx.reply(
      `⚡ <b>${escapeHtml(state.data.providerName)} (${meterType})</b>\n──────────────────────────\n` +
      `Enter your <b>meter number</b>:\n<i>We'll verify your account name before you pay.</i>`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_bills_menu")]]) }
    );
  });

  bot.action(/^bill_elect_amt_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;
    const state = convState.getState(userId);
    if (!state || state.type !== "bill_elect_amount") {
      return ctx.reply("Session expired.", Markup.inlineKeyboard([[btnPrimary("⚡ Electricity", "bill_start_electricity")]]));
    }
    const amountNgn = parseInt(ctx.match[1], 10);
    convState.setState(userId, "bill_elect_phone", { ...state.data, amountNgn }, state.context);
    return ctx.reply(
      `⚡ <b>₦${amountNgn.toLocaleString()} Electricity</b>\n──────────────────────────\n` +
      `Enter your Nigerian phone number (for receipt/SMS delivery):\n💬 <i>Example: <b>08012345678</b></i>`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_bills_menu")]]) }
    );
  });

  // ── 4. CABLE TV (Product 104) ──────────────────────────────────────────────

  bot.action("bill_start_cable", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const user = requireUser(ctx);
    if (!user) return;
    return ctx.reply(
      `📺 <b>Pay Cable TV</b>\n──────────────────────────\nChoose your Cable TV provider:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            btnPrimary("📺 DStv",      "bill_cable_prov_dstv_0"),
            btnPrimary("📺 GOtv",      "bill_cable_prov_gotv_0"),
          ],
          [
            btnPrimary("📺 Startimes", "bill_cable_prov_startimes_0"),
            btnDefault("📋 All Plans", "bill_cable_prov_all_0"),
          ],
          [Markup.button.callback("❌ Cancel", "action_bills_menu")],
        ]),
      }
    );
  });

  bot.action(/^bill_cable_prov_([a-z]+)_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const user = requireUser(ctx);
    if (!user) return;
    const providerKey = ctx.match[1];
    const page = parseInt(ctx.match[2], 10) || 0;
    try {
      const pkgs = await airbills.listCablePackages(providerKey === "all" ? null : providerKey);
      if (!pkgs.length) {
        return ctx.reply("No Cable TV packages found for that provider.", Markup.inlineKeyboard([[btnDefault("« Back", "bill_start_cable")]]));
      }
      const start = page * PAGE_SIZE;
      const slice = pkgs.slice(start, start + PAGE_SIZE);
      convState.setState(ctx.from.id, "bill_cable_pick", { providerKey, pkgs }, getContext(ctx.from.id));

      const rows = slice.map((p, idx) => [
        Markup.button.callback(
          `${p.description || p.prodId} — ₦${Number(p.prodAmount).toLocaleString()}`,
          `bill_cable_pkg_${start + idx}`
        ),
      ]);
      const nav = [];
      if (page > 0) nav.push(Markup.button.callback("⬅️ Prev", `bill_cable_prov_${providerKey}_${page - 1}`));
      if (start + PAGE_SIZE < pkgs.length) nav.push(Markup.button.callback("Next ➡️", `bill_cable_prov_${providerKey}_${page + 1}`));
      if (nav.length) rows.push(nav);
      rows.push([Markup.button.callback("« Providers", "bill_start_cable")]);

      return ctx.reply(
        `📺 <b>Cable TV Packages</b> (Page ${page + 1})\n──────────────────────────\nSelect a package:`,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) }
      );
    } catch (err) {
      return ctx.reply(`⚠️ Couldn't load Cable TV packages: ${err.message}`, Markup.inlineKeyboard([[btnDefault("« Back", "action_bills_menu")]]));
    }
  });

  bot.action(/^bill_cable_pkg_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;
    const state = convState.getState(userId);
    const pkg = state?.data?.pkgs?.[parseInt(ctx.match[1], 10)];
    if (!state || !pkg) {
      return ctx.reply("Session expired.", Markup.inlineKeyboard([[btnPrimary("📺 Cable TV", "bill_start_cable")]]));
    }
    convState.setState(userId, "bill_cable_card", {
      prodId: pkg.prodId,
      amountNgn: Number(pkg.prodAmount),
      providerName: pkg.provider || state.data.providerKey.toUpperCase(),
      description: pkg.description || pkg.prodId,
    }, state.context);
    return ctx.reply(
      `📺 <b>${escapeHtml(pkg.description || pkg.prodId)}</b> (₦${Number(pkg.prodAmount).toLocaleString()})\n──────────────────────────\n` +
      `Enter your <b>Smartcard / IUC number</b>:`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_bills_menu")]]) }
    );
  });

  // ── 5. BETTING (Product 103) ───────────────────────────────────────────────

  bot.action("bill_start_betting", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const user = requireUser(ctx);
    if (!user) return;
    try {
      const platforms = await airbills.listBettingPlatforms();
      if (!platforms.length) {
        return ctx.reply("No betting platforms available right now.", Markup.inlineKeyboard([[btnDefault("« Back", "action_bills_menu")]]));
      }
      convState.setState(ctx.from.id, "bill_bet_pick", { platforms }, getContext(ctx.from.id));
      const rows = platforms.slice(0, 12).map((p, idx) => [
        Markup.button.callback(`🎰 ${p.name || p.prodId}`, `bill_bet_plat_${idx}`),
      ]);
      rows.push([Markup.button.callback("❌ Cancel", "action_bills_menu")]);
      return ctx.reply(
        `🎰 <b>Fund Betting Account</b>\n──────────────────────────\nSelect your betting platform:`,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) }
      );
    } catch (err) {
      return ctx.reply(`⚠️ Couldn't load betting platforms: ${err.message}`, Markup.inlineKeyboard([[btnDefault("« Back", "action_bills_menu")]]));
    }
  });

  bot.action(/^bill_bet_plat_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;
    const state = convState.getState(userId);
    const plat = state?.data?.platforms?.[parseInt(ctx.match[1], 10)];
    if (!state || !plat) {
      return ctx.reply("Session expired.", Markup.inlineKeyboard([[btnPrimary("🎰 Betting", "bill_start_betting")]]));
    }
    convState.setState(userId, "bill_bet_customer", {
      prodId: plat.prodId,
      providerName: plat.name || plat.prodId,
    }, state.context);
    return ctx.reply(
      `🎰 <b>${escapeHtml(plat.name || plat.prodId)}</b>\n──────────────────────────\n` +
      `Enter your <b>Customer / User ID</b>:`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_bills_menu")]]) }
    );
  });

  bot.action(/^bill_bet_amt_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;
    const state = convState.getState(userId);
    if (!state || state.type !== "bill_bet_amount") {
      return ctx.reply("Session expired.", Markup.inlineKeyboard([[btnPrimary("🎰 Betting", "bill_start_betting")]]));
    }
    const amountNgn = parseInt(ctx.match[1], 10);
    return promptBillConfirmation(ctx, userId, state.context, {
      productCode: airbills.PRODUCTS.BETTING.code,
      category: "betting",
      label: "Betting Top-Up",
      emoji: "🎰",
      providerName: state.data.providerName,
      recipient: state.data.customerId,
      amountNgn,
      billData: {
        customerId: state.data.customerId,
        prodId: state.data.prodId,
      },
    });
  });

  // ── 6. TRANSPORT (Product 105) ─────────────────────────────────────────────

  bot.action("bill_start_transport", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const user = requireUser(ctx);
    if (!user) return;
    try {
      const services = await airbills.listTransportServices();
      if (!services.length) {
        return ctx.reply("No transport services available right now.", Markup.inlineKeyboard([[btnDefault("« Back", "action_bills_menu")]]));
      }
      convState.setState(ctx.from.id, "bill_trans_pick", { services }, getContext(ctx.from.id));
      const rows = services.slice(0, 12).map((s, idx) => {
        const priceTag = s.prodAmount > 0 ? ` — ₦${Number(s.prodAmount).toLocaleString()}` : "";
        return [Markup.button.callback(`🚌 ${s.description || s.prodId}${priceTag}`, `bill_trans_svc_${idx}`)];
      });
      rows.push([Markup.button.callback("❌ Cancel", "action_bills_menu")]);
      return ctx.reply(
        `🚌 <b>Transport Tickets &amp; Top-Up</b>\n──────────────────────────\nChoose a service:`,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) }
      );
    } catch (err) {
      return ctx.reply(`⚠️ Couldn't load transport services: ${err.message}`, Markup.inlineKeyboard([[btnDefault("« Back", "action_bills_menu")]]));
    }
  });

  bot.action(/^bill_trans_svc_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;
    const state = convState.getState(userId);
    const svc = state?.data?.services?.[parseInt(ctx.match[1], 10)];
    if (!state || !svc) {
      return ctx.reply("Session expired.", Markup.inlineKeyboard([[btnPrimary("🚌 Transport", "bill_start_transport")]]));
    }
    if (!svc.prodAmount || svc.prodAmount <= 0) {
      convState.setState(userId, "bill_trans_amount", {
        prodId: svc.prodId,
        providerName: svc.name || "Transport",
        description: svc.description || svc.prodId,
      }, state.context);
      return ctx.reply(
        `🚌 <b>${escapeHtml(svc.description || svc.prodId)} Top-Up</b>\n──────────────────────────\n` +
        `How much (in Naira ₦) would you like to top up?`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback("₦500",   "bill_trans_amt_500"),
              Markup.button.callback("₦1,000", "bill_trans_amt_1000"),
            ],
            [
              Markup.button.callback("₦2,000", "bill_trans_amt_2000"),
              Markup.button.callback("₦5,000", "bill_trans_amt_5000"),
            ],
            [Markup.button.callback("❌ Cancel", "action_bills_menu")],
          ]),
        }
      );
    }
    convState.setState(userId, "bill_trans_phone", {
      prodId: svc.prodId,
      amountNgn: Number(svc.prodAmount),
      providerName: svc.name || "Transport",
      description: svc.description || svc.prodId,
    }, state.context);
    return ctx.reply(
      `🚌 <b>${escapeHtml(svc.description || svc.prodId)}</b> (₦${Number(svc.prodAmount).toLocaleString()})\n──────────────────────────\n` +
      `Enter your phone number:\n💬 <i>Example: <b>08012345678</b></i>`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_bills_menu")]]) }
    );
  });

  bot.action(/^bill_trans_amt_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;
    const state = convState.getState(userId);
    if (!state || state.type !== "bill_trans_amount") {
      return ctx.reply("Session expired.", Markup.inlineKeyboard([[btnPrimary("🚌 Transport", "bill_start_transport")]]));
    }
    const amountNgn = parseInt(ctx.match[1], 10);
    convState.setState(userId, "bill_trans_phone", { ...state.data, amountNgn }, state.context);
    return ctx.reply(
      `🚌 <b>${escapeHtml(state.data.description)} — ₦${amountNgn.toLocaleString()}</b>\n──────────────────────────\n` +
      `Enter your phone number:\n💬 <i>Example: <b>08012345678</b></i>`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_bills_menu")]]) }
    );
  });

  // ── Text State Handler (called from bot.on("text")) ────────────────────────

  async function handleBillsTextState(ctx, state, text) {
    if (!state || !String(state.type || "").startsWith("bill_")) return false;
    const userId = ctx.from.id;

    // 1. Airtime phone
    if (state.type === "bill_airtime_phone") {
      if (!airbills.isValidNigerianPhone(text)) {
        await ctx.reply("Please enter a valid 11-digit Nigerian phone number (e.g. 08012345678):");
        return true;
      }
      const phoneNumber = airbills.normalizeNigerianPhone(text);
      const detected = await airbills.detectNetwork(phoneNumber);
      convState.setState(userId, "bill_airtime_net", { phoneNumber }, state.context);

      const rows = [];
      if (detected) {
        rows.push([btnSuccess(`✅ Confirm ${detected.network}`, `bill_airtime_net_${detected.networkId}`)]);
      }
      rows.push(
        airbills.NETWORKS.slice(0, 2).map(n => Markup.button.callback(`${n.emoji} ${n.name}`, `bill_airtime_net_${n.id}`)),
        airbills.NETWORKS.slice(2, 4).map(n => Markup.button.callback(`${n.emoji} ${n.name}`, `bill_airtime_net_${n.id}`)),
        [Markup.button.callback("❌ Cancel", "action_bills_menu")]
      );

      await ctx.reply(
        `📱 <b>Number:</b> <code>${phoneNumber}</code>\n` +
        (detected ? `Detected network: <b>${detected.network}</b>\n\nConfirm or choose another network:` : `Choose the network:`),
        { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) }
      );
      return true;
    }

    // 2. Airtime custom amount
    if (state.type === "bill_airtime_amount") {
      const amountNgn = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (isNaN(amountNgn) || amountNgn < 50 || amountNgn > 50000) {
        await ctx.reply("Enter a valid Naira amount between ₦50 and ₦50,000:");
        return true;
      }
      await promptBillConfirmation(ctx, userId, state.context, {
        productCode: airbills.PRODUCTS.AIRTIME.code,
        category: "airtime",
        label: "Airtime",
        emoji: "📱",
        providerName: state.data.networkName,
        recipient: state.data.phoneNumber,
        amountNgn,
        billData: {
          phoneNumber: state.data.phoneNumber,
          networkId: state.data.networkId,
        },
      });
      return true;
    }

    // 3. Internet Data phone
    if (state.type === "bill_data_phone") {
      if (!airbills.isValidNigerianPhone(text)) {
        await ctx.reply("Please enter a valid 11-digit Nigerian phone number (e.g. 08012345678):");
        return true;
      }
      const phoneNumber = airbills.normalizeNigerianPhone(text);
      await promptBillConfirmation(ctx, userId, state.context, {
        productCode: airbills.PRODUCTS.DATA.code,
        category: "data",
        label: "Internet Data",
        emoji: "📶",
        providerName: state.data.networkName,
        description: state.data.description,
        recipient: phoneNumber,
        amountNgn: state.data.amountNgn,
        billData: {
          phoneNumber,
          networkId: state.data.networkId,
          prodId: state.data.prodId,
        },
      });
      return true;
    }

    // 4. Electricity meter number (+ live validation!)
    if (state.type === "bill_elect_meter") {
      const meterNo = text.replace(/\s+/g, "").trim();
      if (meterNo.length < 6) {
        await ctx.reply("Please enter a valid meter number:");
        return true;
      }
      await ctx.reply("🔍 Verifying meter number...");
      try {
        const validated = await airbills.validateMeter(meterNo, state.data.electId);
        const customerName = validated?.customerName || validated?.name || validated?.accountName || "Verified Account";
        convState.setState(userId, "bill_elect_amount", { ...state.data, meterNo, customerName }, state.context);
        await ctx.reply(
          `✅ <b>Meter Verified!</b>\n──────────────────────────\n` +
          `• <b>Meter:</b> <code>${escapeHtml(meterNo)}</code>\n` +
          `• <b>Name:</b> ${escapeHtml(customerName)}\n\n` +
          `Enter amount in Naira (minimum ₦2,000):`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback("₦2,000",  "bill_elect_amt_2000"),
                Markup.button.callback("₦5,000",  "bill_elect_amt_5000"),
              ],
              [
                Markup.button.callback("₦10,000", "bill_elect_amt_10000"),
                Markup.button.callback("₦20,000", "bill_elect_amt_20000"),
              ],
              [Markup.button.callback("❌ Cancel", "action_bills_menu")],
            ]),
          }
        );
      } catch (err) {
        await ctx.reply(
          `❌ Could not verify meter <code>${escapeHtml(meterNo)}</code>: ${escapeHtml(err.message)}\n\nPlease check the meter number and try again:`,
          { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_bills_menu")]]) }
        );
      }
      return true;
    }

    // 5. Electricity amount
    if (state.type === "bill_elect_amount") {
      const amountNgn = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (isNaN(amountNgn) || amountNgn < 2000) {
        await ctx.reply("Minimum electricity purchase is ₦2,000. Please enter an amount ≥ 2000:");
        return true;
      }
      convState.setState(userId, "bill_elect_phone", { ...state.data, amountNgn }, state.context);
      await ctx.reply(
        `⚡ <b>₦${amountNgn.toLocaleString()} Electricity</b>\n──────────────────────────\n` +
        `Enter your Nigerian phone number (for receipt/SMS delivery):\n💬 <i>Example: <b>08012345678</b></i>`,
        { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_bills_menu")]]) }
      );
      return true;
    }

    // 6. Electricity phone
    if (state.type === "bill_elect_phone") {
      if (!airbills.isValidNigerianPhone(text)) {
        await ctx.reply("Please enter a valid 11-digit Nigerian phone number (e.g. 08012345678):");
        return true;
      }
      const phoneNumber = airbills.normalizeNigerianPhone(text);
      await promptBillConfirmation(ctx, userId, state.context, {
        productCode: airbills.PRODUCTS.ELECTRICITY.code,
        category: "electricity",
        label: `Electricity (${state.data.prodId})`,
        emoji: "⚡",
        providerName: state.data.providerName,
        customerName: state.data.customerName,
        recipient: state.data.meterNo,
        amountNgn: state.data.amountNgn,
        billData: {
          meterNo: state.data.meterNo,
          electId: state.data.electId,
          prodId: state.data.prodId,
          phoneNumber,
        },
      });
      return true;
    }

    // 7. Cable TV smartcard
    if (state.type === "bill_cable_card") {
      const smartCardNo = text.replace(/\s+/g, "").trim();
      if (smartCardNo.length < 6) {
        await ctx.reply("Please enter a valid Smartcard / IUC number:");
        return true;
      }
      convState.setState(userId, "bill_cable_phone", { ...state.data, smartCardNo }, state.context);
      await ctx.reply(
        `📺 <b>Smartcard:</b> <code>${escapeHtml(smartCardNo)}</code>\n──────────────────────────\n` +
        `Enter your Nigerian phone number:\n💬 <i>Example: <b>08012345678</b></i>`,
        { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_bills_menu")]]) }
      );
      return true;
    }

    // 8. Cable TV phone
    if (state.type === "bill_cable_phone") {
      if (!airbills.isValidNigerianPhone(text)) {
        await ctx.reply("Please enter a valid 11-digit Nigerian phone number (e.g. 08012345678):");
        return true;
      }
      const phoneNumber = airbills.normalizeNigerianPhone(text);
      await promptBillConfirmation(ctx, userId, state.context, {
        productCode: airbills.PRODUCTS.CABLE.code,
        category: "cable",
        label: "Cable TV",
        emoji: "📺",
        providerName: state.data.providerName,
        description: state.data.description,
        recipient: state.data.smartCardNo,
        amountNgn: state.data.amountNgn,
        billData: {
          smartCardNo: state.data.smartCardNo,
          phoneNumber,
          prodId: state.data.prodId,
        },
      });
      return true;
    }

    // 9. Betting customer ID
    if (state.type === "bill_bet_customer") {
      const customerId = text.trim();
      if (customerId.length < 3) {
        await ctx.reply("Please enter a valid betting customer ID:");
        return true;
      }
      convState.setState(userId, "bill_bet_amount", { ...state.data, customerId }, state.context);
      await ctx.reply(
        `🎰 <b>${escapeHtml(state.data.providerName)} — ID: <code>${escapeHtml(customerId)}</code></b>\n──────────────────────────\n` +
        `How much (in Naira ₦) would you like to fund?\n<i>Range: ₦1,000 – ₦100,000</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback("₦1,000",  "bill_bet_amt_1000"),
              Markup.button.callback("₦2,000",  "bill_bet_amt_2000"),
            ],
            [
              Markup.button.callback("₦5,000",  "bill_bet_amt_5000"),
              Markup.button.callback("₦10,000", "bill_bet_amt_10000"),
            ],
            [Markup.button.callback("❌ Cancel", "action_bills_menu")],
          ]),
        }
      );
      return true;
    }

    // 10. Betting custom amount
    if (state.type === "bill_bet_amount") {
      const amountNgn = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (isNaN(amountNgn) || amountNgn < 1000 || amountNgn > 100000) {
        await ctx.reply("Enter a valid Naira amount between ₦1,000 and ₦100,000:");
        return true;
      }
      await promptBillConfirmation(ctx, userId, state.context, {
        productCode: airbills.PRODUCTS.BETTING.code,
        category: "betting",
        label: "Betting Top-Up",
        emoji: "🎰",
        providerName: state.data.providerName,
        recipient: state.data.customerId,
        amountNgn,
        billData: {
          customerId: state.data.customerId,
          prodId: state.data.prodId,
        },
      });
      return true;
    }

    // 11. Transport custom amount
    if (state.type === "bill_trans_amount") {
      const amountNgn = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (isNaN(amountNgn) || amountNgn < 100 || amountNgn > 100000) {
        await ctx.reply("Enter a valid Naira amount between ₦100 and ₦100,000:");
        return true;
      }
      convState.setState(userId, "bill_trans_phone", { ...state.data, amountNgn }, state.context);
      await ctx.reply(
        `🚌 <b>${escapeHtml(state.data.description)} — ₦${amountNgn.toLocaleString()}</b>\n──────────────────────────\n` +
        `Enter your phone number:\n💬 <i>Example: <b>08012345678</b></i>`,
        { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_bills_menu")]]) }
      );
      return true;
    }

    // 12. Transport phone
    if (state.type === "bill_trans_phone") {
      if (!airbills.isValidNigerianPhone(text)) {
        await ctx.reply("Please enter a valid 11-digit Nigerian phone number (e.g. 08012345678):");
        return true;
      }
      const phoneNumber = airbills.normalizeNigerianPhone(text);
      await promptBillConfirmation(ctx, userId, state.context, {
        productCode: airbills.PRODUCTS.TRANSPORT.code,
        category: "transport",
        label: "Transport",
        emoji: "🚌",
        providerName: state.data.providerName,
        description: state.data.description,
        recipient: phoneNumber,
        amountNgn: state.data.amountNgn,
        billData: {
          phoneNumber,
          prodId: state.data.prodId,
        },
      });
      return true;
    }

    // 12. PIN confirmation & Execution
    if (state.type === "bill_confirm_pin") {
      await deleteSensitiveMessage(ctx);
      if (!/^\d{4}$/.test(text)) {
        await ctx.reply(
          "Please enter your 4-digit PIN (e.g. 1234):",
          Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_bills_menu")]])
        );
        return true;
      }
      const pinStatus = db.verifyPinWithStatus(userId, text);
      if (!pinStatus.valid) {
        if (pinStatus.locked) {
          convState.clearState(userId);
          await ctx.reply("🔒 Account locked due to too many wrong PIN attempts. Please try again later.", backToMenu);
          return true;
        }
        await ctx.reply(
          `❌ Incorrect PIN (${pinStatus.remainingAttempts} attempt(s) left). Try again:`,
          Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_bills_menu")]])
        );
        return true;
      }

      const user = db.getUser(userId);
      const data = state.data;
      const context = state.context || "personal";
      convState.clearState(userId);

      await ctx.reply(`⏳ Processing your ₦${Number(data.amountNgn).toLocaleString()} ${data.label} payment...`);

      try {
        const res = await airbills.executeBillPayment({
          user,
          pin: text,
          context,
          productCode: data.productCode,
          category: data.category,
          providerName: data.providerName,
          recipient: data.recipient,
          amountNgn: data.amountNgn,
          billData: data.billData,
          onProgress: async (msg) => {
            try { await ctx.reply(msg); } catch (_) {}
          },
        });

        const tokenBlock = res.meterToken
          ? `\n🔑 <b>Meter Token:</b> <code>${escapeHtml(res.meterToken)}</code>\n`
          : "";

        await ctx.reply(
          `✅ <b>Bill Paid Successfully!</b>\n` +
          `──────────────────────────\n` +
          `• <b>Service:</b> ${escapeHtml(data.providerName)} (${escapeHtml(data.label)})\n` +
          `• <b>Recipient:</b> <code>${escapeHtml(data.recipient)}</code>\n` +
          `• <b>Amount:</b> ₦${Number(res.amountNgn).toLocaleString()} ($${Number(res.amountUsdc).toFixed(2)})\n` +
          tokenBlock +
          `• <b>Ref:</b> <code>${escapeHtml(res.airbillsTxId)}</code>`,
          { parse_mode: "HTML", ...afterPaymentButtons }
        );
      } catch (err) {
        console.error("[flows_bills:execute:error]", err);
        await ctx.reply(
          `❌ <b>Bill Payment Failed</b>\n──────────────────────────\n` +
          `⚠️ ${escapeHtml(err.message)}\n\n` +
          `Please try again or check your balance.`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [btnPrimary("💡 Try Again", "action_bills_menu")],
              [btnDefault("🏠 Main Menu", "main_menu")],
            ]),
          }
        );
      }
      return true;
    }

    return false;
  }

  return { showBillsMenu, handleBillsTextState };
}

module.exports = { registerBillsFlows };
