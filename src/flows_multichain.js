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
const { moveFundsBetweenChains, executeCrossChainWithdrawal } = require("../agent/executor");

// Bot-local helpers, injected by bot.js at registration time.
let deps = {};

function registerMultichainFlows(bot, depsIn = {}) {
  deps = { bot, ...depsIn };
  registerNearDepositActions(bot);
  registerSolanaDepositActions(bot);
  registerMoveFundsActions(bot);
  registerCrossChainWithdrawActions(bot);
}

// ─── NEAR Intents deposit (Phase 3 + Multi-token support) ───────────────────

function registerNearDepositActions(bot) {
  const { requireUser, getContext } = deps;

  bot.action("action_near_deposit", async (ctx) => {
    ctx.answerCbQuery();
    const user = requireUser(ctx);
    if (!user) return;
    return showNearTokenSelection(ctx);
  });

  bot.action(/^action_near_tok_([A-Za-z0-9_-]+)$/, async (ctx) => {
    ctx.answerCbQuery();
    const user = requireUser(ctx);
    if (!user) return;
    const sym = ctx.match[1];

    if (sym === "custom") {
      convState.setState(ctx.from.id, "await_near_custom_token", {}, getContext(ctx.from.id));
      return ctx.reply(
        `🔍 <b>Custom NEAR Token</b>\n──────────────────────────\n` +
        `Enter the token symbol (e.g. <code>AURORA</code>, <code>DAI</code>) or NEP-141 contract address (e.g. <code>wrap.near</code> or <code>nep141:...</code>):\n\n` +
        `<i>Type cancel to return.</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_near_deposit")]]),
        }
      );
    }

    const token = await nearLib.resolveNearToken(sym);
    if (!token) return ctx.reply("Token not found. Please choose from the list.", deps.backToMenu);

    convState.setState(
      ctx.from.id,
      "await_near_amount",
      {
        originAsset: token.assetId,
        originSymbol: token.symbol,
        originDecimals: token.decimals,
        minDeposit: token.minDeposit || 1,
      },
      getContext(ctx.from.id)
    );

    return ctx.reply(
      `Ⓝ <b>Deposit ${token.name || token.symbol}</b>\n──────────────────────────\n` +
      `How much <b>${token.symbol}</b> would you like to deposit? (min ${token.minDeposit || 1} ${token.symbol})\n\n` +
      `<i>NEAR Intents will auto-convert your ${token.symbol} into USDC and sweep it to your Arc balance.</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("« Back to Tokens", "action_near_deposit")]]),
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

    const inAmount = row.amount_token !== undefined && row.amount_token !== null ? Number(row.amount_token) : Number(row.amount_usdc);
    const inSymbol = row.origin_symbol || (row.origin_asset?.includes("usdc") ? "USDC" : "tokens");

    const labels = {
      quoting: "⏳ Preparing your deposit address…",
      awaiting_deposit: "⏳ Waiting for your NEAR deposit…",
      PENDING_DEPOSIT: "⏳ Waiting for deposit confirmation on NEAR…",
      KNOWN_DEPOSIT_TX: "✅ Deposit seen — confirming…",
      INCOMPLETE_DEPOSIT: "⚠️ Deposit amount didn't match exactly — refunding the difference…",
      PROCESSING: "🌉 Converting to USDC and bridging…",
      SUCCESS: "✅ Bridged to Base — sweeping into your Arc balance…",
      REFUNDED: "↩️ Refunded to your NEAR refund address.",
      FAILED: "❌ Bridge failed — contact support.",
      expired: "⏰ Deposit window expired.",
    };

    return ctx.reply(
      `Ⓝ <b>NEAR Deposit Status</b>\n──────────────────────────\n` +
      `📥 <b>Depositing:</b> ${inAmount} ${inSymbol}\n` +
      (row.amount_out ? `💵 <b>Converted to:</b> ~$${Number(row.amount_out).toFixed(2)} USDC (Arc)\n` : "") +
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

async function showNearTokenSelection(ctx) {
  const keyboard = [
    [
      Markup.button.callback("💵 USDC", "action_near_tok_USDC"),
      Markup.button.callback("🟢 USDT", "action_near_tok_USDT"),
    ],
    [
      Markup.button.callback("Ⓝ NEAR", "action_near_tok_NEAR"),
      Markup.button.callback("🪙 WBTC", "action_near_tok_WBTC"),
    ],
    [
      Markup.button.callback("🔷 WETH", "action_near_tok_WETH"),
      Markup.button.callback("🟡 DAI", "action_near_tok_DAI"),
    ],
    [
      Markup.button.callback("🔍 Other / Custom Token", "action_near_tok_custom"),
    ],
    [
      Markup.button.callback("❌ Cancel", "main_menu"),
    ],
  ];

  return ctx.reply(
    `Ⓝ <b>Deposit from NEAR (All Tokens Supported)</b>\n──────────────────────────\n` +
    `Deposit <b>any token</b> on NEAR Protocol. NEAR Intents will automatically convert your deposit into <b>USDC</b> and sweep it to your <b>Arc</b> balance (~2–5 minutes).\n\n` +
    `Select a token to deposit:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(keyboard),
    }
  );
}

// ─── Solana Deposit via NEAR Intents (1Click) ────────────────────────────────

function registerSolanaDepositActions(bot) {
  const { requireUser, getContext, getOrDeriveSolanaAddress } = deps;

  bot.action("action_solana_deposit", async (ctx) => {
    ctx.answerCbQuery();
    const user = requireUser(ctx);
    if (!user) return;
    const solAddress = getOrDeriveSolanaAddress(user);
    if (!solAddress) {
      return ctx.reply(
        `☀️ <b>Solana Deposit</b>\n──────────────────────────\n` +
        `❌ No Solana address found for your account.\n` +
        `<i>Please contact support if you believe this is an error.</i>`,
        { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "main_menu")]]) }
      );
    }
    return showSolanaTokenSelection(ctx);
  });

  bot.action(/^action_sol_tok_([A-Za-z0-9_]+)$/, async (ctx) => {
    ctx.answerCbQuery();
    const user = requireUser(ctx);
    if (!user) return;
    const sym = ctx.match[1];

    const token = await nearLib.resolveSolanaToken(sym);
    if (!token) return ctx.reply("Token not found. Please choose from the list.", deps.backToMenu);

    convState.setState(
      ctx.from.id,
      "await_solana_amount",
      {
        originAsset: token.assetId,
        originSymbol: token.symbol,
        originDecimals: token.decimals,
        minDeposit: token.minDeposit || 1,
      },
      getContext(ctx.from.id)
    );

    return ctx.reply(
      `☀️ <b>Deposit ${token.name || token.symbol} from Solana</b>\n──────────────────────────\n` +
      `How much <b>${token.symbol}</b> would you like to deposit? (min ${token.minDeposit || 1} ${token.symbol})\n\n` +
      `<i>NEAR Intents will auto-convert your ${token.symbol} into USDC and sweep it to your Arc balance.\nYou just need to send — no extra steps.</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("« Back to Tokens", "action_solana_deposit")]]),
      }
    );
  });

  // Reuse the existing near_status button for Solana deposits (same DB table)
  // action_near_status_N already handles both NEAR and Solana rows
}

async function showSolanaTokenSelection(ctx) {
  const keyboard = [
    [
      Markup.button.callback("☀️ SOL",   "action_sol_tok_SOL"),
      Markup.button.callback("💵 USDC",  "action_sol_tok_USDC"),
    ],
    [
      Markup.button.callback("🟢 USDT",  "action_sol_tok_USDT"),
      Markup.button.callback("🐕 BONK",  "action_sol_tok_BONK"),
    ],
    [
      Markup.button.callback("🎩 WIF",   "action_sol_tok_WIF"),
      Markup.button.callback("🪐 JUP",   "action_sol_tok_JUP"),
    ],
    [
      Markup.button.callback("🔮 PYTH",  "action_sol_tok_PYTH"),
    ],
    [
      Markup.button.callback("❌ Cancel", "main_menu"),
    ],
  ];

  return ctx.reply(
    `☀️ <b>Deposit from Solana</b>\n──────────────────────────\n` +
    `Send any supported Solana token to a <b>one-time deposit address</b>.\n` +
    `NEAR Intents automatically swaps it to <b>USDC on Base</b> and sweeps it to your <b>Arc</b> balance (~2–5 min).\n\n` +
    `<b>You just send — nothing else needed.</b>\n\n` +
    `Select a token to deposit:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(keyboard),
    }
  );
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
      `No Proxim fee (network gas only).</i>`,
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

// ─── Cross-Chain Withdraw / Send to Any Chain (Tier 1 CCTP + Tier 2 Intents) ─

const CCW_CHAINS = {
  solana:    { name: "Solana",     label: "☀️ Solana",     token: "USDC (SPL)",   icon: "☀️", example: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", engine: "CCTP" },
  base:      { name: "Base",       label: "🔵 Base",       token: "USDC",         icon: "🔵", example: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", engine: "CCTP" },
  arbitrum:  { name: "Arbitrum",   label: "🔷 Arbitrum",   token: "USDC",         icon: "🔷", example: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", engine: "CCTP" },
  optimism:  { name: "Optimism",   label: "🔴 Optimism",   token: "USDC",         icon: "🔴", example: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", engine: "CCTP" },
  polygon:   { name: "Polygon",    label: "🟣 Polygon",    token: "USDC",         icon: "🟣", example: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", engine: "CCTP" },
  avalanche: { name: "Avalanche",  label: "🔺 Avalanche",  token: "USDC",         icon: "🔺", example: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", engine: "CCTP" },
  ethereum:  { name: "Ethereum",   label: "🌐 Ethereum",   token: "USDC",         icon: "🌐", example: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", engine: "CCTP" },
  bitcoin:   { name: "Bitcoin",    label: "₿ Bitcoin",     token: "BTC (Native)", icon: "₿",  example: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", engine: "NEAR_INTENTS" },
  tron:      { name: "Tron",       label: "💎 Tron",       token: "USDT (TRC20)", icon: "💎", example: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", engine: "NEAR_INTENTS" },
  near:      { name: "NEAR",       label: "Ⓝ NEAR",       token: "NEAR",         icon: "Ⓝ",  example: "alice.near", engine: "NEAR_INTENTS" },
};

function validateAddressForChain(chainKey, addr) {
  const clean = String(addr || "").trim();
  if (!clean) return false;
  if (chainKey === "solana") {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(clean);
  }
  if (["base", "arbitrum", "optimism", "polygon", "avalanche", "ethereum"].includes(chainKey)) {
    return /^0x[a-fA-F0-9]{40}$/.test(clean);
  }
  if (chainKey === "bitcoin" || chainKey === "btc") {
    return /^(bc1[a-zA-HJ-NP-Z0-9]{25,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(clean);
  }
  if (chainKey === "tron") {
    return /^T[a-km-zA-HJ-NP-Z1-9]{33}$/.test(clean);
  }
  if (chainKey === "near") {
    return /^(([a-z0-9_-]+\.)*near|[a-f0-9]{64})$/.test(clean);
  }
  return true;
}

function registerCrossChainWithdrawActions(bot) {
  const { requireUser, getContext } = deps;

  bot.action("action_crosschain_withdraw", async (ctx) => {
    ctx.answerCbQuery();
    const user = requireUser(ctx);
    if (!user) return;
    return showCrossChainWithdrawChainSelection(ctx);
  });

  bot.action(/^action_ccw_chain_([a-z0-9_-]+)$/, async (ctx) => {
    ctx.answerCbQuery();
    const user = requireUser(ctx);
    if (!user) return;
    const chainKey = ctx.match[1];
    const chainInfo = CCW_CHAINS[chainKey];
    if (!chainInfo) return ctx.reply("Unsupported destination chain.", deps.backToMenu);

    convState.setState(
      ctx.from.id,
      "await_ccw_address",
      { destinationChain: chainKey, chainInfo },
      getContext(ctx.from.id)
    );

    return ctx.reply(
      `📤 <b>Withdraw to ${chainInfo.label}</b>\n──────────────────────────\n` +
      `Asset to receive: <b>${chainInfo.token}</b>\n\n` +
      `Paste the <b>${chainInfo.name} address</b> you want to withdraw to:\n\n` +
      `<i>Example: <code>${chainInfo.example}</code></i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("« Back to Chains", "action_crosschain_withdraw")]]),
      }
    );
  });
}

async function showCrossChainWithdrawChainSelection(ctx) {
  const keyboard = [
    [
      Markup.button.callback("☀️ Solana (USDC)",   "action_ccw_chain_solana"),
      Markup.button.callback("🔵 Base (USDC)",     "action_ccw_chain_base"),
    ],
    [
      Markup.button.callback("🔷 Arbitrum (USDC)", "action_ccw_chain_arbitrum"),
      Markup.button.callback("🔴 Optimism (USDC)", "action_ccw_chain_optimism"),
    ],
    [
      Markup.button.callback("🟣 Polygon (USDC)",  "action_ccw_chain_polygon"),
      Markup.button.callback("🔺 Avalanche (USDC)","action_ccw_chain_avalanche"),
    ],
    [
      Markup.button.callback("🌐 Ethereum (USDC)", "action_ccw_chain_ethereum"),
      Markup.button.callback("₿ Bitcoin (BTC)",    "action_ccw_chain_bitcoin"),
    ],
    [
      Markup.button.callback("💎 Tron (USDT)",     "action_ccw_chain_tron"),
      Markup.button.callback("Ⓝ NEAR Protocol",   "action_ccw_chain_near"),
    ],
    [
      Markup.button.callback("❌ Cancel", "main_menu"),
    ],
  ];

  return ctx.reply(
    `📤 <b>Withdraw to External Chain / Wallet</b>\n──────────────────────────\n` +
    `Withdraw your Arc balance to <b>any chain</b> with zero bridge hassle.\n\n` +
    `• <b>Solana & EVMs:</b> Instant Circle CCTP (100% native USDC, 0 slippage)\n` +
    `• <b>Bitcoin, Tron & NEAR:</b> NEAR Intent routing (auto-swapped & delivered)\n\n` +
    `Select destination chain:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(keyboard),
    }
  );
}

// ─── Text-state handlers (called from bot.js's text middleware) ───────────────

const HANDLED_STATES = new Set([
  "await_near_amount",
  "await_near_custom_token",
  "await_solana_amount",
  "await_ccw_address",
  "await_ccw_amount",
  "confirm_ccw",
  "move_funds_amount",
  "move_funds_confirm",
]);

function handlesState(stateType) {
  return HANDLED_STATES.has(stateType);
}

async function handleMultichainState(bot, ctx, state, text, userId) {
  const { requireUser, getContext, getActiveWallet, getOrDeriveSolanaAddress, deleteSensitiveMessage } = deps;

  // ── NEAR custom token entry ──────────────────────────────────────────────

  if (state.type === "await_near_custom_token") {
    const input = text.trim();
    if (shouldReprocessConversationState("await_near_custom_token", text)) {
      convState.clearState(userId);
      return bot.handleUpdate({ update_id: ctx.update.update_id, message: ctx.message });
    }

    const token = await nearLib.resolveNearToken(input);
    if (!token) {
      return ctx.reply(
        `❌ Could not resolve token "${input}". Please enter a valid symbol (e.g. DAI) or contract (e.g. wrap.near). Type cancel to stop.`
      );
    }

    convState.setState(
      userId,
      "await_near_amount",
      {
        originAsset: token.assetId,
        originSymbol: token.symbol,
        originDecimals: token.decimals,
        minDeposit: token.minDeposit || 0.001,
      },
      state.context || getContext(userId)
    );

    return ctx.reply(
      `Ⓝ <b>Deposit ${token.name || token.symbol}</b>\n──────────────────────────\n` +
      `Asset ID: <code>${token.assetId}</code>\n` +
      `How much <b>${token.symbol}</b> would you like to deposit?\n\n` +
      `<i>NEAR Intents will auto-convert your ${token.symbol} into USDC and sweep it to your Arc balance.</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("« Back to Tokens", "action_near_deposit")]]),
      }
    );
  }

  // ── NEAR deposit amount ──────────────────────────────────────────────────

  if (state.type === "await_near_amount") {
    const amount = parseFloat(text.replace(/[^0-9.]/g, ""));
    const tokenSymbol = state.data?.originSymbol || "USDC";
    const originAsset = state.data?.originAsset || nearLib.ASSETS.NEAR_USDC;
    const originDecimals = state.data?.originDecimals || 6;
    const minDeposit = state.data?.minDeposit ?? (tokenSymbol === "USDC" || tokenSymbol === "USDT" ? 2 : 0.001);

    if (isNaN(amount) || amount <= 0 || (minDeposit && amount < minDeposit)) {
      if (shouldReprocessConversationState("await_near_amount", text)) {
        convState.clearState(userId);
        return bot.handleUpdate({ update_id: ctx.update.update_id, message: ctx.message });
      }
      return ctx.reply(`Enter a valid amount of ${tokenSymbol} (minimum ${minDeposit} ${tokenSymbol}). Type cancel to stop.`);
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

    await ctx.reply(`⏳ Requesting NEAR Intent quote to convert ${amount} ${tokenSymbol} to USDC…`);
    let row;
    try {
      row = await nearLib.createNearDeposit({
        telegramId: userId,
        accountType: context,
        originAsset,
        originSymbol: tokenSymbol,
        originDecimals,
        amount,
        amountUsdc: amount,
        recipientAddress,
        refundTo,
      });
    } catch (err) {
      convState.clearState(userId);
      return ctx.reply(`❌ Could not open a NEAR deposit: ${err.message}`, deps.backToMenu);
    }
    convState.clearState(userId);

    if (!row || !row.deposit_address) {
      return ctx.reply("❌ The bridge could not quote this token right now. Try again in a few minutes.", deps.backToMenu);
    }

    const expireIn = process.env.NEAR_INTENT_DEADLINE_MIN || 30;
    return ctx.reply(
      `Ⓝ <b>NEAR Deposit Instructions</b>\n──────────────────────────\n` +
      `💰 <b>Send exactly:</b> ${amount} ${tokenSymbol}\n` +
      (row.amount_out ? `💵 <b>Estimated Received:</b> ~$${Number(row.amount_out).toFixed(2)} USDC on Arc\n` : "") +
      `📍 <b>NEAR address (one-time):</b> <code>${row.deposit_address}</code>\n` +
      (row.deposit_memo ? `📝 <b>Memo (required):</b> <code>${row.deposit_memo}</code>\n` : "") +
      `⏰ <b>Valid for:</b> ${expireIn} minutes\n\n` +
      `🔄 <b>Auto-Conversion:</b> NEAR Intents will auto-convert your ${tokenSymbol} into Base USDC and auto-sweep it to Arc.\n` +
      `⚠️ <i>Send ${tokenSymbol} on NEAR only, exact amount, before expiry. ` +
      `If anything goes wrong, funds auto-refund to your NEAR address: <code>${refundTo}</code></i>`,
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

  // ── Solana deposit amount (via NEAR Intents 1Click) ─────────────────────

  if (state.type === "await_solana_amount") {
    const { getOrDeriveSolanaAddress, getActiveWallet } = deps;
    const amount = parseFloat(text.replace(/[^0-9.]/g, ""));
    const tokenSymbol = state.data?.originSymbol || "SOL";
    const originAsset = state.data?.originAsset;
    const originDecimals = state.data?.originDecimals || 9;
    const minDeposit = state.data?.minDeposit ?? 0.02;

    if (isNaN(amount) || amount <= 0 || (minDeposit && amount < minDeposit)) {
      if (shouldReprocessConversationState("await_solana_amount", text)) {
        convState.clearState(userId);
        return bot.handleUpdate({ update_id: ctx.update.update_id, message: ctx.message });
      }
      return ctx.reply(`Enter a valid amount of ${tokenSymbol} (minimum ${minDeposit} ${tokenSymbol}). Type cancel to stop.`);
    }

    const user = requireUser(ctx);
    if (!user) return;
    const context = state.context || "personal";
    const recipientAddress = getActiveWallet(user);

    // Refund address = user's derived Solana address
    // If user sends to the Solana deposit address and the swap fails,
    // 1Click refunds back to their Solana wallet — zero friction.
    const refundTo = getOrDeriveSolanaAddress(user);
    if (!refundTo) {
      convState.clearState(userId);
      return ctx.reply(
        "❌ We could not find your Solana address to use as a refund address. " +
        "Please contact support.",
        deps.backToMenu
      );
    }

    await ctx.reply(`⏳ Requesting NEAR Intents quote for ${amount} ${tokenSymbol} → Base USDC…`);
    let row;
    try {
      row = await nearLib.createSolanaDeposit({
        telegramId: userId,
        accountType: context,
        originAsset,
        originSymbol: tokenSymbol,
        originDecimals,
        amount,
        recipientAddress,
        refundTo,
      });
    } catch (err) {
      convState.clearState(userId);
      return ctx.reply(`❌ Could not open a Solana deposit: ${err.message}`, deps.backToMenu);
    }
    convState.clearState(userId);

    if (!row || !row.deposit_address) {
      return ctx.reply(
        "❌ The bridge could not quote this token right now. " +
        "This token may not be supported by the solver yet — try again in a few minutes.",
        deps.backToMenu
      );
    }

    const expireIn = process.env.NEAR_INTENT_DEADLINE_MIN || 30;
    return ctx.reply(
      `☀️ <b>Solana Deposit Instructions</b>\n──────────────────────────\n` +
      `💰 <b>Send exactly:</b> ${amount} ${tokenSymbol}\n` +
      (row.amount_out ? `💵 <b>Estimated Received:</b> ~$${Number(row.amount_out).toFixed(2)} USDC on Arc\n` : "") +
      `📍 <b>Solana address (one-time):</b>\n<code>${row.deposit_address}</code>\n` +
      (row.deposit_memo ? `📝 <b>Memo (required):</b> <code>${row.deposit_memo}</code>\n` : "") +
      `⏰ <b>Valid for:</b> ${expireIn} minutes\n\n` +
      `🔄 <b>Auto-Conversion:</b> NEAR Intents swaps your ${tokenSymbol} → USDC on Base → sweeps to Arc.\n` +
      `⚠️ <i>Send ${tokenSymbol} on Solana only, exact amount, before expiry.\n` +
      `If anything goes wrong, funds auto-refund to your Solana address: <code>${refundTo}</code></i>`,
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

  // ── Cross-Chain Withdraw: Address input ──────────────────────────────────
  if (state.type === "await_ccw_address") {
    const input = text.trim();
    if (shouldReprocessConversationState("await_ccw_address", text)) {
      convState.clearState(userId);
      return bot.handleUpdate({ update_id: ctx.update.update_id, message: ctx.message });
    }

    const chainKey = state.data?.destinationChain;
    const chainInfo = state.data?.chainInfo || CCW_CHAINS[chainKey];

    if (!validateAddressForChain(chainKey, input)) {
      return ctx.reply(
        `❌ Invalid ${chainInfo?.name || "destination"} address.\n\n` +
        `Please enter a valid address (e.g. <code>${chainInfo?.example || ""}</code>). Type cancel to return.`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_crosschain_withdraw")]]),
        }
      );
    }

    convState.setState(
      userId,
      "await_ccw_amount",
      {
        destinationChain: chainKey,
        chainInfo,
        destinationAddress: input,
      },
      state.context || getContext(userId)
    );

    return ctx.reply(
      `📤 <b>Withdraw to ${chainInfo.label}</b>\n──────────────────────────\n` +
      `📍 <b>Destination:</b> <code>${input}</code>\n` +
      `🪙 <b>Receiving:</b> ${chainInfo.token}\n\n` +
      `How much USD would you like to withdraw? (min $1.00)`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "action_crosschain_withdraw")]]),
      }
    );
  }

  // ── Cross-Chain Withdraw: Amount input ───────────────────────────────────
  if (state.type === "await_ccw_amount") {
    const amount = parseFloat(text.replace(/[^0-9.]/g, ""));
    const chainKey = state.data?.destinationChain;
    const chainInfo = state.data?.chainInfo || CCW_CHAINS[chainKey];
    const destinationAddress = state.data?.destinationAddress;

    if (isNaN(amount) || amount < 1) {
      if (shouldReprocessConversationState("await_ccw_amount", text)) {
        convState.clearState(userId);
        return bot.handleUpdate({ update_id: ctx.update.update_id, message: ctx.message });
      }
      return ctx.reply("Enter a valid amount of at least $1.00. Type cancel to stop.");
    }

    const user = requireUser(ctx);
    if (!user) return;
    const context = state.context || "personal";
    const sourceAddress = getActiveWallet(user);

    // Balance check on Arc
    let arcBalance = 0;
    try {
      const micro = await walletLib.getNativeBalanceMicro(sourceAddress);
      arcBalance = parseFloat(walletLib.formatMicro(micro));
    } catch (_) {}

    if (arcBalance < amount) {
      return ctx.reply(
        `Not enough USDC on Arc. You have $${arcBalance.toFixed(2)}, need $${amount.toFixed(2)}. ` +
        `Enter a smaller amount or type cancel.`
      );
    }

    convState.setState(
      userId,
      "confirm_ccw",
      {
        destinationChain: chainKey,
        chainInfo,
        destinationAddress,
        amountUsdc: amount,
      },
      context
    );

    const estTime = chainInfo.engine === "CCTP" ? "~1–3 minutes" : "~2–5 minutes";
    const routeDesc = chainInfo.engine === "CCTP"
      ? "Circle CCTP (100% native USDC, 0 slippage)"
      : "NEAR Intents (auto-swap & bridge)";

    const platformFee = Number(process.env.CROSSCHAIN_WITHDRAWAL_FEE_USDC ?? 0.30);
    const netReceived = Math.max(0, amount - platformFee);

    return ctx.reply(
      `📤 <b>Confirm Cross-Chain Withdrawal</b>\n──────────────────────────\n` +
      `🌐 <b>Destination Chain:</b> ${chainInfo.label}\n` +
      `📍 <b>To Address:</b>\n<code>${destinationAddress}</code>\n` +
      `💰 <b>Amount:</b> $${amount.toFixed(2)} USDC\n` +
      `🏷️ <b>Bridge Fee:</b> $${platformFee.toFixed(2)} USDC\n` +
      `🪙 <b>Net Receiving:</b> ~$${netReceived.toFixed(2)} in ${chainInfo.token}\n` +
      `⏱️ <b>Est. Time:</b> ${estTime}\n` +
      `🌉 <b>Route:</b> ${routeDesc}\n\n` +
      `Enter your 4-digit PIN to confirm:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "main_menu")]]),
      }
    );
  }

  // ── Cross-Chain Withdraw: PIN Confirmation & Execution ───────────────────
  if (state.type === "confirm_ccw") {
    await deleteSensitiveMessage(ctx);
    if (!/^\d{4}$/.test(text)) return ctx.reply("Enter your 4-digit PIN.");
    if (!db.verifyPin(userId, text)) { convState.clearState(userId); return ctx.reply("Incorrect PIN. Try again."); }
    const user = db.getUser(userId);
    convState.clearState(userId);
    await ctx.reply("⏳ Processing cross-chain withdrawal…");
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
      const result = await executeCrossChainWithdrawal(userWallet, {
        destinationChain: state.data.destinationChain,
        destinationAddress: state.data.destinationAddress,
        amountUsdc: state.data.amountUsdc,
        telegramId: userId,
        accountType: context,
        bot,
      });

      if (result.success) {
        const chainInfo = state.data.chainInfo || CCW_CHAINS[state.data.destinationChain];
        return ctx.reply(
          `✅ <b>Withdrawal Submitted!</b>\n──────────────────────────\n` +
          `🌐 <b>Destination:</b> ${chainInfo?.label || state.data.destinationChain}\n` +
          `💰 <b>Amount:</b> $${Number(result.amount).toFixed(2)} USDC\n` +
          `📍 <b>Recipient:</b> <code>${state.data.destinationAddress}</code>\n` +
          (result.txHash ? `🔗 <b>Transaction Hash:</b>\n<code>${result.txHash}</code>\n` : "") +
          `\n<i>Funds typically arrive on the destination chain in 1–5 minutes.</i>`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("💰 Check Balance", "action_balance")],
              [Markup.button.callback("🏠 Main Menu", "main_menu")],
            ]),
          }
        );
      }
      return ctx.reply(`❌ ${result.error}`, deps.backToMenu);
    } catch (err) {
      console.error("[flows_multichain:confirm_ccw:error]", err);
      return ctx.reply(`❌ Withdrawal could not be completed: ${err.message || "An unexpected error occurred"}`, deps.backToMenu);
    }
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
      `<i>Uses Circle CCTP. Funds arrive in ~1–5 minutes. Network gas only — no Proxim fee.</i>\n\n` +
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
