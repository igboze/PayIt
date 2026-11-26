// src/flows_nuvion_kyc.js
// Opt-in Step-by-Step Telegram Chat Wizard for Tier-1 Nuvion KYC (Personal) & KYB (Business).
// - Strictly gated behind nuvion.isUserAllowedNuvion() (NUVION_BETA_IDS / NUVION_PUBLIC_LAUNCH)
// - Resumable drafts stored in SQLite (nuvion_kyc_drafts) and wiped immediately on submission
// - Sensitive inputs (BVN, NIN, SSN, ID numbers, ID photos/PDFs) are auto-deleted from Telegram chat
// - Uploaded documents are streamed into memory as Base64 -> POST /documents -> never written to disk

const { Markup } = require("telegraf");
const nuvion = require("./nuvion");
const nuvionWebhooks = require("./nuvion_webhooks");
const db = require("./db");
const idempotency = require("./idempotency");
const convState = require("./conversation_state");
const compliance = require("./compliance");
const emailModule = require("./email");

let deps = {};

const UPLOAD_STEP_ALLOWED_MIMES = {
  nuvion_kyc_doc_id_front: new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg"]),
  nuvion_kyc_doc_id_back: new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg"]),
  nuvion_kyc_doc_poa: new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg"]),
  nuvion_kyb_doc_coi: new Set(["application/pdf"]),
  nuvion_kyb_doc_memart: new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]),
  nuvion_kyb_doc_poa: new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg"]),
  nuvion_kyb_doc_officer_id: new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg"]),
  nuvion_kyb_doc_officer_poa: new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg"]),
};

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function maskSecret(val, visible = 4) {
  const s = String(val || "").trim();
  if (!s) return "—";
  if (s.length <= visible) return "****";
  return "*".repeat(Math.max(4, s.length - visible)) + s.slice(-visible);
}

function normalizePhone(input, defaultCountry = "NG") {
  let clean = String(input || "").trim().replace(/[\s\-().]/g, "");
  if (!clean) return null;
  if (clean.startsWith("00")) clean = "+" + clean.slice(2);
  if (!clean.startsWith("+")) {
    if (defaultCountry === "NG" && /^0[789]\d{9}$/.test(clean)) {
      clean = "+234" + clean.slice(1);
    } else if (defaultCountry === "NG" && /^234\d{10}$/.test(clean)) {
      clean = "+" + clean;
    } else if (/^\d{9,13}$/.test(clean)) {
      clean = "+" + clean;
    }
  }
  // Nuvion API strictly requires phonenumber 10–14 characters total including '+'
  return /^\+\d{9,13}$/.test(clean) && clean.length >= 10 && clean.length <= 14 ? clean : null;
}

function normalizeWebsiteUrl(raw) {
  const s = String(raw || "").trim();
  if (!s || /^(none|n\/a|na|skip|-|nil)$/i.test(s)) return null;
  const candidate = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const parsed = new URL(candidate);
    if ((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname.includes(".")) {
      return parsed.toString().replace(/\/$/, "");
    }
  } catch (_) {}
  return undefined; // signals invalid URL format
}

function isFutureIsoDate(d) {
  if (!isValidIsoDate(d)) return false;
  return new Date(`${d}T23:59:59Z`).getTime() > Date.now();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || "").trim());
}

function isValidIsoDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || "").trim())) return false;
  const parsed = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(d);
}

function isAdultDob(dobStr) {
  if (!isValidIsoDate(dobStr)) return false;
  const dob = new Date(`${dobStr}T00:00:00Z`);
  const ageYears = (Date.now() - dob.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  return ageYears >= 18 && ageYears <= 110;
}

function handlesState(stateType) {
  return typeof stateType === "string" && (
    stateType.startsWith("nuvion_kyc_") ||
    stateType.startsWith("nuvion_kyb_")
  );
}

function isUploadState(stateType) {
  return [
    "nuvion_kyc_doc_id_front",
    "nuvion_kyc_doc_id_back",
    "nuvion_kyc_doc_poa",
    "nuvion_kyb_doc_coi",
    "nuvion_kyb_doc_memart",
    "nuvion_kyb_doc_poa",
    "nuvion_kyb_doc_officer_id",
    "nuvion_kyb_doc_officer_poa",
  ].includes(stateType);
}

function saveDraftAndState(userId, accountType, step, data) {
  db.saveNuvionKycDraft(userId, accountType, step, data);
  convState.setState(userId, step, { accountType, ...data }, accountType);
}

/**
 * Immediately delete the user's message from the Telegram chat once a KYC/KYB step is captured
 * (or delete the review message when submitted/cleared) so zero personal details remain in chat history.
 */
async function deleteUserStepMessage(ctx) {
  if (!ctx) return;
  try {
    if (typeof deps.deleteSensitiveMessage === "function") {
      await deps.deleteSensitiveMessage(ctx);
      return;
    }
  } catch (_) {}
  try {
    if (typeof ctx.deleteMessage === "function") {
      await ctx.deleteMessage();
      return;
    }
  } catch (_) {}
  try {
    const chatId = ctx.chat?.id || ctx.from?.id;
    const msgId = ctx.message?.message_id || ctx.callbackQuery?.message?.message_id;
    if (chatId && msgId && ctx.telegram && typeof ctx.telegram.deleteMessage === "function") {
      await ctx.telegram.deleteMessage(chatId, msgId);
    }
  } catch (_) {}
}

const NUVION_PRIVACY_FOOTER = compliance.KYC_CONSENT_FOOTER;

const COUNTRY_KYC_PRESETS = {
  US: {
    label: "🇺🇸 United States",
    sampleName: "Alex Johnson",
    samplePhone: "+12125550198",
    sampleStreet: "350 Fifth Avenue, Suite 2100",
    sampleCityStateZip: "New York, NY, 10118",
    sampleBizName: "Acme Technologies LLC",
    sampleBizReg: "47-7654334, 47-1234589, Technology",
    sampleIncorp: "2023, 5, US, Delaware",
    authorities: [
      [
        { label: "U.S. Dept of State (Passport)", code: "US_DOS", full: "US Department of State" },
        { label: "State DMV (Driver's License)", code: "US_DMV", full: "Department of Motor Vehicles" },
      ],
    ],
  },
  GB: {
    label: "🇬🇧 United Kingdom",
    sampleName: "Oliver Smith",
    samplePhone: "+447700900123",
    sampleStreet: "221B Baker Street",
    sampleCityStateZip: "London, England, NW1 6XE",
    sampleBizName: "Acme Technologies Ltd",
    sampleBizReg: "12345678, GB123456789, Technology",
    sampleIncorp: "2023, 5, GB, England",
    authorities: [
      [
        { label: "HM Passport Office", code: "GB_HMPO", full: "HM Passport Office" },
        { label: "DVLA (Driving Licence)", code: "GB_DVLA", full: "Driver and Vehicle Licensing Agency" },
      ],
    ],
  },
  CA: {
    label: "🇨🇦 Canada",
    sampleName: " Liam Tremblay",
    samplePhone: "+14165550199",
    sampleStreet: "100 Queen Street West",
    sampleCityStateZip: "Toronto, Ontario, M5H 2N2",
    sampleBizName: "Acme Technologies Inc",
    sampleBizReg: "1234567-8, 123456789RC0001, Technology",
    sampleIncorp: "2023, 5, CA, Ontario",
    authorities: [
      [
        { label: "IRCC / Passport Canada", code: "CA_IRCC", full: "Immigration, Refugees and Citizenship Canada" },
        { label: "Provincial Ministry", code: "CA_PROV", full: "Provincial Licensing Authority" },
      ],
    ],
  },
  NG: {
    label: "🇳🇬 Nigeria",
    sampleName: "Chinedu Okafor",
    samplePhone: "+2348012345678",
    sampleStreet: "14 Admiralty Way, Lekki Phase 1",
    sampleCityStateZip: "Lagos, Lagos, 106104",
    sampleBizName: "Acme Technologies Ltd",
    sampleBizReg: "RC1234567, 10293847-0001, Technology",
    sampleIncorp: "2023, 5, NG, Lagos",
    authorities: [
      [
        { label: "NIS (Nigeria Passport)", code: "NIS", full: "Nigeria Immigration Service" },
        { label: "NIMC (National ID)", code: "NIMC", full: "National Identity Management Commission" },
      ],
      [{ label: "FRSC (Driver's License)", code: "FRSC", full: "Federal Road Safety Corps" }],
    ],
  },
  GH: {
    label: "🇬🇭 Ghana",
    sampleName: "Kwame Mensah",
    samplePhone: "+233241234567",
    sampleStreet: "14 Independence Avenue, Ridge",
    sampleCityStateZip: "Accra, Greater Accra, GA-100",
    sampleBizName: "Acme Technologies Ghana Ltd",
    sampleBizReg: "CS123452023, C0012345678, Technology",
    sampleIncorp: "2023, 5, GH, Greater Accra",
    authorities: [
      [
        { label: "Passport Office Ghana", code: "GH_PASS", full: "Passport Office Ghana" },
        { label: "NIA (Ghana Card)", code: "GH_NIA", full: "National Identification Authority" },
      ],
      [{ label: "DVLA Ghana", code: "GH_DVLA", full: "Driver and Vehicle Licensing Authority" }],
    ],
  },
  KE: {
    label: "🇰🇪 Kenya",
    sampleName: "Kamau Njoroge",
    samplePhone: "+254712345678",
    sampleStreet: "Delta Corner, Westlands",
    sampleCityStateZip: "Nairobi, Nairobi, 00100",
    sampleBizName: "Acme Technologies Kenya Ltd",
    sampleBizReg: "PVT-123456, P051234567A, Technology",
    sampleIncorp: "2023, 5, KE, Nairobi",
    authorities: [
      [
        { label: "Directorate of Immigration", code: "KE_IMM", full: "Directorate of Immigration Services" },
        { label: "NRB (National ID)", code: "KE_NRB", full: "National Registration Bureau" },
      ],
      [{ label: "NTSA (Driving Licence)", code: "KE_NTSA", full: "National Transport and Safety Authority" }],
    ],
  },
};

const DEFAULT_KYC_PRESET = {
  label: "🌍 International",
  sampleName: "Alex Johnson",
  samplePhone: "+447700900123",
  sampleStreet: "100 Main Street, Suite 4",
  sampleCityStateZip: "London, England, SW1A 1AA",
  sampleBizName: "Acme Technologies Ltd",
  sampleBizReg: "REG-1234567, TAX-9876543, Technology",
  sampleIncorp: "2023, 5, GB, London",
  authorities: [
    [
      { label: "National Passport Office", code: "INTL_PASS", full: "National Passport Office" },
      { label: "National ID Authority", code: "INTL_NID", full: "National Identity Authority" },
    ],
    [{ label: "Driver Licensing Authority", code: "INTL_DL", full: "Driver Licensing Authority" }],
  ],
};

function getCountryKycPreset(countryCode) {
  const code = String(countryCode || "").trim().toUpperCase();
  return COUNTRY_KYC_PRESETS[code] || DEFAULT_KYC_PRESET;
}

function buildCountrySelectionRows(actionPrefix) {
  return [
    [
      Markup.button.callback("🇺🇸 United States (US)", `${actionPrefix}_US`),
      Markup.button.callback("🇬🇧 United Kingdom (GB)", `${actionPrefix}_GB`),
    ],
    [
      Markup.button.callback("🇨🇦 Canada (CA)", `${actionPrefix}_CA`),
      Markup.button.callback("🇳🇬 Nigeria (NG)", `${actionPrefix}_NG`),
    ],
    [
      Markup.button.callback("🇬🇭 Ghana (GH)", `${actionPrefix}_GH`),
      Markup.button.callback("🇰🇪 Kenya (KE)", `${actionPrefix}_KE`),
    ],
    [
      Markup.button.callback("🇿🇦 South Africa (ZA)", `${actionPrefix}_ZA`),
      Markup.button.callback("🇦🇪 UAE (AE)", `${actionPrefix}_AE`),
    ],
    [
      Markup.button.callback("🇩🇪 Germany (DE)", `${actionPrefix}_DE`),
      Markup.button.callback("🇫🇷 France (FR)", `${actionPrefix}_FR`),
    ],
  ];
}

function wizardControls(accountType) {
  const prefix = accountType === "business" ? "nuvion_kyb" : "nuvion_kyc";
  return [
    [
      Markup.button.callback("💾 Pause & Save", `${prefix}_pause`),
      Markup.button.callback("🗑️ Cancel / Restart", `${prefix}_reset`),
    ],
  ];
}

// ── Portal & Status View ──────────────────────────────────────────────────────

async function showGlobalPortal(ctx, forcedContext = null) {
  const user = deps.requireUser ? deps.requireUser(ctx) : db.getUser(ctx.from.id);
  if (!user) return;

  if (!nuvion.isUserAllowedNuvion(ctx.from.id)) {
    return ctx.reply(
      `🌍 <b>Proxim Global Banking</b>\n──────────────────────────\n` +
      `Named global accounts (USD, GBP, EUR, NGN), Virtual USD Cards, and international transfers are currently in private beta.\n\n` +
      `Your regular Proxim wallet, Naira deposits, transfers, and bill payments are ready to use right now!`,
      { parse_mode: "HTML", ...(deps.backToMenu || {}) }
    );
  }

  const accountType = forcedContext || (deps.getContext ? deps.getContext(ctx.from.id) : (user.active_context || "personal"));
  const isBiz = accountType === "business";
  if (isBiz && !user.business_deposit_address) {
    return ctx.reply(
      `💼 <b>Business Account Required for KYB</b>\n──────────────────────────\n` +
      `Business Verification (KYB) is strictly separate from Personal KYC and requires a Proxim Business wallet first.\n\n` +
      `Tap below to set up your Business Account or check your Personal KYC status:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("💼 Set Up Business Account", "switch_business")],
          [Markup.button.callback("🪪 View Personal KYC Status", "action_nuvion_portal")],
          [Markup.button.callback("🏠 Main Menu", "main_menu")],
        ]),
      }
    );
  }

  const entity = db.getNuvionEntityByUser(ctx.from.id, accountType);
  const otherType = isBiz ? "personal" : "business";
  const hasBiz = Boolean(user.business_deposit_address);
  const otherEntity = (otherType === "personal" || hasBiz) ? db.getNuvionEntityByUser(ctx.from.id, otherType) : null;
  const otherStatus = String(otherEntity?.status || "not_started").toLowerCase();
  const otherStatusSummary = otherStatus === "approved"
    ? "Tier 1 Approved ✅"
    : otherStatus === "pending" || otherStatus === "incomplete"
      ? "Under Review ⏳"
      : "Not Verified";
  const otherStatusLine = (otherType === "personal" || hasBiz)
    ? `• <b>${isBiz ? "Personal KYC" : "Business KYB"} Status:</b> ${otherStatusSummary} <i>(tracked separately)</i>\n`
    : "";
  const switchPortalRow = (otherType === "personal" || hasBiz)
    ? [[Markup.button.callback(isBiz ? "🪪 Switch to Personal KYC Portal" : "💼 Switch to Business KYB Portal", isBiz ? "action_nuvion_portal" : "biz_nuvion_portal")]]
    : [];

  const draft = db.getNuvionKycDraft(ctx.from.id, accountType);
  const label = isBiz ? "Business Global Banking (KYB)" : "Personal Global Banking (KYC)";

  const status = String(entity?.status || "").toLowerCase();
  const isApproved = status === "approved";
  const hasDraft = Boolean(draft && draft.step);

  if (!entity || (!isApproved && hasDraft)) {
    const startAction = isBiz ? "nuvion_kyb_start" : "nuvion_kyc_start";
    const resumeAction = isBiz ? "nuvion_kyb_resume" : "nuvion_kyc_resume";
    const buttons = [];
    if (draft) {
      buttons.push([Markup.button.callback(isBiz ? "▶️ Resume Business KYB" : "▶️ Resume Personal KYC", resumeAction)]);
      buttons.push([Markup.button.callback("🔄 Start Fresh", startAction)]);
    } else {
      buttons.push([Markup.button.callback(isBiz ? "💼 Verify Business (KYB)" : "🪪 Start Personal Verification (KYC)", startAction)]);
    }
    buttons.push(...switchPortalRow);
    buttons.push([Markup.button.callback("🏠 Main Menu", "main_menu")]);

    return ctx.reply(
      `🌍 <b>${label} — Upgrade from Tier 0 to Tier 1</b>\n──────────────────────────\n` +
      `🏷️ <b>${isBiz ? "Business KYB" : "Personal KYC"} Status:</b> Tier 0 (Standard — NGN Accounts Only)\n` +
      otherStatusLine +
      `\n` +
      `On <b>Tier 0</b>, your ${isBiz ? "Business" : "Personal"} account only has access to <b>Nigerian Naira (NGN)</b> accounts and local transfers.\n` +
      `Getting <b>Global Bank Accounts</b> and <b>Virtual USD Cards</b> requires <b>Tier 1</b>, which unlocks automatically once you complete ${isBiz ? "Business Verification (KYB)" : "ID Verification (KYC)"}:\n\n` +
      `• 🏦 <b>Named Global Bank Accounts</b> (USD, GBP, EUR, NGN, CAD, AED, KES, GHS)\n` +
      `• 💳 <b>${isBiz ? "Business &amp; Team" : "Virtual &amp; Disposable"} USD Cards</b> (Netflix, AWS, Ads, Online Shopping)\n` +
      `• ✈️ <b>Global Transfers</b> (27+ currencies via bank &amp; mobile money rails)\n` +
      (isBiz ? `• 🧾 <b>Global Client Invoicing &amp; 27-Currency Payroll</b>\n` : "") +
      `\n<i>All deposits automatically settle straight into your main Proxim balance.</i>\n\n` +
      `🌍 <b>Supported Countries for KYC &amp; KYB (Powered by Nuvion):</b>\n` +
      `🇳🇬 Nigeria · 🇺🇸 US · 🇬🇧 UK · 🇨🇦 Canada · 🇪🇺 Eurozone (DE, FR, NL, ES, IT &amp; EU) · 🇦🇪 UAE · 🇬🇭 Ghana · 🇰🇪 Kenya · 🇹🇿 Tanzania · 🇺🇬 Uganda · 🇿🇦 South Africa · 🇲🇽 Mexico · 🇧🇷 Brazil · 🇨🇭 Switzerland · 🇸🇪 Sweden · 🇳🇴 Norway · 🇩🇰 Denmark · 🇦🇺 Australia · 🇳🇿 New Zealand · 🇸🇬 Singapore · 🇭🇰 Hong Kong · 🇯🇵 Japan · 🇰🇷 South Korea · 🇵🇭 Philippines · 🇹🇭 Thailand · 🇮🇱 Israel &amp; global ISO jurisdictions — select your country in Step 1.\n\n` +
      `<b>What you'll need:</b>\n` +
      (isBiz
        ? `• Certificate of Incorporation &amp; Articles/Memorandum of Association (PDF)\n• Business proof of address (&lt; 3 months)\n• Director / Owner Government ID &amp; proof of address\n\n`
        : `• Valid Government ID (Passport, National ID, or Driver's License)\n• Proof of address (utility bill or bank statement &lt; 3 months)\n• Local tax/identity number where required by your country (e.g. SSN for US, BVN/NIN for NG)\n\n`) +
      `🛡️ <b>Privacy &amp; Compliance Guarantee (Powered by Nuvion)</b>\n` +
      `• Your KYC/KYB verification is handled directly by <b>Nuvion</b>, our regulated global banking &amp; compliance infrastructure partner.\n` +
      `• <b>100% Compliant &amp; Confidential:</b> Your data and documents are encrypted, used strictly for regulatory verification, and <b>will never be shared with anyone</b>.\n` +
      `• <b>Auto-Delete Chat Protection:</b> Every detail and document you enter is automatically deleted from this Telegram chat as soon as each step is completed.`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) }
    );
  }

  if (status === "approved") {
    const bridgeReady = Boolean(entity.usc_base_address && entity.self_base_payment_detail_id);
    const fiatDetails = db.getNuvionAccountDetailsByEntity(entity.entity_id).filter((d) => d.asset_type === "fiat");
    const p = accountType === "business" ? "biz" : "per";

    return ctx.reply(
      `🌍 <b>${label}</b>  ✅ <b>Verified</b>\n──────────────────────────\n` +
      `• <b>Account Name:</b> ${escapeHtml(entity.legal_name || "Verified Account")}\n` +
      `• <b>${isBiz ? "Business KYB" : "Personal KYC"} Status:</b> Tier-1 Approved ✅\n` +
      otherStatusLine +
      `• <b>Instant Settlement Bridge:</b> ${bridgeReady ? "✅ Active" : "⏳ Provisioning..."}\n` +
      `• <b>Global Receiving Accounts:</b> ${fiatDetails.length} active\n\n` +
      `<i>All deposits received into your global bank accounts settle automatically into your main Proxim balance.</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🏦 Global Bank Accounts (10 Currencies)", `nuvion_accounts_menu_${p}`)],
          [Markup.button.callback("🌍 Send Abroad (27 Currencies)", `nuvion_po_menu_${p}`)],
          [Markup.button.callback(accountType === "business" ? "💳 Business & Team USD Cards" : "💳 Virtual & Disposable USD Cards", `nuvion_cards_menu_${p}`)],
          [Markup.button.callback("🔗 Request Payment Link (UK/EU/CA/MoMo)", `nuvion_paylink_menu_${p}`)],
          ...(accountType === "business" ? [[Markup.button.callback("📄 Multi-Currency CSV Payroll", `nuvion_po_csv_start_${p}`)]] : []),
          [Markup.button.callback("🔄 Sync Bridge & Status", `nuvion_refresh_${accountType}`)],
          ...switchPortalRow,
          [Markup.button.callback("🏠 Main Menu", "main_menu")],
        ]),
      }
    );
  }

  if (status === "pending" || status === "incomplete") {
    return ctx.reply(
      `⏳ <b>${label} — Verification In Progress</b>\n──────────────────────────\n` +
      `• <b>Name:</b> ${escapeHtml(entity.legal_name || "—")}\n` +
      `• <b>${isBiz ? "Business KYB" : "Personal KYC"} Status:</b> <code>${escapeHtml(status.toUpperCase())}</code>\n` +
      otherStatusLine +
      `• <b>Compliance Partner:</b> <b>Nuvion</b>\n\n` +
      `We'll message you automatically the moment your verification is approved.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Check Status Now", `nuvion_refresh_${accountType}`)],
          ...switchPortalRow,
          [Markup.button.callback("🏠 Main Menu", "main_menu")],
        ]),
      }
    );
  }

  return ctx.reply(
    `❌ <b>${label} — Verification ${escapeHtml(status.toUpperCase())}</b>\n──────────────────────────\n` +
    otherStatusLine +
    `Your verification could not be completed. Your regular Proxim wallet remains fully active.\n` +
    `Please contact support if you'd like us to review your application.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        ...switchPortalRow,
        [Markup.button.callback("🏠 Main Menu", "main_menu")],
      ]),
    }
  );
}

// ── Personal KYC Step Prompt Renderer ─────────────────────────────────────────

async function promptPersonalKycStep(ctx, userId, step, data = {}) {
  saveDraftAndState(userId, "personal", step, data);
  const preset = getCountryKycPreset(data.nationality || data.country_code);

  switch (step) {
    case "nuvion_kyc_country":
      return ctx.reply(
        `🌍 <b>Step 1/9 — Choose Your Country of Verification</b>\n──────────────────────────\n` +
        `Select the country you are verifying from below, or type any <b>2-letter country code</b> (e.g. <code>US</code>, <code>GB</code>, <code>CA</code>, <code>NG</code>, <code>GH</code>, <code>KE</code>, <code>AU</code>, <code>SG</code>):` +
        NUVION_PRIVACY_FOOTER,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            ...buildCountrySelectionRows("nuvion_kyc_pick_country"),
            ...wizardControls("personal"),
          ]),
        }
      );

    case "nuvion_kyc_name":
      return ctx.reply(
        `🪪 <b>Step 2/9 — Legal Full Name</b>\n──────────────────────────\n` +
        `Enter your full legal name exactly as it appears on your government ID (e.g. <code>${escapeHtml(preset.sampleName)}</code>):` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("personal")) }
      );

    case "nuvion_kyc_email":
      return ctx.reply(
        `📧 <b>Step 3/9 — Personal Email Address</b>\n──────────────────────────\n` +
        `Enter your personal email address (must be unique to you):` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("personal")) }
      );

    case "nuvion_kyc_phone":
      return ctx.reply(
        `📱 <b>Step 4/9 — Phone Number</b>\n──────────────────────────\n` +
        `Enter your phone number with country code (e.g. <code>${escapeHtml(preset.samplePhone)}</code>):` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("personal")) }
      );

    case "nuvion_kyc_dob":
      return ctx.reply(
        `🎂 <b>Step 5/9 — Date of Birth</b>\n──────────────────────────\n` +
        `Enter your date of birth in <code>YYYY-MM-DD</code> format (e.g. <code>1994-06-15</code>):` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("personal")) }
      );

    case "nuvion_kyc_gender":
      return ctx.reply(
        `👤 <b>Step 5b/9 — Gender</b>\n──────────────────────────\nSelect your gender as printed on your ID:`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback("Male", "nuvion_kyc_set_gender_m"),
              Markup.button.callback("Female", "nuvion_kyc_set_gender_f"),
            ],
            ...wizardControls("personal"),
          ]),
        }
      );

    case "nuvion_kyc_nationality":
      return ctx.reply(
        `🌍 <b>Choose Your Country / Nationality</b>\n──────────────────────────\nSelect your country of citizenship (or type any 2-letter ISO code like <code>CA</code>, <code>AU</code>, <code>SG</code>):`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            ...buildCountrySelectionRows("nuvion_kyc_set_nat"),
            ...wizardControls("personal"),
          ]),
        }
      );

    case "nuvion_kyc_address_street":
      return ctx.reply(
        `🏠 <b>Step 6/9 — Residential Address (Street)</b>\n──────────────────────────\n` +
        `Enter your street address (e.g. <code>${escapeHtml(preset.sampleStreet)}</code>):` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("personal")) }
      );

    case "nuvion_kyc_address_city":
      return ctx.reply(
        `🏙️ <b>Step 6b/9 — City, State/Province &amp; Postal Code</b>\n──────────────────────────\n` +
        `Send your <b>City, State/Province, Postal Code</b> separated by commas (e.g. <code>${escapeHtml(preset.sampleCityStateZip)}</code>):` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("personal")) }
      );

    case "nuvion_kyc_bvn":
      return ctx.reply(
        `🔒 <b>Step 7/9 — BVN (Nigerian Nationals)</b>\n──────────────────────────\n` +
        `Enter your <b>11-digit BVN</b>:` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("personal")) }
      );

    case "nuvion_kyc_nin":
      return ctx.reply(
        `🔒 <b>Step 7b/9 — NIN (Nigerian Nationals)</b>\n──────────────────────────\n` +
        `Enter your <b>11-digit NIN</b>:` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("personal")) }
      );

    case "nuvion_kyc_ssn":
      return ctx.reply(
        `🔒 <b>Step 7/9 — SSN (U.S. Nationals)</b>\n──────────────────────────\n` +
        `Enter your <b>SSN</b> (e.g. <code>123-45-6789</code>):` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("personal")) }
      );

    case "nuvion_kyc_id_type":
      return ctx.reply(
        `🪪 <b>Step 8/9 — Government ID Type</b>\n──────────────────────────\nChoose the valid, unexpired ID you will upload:`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🛂 International Passport", "nuvion_kyc_set_idtype_international_passport")],
            [Markup.button.callback("🪪 National ID Card", "nuvion_kyc_set_idtype_national_id")],
            [Markup.button.callback("🚗 Driver's License", "nuvion_kyc_set_idtype_drivers_license")],
            ...wizardControls("personal"),
          ]),
        }
      );

    case "nuvion_kyc_id_number":
      return ctx.reply(
        `🔢 <b>Step 8b/9 — ID Number</b>\n──────────────────────────\n` +
        `Enter your document number (e.g. <code>A12345678</code>):` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("personal")) }
      );

    case "nuvion_kyc_id_dates":
      return ctx.reply(
        `📅 <b>Step 8c/9 — ID Issue &amp; Expiry Dates</b>\n──────────────────────────\n` +
        `Enter <b>Issue Date, Expiry Date</b> in <code>YYYY-MM-DD</code> format (e.g. <code>2022-03-01, 2032-02-28</code>):` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("personal")) }
      );

    case "nuvion_kyc_id_authority": {
      const authRows = preset.authorities.map((row) =>
        row.map((btn) => Markup.button.callback(btn.label, `nuvion_kyc_set_auth_${btn.code}`))
      );
      return ctx.reply(
        `🏛️ <b>Step 8d/9 — Issuing Authority</b>\n──────────────────────────\n` +
        `Tap the authority that issued your ID, or type it directly into the chat:` +
        NUVION_PRIVACY_FOOTER,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            ...authRows,
            ...wizardControls("personal"),
          ]),
        }
      );
    }

    case "nuvion_kyc_doc_id_front":
      return ctx.reply(
        `📸 <b>Step 9/9 — Upload Government ID (Front)</b>\n──────────────────────────\n` +
        `Send a clear <b>photo or PDF</b> of the front page of your ID.` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("personal")) }
      );

    case "nuvion_kyc_doc_id_back":
      return ctx.reply(
        `📸 <b>Step 9b/9 — Upload Government ID (Back)</b>\n──────────────────────────\n` +
        `Send a clear <b>photo or PDF</b> of the back of your ID, or tap Skip if single-page (like a passport):` +
        NUVION_PRIVACY_FOOTER,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("⏭️ Skip Back Side", "nuvion_kyc_skip_id_back")],
            ...wizardControls("personal"),
          ]),
        }
      );

    case "nuvion_kyc_doc_poa":
      return ctx.reply(
        `🧾 <b>Final Upload — Proof of Address</b>\n──────────────────────────\n` +
        `Send a clear <b>photo or PDF</b> of a utility bill, bank statement, or government letter dated within the <b>last 3 months</b>:` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("personal")) }
      );

    case "nuvion_kyc_review": {
      const fullName = [data.first_name, data.middle_name, data.last_name].filter(Boolean).join(" ");
      return ctx.reply(
        `✅ <b>Review Your Tier-1 Verification</b>\n──────────────────────────\n` +
        `• <b>Name:</b> ${escapeHtml(fullName)}\n` +
        `• <b>Email:</b> ${escapeHtml(data.email)}\n` +
        `• <b>Phone:</b> <code>${escapeHtml(maskSecret(data.phonenumber, 4))}</code>\n` +
        `• <b>DOB / Gender:</b> <code>${escapeHtml(maskSecret(data.date_of_birth, 2))}</code> (${data.gender === "f" ? "Female" : "Male"})\n` +
        `• <b>Nationality:</b> ${escapeHtml(data.nationality)}\n` +
        `• <b>Address:</b> ${escapeHtml(data.city)}, ${escapeHtml(data.state)}\n` +
        (data.bvn ? `• <b>BVN:</b> <code>${maskSecret(data.bvn)}</code>\n` : "") +
        (data.nin ? `• <b>NIN:</b> <code>${maskSecret(data.nin)}</code>\n` : "") +
        (data.ssn ? `• <b>SSN:</b> <code>${maskSecret(data.ssn)}</code>\n` : "") +
        `• <b>ID:</b> ${escapeHtml(data.id_type)} (<code>${maskSecret(data.id_number)}</code>)\n` +
        `• <b>Documents:</b> ID Front ✅${data.doc_id_back ? " · ID Back ✅" : ""} · Proof of Address ✅\n\n` +
        `🛡️ <i>Your verification is processed by <b>Nuvion</b> (100% compliant &amp; confidential — never shared with anyone). This review card will also be auto-deleted upon submission.</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🚀 Submit Verification", "nuvion_kyc_submit")],
            [
              Markup.button.callback("💾 Pause & Save", "nuvion_kyc_pause"),
              Markup.button.callback("🗑️ Cancel & Clear", "nuvion_kyc_reset"),
            ],
          ]),
        }
      );
    }
  }
}

// ── Business KYB Step Prompt Renderer ─────────────────────────────────────────

async function promptBusinessKybStep(ctx, userId, step, data = {}) {
  saveDraftAndState(userId, "business", step, data);
  const preset = getCountryKycPreset(data.incorp_country || data.biz_country_code);

  switch (step) {
    case "nuvion_kyb_country":
      return ctx.reply(
        `🌍 <b>Business KYB (Step 1/9) — Country of Registration</b>\n──────────────────────────\n` +
        `Select the country where your business is registered, or type any <b>2-letter country code</b> (e.g. <code>US</code>, <code>GB</code>, <code>CA</code>, <code>NG</code>, <code>GH</code>, <code>KE</code>, <code>AE</code>):` +
        NUVION_PRIVACY_FOOTER,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            ...buildCountrySelectionRows("nuvion_kyb_pick_country"),
            ...wizardControls("business"),
          ]),
        }
      );

    case "nuvion_kyb_legal_name":
      return ctx.reply(
        `💼 <b>Business KYB (Step 2/9) — Legal Business Name</b>\n──────────────────────────\n` +
        `Enter your registered company name exactly as on your Certificate of Incorporation (e.g. <code>${escapeHtml(preset.sampleBizName)}</code>):` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("business")) }
      );

    case "nuvion_kyb_type":
      return ctx.reply(
        `🏢 <b>Step 2b/9 — Business Entity Type</b>\n──────────────────────────\nSelect your company structure:`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback("Limited / LLC", "nuvion_kyb_set_type_llc"),
              Markup.button.callback("Corporation", "nuvion_kyb_set_type_corporation"),
            ],
            [
              Markup.button.callback("Sole Proprietorship", "nuvion_kyb_set_type_sole_proprietorship"),
              Markup.button.callback("Partnership", "nuvion_kyb_set_type_partnership"),
            ],
            ...wizardControls("business"),
          ]),
        }
      );

    case "nuvion_kyb_reg":
      return ctx.reply(
        `📋 <b>Step 3/9 — Registration &amp; Industry</b>\n──────────────────────────\n` +
        `Send <b>Registration Number, Tax ID, Industry</b> separated by commas (e.g. <code>${escapeHtml(preset.sampleBizReg)}</code>):` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("business")) }
      );

    case "nuvion_kyb_incorp":
      return ctx.reply(
        `📅 <b>Step 4/9 — Incorporation Details</b>\n──────────────────────────\n` +
        `Send <b>Year, Month (1-12), Country Code, State/Province</b> separated by commas (e.g. <code>${escapeHtml(preset.sampleIncorp)}</code>):` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("business")) }
      );

    case "nuvion_kyb_contact":
      return ctx.reply(
        `📧 <b>Step 5/9 — Business Contact</b>\n──────────────────────────\n` +
        `Send <b>Business Email, Phone, Website (optional)</b> separated by commas (e.g. <code>finance@acme.com, ${escapeHtml(preset.samplePhone)}, https://acme.com</code> or omit website):` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("business")) }
      );

    case "nuvion_kyb_address":
      return ctx.reply(
        `🏠 <b>Step 6/9 — Registered Business Address</b>\n──────────────────────────\n` +
        `Send <b>Street (4+ chars), City, State/Province, Postal Code, Country Code</b> separated by commas (e.g. <code>${escapeHtml(preset.sampleStreet)}, ${escapeHtml(preset.sampleCityStateZip)}, ${escapeHtml(data.incorp_country || "US")}</code>):` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("business")) }
      );

    case "nuvion_kyb_officer":
      return ctx.reply(
        `👤 <b>Step 7/9 — Controlling Officer / Beneficial Owner (≥25%)</b>\n──────────────────────────\n` +
        `Send <b>First Name, Last Name, Job Title, Ownership %, Email, Phone, DOB (YYYY-MM-DD), Nationality (2-letter), Gender (m/f)</b> separated by commas:` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("business")) }
      );

    case "nuvion_kyb_officer_ids":
      return ctx.reply(
        `🔒 <b>Step 7b/9 — Officer ID Details</b>\n──────────────────────────\n` +
        `Send <b>ID Type (passport/national_id/drivers_license), ID Number, Issue Date, Expiry Date, BVN (if NG) / SSN (if US), NIN (if NG)</b> separated by commas:` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("business")) }
      );

    case "nuvion_kyb_doc_coi":
      return ctx.reply(
        `📄 <b>Step 8/9 — Upload Certificate of Incorporation (PDF)</b>\n──────────────────────────\n` +
        `Send the <b>PDF</b> of your company's Certificate of Incorporation:` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("business")) }
      );

    case "nuvion_kyb_doc_memart":
      return ctx.reply(
        `📄 <b>Step 8b/9 — Upload Memorandum of Association (PDF/DOCX)</b>\n──────────────────────────\n` +
        `Send the <b>PDF or DOCX</b> of your Memorandum &amp; Articles of Association:` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("business")) }
      );

    case "nuvion_kyb_doc_poa":
      return ctx.reply(
        `🧾 <b>Step 8c/9 — Upload Business Proof of Address</b>\n──────────────────────────\n` +
        `Send a <b>PDF or photo</b> of your business utility bill / bank statement (&lt; 3 months old):` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("business")) }
      );

    case "nuvion_kyb_doc_officer_id":
      return ctx.reply(
        `🪪 <b>Step 9/9 — Upload Officer Government ID</b>\n──────────────────────────\n` +
        `Send a clear <b>photo or PDF</b> of the director/owner's government ID:` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("business")) }
      );

    case "nuvion_kyb_doc_officer_poa":
      return ctx.reply(
        `🧾 <b>Final Upload — Officer Proof of Address</b>\n──────────────────────────\n` +
        `Send a clear <b>photo or PDF</b> of the director/owner's proof of address (&lt; 3 months):` +
        NUVION_PRIVACY_FOOTER,
        { parse_mode: "HTML", ...Markup.inlineKeyboard(wizardControls("business")) }
      );

    case "nuvion_kyb_review":
      return ctx.reply(
        `✅ <b>Review Business Verification (KYB)</b>\n──────────────────────────\n` +
        `• <b>Legal Name:</b> ${escapeHtml(data.legal_name)}\n` +
        `• <b>Type / Industry:</b> ${escapeHtml(data.business_type)} · ${escapeHtml(data.industry)}\n` +
        `• <b>Reg # / Tax ID:</b> <code>${escapeHtml(maskSecret(data.registration_number, 3))}</code> / <code>${escapeHtml(maskSecret(data.tax_id, 3))}</code>\n` +
        `• <b>Email:</b> ${escapeHtml(data.business_email)}\n` +
        `• <b>Officer:</b> ${escapeHtml(data.officer_first_name)} ${escapeHtml(data.officer_last_name)} (${escapeHtml(data.officer_job_title)}, ${data.officer_ownership}%)\n` +
        `• <b>Documents:</b> COI ✅ · MemArt ✅ · Biz POA ✅ · Officer ID ✅ · Officer POA ✅\n\n` +
        `🛡️ <i>Your KYB verification is processed by <b>Nuvion</b> (100% compliant &amp; confidential — never shared with anyone). This review card will also be auto-deleted upon submission.</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🚀 Submit Business Verification", "nuvion_kyb_submit")],
            [
              Markup.button.callback("💾 Pause & Save", "nuvion_kyb_pause"),
              Markup.button.callback("🗑️ Cancel & Clear", "nuvion_kyb_reset"),
            ],
          ]),
        }
      );
  }
}

// ── Submit Handlers (Personal KYC & Business KYB) ─────────────────────────────

async function executePersonalKycSubmission(ctx, userId) {
  const draft = db.getNuvionKycDraft(userId, "personal");
  const d = draft?.data;
  if (!d || !d.first_name || !d.email || !d.doc_id_front || !d.doc_poa) {
    return ctx.reply("⚠️ Your verification draft is incomplete. Please restart with /global.");
  }

  // Idempotency lock: prevent double-tap duplicate POST /individual-entities calls
  const lockKey = `nuvion_kyc_submit:${userId}:personal`;
  const lock = idempotency.tryAcquireOperationLock(lockKey, {
    scope: "nuvion_kyc_submit",
    telegramId: userId,
    accountType: "personal",
    lockTtlSeconds: 120,
  });
  if (!lock.acquired) {
    if (lock.reason === "already_completed") {
      return showGlobalPortal(ctx, "personal");
    }
    return ctx.reply("⏳ Your verification is already being submitted. Please wait a moment...");
  }

  const fullName = [d.first_name, d.middle_name, d.last_name].filter(Boolean).join(" ");
  const personObj = {
    first_name: d.first_name,
    last_name: d.last_name,
    date_of_birth: d.date_of_birth,
    email: String(d.email).trim().toLowerCase(),
    nationality: String(d.nationality || "").toUpperCase(),
    gender: d.gender === "f" ? "f" : "m",
    phonenumber: d.phonenumber,
  };
  if (d.middle_name) personObj.middle_name = d.middle_name;
  if (d.bvn) personObj.bvn = d.bvn;
  if (d.nin) personObj.nin = d.nin;
  if (d.ssn) personObj.ssn = d.ssn;

  const entityPayload = {
    name: fullName,
    person: personObj,
    address: {
      line_1: d.line_1,
      city: d.city,
      state: d.state,
      postal_code: d.postal_code,
      country_code: String(d.country_code || d.nationality || "").toUpperCase(),
    },
    identification: {
      document: {
        type: d.id_type,
        number: d.id_number,
        issue_date: d.id_issue_date,
        expiry_date: d.id_expiry_date,
        issuing_country: String(d.id_issuing_country || d.nationality || "").toUpperCase(),
        issuing_authority: d.id_issuing_authority || "Government Authority",
      },
      proof_of_address: {
        type: "utility_bill",
      },
    },
    meta: {
      funding_source: "salary",
      monthly_transaction_value: "5000",
      customer_types: "individual",
      monthly_payments_count: "20",
      max_transfer_amount: "5000",
      sales_channels: "Proxim",
    },
  };

  try {
    // Pre-flight schema check BEFORE hitting live https://api.nuvion.co!
    nuvion.validateIndividualEntityPayload(entityPayload);

    await ctx.reply("⏳ <b>Submitting your Tier-1 verification securely...</b>", { parse_mode: "HTML" });

    // Check existing local entity first to avoid duplicate POST /individual-entities on retry
    const existingLocal = db.getNuvionEntityByUser(userId, "personal");
    let entityId = existingLocal?.entity_id || null;
    let personId = existingLocal?.person_id || null;
    let entityStatus = String(existingLocal?.status || "").toLowerCase();

    if (entityId && (entityStatus === "pending" || entityStatus === "approved")) {
      db.deleteNuvionKycDraft(userId, "personal");
      convState.clearState(userId);
      idempotency.completeOperationIdempotency(lockKey, { txHash: entityId });
      return showGlobalPortal(ctx, "personal");
    }

    if (!entityId || entityStatus !== "incomplete") {
      let created = null;
      try {
        created = await nuvion.createIndividualEntity(entityPayload, { validate: true });
      } catch (err) {
        if (err instanceof nuvion.NuvionError && err.status === 409 && err.type === "error_duplicate_resource") {
          created = await nuvion.recoverEntityByName({ name: fullName, type: "individual", email: personObj.email });
          if (!created) throw err;
        } else {
          throw err;
        }
      }

      const entityObj = created?.entity || created;
      entityId = entityObj?.id;
      personId = created?.person?.id || entityObj?.person_id || null;
      entityStatus = String(entityObj?.status || "incomplete").toLowerCase();
      if (!entityId) throw new Error("Nuvion did not return an entity ID.");

      db.upsertNuvionEntity({
        telegramId: userId,
        accountType: "personal",
        entityId,
        entityType: "individual",
        personId,
        legalName: fullName,
        email: personObj.email,
        status: entityStatus,
      });
    } else if (!personId) {
      try {
        const live = await nuvion.getEntity(entityId);
        personId = live?.person?.id || live?.entity?.person_id || null;
        if (personId) db.updateNuvionEntity(entityId, { person_id: personId });
        if (live?.entity?.status) entityStatus = String(live.entity.status).toLowerCase();
      } catch (_) {}
    }

    // Stream Telegram files directly into memory as Base64 (never saved to disk)
    const idFrontBuf = await deps.downloadTelegramFile(ctx, d.doc_id_front.fileId);
    const idBackBuf = d.doc_id_back?.fileId ? await deps.downloadTelegramFile(ctx, d.doc_id_back.fileId) : null;
    const poaBuf = await deps.downloadTelegramFile(ctx, d.doc_poa.fileId);

    await nuvion.uploadDocument({
      entityId,
      key: "identity",
      description: `${d.id_type} for ${fullName}`,
      fileBase64: idFrontBuf.toString("base64"),
      fileBackBase64: idBackBuf ? idBackBuf.toString("base64") : null,
      fileType: d.doc_id_front.mimeType || "image/jpeg",
      personId,
    });

    await nuvion.uploadDocument({
      entityId,
      key: "proof_of_address",
      description: `Proof of address for ${fullName}`,
      fileBase64: poaBuf.toString("base64"),
      fileType: d.doc_poa.mimeType || "image/jpeg",
      personId,
    });

    if (entityStatus === "incomplete") {
      await nuvion.submitOnboarding(entityId);
      db.updateNuvionEntity(entityId, { status: "pending" });
    }

    idempotency.completeOperationIdempotency(lockKey, { txHash: entityId });

    // Wipe sensitive draft immediately after submission
    db.deleteNuvionKycDraft(userId, "personal");
    convState.clearState(userId);

    if (personObj.email) {
      emailModule.sendKycStatusEmail({
        to: personObj.email,
        name: fullName,
        status: "pending",
        accountType: "personal",
      }).catch((e) => console.warn("[nuvion_kyc:email]", e.message));
    }

    return ctx.reply(
      `🎉 <b>Verification Submitted!</b>\n──────────────────────────\n` +
      `Your Tier-1 verification is now being reviewed by <b>Nuvion</b>.\n\n` +
      `🛡️ <b>Privacy Confirmed:</b> Your application is 100% compliant and confidential, will never be shared with anyone, and your local chat inputs &amp; draft have been erased.\n\n` +
      `We'll notify you automatically right here as soon as your Global Bank Accounts, Virtual USD Cards, and International Transfers are active!`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Check Status", "nuvion_refresh_personal")],
          [Markup.button.callback("🏠 Main Menu", "main_menu")],
        ]),
      }
    );
  } catch (err) {
    idempotency.failOperationIdempotency(lockKey, err.message);
    console.error("[nuvion_kyc:submit_error]", err.message, err.validations || "");
    return ctx.reply(
      `❌ <b>Could not submit verification</b>\n──────────────────────────\n` +
      `${escapeHtml(nuvion.formatUserFriendlyError(err))}\n\n` +
      `Your progress is saved — tap below to retry or restart.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔁 Retry Submission", "nuvion_kyc_submit")],
          [Markup.button.callback("🗑️ Start Over", "nuvion_kyc_reset")],
        ]),
      }
    );
  }
}

async function executeBusinessKybSubmission(ctx, userId) {
  const user = db.getUser(userId);
  if (!user || !user.business_deposit_address) {
    return ctx.reply(
      `⚠️ <b>Business Wallet Required</b>\n──────────────────────────\n` +
      `Please create your Proxim Business Account first so business funds remain strictly isolated from your personal wallet.`,
      { parse_mode: "HTML", ...(deps.backToMenu || {}) }
    );
  }

  const draft = db.getNuvionKycDraft(userId, "business");
  const d = draft?.data;
  if (!d || !d.legal_name || !d.doc_coi || !d.doc_memart || !d.doc_poa || !d.doc_officer_id || !d.doc_officer_poa) {
    return ctx.reply("⚠️ Your business verification draft is incomplete. Please restart with /global.");
  }

  // Idempotency lock: prevent double-tap duplicate POST /business-entities calls
  const lockKey = `nuvion_kyc_submit:${userId}:business`;
  const lock = idempotency.tryAcquireOperationLock(lockKey, {
    scope: "nuvion_kyb_submit",
    telegramId: userId,
    accountType: "business",
    lockTtlSeconds: 120,
  });
  if (!lock.acquired) {
    if (lock.reason === "already_completed") {
      return showGlobalPortal(ctx, "business");
    }
    return ctx.reply("⏳ Your business verification is already being submitted. Please wait a moment...");
  }

  // Check if founder already completed Personal KYC with the same email -> link via person_id to avoid 409!
  const existingPersonal = db.getNuvionEntityByUser(userId, "personal");
  const officerEmailLower = String(d.officer_email || "").trim().toLowerCase();
  const canReusePersonalPersonId = Boolean(
    existingPersonal?.person_id &&
    existingPersonal?.email &&
    String(existingPersonal.email).trim().toLowerCase() === officerEmailLower
  );

  let officerEntry;
  if (canReusePersonalPersonId) {
    officerEntry = {
      job_title: d.officer_job_title || "Director",
      is_control_person: true,
      is_beneficial_owner: true,
      ownership_percentage: Number(d.officer_ownership) || 100,
      person_id: existingPersonal.person_id,
    };
  } else {
    const officerNat = String(d.officer_nationality || "").toUpperCase();
    const officerPerson = {
      first_name: d.officer_first_name,
      last_name: d.officer_last_name,
      date_of_birth: d.officer_dob,
      email: officerEmailLower,
      nationality: officerNat,
      gender: d.officer_gender === "f" ? "f" : "m",
      phonenumber: d.officer_phone,
      identification: {
        document: {
          type: d.officer_id_type || "international_passport",
          number: d.officer_id_number,
          issue_date: d.officer_id_issue_date,
          expiry_date: d.officer_id_expiry_date,
          issuing_country: officerNat,
          issuing_authority: d.officer_id_authority || "Government Authority",
        },
        proof_of_address: { type: "utility_bill" },
      },
      address: {
        line_1: d.biz_line_1,
        city: d.biz_city,
        state: d.biz_state,
        postal_code: d.biz_postal_code,
        country_code: String(d.biz_country_code || officerNat || "").toUpperCase(),
      },
    };
    if (d.officer_bvn) officerPerson.bvn = d.officer_bvn;
    if (d.officer_nin) officerPerson.nin = d.officer_nin;
    if (d.officer_ssn) officerPerson.ssn = d.officer_ssn;

    officerEntry = {
      job_title: d.officer_job_title || "Director",
      is_control_person: true,
      is_beneficial_owner: true,
      ownership_percentage: Number(d.officer_ownership) || 100,
      person: officerPerson,
    };
  }

  const businessObj = {
    legal_name: d.legal_name,
    trade_name: d.trade_name || d.legal_name,
    industry: d.industry || "Technology",
    email: String(d.business_email || "").trim().toLowerCase(),
    type: d.business_type || "llc",
    description: `${d.legal_name} operating in ${d.industry || "Technology"}`,
    registration_number: d.registration_number,
    phonenumber: d.business_phone,
    incorporation_meta: {
      year: Number(d.incorp_year),
      month: Number(d.incorp_month),
      country: String(d.incorp_country || "").toUpperCase(),
      state: d.incorp_state,
    },
  };
  // Only send website when a valid URL was actually provided (optional per Nuvion docs)
  const cleanWebsite = normalizeWebsiteUrl(d.business_website);
  if (cleanWebsite) {
    businessObj.website = cleanWebsite;
  }

  const bizAddress = {
    line_1: d.biz_line_1,
    city: d.biz_city,
    state: d.biz_state,
    postal_code: d.biz_postal_code,
    country_code: String(d.biz_country_code || d.incorp_country || "").toUpperCase(),
  };

  const payload = {
    name: d.legal_name,
    business: businessObj,
    address: bizAddress,
    operating_address: { ...bizAddress },
    business_officers: [officerEntry],
    meta: {
      registration_number: d.registration_number,
      tax_id: d.tax_id,
      annual_turnover: "100K",
      monthly_transaction_value: "25K",
      monthly_payments_count: "50",
      max_transfer_amount: "10K",
      customer_types: "Business",
      sales_channels: "Direct",
      funding_source: "Business revenue",
    },
  };

  try {
    // Pre-flight schema check BEFORE hitting live https://api.nuvion.co!
    nuvion.validateBusinessEntityPayload(payload);

    await ctx.reply("⏳ <b>Submitting your Business KYB verification securely...</b>", { parse_mode: "HTML" });

    // Check existing local business entity first so retries reuse `incomplete` entity instead of re-creating
    const existingLocal = db.getNuvionEntityByUser(userId, "business");
    let entityId = existingLocal?.entity_id || null;
    let businessId = existingLocal?.business_id || null;
    let officerPersonId = existingLocal?.person_id || (canReusePersonalPersonId ? existingPersonal.person_id : null);
    let entityStatus = String(existingLocal?.status || "").toLowerCase();

    if (entityId && (entityStatus === "pending" || entityStatus === "approved")) {
      db.deleteNuvionKycDraft(userId, "business");
      convState.clearState(userId);
      idempotency.completeOperationIdempotency(lockKey, { txHash: entityId });
      return showGlobalPortal(ctx, "business");
    }

    if (!entityId || entityStatus !== "incomplete") {
      let created = null;
      try {
        created = await nuvion.createBusinessEntity(payload, { validate: true });
      } catch (err) {
        if (err instanceof nuvion.NuvionError && err.status === 409 && err.type === "error_duplicate_resource") {
          created = await nuvion.recoverEntityByName({ name: d.legal_name, type: "business", email: businessObj.email });
          if (!created) throw err;
        } else {
          throw err;
        }
      }

      const entityObj = created?.entity || created;
      entityId = entityObj?.id;
      businessId = created?.business?.id || entityObj?.business_id || null;
      // CRITICAL: POST /business-entities returns `data.business_officers[0].person_id`!
      officerPersonId =
        created?.business_officers?.[0]?.person_id ||
        created?.business_officers?.[0]?.person?.id ||
        created?.officers?.[0]?.person_id ||
        created?.officers?.[0]?.person?.id ||
        (canReusePersonalPersonId ? existingPersonal.person_id : null) ||
        null;
      entityStatus = String(entityObj?.status || "incomplete").toLowerCase();
      if (!entityId) throw new Error("Nuvion did not return a business entity ID.");

      db.upsertNuvionEntity({
        telegramId: userId,
        accountType: "business",
        entityId,
        entityType: "business",
        personId: officerPersonId,
        businessId,
        legalName: d.legal_name,
        email: businessObj.email,
        status: entityStatus,
      });
    }

    if (!officerPersonId) {
      try {
        const live = await nuvion.getEntity(entityId);
        officerPersonId =
          live?.business_officers?.[0]?.person_id ||
          live?.business_officers?.[0]?.person?.id ||
          live?.officers?.[0]?.person_id ||
          null;
        if (officerPersonId) db.updateNuvionEntity(entityId, { person_id: officerPersonId });
        if (live?.entity?.status) entityStatus = String(live.entity.status).toLowerCase();
      } catch (_) {}
    }

    if (!officerPersonId) {
      throw new Error("Could not resolve officer person_id from Nuvion business entity; aborting document upload to prevent unlinked officer docs.");
    }

    const docs = [
      { key: "certificate_of_incorporation", doc: d.doc_coi, desc: `COI for ${d.legal_name}` },
      { key: "memorandum_of_association", doc: d.doc_memart, desc: `MemArt for ${d.legal_name}` },
      { key: "proof_of_address", doc: d.doc_poa, desc: `Business POA for ${d.legal_name}` },
      { key: "identity", doc: d.doc_officer_id, desc: `Officer ID`, personId: officerPersonId },
      { key: "proof_of_address", doc: d.doc_officer_poa, desc: `Officer POA`, personId: officerPersonId },
    ];

    for (const item of docs) {
      const buf = await deps.downloadTelegramFile(ctx, item.doc.fileId);
      await nuvion.uploadDocument({
        entityId,
        key: item.key,
        description: item.desc,
        fileBase64: buf.toString("base64"),
        fileType: item.doc.mimeType || "application/pdf",
        personId: item.personId || null,
      });
    }

    if (entityStatus === "incomplete") {
      await nuvion.submitOnboarding(entityId);
      db.updateNuvionEntity(entityId, { status: "pending" });
    }

    idempotency.completeOperationIdempotency(lockKey, { txHash: entityId });

    db.deleteNuvionKycDraft(userId, "business");
    convState.clearState(userId);

    if (businessObj.email) {
      emailModule.sendKycStatusEmail({
        to: businessObj.email,
        name: d.legal_name,
        status: "pending",
        accountType: "business",
      }).catch((e) => console.warn("[nuvion_kyb:email]", e.message));
    }

    return ctx.reply(
      `🎉 <b>Business Verification Submitted!</b>\n──────────────────────────\n` +
      `<b>${escapeHtml(d.legal_name)}</b> is now under KYB compliance review by <b>Nuvion</b>.\n\n` +
      `🛡️ <b>Privacy Confirmed:</b> Your business records are 100% compliant and confidential, will never be shared with anyone, and your local chat inputs &amp; draft have been erased.\n\n` +
      `We'll notify you automatically the moment your Business Global Bank Accounts and Team Cards are live!`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Check Status", "nuvion_refresh_business")],
          [Markup.button.callback("🏠 Main Menu", "main_menu")],
        ]),
      }
    );
  } catch (err) {
    idempotency.failOperationIdempotency(lockKey, err.message);
    console.error("[nuvion_kyb:submit_error]", err.message, err.validations || "");
    return ctx.reply(
      `❌ <b>Could not submit business verification</b>\n──────────────────────────\n` +
      `${escapeHtml(nuvion.formatUserFriendlyError(err))}`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔁 Retry Submission", "nuvion_kyb_submit")],
          [Markup.button.callback("🗑️ Start Over", "nuvion_kyb_reset")],
        ]),
      }
    );
  }
}

// ── Text & File Handlers for Bot Dispatcher ───────────────────────────────────

async function handleNuvionKycTextState(ctx, state, text, userId) {
  if (!state || !handlesState(state.type)) return false;

  const accountType = state.data?.accountType || (state.type.startsWith("nuvion_kyb_") ? "business" : "personal");
  const draft = db.getNuvionKycDraft(userId, accountType);
  const data = { ...(draft?.data || {}), ...(state.data || {}) };
  const val = String(text || "").trim();

  if (isUploadState(state.type)) {
    await ctx.reply("📎 Please upload a <b>photo or PDF file</b> directly in this chat (not plain text).", { parse_mode: "HTML" });
    return true;
  }

  // ── Personal KYC Text Steps (Delete User Message Upon Passing Each Step!) ─
  if (state.type === "nuvion_kyc_country") {
    const code = val.toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) {
      if (compliance.isSanctionedCountry(code)) {
        await deleteUserStepMessage(ctx);
        await ctx.reply(compliance.getSanctionedCountryMessage(code), { parse_mode: "HTML", disable_web_page_preview: true });
        return true;
      }
      await deleteUserStepMessage(ctx);
      data.nationality = code;
      data.country_code = code;
      await promptPersonalKycStep(ctx, userId, "nuvion_kyc_name", data);
      return true;
    }
    // Backwards-compatible fallback if a caller/test sends full name directly on step 1
    const nameParts = val.split(/\s+/).filter(Boolean);
    if (nameParts.length >= 2) {
      await deleteUserStepMessage(ctx);
      data.first_name = nameParts[0];
      data.last_name = nameParts[nameParts.length - 1];
      if (nameParts.length > 2) data.middle_name = nameParts.slice(1, -1).join(" ");
      await promptPersonalKycStep(ctx, userId, "nuvion_kyc_email", data);
      return true;
    }
    await ctx.reply("Please tap your country button above or enter a 2-letter ISO country code (e.g. <code>US</code>, <code>GB</code>, <code>CA</code>, <code>NG</code>, <code>GH</code>, <code>KE</code>).", { parse_mode: "HTML" });
    return true;
  }

  if (state.type === "nuvion_kyc_name") {
    const parts = val.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      await ctx.reply("Please enter at least your <b>First Name</b> and <b>Last Name</b>.", { parse_mode: "HTML" });
      return true;
    }
    await deleteUserStepMessage(ctx);
    data.first_name = parts[0];
    data.last_name = parts[parts.length - 1];
    if (parts.length > 2) data.middle_name = parts.slice(1, -1).join(" ");
    await promptPersonalKycStep(ctx, userId, "nuvion_kyc_email", data);
    return true;
  }

  if (state.type === "nuvion_kyc_email") {
    if (!isValidEmail(val)) {
      await ctx.reply("Please enter a valid personal email address (e.g. <code>alex@example.com</code>).", { parse_mode: "HTML" });
      return true;
    }
    await deleteUserStepMessage(ctx);
    data.email = val.toLowerCase();
    await promptPersonalKycStep(ctx, userId, "nuvion_kyc_phone", data);
    return true;
  }

  if (state.type === "nuvion_kyc_phone") {
    const phone = normalizePhone(val, data.nationality || "NG");
    if (!phone) {
      const preset = getCountryKycPreset(data.nationality);
      await ctx.reply(`Please enter a valid phone number with country code (e.g. <code>${escapeHtml(preset.samplePhone)}</code>).`, { parse_mode: "HTML" });
      return true;
    }
    await deleteUserStepMessage(ctx);
    data.phonenumber = phone;
    await promptPersonalKycStep(ctx, userId, "nuvion_kyc_dob", data);
    return true;
  }

  if (state.type === "nuvion_kyc_dob") {
    if (!isAdultDob(val)) {
      await ctx.reply("Please enter a valid date of birth in <code>YYYY-MM-DD</code> format (must be 18+, e.g. <code>1994-06-15</code>).", { parse_mode: "HTML" });
      return true;
    }
    await deleteUserStepMessage(ctx);
    data.date_of_birth = val;
    await promptPersonalKycStep(ctx, userId, "nuvion_kyc_gender", data);
    return true;
  }

  if (state.type === "nuvion_kyc_nationality") {
    const code = val.toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) {
      await ctx.reply("Please tap a country button above or enter a 2-letter ISO country code (e.g. <code>NG</code>, <code>GH</code>, <code>GB</code>).", { parse_mode: "HTML" });
      return true;
    }
    await deleteUserStepMessage(ctx);
    data.nationality = code;
    data.country_code = code;
    await promptPersonalKycStep(ctx, userId, "nuvion_kyc_address_street", data);
    return true;
  }

  if (state.type === "nuvion_kyc_address_street") {
    if (val.length < 4) {
      await ctx.reply("Please enter your complete street address.");
      return true;
    }
    await deleteUserStepMessage(ctx);
    data.line_1 = val;
    await promptPersonalKycStep(ctx, userId, "nuvion_kyc_address_city", data);
    return true;
  }

  if (state.type === "nuvion_kyc_address_city") {
    const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) {
      await ctx.reply("Please send <b>City, State, Postal Code</b> separated by commas (e.g. <code>Lagos, Lagos, 106104</code>).", { parse_mode: "HTML" });
      return true;
    }
    await deleteUserStepMessage(ctx);
    data.city = parts[0];
    data.state = parts[1];
    data.postal_code = parts[2] || "100001";
    if (parts[3] && /^[A-Za-z]{2}$/.test(parts[3])) data.country_code = parts[3].toUpperCase();

    if (data.nationality === "NG") {
      await promptPersonalKycStep(ctx, userId, "nuvion_kyc_bvn", data);
    } else if (data.nationality === "US") {
      await promptPersonalKycStep(ctx, userId, "nuvion_kyc_ssn", data);
    } else {
      await promptPersonalKycStep(ctx, userId, "nuvion_kyc_id_type", data);
    }
    return true;
  }

  if (state.type === "nuvion_kyc_bvn") {
    await deleteUserStepMessage(ctx);
    const digits = val.replace(/\D/g, "");
    if (!/^\d{11}$/.test(digits)) {
      await ctx.reply("BVN must be exactly <b>11 digits</b>. Please re-enter (message will be auto-deleted).", { parse_mode: "HTML" });
      return true;
    }
    data.bvn = digits;
    await promptPersonalKycStep(ctx, userId, "nuvion_kyc_nin", data);
    return true;
  }

  if (state.type === "nuvion_kyc_nin") {
    await deleteUserStepMessage(ctx);
    const digits = val.replace(/\D/g, "");
    if (!/^\d{11}$/.test(digits)) {
      await ctx.reply("NIN must be exactly <b>11 digits</b>. Please re-enter (message will be auto-deleted).", { parse_mode: "HTML" });
      return true;
    }
    data.nin = digits;
    await promptPersonalKycStep(ctx, userId, "nuvion_kyc_id_type", data);
    return true;
  }

  if (state.type === "nuvion_kyc_ssn") {
    await deleteUserStepMessage(ctx);
    const digits = val.replace(/\D/g, "");
    if (!/^\d{9}$/.test(digits)) {
      await ctx.reply("SSN must be 9 digits (e.g. <code>123-45-6789</code>). Please re-enter.", { parse_mode: "HTML" });
      return true;
    }
    data.ssn = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
    await promptPersonalKycStep(ctx, userId, "nuvion_kyc_id_type", data);
    return true;
  }

  if (state.type === "nuvion_kyc_id_number") {
    await deleteUserStepMessage(ctx);
    if (val.length < 4) {
      await ctx.reply("Please enter a valid document number.");
      return true;
    }
    data.id_number = val;
    await promptPersonalKycStep(ctx, userId, "nuvion_kyc_id_dates", data);
    return true;
  }

  if (state.type === "nuvion_kyc_id_dates") {
    const parts = val.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2 || !isValidIsoDate(parts[0]) || !isValidIsoDate(parts[1])) {
      await ctx.reply("Please enter two valid dates: <code>YYYY-MM-DD, YYYY-MM-DD</code> (Issue Date, Expiry Date).", { parse_mode: "HTML" });
      return true;
    }
    if (!isFutureIsoDate(parts[1])) {
      await ctx.reply("⚠️ Your ID appears to be <b>expired</b>. Please provide a valid, unexpired ID.", { parse_mode: "HTML" });
      return true;
    }
    if (parts[0] > parts[1]) {
      await ctx.reply("⚠️ Issue date cannot be later than expiry date. Please re-enter <code>Issue Date, Expiry Date</code>.", { parse_mode: "HTML" });
      return true;
    }
    await deleteUserStepMessage(ctx);
    data.id_issue_date = parts[0];
    data.id_expiry_date = parts[1];
    data.id_issuing_country = data.nationality;
    await promptPersonalKycStep(ctx, userId, "nuvion_kyc_id_authority", data);
    return true;
  }

  if (state.type === "nuvion_kyc_id_authority") {
    if (val.length < 2) {
      await ctx.reply("Please enter the issuing authority (e.g. <code>NIS</code>, <code>NIMC</code>, <code>US Department of State</code>).", { parse_mode: "HTML" });
      return true;
    }
    await deleteUserStepMessage(ctx);
    data.id_issuing_authority = val;
    await promptPersonalKycStep(ctx, userId, "nuvion_kyc_doc_id_front", data);
    return true;
  }

  // ── Business KYB Text Steps (Delete User Message Upon Passing Each Step!) ─
  if (state.type === "nuvion_kyb_country") {
    const code = val.toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) {
      if (compliance.isSanctionedCountry(code)) {
        await deleteUserStepMessage(ctx);
        await ctx.reply(compliance.getSanctionedCountryMessage(code), { parse_mode: "HTML", disable_web_page_preview: true });
        return true;
      }
      await deleteUserStepMessage(ctx);
      data.incorp_country = code;
      data.biz_country_code = code;
      await promptBusinessKybStep(ctx, userId, "nuvion_kyb_legal_name", data);
      return true;
    }
    if (val.length >= 3) {
      await deleteUserStepMessage(ctx);
      data.legal_name = val;
      data.trade_name = val;
      await promptBusinessKybStep(ctx, userId, "nuvion_kyb_type", data);
      return true;
    }
    await ctx.reply("Please tap your business country button above or enter a 2-letter ISO country code (e.g. <code>US</code>, <code>GB</code>, <code>CA</code>, <code>NG</code>, <code>GH</code>, <code>KE</code>).", { parse_mode: "HTML" });
    return true;
  }

  if (state.type === "nuvion_kyb_legal_name") {
    if (val.length < 2) {
      await ctx.reply("Please enter your full registered legal business name.");
      return true;
    }
    await deleteUserStepMessage(ctx);
    data.legal_name = val;
    data.trade_name = val;
    await promptBusinessKybStep(ctx, userId, "nuvion_kyb_type", data);
    return true;
  }

  if (state.type === "nuvion_kyb_reg") {
    const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length < 3) {
      await ctx.reply("Send <b>Registration Number, Tax ID, Industry</b> separated by commas.", { parse_mode: "HTML" });
      return true;
    }
    await deleteUserStepMessage(ctx);
    data.registration_number = parts[0];
    data.tax_id = parts[1];
    data.industry = parts[2];
    await promptBusinessKybStep(ctx, userId, "nuvion_kyb_incorp", data);
    return true;
  }

  if (state.type === "nuvion_kyb_incorp") {
    const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
    const yr = Number(parts[0]);
    const mo = Number(parts[1]);
    if (parts.length < 4 || !yr || yr < 1900 || !mo || mo < 1 || mo > 12 || !/^[A-Za-z]{2}$/.test(parts[2])) {
      await ctx.reply("Send <b>Year, Month (1-12), 2-letter Country Code, State</b> (e.g. <code>2023, 5, NG, Lagos</code>).", { parse_mode: "HTML" });
      return true;
    }
    const incorpCode = parts[2].toUpperCase();
    if (compliance.isSanctionedCountry(incorpCode)) {
      await deleteUserStepMessage(ctx);
      await ctx.reply(compliance.getSanctionedCountryMessage(incorpCode), { parse_mode: "HTML", disable_web_page_preview: true });
      return true;
    }
    await deleteUserStepMessage(ctx);
    data.incorp_year = yr;
    data.incorp_month = mo;
    data.incorp_country = incorpCode;
    data.incorp_state = parts[3];
    await promptBusinessKybStep(ctx, userId, "nuvion_kyb_contact", data);
    return true;
  }

  if (state.type === "nuvion_kyb_contact") {
    const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
    const phone = normalizePhone(parts[1], data.incorp_country || "NG");
    if (parts.length < 2 || !isValidEmail(parts[0]) || !phone) {
      await ctx.reply("Send <b>Business Email, Phone (10–14 chars e.g. +2348012345678), Website (optional)</b> separated by commas.", { parse_mode: "HTML" });
      return true;
    }
    const website = parts[2] ? normalizeWebsiteUrl(parts[2]) : null;
    if (website === undefined) {
      await ctx.reply("That website URL looks invalid. Use format like <code>https://acme.com</code> or omit it.", { parse_mode: "HTML" });
      return true;
    }
    await deleteUserStepMessage(ctx);
    data.business_email = parts[0].toLowerCase();
    data.business_phone = phone;
    data.business_website = website; // null when omitted -> omitted cleanly in payload
    await promptBusinessKybStep(ctx, userId, "nuvion_kyb_address", data);
    return true;
  }

  if (state.type === "nuvion_kyb_address") {
    const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length < 5 || parts[0].length < 4 || !/^[A-Za-z]{2}$/.test(parts[4])) {
      await ctx.reply("Send <b>Street (min 4 chars), City, State, Postal Code, 2-letter Country Code</b> separated by commas.", { parse_mode: "HTML" });
      return true;
    }
    await deleteUserStepMessage(ctx);
    data.biz_line_1 = parts[0];
    data.biz_city = parts[1];
    data.biz_state = parts[2];
    data.biz_postal_code = parts[3];
    data.biz_country_code = parts[4].toUpperCase();
    await promptBusinessKybStep(ctx, userId, "nuvion_kyb_officer", data);
    return true;
  }

  if (state.type === "nuvion_kyb_officer") {
    const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length < 8 || !isValidEmail(parts[4]) || !isAdultDob(parts[6]) || !/^[A-Za-z]{2}$/.test(parts[7])) {
      await ctx.reply("Send <b>First Name, Last Name, Job Title, Ownership %, Email, Phone, DOB (YYYY-MM-DD), Nationality (2-letter), Gender (m/f)</b> separated by commas.", { parse_mode: "HTML" });
      return true;
    }
    const phone = normalizePhone(parts[5], parts[7].toUpperCase());
    if (!phone) {
      await ctx.reply("Officer phone number is invalid (must be 10–14 chars with country code, e.g. <code>+2348012345678</code>).", { parse_mode: "HTML" });
      return true;
    }
    await deleteUserStepMessage(ctx);
    const rawGender = String(parts[8] || "m").trim().toLowerCase();
    const gender = rawGender.startsWith("f") ? "f" : "m";

    data.officer_first_name = parts[0];
    data.officer_last_name = parts[1];
    data.officer_job_title = parts[2];
    data.officer_ownership = Math.min(100, Math.max(25, Number(parts[3].replace("%", "")) || 100));
    data.officer_email = parts[4].toLowerCase();
    data.officer_phone = phone;
    data.officer_dob = parts[6];
    data.officer_nationality = parts[7].toUpperCase();
    data.officer_gender = gender;
    await promptBusinessKybStep(ctx, userId, "nuvion_kyb_officer_ids", data);
    return true;
  }

  if (state.type === "nuvion_kyb_officer_ids") {
    await deleteUserStepMessage(ctx);
    const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length < 4 || !isValidIsoDate(parts[2]) || !isValidIsoDate(parts[3])) {
      await ctx.reply("Send <b>ID Type, ID Number, Issue Date (YYYY-MM-DD), Expiry Date (YYYY-MM-DD), BVN (if NG) / SSN (if US), NIN (if NG)</b> separated by commas.", { parse_mode: "HTML" });
      return true;
    }
    if (!isFutureIsoDate(parts[3]) || parts[2] > parts[3]) {
      await ctx.reply("⚠️ Officer ID must be unexpired with a valid Issue Date before Expiry Date. Please re-enter.", { parse_mode: "HTML" });
      return true;
    }
    const nat = String(data.officer_nationality || "").toUpperCase();
    const bizCountry = String(data.biz_country_code || "").toUpperCase();
    if (nat === "NG" || bizCountry === "NG") {
      const bvn = String(parts[4] || "").replace(/\D/g, "");
      const nin = String(parts[5] || "").replace(/\D/g, "");
      if (!/^\d{11}$/.test(bvn) || !/^\d{11}$/.test(nin)) {
        await ctx.reply("Nigerian officers require an <b>11-digit BVN</b> and <b>11-digit NIN</b> as the 5th and 6th values.", { parse_mode: "HTML" });
        return true;
      }
      data.officer_bvn = bvn;
      data.officer_nin = nin;
    } else if (nat === "US" || bizCountry === "US") {
      const ssnDigits = String(parts[4] || "").replace(/\D/g, "");
      if (!/^\d{9}$/.test(ssnDigits)) {
        await ctx.reply("U.S. officers require a <b>9-digit SSN</b> as the 5th value.", { parse_mode: "HTML" });
        return true;
      }
      data.officer_ssn = `${ssnDigits.slice(0, 3)}-${ssnDigits.slice(3, 5)}-${ssnDigits.slice(5)}`;
    } else {
      if (parts[4]) data.officer_bvn = parts[4].replace(/\D/g, "");
      if (parts[5]) data.officer_nin = parts[5].replace(/\D/g, "");
    }
    const rawType = parts[0].toLowerCase();
    data.officer_id_type = rawType.includes("pass") ? "international_passport" : rawType.includes("driv") ? "drivers_license" : "national_id";
    data.officer_id_number = parts[1];
    data.officer_id_issue_date = parts[2];
    data.officer_id_expiry_date = parts[3];
    await promptBusinessKybStep(ctx, userId, "nuvion_kyb_doc_coi", data);
    return true;
  }

  return false;
}

/**
 * Handles photo or PDF/DOCX uploads during active KYC / KYB upload steps.
 * Returns true if consumed so bot.js skips invoice/logo parsing.
 */
async function handleNuvionKycMediaUpload(ctx, { fileId, mimeType = "image/jpeg" }) {
  const userId = ctx.from?.id;
  if (!userId) return false;
  const state = convState.getState(userId);
  if (!state || !isUploadState(state.type)) return false;

  // Immediately delete sensitive upload from chat
  await deleteUserStepMessage(ctx);

  const normalizedMime = String(mimeType || "image/jpeg").trim().toLowerCase();
  const stepAllowed = UPLOAD_STEP_ALLOWED_MIMES[state.type] || nuvion.ALLOWED_DOCUMENT_MIME_TYPES;
  if (!nuvion.ALLOWED_DOCUMENT_MIME_TYPES.has(normalizedMime) || !stepAllowed.has(normalizedMime)) {
    const allowedLabels = state.type === "nuvion_kyb_doc_coi"
      ? "PDF"
      : state.type === "nuvion_kyb_doc_memart"
        ? "PDF or DOC/DOCX"
        : "JPG, PNG, or PDF";
    await ctx.reply(
      `⚠️ Unsupported file format (<code>${escapeHtml(normalizedMime)}</code>). Please upload a <b>${allowedLabels}</b> file.`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  const accountType = state.type.startsWith("nuvion_kyb_") ? "business" : "personal";
  const draft = db.getNuvionKycDraft(userId, accountType);
  const data = { ...(draft?.data || {}), ...(state.data || {}) };
  const docMeta = { fileId, mimeType: normalizedMime };

  switch (state.type) {
    case "nuvion_kyc_doc_id_front":
      data.doc_id_front = docMeta;
      if (data.id_type === "international_passport") {
        await promptPersonalKycStep(ctx, userId, "nuvion_kyc_doc_poa", data);
      } else {
        await promptPersonalKycStep(ctx, userId, "nuvion_kyc_doc_id_back", data);
      }
      return true;

    case "nuvion_kyc_doc_id_back":
      data.doc_id_back = docMeta;
      await promptPersonalKycStep(ctx, userId, "nuvion_kyc_doc_poa", data);
      return true;

    case "nuvion_kyc_doc_poa":
      data.doc_poa = docMeta;
      await promptPersonalKycStep(ctx, userId, "nuvion_kyc_review", data);
      return true;

    case "nuvion_kyb_doc_coi":
      data.doc_coi = docMeta;
      await promptBusinessKybStep(ctx, userId, "nuvion_kyb_doc_memart", data);
      return true;

    case "nuvion_kyb_doc_memart":
      data.doc_memart = docMeta;
      await promptBusinessKybStep(ctx, userId, "nuvion_kyb_doc_poa", data);
      return true;

    case "nuvion_kyb_doc_poa":
      data.doc_poa = docMeta;
      await promptBusinessKybStep(ctx, userId, "nuvion_kyb_doc_officer_id", data);
      return true;

    case "nuvion_kyb_doc_officer_id":
      data.doc_officer_id = docMeta;
      await promptBusinessKybStep(ctx, userId, "nuvion_kyb_doc_officer_poa", data);
      return true;

    case "nuvion_kyb_doc_officer_poa":
      data.doc_officer_poa = docMeta;
      await promptBusinessKybStep(ctx, userId, "nuvion_kyb_review", data);
      return true;
  }

  return false;
}

// ── Register Telegraf Commands & Callbacks ────────────────────────────────────

function registerNuvionKycFlows(bot, depsIn = {}) {
  deps = { bot, ...depsIn };

  bot.command(["global", "verify"], async (ctx) => showGlobalPortal(ctx));
  bot.command("kyc", async (ctx) => showGlobalPortal(ctx, "personal"));
  bot.command("kyb", async (ctx) => showGlobalPortal(ctx, "business"));
  bot.command(["resume_kyc", "proceed_kyc"], async (ctx) => {
    const draft = db.getNuvionKycDraft(ctx.from.id, "personal");
    if (draft && draft.step) return promptPersonalKycStep(ctx, ctx.from.id, draft.step, draft.data || {});
    return showGlobalPortal(ctx, "personal");
  });
  bot.command(["resume_kyb", "proceed_kyb"], async (ctx) => {
    const draft = db.getNuvionKycDraft(ctx.from.id, "business");
    if (draft && draft.step) return promptBusinessKybStep(ctx, ctx.from.id, draft.step, draft.data || {});
    return showGlobalPortal(ctx, "business");
  });
  bot.command(["resume", "proceed"], async (ctx) => {
    const acctType = deps.getContext ? deps.getContext(ctx.from.id) : "personal";
    const draft = db.getNuvionKycDraft(ctx.from.id, acctType);
    if (draft && draft.step) {
      if (acctType === "business") {
        return promptBusinessKybStep(ctx, ctx.from.id, draft.step, draft.data || {});
      }
      return promptPersonalKycStep(ctx, ctx.from.id, draft.step, draft.data || {});
    }
    return showGlobalPortal(ctx, acctType);
  });

  bot.action("action_nuvion_portal", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    return showGlobalPortal(ctx, "personal");
  });

  bot.action("biz_nuvion_portal", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    return showGlobalPortal(ctx, "business");
  });

  bot.action(/^nuvion_refresh_(personal|business)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const acctType = ctx.match[1];
    if (!nuvion.isUserAllowedNuvion(ctx.from.id)) return showGlobalPortal(ctx, acctType);
    const local = db.getNuvionEntityByUser(ctx.from.id, acctType);
    if (!local) return showGlobalPortal(ctx, acctType);

    try {
      const liveWrapper = await nuvion.getEntity(local.entity_id);
      const liveEntity = liveWrapper?.entity || liveWrapper;
      const latestStatus = String(liveEntity?.status || local.status).toLowerCase();
      let updated = db.updateNuvionEntity(local.entity_id, {
        status: latestStatus,
        risk_level: liveEntity?.risk_level || local.risk_level,
      });
      if (latestStatus === "approved") {
        await nuvionWebhooks.bootstrapApprovedEntity(updated, { liveEntity: liveWrapper });
      }
    } catch (err) {
      await ctx.reply(`⚠️ Couldn't refresh right now: ${escapeHtml(nuvion.formatUserFriendlyError(err))}`, { parse_mode: "HTML" });
    }
    return showGlobalPortal(ctx, acctType);
  });

  // Personal KYC start / resume / pause / reset / inline selections
  bot.action("nuvion_kyc_start", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!nuvion.isUserAllowedNuvion(ctx.from.id)) return showGlobalPortal(ctx, "personal");
    db.deleteNuvionKycDraft(ctx.from.id, "personal");
    return promptPersonalKycStep(ctx, ctx.from.id, "nuvion_kyc_country", {});
  });

  bot.action(/^nuvion_kyc_pick_country_([A-Z]{2})$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const nat = ctx.match[1];
    const draft = db.getNuvionKycDraft(ctx.from.id, "personal");
    const data = { ...(draft?.data || {}), nationality: nat, country_code: nat };
    return promptPersonalKycStep(ctx, ctx.from.id, "nuvion_kyc_name", data);
  });

  bot.action("nuvion_kyc_resume", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const draft = db.getNuvionKycDraft(ctx.from.id, "personal");
    if (!draft) return promptPersonalKycStep(ctx, ctx.from.id, "nuvion_kyc_country", {});
    return promptPersonalKycStep(ctx, ctx.from.id, draft.step, draft.data);
  });

  bot.action("nuvion_kyc_pause", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const currentState = convState.getState(ctx.from.id);
    if (currentState && String(currentState.type || "").startsWith("nuvion_kyc_")) {
      db.saveNuvionKycDraft(ctx.from.id, "personal", currentState.type, currentState.data || {});
    }
    convState.clearState(ctx.from.id);
    return ctx.reply(
      "💾 <b>Personal Verification Paused & Saved!</b>\n──────────────────────────\n" +
      "Your progress has been safely saved. Whenever you're ready to proceed, tap <b>▶️ Resume Verification</b> below or send /global.",
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("▶️ Resume Verification", "nuvion_kyc_resume")],
          [Markup.button.callback("🔄 Start Fresh", "nuvion_kyc_start")],
          [Markup.button.callback("🏠 Main Menu", "main_menu")],
        ]),
      }
    );
  });

  bot.action("nuvion_kyc_reset", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    await deleteUserStepMessage(ctx);
    db.deleteNuvionKycDraft(ctx.from.id, "personal");
    convState.clearState(ctx.from.id);
    return ctx.reply("🗑️ Verification draft cleared and removed from chat.", deps.backToMenu || {});
  });

  bot.action(/^nuvion_kyc_set_gender_(m|f)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const draft = db.getNuvionKycDraft(ctx.from.id, "personal");
    const data = { ...(draft?.data || {}), gender: ctx.match[1] };
    // If the user already selected their country at Step 1, skip straight to Residential Address!
    if (data.nationality && /^[A-Z]{2}$/.test(data.nationality)) {
      return promptPersonalKycStep(ctx, ctx.from.id, "nuvion_kyc_address_street", data);
    }
    return promptPersonalKycStep(ctx, ctx.from.id, "nuvion_kyc_nationality", data);
  });

  bot.action(/^nuvion_kyc_set_nat_([A-Z]{2})$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const draft = db.getNuvionKycDraft(ctx.from.id, "personal");
    const nat = ctx.match[1];
    const data = { ...(draft?.data || {}), nationality: nat, country_code: nat };
    return promptPersonalKycStep(ctx, ctx.from.id, "nuvion_kyc_address_street", data);
  });

  bot.action(/^nuvion_kyc_set_idtype_(international_passport|national_id|drivers_license)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const draft = db.getNuvionKycDraft(ctx.from.id, "personal");
    const data = { ...(draft?.data || {}), id_type: ctx.match[1] };
    return promptPersonalKycStep(ctx, ctx.from.id, "nuvion_kyc_id_number", data);
  });

  bot.action(/^nuvion_kyc_set_auth_(.+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const authMap = {
      NIS: "Nigeria Immigration Service",
      NIMC: "National Identity Management Commission",
      FRSC: "Federal Road Safety Corps",
      US_DOS: "US Department of State",
      US_DMV: "Department of Motor Vehicles",
      GB_HMPO: "HM Passport Office",
      GB_DVLA: "Driver and Vehicle Licensing Agency",
      CA_IRCC: "Immigration, Refugees and Citizenship Canada",
      CA_PROV: "Provincial Licensing Authority",
      GH_PASS: "Passport Office Ghana",
      GH_NIA: "National Identification Authority",
      GH_DVLA: "Driver and Vehicle Licensing Authority",
      KE_IMM: "Directorate of Immigration Services",
      KE_NRB: "National Registration Bureau",
      KE_NTSA: "National Transport and Safety Authority",
      INTL_PASS: "National Passport Office",
      INTL_NID: "National Identity Authority",
      INTL_DL: "Driver Licensing Authority",
    };
    const draft = db.getNuvionKycDraft(ctx.from.id, "personal");
    const data = { ...(draft?.data || {}), id_issuing_authority: authMap[ctx.match[1]] || ctx.match[1] };
    return promptPersonalKycStep(ctx, ctx.from.id, "nuvion_kyc_doc_id_front", data);
  });

  bot.action("nuvion_kyc_skip_id_back", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const draft = db.getNuvionKycDraft(ctx.from.id, "personal");
    return promptPersonalKycStep(ctx, ctx.from.id, "nuvion_kyc_doc_poa", draft?.data || {});
  });

  bot.action("nuvion_kyc_submit", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    await deleteUserStepMessage(ctx);
    return executePersonalKycSubmission(ctx, ctx.from.id);
  });

  // Business KYB start / resume / pause / reset / inline selections
  bot.action("nuvion_kyb_start", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!nuvion.isUserAllowedNuvion(ctx.from.id)) return showGlobalPortal(ctx, "business");
    db.deleteNuvionKycDraft(ctx.from.id, "business");
    return promptBusinessKybStep(ctx, ctx.from.id, "nuvion_kyb_country", {});
  });

  bot.action(/^nuvion_kyb_pick_country_([A-Z]{2})$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const country = ctx.match[1];
    const draft = db.getNuvionKycDraft(ctx.from.id, "business");
    const data = { ...(draft?.data || {}), incorp_country: country, biz_country_code: country };
    return promptBusinessKybStep(ctx, ctx.from.id, "nuvion_kyb_legal_name", data);
  });

  bot.action("nuvion_kyb_resume", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const draft = db.getNuvionKycDraft(ctx.from.id, "business");
    if (!draft) return promptBusinessKybStep(ctx, ctx.from.id, "nuvion_kyb_country", {});
    return promptBusinessKybStep(ctx, ctx.from.id, draft.step, draft.data);
  });

  bot.action("nuvion_kyb_pause", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const currentState = convState.getState(ctx.from.id);
    if (currentState && String(currentState.type || "").startsWith("nuvion_kyb_")) {
      db.saveNuvionKycDraft(ctx.from.id, "business", currentState.type, currentState.data || {});
    }
    convState.clearState(ctx.from.id);
    return ctx.reply(
      "💾 <b>Business Verification Paused & Saved!</b>\n──────────────────────────\n" +
      "Your progress has been safely saved. Whenever you're ready to proceed, tap <b>▶️ Resume Verification</b> below or send /global.",
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("▶️ Resume Verification", "nuvion_kyb_resume")],
          [Markup.button.callback("🔄 Start Fresh", "nuvion_kyb_start")],
          [Markup.button.callback("🏠 Main Menu", "main_menu")],
        ]),
      }
    );
  });

  bot.action("nuvion_kyb_reset", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    await deleteUserStepMessage(ctx);
    db.deleteNuvionKycDraft(ctx.from.id, "business");
    convState.clearState(ctx.from.id);
    return ctx.reply("🗑️ Business verification draft cleared and removed from chat.", deps.backToMenu || {});
  });

  bot.action(/^nuvion_kyb_set_type_(llc|corporation|sole_proprietorship|partnership)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const draft = db.getNuvionKycDraft(ctx.from.id, "business");
    const data = { ...(draft?.data || {}), business_type: ctx.match[1] };
    return promptBusinessKybStep(ctx, ctx.from.id, "nuvion_kyb_reg", data);
  });

  bot.action("nuvion_kyb_submit", async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    await deleteUserStepMessage(ctx);
    return executeBusinessKybSubmission(ctx, ctx.from.id);
  });
}

module.exports = {
  registerNuvionKycFlows,
  showGlobalPortal,
  handlesState,
  isUploadState,
  handleNuvionKycTextState,
  handleNuvionKycMediaUpload,
  executePersonalKycSubmission,
  executeBusinessKybSubmission,
  normalizePhone,
  normalizeWebsiteUrl,
  isValidEmail,
  isAdultDob,
  isFutureIsoDate,
  maskSecret,
};
