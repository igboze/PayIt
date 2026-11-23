// src/flows_investments.js
// Telegram UI Flows for Pods Finance Investments (Open to All Users — Tier 0 & Tier 1):
//   1. US Stocks & ETFs (471 Ondo Global Markets tickers — Buy, Live Price, Portfolio, Sell)
//   2. Insured & High-Yield Dollar Savings (OpenCover Insured, Tokenized T-Bills, Base USDC, EarnUSD)

const { Markup } = require("telegraf");
const { parseUnits } = require("ethers");
const pods = require("./pods");
const podsExecutor = require("./pods_executor");
const podsStore = require("./pods_store");
const db = require("./db");
const convState = require("./conversation_state");
const apiRoutes = require("./api_routes");
const { safeAnswerCbQuery } = require("./telegram_utils");

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

function getPodsWebhookUrl() {
  try {
    const base = apiRoutes.getPublicBaseUrl ? apiRoutes.getPublicBaseUrl() : "";
    if (base && base.startsWith("https://")) return `${base.replace(/\/+$/, "")}/webhooks/pods`;
  } catch (_) {}
  return null;
}

function getAccountWallet(user, context) {
  return context === "business"
    ? (user.business_deposit_address || user.deposit_address)
    : user.deposit_address;
}

function decryptContextKey(pin, user, context) {
  return context === "business"
    ? db.decryptBusinessPrivateKey(pin, user)
    : db.decryptPrivateKey(pin, user);
}

function handlesState(stateType) {
  return typeof stateType === "string" && stateType.startsWith("pods_");
}

function ensureDisclaimer(ctx, nextAction) {
  if (podsStore.hasAcceptedInvestmentsDisclaimer(ctx.from.id)) return true;
  ctx.reply(
    `📈 <b>Proxim Investments — Quick Disclosure</b>\n` +
    `──────────────────────────\n` +
    `Before trading tokenized US stocks or depositing into yield vaults, please confirm:\n\n` +
    `• You understand asset prices and yields can fluctuate and carry market/smart-contract risk.\n` +
    `• Tokenized US equities (Ondo Global Markets) are <b>not available to US persons</b> or restricted jurisdictions.\n` +
    `• Positions are held non-custodially in your own Proxim wallet.\n\n` +
    `Tap below to accept and continue:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ I Understand & Accept", `pods_accept_disc_${nextAction}`)],
        [Markup.button.callback("❌ Cancel", "main_menu")],
      ]),
    }
  );
  return false;
}

function checkFeatureGate(ctx) {
  if (pods.isInvestmentsEnabledForUser(ctx.from?.id)) return true;
  ctx.reply("🚧 US Stocks & Insured Savings are currently in private beta and will launch soon.", deps.backToMenu || {});
  return false;
}

async function showInvestmentsHub(ctx) {
  const user = deps.requireUser ? deps.requireUser(ctx) : db.getUser(ctx.from.id);
  if (!user) return;
  if (!checkFeatureGate(ctx)) return;
  if (!ensureDisclaimer(ctx, "hub")) return;

  return ctx.reply(
    `📈 <b>Proxim Investments</b>\n` +
    `──────────────────────────\n` +
    `Grow your wealth directly from your Proxim USD balance — open to all users:\n\n` +
    `• <b>🇺🇸 US Stocks &amp; ETFs:</b> Buy fractional shares of 470+ stocks (AAPL, NVDA, TSLA, SPY, QQQ…) from <b>$10</b>.\n` +
    `• <b>🛡️ Insured &amp; High-Yield Savings:</b> OpenCover-insured USD savings, tokenized US T-Bills, and liquid Base vaults.\n\n` +
    `What would you like to explore?`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🇺🇸 Buy / Trade US Stocks", "pods_stocks_menu")],
        [Markup.button.callback("💼 My Stock Portfolio", "pods_stocks_portfolio")],
        [Markup.button.callback("🛡️ Insured & High-Yield Vaults", "pods_vaults_menu")],
        [Markup.button.callback("📊 My Vault Positions", "pods_vaults_portfolio")],
        [Markup.button.callback("🏠 Main Menu", "main_menu")],
      ]),
    }
  );
}

async function showStocksMenu(ctx) {
  const user = deps.requireUser ? deps.requireUser(ctx) : db.getUser(ctx.from.id);
  if (!user) return;
  if (!checkFeatureGate(ctx)) return;
  if (!ensureDisclaimer(ctx, "stocks")) return;

  const rows = [];
  for (let i = 0; i < pods.POPULAR_STOCKS.length; i += 3) {
    const slice = pods.POPULAR_STOCKS.slice(i, i + 3);
    rows.push(
      slice.map((s) => Markup.button.callback(`${s.icon} ${s.ticker}`, `pods_stock_view_${s.ticker}`))
    );
  }
  rows.push([Markup.button.callback("🔍 Search 470+ Stocks & ETFs", "pods_stocks_search")]);
  rows.push([
    Markup.button.callback("💼 My Portfolio", "pods_stocks_portfolio"),
    Markup.button.callback("⬅️ Back", "pods_hub"),
  ]);

  return ctx.reply(
    `🇺🇸 <b>US Stocks &amp; ETFs (Ondo Global Markets)</b>\n` +
    `──────────────────────────\n` +
    `Pick a popular stock below or search any of <b>470+ US equities &amp; ETFs</b>.\n` +
    `<i>Minimum buy: $10 · Funded straight from your Proxim USD balance.</i>`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) }
  );
}

async function showStockDetail(ctx, tickerRaw) {
  const user = deps.requireUser ? deps.requireUser(ctx) : db.getUser(ctx.from.id);
  if (!user) return;
  const ticker = pods.normalizeTicker(tickerRaw);
  const context = deps.getContext ? deps.getContext(ctx.from.id) : "personal";
  const wallet = getAccountWallet(user, context);

  try {
    const [status, pos] = await Promise.all([
      pods.getStockMarketStatus(ticker),
      pods.getStrategyPosition(pods.toOndoStrategyId(ticker), wallet).catch(() => null),
    ]);

    const popular = pods.POPULAR_STOCKS.find((p) => p.ticker === ticker);
    const title = popular ? `${popular.icon} ${popular.name} (${ticker})` : `📈 ${ticker}`;
    const priceStr = status.price != null ? `$${status.price.toFixed(2)}` : "Unavailable";
    const pct = status.priceChangePct24h;
    const chgStr = pct != null ? `${pct >= 0 ? "🟢 +" : "🔴 "}${pct.toFixed(2)}% (24h)` : "";
    const sessionBadge = status.tradable
      ? `🟢 Market Tradable (${escapeHtml(status.marketStatus)})`
      : `🔴 Market Closed (${escapeHtml(status.blockingReason || status.marketStatus)})`;

    const heldShares = pos?.currentPosition || 0;
    const heldLine = heldShares > 0
      ? `\n💼 <b>Your Holding:</b> ${heldShares.toFixed(4)} ${ticker}` +
        (status.price ? ` (~$${(heldShares * status.price).toFixed(2)})` : "") +
        (pos?.avgPurchasePrice ? `\n• <b>Avg Buy Price:</b> $${pos.avgPurchasePrice.toFixed(2)}` : "") +
        (pos?.profit ? `\n• <b>PnL:</b> ${pos.profit >= 0 ? "+" : ""}$${pos.profit.toFixed(2)}` : "")
      : "";

    const buttons = [];
    if (status.tradable) {
      buttons.push([Markup.button.callback(`🟢 Buy ${ticker} ($10+)`, `pods_stock_buy_${ticker}`)]);
    }
    if (heldShares > 0 && status.tradable) {
      buttons.push([Markup.button.callback(`🔴 Sell ${ticker}`, `pods_stock_sell_${ticker}`)]);
    }
    buttons.push([
      Markup.button.callback("🔄 Refresh", `pods_stock_view_${ticker}`),
      Markup.button.callback("⬅️ All Stocks", "pods_stocks_menu"),
    ]);

    return ctx.reply(
      `<b>${escapeHtml(title)}</b>\n` +
      `──────────────────────────\n` +
      `💵 <b>Price:</b> ${priceStr} ${chgStr}\n` +
      `🕒 <b>Status:</b> ${sessionBadge}` +
      heldLine +
      `\n\n<i>Orders fill asynchronously via Ondo Global Markets (~2–5 min) and land in your non-custodial wallet.</i>`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) }
    );
  } catch (err) {
    console.error("[flows_investments:stock_detail]", err.message);
    return ctx.reply(
      `❌ Could not load market data for <b>${escapeHtml(ticker)}</b>. Double-check the ticker and try again.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ All Stocks", "pods_stocks_menu")]]),
      }
    );
  }
}

async function showStocksPortfolio(ctx) {
  const user = deps.requireUser ? deps.requireUser(ctx) : db.getUser(ctx.from.id);
  if (!user) return;
  const context = deps.getContext ? deps.getContext(ctx.from.id) : "personal";
  const wallet = getAccountWallet(user, context);
  const tracked = podsStore.getUserTrackedStockTickers(ctx.from.id, context);

  if (!tracked.length) {
    return ctx.reply(
      `💼 <b>My Stock Portfolio</b>\n──────────────────────────\n` +
      `You don't own any US stocks yet.\n\nTap below to buy your first fractional share from <b>$10</b>:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🇺🇸 Browse US Stocks", "pods_stocks_menu")],
          [Markup.button.callback("⬅️ Back", "pods_hub")],
        ]),
      }
    );
  }

  const lines = [];
  const buttons = [];
  for (const ticker of tracked.slice(0, 10)) {
    try {
      const [pos, status] = await Promise.all([
        pods.getStrategyPosition(pods.toOndoStrategyId(ticker), wallet),
        pods.getStockMarketStatus(ticker).catch(() => null),
      ]);
      const shares = pos.currentPosition || 0;
      const valUsd = status?.price ? shares * status.price : (pos.currentPositionUsd || 0);
      const pnlStr = pos.profit ? ` (${pos.profit >= 0 ? "+" : ""}$${pos.profit.toFixed(2)})` : "";
      const pendStr = pos.requestedToLend > 0 ? ` · ⏳ Pending buy` : pos.requestedToWithdraw > 0 ? ` · ⏳ Pending sell` : "";
      lines.push(`• <b>${escapeHtml(ticker)}:</b> ${shares.toFixed(4)} sh · $${valUsd.toFixed(2)}${pnlStr}${pendStr}`);
      buttons.push([
        Markup.button.callback(`📈 ${ticker}`, `pods_stock_view_${ticker}`),
        ...(shares > 0 ? [Markup.button.callback(`🔴 Sell ${ticker}`, `pods_stock_sell_${ticker}`)] : []),
      ]);
    } catch (_) {
      lines.push(`• <b>${escapeHtml(ticker)}:</b> <i>Refreshing…</i>`);
    }
  }
  buttons.push([Markup.button.callback("🇺🇸 Buy More Stocks", "pods_stocks_menu")]);
  buttons.push([Markup.button.callback("⬅️ Back", "pods_hub")]);

  return ctx.reply(
    `💼 <b>My Stock Portfolio (${context === "business" ? "Business" : "Personal"})</b>\n` +
    `──────────────────────────\n` +
    `${lines.join("\n")}\n\n` +
    `<i>Tap any ticker for live price, avg buy price, or to sell back to USD.</i>`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) }
  );
}

async function showVaultsMenu(ctx) {
  const user = deps.requireUser ? deps.requireUser(ctx) : db.getUser(ctx.from.id);
  if (!user) return;
  if (!checkFeatureGate(ctx)) return;
  if (!ensureDisclaimer(ctx, "vaults")) return;

  const vaults = await pods.getCuratedSavingsVaults();
  const lines = vaults.map(
    (v) =>
      `${v.badge} <b>${escapeHtml(v.name)}</b> — <b>${v.apyPct}% APY</b>\n` +
      `   Lock: ${escapeHtml(v.lockPeriod)} · Unlock: ${escapeHtml(v.unlockPeriod)}`
  );

  const buttons = vaults.map((v) => [
    Markup.button.callback(`${v.badge} · ${v.apyPct}% APY`, `pods_vault_view_${v.shortId}`),
  ]);
  buttons.push([
    Markup.button.callback("📊 My Vaults", "pods_vaults_portfolio"),
    Markup.button.callback("⬅️ Back", "pods_hub"),
  ]);

  return ctx.reply(
    `🛡️ <b>Insured &amp; High-Yield Dollar Vaults</b>\n` +
    `──────────────────────────\n` +
    `${lines.join("\n\n")}\n\n` +
    `<i>Tap any vault to inspect lock/unlock terms, deposit, or withdraw:</i>`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) }
  );
}

async function showVaultDetail(ctx, shortId) {
  const user = deps.requireUser ? deps.requireUser(ctx) : db.getUser(ctx.from.id);
  if (!user) return;
  const vault = pods.getSavingsVaultByShortId(shortId);
  if (!vault) return ctx.reply("Vault not found.");
  const context = deps.getContext ? deps.getContext(ctx.from.id) : "personal";
  const wallet = getAccountWallet(user, context);

  const pos = await pods.getStrategyPosition(vault.id, wallet).catch(() => null);
  const apyPct = pos ? (pos.apy * 100).toFixed(2) : "—";
  const bal = pos?.currentPosition || 0;
  const profit = pos?.profit || 0;

  const buttons = [
    [Markup.button.callback(`➕ Deposit into ${vault.name}`, `pods_vault_dep_${vault.shortId}`)],
  ];
  if (bal > 0) {
    buttons.push([Markup.button.callback(`➖ Withdraw All`, `pods_vault_wdr_${vault.shortId}`)]);
  }
  buttons.push([
    Markup.button.callback("🔄 Refresh", `pods_vault_view_${vault.shortId}`),
    Markup.button.callback("⬅️ All Vaults", "pods_vaults_menu"),
  ]);

  return ctx.reply(
    `${vault.badge} <b>${escapeHtml(vault.name)}</b>\n` +
    `──────────────────────────\n` +
    `📈 <b>Live APY:</b> ${apyPct}%\n` +
    `🔒 <b>Lock Period:</b> ${escapeHtml(vault.lockPeriod)}\n` +
    `🔓 <b>Unlock / Withdrawal:</b> ${escapeHtml(vault.unlockPeriod)}\n` +
    `⚖️ <b>Risk Profile:</b> ${escapeHtml(vault.riskLabel)}\n` +
    `──────────────────────────\n` +
    `💰 <b>Your Balance:</b> $${bal.toFixed(2)}\n` +
    `✨ <b>Yield Earned:</b> +$${profit.toFixed(4)}`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) }
  );
}

async function showVaultsPortfolio(ctx) {
  const user = deps.requireUser ? deps.requireUser(ctx) : db.getUser(ctx.from.id);
  if (!user) return;
  const context = deps.getContext ? deps.getContext(ctx.from.id) : "personal";
  const wallet = getAccountWallet(user, context);
  const vaults = await pods.getCuratedSavingsVaults();

  const lines = [];
  const buttons = [];
  for (const v of vaults) {
    const pos = await pods.getStrategyPosition(v.id, wallet).catch(() => null);
    const bal = pos?.currentPosition || 0;
    const pend = pos?.requestedToLend || 0;
    if (bal > 0.001 || pend > 0.001) {
      lines.push(
        `• <b>${escapeHtml(v.name)}</b> (${v.apyPct}% APY): <b>$${bal.toFixed(2)}</b>` +
        (pos?.profit > 0 ? ` (+$${pos.profit.toFixed(4)} yield)` : "") +
        (pend > 0 ? ` · ⏳ Pending` : "")
      );
      buttons.push([Markup.button.callback(`Manage ${v.name}`, `pods_vault_view_${v.shortId}`)]);
    }
  }

  if (!lines.length) {
    return ctx.reply(
      `📊 <b>My Savings Vaults</b>\n──────────────────────────\n` +
      `No active vault deposits yet. Start earning with OpenCover-insured USD savings or Tokenized US T-Bills:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🛡️ Explore Savings Vaults", "pods_vaults_menu")],
          [Markup.button.callback("⬅️ Back", "pods_hub")],
        ]),
      }
    );
  }

  buttons.push([Markup.button.callback("➕ Deposit More", "pods_vaults_menu")]);
  buttons.push([Markup.button.callback("⬅️ Back", "pods_hub")]);

  return ctx.reply(
    `📊 <b>My Savings Vaults</b>\n──────────────────────────\n${lines.join("\n")}`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) }
  );
}

function registerInvestmentFlows(bot, injectedDeps = {}) {
  deps = injectedDeps;

  bot.action("pods_hub", async (ctx) => { await safeAnswerCbQuery(ctx); return showInvestmentsHub(ctx); });
  bot.action("pods_stocks_menu", async (ctx) => { await safeAnswerCbQuery(ctx); return showStocksMenu(ctx); });
  bot.action("pods_stocks_portfolio", async (ctx) => { await safeAnswerCbQuery(ctx); return showStocksPortfolio(ctx); });
  bot.action("pods_vaults_menu", async (ctx) => { await safeAnswerCbQuery(ctx); return showVaultsMenu(ctx); });
  bot.action("pods_vaults_portfolio", async (ctx) => { await safeAnswerCbQuery(ctx); return showVaultsPortfolio(ctx); });

  bot.action(/^pods_accept_disc_(hub|stocks|vaults)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    podsStore.acceptInvestmentsDisclaimer(ctx.from.id);
    const dest = ctx.match[1];
    if (dest === "stocks") return showStocksMenu(ctx);
    if (dest === "vaults") return showVaultsMenu(ctx);
    return showInvestmentsHub(ctx);
  });

  bot.action("pods_stocks_search", async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const context = deps.getContext ? deps.getContext(ctx.from.id) : "personal";
    convState.setState(ctx.from.id, "pods_stock_search", {}, context);
    return ctx.reply(
      `🔍 <b>Search 470+ US Stocks &amp; ETFs</b>\n──────────────────────────\n` +
      `Type a stock ticker or company name (e.g. <code>NVDA</code>, <code>AAPL</code>, <code>SPY</code>, <code>UBER</code>):`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "pods_stocks_menu")]]) }
    );
  });

  bot.action(/^pods_stock_view_([A-Za-z0-9.-]+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    return showStockDetail(ctx, ctx.match[1]);
  });

  bot.action(/^pods_stock_buy_([A-Za-z0-9.-]+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const ticker = pods.normalizeTicker(ctx.match[1]);
    const context = deps.getContext ? deps.getContext(ctx.from.id) : "personal";
    convState.setState(ctx.from.id, "pods_stock_buy_amount", { ticker }, context);
    return ctx.reply(
      `🟢 <b>Buy ${escapeHtml(ticker)}</b>\n──────────────────────────\n` +
      `Enter the USD amount to invest (minimum <b>$${pods.MIN_STOCK_BUY_USD}</b>, e.g. <code>25</code> or <code>100</code>):`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `pods_stock_view_${ticker}`)]]) }
    );
  });

  bot.action(/^pods_stock_sell_([A-Za-z0-9.-]+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const ticker = pods.normalizeTicker(ctx.match[1]);
    const context = deps.getContext ? deps.getContext(ctx.from.id) : "personal";
    convState.setState(ctx.from.id, "pods_stock_sell_pin", { ticker, pct: 100 }, context);
    return ctx.reply(
      `🔴 <b>Sell ${escapeHtml(ticker)} (100% of position)</b>\n──────────────────────────\n` +
      `Proceeds will settle back into your Proxim USD balance.\n\nEnter your <b>4-digit PIN</b> to confirm:`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `pods_stock_view_${ticker}`)]]) }
    );
  });

  bot.action(/^pods_vault_view_([a-z0-9]+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    return showVaultDetail(ctx, ctx.match[1]);
  });

  bot.action(/^pods_vault_dep_([a-z0-9]+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const vault = pods.getSavingsVaultByShortId(ctx.match[1]);
    if (!vault) return ctx.reply("Vault not found.");
    const context = deps.getContext ? deps.getContext(ctx.from.id) : "personal";
    convState.setState(ctx.from.id, "pods_vault_dep_amount", { shortId: vault.shortId, vaultId: vault.id, vaultName: vault.name }, context);
    return ctx.reply(
      `➕ <b>Deposit into ${escapeHtml(vault.name)}</b>\n──────────────────────────\n` +
      `🔒 Lock: ${escapeHtml(vault.lockPeriod)} · 🔓 Unlock: ${escapeHtml(vault.unlockPeriod)}\n\n` +
      `Enter the USD amount to deposit (minimum <b>$${pods.MIN_VAULT_DEPOSIT_USD}</b>):`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `pods_vault_view_${vault.shortId}`)]]) }
    );
  });

  bot.action(/^pods_vault_wdr_([a-z0-9]+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const vault = pods.getSavingsVaultByShortId(ctx.match[1]);
    if (!vault) return ctx.reply("Vault not found.");
    const context = deps.getContext ? deps.getContext(ctx.from.id) : "personal";
    convState.setState(ctx.from.id, "pods_vault_wdr_pin", { shortId: vault.shortId, vaultId: vault.id, vaultName: vault.name }, context);
    return ctx.reply(
      `➖ <b>Withdraw from ${escapeHtml(vault.name)}</b>\n──────────────────────────\n` +
      `🔓 Unlock window: <b>${escapeHtml(vault.unlockPeriod)}</b>\n` +
      `Funds return to your Proxim USD balance.\n\nEnter your <b>4-digit PIN</b> to confirm:`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `pods_vault_view_${vault.shortId}`)]]) }
    );
  });
}

async function handleInvestmentTextState(ctx, state, text, userId) {
  if (!state || !handlesState(state.type)) return false;
  const user = deps.requireUser ? deps.requireUser(ctx) : db.getUser(userId);
  if (!user) return true;
  const context = state.context || (deps.getContext ? deps.getContext(userId) : "personal");
  const wallet = getAccountWallet(user, context);

  // 1. Search stocks
  if (state.type === "pods_stock_search") {
    convState.clearState(userId);
    const matches = await pods.searchStocks(text, 9);
    if (!matches.length) {
      await ctx.reply(
        `No matching US stock found for "<b>${escapeHtml(text)}</b>". Try a ticker like <code>AAPL</code>, <code>NVDA</code>, or <code>SPY</code>.`,
        { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔍 Try Again", "pods_stocks_search")]]) }
      );
      return true;
    }
    const rows = matches.map((m) => [
      Markup.button.callback(`${m.icon} ${m.ticker} — ${m.name}`, `pods_stock_view_${m.ticker}`),
    ]);
    rows.push([Markup.button.callback("⬅️ Back", "pods_stocks_menu")]);
    await ctx.reply(
      `🔍 <b>Matches for "${escapeHtml(text)}"</b>`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) }
    );
    return true;
  }

  // 2. Stock buy amount -> ask PIN
  if (state.type === "pods_stock_buy_amount") {
    const amount = parseFloat(String(text || "").replace(/[^0-9.]/g, ""));
    const ticker = state.data.ticker;
    if (!Number.isFinite(amount) || amount < pods.MIN_STOCK_BUY_USD) {
      await ctx.reply(`Minimum stock purchase is <b>$${pods.MIN_STOCK_BUY_USD}</b>. Enter an amount like <code>25</code>:`, { parse_mode: "HTML" });
      return true;
    }
    convState.setState(userId, "pods_stock_buy_pin", { ticker, amount }, context);
    await ctx.reply(
      `🔐 <b>Confirm Stock Purchase</b>\n──────────────────────────\n` +
      `• <b>Stock:</b> ${escapeHtml(ticker)}\n` +
      `• <b>Amount:</b> $${amount.toFixed(2)} USD\n` +
      `• <b>Settlement:</b> ~2–5 min (Ondo Global Markets)\n\n` +
      `Enter your <b>4-digit PIN</b> to execute:`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `pods_stock_view_${ticker}`)]]) }
    );
    return true;
  }

  // 3. Stock buy PIN -> execute bridge + EIP-7702 atomic buy
  if (state.type === "pods_stock_buy_pin") {
    if (deps.deleteSensitiveMessage) await deps.deleteSensitiveMessage(ctx);
    if (!/^\d{4}$/.test(text)) { await ctx.reply("Enter your 4-digit PIN."); return true; }
    if (!db.verifyPin(userId, text)) { convState.clearState(userId); await ctx.reply("Incorrect PIN."); return true; }

    const { ticker, amount } = state.data;
    convState.clearState(userId);
    await ctx.reply(`⏳ Preparing your <b>$${amount.toFixed(2)} ${escapeHtml(ticker)}</b> order…`, { parse_mode: "HTML" });

    try {
      const status = await pods.getStockMarketStatus(ticker);
      if (!status.tradable) {
        await ctx.reply(`🔴 <b>${escapeHtml(ticker)}</b> is currently not tradable (${escapeHtml(status.blockingReason || status.marketStatus)}). Please try during market hours.`, { parse_mode: "HTML" });
        return true;
      }

      const privateKey = decryptContextKey(text, user, context);
      await podsExecutor.ensureBaseUsdcForInvestment({ privateKey, userAddress: wallet, amountUsdc: amount, telegramId: userId });

      const strategyId = pods.toOndoStrategyId(ticker);
      const res = await pods.getStrategyBytecode({
        strategyId,
        action: "buy",
        amount: podsExecutor.toBaseUsdcUnits(amount),
        wallet,
        fromChainId: pods.BASE_CHAIN_ID,
        fromTokenAddress: pods.BASE_USDC_ADDRESS,
        webhookURL: getPodsWebhookUrl(),
      });

      const execRes = await podsExecutor.executePodsBytecodeAtomic({
        privateKey,
        chainId: pods.BASE_CHAIN_ID,
        bytecodeLegs: res.bytecode || res.transactionData,
      });

      podsStore.recordPodsAction({
        telegramId: userId,
        accountType: context,
        walletAddress: wallet,
        kind: "stock_buy",
        strategyId,
        ticker,
        amountUsd: amount,
        txHash: execRes.txHash,
        podsActionId: res.id || null,
        status: "PENDING",
        meta: { priceAtOrder: status.price, quote: res.quote || null },
      });

      await ctx.reply(
        `✅ <b>${escapeHtml(ticker)} Buy Order Submitted!</b>\n──────────────────────────\n` +
        `• <b>Amount:</b> $${amount.toFixed(2)} USD\n` +
        (status.price ? `• <b>Est. Price:</b> $${status.price.toFixed(2)}\n` : "") +
        `• <b>Tx:</b> <code>${escapeHtml(execRes.txHash)}</code>\n` +
        (res.id ? `• <b>Order Ref:</b> <code>${escapeHtml(res.id)}</code>\n` : "") +
        `\n⏳ <i>Ondo Global Markets is filling your order (~2–5 min). You'll get a confirmation message the moment it settles!</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("💼 My Stock Portfolio", "pods_stocks_portfolio")],
            [Markup.button.callback("🏠 Main Menu", "main_menu")],
          ]),
        }
      );
    } catch (err) {
      console.error("[flows_investments:stock_buy]", err.response?.data || err.message);
      const errMsg = err.response?.data?.error?.message || err.message;
      await ctx.reply(`❌ Stock purchase failed: ${escapeHtml(errMsg)}`, { parse_mode: "HTML" });
    }
    return true;
  }

  // 4. Stock sell PIN -> execute BSC atomic sell -> payout to Base USDC -> auto-sweep to Arc
  if (state.type === "pods_stock_sell_pin") {
    if (deps.deleteSensitiveMessage) await deps.deleteSensitiveMessage(ctx);
    if (!/^\d{4}$/.test(text)) { await ctx.reply("Enter your 4-digit PIN."); return true; }
    if (!db.verifyPin(userId, text)) { convState.clearState(userId); await ctx.reply("Incorrect PIN."); return true; }

    const { ticker } = state.data;
    convState.clearState(userId);
    await ctx.reply(`⏳ Submitting your <b>${escapeHtml(ticker)}</b> sell order…`, { parse_mode: "HTML" });

    try {
      const strategyId = pods.toOndoStrategyId(ticker);
      const pos = await pods.getStrategyPosition(strategyId, wallet);
      if (!pos.currentPosition || pos.currentPosition <= 0) {
        await ctx.reply(`You don't have an active <b>${escapeHtml(ticker)}</b> share balance to sell.`, { parse_mode: "HTML" });
        return true;
      }

      const privateKey = decryptContextKey(text, user, context);
      const shareBaseUnits = parseUnits(pos.currentPosition.toFixed(18), 18).toString();
      const res = await pods.getStrategyBytecode({
        strategyId,
        action: "sell",
        amount: shareBaseUnits,
        wallet,
        toChainId: pods.BASE_CHAIN_ID,
        toTokenAddress: pods.BASE_USDC_ADDRESS,
        webhookURL: getPodsWebhookUrl(),
      });

      const execRes = await podsExecutor.executePodsBytecodeAtomic({
        privateKey,
        chainId: pods.BSC_CHAIN_ID,
        bytecodeLegs: res.bytecode || res.transactionData,
      });

      podsStore.recordPodsAction({
        telegramId: userId,
        accountType: context,
        walletAddress: wallet,
        kind: "stock_sell",
        strategyId,
        ticker,
        amountUsd: pos.currentPositionUsd || 0,
        txHash: execRes.txHash,
        podsActionId: res.id || null,
        status: "PENDING",
        meta: { sharesSold: pos.currentPosition },
      });

      await ctx.reply(
        `✅ <b>${escapeHtml(ticker)} Sell Order Submitted!</b>\n──────────────────────────\n` +
        `• <b>Shares:</b> ${pos.currentPosition.toFixed(4)} ${escapeHtml(ticker)}\n` +
        `• <b>Tx:</b> <code>${escapeHtml(execRes.txHash)}</code>\n` +
        `\n⏳ <i>Once filled (~2–5 min), USDC settles automatically back into your Proxim USD balance.</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("💼 My Stock Portfolio", "pods_stocks_portfolio")]]),
        }
      );
    } catch (err) {
      console.error("[flows_investments:stock_sell]", err.response?.data || err.message);
      const errMsg = err.response?.data?.error?.message || err.message;
      await ctx.reply(`❌ Stock sale failed: ${escapeHtml(errMsg)}`, { parse_mode: "HTML" });
    }
    return true;
  }

  // 5. Vault deposit amount -> ask PIN
  if (state.type === "pods_vault_dep_amount") {
    const amount = parseFloat(String(text || "").replace(/[^0-9.]/g, ""));
    const { shortId, vaultId, vaultName } = state.data;
    if (!Number.isFinite(amount) || amount < pods.MIN_VAULT_DEPOSIT_USD) {
      await ctx.reply(`Minimum deposit is <b>$${pods.MIN_VAULT_DEPOSIT_USD}</b>. Enter an amount:`, { parse_mode: "HTML" });
      return true;
    }
    convState.setState(userId, "pods_vault_dep_pin", { shortId, vaultId, vaultName, amount }, context);
    await ctx.reply(
      `🔐 <b>Confirm Savings Deposit</b>\n──────────────────────────\n` +
      `• <b>Vault:</b> ${escapeHtml(vaultName)}\n` +
      `• <b>Amount:</b> $${amount.toFixed(2)} USD\n\n` +
      `Enter your <b>4-digit PIN</b> to deposit:`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `pods_vault_view_${shortId}`)]]) }
    );
    return true;
  }

  // 6. Vault deposit PIN -> execute
  if (state.type === "pods_vault_dep_pin") {
    if (deps.deleteSensitiveMessage) await deps.deleteSensitiveMessage(ctx);
    if (!/^\d{4}$/.test(text)) { await ctx.reply("Enter your 4-digit PIN."); return true; }
    if (!db.verifyPin(userId, text)) { convState.clearState(userId); await ctx.reply("Incorrect PIN."); return true; }

    const { shortId, vaultId, vaultName, amount } = state.data;
    const vault = pods.getSavingsVaultByShortId(shortId);
    convState.clearState(userId);
    await ctx.reply(`⏳ Depositing <b>$${amount.toFixed(2)}</b> into <b>${escapeHtml(vaultName)}</b>…`, { parse_mode: "HTML" });

    try {
      const privateKey = decryptContextKey(text, user, context);
      await podsExecutor.ensureBaseUsdcForInvestment({ privateKey, userAddress: wallet, amountUsdc: amount, telegramId: userId });

      const isCrossChain = vault.chainId !== pods.BASE_CHAIN_ID;
      const res = await pods.getStrategyBytecode({
        strategyId: vaultId,
        action: vault.depositAction || "lend",
        amount: podsExecutor.toBaseUsdcUnits(amount),
        wallet,
        ...(isCrossChain ? { fromChainId: pods.BASE_CHAIN_ID, fromTokenAddress: pods.BASE_USDC_ADDRESS } : {}),
        webhookURL: getPodsWebhookUrl(),
      });

      const execRes = await podsExecutor.executePodsBytecodeAtomic({
        privateKey,
        chainId: pods.BASE_CHAIN_ID,
        bytecodeLegs: res.bytecode || res.transactionData,
      });

      podsStore.recordPodsAction({
        telegramId: userId,
        accountType: context,
        walletAddress: wallet,
        kind: "vault_deposit",
        strategyId: vaultId,
        amountUsd: amount,
        txHash: execRes.txHash,
        podsActionId: res.id || null,
        status: isCrossChain ? "PENDING" : "SUCCESS",
      });

      await ctx.reply(
        `✅ <b>Savings Deposit Submitted!</b>\n──────────────────────────\n` +
        `• <b>Vault:</b> ${escapeHtml(vaultName)}\n` +
        `• <b>Amount:</b> $${amount.toFixed(2)} USD\n` +
        `• <b>Tx:</b> <code>${escapeHtml(execRes.txHash)}</code>\n` +
        `\n✨ <i>Your balance is now earning yield automatically!</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("📊 My Vaults", "pods_vaults_portfolio")]]),
        }
      );
    } catch (err) {
      console.error("[flows_investments:vault_dep]", err.response?.data || err.message);
      const errMsg = err.response?.data?.error?.message || err.message;
      await ctx.reply(`❌ Vault deposit failed: ${escapeHtml(errMsg)}`, { parse_mode: "HTML" });
    }
    return true;
  }

  // 7. Vault withdraw PIN -> execute
  if (state.type === "pods_vault_wdr_pin") {
    if (deps.deleteSensitiveMessage) await deps.deleteSensitiveMessage(ctx);
    if (!/^\d{4}$/.test(text)) { await ctx.reply("Enter your 4-digit PIN."); return true; }
    if (!db.verifyPin(userId, text)) { convState.clearState(userId); await ctx.reply("Incorrect PIN."); return true; }

    const { shortId, vaultId, vaultName } = state.data;
    const vault = pods.getSavingsVaultByShortId(shortId);
    convState.clearState(userId);
    await ctx.reply(`⏳ Initiating withdrawal from <b>${escapeHtml(vaultName)}</b>…`, { parse_mode: "HTML" });

    try {
      const pos = await pods.getStrategyPosition(vaultId, wallet);
      if (!pos.currentPosition || pos.currentPosition <= 0) {
        await ctx.reply(`No active balance found in <b>${escapeHtml(vaultName)}</b>.`, { parse_mode: "HTML" });
        return true;
      }
      const privateKey = decryptContextKey(text, user, context);
      const isCrossChain = vault.chainId !== pods.BASE_CHAIN_ID;
      const decimals = Number(
        pos.raw?.strategy?.decimals ??
        pos.raw?.asset?.decimals ??
        (vault.chainId === pods.BASE_CHAIN_ID ? 6 : 18)
      );
      const amtUnits = parseUnits(pos.currentPosition.toFixed(Math.min(decimals, 18)), decimals).toString();

      const res = await pods.getStrategyBytecode({
        strategyId: vaultId,
        action: vault.withdrawAction || "withdraw",
        amount: amtUnits,
        wallet,
        ...(isCrossChain ? { toChainId: pods.BASE_CHAIN_ID, toTokenAddress: pods.BASE_USDC_ADDRESS } : {}),
        webhookURL: getPodsWebhookUrl(),
      });

      const execRes = await podsExecutor.executePodsBytecodeAtomic({
        privateKey,
        chainId: vault.chainId,
        bytecodeLegs: res.bytecode || res.transactionData,
      });

      podsStore.recordPodsAction({
        telegramId: userId,
        accountType: context,
        walletAddress: wallet,
        kind: "vault_withdraw",
        strategyId: vaultId,
        amountUsd: pos.currentPosition,
        txHash: execRes.txHash,
        podsActionId: res.id || null,
        status: "PENDING",
      });

      await ctx.reply(
        `✅ <b>Withdrawal Submitted!</b>\n──────────────────────────\n` +
        `• <b>Vault:</b> ${escapeHtml(vaultName)}\n` +
        `• <b>Amount:</b> ~$${pos.currentPosition.toFixed(2)}\n` +
        `• <b>Unlock Window:</b> ${escapeHtml(vault.unlockPeriod)}\n` +
        `• <b>Tx:</b> <code>${escapeHtml(execRes.txHash)}</code>\n` +
        `\n<i>Funds settle straight back into your Proxim USD balance.</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("📊 My Vaults", "pods_vaults_portfolio")]]),
        }
      );
    } catch (err) {
      console.error("[flows_investments:vault_wdr]", err.response?.data || err.message);
      const errMsg = err.response?.data?.error?.message || err.message;
      await ctx.reply(`❌ Withdrawal failed: ${escapeHtml(errMsg)}`, { parse_mode: "HTML" });
    }
    return true;
  }

  return false;
}

module.exports = {
  handlesState,
  showInvestmentsHub,
  showStocksMenu,
  showVaultsMenu,
  registerInvestmentFlows,
  handleInvestmentTextState,
};
