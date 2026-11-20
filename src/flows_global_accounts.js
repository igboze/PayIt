// src/flows_global_accounts.js
// Telegram UI Flows for Nuvion Phase 2:
// - Named Global Receiving Bank Accounts (USD, GBP, EUR, NGN, AED, KES, GHS, TZS, MXN)
// - Hosted Payment Request Links (GBP/EUR Open Banking, CAD Interac e-Transfer, KES/TZS Mobile Money)
// - Business Invoice Global Bank Details helper

const { Markup } = require("telegraf");
const nuvion = require("./nuvion");
const orchestrator = require("./nuvion_orchestrator");
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
  return typeof stateType === "string" && stateType.startsWith("nuvion_paylink_");
}

/**
 * Show currency grid for named Global Receiving Bank Accounts (Personal or Business).
 */
async function showGlobalAccountsMenu(ctx, accountType = "personal") {
  const user = deps.requireUser ? deps.requireUser(ctx) : db.getUser(ctx.from.id);
  if (!user) return;
  if (!nuvion.isUserAllowedNuvion(ctx.from.id)) {
    return ctx.reply("🌍 Global Bank Accounts are currently in private beta.", deps.backToMenu || {});
  }

  const entity = db.getNuvionEntityByUser(ctx.from.id, accountType);
  if (!entity || String(entity.status).toLowerCase() !== "approved") {
    return ctx.reply(
      `🔒 <b>Tier-1 Verification Required</b>\n──────────────────────────\n` +
      `Complete your ${accountType === "business" ? "Business KYB" : "Personal KYC"} verification first to unlock named global bank accounts.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🪪 Open Global Banking", accountType === "business" ? "biz_nuvion_portal" : "action_nuvion_portal")],
          [Markup.button.callback("🏠 Main Menu", "main_menu")],
        ]),
      }
    );
  }

  const existing = db.getNuvionAccountDetailsByEntity(entity.entity_id).filter((d) => d.asset_type === "fiat");
  const activeCurrencies = new Set(existing.filter((d) => d.status === "active").map((d) => d.currency));
  const pendingCurrencies = new Set(existing.filter((d) => d.status !== "active").map((d) => d.currency));

  const badge = (code) => (activeCurrencies.has(code) ? " ✅" : pendingCurrencies.has(code) ? " ⏳" : "");
  const p = accountType === "business" ? "biz" : "per";
  const label = accountType === "business" ? "Business Global Bank Accounts" : "Global Bank Accounts";

  return ctx.reply(
    `🏦 <b>${label}</b>\n──────────────────────────\n` +
    `<b>Account Holder:</b> ${escapeHtml(entity.legal_name || "Verified Account")}\n\n` +
    `Tap a currency below to view or generate your permanent named bank details.\n` +
    `<i>Any transfer received automatically converts and settles straight into your main Proxim balance.</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`🇺🇸 USD${badge("USD")}`, `nuvion_acct_${p}_USD`),
          Markup.button.callback(`🇬🇧 GBP${badge("GBP")}`, `nuvion_acct_${p}_GBP`),
          Markup.button.callback(`🇪🇺 EUR${badge("EUR")}`, `nuvion_acct_${p}_EUR`),
        ],
        [
          Markup.button.callback(`🇳🇬 NGN${badge("NGN")}`, `nuvion_acct_${p}_NGN`),
          Markup.button.callback(`🇦🇪 AED${badge("AED")}`, `nuvion_acct_${p}_AED`),
          Markup.button.callback(`🇰🇪 KES${badge("KES")}`, `nuvion_acct_${p}_KES`),
        ],
        [
          Markup.button.callback(`🇬🇭 GHS${badge("GHS")}`, `nuvion_acct_${p}_GHS`),
          Markup.button.callback(`🇹🇿 TZS${badge("TZS")}`, `nuvion_acct_${p}_TZS`),
          Markup.button.callback(`🇲🇽 MXN${badge("MXN")}`, `nuvion_acct_${p}_MXN`),
        ],
        [Markup.button.callback("🔗 Request Payment Link (UK / EU / Canada / MoMo)", `nuvion_paylink_menu_${p}`)],
        [Markup.button.callback("« Back to Global Portal", accountType === "business" ? "biz_nuvion_portal" : "action_nuvion_portal")],
      ]),
    }
  );
}

/**
 * Show hosted payment link rail selector (Open Banking, Interac CAD, Mobile Money).
 */
async function showPaymentLinksMenu(ctx, accountType = "personal") {
  const entity = db.getNuvionEntityByUser(ctx.from.id, accountType);
  if (!entity || String(entity.status).toLowerCase() !== "approved") {
    return showGlobalAccountsMenu(ctx, accountType);
  }
  const p = accountType === "business" ? "biz" : "per";

  return ctx.reply(
    `🔗 <b>Request a Global Payment Link</b>\n──────────────────────────\n` +
    `Collect instant payments from international clients or customers — funds settle straight into your main Proxim balance:\n\n` +
    `• 🇬🇧 <b>UK Open Banking (GBP):</b> Instant pay-by-bank link\n` +
    `• 🇪🇺 <b>EU Open Banking (EUR):</b> Instant pay-by-bank link\n` +
    `• 🇨🇦 <b>Canada Interac (CAD):</b> Official Interac e-Transfer request sent to client's email\n` +
    `• 🇰🇪 <b>Kenya M-Pesa (KES):</b> Instant USSD prompt on payer's phone\n` +
    `• 🇹🇿 <b>Tanzania MoMo (TZS):</b> Airtel / Tigo / Halotel USSD prompt`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("🇬🇧 GBP Bank Link", `nuvion_pl_start_${p}_openbanking_GBP`),
          Markup.button.callback("🇪🇺 EUR Bank Link", `nuvion_pl_start_${p}_openbanking_EUR`),
        ],
        [Markup.button.callback("🇨🇦 Canada Interac Request (CAD)", `nuvion_pl_start_${p}_interac_CAD`)],
        [
          Markup.button.callback("🇰🇪 Kenya M-Pesa", `nuvion_pl_start_${p}_momo_KES`),
          Markup.button.callback("🇹🇿 Tanzania MoMo", `nuvion_pl_start_${p}_momo_TZS`),
        ],
        [Markup.button.callback("« Back to Global Accounts", `nuvion_accounts_menu_${p}`)],
      ]),
    }
  );
}

/**
 * Handle text input for hosted payment link creation.
 */
async function handleGlobalAccountsTextState(ctx, state, text, userId) {
  if (!state || !handlesState(state.type)) return false;

  const val = String(text || "").trim();
  const d = state.data || {};
  const accountType = d.accountType || "personal";
  const p = accountType === "business" ? "biz" : "per";

  // ── Open Banking (GBP / EUR): "Amount, Description" ───────────────────────
  if (state.type === "nuvion_paylink_openbanking") {
    const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
    const amount = parseFloat((parts[0] || "").replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
      await ctx.reply(`Please enter a valid ${d.currency} amount (e.g. <code>250, Design invoice</code>).`, { parse_mode: "HTML" });
      return true;
    }
    const narration = parts.slice(1).join(", ") || `${d.currency} payment`;
    convState.clearState(userId);
    await ctx.reply(`⏳ Creating your ${d.currency} instant payment link...`);

    try {
      const { session } = await orchestrator.createHostedPaymentLink({
        telegramId: userId,
        accountType,
        currency: d.currency,
        amountMajor: amount,
        fundingType: "open-banking",
        narration,
      });

      const amtStr = orchestrator.formatFiatAmount(d.currency, amount);
      await ctx.reply(
        `✅ <b>${d.currency} Payment Link Ready!</b>\n──────────────────────────\n` +
        `• <b>Amount:</b> ${amtStr}\n` +
        `• <b>Note:</b> ${escapeHtml(narration)}\n` +
        `• <b>Checkout Link:</b>\n${escapeHtml(session.checkout_url || "Unavailable")}\n\n` +
        `<i>Share this link with your payer. Once they complete the bank transfer, funds settle straight into your main Proxim balance.</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            ...(session.checkout_url ? [[Markup.button.url("🌐 Open Checkout Link", session.checkout_url)]] : []),
            [Markup.button.callback("« Global Accounts", `nuvion_accounts_menu_${p}`)],
          ]),
        }
      );
    } catch (err) {
      await ctx.reply(`❌ ${escapeHtml(nuvion.formatUserFriendlyError(err))}`, { parse_mode: "HTML" });
    }
    return true;
  }

  // ── Interac (CAD): "Amount, Payer Name, Payer Email, Memo" ────────────────
  if (state.type === "nuvion_paylink_interac") {
    const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
    const amount = parseFloat((parts[0] || "").replace(/[^0-9.]/g, ""));
    const payerName = parts[1];
    const payerEmail = parts[2];
    const narration = parts.slice(3).join(", ") || `Invoice payment`;

    if (!Number.isFinite(amount) || amount < 1 || amount > 25000 || !payerName || !payerEmail || !payerEmail.includes("@")) {
      await ctx.reply(
        `Please send: <b>Amount (1–25000), Payer Name, Payer Email, Memo</b>\n` +
        `Example: <code>150, Ada Lovelace, ada@example.com, Logo design</code>`,
        { parse_mode: "HTML" }
      );
      return true;
    }

    convState.clearState(userId);
    await ctx.reply("⏳ Sending official Interac e-Transfer request...");

    try {
      const { session } = await orchestrator.createHostedPaymentLink({
        telegramId: userId,
        accountType,
        currency: "CAD",
        amountMajor: amount,
        fundingType: "interac",
        payerName,
        payerEmail,
        narration,
      });

      await ctx.reply(
        `✅ <b>Interac Request Sent!</b>\n──────────────────────────\n` +
        `• <b>Amount:</b> ${orchestrator.formatFiatAmount("CAD", amount)}\n` +
        `• <b>Sent To:</b> ${escapeHtml(payerName)} (<code>${escapeHtml(payerEmail)}</code>)\n` +
        (session.reference_number ? `• <b>Interac Ref:</b> <code>${escapeHtml(session.reference_number)}</code>\n` : "") +
        `\n<i>Your client has received an Interac email from their Canadian bank rail. We automatically check for settlement every few minutes and will credit your main balance as soon as they accept.</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("« Global Accounts", `nuvion_accounts_menu_${p}`)]]),
        }
      );
    } catch (err) {
      await ctx.reply(`❌ ${escapeHtml(nuvion.formatUserFriendlyError(err))}`, { parse_mode: "HTML" });
    }
    return true;
  }

  // ── Mobile Money (KES / TZS): "Amount, Phone" ─────────────────────────────
  if (state.type === "nuvion_paylink_momo") {
    const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
    const amount = parseFloat((parts[0] || "").replace(/[^0-9.]/g, ""));
    const msisdn = (parts[1] || "").replace(/\D/g, "");
    const narration = parts.slice(2).join(", ") || `${d.currency} payment`;

    if (!Number.isFinite(amount) || amount <= 0 || msisdn.length < 9) {
      await ctx.reply(
        `Please send: <b>Amount (${d.currency}), Phone Number</b>\n` +
        `Example: <code>${d.currency === "KES" ? "2500, 254712345678" : "50000, 255712345678"}</code>`,
        { parse_mode: "HTML" }
      );
      return true;
    }

    convState.clearState(userId);
    await ctx.reply(`⏳ Sending ${d.currency} Mobile Money USSD prompt to +${msisdn}...`);

    try {
      await orchestrator.createHostedPaymentLink({
        telegramId: userId,
        accountType,
        currency: d.currency,
        amountMajor: amount,
        fundingType: "momo",
        msisdn,
        momoChannel: d.channel,
        narration,
      });

      await ctx.reply(
        `📲 <b>Mobile Money Prompt Sent!</b>\n──────────────────────────\n` +
        `• <b>Amount:</b> ${orchestrator.formatFiatAmount(d.currency, amount)}\n` +
        `• <b>Phone:</b> <code>+${escapeHtml(msisdn)}</code>\n` +
        `• <b>Channel:</b> ${escapeHtml(d.channel)}\n\n` +
        `<i>Ask the payer to approve the USSD prompt on their phone. Once confirmed, funds settle straight into your main Proxim balance.</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("« Global Accounts", `nuvion_accounts_menu_${p}`)]]),
        }
      );
    } catch (err) {
      await ctx.reply(`❌ ${escapeHtml(nuvion.formatUserFriendlyError(err))}`, { parse_mode: "HTML" });
    }
    return true;
  }

  return false;
}

/**
 * Helper for Business Invoicing: returns formatted active named bank accounts
 * (USD, GBP, EUR, NGN, etc.) that a verified Proxim Business can share alongside an invoice.
 */
function getBusinessGlobalPaymentOptions(telegramId) {
  const entity = db.getNuvionEntityByUser(telegramId, "business");
  if (!entity || String(entity.status).toLowerCase() !== "approved") return [];
  return db
    .getNuvionAccountDetailsByEntity(entity.entity_id)
    .filter((d) => d.asset_type === "fiat" && d.status === "active");
}

function registerGlobalAccountsFlows(bot, depsIn = {}) {
  deps = { bot, ...depsIn };

  bot.action(/^nuvion_accounts_menu_(per|biz)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const accountType = ctx.match[1] === "biz" ? "business" : "personal";
    return showGlobalAccountsMenu(ctx, accountType);
  });

  bot.action(/^nuvion_acct_(per|biz)_([A-Z]{3})$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const accountType = ctx.match[1] === "biz" ? "business" : "personal";
    const currency = ctx.match[2];
    const p = ctx.match[1];

    await ctx.reply(`⏳ Checking your named <b>${currency}</b> bank account...`, { parse_mode: "HTML" });
    try {
      const { entity, detail, isPending } = await orchestrator.provisionGlobalReceivingAccount(
        ctx.from.id,
        accountType,
        currency
      );

      if (isPending) {
        return ctx.reply(
          `⏳ <b>Provisioning Your ${currency} Bank Account</b>\n──────────────────────────\n` +
          `Your named <b>${currency}</b> account for <b>${escapeHtml(entity.legal_name || "your profile")}</b> is being generated by our banking partner.\n\n` +
          `We'll message you automatically right here with your account number as soon as it activates!`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [Markup.button.callback(`🔄 Refresh ${currency} Details`, `nuvion_acct_${p}_${currency}`)],
              [Markup.button.callback("« All Global Accounts", `nuvion_accounts_menu_${p}`)],
            ]),
          }
        );
      }

      const cardText = orchestrator.formatReceivingDetailsCard(detail, entity.legal_name);
      return ctx.reply(cardText, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("« All Global Accounts", `nuvion_accounts_menu_${p}`)],
          [Markup.button.callback("🏠 Main Menu", "main_menu")],
        ]),
      });
    } catch (err) {
      return ctx.reply(
        `❌ Couldn't load ${currency} account details: ${escapeHtml(nuvion.formatUserFriendlyError(err))}`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("« Global Accounts", `nuvion_accounts_menu_${p}`)]]),
        }
      );
    }
  });

  bot.action(/^nuvion_paylink_menu_(per|biz)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const accountType = ctx.match[1] === "biz" ? "business" : "personal";
    return showPaymentLinksMenu(ctx, accountType);
  });

  bot.action(/^nuvion_pl_start_(per|biz)_openbanking_(GBP|EUR)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const accountType = ctx.match[1] === "biz" ? "business" : "personal";
    const currency = ctx.match[2];
    convState.setState(ctx.from.id, "nuvion_paylink_openbanking", { accountType, currency }, accountType);
    return ctx.reply(
      `🔗 <b>New ${currency} Instant Payment Link</b>\n──────────────────────────\n` +
      `Enter <b>Amount, Description</b> (e.g. <code>250, Website invoice</code>):`,
      { parse_mode: "HTML" }
    );
  });

  bot.action(/^nuvion_pl_start_(per|biz)_interac_CAD$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const accountType = ctx.match[1] === "biz" ? "business" : "personal";
    convState.setState(ctx.from.id, "nuvion_paylink_interac", { accountType, currency: "CAD" }, accountType);
    return ctx.reply(
      `🇨🇦 <b>New Canada Interac Request (CAD)</b>\n──────────────────────────\n` +
      `Enter <b>Amount, Payer Name, Payer Email, Memo</b> separated by commas:\n` +
      `Example: <code>150, Ada Lovelace, ada@example.com, Consulting invoice</code>`,
      { parse_mode: "HTML" }
    );
  });

  bot.action(/^nuvion_pl_start_(per|biz)_momo_KES$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const accountType = ctx.match[1] === "biz" ? "business" : "personal";
    convState.setState(ctx.from.id, "nuvion_paylink_momo", { accountType, currency: "KES", channel: "KE-SAFARICOM-C2B" }, accountType);
    return ctx.reply(
      `🇰🇪 <b>Kenya M-Pesa Payment Prompt (KES)</b>\n──────────────────────────\n` +
      `Enter <b>Amount (20–250,000 KES), Phone Number</b> separated by a comma:\n` +
      `Example: <code>2500, 254712345678</code>`,
      { parse_mode: "HTML" }
    );
  });

  bot.action(/^nuvion_pl_start_(per|biz)_momo_TZS$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const p = ctx.match[1];
    return ctx.reply(
      `🇹🇿 <b>Select Tanzania Mobile Money Network</b>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("Airtel Money", `nuvion_pl_tz_${p}_TZ-AIRTEL-C2B`),
            Markup.button.callback("Tigo Pesa", `nuvion_pl_tz_${p}_TZ-TIGO-C2B`),
          ],
          [Markup.button.callback("Halotel HaloPesa", `nuvion_pl_tz_${p}_TZ-HALOTEL-C2B`)],
          [Markup.button.callback("« Back", `nuvion_paylink_menu_${p}`)],
        ]),
      }
    );
  });

  bot.action(/^nuvion_pl_tz_(per|biz)_(TZ-[A-Z0-9-]+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const accountType = ctx.match[1] === "biz" ? "business" : "personal";
    const channel = ctx.match[2];
    convState.setState(ctx.from.id, "nuvion_paylink_momo", { accountType, currency: "TZS", channel }, accountType);
    return ctx.reply(
      `🇹🇿 <b>Tanzania Mobile Money Prompt (${channel})</b>\n──────────────────────────\n` +
      `Enter <b>Amount (1,000–5,000,000 TZS), Phone Number</b> separated by a comma:\n` +
      `Example: <code>50000, 255712345678</code>`,
      { parse_mode: "HTML" }
    );
  });
}

module.exports = {
  registerGlobalAccountsFlows,
  showGlobalAccountsMenu,
  showPaymentLinksMenu,
  handlesState,
  handleGlobalAccountsTextState,
  getBusinessGlobalPaymentOptions,
};
