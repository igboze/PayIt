// src/app_api/actions.js
// Money & sensitive actions for the mobile app. Every action is two-step:
//   1. prepare(ctx, body): validate, quote and pre-check limits. Returns the exact action that the
//      user's passkey will sign (canonical, bound by hash into the WebAuthn challenge) plus a
//      human summary for the approval sheet.
//   2. execute(ctx, action, pin, context, body): runs only after the passkey assertion and PIN verify.
// Execution reuses the same modules the Telegram bot and builder API use, so fees, limits and
// fraud checks stay identical across channels (personal and business accounts).

const deps = {
  get db() { return require("../db"); },
  get walletLib() { return require("../wallet"); },
  get fraudGuard() { return require("../fraud_guard"); },
  get multichain() { return require("../multichain"); },
  get paj() { return require("../paj"); },
  get fx() { return require("../fx"); },
  get nuvionPayouts() { return require("../nuvion_payouts"); },
  get airbills() { return require("../airbills"); },
  get savings() { return require("../savings"); },
  get nuvionCards() { return require("../nuvion_cards"); },
  get notify() { return require("../notify"); },
  get schedules() { return require("./schedules"); },
  get store() { return require("./store"); },
  get executor() { return require("../../agent/executor"); },
  get flowsMultichain() { return require("../flows_multichain"); },
  get socialTransfers() { return require("../social_transfers"); },
  get swap() { return require("../swap"); },
  get bizProfile() { return require("../biz_profile"); },
  get solanaAddress() { return require("../solana_address"); },
};
const overrides = {};
const dep = (name) => (name in overrides ? overrides[name] : deps[name]);
function __setTestDeps(o = {}) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setTestDeps cannot be used in production.");
  }
  for (const k of Object.keys(overrides)) delete overrides[k];
  Object.assign(overrides, o);
}

const WEAK_PINS = new Set(["0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999", "1234", "4321", "1122", "1212", "0123"]);

class ActionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (msg, code = "invalid_request") => new ActionError(400, code, msg);

// ─── helpers ──────────────────────────────────────────────────────────────────

function str(body, field, { pattern = null, max = 256, optional = false } = {}) {
  const v = body?.[field];
  if (v === undefined || v === null || v === "") {
    if (optional) return null;
    throw bad(`Missing field: ${field}`);
  }
  const s = String(v).trim();
  if (!s || s.length > max || (pattern && !pattern.test(s))) throw bad(`Invalid field: ${field}`);
  return s;
}

function money(body, field, { min = 0.01, max = 1_000_000 } = {}) {
  const n = Number(body?.[field]);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`Enter a valid ${field}.`, "invalid_amount");
  return n;
}

function resolveAccountType(ctx, body) {
  const raw = body?.accountType !== undefined && body?.accountType !== null && body?.accountType !== ""
    ? String(body.accountType).trim().toLowerCase()
    : (ctx.accountHeader || (ctx.user?.active_context === "business" && ctx.user?.business_deposit_address ? "business" : "personal"));
  if (raw !== "personal" && raw !== "business") {
    throw bad("Invalid accountType. Use 'personal' or 'business'.");
  }
  if (raw === "business") {
    if (!ctx.user?.business_deposit_address) {
      throw new ActionError(404, "no_business_account", "No business account found. Set up your business account first.");
    }
    return "business";
  }
  return "personal";
}

function accountTagLines(ctx, accountType) {
  if (!ctx.user?.business_deposit_address) return [];
  return [["Account", accountType === "business" ? "Business" : "Personal"]];
}

function getWalletAddress(user, accountType) {
  return accountType === "business" ? user?.business_deposit_address : user?.deposit_address;
}

async function precheck(ctx, amountUsd, reference, action, accountType = "personal") {
  try {
    await dep("fraudGuard").assertOutboundAllowed({
      telegramId: ctx.telegramId, accountType, action, amountUsd, reference, record: false,
    });
  } catch (err) {
    throw new ActionError(403, "blocked", err.message);
  }
}

async function recordOutbound(ctx, amountUsd, reference, action, accountType = "personal") {
  try {
    await dep("fraudGuard").assertOutboundAllowed({
      telegramId: ctx.telegramId, accountType, action, amountUsd, reference,
    });
  } catch (err) {
    throw new ActionError(403, "blocked", err.message);
  }
}

function unlockKey(ctx, pin, accountType = "personal") {
  const db = dep("db");
  const user = db.getUser(ctx.telegramId);
  const key = accountType === "business"
    ? db.decryptBusinessPrivateKey(pin, user)
    : db.decryptPrivateKey(pin, user);
  if (!key) throw new ActionError(401, "pin_invalid", "Wrong PIN.");
  return key;
}

async function sendOnchain(ctx, pin, toAddress, amountUsdc, narration, type = "transfer", accountType = "personal") {
  const db = dep("db");
  const walletLib = dep("walletLib");
  const signer = walletLib.walletFromPrivateKey(unlockKey(ctx, pin, accountType));
  const amountMicro = walletLib.parseToMicro(Number(amountUsdc).toFixed(6));
  const txRes = await walletLib.sendSponsoredOrDirectTransaction(signer, toAddress, amountMicro, "0x", { waitForConfirmation: false });
  const txHash = txRes.txHash || txRes.hash;
  db.recordTransaction(ctx.telegramId, type, String(amountMicro), "completed", txHash, accountType, 18, "arc", narration || null);
  return txHash;
}

function findRecipientUser(raw) {
  const db = dep("db");
  const store = dep("store");
  const q = String(raw || "").trim();
  if (/^\+?[0-9][0-9\s-]{7,}$/.test(q)) {
    const phone = q.replace(/[\s-]/g, "");
    return store.findUserByPhone(phone.startsWith("+") ? phone : `+${phone}`);
  }
  const handle = q.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{3,32}$/.test(handle)) return null;
  return db.findUserByUsername(handle);
}

const fmt = (n) => Number(n).toFixed(2);
const cleanBrand = (msg) => String(msg || "").replace(/nuvion/gi, "Global Neobank");

// ─── action definitions ───────────────────────────────────────────────────────

const ACTIONS = {
  "transfer.wallet": {
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const toAddress = str(body, "toAddress", { pattern: /^0x[0-9a-fA-F]{40}$/ }).toLowerCase();
      const amountUsdc = money(body, "amountUsdc");
      const narration = str(body, "narration", { optional: true, max: 100 }) || "";
      const ownAddr = getWalletAddress(ctx.user, accountType);
      if (ownAddr && toAddress === String(ownAddr).toLowerCase()) throw bad("You can't send to your own wallet.", "self_transfer");
      await precheck(ctx, amountUsdc, toAddress, "app_transfer", accountType);
      return {
        amountUsd: amountUsdc,
        action: { accountType, toAddress, amountUsdc: amountUsdc.toFixed(6), currency: "USDC", narration },
        summary: { title: `Send $${fmt(amountUsdc)}`, lines: [...accountTagLines(ctx, accountType), ["To", toAddress], ["Amount", `$${fmt(amountUsdc)}`]] },
      };
    },
    async execute(ctx, a, pin) {
      const accountType = a.accountType || "personal";
      await recordOutbound(ctx, Number(a.amountUsdc), a.toAddress, "app_transfer", accountType);
      const txHash = await sendOnchain(ctx, pin, a.toAddress, a.amountUsdc, a.narration, "transfer", accountType);
      return { txHash, amountUsdc: a.amountUsdc, toAddress: a.toAddress, accountType, notice: `Sent $${fmt(a.amountUsdc)}` };
    },
  },

  "transfer.user": {
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const recipient = findRecipientUser(str(body, "recipient", { max: 40 }));
      if (!recipient || !recipient.deposit_address) {
        throw new ActionError(404, "recipient_not_found", "No Proxim user with that username or phone. Send them a claimable gift link instead.");
      }
      if (Number(recipient.telegram_id) === ctx.telegramId) throw bad("You can't send to yourself.", "self_transfer");
      const amountUsdc = money(body, "amountUsdc");
      const narration = str(body, "narration", { optional: true, max: 100 }) || "";
      await precheck(ctx, amountUsdc, `user:${recipient.telegram_id}`, "app_p2p", accountType);
      const label = recipient.username ? `@${recipient.username}` : "Proxim user";
      return {
        amountUsd: amountUsdc,
        action: { accountType, recipientId: String(recipient.telegram_id), recipientLabel: label, toAddress: String(recipient.deposit_address).toLowerCase(), amountUsdc: amountUsdc.toFixed(6), narration },
        summary: { title: `Send $${fmt(amountUsdc)} to ${label}`, lines: [["To", label], ["Amount", `$${fmt(amountUsdc)}`], ["Fee", "Free"]] },
      };
    },
    async execute(ctx, a, pin) {
      const db = dep("db");
      const accountType = a.accountType || "personal";
      const recipient = db.getUser(Number(a.recipientId));
      if (!recipient || String(recipient.deposit_address).toLowerCase() !== a.toAddress) throw new ActionError(409, "recipient_changed", "The recipient's account changed. Please start again.");
      await recordOutbound(ctx, Number(a.amountUsdc), `user:${a.recipientId}`, "app_p2p", accountType);
      const txHash = await sendOnchain(ctx, pin, a.toAddress, a.amountUsdc, a.narration, "p2p_send", accountType);
      try {
        db.recordTransaction(Number(a.recipientId), "p2p_receive", String(dep("walletLib").parseToMicro(Number(a.amountUsdc).toFixed(6))), "completed", txHash, "personal", 18, "arc", a.narration || null);
      } catch (_) {}
      const from = ctx.user.username ? `@${ctx.user.username}` : "a Proxim user";
      try {
        await dep("notify").notify(Number(a.recipientId), { title: "Money received", html: `💸 <b>You received $${fmt(a.amountUsdc)}</b> from ${from}.${a.narration ? `\nNote: ${String(a.narration).replace(/[<>&]/g, "")}` : ""}` });
      } catch (_) {}
      return { txHash, amountUsdc: a.amountUsdc, to: a.recipientLabel, accountType, notice: `Sent $${fmt(a.amountUsdc)} to ${a.recipientLabel}` };
    },
  },

  "gift.create": {
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const st = dep("socialTransfers");
      const targetHandle = st.normalizeTelegramHandle(str(body, "targetUsername", { max: 64 }));
      if (!targetHandle) throw bad("Enter a valid @username for the gift link.");
      if (ctx.user.username && ctx.user.username.toLowerCase() === targetHandle) throw bad("You can't send a gift link to yourself.", "self_transfer");
      const amountUsdc = money(body, "amountUsdc", { min: 1 });
      const expiresHours = Math.min(Math.max(Number(body?.expiresHours || 48), 1), 168);
      await precheck(ctx, amountUsdc, `gift:${targetHandle}`, "app_gift_create", accountType);
      return {
        amountUsd: amountUsdc,
        action: { accountType, targetUsername: targetHandle, amountUsdc: amountUsdc.toFixed(6), expiresHours },
        summary: {
          title: `Send $${fmt(amountUsdc)} gift link to @${targetHandle}`,
          lines: [["Recipient", `@${targetHandle}`], ["Amount", `$${fmt(amountUsdc)}`], ["Expires in", `${expiresHours} hours`]],
        },
      };
    },
    async execute(ctx, a, pin) {
      const st = dep("socialTransfers");
      const accountType = a.accountType || "personal";
      const amount = Number(a.amountUsdc);
      await recordOutbound(ctx, amount, `gift:${a.targetUsername}`, "app_gift_create", accountType);
      const escrowAddress = st.getEscrowHolderAddress();
      const txHash = await sendOnchain(ctx, pin, escrowAddress, amount, `Gift link for @${a.targetUsername}`, "p2p_escrow", accountType);
      const created = st.createGiftEscrow({
        senderId: ctx.telegramId,
        senderAccountType: accountType,
        targetUsername: a.targetUsername,
        amountUsdc: amount,
        expiresHours: a.expiresHours || 48,
      });
      return {
        txHash,
        claimToken: created.claimToken,
        claimUrl: created.claimUrl,
        shareUrl: created.shareUrl,
        shareText: created.shareText,
        escrow: created.escrow,
        notice: `Created $${fmt(amount)} gift link for @${a.targetUsername}`,
      };
    },
  },

  "gift.cancel": {
    noPin: true,
    async prepare(ctx, body) {
      const claimToken = str(body, "claimToken", { max: 80 });
      const escrow = dep("db").getSocialEscrowByToken(claimToken);
      if (!escrow || Number(escrow.sender_id) !== ctx.telegramId) throw new ActionError(404, "gift_not_found", "Gift link not found.");
      if (escrow.status !== "pending") throw new ActionError(409, "gift_not_pending", `This gift link is already ${escrow.status}.`);
      return {
        amountUsd: 0,
        action: { claimToken, targetHandle: escrow.target_handle, amountUsdc: String(escrow.amount_usdc) },
        summary: { title: `Cancel $${fmt(escrow.amount_usdc)} gift link`, lines: [["Recipient", `@${escrow.target_handle}`], ["Refund to", "Your Proxim balance"]] },
      };
    },
    async execute(ctx, a) {
      const escrow = dep("db").getSocialEscrowByToken(a.claimToken);
      const acctType = escrow?.sender_account_type || "personal";
      const senderAddress = getWalletAddress(ctx.user, acctType) || ctx.user.deposit_address;
      const res = await dep("socialTransfers").refundEscrowToSender({
        claimToken: a.claimToken,
        senderId: ctx.telegramId,
        senderAddress,
      });
      return { txHash: res.txHash, escrow: res.escrow, notice: `Refunded $${fmt(a.amountUsdc)} gift link` };
    },
  },

  "withdraw.crypto": {
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const fm = dep("flowsMultichain");
      const destinationChain = str(body, "destinationChain", { max: 32 }).toLowerCase();
      const chainInfo = fm.CCW_CHAINS?.[destinationChain];
      if (!chainInfo) throw bad(`Unsupported destination chain: ${destinationChain}`);
      const destinationAddress = str(body, "destinationAddress", { max: 128 });
      if (!fm.validateAddressForChain(destinationChain, destinationAddress)) {
        throw bad(`Invalid ${chainInfo.name} address.`, "invalid_address");
      }
      const amountUsdc = money(body, "amountUsdc", { min: 1 });
      const feeUsd = Number(process.env.CROSSCHAIN_WITHDRAWAL_FEE_USDC ?? 0.30);
      if (amountUsdc <= feeUsd) throw bad(`Minimum withdrawal must exceed the $${fmt(feeUsd)} bridge fee.`, "invalid_amount");
      await precheck(ctx, amountUsdc, `ccw:${destinationChain}:${destinationAddress}`, "app_crosschain_withdraw", accountType);
      return {
        amountUsd: amountUsdc,
        action: { accountType, destinationChain, destinationAddress: destinationChain === "near" ? destinationAddress.toLowerCase() : destinationAddress, amountUsdc: amountUsdc.toFixed(6) },
        summary: {
          title: `Withdraw $${fmt(amountUsdc)} to ${chainInfo.label}`,
          lines: [["Network", chainInfo.label], ["Asset", chainInfo.token], ["To", destinationAddress], ["Bridge fee", `$${fmt(feeUsd)}`], ["Estimated received", `~$${fmt(amountUsdc - feeUsd)}`]],
        },
      };
    },
    async execute(ctx, a, pin) {
      const accountType = a.accountType || "personal";
      await recordOutbound(ctx, Number(a.amountUsdc), `ccw:${a.destinationChain}:${a.destinationAddress}`, "app_crosschain_withdraw", accountType);
      const userWallet = dep("walletLib").walletFromPrivateKey(unlockKey(ctx, pin, accountType));
      const res = await dep("executor").executeCrossChainWithdrawal(userWallet, {
        destinationChain: a.destinationChain,
        destinationAddress: a.destinationAddress,
        amountUsdc: Number(a.amountUsdc),
        telegramId: ctx.telegramId,
        accountType,
        bot: dep("notify").getNotifyBot(),
      });
      if (!res || !res.success) {
        throw new ActionError(502, "withdrawal_failed", res?.error || "Cross-chain withdrawal could not be completed.");
      }
      return { ...res, notice: `Withdrawing $${fmt(a.amountUsdc)} to ${a.destinationChain}` };
    },
  },

  "bridge.move": {
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const direction = str(body, "direction", { pattern: /^(arc_to_solana|solana_to_arc)$/ });
      const amountUsdc = money(body, "amountUsdc", { min: 0.5 });
      const label = direction === "arc_to_solana" ? "Arc → Solana" : "Solana → Arc";
      return {
        amountUsd: 0, // internal self-move between the user's own Arc and Solana wallets
        action: { accountType, direction, amountUsdc: amountUsdc.toFixed(6) },
        summary: { title: `Move $${fmt(amountUsdc)} (${label})`, lines: [["Route", label], ["Amount", `$${fmt(amountUsdc)}`], ["Proxim fee", "Free"]] },
      };
    },
    async execute(ctx, a, pin) {
      const accountType = a.accountType || "personal";
      const userWallet = dep("walletLib").walletFromPrivateKey(unlockKey(ctx, pin, accountType));
      const res = await dep("executor").moveFundsBetweenChains(userWallet, {
        direction: a.direction,
        amountUsdc: Number(a.amountUsdc),
        telegramId: ctx.telegramId,
        accountType,
        bot: dep("notify").getNotifyBot(),
      });
      if (!res || !res.success) {
        throw new ActionError(502, "bridge_failed", res?.error || "Move between chains could not be completed.");
      }
      return { ...res, notice: `Moving $${fmt(a.amountUsdc)} (${a.direction === "arc_to_solana" ? "Arc → Solana" : "Solana → Arc"})` };
    },
  },

  "swap.execute": {
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const tokenIn = str(body, "tokenIn", { pattern: /^(USDC|EURC)$/i }).toUpperCase();
      const tokenOut = str(body, "tokenOut", { pattern: /^(USDC|EURC)$/i }).toUpperCase();
      if (tokenIn === tokenOut) throw bad("Select two different currencies to swap.");
      const amountIn = money(body, "amountIn", { min: 1 });
      const amountMicro = dep("walletLib").parseToMicro(amountIn.toFixed(6));
      let quote = null;
      try {
        quote = await dep("swap").getSwapQuote(tokenIn, tokenOut, amountMicro);
      } catch (err) {
        throw new ActionError(502, "quote_failed", err.message || "Could not get a live swap quote.");
      }
      return {
        amountUsd: 0, // stays inside user's own wallet
        action: { accountType, tokenIn, tokenOut, amountIn: amountIn.toFixed(6), estimatedOut: String(quote?.amountOut || "") },
        summary: {
          title: `Swap ${fmt(amountIn)} ${tokenIn} → ${tokenOut}`,
          lines: [["You send", `${fmt(amountIn)} ${tokenIn}`], ["You receive", `≈ ${quote?.amountOut || "Live rate"} ${tokenOut}`], ["Fee", quote?.protocolFee ? `${quote.protocolFee} ${tokenOut}` : "1%"]],
        },
      };
    },
    async execute(ctx, a, pin) {
      const accountType = a.accountType || "personal";
      const pk = unlockKey(ctx, pin, accountType);
      const amountMicro = dep("walletLib").parseToMicro(Number(a.amountIn).toFixed(6));
      const res = await dep("swap").executeSwap(pk, a.tokenIn, a.tokenOut, amountMicro);
      const txHash = res?.txHash || res?.hash || res?.transactionHash || null;
      try {
        dep("db").recordTransaction(ctx.telegramId, "swap", String(amountMicro), "completed", txHash, accountType, 18, "arc", `Swap ${a.amountIn} ${a.tokenIn} -> ${a.tokenOut}`);
      } catch (_) {}
      return { result: res, txHash, notice: `Swapped ${fmt(a.amountIn)} ${a.tokenIn} to ${a.tokenOut}` };
    },
  },

  "payout.ngn": {
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const amountUsdc = money(body, "amountUsdc", { min: 1 });
      const bankCode = str(body, "bankCode", { pattern: /^[A-Za-z0-9-]{2,20}$/ });
      const accountNumber = str(body, "accountNumber", { pattern: /^\d{10}$/ });
      const accountName = str(body, "accountName", { optional: true, max: 80 }) || "";
      const narration = str(body, "narration", { optional: true, max: 60 }) || "";
      await precheck(ctx, amountUsdc, `${bankCode}:${accountNumber}`, "app_offramp_ngn", accountType);
      let rate = null;
      try { const r = await dep("paj").getRates("NGN"); rate = Number(r?.offRampRate?.rate) || null; } catch (_) {}
      if (!rate) { try { rate = Number(await dep("fx").getUsdToNgnRate()) || null; } catch (_) {} }
      const estNgn = rate ? Math.floor(amountUsdc * rate) : null;
      return {
        amountUsd: amountUsdc,
        action: { accountType, amountUsdc: amountUsdc.toFixed(6), bankCode, accountNumber, accountName, narration, quotedRate: rate },
        summary: {
          title: `Send $${fmt(amountUsdc)} to ${accountName || accountNumber}`,
          lines: [["To", `${accountName || "Account"} · ••${accountNumber.slice(-2)}`], ["They get", estNgn ? `≈ ₦${estNgn.toLocaleString("en-NG")}` : "Shown by the bank partner"], ["Rate", rate ? `$1 = ₦${rate}` : "Live rate"]],
        },
      };
    },
    async execute(ctx, a, pin) {
      const db = dep("db");
      const walletLib = dep("walletLib");
      const multichain = dep("multichain");
      const accountType = a.accountType || "personal";
      const amount = Number(a.amountUsdc);
      await recordOutbound(ctx, amount, `${a.bankCode}:${a.accountNumber}`, "app_offramp_ngn", accountType);
      const senderName = db.resolveSenderName(ctx.telegramId, accountType);
      const order = await dep("paj").createOfframpPayout({
        amountUsdc: amount, bankCode: a.bankCode, accountNumber: a.accountNumber,
        accountName: a.accountName || undefined, narration: a.narration || undefined, senderName,
      });
      const fundingAddress = order.address;
      const fundingAmount = Number(order.amount || amount);
      if (!fundingAddress) throw new ActionError(502, "provider_error", "The bank partner didn't return a funding address. Nothing was sent.");
      const privateKey = unlockKey(ctx, pin, accountType);
      let txHash = null;
      let rail = "arc";
      if (multichain.isSolanaAddress(fundingAddress)) {
        rail = "solana";
        const sol = multichain.deriveSolanaFromEvmKey(privateKey);
        const tx = await multichain.sendSolanaTransfer({ keypair: sol.keypair, recipientAddress: fundingAddress, amount: fundingAmount });
        txHash = tx?.txHash || tx?.signature || null;
      } else if (walletLib.isValidAddress(fundingAddress)) {
        const signer = walletLib.walletFromPrivateKey(privateKey);
        const tx = await walletLib.sendSponsoredOrDirectTransaction(signer, fundingAddress, walletLib.parseToMicro(fundingAmount.toFixed(6)));
        txHash = tx?.txHash || null;
      } else {
        throw new ActionError(502, "provider_error", "Unsupported funding address from the bank partner. Nothing was sent.");
      }
      const orderId = order.id || order.reference || txHash;
      db.recordOfframpOrder({
        orderId, telegramId: ctx.telegramId, accountType, accountNumber: String(a.accountNumber), bankCode: String(a.bankCode),
        bankName: order.bankName || order.bank?.name || null, accountName: order.accountName || a.accountName || null,
        amountUsdc: fundingAmount, fiatAmount: order.fiatAmount || null, rate: order.rate || null, rail, txHash,
        narration: a.narration || null, senderName: senderName || null, status: "submitted",
      });
      db.recordTransaction(ctx.telegramId, "offramp", String(walletLib.parseToMicro(fundingAmount.toFixed(6))), "submitted", txHash || orderId, accountType, 18, rail, a.narration || null);
      return { orderId, txHash, rail, accountType, status: "submitted", notice: `Sending $${fmt(fundingAmount)} to ${order.accountName || a.accountName || "the bank account"}` };
    },
  },

  "payout.global": {
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const targetCurrency = str(body, "targetCurrency", { pattern: /^[A-Za-z]{3}$/ }).toUpperCase();
      const targetAmountMajor = money(body, "targetAmount");
      const railKey = str(body, "railKey", { optional: true, max: 40 });
      const savedCounterpartyId = str(body, "savedCounterpartyId", { optional: true, max: 80 });
      const recipientDetails = body?.recipientDetails && typeof body.recipientDetails === "object" ? body.recipientDetails : null;
      let savedCounterparty = null;
      if (savedCounterpartyId) {
        const ent = dep("db").getNuvionEntityByUser(ctx.telegramId, accountType);
        if (ent) {
          savedCounterparty = dep("db").getNuvionCounterpartiesByEntity(ent.entity_id, targetCurrency)
            .find((c) => String(c.counterparty_id) === savedCounterpartyId || String(c.id) === savedCounterpartyId) || null;
        }
        if (!savedCounterparty) throw new ActionError(404, "recipient_not_found", "Saved global recipient not found.");
      } else if (!recipientDetails) {
        throw bad("Recipient bank details or savedCounterpartyId is required.");
      }
      const narration = str(body, "narration", { optional: true, max: 60 }) || "";
      const effectiveRail = railKey || (() => { try { return JSON.parse(savedCounterparty?.summary_json || "{}").railKey || null; } catch (_) { return null; } })();
      const q = await dep("nuvionPayouts").quoteGlobalPayout({ telegramId: ctx.telegramId, accountType, railKey: effectiveRail, targetCurrency, targetAmountMajor });
      const userUsd = Number(q?.userTotalUsd ?? q?.totalUsd ?? 0);
      await precheck(ctx, userUsd, `global:${targetCurrency}`, "app_global_payout", accountType);
      return {
        amountUsd: userUsd,
        action: {
          accountType,
          targetCurrency,
          targetAmountMajor: String(targetAmountMajor),
          railKey: effectiveRail || q?.rail?.key || q?.railKey || null,
          savedCounterpartyId: savedCounterparty ? String(savedCounterparty.counterparty_id) : null,
          recipientDetails: savedCounterparty ? null : recipientDetails,
          narration,
          quotedUsd: userUsd.toFixed(2),
        },
        summary: {
          title: `Send ${targetAmountMajor} ${targetCurrency}`,
          lines: [["They get", `${targetAmountMajor} ${targetCurrency}`], ["From your balance", `$${fmt(userUsd)}`]],
        },
        context: savedCounterparty ? { savedCounterparty } : null,
      };
    },
    async execute(ctx, a, pin, context) {
      const accountType = a.accountType || "personal";
      await recordOutbound(ctx, Number(a.quotedUsd), `global:${a.targetCurrency}`, "app_global_payout", accountType);
      const res = await dep("nuvionPayouts").initiateGlobalPayout({
        telegramId: ctx.telegramId, pin, accountType, railKey: a.railKey || undefined,
        targetCurrency: a.targetCurrency, targetAmountMajor: Number(a.targetAmountMajor),
        recipientDetails: a.recipientDetails || null,
        savedCounterparty: context?.savedCounterparty || null,
        narration: a.narration || null, bot: dep("notify").getNotifyBot(),
      });
      return { result: res, notice: `Sending ${a.targetAmountMajor} ${a.targetCurrency}` };
    },
  },

  "bill.pay": {
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const category = str(body, "category", { pattern: /^(airtime|data|electricity|cable|betting|internet|transport)$/ });
      const productCode = str(body, "productCode", { max: 80 });
      const recipient = str(body, "recipient", { max: 40 });
      const providerName = str(body, "providerName", { optional: true, max: 80 }) || null;
      const amountNgn = money(body, "amountNgn", { min: 50, max: 2_000_000 });
      const billData = body?.billData && typeof body.billData === "object" ? body.billData : {};
      const est = await dep("airbills").estimateBillUsdc(amountNgn);
      const usd = Number(est?.usdc ?? est?.amountUsdc ?? est ?? 0);
      await precheck(ctx, usd, `${category}:${recipient}`, "app_bill", accountType);
      return {
        amountUsd: usd,
        action: { accountType, category, productCode, providerName, recipient, amountNgn: String(amountNgn), billData, quotedUsd: usd.toFixed(2) },
        summary: { title: `Pay ₦${amountNgn.toLocaleString("en-NG")} ${category}`, lines: [["For", recipient], ["Provider", providerName || productCode], ["From your balance", `≈ $${fmt(usd)}`]] },
      };
    },
    async execute(ctx, a, pin) {
      const accountType = a.accountType || "personal";
      await recordOutbound(ctx, Number(a.quotedUsd), `${a.category}:${a.recipient}`, "app_bill", accountType);
      const res = await dep("airbills").executeBillPayment({
        user: dep("db").getUser(ctx.telegramId), pin, context: accountType, productCode: a.productCode, category: a.category,
        providerName: a.providerName, recipient: a.recipient, amountNgn: Number(a.amountNgn), billData: a.billData || {},
      });
      return { result: res, notice: `Paid ₦${Number(a.amountNgn).toLocaleString("en-NG")} ${a.category}` };
    },
  },

  "savings.deposit": {
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const amountUsdc = money(body, "amountUsdc", { min: 1 });
      const pools = await dep("savings").getYieldPools();
      const pool = pools.find((p) => p.symbol === "USDC") || pools[0];
      if (!pool || !pool.vaultAddress) throw new ActionError(503, "unavailable", "Savings are unavailable right now.");
      return {
        amountUsd: amountUsdc,
        action: { accountType, amountUsdc: amountUsdc.toFixed(6), vaultAddress: String(pool.vaultAddress).toLowerCase() },
        summary: { title: `Save $${fmt(amountUsdc)}`, lines: [["Into", pool.name || "Dollar lending vault"], ["Amount", `$${fmt(amountUsdc)}`]] },
        context: { pool },
      };
    },
    async execute(ctx, a, pin, context) {
      const savings = dep("savings");
      const accountType = a.accountType || "personal";
      const pool = context?.pool || { vaultAddress: a.vaultAddress };
      const res = await savings.depositIntoVault(unlockKey(ctx, pin, accountType), a.vaultAddress, Number(a.amountUsdc));
      if (!res || !res.success) throw new ActionError(502, "provider_error", res?.error || "The savings deposit didn't go through. Nothing was moved.");
      savings.openYieldPosition(ctx.telegramId, Number(a.amountUsdc), pool, { vaultAddress: a.vaultAddress, depositTxHash: res.txHash || res.hash || null, accountType });
      return { txHash: res.txHash || res.hash || null, notice: `Saved $${fmt(a.amountUsdc)}` };
    },
  },

  "savings.withdraw": {
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const open = dep("db").getOpenYieldPosition(ctx.telegramId, accountType);
      if (!open) throw new ActionError(404, "no_position", "You have no savings to withdraw.");
      return { amountUsd: 0, action: { accountType, positionId: String(open.id) }, summary: { title: "Withdraw all savings", lines: [["Back to", "Your balance"]] } };
    },
    async execute(ctx, a, pin) {
      const db = dep("db");
      const accountType = a.accountType || "personal";
      const open = db.getOpenYieldPosition(ctx.telegramId, accountType);
      if (!open || String(open.id) !== a.positionId) throw new ActionError(409, "changed", "Your savings changed. Please start again.");
      const userWallet = dep("walletLib").walletFromPrivateKey(unlockKey(ctx, pin, accountType));
      userWallet.telegramId = ctx.telegramId;
      const r = await dep("savings").withdrawFromVaultWithFee({ userWallet, position: open });
      return { withdrawnUsdc: r.totalUserPayout, netYieldUsdc: r.netYieldUsdc, feeUsdc: r.devFeeUsdc, txHash: r.withdrawTxHash, notice: `Withdrew $${fmt(r.totalUserPayout || 0)}` };
    },
  },

  "card.issue": {
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const cardType = str(body, "cardType", { pattern: /^(virtual|disposable|team)$/ });
      const cardName = str(body, "cardName", { optional: true, max: 40 }) || (cardType === "disposable" ? "One-time card" : cardType === "team" ? "Team card" : "Online shopping");
      const loadAmountUsd = money(body, "loadAmountUsd", { min: 1 });
      const q = await dep("nuvionCards").quoteCardIssuance({ telegramId: ctx.telegramId, accountType, cardType, loadAmountUsd, cardName });
      const total = Number(q?.totalUsd ?? q?.userTotalUsd ?? loadAmountUsd);
      await precheck(ctx, total, `card:${cardType}`, "app_card_issue", accountType);
      return {
        amountUsd: total,
        action: { accountType, cardType, cardName, loadAmountUsd: String(loadAmountUsd), quotedUsd: total.toFixed(2) },
        summary: { title: `New ${cardType} card`, lines: [["Loaded with", `$${fmt(loadAmountUsd)}`], ["Total from balance", `$${fmt(total)}`]] },
      };
    },
    async execute(ctx, a, pin) {
      const accountType = a.accountType || "personal";
      await recordOutbound(ctx, Number(a.quotedUsd), `card:${a.cardType}`, "app_card_issue", accountType);
      const res = await dep("nuvionCards").initiateCardIssuance({ telegramId: ctx.telegramId, pin, accountType, cardType: a.cardType, cardName: a.cardName, loadAmountUsd: Number(a.loadAmountUsd), bot: dep("notify").getNotifyBot() });
      return { result: res, notice: "Your card is being created" };
    },
  },

  "card.topup": {
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const cardId = str(body, "cardId", { max: 80 });
      const loadAmountUsd = money(body, "loadAmountUsd", { min: 1 });
      const q = await dep("nuvionCards").quoteCardTopUp({ telegramId: ctx.telegramId, accountType, cardId, loadAmountUsd });
      const total = Number(q?.totalUsd ?? q?.userTotalUsd ?? loadAmountUsd);
      await precheck(ctx, total, `card_topup:${cardId}`, "app_card_topup", accountType);
      return {
        amountUsd: total,
        action: { accountType, cardId, loadAmountUsd: String(loadAmountUsd), quotedUsd: total.toFixed(2) },
        summary: { title: `Top up card $${fmt(loadAmountUsd)}`, lines: [["Card", cardId], ["Total from balance", `$${fmt(total)}`]] },
      };
    },
    async execute(ctx, a, pin) {
      const accountType = a.accountType || "personal";
      await recordOutbound(ctx, Number(a.quotedUsd), `card_topup:${a.cardId}`, "app_card_topup", accountType);
      const res = await dep("nuvionCards").initiateCardTopUp({ telegramId: ctx.telegramId, pin, accountType, cardId: a.cardId, loadAmountUsd: Number(a.loadAmountUsd), bot: dep("notify").getNotifyBot() });
      return { result: res, notice: `Topping up card with $${fmt(a.loadAmountUsd)}` };
    },
  },

  "card.unload": {
    noPin: true,
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const cardId = str(body, "cardId", { max: 80 });
      const amountUsd = body?.amountUsd !== undefined && body?.amountUsd !== null && body?.amountUsd !== ""
        ? money(body, "amountUsd", { min: 1 })
        : null;
      return {
        amountUsd: 0,
        action: { accountType, cardId, amountUsd: amountUsd !== null ? String(amountUsd) : null },
        summary: { title: amountUsd ? `Unload $${fmt(amountUsd)} from card` : "Unload full card balance", lines: [["Card", cardId], ["Back to", "Your Proxim balance"]] },
      };
    },
    async execute(ctx, a) {
      const res = await dep("nuvionCards").unloadCardToMainWallet({
        telegramId: ctx.telegramId,
        accountType: a.accountType || "personal",
        cardId: a.cardId,
        amountUsd: a.amountUsd !== null ? Number(a.amountUsd) : null,
        bot: dep("notify").getNotifyBot(),
      });
      return { result: res, notice: "Card funds moved back to your balance" };
    },
  },

  "card.delete": {
    noPin: true,
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const cardId = str(body, "cardId", { max: 80 });
      return {
        amountUsd: 0,
        action: { accountType, cardId },
        summary: { title: "Delete card", lines: [["Card", cardId], ["Remaining balance", "Returned to your Proxim balance"]] },
      };
    },
    async execute(ctx, a) {
      const res = await dep("nuvionCards").deleteCardAndUnload({
        telegramId: ctx.telegramId,
        accountType: a.accountType || "personal",
        cardId: a.cardId,
        bot: dep("notify").getNotifyBot(),
      });
      return { result: res, notice: "Card deleted" };
    },
  },

  "card.reveal": {
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const cardId = str(body, "cardId", { max: 80 });
      return {
        amountUsd: 0,
        action: { accountType, cardId },
        summary: { title: "View card number & CVV", lines: [["Card", cardId]] },
      };
    },
    async execute(ctx, a, pin) {
      const details = await dep("nuvionCards").revealCardDetailsWithPin({
        telegramId: ctx.telegramId,
        pin,
        accountType: a.accountType || "personal",
        cardId: a.cardId,
      });
      // Intentionally omit `notice` so sensitive card details never trigger push/Telegram messages
      return { card: details };
    },
  },

  "card.freeze": {
    noPin: true,
    async prepare(ctx, body) {
      const accountType = resolveAccountType(ctx, body);
      const cardId = str(body, "cardId", { max: 80 });
      const freeze = body?.freeze !== false;
      return { amountUsd: 0, action: { accountType, cardId, freeze }, summary: { title: freeze ? "Freeze card" : "Unfreeze card", lines: [["Card", cardId]] } };
    },
    async execute(ctx, a) {
      const res = await dep("nuvionCards").setCardFrozen({ telegramId: ctx.telegramId, accountType: a.accountType || "personal", cardId: a.cardId, freeze: a.freeze });
      return { result: res, notice: a.freeze ? "Card frozen" : "Card unfrozen" };
    },
  },

  "payroll.run": {
    async prepare(ctx, body) {
      const csvText = str(body, "csvText", { max: 200_000 });
      const plan = await dep("nuvionPayouts").parseAndQuoteGlobalPayroll({ telegramId: ctx.telegramId, csvText, accountType: "business" });
      const total = Number(plan.totalUserUsd || 0);
      const csvHash = dep("store").sha256(csvText);
      return {
        amountUsd: total,
        action: { batchId: String(plan.batchId), rows: plan.rows.length, totalUsd: total.toFixed(2), csvHash },
        summary: {
          title: `Pay ${plan.rows.length} people`,
          lines: [["People", String(plan.rows.length)], ["Total from business balance", `$${fmt(total)}`]],
          rows: plan.rows.slice(0, 50).map((r) => ({ name: r.name || r.recipientName || null, currency: r.currency || r.targetCurrency || null, amount: r.amount ?? r.targetAmountMajor ?? null })),
          parseErrors: plan.parseErrors || [],
        },
        context: { plan },
      };
    },
    async execute(ctx, a, pin, context) {
      if (!context?.plan || String(context.plan.batchId) !== a.batchId) throw new ActionError(409, "changed", "Payroll changed. Please upload it again.");
      await recordOutbound(ctx, Number(a.totalUsd), `payroll:${a.batchId}`, "app_payroll", "business");
      const res = await dep("nuvionPayouts").executeGlobalPayrollBatch({ telegramId: ctx.telegramId, pin, payrollPlan: context.plan, accountType: "business", bot: dep("notify").getNotifyBot() });
      return { result: res, notice: `Paying ${a.rows} people` };
    },
  },

  "schedule.create": {
    async prepare(ctx, body) {
      const kind = str(body, "kind", { pattern: /^(transfer\.user|transfer\.wallet)$/ });
      const frequency = str(body, "frequency", { pattern: /^(daily|weekly|monthly)$/ });
      const day = str(body, "day", { optional: true, max: 12 });
      const time = str(body, "time", { optional: true, pattern: /^([01]\d|2[0-3]):[0-5]\d$/ }) || "09:00";
      const inner = await ACTIONS[kind].prepare(ctx, body);
      const label = dep("schedules").describe({ frequency, day, time });
      return {
        amountUsd: 0, // nothing moves now; each run is checked against limits when it happens
        action: { kind, frequency, day: day || null, time, payment: inner.action },
        summary: { title: `${inner.summary.title}, ${label}`, lines: [...inner.summary.lines, ["Repeats", label]] },
      };
    },
    async execute(ctx, a) {
      const row = dep("schedules").createSchedule({ telegramId: ctx.telegramId, kind: a.kind, frequency: a.frequency, day: a.day, time: a.time, payment: a.payment, approvedDeviceId: ctx.deviceId });
      return { schedule: row, notice: "Schedule created" };
    },
  },

  "business.setup": {
    async prepare(ctx, body) {
      if (ctx.user?.business_deposit_address) {
        throw new ActionError(409, "already_exists", "You already have a business account.");
      }
      const businessName = str(body, "businessName", { optional: true, max: 80 }) || null;
      const businessEmail = str(body, "businessEmail", { optional: true, max: 120 }) || null;
      return {
        amountUsd: 0,
        action: { businessName, businessEmail },
        summary: { title: "Create Business Account", lines: [["Business", businessName || "Proxim Business"], ["Wallet", "Dedicated business USDC wallet"]] },
      };
    },
    async execute(ctx, a, pin) {
      const db = dep("db");
      const freshUser = db.getUser(ctx.telegramId);
      if (freshUser?.business_deposit_address) {
        return { businessDepositAddress: freshUser.business_deposit_address, notice: "Business account already active" };
      }
      const bizWallet = dep("walletLib").generateUserWallet();
      db.addBusinessWallet(ctx.telegramId, bizWallet.address, bizWallet.privateKey, pin);
      try { dep("solanaAddress").reconcileUser(db.getUser(ctx.telegramId)); } catch (_) {}
      if (a.businessName) {
        try {
          const bp = dep("bizProfile");
          if (typeof bp.initBizProfileTable === "function") bp.initBizProfileTable();
          bp.upsertBizProfile(ctx.telegramId, { businessName: a.businessName, businessEmail: a.businessEmail || null });
        } catch (_) {}
      }
      return { businessDepositAddress: bizWallet.address, notice: "Business account created" };
    },
  },

  "pin.change": {
    async prepare() {
      // Never store the new PIN in the challenge row; it is verified and passed at /actions/confirm time.
      return {
        amountUsd: 0,
        action: { changePin: true },
        summary: { title: "Change your 4-digit PIN", lines: [["Action", "Re-encrypt wallets with your new PIN"]] },
      };
    },
    async execute(ctx, _a, pin, _context, body) {
      const newPin = str(body, "newPin", { pattern: /^\d{4}$/ });
      if (WEAK_PINS.has(newPin)) throw bad("Choose a PIN that is harder to guess.", "weak_pin");
      if (newPin === pin) throw bad("Your new PIN must be different from your current PIN.");
      const db = dep("db");
      const user = db.getUser(ctx.telegramId);
      const personalKey = db.decryptPrivateKey(pin, user);
      if (!personalKey) throw new ActionError(401, "pin_invalid", "Wrong current PIN.");
      const bizKey = user.business_deposit_address ? db.decryptBusinessPrivateKey(pin, user) : null;
      db.updatePin(ctx.telegramId, newPin, personalKey, bizKey);
      return { updated: true, notice: "Your PIN was changed" };
    },
  },

  "rewards.redeem": {
    async prepare(ctx, body) {
      const points = Math.round(Number(body?.points));
      if (!Number.isInteger(points) || points < 20 || points > 1_000_000) {
        throw bad("Enter a valid number of points (minimum 20).", "invalid_amount");
      }
      const balance = dep("db").getPointsBalance(ctx.telegramId);
      if (balance < points) throw new ActionError(400, "insufficient_points", `You only have ${balance} points available.`);
      const rewardType = str(body, "rewardType", { pattern: /^(airtime|bills|cashback)$/ });
      const recipient = str(body, "recipient", { optional: true, max: 40 }) || null;
      return {
        amountUsd: 0,
        action: { points, rewardType, recipient },
        summary: { title: `Redeem ${points} reward points`, lines: [["Reward", rewardType], ["Points", String(points)]] },
      };
    },
    async execute(ctx, a) {
      const db = dep("db");
      const details = a.recipient ? `${a.rewardType}:${a.recipient}` : a.rewardType;
      db.redeemPointsAtomic(ctx.telegramId, a.points, `redeem_${a.rewardType}`, details);
      const remainingPoints = db.getPointsBalance(ctx.telegramId);
      return { redeemedPoints: a.points, remainingPoints, rewardType: a.rewardType, notice: `Redeemed ${a.points} points` };
    },
  },
};

module.exports = { ACTIONS, ActionError, findRecipientUser, cleanBrand, __setTestDeps };
