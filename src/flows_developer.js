// src/flows_developer.js
// Proxim Developer Portal & Builder API Keys Flow
// Allows developers to generate, customize features, and manage API keys directly via the bot.

const { Markup } = require("telegraf");
const apiKeys = require("./api_keys");
const convState = require("./conversation_state");

let deps = {};

function registerDeveloperFlows(bot, depsIn = {}) {
  deps = { bot, ...depsIn };
  const { requireUser } = deps;

  // ── Commands ─────────────────────────────────────────────────────────────
  bot.command(["developer", "developers", "api", "apikeys"], async (ctx) => {
    const user = requireUser(ctx);
    if (!user) return;
    return showDeveloperMenu(ctx);
  });

  // ── Actions ──────────────────────────────────────────────────────────────
  bot.action("action_developer_menu", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const user = requireUser(ctx);
    if (!user) return;
    return showDeveloperMenu(ctx);
  });

  bot.action("action_dev_new_key", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const user = requireUser(ctx);
    if (!user) return;

    convState.setState(ctx.from.id, "await_dev_app_name", {}, "personal");

    return ctx.reply(
      `🛠️ <b>Create Builder API Key</b>\n──────────────────────────\n` +
      `Enter a name for your application or service (e.g. <code>My Fintech App</code>, <code>Storefront POS</code>, <code>CrossChain Bot</code>):\n\n` +
      `<i>Type cancel to return to menu.</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_developer_menu")]]),
      }
    );
  });

  bot.action("action_dev_list_keys", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const user = requireUser(ctx);
    if (!user) return;
    return showDeveloperKeysList(ctx);
  });

  bot.action("action_dev_feat_all", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const user = requireUser(ctx);
    if (!user) return;

    const state = convState.getState(ctx.from.id);
    const appName = state?.data?.appName || "Builder App";
    convState.clearState(ctx.from.id);

    try {
      const created = apiKeys.generateApiKey({
        telegramId: ctx.from.id,
        appName,
        features: ["all"],
      });

      return showKeyCreatedSuccess(ctx, created);
    } catch (err) {
      return ctx.reply(`❌ Failed to create API key: ${err.message}`, deps.backToMenu);
    }
  });

  bot.action("action_dev_feat_custom_start", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const user = requireUser(ctx);
    if (!user) return;

    const state = convState.getState(ctx.from.id);
    const appName = state?.data?.appName || "Builder App";
    const selected = state?.data?.selectedFeatures || ["wallets", "transfers"];

    convState.setState(ctx.from.id, "dev_customizing_features", { appName, selectedFeatures: selected }, "personal");
    return showCustomFeatureSelection(ctx, appName, selected);
  });

  bot.action(/^action_dev_toggle_feat_([a-z_]+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const feat = ctx.match[1];
    const state = convState.getState(ctx.from.id);
    if (!state || !state.data) return showDeveloperMenu(ctx);

    let selected = state.data.selectedFeatures || [];
    if (selected.includes(feat)) {
      selected = selected.filter((f) => f !== feat);
    } else {
      selected.push(feat);
    }

    if (selected.length === 0) selected = ["wallets"]; // keep at least 1

    state.data.selectedFeatures = selected;
    convState.setState(ctx.from.id, state.type, state.data, "personal");

    return showCustomFeatureSelection(ctx, state.data.appName, selected);
  });

  bot.action("action_dev_generate_custom_key", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const state = convState.getState(ctx.from.id);
    const appName = state?.data?.appName || "Builder App";
    const features = state?.data?.selectedFeatures || ["wallets"];
    convState.clearState(ctx.from.id);

    try {
      const created = apiKeys.generateApiKey({
        telegramId: ctx.from.id,
        appName,
        features,
      });

      return showKeyCreatedSuccess(ctx, created);
    } catch (err) {
      return ctx.reply(`❌ Failed to create API key: ${err.message}`, deps.backToMenu);
    }
  });

  bot.action(/^action_dev_revoke_([a-zA-Z0-9_]+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const keyId = ctx.match[1];
    apiKeys.revokeApiKey(keyId, ctx.from.id);
    await ctx.reply(`🗑️ <b>API Key Revoked</b>\nKey <code>${keyId}</code> has been deactivated and can no longer be used.`, { parse_mode: "HTML" });
    return showDeveloperKeysList(ctx);
  });

  bot.action(/^action_dev_edit_([a-zA-Z0-9_]+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const keyId = ctx.match[1];
    const keys = apiKeys.listApiKeys(ctx.from.id);
    const target = keys.find((k) => k.key_id === keyId);
    if (!target) return ctx.reply("Key not found.", deps.backToMenu);

    const currentFeats = target.allowed_features || [];
    convState.setState(ctx.from.id, "dev_editing_key_features", { keyId, appName: target.app_name, selectedFeatures: currentFeats }, "personal");
    return showCustomFeatureSelection(ctx, target.app_name, currentFeats, keyId);
  });

  bot.action(/^action_dev_save_edit_([a-zA-Z0-9_]+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const keyId = ctx.match[1];
    const state = convState.getState(ctx.from.id);
    const selected = state?.data?.selectedFeatures || ["all"];
    convState.clearState(ctx.from.id);

    try {
      apiKeys.updateApiKeyFeatures(keyId, selected, ctx.from.id);
      await ctx.reply(`✅ <b>Features Updated!</b>\nYour API key features have been updated to:\n• <code>${selected.join(", ")}</code>`, { parse_mode: "HTML" });
      return showDeveloperKeysList(ctx);
    } catch (err) {
      return ctx.reply(`❌ Failed to update features: ${err.message}`, deps.backToMenu);
    }
  });

  bot.action("action_dev_docs", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    return ctx.reply(
      `📖 <b>Proxim Builder API Quickstart</b>\n──────────────────────────\n` +
      `<b>Base URL:</b> <code>https://api.proxim.finance/api/v1</code> (or your deployed URL)\n\n` +
      `<b>Authentication:</b>\n` +
      `Send your API key in the headers of any request:\n` +
      `<code>Authorization: Bearer prx_live_...</code>\n\n` +
      `<b>Core Endpoints:</b>\n` +
      `• <code>GET /api/v1/auth/me</code> — Verify key & limits\n` +
      `• <code>POST /api/v1/wallets</code> — Create customer wallet\n` +
      `• <code>GET /api/v1/wallets/:id/balance</code> — Check unified balances\n` +
      `• <code>POST /api/v1/transfers</code> — Send USDC instantly\n` +
      `• <code>POST /api/v1/invoices</code> — Create payment invoice\n` +
      `• <code>POST /api/v1/onramp/bank-transfer</code> — Virtual Nigerian bank account\n` +
      `• <code>POST /api/v1/intents/deposits/robinhood</code> — Robinhood Chain deposit\n` +
      `• <code>POST /api/v1/intents/deposits/solana</code> — Solana deposit\n` +
      `• <code>GET /api/v1/savings/rates</code> — USDC yield vaults\n\n` +
      `<i>Full interactive documentation is available in <code>BUILDER_API.md</code></i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("➕ Generate API Key", "action_dev_new_key")],
          [Markup.button.callback("🔑 My API Keys", "action_dev_list_keys")],
          [Markup.button.callback("🏠 Main Menu", "main_menu")],
        ]),
      }
    );
  });
}

async function showDeveloperMenu(ctx) {
  const keys = apiKeys.listApiKeys(ctx.from.id).filter((k) => k.is_active);

  return ctx.reply(
    `🛠️ <b>Proxim Developer Portal</b>\n──────────────────────────\n` +
    `Build your own apps with <b>100% of Proxim</b> via REST API keys:\n\n` +
    `• 👛 <b>Multichain Wallets</b> (Arc, Solana, NEAR, Robinhood)\n` +
    `• 💸 <b>Instant Transfers</b> (Gasless & micro-second finality on Arc)\n` +
    `• 🧾 <b>Invoicing & QR Checkout</b> (USDC & Naira)\n` +
    `• 🇳🇬 <b>Fiat Onramp & Offramp</b> (Virtual Nigerian bank accounts)\n` +
    `• 🏹 <b>NEAR Intents</b> (Cross-chain swaps: Robinhood Chain, Solana, NEAR)\n` +
    `• 📈 <b>Savings & Yield Vaults</b> (ERC-4626 USDC earn)\n` +
    `• 🧾 <b>Cryptographic Receipts</b> (Instant proof generation)\n\n` +
    `<b>Active API Keys:</b> ${keys.length}\n` +
    `<i>Customize your key to only enable the features your app needs, or get full 100% access.</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("➕ Generate New API Key", "action_dev_new_key")],
        [Markup.button.callback(`🔑 My API Keys (${keys.length})`, "action_dev_list_keys")],
        [Markup.button.callback("📖 API Quickstart & Docs", "action_dev_docs")],
        [Markup.button.callback("🏠 Main Menu", "main_menu")],
      ]),
    }
  );
}

async function showDeveloperKeysList(ctx) {
  const keys = apiKeys.listApiKeys(ctx.from.id);
  const activeKeys = keys.filter((k) => k.is_active);

  if (activeKeys.length === 0) {
    return ctx.reply(
      `🔑 <b>My API Keys</b>\n──────────────────────────\n` +
      `You haven't generated any API keys yet.\n` +
      `Create one to start building your own applications on top of Proxim!`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("➕ Generate New API Key", "action_dev_new_key")],
          [Markup.button.callback("« Back to Portal", "action_developer_menu")],
        ]),
      }
    );
  }

  let text = `🔑 <b>My API Keys (${activeKeys.length})</b>\n──────────────────────────\n\n`;
  const buttons = [];

  for (const k of activeKeys) {
    const feats = k.allowed_features.includes("all") ? "100% Full Access" : k.allowed_features.join(", ");
    text += `📱 <b>${k.app_name}</b>\n` +
      `• Key ID: <code>${k.key_id}</code>\n` +
      `• Prefix: <code>${k.key_prefix}</code>\n` +
      `• Features: <i>${feats}</i>\n` +
      `• Rate Limit: ${k.rate_limit_per_min} req/min\n` +
      `• Created: ${k.created_at}\n\n`;

    buttons.push([
      Markup.button.callback(`⚙️ Edit Features (${k.app_name})`, `action_dev_edit_${k.key_id}`),
      Markup.button.callback(`🗑️ Revoke`, `action_dev_revoke_${k.key_id}`),
    ]);
  }

  buttons.push([Markup.button.callback("➕ Generate New Key", "action_dev_new_key")]);
  buttons.push([Markup.button.callback("« Back to Portal", "action_developer_menu")]);

  return ctx.reply(text, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(buttons),
  });
}

function showCustomFeatureSelection(ctx, appName, selected = [], editingKeyId = null) {
  const featuresList = [
    { id: "wallets", name: "👛 Wallets" },
    { id: "transfers", name: "💸 Transfers" },
    { id: "invoices", name: "🧾 Invoices" },
    { id: "onramp", name: "🇳🇬 Naira Onramp" },
    { id: "offramp", name: "🏦 Naira Offramp" },
    { id: "crypto_deposits", name: "🌐 EVM Deposits" },
    { id: "near_intents", name: "🏹 Robinhood / NEAR" },
    { id: "savings", name: "📈 Yield Savings" },
    { id: "receipts", name: "🧾 Receipts" },
  ];

  const rows = [];
  for (let i = 0; i < featuresList.length; i += 2) {
    const row = [];
    const f1 = featuresList[i];
    const isSel1 = selected.includes(f1.id);
    row.push(Markup.button.callback(`${isSel1 ? "✅" : "⬜"} ${f1.name}`, `action_dev_toggle_feat_${f1.id}`));

    if (i + 1 < featuresList.length) {
      const f2 = featuresList[i + 1];
      const isSel2 = selected.includes(f2.id);
      row.push(Markup.button.callback(`${isSel2 ? "✅" : "⬜"} ${f2.name}`, `action_dev_toggle_feat_${f2.id}`));
    }
    rows.push(row);
  }

  const confirmAction = editingKeyId
    ? `action_dev_save_edit_${editingKeyId}`
    : "action_dev_generate_custom_key";

  rows.push([Markup.button.callback(`🚀 ${editingKeyId ? "Save Changes" : "Create Key"} (${selected.length} features)`, confirmAction)]);
  rows.push([Markup.button.callback("❌ Cancel", "action_developer_menu")]);

  return ctx.reply(
    `⚙️ <b>Customize Features for "${appName}"</b>\n──────────────────────────\n` +
    `Tap to toggle the features your app will have access to:\n\n` +
    `<i>Selected: ${selected.length} features</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(rows),
    }
  );
}

function showKeyCreatedSuccess(ctx, created) {
  const feats = created.allowedFeatures.includes("all")
    ? "🌟 100% Full Access (All Features)"
    : created.allowedFeatures.map((f) => `• <code>${f}</code>`).join("\n");

  return ctx.reply(
    `🎉 <b>API Key Generated!</b>\n──────────────────────────\n` +
    `📱 <b>App Name:</b> ${created.appName}\n` +
    `🔑 <b>Key ID:</b> <code>${created.keyId}</code>\n` +
    `⚡ <b>Rate Limit:</b> ${created.rateLimitPerMin} req/min\n\n` +
    `🔐 <b>Your Secret API Key:</b>\n` +
    `<code>${created.secretKey}</code>\n\n` +
    `⚠️ <b>IMPORTANT:</b> Copy and save this key right now! For security reasons, you will NOT be able to view the secret key again.\n\n` +
    `<b>Enabled Features:</b>\n${feats}\n\n` +
    `🧪 <b>Quick Test (curl):</b>\n` +
    `<code>curl -H "Authorization: Bearer ${created.secretKey}" https://api.proxim.finance/api/v1/auth/me</code>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔑 View All Keys", "action_dev_list_keys")],
        [Markup.button.callback("📖 API Docs", "action_dev_docs")],
        [Markup.button.callback("🏠 Main Menu", "main_menu")],
      ]),
    }
  );
}

async function handleDeveloperState(bot, ctx, state, text, userId) {
  if (state.type === "await_dev_app_name") {
    const appName = text.trim();
    if (!appName || appName.length < 2) {
      return ctx.reply("Please enter a valid application name (at least 2 characters). Type cancel to abort.");
    }

    convState.setState(userId, "dev_feature_selection", { appName }, "personal");

    return ctx.reply(
      `🛠️ <b>Choose Access Level for "${appName}"</b>\n──────────────────────────\n` +
      `How would you like to configure feature access for this key?\n\n` +
      `• <b>100% Full Access:</b> Get all existing & future Proxim capabilities (Wallets, Transfers, Invoices, Fiat On/Offramp, NEAR Intents, Robinhood Chain, Yield, etc.).\n` +
      `• <b>Custom Features:</b> Select only specific features needed for your app.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🌟 100% Full Access (Recommended)", "action_dev_feat_all")],
          [Markup.button.callback("⚙️ Customize Specific Features", "action_dev_feat_custom_start")],
          [Markup.button.callback("❌ Cancel", "action_developer_menu")],
        ]),
      }
    );
  }
}

module.exports = {
  registerDeveloperFlows,
  handleDeveloperState,
  showDeveloperMenu,
};
