// src/nuvion_cards.js
// Nuvion Phase 4 — Load-to-Spend Virtual & Disposable USD Cards (Personal + Business Team Cards)
//
// Core Guarantees (per docs.nuvion.co/guides/card-issuing & /api-reference/cards):
// 1. Main Proxim balance NEVER sits idle in Nuvion — only explicitly loaded card funds sit in each
//    card's dedicated USD sub-account (`purpose: "card"`), acting as that card's hard spending cap.
// 2. Always queries live GET /card-creation-fee/{account_id}?currency=USD BEFORE funding/issuing
//    so `400 error_card_creation_fee_required` never occurs.
// 3. Anti-duplicate lock before non-idempotent POST /virtual-cards or POST /disposable-cards
//    (and timeout recovery via GET /cards?account_id=... so a user is never double-issued/charged).
// 4. Card expiration clamped strictly <= 24 months out (Nuvion rejects > 2 years with 503).
// 5. ZERO PAN (number) or CVV EVER stored in SQLite or written to logs!
// 6. Disposable cards auto-sweep any remaining USD cents straight back to the user's 0x Base wallet
//    after single-use settlement (`outflows.completed`, `payment_type: "card-debit"`).
// 7. Reusable virtual cards support 1-tap Top Up (Base/Gateway -> Card USD), Unload to Main Wallet
//    (Card USD -> USC on BASE_MAINNET), Freeze, Unfreeze, Delete (with auto-unload!), and Transactions.

const crypto = require("node:crypto");
const nuvion = require("./nuvion");
const nuvionWebhooks = require("./nuvion_webhooks");
const payouts = require("./nuvion_payouts");
const db = require("./db");
const walletLib = require("./wallet");

const CARD_DEBIT_PAYMENT_TYPES = new Set(["card-debit", "card-debit-recoup"]);
const CARD_REFUND_PAYMENT_TYPES = new Set(["card-debit-reversal", "card-credit-refund"]);
const DEFAULT_MIN_AUTO_SWEEP_MINOR = 50; // $0.50 minimum leftover to sweep on disposable cards

let _cardHooksRegistered = false;

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getBotTelegram(bot) {
  if (!bot) return null;
  if (bot.telegram && typeof bot.telegram.sendMessage === "function") return bot.telegram;
  if (bot.bot?.telegram && typeof bot.bot.telegram.sendMessage === "function") return bot.bot.telegram;
  return null;
}

/**
 * Compute a valid Nuvion card expiration (strictly <= 2 years out per docs).
 * Uses +22 months so timezone boundaries never breach the 24-month ceiling.
 */
function getSafeCardExpiration(now = new Date()) {
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 22, 1));
  const month = String(target.getUTCMonth() + 1).padStart(2, "0");
  const year = String(target.getUTCFullYear()).slice(-2);
  return { expirationMonth: month, expirationYear: year };
}

/**
 * Build required Nuvion `cardholder` object from entity record or explicit Business team member overrides.
 */
async function resolveCardholder(entity, overrides = null) {
  let firstName = overrides?.first_name || overrides?.firstName || "";
  let lastName = overrides?.last_name || overrides?.lastName || "";
  let email = overrides?.email || entity.email || "";
  let phone = overrides?.phone_number || overrides?.phoneNumber || "";

  if (!firstName || !lastName || !email || !phone) {
    try {
      const live = await nuvion.getEntity(entity.entity_id);
      const p = live?.person || live?.officers?.[0] || {};
      if (!firstName && p.first_name) firstName = p.first_name;
      if (!lastName && p.last_name) lastName = p.last_name;
      if (!email && (p.email || live?.business?.email)) email = p.email || live.business.email;
      if (!phone && (p.phone_number || live?.business?.phone_number)) phone = p.phone_number || live.business.phone_number;
    } catch (_) {}
  }

  const legalParts = String(entity.legal_name || "Proxim Member").trim().split(/\s+/);
  firstName = String(firstName || legalParts[0] || "Proxim").trim();
  lastName = String(lastName || legalParts.slice(1).join(" ") || firstName).trim();
  email = String(email || `cardholder_${entity.telegram_id}@proxim.local`).trim().toLowerCase();
  phone = String(phone || "+2348000000000").trim();
  if (!phone.startsWith("+")) phone = `+${phone.replace(/\D/g, "")}`;

  return {
    first_name: firstName,
    last_name: lastName,
    email,
    phone_number: phone,
  };
}

// ── 1. Dedicated Load-to-Spend Card USD Sub-Account & Internal Book-Transfer ─

/**
 * Create a dedicated USD sub-account (`purpose: "card"`) on the child entity
 * AND register a reusable `book-transfer` payment detail pointing to its `nuvion_ban`
 * so USC bridge funds convert and land instantly (`applicable_fee: 0`) onto the card!
 */
async function createCardUsdSubAccount(entity, cardName, cardType = "virtual") {
  const entityId = entity.entity_id;
  const acc = await nuvion.createAccount({
    entityId,
    type: "checking",
    currency: "USD",
    displayName: `${cardType === "disposable" ? "Disposable" : "Card"} · ${cardName}`.slice(0, 60),
    meta: { purpose: "card", card_type: cardType },
  });

  db.upsertNuvionAccount({
    entityId,
    accountId: acc.id,
    currency: "USD",
    accountType: acc.type || "checking",
    displayName: acc.display_name,
    nuvionBan: acc.nuvion_ban || null,
    purpose: "card",
    status: acc.status || "active",
  });

  const bookTransferTarget = await ensureCardAccountBookTransferTarget(entity, acc.id, acc.nuvion_ban);
  return { account: acc, bookTransferTarget };
}

/**
 * Ensure a `book-transfer` payment detail exists under `entity.self_counterparty_id`
 * pointing to `cardAccountBan` (the card USD sub-account's `nuvion_ban`).
 */
async function ensureCardAccountBookTransferTarget(entity, cardAccountId, cardAccountBan = null) {
  const entityId = entity.entity_id;
  const label = `__card_subacct_${cardAccountId}__`;

  const cached = db.getNuvionCounterpartiesByEntity(entityId, "USD").find((c) => c.label === label);
  if (cached) {
    return { counterpartyId: cached.counterparty_id, paymentDetailId: cached.payment_detail_id };
  }

  let ensuredEntity = entity;
  if (!ensuredEntity.self_counterparty_id) {
    ensuredEntity = await nuvionWebhooks.bootstrapApprovedEntity(ensuredEntity);
  }
  if (!ensuredEntity.self_counterparty_id) {
    throw new Error("Entity self-counterparty not initialized.");
  }

  let ban = cardAccountBan;
  if (!ban) {
    const localAcc = db.getNuvionAccountsByEntity(entityId, { currency: "USD" }).find((a) => a.account_id === cardAccountId);
    ban = localAcc?.nuvion_ban || null;
  }
  if (!ban) {
    const liveAcc = await nuvion.getAccount(cardAccountId, entityId);
    ban = liveAcc?.nuvion_ban || null;
  }
  if (!ban) {
    throw new Error(`Card USD sub-account ${cardAccountId} is missing nuvion_ban.`);
  }

  const pd = await nuvion.createPaymentDetail({
    entityId,
    counterparty_id: ensuredEntity.self_counterparty_id,
    payment_method: "book-transfer",
    currency: "USD",
    account_holder_name: ensuredEntity.legal_name || "Proxim Card",
    account_number: ban,
  });

  db.saveNuvionCounterparty({
    entityId,
    counterpartyId: ensuredEntity.self_counterparty_id,
    paymentDetailId: pd.id,
    label,
    currency: "USD",
    scheme: "nuvion_direct",
    paymentMethod: "book-transfer",
    accountHolderName: ensuredEntity.legal_name || "Proxim Card",
    summary: { cardAccountId, nuvion_ban: ban, isCardInternal: true },
  });

  return { counterpartyId: ensuredEntity.self_counterparty_id, paymentDetailId: pd.id };
}

// ── 2. Live Card Creation & Top-Up Quote (Fee Check + 1% Spread) ─────────────

/**
 * Quote creating a new Virtual or Disposable USD Card:
 *  - Ensures dedicated Card USD sub-account (or checks live `GET /card-creation-fee/{account_id}?currency=USD`)
 *  - Computes creation fee + desired card spend load + 1% FX/load spread (`NUVION_FX_MARGIN_BPS=100`)
 */
async function quoteCardIssuance({
  telegramId,
  accountType = "personal",
  cardType = "virtual",
  loadAmountUsd,
  cardName = null,
}) {
  const loadAmt = Number(loadAmountUsd);
  if (!Number.isFinite(loadAmt) || loadAmt < 1) {
    throw new Error("Initial card load amount must be at least $1.00.");
  }
  if (!["virtual", "disposable"].includes(cardType)) {
    throw new Error("Card type must be 'virtual' or 'disposable'.");
  }

  const entity = await payouts.ensureApprovedBridgeEntity(telegramId, accountType);

  // Check card creation fee against any existing USD account on the entity (or create a fresh card USD sub-account)
  let feeCheckAccountId = db.getNuvionAccountsByEntity(entity.entity_id, { currency: "USD" })[0]?.account_id || null;
  if (!feeCheckAccountId) {
    const tmp = await createCardUsdSubAccount(entity, cardName || (cardType === "disposable" ? "Disposable USD" : "Proxim Virtual"), cardType);
    feeCheckAccountId = tmp.account.id;
  }

  let creationFeeMinor = 0;
  try {
    const feeRes = await nuvion.getCardCreationFee(feeCheckAccountId, {
      currency: "USD",
      entityId: entity.entity_id,
    });
    creationFeeMinor = Math.max(0, Math.round(Number(feeRes?.fee || 0)));
  } catch (err) {
    console.warn("[nuvion_cards] getCardCreationFee fallback note:", err.message);
  }

  const creationFeeUsd = nuvion.fromNuvionMinor(creationFeeMinor);
  const nuvionNeededUsd = round2(loadAmt + creationFeeUsd);
  const marginBps = nuvion.getFxMarginBps("outbound");
  const marginMinor = marginBps > 0 ? Math.max(1, nuvion.calcMarginMinor(nuvion.toNuvionMinor(loadAmt), marginBps)) : 0;
  const marginUsd = nuvion.fromNuvionMinor(marginMinor);
  const userTotalUsd = round2(nuvionNeededUsd + marginUsd);

  return {
    entity,
    cardType,
    loadAmountUsd: round2(loadAmt),
    loadAmountMinor: nuvion.toNuvionMinor(loadAmt),
    creationFeeMinor,
    creationFeeUsd,
    nuvionNeededUsd,
    nuvionNeededMinor: nuvion.toNuvionMinor(nuvionNeededUsd),
    marginBps,
    marginMinor,
    marginUsd,
    userTotalUsd,
  };
}

/**
 * Quote topping up an existing reusable Virtual USD Card (1% spread on load).
 */
async function quoteCardTopUp({ telegramId, accountType = "personal", cardId, loadAmountUsd }) {
  const loadAmt = Number(loadAmountUsd);
  if (!Number.isFinite(loadAmt) || loadAmt < 1) {
    throw new Error("Top-up amount must be at least $1.00.");
  }
  const entity = await payouts.ensureApprovedBridgeEntity(telegramId, accountType);
  const card = db.getNuvionCardsByEntity(entity.entity_id).find((c) => c.card_id === cardId);
  if (!card) throw new Error("Card not found.");
  if (card.card_type === "disposable") {
    throw new Error("Disposable cards are single-use and cannot be topped up.");
  }
  if (card.status === "deleted" || card.status === "deactivated") {
    throw new Error("This card is inactive and cannot be topped up.");
  }

  const marginBps = nuvion.getFxMarginBps("outbound");
  const marginMinor = marginBps > 0 ? Math.max(1, nuvion.calcMarginMinor(nuvion.toNuvionMinor(loadAmt), marginBps)) : 0;
  const marginUsd = nuvion.fromNuvionMinor(marginMinor);
  const userTotalUsd = round2(loadAmt + marginUsd);

  return {
    entity,
    card,
    loadAmountUsd: round2(loadAmt),
    loadAmountMinor: nuvion.toNuvionMinor(loadAmt),
    marginBps,
    marginMinor,
    marginUsd,
    userTotalUsd,
  };
}

// ── 3. Initiate Card Issuance (Load-to-Spend + Anti-Duplicate Lock!) ─────────

/**
 * Step A (User confirms PIN):
 *  1. Verifies PIN & checks no duplicate active `card_issue` lock exists for this user/request
 *  2. Creates dedicated USD Card sub-account (`purpose: "card"`) + internal book-transfer payment detail
 *  3. Reads exact live `GET /card-creation-fee/{cardAccountId}?currency=USD`
 *  4. Funds Nuvion USC Base bridge for `loadAmountUsd + creationFeeUsd` (+ 1% spread to fee wallet)
 *  5. Creates durable `nuvion_jobs` (`job_type: "card_issue"`, `state: "funding_in_transit"`)
 */
async function initiateCardIssuance({
  telegramId,
  pin,
  accountType = "personal",
  cardType = "virtual",
  cardName,
  loadAmountUsd,
  cardholderOverrides = null,
  bot = null,
  fundingExecutor = null,
}) {
  const user = db.getUser(telegramId);
  if (!user) throw new Error("User account not found.");
  if (!db.verifyPin(telegramId, pin)) throw new Error("Incorrect PIN.");

  const cleanCardName = String(cardName || (cardType === "disposable" ? "Disposable Card" : "Proxim USD Card")).trim().slice(0, 50);
  const entity = await payouts.ensureApprovedBridgeEntity(telegramId, accountType);

  // Anti-duplicate lock check: never allow two concurrent card-issue jobs for the same entity/name
  const inFlight = [
    ...db.getNuvionJobsByState("card_issue", "funding_in_transit"),
    ...db.getNuvionJobsByState("card_issue", "issuing_card"),
  ].find((j) => j.entity_id === entity.entity_id && j.payload?.cardName === cleanCardName);

  if (inFlight) {
    throw new Error(`Card "${cleanCardName}" is already being issued. Please wait a moment.`);
  }

  // Dedicated USD sub-account per card so its balance.available IS this card's exact spend limit!
  const { account: cardSubAcc, bookTransferTarget } = await createCardUsdSubAccount(entity, cleanCardName, cardType);

  let creationFeeMinor = 0;
  try {
    const feeRes = await nuvion.getCardCreationFee(cardSubAcc.id, {
      currency: "USD",
      entityId: entity.entity_id,
    });
    creationFeeMinor = Math.max(0, Math.round(Number(feeRes?.fee || 0)));
  } catch (err) {
    console.warn("[nuvion_cards] getCardCreationFee note:", err.message);
  }

  const loadAmt = round2(Number(loadAmountUsd));
  if (!Number.isFinite(loadAmt) || loadAmt < 1) {
    throw new Error("Initial card load amount must be at least $1.00.");
  }

  const creationFeeUsd = nuvion.fromNuvionMinor(creationFeeMinor);
  const nuvionNeededUsd = round2(loadAmt + creationFeeUsd);
  const marginBps = nuvion.getFxMarginBps("outbound");
  const marginMinor = marginBps > 0 ? Math.max(1, nuvion.calcMarginMinor(nuvion.toNuvionMinor(loadAmt), marginBps)) : 0;
  const marginUsd = nuvion.fromNuvionMinor(marginMinor);
  const userTotalUsd = round2(nuvionNeededUsd + marginUsd);

  const cardholder = await resolveCardholder(entity, cardholderOverrides);
  const { expirationMonth, expirationYear } = getSafeCardExpiration();

  // Fund user's Nuvion USC Base deposit address from unified balance (zero Base ETH needed on user wallet!)
  const funding = await payouts.fundNuvionBaseBridge({
    user,
    pin,
    accountType,
    nuvionBaseAddress: entity.usc_base_address,
    nuvionCostUsd: nuvionNeededUsd,
    marginUsd,
    bot,
    fundingExecutor,
  });

  const uniqueReference = `prx-card-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const job = db.createNuvionJob({
    entityId: entity.entity_id,
    telegramId,
    accountType,
    jobType: "card_issue",
    state: "funding_in_transit",
    currency: "USD",
    amountMinor: nuvion.toNuvionMinor(nuvionNeededUsd),
    marginMinor,
    uniqueReference,
    sourceTxHash: funding.txHash || null,
    payload: {
      cardType,
      cardName: cleanCardName,
      cardAccountId: cardSubAcc.id,
      cardAccountBan: cardSubAcc.nuvion_ban || null,
      bookTransferCounterpartyId: bookTransferTarget.counterpartyId,
      bookTransferPaymentDetailId: bookTransferTarget.paymentDetailId,
      loadAmountUsd: loadAmt,
      creationFeeUsd,
      creationFeeMinor,
      nuvionNeededUsd,
      nuvionNeededMinor: nuvion.toNuvionMinor(nuvionNeededUsd),
      userTotalUsd,
      cardholder,
      expirationMonth,
      expirationYear,
      fundingRoute: funding.route,
      fundingTxHash: funding.txHash || null,
    },
  });

  return {
    job,
    cardAccountId: cardSubAcc.id,
    loadAmountUsd: loadAmt,
    creationFeeUsd,
    marginUsd,
    userTotalUsd,
    funding,
    uniqueReference,
  };
}

/**
 * Initiate topping up an existing reusable Virtual USD Card (Load-to-Spend).
 */
async function initiateCardTopUp({
  telegramId,
  pin,
  accountType = "personal",
  cardId,
  loadAmountUsd,
  bot = null,
  fundingExecutor = null,
}) {
  const user = db.getUser(telegramId);
  if (!user) throw new Error("User account not found.");
  if (!db.verifyPin(telegramId, pin)) throw new Error("Incorrect PIN.");

  const q = await quoteCardTopUp({ telegramId, accountType, cardId, loadAmountUsd });
  const { entity, card } = q;

  const bookTransferTarget = await ensureCardAccountBookTransferTarget(entity, card.account_id);

  const funding = await payouts.fundNuvionBaseBridge({
    user,
    pin,
    accountType,
    nuvionBaseAddress: entity.usc_base_address,
    nuvionCostUsd: q.loadAmountUsd,
    marginUsd: q.marginUsd,
    bot,
    fundingExecutor,
  });

  const uniqueReference = `prx-ctop-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const job = db.createNuvionJob({
    entityId: entity.entity_id,
    telegramId,
    accountType,
    jobType: "card_topup",
    state: "funding_in_transit",
    currency: "USD",
    amountMinor: q.loadAmountMinor,
    marginMinor: q.marginMinor,
    uniqueReference,
    sourceTxHash: funding.txHash || null,
    cardId: card.card_id,
    payload: {
      cardId: card.card_id,
      cardName: card.card_name || "Virtual Card",
      cardAccountId: card.account_id,
      bookTransferCounterpartyId: bookTransferTarget.counterpartyId,
      bookTransferPaymentDetailId: bookTransferTarget.paymentDetailId,
      loadAmountUsd: q.loadAmountUsd,
      loadAmountMinor: q.loadAmountMinor,
      userTotalUsd: q.userTotalUsd,
      fundingRoute: funding.route,
      fundingTxHash: funding.txHash || null,
    },
  });

  return { job, quote: q, funding, uniqueReference };
}

// ── 4. Complete Card Issuance / Top-Up When USC Lands on Nuvion Bridge ───────

/**
 * Convert arrived USC -> USD into the card's dedicated USD sub-account via instant 0-fee book-transfer.
 */
async function _fundCardSubAccountFromUscBridge({ entity, uscMinor, counterpartyId, paymentDetailId, uniqueReference, narration }) {
  const quote = await nuvion.createFxQuote({
    entityId: entity.entity_id,
    fromCurrency: "USC",
    toCurrency: "USD",
    amountFrom: uscMinor,
    accountId: entity.usc_account_id,
  });

  const transfer = await nuvion.createTransfer({
    entityId: entity.entity_id,
    accountId: entity.usc_account_id,
    counterpartyId,
    paymentDetailId,
    amountMinor: quote.amount_from,
    currency: "USC",
    narration: narration || "Card funding",
    paymentType: "book-transfer",
    fxQuoteId: quote.id,
    uniqueReference,
  });

  return { quote, transfer, creditedUsdMinor: quote.amount_to };
}

/**
 * Triggered automatically on `inflows.completed` (`currency === "USC"`, `status === "successful"`):
 *  - Completes queued `card_issue` (fund USD sub-account -> atomic lock -> issue virtual/disposable card -> notify user!)
 *  - Or completes queued `card_topup` (fund USD sub-account -> notify user of updated spend cap!)
 */
async function handleUscInflowForCardJobs({ confirmed, entityRecord, bot = null }) {
  if (!confirmed || !entityRecord) return { handled: false, reason: "missing_context" };
  if (String(confirmed.currency || "").toUpperCase() !== "USC" || String(confirmed.status || "").toLowerCase() !== "successful") {
    return { handled: false, reason: "not_settled_usc" };
  }

  const netArrivedMinor = Math.max(0, Math.round(Number(confirmed.amount || 0)) - Math.round(Number(confirmed.applicable_fee || 0)));
  if (netArrivedMinor <= 0) return { handled: false, reason: "zero_net" };

  // Check queued card_issue first, then card_topup
  const issueJob = db
    .getNuvionJobsByState("card_issue", "funding_in_transit")
    .find((j) => j.entity_id === entityRecord.entity_id);

  const telegram = getBotTelegram(bot);

  if (issueJob) {
    const p = issueJob.payload || {};
    // Acquire atomic state lock BEFORE non-idempotent POST /*-cards!
    const locked = db.db
      .prepare("UPDATE nuvion_jobs SET state = 'issuing_card', updated_at = datetime('now') WHERE id = ? AND state = 'funding_in_transit'")
      .run(issueJob.id);
    if (!locked || locked.changes === 0) {
      return { handled: false, duplicate: true, jobId: issueJob.id };
    }

    try {
      // Step 1: Instantly convert USC -> USD into the card's dedicated USD sub-account
      const fundRes = await _fundCardSubAccountFromUscBridge({
        entity: entityRecord,
        uscMinor: netArrivedMinor,
        counterpartyId: p.bookTransferCounterpartyId,
        paymentDetailId: p.bookTransferPaymentDetailId,
        uniqueReference: `bt-${issueJob.unique_reference}`,
        narration: `Load card ${p.cardName}`,
      });

      // Step 2: Check if a card was already created on this sub-account (timeout recovery guard!)
      let createdCard = null;
      try {
        const existingList = await nuvion.listCards({ entityId: entityRecord.entity_id, accountId: p.cardAccountId, limit: 5 });
        const rows = existingList?.data || [];
        createdCard = rows.find((c) => c.status !== "deleted") || null;
      } catch (_) {}

      // Step 3: Issue card (NON-IDEMPOTENT — called strictly once under lock!)
      if (!createdCard) {
        const cardReq = {
          entityId: entityRecord.entity_id,
          accountId: p.cardAccountId,
          cardName: p.cardName,
          currency: "USD",
          cardholder: p.cardholder,
          expirationMonth: p.expirationMonth,
          expirationYear: p.expirationYear,
        };
        createdCard = p.cardType === "disposable"
          ? await nuvion.createDisposableCard(cardReq)
          : await nuvion.createVirtualCard(cardReq);
      }

      // NEVER store raw PAN (`number`) or `cvv` in SQLite or logs! Only store last4 & metadata.
      const last4 = createdCard?.number ? String(createdCard.number).slice(-4) : (createdCard?.last4 || null);
      db.upsertNuvionCard({
        entityId: entityRecord.entity_id,
        accountId: p.cardAccountId,
        cardId: createdCard.id,
        cardType: p.cardType,
        cardName: createdCard.name || p.cardName,
        currency: "USD",
        last4,
        status: createdCard.status || "active",
      });

      db.updateNuvionJob(issueJob.id, {
        state: "completed",
        card_id: createdCard.id,
        nuvion_transfer_id: fundRes.transfer.id,
        fx_quote_id: fundRes.quote.id,
        payload_json: {
          ...p,
          cardId: createdCard.id,
          last4,
          fundedUsdMinor: fundRes.creditedUsdMinor,
        },
      });

      try {
        const amountMicro = walletLib.parseToMicro(Number(p.userTotalUsd || p.loadAmountUsd || 0).toFixed(6));
        db.recordTransaction(
          issueJob.telegram_id,
          "card_load",
          String(amountMicro),
          "confirmed",
          createdCard.id,
          issueJob.account_type || "personal",
          18,
          "base",
          `Issued ${p.cardType} card: ${p.cardName}`
        );
      } catch (_) {}

      if (telegram && issueJob.telegram_id) {
        const kindLabel = p.cardType === "disposable" ? "Disposable 1-Time USD Card" : "Virtual USD Card";
        const tailStr = last4 ? ` (•••• ${last4})` : "";
        await telegram.sendMessage(
          issueJob.telegram_id,
          `🎉 <b>Your ${kindLabel} Is Active!</b>\n` +
          `──────────────────────────\n` +
          `💳 <b>Card:</b> ${escapeHtml(p.cardName)}${tailStr}\n` +
          `💵 <b>Loaded Spend Cap:</b> $${Number(p.loadAmountUsd || 0).toFixed(2)}\n` +
          (p.cardType === "disposable"
            ? `🔒 <b>Single-Use Protection:</b> Auto-deactivates after 1 charge &amp; sweeps any leftover balance back to your main Proxim balance!\n\n`
            : `\n`) +
          `<i>Open 💳 Cards anytime to reveal your PIN-protected card details, top up, freeze, or unload unused funds back to your balance.</i>`,
          { parse_mode: "HTML" }
        ).catch(() => {});
      }

      return { handled: true, jobType: "card_issue", jobId: issueJob.id, cardId: createdCard.id, last4 };
    } catch (err) {
      db.updateNuvionJob(issueJob.id, {
        state: "failed",
        error_message: err.message,
      });
      throw err;
    }
  }

  // Check queued card_topup
  const topupJob = db
    .getNuvionJobsByState("card_topup", "funding_in_transit")
    .find((j) => j.entity_id === entityRecord.entity_id);

  if (topupJob) {
    const p = topupJob.payload || {};
    const locked = db.db
      .prepare("UPDATE nuvion_jobs SET state = 'processing', updated_at = datetime('now') WHERE id = ? AND state = 'funding_in_transit'")
      .run(topupJob.id);
    if (!locked || locked.changes === 0) {
      return { handled: false, duplicate: true, jobId: topupJob.id };
    }

    try {
      const fundRes = await _fundCardSubAccountFromUscBridge({
        entity: entityRecord,
        uscMinor: netArrivedMinor,
        counterpartyId: p.bookTransferCounterpartyId,
        paymentDetailId: p.bookTransferPaymentDetailId,
        uniqueReference: `bt-${topupJob.unique_reference}`,
        narration: `Top up card ${p.cardName}`,
      });

      db.updateNuvionJob(topupJob.id, {
        state: "completed",
        nuvion_transfer_id: fundRes.transfer.id,
        fx_quote_id: fundRes.quote.id,
      });

      const creditedUsd = nuvion.fromNuvionMinor(fundRes.creditedUsdMinor);
      try {
        const amountMicro = walletLib.parseToMicro(Number(p.userTotalUsd || creditedUsd).toFixed(6));
        db.recordTransaction(
          topupJob.telegram_id,
          "card_load",
          String(amountMicro),
          "confirmed",
          fundRes.transfer.id,
          topupJob.account_type || "personal",
          18,
          "base",
          `Topped up card: ${p.cardName}`
        );
      } catch (_) {}

      if (telegram && topupJob.telegram_id) {
        await telegram.sendMessage(
          topupJob.telegram_id,
          `✅ <b>Card Topped Up!</b>\n` +
          `──────────────────────────\n` +
          `💳 <b>Card:</b> ${escapeHtml(p.cardName || "Virtual Card")}\n` +
          `💵 <b>Added to Card Limit:</b> +$${creditedUsd.toFixed(2)}\n` +
          `<i>Ready to spend immediately!</i>`,
          { parse_mode: "HTML" }
        ).catch(() => {});
      }

      return { handled: true, jobType: "card_topup", jobId: topupJob.id, cardId: topupJob.card_id, creditedUsd };
    } catch (err) {
      db.updateNuvionJob(topupJob.id, { state: "failed", error_message: err.message });
      throw err;
    }
  }

  return { handled: false, reason: "no_pending_card_jobs" };
}

// ── 5. Unload Card Balance Back to Main Proxim Wallet (Base 0x) ──────────────

/**
 * Unload remaining available USD from a card's dedicated sub-account straight back
 * to the user's own 0x wallet on BASE_MAINNET (`USD -> USC` stablecoin-transfer).
 * Used both for explicit user "Unload to Balance" AND Disposable leftover auto-sweep!
 */
async function unloadCardToMainWallet({
  telegramId,
  accountType = "personal",
  cardId,
  amountUsd = null, // null = unload 100% of available balance
  reason = "Card unload to main wallet",
  minAutoSweepMinor = 1,
  bot = null,
}) {
  let entity = db.getNuvionEntityByUser(telegramId, accountType);
  if (!entity || String(entity.status).toLowerCase() !== "approved") {
    throw new Error("Approved Tier-1 entity required.");
  }
  if (!entity.self_counterparty_id || !entity.self_base_payment_detail_id) {
    entity = await nuvionWebhooks.bootstrapApprovedEntity(entity);
  }

  const card = db.getNuvionCardsByEntity(entity.entity_id).find((c) => c.card_id === cardId)
    || db.prepare("SELECT * FROM nuvion_cards WHERE card_id = ? AND entity_id = ?").get(String(cardId), entity.entity_id);
  if (!card) throw new Error("Card not found.");

  const liveAcc = await nuvion.getAccount(card.account_id, entity.entity_id);
  const availMinor = Math.max(0, Math.round(Number(liveAcc?.balance?.available || 0)));

  if (availMinor < minAutoSweepMinor) {
    return { unloaded: false, reason: "below_threshold", availableUsd: nuvion.fromNuvionMinor(availMinor) };
  }

  let targetMinor = amountUsd != null ? Math.min(availMinor, nuvion.toNuvionMinor(amountUsd)) : availMinor;
  if (targetMinor <= 0) {
    return { unloaded: false, reason: "zero_amount", availableUsd: nuvion.fromNuvionMinor(availMinor) };
  }

  const uniqueBase = `prx-cunload-${cardId.slice(-8)}-${Date.now()}`;
  let quote = null;
  let transfer = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      quote = await nuvion.createFxQuote({
        entityId: entity.entity_id,
        fromCurrency: "USD",
        toCurrency: "USC",
        amountFrom: targetMinor,
        accountId: card.account_id,
      });

      const ref = attempt === 0 ? uniqueBase : `${uniqueBase}-r${attempt}`;
      transfer = await nuvion.createTransfer({
        entityId: entity.entity_id,
        accountId: card.account_id,
        counterpartyId: entity.self_counterparty_id,
        paymentDetailId: entity.self_base_payment_detail_id,
        amountMinor: targetMinor,
        currency: "USD",
        narration: `${reason} (${card.card_name || cardId})`.slice(0, 100),
        paymentType: "stablecoin-transfer",
        fxQuoteId: quote.id,
        uniqueReference: ref,
      });
      break;
    } catch (err) {
      if (attempt === 0 && err instanceof nuvion.NuvionError && err.type === "error_transfer_insufficient_funds") {
        const feeBuf = Math.max(50, Math.ceil(targetMinor * 0.015));
        if (targetMinor - feeBuf > 0) {
          targetMinor -= feeBuf;
          continue;
        }
      }
      throw err;
    }
  }

  const unloadedUsd = nuvion.fromNuvionMinor(quote.amount_to);
  db.createNuvionJob({
    entityId: entity.entity_id,
    telegramId,
    accountType,
    jobType: "card_unload",
    state: "completed",
    currency: "USD",
    amountMinor: targetMinor,
    uniqueReference: uniqueBase,
    nuvionTransferId: transfer.id,
    fxQuoteId: quote.id,
    cardId: card.card_id,
    payload: { cardId: card.card_id, cardName: card.card_name, unloadedUsd, reason },
  });

  if (process.env.NODE_ENV !== "test") {
    setTimeout(() => {
      try {
        const evmDepositSweeper = require("./evm_deposit_sweeper");
        evmDepositSweeper.sweepUserDeposits(entity.telegram_id, null, { silent: true }).catch(() => {});
      } catch (_) {}
    }, 15000);
  }

  return {
    unloaded: true,
    cardId: card.card_id,
    transferId: transfer.id,
    unloadedUsd,
  };
}

// ── 6. Card Controls, Sensitive Reveal (Never Logged/Stored), Balance Rollup ─

/**
 * List active/frozen/deactivated cards for a user's entity with live spendable balance per card!
 */
async function getUserCardsWithBalances(telegramId, accountType = "personal") {
  const entity = db.getNuvionEntityByUser(telegramId, accountType);
  if (!entity || String(entity.status).toLowerCase() !== "approved") {
    return { entity: null, cards: [], totalCardBalanceUsd: 0 };
  }

  const localCards = db.getNuvionCardsByEntity(entity.entity_id);
  const enriched = [];
  let totalCardBalanceUsd = 0;

  for (const card of localCards) {
    let availableUsd = 0;
    try {
      const liveAcc = await nuvion.getAccount(card.account_id, entity.entity_id);
      availableUsd = nuvion.fromNuvionMinor(liveAcc?.balance?.available || 0);
    } catch (_) {}
    totalCardBalanceUsd = round2(totalCardBalanceUsd + availableUsd);
    enriched.push({
      ...card,
      availableUsd,
    });
  }

  return { entity, cards: enriched, totalCardBalanceUsd };
}

/**
 * Lightweight total loaded card allocation for the unified Balance screen (`• Cards Loaded: $X.XX`).
 * Never blocks balance display (strict 2.5s timeout, returns 0 on error or in unit tests without flag).
 */
async function getTotalLoadedCardUsd(telegramId, accountType = "personal") {
  if (!nuvion.isUserAllowedNuvion(telegramId)) return 0;
  if (process.env.NODE_ENV === "test" && process.env.ENABLE_CARD_BALANCE_READ !== "true") return 0;
  try {
    const res = await Promise.race([
      getUserCardsWithBalances(telegramId, accountType),
      new Promise((resolve) => setTimeout(() => resolve({ totalCardBalanceUsd: 0 }), 2500)),
    ]);
    return Number(res?.totalCardBalanceUsd || 0);
  } catch (_) {
    return 0;
  }
}

/**
 * PIN-verified sensitive card credentials fetch (`GET /card-details/{card_id}`).
 * NEVER logs or persists PAN (`number`) or `cvv`!
 */
async function revealCardDetailsWithPin({ telegramId, pin, accountType = "personal", cardId }) {
  const user = db.getUser(telegramId);
  if (!user) throw new Error("User account not found.");
  if (!db.verifyPin(telegramId, pin)) throw new Error("Incorrect PIN.");

  const entity = db.getNuvionEntityByUser(telegramId, accountType);
  if (!entity) throw new Error("Global banking profile not found.");

  const card = db.getNuvionCardsByEntity(entity.entity_id).find((c) => c.card_id === cardId);
  if (!card) throw new Error("Card not found.");

  const details = await nuvion.getCardDetails(cardId, entity.entity_id);
  let availableUsd = 0;
  try {
    const liveAcc = await nuvion.getAccount(card.account_id, entity.entity_id);
    availableUsd = nuvion.fromNuvionMinor(liveAcc?.balance?.available || 0);
  } catch (_) {}

  // Update only safe non-sensitive last4 & status in DB (NEVER number or cvv!)
  const safeLast4 = details?.number ? String(details.number).slice(-4) : card.last4;
  db.upsertNuvionCard({
    entityId: entity.entity_id,
    accountId: card.account_id,
    cardId: card.card_id,
    cardType: details?.type || card.card_type,
    cardName: details?.name || card.card_name,
    currency: details?.currency || "USD",
    last4: safeLast4,
    status: details?.status || card.status,
  });

  return {
    cardId: card.card_id,
    name: details?.name || card.card_name,
    type: details?.type || card.card_type,
    status: details?.status || card.status,
    number: details?.number || null, // Ephemeral in memory only!
    cvv: details?.cvv || null,       // Ephemeral in memory only!
    expirationMonth: details?.expiration_month || null,
    expirationYear: details?.expiration_year || null,
    cardholderName: [details?.first_name, details?.last_name].filter(Boolean).join(" ") || entity.legal_name,
    billing: details?.billing || null,
    availableUsd,
  };
}

async function setCardFrozen({ telegramId, accountType = "personal", cardId, freeze = true }) {
  const entity = db.getNuvionEntityByUser(telegramId, accountType);
  if (!entity) throw new Error("Global banking profile not found.");
  const card = db.getNuvionCardsByEntity(entity.entity_id).find((c) => c.card_id === cardId);
  if (!card) throw new Error("Card not found.");

  const updated = freeze
    ? await nuvion.freezeCard(cardId, entity.entity_id)
    : await nuvion.unfreezeCard(cardId, entity.entity_id);

  const nextStatus = updated?.status || (freeze ? "blocked" : "active");
  db.upsertNuvionCard({
    entityId: entity.entity_id,
    accountId: card.account_id,
    cardId: card.card_id,
    cardType: card.card_type,
    cardName: card.card_name,
    currency: card.currency || "USD",
    last4: card.last4,
    status: nextStatus,
  });

  return { cardId, status: nextStatus };
}

/**
 * Permanently soft-delete a card AND automatically unload any remaining USD back to user's main wallet!
 */
async function deleteCardAndUnload({ telegramId, accountType = "personal", cardId, bot = null }) {
  const entity = db.getNuvionEntityByUser(telegramId, accountType);
  if (!entity) throw new Error("Global banking profile not found.");
  const card = db.getNuvionCardsByEntity(entity.entity_id).find((c) => c.card_id === cardId);
  if (!card) throw new Error("Card not found.");

  await nuvion.deleteCard(cardId, entity.entity_id);
  db.upsertNuvionCard({
    entityId: entity.entity_id,
    accountId: card.account_id,
    cardId: card.card_id,
    cardType: card.card_type,
    cardName: card.card_name,
    currency: card.currency || "USD",
    last4: card.last4,
    status: "deleted",
  });

  let unloadRes = { unloaded: false, unloadedUsd: 0 };
  try {
    unloadRes = await unloadCardToMainWallet({
      telegramId,
      accountType,
      cardId,
      reason: "Deleted card balance sweep",
      minAutoSweepMinor: Number(process.env.NUVION_CARD_AUTO_SWEEP_MIN_MINOR || DEFAULT_MIN_AUTO_SWEEP_MINOR),
      bot,
    });
  } catch (err) {
    console.warn("[nuvion_cards] deleteCard unload note:", err.message);
  }

  return { deleted: true, cardId, unloadedUsd: unloadRes.unloaded ? unloadRes.unloadedUsd : 0 };
}

async function fetchCardTransactions({ telegramId, accountType = "personal", cardId, limit = 10 }) {
  const entity = db.getNuvionEntityByUser(telegramId, accountType);
  if (!entity) throw new Error("Global banking profile not found.");
  const res = await nuvion.getCardTransactions(cardId, { entityId: entity.entity_id, limit });
  return res?.data || [];
}

// ── 7. Real-Time Spend / Decline / Refund Webhooks + Disposable Auto-Sweep ───

function _findCardForWebhookTransfer(confirmed, data, entityId) {
  const cardId = confirmed?.card_id || data?.card_id || confirmed?.meta?.card_id || null;
  if (cardId) {
    const byId = db.prepare("SELECT * FROM nuvion_cards WHERE card_id = ? LIMIT 1").get(String(cardId));
    if (byId) return byId;
  }
  const accountId = confirmed?.account_id || data?.account_id || data?.account?.id || null;
  if (accountId && entityId) {
    const byAcc = db
      .prepare("SELECT * FROM nuvion_cards WHERE entity_id = ? AND account_id = ? ORDER BY id DESC LIMIT 1")
      .get(String(entityId), String(accountId));
    if (byAcc) return byAcc;
  }
  return null;
}

async function handleCardOutflowWebhook({ event, confirmed, data, entityRecord, bot = null }) {
  const paymentType = String(confirmed?.payment_type || data?.payment_type || "").toLowerCase();
  const isDebit = CARD_DEBIT_PAYMENT_TYPES.has(paymentType);
  const isRefund = CARD_REFUND_PAYMENT_TYPES.has(paymentType) || event === "outflows.refunded";
  if (!isDebit && !isRefund) return { handled: false, reason: "not_card_event" };

  const entityId = entityRecord?.entity_id || confirmed?.entity_id || data?.entity_id || null;
  const card = _findCardForWebhookTransfer(confirmed, data, entityId);
  const entity = entityRecord || (entityId ? db.getNuvionEntityByEntityId(entityId) : null);
  if (!entity) return { handled: false, reason: "missing_entity" };

  const amountUsd = nuvion.fromNuvionMinor(confirmed?.amount || data?.amount || 0);
  const merchant = confirmed?.recipient?.name || confirmed?.narration || data?.narration || "Card Merchant";
  const cardLabel = card ? `${card.card_name || "USD Card"}${card.last4 ? ` (•••• ${card.last4})` : ""}` : "USD Card";
  const telegram = getBotTelegram(bot);

  let remainingUsd = null;
  if (card?.account_id) {
    try {
      const acc = await nuvion.getAccount(card.account_id, entity.entity_id);
      remainingUsd = nuvion.fromNuvionMinor(acc?.balance?.available || 0);
    } catch (_) {}
  }

  // Case 1: Card Debit Settled (`outflows.completed`)
  if (event === "outflows.completed" && isDebit) {
    let sweptLeftoverUsd = 0;

    // Disposable card -> mark deactivated & auto-sweep any remaining cents straight back to main wallet!
    if (card && card.card_type === "disposable") {
      db.upsertNuvionCard({
        entityId: entity.entity_id,
        accountId: card.account_id,
        cardId: card.card_id,
        cardType: "disposable",
        cardName: card.card_name,
        currency: card.currency || "USD",
        last4: card.last4,
        status: "deactivated",
      });

      try {
        const sweepRes = await unloadCardToMainWallet({
          telegramId: entity.telegram_id,
          accountType: entity.account_type || "personal",
          cardId: card.card_id,
          reason: "Disposable card leftover auto-sweep",
          minAutoSweepMinor: Number(process.env.NUVION_CARD_AUTO_SWEEP_MIN_MINOR || DEFAULT_MIN_AUTO_SWEEP_MINOR),
          bot,
        });
        if (sweepRes.unloaded) {
          sweptLeftoverUsd = sweepRes.unloadedUsd;
          remainingUsd = 0;
        }
      } catch (sweepErr) {
        console.warn("[nuvion_cards] Disposable auto-sweep note:", sweepErr.message);
      }
    }

    try {
      const amountMicro = walletLib.parseToMicro(amountUsd.toFixed(6));
      db.recordTransaction(
        entity.telegram_id,
        "card_spend",
        String(amountMicro),
        "confirmed",
        confirmed?.id || data?.id || null,
        entity.account_type || "personal",
        18,
        "base",
        `${cardLabel}: ${merchant}`
      );
    } catch (_) {}

    if (telegram && entity.telegram_id) {
      const sweepNote = sweptLeftoverUsd > 0
        ? `\n↩️ <b>Leftover Returned:</b> $${sweptLeftoverUsd.toFixed(2)} automatically swept back to your main Proxim balance!`
        : (remainingUsd !== null ? `\n💰 <b>Remaining Card Limit:</b> $${remainingUsd.toFixed(2)}` : "");
      await telegram.sendMessage(
        entity.telegram_id,
        `💳 <b>Card Purchase Approved</b>\n` +
        `──────────────────────────\n` +
        `• <b>Merchant:</b> ${escapeHtml(merchant)}\n` +
        `• <b>Amount:</b> $${amountUsd.toFixed(2)}\n` +
        `• <b>Card:</b> ${escapeHtml(cardLabel)}${sweepNote}`,
        { parse_mode: "HTML" }
      ).catch(() => {});
    }

    return { handled: true, type: "card_spend", amountUsd, sweptLeftoverUsd };
  }

  // Case 2: Card Debit Declined (`outflows.failed`)
  if (event === "outflows.failed" && isDebit) {
    if (telegram && entity.telegram_id) {
      await telegram.sendMessage(
        entity.telegram_id,
        `⚠️ <b>Card Charge Declined</b>\n` +
        `──────────────────────────\n` +
        `• <b>Merchant:</b> ${escapeHtml(merchant)}\n` +
        `• <b>Attempted:</b> $${amountUsd.toFixed(2)}\n` +
        `• <b>Card:</b> ${escapeHtml(cardLabel)}\n` +
        (remainingUsd !== null ? `• <b>Available on Card:</b> $${remainingUsd.toFixed(2)}\n` : "") +
        `\n<i>Top up your card or unfreeze it from 💳 Cards if you want to retry.</i>`,
        { parse_mode: "HTML" }
      ).catch(() => {});
    }
    return { handled: true, type: "card_declined", amountUsd };
  }

  // Case 3: Card Refund or Reversal (`outflows.refunded`)
  if (isRefund) {
    let sweptRefundUsd = 0;
    // If card is already deactivated or deleted, sweep refunded funds right back to main wallet!
    if (card && (card.status === "deactivated" || card.status === "deleted" || card.card_type === "disposable")) {
      try {
        const sweepRes = await unloadCardToMainWallet({
          telegramId: entity.telegram_id,
          accountType: entity.account_type || "personal",
          cardId: card.card_id,
          reason: "Card refund auto-sweep to main wallet",
          minAutoSweepMinor: Number(process.env.NUVION_CARD_AUTO_SWEEP_MIN_MINOR || DEFAULT_MIN_AUTO_SWEEP_MINOR),
          bot,
        });
        if (sweepRes.unloaded) sweptRefundUsd = sweepRes.unloadedUsd;
      } catch (_) {}
    }

    if (telegram && entity.telegram_id) {
      const destLine = sweptRefundUsd > 0
        ? `↩️ <b>Returned to Main Balance:</b> $${sweptRefundUsd.toFixed(2)}`
        : (remainingUsd !== null ? `💰 <b>Updated Card Balance:</b> $${remainingUsd.toFixed(2)}` : "");
      await telegram.sendMessage(
        entity.telegram_id,
        `🔄 <b>Card Refund Received!</b>\n` +
        `──────────────────────────\n` +
        `• <b>Merchant:</b> ${escapeHtml(merchant)}\n` +
        `• <b>Refunded:</b> +$${amountUsd.toFixed(2)}\n` +
        `• <b>Card:</b> ${escapeHtml(cardLabel)}\n` +
        (destLine ? `${destLine}` : ""),
        { parse_mode: "HTML" }
      ).catch(() => {});
    }
    return { handled: true, type: "card_refund", amountUsd, sweptRefundUsd };
  }

  return { handled: false, reason: "unhandled_card_event" };
}

// ── 8. Register Phase 4 Webhook Hooks (Idempotent) ───────────────────────────

function registerCardHooks() {
  if (_cardHooksRegistered) return;
  _cardHooksRegistered = true;

  nuvionWebhooks.onNuvionEvent("inflows.completed", async ({ confirmed, entityRecord, bot }) => {
    if (!entityRecord) return;
    if (String(confirmed?.currency || "").toUpperCase() !== "USC") return;
    await handleUscInflowForCardJobs({ confirmed, entityRecord, bot });
  });

  for (const evt of ["outflows.completed", "outflows.failed", "outflows.refunded"]) {
    nuvionWebhooks.onNuvionEvent(evt, async ({ confirmed, data, entityRecord, bot }) => {
      await handleCardOutflowWebhook({ event: evt, confirmed, data, entityRecord, bot });
    });
  }
}

module.exports = {
  getSafeCardExpiration,
  resolveCardholder,
  createCardUsdSubAccount,
  ensureCardAccountBookTransferTarget,
  quoteCardIssuance,
  quoteCardTopUp,
  initiateCardIssuance,
  initiateCardTopUp,
  handleUscInflowForCardJobs,
  unloadCardToMainWallet,
  getUserCardsWithBalances,
  getTotalLoadedCardUsd,
  revealCardDetailsWithPin,
  setCardFrozen,
  deleteCardAndUnload,
  fetchCardTransactions,
  handleCardOutflowWebhook,
  registerCardHooks,
};
