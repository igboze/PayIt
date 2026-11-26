// src/nuvion_webhooks.js
// Production Nuvion Webhook Handler & Base Pass-Through Entity Bootstrapper
//
// Core safety guarantees (per docs.nuvion.co/webhooks/overview):
// 1. Raw-body HMAC-SHA256 verification: HMAC_SHA256(nv_wsk_..., "{timestamp}.{rawBody}")
// 2. Immediate 200 OK acknowledgement before async processing (prevents 3-strike 24h blacklisting)
// 3. Strict idempotency deduplication on x-nuvion-event-id
// 4. Confirm state before acting via GET /entities, GET /account-details, GET /transfers, GET /funding-sessions
// 5. Never registers Circle GatewayWallet as a direct Nuvion transfer address (EOA only!)

const nuvion = require("./nuvion");
const db = require("./db");
const idempotency = require("./idempotency");
const walletLib = require("./wallet");
const emailModule = require("./email");
const notifyModule = require("./notify");

const CIRCLE_GATEWAY_WALLET_ADDRESS = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

// Extensible event listeners for Phase 2 (Inbound Base Auto-Sweep), Phase 3 (Outbound Payouts), Phase 4 (Cards)
const _eventListeners = new Map();

function onNuvionEvent(eventName, handler) {
  if (!_eventListeners.has(eventName)) _eventListeners.set(eventName, []);
  _eventListeners.get(eventName).push(handler);
}

async function emitNuvionEvent(eventName, context) {
  const handlers = [
    ...(_eventListeners.get(eventName) || []),
    ...(_eventListeners.get("*") || []),
  ];
  for (const fn of handlers) {
    try {
      await fn(context);
    } catch (err) {
      console.error(`[nuvion_webhooks] Listener error for ${eventName}:`, err.message);
    }
  }
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
 * Idempotently bootstrap the Base (BASE_MAINNET / base) Pass-Through Bridge
 * for an approved Nuvion child entity:
 *  1. Create or find the entity's `USC` checking account + Base (`chain: "base"`) deposit address
 *  2. Register the user's own Proxim `0x` EOA wallet as a Self-Counterparty on `BASE_MAINNET`
 *     so inbound fiat auto-sweeps fire straight to the user's main wallet with zero idle Nuvion custody.
 */
async function bootstrapApprovedEntity(entityRecord, { liveEntity = null } = {}) {
  if (!entityRecord || !entityRecord.entity_id) {
    throw new Error("entityRecord with entity_id is required");
  }
  const entityId = entityRecord.entity_id;
  const user = db.getUser(entityRecord.telegram_id);
  const isBusiness = entityRecord.account_type === "business";
  // STRICT ISOLATION: Business entities NEVER fall back to personal deposit_address!
  const targetWalletAddress = user
    ? (isBusiness ? (user.business_deposit_address || null) : (user.deposit_address || null))
    : null;
  if (isBusiness && user && !targetWalletAddress) {
    throw new Error(`Business wallet not provisioned for user ${entityRecord.telegram_id}; refusing personal wallet fallback.`);
  }

  const updates = {};

  // ── 1. Ensure USC Bridge Account exists ──────────────────────────────────
  let uscAccountId = entityRecord.usc_account_id;
  if (!uscAccountId) {
    let existingAcc = null;
    try {
      const listed = await nuvion.listAccounts({ entityId, currency: "USC", limit: 10 });
      const rows = listed?.data || [];
      existingAcc = rows.find((a) => a.currency === "USC") || null;
    } catch (_) {}

    const acc = existingAcc || await nuvion.createAccount({
      entityId,
      type: "checking",
      currency: "USC",
      displayName: entityRecord.account_type === "business" ? "Proxim Business Base Bridge" : "Proxim Base Bridge",
      meta: { purpose: "usc_bridge", chain: "base" },
    });

    if (acc && acc.id) {
      uscAccountId = acc.id;
      updates.usc_account_id = acc.id;
      db.upsertNuvionAccount({
        entityId,
        accountId: acc.id,
        currency: "USC",
        accountType: acc.type || "checking",
        displayName: acc.display_name || "Proxim Base Bridge",
        nuvionBan: acc.nuvion_ban || null,
        purpose: "usc_bridge",
        status: acc.status || "active",
      });
    }
  }

  // ── 2. Ensure Base (`chain: "base"`) Deposit Address exists on USC account ─
  let uscBaseDetailId = entityRecord.usc_base_detail_id;
  let uscBaseAddress = entityRecord.usc_base_address;
  if (uscAccountId && (!uscBaseDetailId || !uscBaseAddress)) {
    let detail = null;
    try {
      const listedDetails = await nuvion.listAccountDetails({ accountId: uscAccountId, entityId, limit: 100 });
      const rows = listedDetails?.data || [];
      detail = rows.find((d) => (d.chain || "").toLowerCase() === "base") || rows[0] || null;
    } catch (_) {}

    if (!detail) {
      detail = await nuvion.createAccountDetails({
        accountId: uscAccountId,
        entityId,
        chain: "base",
        assetType: "stablecoin",
      });
    }

    if (detail && detail.id) {
      uscBaseDetailId = detail.id;
      uscBaseAddress = detail.account_number || null;
      updates.usc_base_detail_id = detail.id;
      if (uscBaseAddress) updates.usc_base_address = uscBaseAddress;
      db.upsertNuvionAccountDetail({
        accountId: uscAccountId,
        detailId: detail.id,
        entityId,
        assetType: "stablecoin",
        currency: "USC",
        chain: "base",
        accountNumber: detail.account_number || null,
        beneficiaryName: detail.beneficiary_name || entityRecord.legal_name || null,
        status: detail.status || "pending",
        rawMeta: detail,
      });
    }
  }

  // ── 3. Ensure Self-Counterparty + BASE_MAINNET Payment Detail to User's 0x ─
  if (
    targetWalletAddress &&
    walletLib.isValidAddress(targetWalletAddress) &&
    targetWalletAddress.toLowerCase() !== CIRCLE_GATEWAY_WALLET_ADDRESS.toLowerCase()
  ) {
    let selfCpId = entityRecord.self_counterparty_id;
    let selfBasePdId = entityRecord.self_base_payment_detail_id;

    // Check locally cached self-counterparty first to avoid duplicate creations on retry
    if (!selfCpId || !selfBasePdId) {
      const cachedSelf = db.getNuvionCounterpartiesByEntity(entityId, "USC").find((c) => {
        try {
          const s = c.summary_json ? JSON.parse(c.summary_json) : {};
          return s.isSelf === true && String(s.wallet_address || "").toLowerCase() === targetWalletAddress.toLowerCase();
        } catch (_) {
          return false;
        }
      });
      if (cachedSelf) {
        selfCpId = selfCpId || cachedSelf.counterparty_id;
        selfBasePdId = selfBasePdId || cachedSelf.payment_detail_id;
        updates.self_counterparty_id = selfCpId;
        updates.self_base_payment_detail_id = selfBasePdId;
      }
    }

    if (!selfCpId) {
      const fullName = (entityRecord.legal_name || user?.username || "Proxim Account").trim();
      const parts = fullName.split(/\s+/);
      const firstName = parts[0] || "Proxim";
      const lastName = parts.slice(1).join(" ") || firstName;
      const email = entityRecord.email || liveEntity?.person?.email || liveEntity?.business?.email || `user_${entityRecord.telegram_id}@proxim.app`;

      const profile = entityRecord.entity_type === "business"
        ? {
            legal_name: fullName,
            relationship: "self",
            email,
            registered_address: {
              line1: liveEntity?.address?.line_1 || "1 Main Street",
              city: liveEntity?.address?.city || "Lagos",
              postal_code: liveEntity?.address?.postal_code || "100001",
              country: liveEntity?.address?.country_code || "NG",
            },
          }
        : {
            first_name: liveEntity?.person?.first_name || firstName,
            last_name: liveEntity?.person?.last_name || lastName,
            relationship: "self",
            email,
            address: {
              line1: liveEntity?.address?.line_1 || "1 Main Street",
              city: liveEntity?.address?.city || "Lagos",
              state_or_province: liveEntity?.address?.state || "Lagos",
              postal_code: liveEntity?.address?.postal_code || "100001",
              country: liveEntity?.address?.country_code || "NG",
            },
          };

      const cp = await nuvion.createCounterparty({
        entityId,
        type: entityRecord.entity_type === "business" ? "business" : "individual",
        nickname: entityRecord.account_type === "business" ? "Proxim Business Main Wallet" : "Proxim Main Wallet",
        profile,
      });
      if (cp && cp.id) {
        selfCpId = cp.id;
        updates.self_counterparty_id = cp.id;
      }
    }

    if (selfCpId && !selfBasePdId) {
      const pd = await nuvion.createPaymentDetail({
        entityId,
        counterparty_id: selfCpId,
        payment_method: "stablecoin-transfer",
        currency: "USC",
        account_holder_name: entityRecord.legal_name || "Proxim Account",
        blockchain_network: "BASE_MAINNET",
        wallet_address: targetWalletAddress,
      });
      if (pd && pd.id) {
        selfBasePdId = pd.id;
        updates.self_base_payment_detail_id = pd.id;
        db.saveNuvionCounterparty({
          entityId,
          counterpartyId: selfCpId,
          paymentDetailId: pd.id,
          label: "Proxim Main Wallet (Base)",
          currency: "USC",
          scheme: "BASE_MAINNET",
          paymentMethod: "stablecoin-transfer",
          accountHolderName: entityRecord.legal_name || "Proxim Account",
          summary: { wallet_address: targetWalletAddress, network: "BASE_MAINNET", isSelf: true },
        });
      }
    }
  }

  const updated = Object.keys(updates).length > 0
    ? db.updateNuvionEntity(entityId, updates)
    : entityRecord;

  return updated;
}

/**
 * Resolve child entity_id for a webhook payload even when Nuvion omits top-level `data.entity_id`.
 */
function _resolveEntityIdForWebhook(data) {
  if (!data || typeof data !== "object") return null;
  if (data.entity_id) return String(data.entity_id);
  if (data.account?.entity_id) return String(data.account.entity_id);

  const accountId = data.account_id || data.account?.id || null;
  if (accountId) {
    try {
      const acc = db.prepare("SELECT entity_id FROM nuvion_accounts WHERE account_id = ? LIMIT 1").get(String(accountId));
      if (acc?.entity_id) return String(acc.entity_id);
      const det = db.prepare("SELECT entity_id FROM nuvion_account_details WHERE account_id = ? LIMIT 1").get(String(accountId));
      if (det?.entity_id) return String(det.entity_id);
    } catch (_) {}
  }

  const cardId = data.card_id || (data.type && ["virtual", "disposable"].includes(data.type) ? data.id : null);
  if (cardId) {
    try {
      const card = db.prepare("SELECT entity_id FROM nuvion_cards WHERE card_id = ? LIMIT 1").get(String(cardId));
      if (card?.entity_id) return String(card.entity_id);
    } catch (_) {}
  }

  if (data.id) {
    try {
      const job = db.prepare(
        "SELECT entity_id FROM nuvion_jobs WHERE nuvion_transfer_id = ? OR session_id = ? LIMIT 1"
      ).get(String(data.id), String(data.id));
      if (job?.entity_id) return String(job.entity_id);
    } catch (_) {}
  }

  return null;
}

/**
 * Process a verified Nuvion webhook event asynchronously.
 * Always confirms latest state via GET before crediting or notifying.
 */
async function processNuvionEvent(payload, headers = {}, bot = null) {
  if (!payload || typeof payload !== "object") {
    return { handled: false, reason: "empty_payload" };
  }

  const event = String(payload.event || "").trim();
  const data = payload.data || {};
  const normalizedHeaders = {};
  for (const [k, v] of Object.entries(headers || {})) {
    normalizedHeaders[String(k).toLowerCase()] = v;
  }

  // Health check ping sent by Nuvion during webhook URL updates or blacklist reactivation
  if (event === "webhook.health") {
    console.log("[nuvion_webhooks] Received webhook.health verification ping.");
    return { handled: true, healthPing: true, event };
  }

  // Test events created via POST /webhook-tests only contain { webhook_id }
  if (data && data.webhook_id && Object.keys(data).length === 1) {
    console.log(`[nuvion_webhooks] Received test webhook event "${event}" for webhook ${data.webhook_id}`);
    return { handled: true, testEvent: true, event };
  }

  const headerEventId = normalizedHeaders["x-nuvion-event-id"];
  const dedupId = headerEventId
    ? `nuvion:${headerEventId}`
    : `nuvion:${event}:${data.id || data.account?.id || Date.now()}`;

  // Single atomic INSERT OR IGNORE claim (prevents simultaneous retry race conditions)
  const claimed = idempotency.tryClaimWebhookEvent(dedupId, event, data.id || data.account?.id || null);
  if (!claimed) {
    console.log(`[nuvion_webhooks] Duplicate event ${dedupId} ignored.`);
    return { handled: true, duplicate: true, event };
  }

  const telegram = getBotTelegram(bot);
  console.log(`[nuvion_webhooks] Processing event "${event}" (id=${headerEventId || "n/a"})`);

  // ── 1. Entity lifecycle (KYC / KYB Approval or Rejection) ─────────────────
  if (event === "entities.created" || event === "entities.updated") {
    const entityId = data.id;
    if (!entityId) return { handled: false, reason: "missing_entity_id" };

    const localRecord = db.getNuvionEntityByEntityId(entityId);
    if (!localRecord) {
      await emitNuvionEvent(event, { payload, data, entityRecord: null, bot });
      return { handled: true, event, unknownEntity: true };
    }

    // Confirm state before acting via GET /entities/{id}
    let liveWrapper = null;
    try {
      liveWrapper = await nuvion.getEntity(entityId);
    } catch (err) {
      console.warn(`[nuvion_webhooks] Could not confirm entity ${entityId}:`, err.message);
    }

    const liveEntity = liveWrapper?.entity || liveWrapper || data;
    const latestStatus = String(liveEntity.status || data.status || localRecord.status).toLowerCase();
    const prevStatus = String(localRecord.status || "").toLowerCase();

    let updatedRecord = db.updateNuvionEntity(entityId, {
      status: latestStatus,
      risk_level: liveEntity.risk_level || data.risk_level || localRecord.risk_level,
    });

    if (latestStatus === "approved") {
      try {
        updatedRecord = await bootstrapApprovedEntity(updatedRecord, { liveEntity: liveWrapper });
      } catch (bootErr) {
        console.error(`[nuvion_webhooks] Base bridge bootstrap failed for entity ${entityId}:`, bootErr.message);
      }

      const acctLabel = updatedRecord.account_type === "business" ? "Business Account" : "Global Account";
      if (prevStatus !== "approved" && updatedRecord.telegram_id) {
        // Multi-channel dispatch: Telegram + Push Notification + In-App Inbox
        await notifyModule.notify(updatedRecord.telegram_id, {
          title: "Tier-1 Verification Approved",
          html: `🎉 <b>Tier-1 Verification Approved!</b>\nYour ${acctLabel} is now verified for Proxim Global Banking. Named accounts (USD, GBP, EUR) and USD Cards are now unlocked!`,
          data: { type: "kyc_approved", entityId },
        }).catch(() => {});

        if (telegram) {
          await telegram.sendMessage(
            updatedRecord.telegram_id,
            `🎉 <b>Tier-1 Verification Approved!</b>\n` +
            `──────────────────────────\n` +
            `Your <b>${escapeHtml(acctLabel)}</b> is now verified for Proxim Global Banking.\n\n` +
            `You now have access to:\n` +
            `• 🌍 Named global bank accounts (USD, GBP, EUR, NGN &amp; more)\n` +
            `• 💳 Virtual &amp; Disposable USD Cards\n` +
            `• ✈️ International bank &amp; mobile money transfers\n\n` +
            `<i>Type /global anytime to open Global Banking.</i>`,
            { parse_mode: "HTML" }
          ).catch(() => {});
        }

        // Direct consumer transactional email dispatch to user's personal email
        const userEmail = liveEntity?.person?.email || liveEntity?.business?.email || localRecord?.email || null;
        if (userEmail) {
          emailModule.sendKycStatusEmail({
            to: userEmail,
            name: updatedRecord.legal_name,
            status: "approved",
            accountType: updatedRecord.account_type,
          }).catch((e) => console.warn("[nuvion_webhooks:email]", e.message));
        }
      }
    } else if ((latestStatus === "failed" || latestStatus === "blocked" || latestStatus === "action_required") && prevStatus !== latestStatus && updatedRecord.telegram_id) {
      await notifyModule.notify(updatedRecord.telegram_id, {
        title: "Verification Update",
        html: `❌ <b>Verification Update</b>\nYour Tier-1 verification status changed to ${escapeHtml(latestStatus)}. Please check your documents or contact support.`,
        data: { type: "kyc_status_change", entityId, status: latestStatus },
      }).catch(() => {});

      if (telegram) {
        await telegram.sendMessage(
          updatedRecord.telegram_id,
          `❌ <b>Verification Update</b>\n` +
          `──────────────────────────\n` +
          `Your Tier-1 verification status changed to <b>${escapeHtml(latestStatus)}</b>.\n` +
          `Your regular Proxim wallet remains fully active. Contact support if you need help reviewing your documents.`,
          { parse_mode: "HTML" }
        ).catch(() => {});
      }

      const userEmail = liveEntity?.person?.email || liveEntity?.business?.email || localRecord?.email || null;
      if (userEmail) {
        emailModule.sendKycStatusEmail({
          to: userEmail,
          name: updatedRecord.legal_name,
          status: latestStatus,
          accountType: updatedRecord.account_type,
        }).catch((e) => console.warn("[nuvion_webhooks:email]", e.message));
      }
    }

    await emitNuvionEvent(event, { payload, data, liveEntity: liveWrapper, entityRecord: updatedRecord, bot });
    return { handled: true, event, status: latestStatus, entityRecord: updatedRecord };
  }

  // ── 2. Account Details Provisioning (Fiat Bank Details & Base USC Address) ─
  if (event === "account_details.created" || event === "account_details.updated") {
    const detailId = data.id;
    const entityId = _resolveEntityIdForWebhook(data);
    if (!detailId) return { handled: false, reason: "missing_detail_id" };

    // Confirm latest state via GET /account-details/{id}?entity_id=...
    // Merge the live GET over the webhook payload instead of replacing it: if the GET comes
    // back empty or in an unexpected shape, the webhook's own status/account number survive.
    let confirmed = data;
    try {
      const live = await nuvion.getAccountDetails(detailId, entityId || null);
      if (live && typeof live === "object" && (live.id || live.account_number || live.iban || live.status)) {
        confirmed = { ...data };
        for (const [k, v] of Object.entries(live)) {
          if (v !== undefined && v !== null && v !== "") confirmed[k] = v;
        }
      } else {
        console.warn(`[nuvion_webhooks] Account detail ${detailId} GET returned no usable fields; using webhook payload.`);
      }
    } catch (err) {
      console.warn(`[nuvion_webhooks] Could not confirm account detail ${detailId}:`, err.message);
    }

    const issuerMeta = confirmed.issuer?.meta || {};
    const saved = db.upsertNuvionAccountDetail({
      accountId: confirmed.account_id || data.account_id || "",
      detailId: confirmed.id || detailId,
      entityId: confirmed.entity_id || entityId || "",
      assetType: confirmed.asset_type || (confirmed.chain ? "stablecoin" : "fiat"),
      currency: confirmed.currency || data.currency || "USD",
      chain: confirmed.chain || null,
      accountNumber: confirmed.account_number || null,
      iban: confirmed.iban || null,
      routingNumber: confirmed.routing_number || issuerMeta.routing_number || null,
      sortCode: issuerMeta.sort_code || (confirmed.issuer?.scheme === "sort_code" ? confirmed.issuer?.code : null),
      swiftCode: issuerMeta.swift_code || null,
      bankName: issuerMeta.bank_name || confirmed.issuer?.name || null,
      beneficiaryName: confirmed.beneficiary_name || null,
      status: confirmed.status || "pending",
      rawMeta: confirmed,
    });

    console.log(
      `[nuvion_webhooks] Account detail ${detailId} saved: currency=${saved?.currency} asset=${saved?.asset_type} ` +
      `status=${saved?.status} hasNumber=${!!(saved?.account_number || saved?.iban)} entityKnown=${!!(entityId && db.getNuvionEntityByEntityId(entityId))}`
    );

    const entityRecord = entityId ? db.getNuvionEntityByEntityId(entityId) : null;
    if (entityRecord) {
      // If this is the user's USC Base bridge address becoming active, sync it onto nuvion_entities
      if (entityRecord.usc_base_detail_id === detailId && confirmed.account_number) {
        db.updateNuvionEntity(entityId, { usc_base_address: confirmed.account_number });
      } else if (saved.asset_type === "fiat" && nuvion.isAccountDetailReady(saved) && telegram && entityRecord.telegram_id) {
        const lines = [
          `🏦 <b>Your ${escapeHtml(saved.currency)} Bank Account Is Ready!</b>`,
          `──────────────────────────`,
          `<b>Account Name:</b> ${escapeHtml(saved.beneficiary_name || entityRecord.legal_name || "Proxim Account")}`,
        ];
        if (saved.bank_name) lines.push(`<b>Bank:</b> ${escapeHtml(saved.bank_name)}`);
        if (saved.account_number) lines.push(`<b>Account Number:</b> <code>${escapeHtml(saved.account_number)}</code>`);
        if (saved.routing_number) lines.push(`<b>Routing Number:</b> <code>${escapeHtml(saved.routing_number)}</code>`);
        if (saved.sort_code) lines.push(`<b>Sort Code:</b> <code>${escapeHtml(saved.sort_code)}</code>`);
        if (saved.iban) lines.push(`<b>IBAN:</b> <code>${escapeHtml(saved.iban)}</code>`);
        if (saved.swift_code) lines.push(`<b>SWIFT/BIC:</b> <code>${escapeHtml(saved.swift_code)}</code>`);
        lines.push(`\n<i>Funds received into this account automatically settle straight into your main Proxim balance.</i>`);

        await telegram.sendMessage(entityRecord.telegram_id, lines.join("\n"), { parse_mode: "HTML" }).catch(() => {});
      }
    }

    await emitNuvionEvent(event, { payload, data, confirmed, saved, entityRecord, bot });
    return { handled: true, event, status: confirmed.status };
  }

  // ── 3. Transfers (Inflows, Outflows, Card Debits & Refunds) ───────────────
  if (event.startsWith("inflows.") || event.startsWith("outflows.")) {
    const transferId = data.id;
    let entityId = _resolveEntityIdForWebhook(data);
    let confirmed = data;
    if (transferId) {
      try {
        confirmed = await nuvion.getTransfer(transferId, entityId);
        if (!entityId) entityId = _resolveEntityIdForWebhook(confirmed);
      } catch (err) {
        console.warn(`[nuvion_webhooks] Could not confirm transfer ${transferId}:`, err.message);
      }
    }
    const entityRecord = entityId ? db.getNuvionEntityByEntityId(entityId) : null;
    await emitNuvionEvent(event, { payload, data, confirmed, entityRecord, bot });
    return { handled: true, event, status: confirmed?.status || data?.status };
  }

  // ── 4. Funding Sessions (Open Banking, Interac, MoMo, Crypto) ─────────────
  if (event === "funding_sessions.updated") {
    const sessionId = data.id;
    let entityId = _resolveEntityIdForWebhook(data);
    let confirmed = data;
    if (sessionId) {
      try {
        confirmed = await nuvion.getFundingSession(sessionId, entityId);
        if (!entityId) entityId = _resolveEntityIdForWebhook(confirmed);
      } catch (err) {
        console.warn(`[nuvion_webhooks] Could not confirm funding session ${sessionId}:`, err.message);
      }
    }
    const entityRecord = entityId ? db.getNuvionEntityByEntityId(entityId) : null;
    await emitNuvionEvent(event, { payload, data, confirmed, entityRecord, bot });
    return { handled: true, event, status: confirmed?.status || data?.status };
  }

  // ── 5. Cards Lifecycle ────────────────────────────────────────────────────
  if (event.startsWith("cards.")) {
    const cardId = data.id || data.card_id;
    const entityId = _resolveEntityIdForWebhook(data);
    const statusMap = {
      "cards.created": "active",
      "cards.frozen": "blocked",
      "cards.unfrozen": "active",
      "cards.deleted": "deleted",
    };
    if (cardId && statusMap[event]) {
      try {
        db.upsertNuvionCard({
          entityId: entityId || "",
          accountId: data.account_id || "",
          cardId,
          cardType: data.type || "virtual",
          cardName: data.name || null,
          currency: data.currency || "USD",
          last4: data.last4 || null,
          status: statusMap[event],
        });
      } catch (_) {}
    }
    const entityRecord = entityId ? db.getNuvionEntityByEntityId(entityId) : null;
    await emitNuvionEvent(event, { payload, data, entityRecord, bot });
    return { handled: true, event };
  }

  // Any other event (accounts.created, capital_*, etc.)
  await emitNuvionEvent(event, { payload, data, bot });
  return { handled: true, event };
}

/**
 * HTTP route handler mounted at POST /webhook/nuvion inside src/webhook_server.js.
 * Verifies raw-body HMAC-SHA256, responds 200 immediately to avoid 3-strike blacklisting,
 * and dispatches async event handling.
 */
function handleNuvionWebhookHttp(req, res, bot = null) {
  const MAX_WEBHOOK_BYTES = 1024 * 1024;
  const chunks = [];
  let byteLen = 0;
  req.on("data", (chunk) => {
    byteLen += chunk.length;
    if (byteLen <= MAX_WEBHOOK_BYTES) chunks.push(chunk);
  });
  req.on("end", () => {
    if (byteLen > MAX_WEBHOOK_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Payload too large" }));
    }
    const rawBody = Buffer.concat(chunks);
    const secret = (process.env.NUVION_WEBHOOK_SECRET || "").trim();

    if (secret) {
      const valid = nuvion.verifyWebhookSignature(rawBody, req.headers, secret);
      if (!valid) {
        console.warn("[nuvion_webhooks] Rejected webhook: invalid or missing HMAC signature.");
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid signature" }));
      }
    } else if (process.env.NODE_ENV === "production") {
      console.error("[nuvion_webhooks] Rejected webhook in production: NUVION_WEBHOOK_SECRET is not configured.");
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "webhook secret not configured" }));
    } else {
      console.warn("[nuvion_webhooks] WARNING: NUVION_WEBHOOK_SECRET is not set. Nuvion webhooks are NOT signature-verified (non-production mode).");
    }

    // Acknowledge immediately with 200 OK so Nuvion never retries or blacklists the endpoint
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true }));

    // Process asynchronously
    setImmediate(async () => {
      try {
        const payload = JSON.parse(rawBody.toString("utf8"));
        await processNuvionEvent(payload, req.headers, bot);
      } catch (err) {
        console.error("[nuvion_webhooks] Async processing error:", err.message);
      }
    });
  });
}

module.exports = {
  CIRCLE_GATEWAY_WALLET_ADDRESS,
  bootstrapApprovedEntity,
  processNuvionEvent,
  handleNuvionWebhookHttp,
  onNuvionEvent,
};
