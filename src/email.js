// src/email.js
// Transactional email dispatch for Proxim end-users (KYC approval, receipts, security alerts).
// Uses Resend API (standard), Postmark, or SMTP if configured.
// Prevents Nuvion internal admin notifications from being the only communication channel:
// alerts are sent directly to the customer's personal email.

const axios = require("axios");

/**
 * Resolve the best available consumer email address for a user across:
 * 1. Live provider entity payload (person/business/individual/top-level email)
 * 2. Stored nuvion_entities.email
 * 3. User's Google/Email signup address stored in users.phone_number (`email:...`)
 */
function resolveUserEmail(telegramId = null, entityRecord = null, liveEntity = null) {
  const candidates = [
    liveEntity?.person?.email,
    liveEntity?.business?.email,
    liveEntity?.individual?.email,
    liveEntity?.entity?.person?.email,
    liveEntity?.entity?.business?.email,
    liveEntity?.entity?.email,
    liveEntity?.email,
    entityRecord?.email,
  ];
  if (telegramId) {
    try {
      const db = require("./db");
      const user = db.getUser(telegramId);
      const rawPhone = String(user?.phone_number || "");
      if (rawPhone.startsWith("email:")) {
        candidates.push(rawPhone.slice("email:".length));
      }
      if (!entityRecord) {
        const pEnt = db.getNuvionEntityByUser?.(telegramId, "personal");
        const bEnt = db.getNuvionEntityByUser?.(telegramId, "business");
        if (pEnt?.email) candidates.push(pEnt.email);
        if (bEnt?.email) candidates.push(bEnt.email);
      }
      // Also check any saved KYC/KYB draft email if user started KYC
      try {
        const pDraft = db.getNuvionKycDraft?.(telegramId, "personal");
        const bDraft = db.getNuvionKycDraft?.(telegramId, "business");
        if (pDraft?.data?.email) candidates.push(pDraft.data.email);
        if (bDraft?.data?.email) candidates.push(bDraft.data.email);
      } catch (_) { }
    } catch (_) { }
  }
  for (const c of candidates) {
    const clean = String(c || "").trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) return clean;
  }
  return null;
}

function _lookupFiatAmountFromOrders(db, telegramId, rawType, txHash, amountUsd) {
  if (!txHash || !db?.db) return null;
  try {
    if (/offramp|payout|withdraw_naira/.test(rawType)) {
      const ord = db.db.prepare(
        "SELECT fiat_amount, rate FROM paj_offramp_orders WHERE telegram_id = ? AND (tx_hash = ? OR order_id = ?) ORDER BY id DESC LIMIT 1"
      ).get(Number(telegramId), String(txHash), String(txHash));
      if (ord && Number(ord.fiat_amount) > 0) {
        return { currency: "NGN", amount: Number(ord.fiat_amount) };
      }
      if (ord && Number(ord.rate) > 0 && amountUsd > 0) {
        return { currency: "NGN", amount: Math.round(amountUsd * Number(ord.rate)) };
      }
      const nj = db.db.prepare(
        "SELECT currency, amount_minor FROM nuvion_jobs WHERE telegram_id = ? AND (nuvion_transfer_id = ? OR unique_reference = ?) AND UPPER(currency) = 'NGN' ORDER BY id DESC LIMIT 1"
      ).get(Number(telegramId), String(txHash), String(txHash));
      if (nj && Number(nj.amount_minor) > 0) {
        return { currency: "NGN", amount: Math.round(Number(nj.amount_minor) / 100) };
      }
    } else {
      const ord = db.db.prepare(
        "SELECT fiat_amount FROM paj_onramp_orders WHERE telegram_id = ? AND (tx_hash = ? OR order_id = ?) ORDER BY id DESC LIMIT 1"
      ).get(Number(telegramId), String(txHash), String(txHash));
      if (ord && Number(ord.fiat_amount) > 0) {
        return { currency: "NGN", amount: Number(ord.fiat_amount) };
      }
    }
  } catch (_) { }
  return null;
}

function _lookupCounterpartyFromOrders(db, telegramId, rawType, txHash) {
  if (!txHash || !db?.db) return null;
  try {
    const statement = require("./statement");
    const enriched = statement.enrichTransactionRow(db, telegramId, {
      type: rawType,
      tx_hash: txHash,
    });
    if (enriched.counterpartyName || enriched.counterpartyBank || enriched.counterpartyAccount) {
      return {
        name: enriched.counterpartyName,
        bank: enriched.counterpartyBank,
        account: enriched.counterpartyAccount,
      };
    }
  } catch (_) { }
  return null;
}

function getEmailConfigDiagnostics() {
  const smtpUser = (process.env.SMTP_USER || "").trim();
  const smtpPass = (process.env.SMTP_PASS || "").trim();
  const smtpHost = (process.env.SMTP_HOST || "mail.privateemail.com").trim();
  const smtpPort = Number(process.env.SMTP_PORT || 465);
  const smtpFrom = (process.env.SMTP_FROM_EMAIL || (smtpUser ? `Igboze from Proxim <${smtpUser}>` : "")).trim();
  return {
    resendConfigured: Boolean((process.env.RESEND_API_KEY || "").trim()),
    postmarkConfigured: Boolean((process.env.POSTMARK_SERVER_TOKEN || "").trim()),
    smtpConfigured: Boolean(smtpUser && smtpPass),
    smtpHost: smtpUser ? smtpHost : null,
    smtpPort: smtpUser ? smtpPort : null,
    smtpUserMasked: smtpUser ? smtpUser.replace(/^(..).*(@.*)$/, "$1***$2") : null,
    smtpFrom: smtpFrom || null,
  };
}

async function sendTransactionalEmail({ to, subject, html, text }) {
  if (!to || !to.includes("@")) {
    return { sent: false, reason: "invalid_recipient" };
  }

  const errors = [];

  // 1. Resend (https://resend.com)
  const resendApiKey = (process.env.RESEND_API_KEY || "").trim();
  if (resendApiKey) {
    try {
      const rawFrom = (process.env.RESEND_FROM_EMAIL || "Igboze from Proxim <igboze@proximfi.xyz>").trim();
      const from = rawFrom.replace(/^["']+|["']+$/g, "").trim();
      const resp = await axios.post(
        "https://api.resend.com/emails",
        {
          from,
          to: [to],
          subject,
          html,
          text: text || html.replace(/<[^>]+>/g, ""),
        },
        {
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }
      );
      return { sent: true, provider: "resend", id: resp.data?.id };
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      errors.push(`resend: ${msg}`);
      console.warn(`[email:resend] Failed to send email to ${to}:`, err.response?.data || err.message);
    }
  }

  // 2. Postmark (https://postmarkapp.com)
  const postmarkToken = (process.env.POSTMARK_SERVER_TOKEN || "").trim();
  if (postmarkToken) {
    try {
      const from = (process.env.POSTMARK_FROM_EMAIL || "Igboze from Proxim <igboze@proximfi.xyz>").trim().replace(/^["']+|["']+$/g, "").trim();
      const resp = await axios.post(
        "https://api.postmarkapp.com/email",
        {
          From: from,
          To: to,
          Subject: subject,
          HtmlBody: html,
          TextBody: text || html.replace(/<[^>]+>/g, ""),
          MessageStream: "outbound",
        },
        {
          headers: {
            "X-Postmark-Server-Token": postmarkToken,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }
      );
      return { sent: true, provider: "postmark", id: resp.data?.MessageID };
    } catch (err) {
      const msg = err.response?.data?.Message || err.message;
      errors.push(`postmark: ${msg}`);
      console.warn(`[email:postmark] Failed to send email to ${to}:`, err.response?.data || err.message);
    }
  }

  // 3. SMTP (e.g. Namecheap Private Email: mail.privateemail.com, port 465 SSL or 587 STARTTLS)
  const smtpUser = (process.env.SMTP_USER || "").trim();
  const smtpPass = (process.env.SMTP_PASS || "").trim();
  if (smtpUser && smtpPass) {
    const nodemailer = require("nodemailer");
    const host = (process.env.SMTP_HOST || "mail.privateemail.com").trim();
    const primaryPort = Number(process.env.SMTP_PORT || 465);
    const primarySecure = process.env.SMTP_SECURE !== undefined
      ? String(process.env.SMTP_SECURE).toLowerCase() === "true"
      : primaryPort === 465;
    const rawFrom = (process.env.SMTP_FROM_EMAIL || `Igboze from Proxim <${smtpUser}>`).trim();
    const primaryFrom = rawFrom.replace(/^["']+|["']+$/g, "").trim();
    const fallbackFrom = `Igboze from Proxim <${smtpUser}>`;

    // Try configured port first, then automatically fall back between 465 (SSL) and 587 (STARTTLS)
    const attempts = [
      { port: primaryPort, secure: primarySecure, from: primaryFrom },
      { port: primaryPort === 465 ? 587 : 465, secure: primaryPort !== 465, from: primaryFrom },
    ];
    if (primaryFrom.toLowerCase() !== fallbackFrom.toLowerCase()) {
      attempts.push({ port: primaryPort, secure: primarySecure, from: fallbackFrom });
    }

    let smtpLastErr = null;
    for (const cfg of attempts) {
      try {
        const transporter = nodemailer.createTransport({
          host,
          port: cfg.port,
          secure: cfg.secure,
          auth: { user: smtpUser, pass: smtpPass },
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 15000,
        });
        const info = await transporter.sendMail({
          from: cfg.from,
          to,
          subject,
          html,
          text: text || html.replace(/<[^>]+>/g, ""),
        });
        return { sent: true, provider: "smtp", port: cfg.port, id: info?.messageId || null };
      } catch (err) {
        smtpLastErr = err.message;
        console.warn(`[email:smtp] Failed to send to ${to} via ${host}:${cfg.port} (from: ${cfg.from}):`, err.message);
      }
    }
    if (smtpLastErr) errors.push(`smtp: ${smtpLastErr}`);
  }

  // If no email provider is configured (or all configured providers failed), log clearly for diagnostics
  const combinedError = errors.length > 0 ? errors.join(" | ") : null;
  const reason = combinedError ? "provider_delivery_failed" : "no_provider_configured";
  console.warn(`[email:${reason}] To: ${to} | Subject: "${subject}"${combinedError ? ` | Error: ${combinedError}` : ""}`);
  return { sent: false, reason, ...(combinedError ? { error: combinedError } : { simulated: true }) };
}

function escapeEmailHtml(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SUPPORT_EMAIL = "info@proximfi.xyz";
const PROXIM_SOCIAL_LINKS = {
  x: "https://x.com/proximfi",
  facebook: "https://www.facebook.com/proximfi/",
  website: "https://www.proximfi.xyz/",
};

function getEmailAssetBaseUrl() {
  return (
    process.env.APP_PUBLIC_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    "https://payit-production.up.railway.app"
  ).trim().replace(/\/+$/, "");
}

function renderSocialIconsRow() {
  const base = getEmailAssetBaseUrl();
  const items = [
    { href: PROXIM_SOCIAL_LINKS.x, src: `${base}/assets/email/icon_x.png`, alt: "X", label: "X" },
    { href: PROXIM_SOCIAL_LINKS.facebook, src: `${base}/assets/email/icon_facebook.png`, alt: "Facebook", label: "Facebook" },
    { href: PROXIM_SOCIAL_LINKS.website, src: `${base}/assets/email/icon_website.png`, alt: "Website", label: "Website" },
  ];
  const cells = items
    .map(
      (item, idx) => `
      <td align="center" valign="middle" style="${idx < items.length - 1 ? "padding-right:10px;" : ""}">
        <a href="${item.href}" target="_blank" rel="noopener noreferrer" title="${item.label}" style="display:inline-block;text-decoration:none;">
          <img src="${item.src}" alt="${item.alt}" width="30" height="30" style="display:block;width:30px;height:30px;border:0;outline:none;text-decoration:none;border-radius:15px;" />
        </a>
      </td>`
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 10px 0;">
    <tr>${cells}</tr>
  </table>`;
}

/**
 * Gmail / Apple Mail / Outlook-safe responsive HTML email shell.
 * Uses pure nested presentation tables (zero CSS flex/grid/broken emoji badges)
 * so every Proxim email renders crisp and aligned on mobile & desktop clients.
 */
function renderProximEmailShell({
  badge = "PROXIM",
  badgeBg = "#E0A82E",
  badgeColor = "#002018",
  heading = "",
  subheading = "",
  bodyHtml = "",
  footerNote = `Need help? Contact <a href="mailto:${SUPPORT_EMAIL}" style="color:#002018;font-weight:700;text-decoration:none;">${SUPPORT_EMAIL}</a>.`,
  footerBrand = "Proxim &middot; Global Banking &amp; Payments",
  showSocials = true,
}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background-color:#F5F1E8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#13110C;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F5F1E8;width:100%;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background-color:#FFFFFF;border:1px solid #DCD3C1;border-radius:16px;overflow:hidden;">
          <!-- Brand Header -->
          <tr>
            <td style="background-color:#002018;padding:20px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="left" valign="middle">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td valign="middle" style="padding-right:10px;">
                          <img src="${getEmailAssetBaseUrl()}/assets/email/proxim_logo.png" alt="Proxim" width="32" height="32" style="display:block;width:32px;height:32px;border-radius:8px;border:1px solid #1E4D3B;outline:none;text-decoration:none;" />
                        </td>
                        <td valign="middle">
                          <span style="font-size:20px;font-weight:800;letter-spacing:-0.4px;color:#FFFFFF;line-height:24px;">Proxim</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td align="right" valign="middle">
                    <span style="display:inline-block;background-color:${badgeBg};color:${badgeColor};font-size:11px;font-weight:800;letter-spacing:0.6px;text-transform:uppercase;padding:4px 10px;border-radius:999px;">${escapeEmailHtml(badge)}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Main Body -->
          <tr>
            <td style="padding:26px 24px 20px 24px;">
              ${heading ? `<h1 style="margin:0 0 8px 0;font-size:22px;line-height:28px;font-weight:800;color:#002018;">${heading}</h1>` : ""}
              ${subheading ? `<p style="margin:0 0 18px 0;font-size:14.5px;line-height:22px;color:#5C5546;">${subheading}</p>` : ""}
              ${bodyHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color:#FAF7F0;border-top:1px solid #E6DEC9;padding:16px 24px;">
              <p style="margin:0 0 4px 0;font-size:12.5px;line-height:19px;color:#5C5546;">${footerNote}</p>
              ${showSocials ? renderSocialIconsRow() : ""}
              <p style="margin:0;font-size:11.5px;line-height:17px;color:#8A8170;">${footerBrand}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderKeyValueTable(rows) {
  const trs = rows
    .map(
      ([k, v], idx) => `
      <tr>
        <td align="left" valign="top" style="padding:9px 0;font-size:13.5px;line-height:19px;color:#5C5546;${idx < rows.length - 1 ? "border-bottom:1px solid #EAE2D1;" : ""}">${escapeEmailHtml(k)}</td>
        <td align="right" valign="top" style="padding:9px 0 9px 12px;font-size:13.5px;line-height:19px;font-weight:700;color:#13110C;${idx < rows.length - 1 ? "border-bottom:1px solid #EAE2D1;" : ""}">${escapeEmailHtml(v)}</td>
      </tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FAF7F0;border:1px solid #E6DEC9;border-radius:12px;margin:14px 0;">
    <tr>
      <td style="padding:6px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${trs}</table>
      </td>
    </tr>
  </table>`;
}

async function sendKycStatusEmail({ to, name, status, accountType = "personal" }) {
  const isBiz = accountType === "business";
  const label = isBiz ? "Business Account" : "Personal Account";
  const greeting = `Hello ${escapeEmailHtml(name || "there")},`;

  if (status === "approved") {
    const bodyHtml = `
      <p style="margin:0 0 14px 0;font-size:15px;line-height:22px;color:#3A352C;">${greeting}</p>
      <p style="margin:0 0 16px 0;font-size:15px;line-height:22px;color:#3A352C;">Great news! Your <strong>${escapeEmailHtml(label)}</strong> is now <strong>VERIFIED</strong>. Your global bank accounts and virtual USD cards are unlocked.</p>
      ${renderKeyValueTable([
        ["Account Status", "VERIFIED"],
        ["Global Accounts", "USD, GBP, EUR, NGN, CAD, AED, KES, GHS, TZS"],
        ["Deposit Fee", "0% (Hold Local Currency or Auto-USD)"],
        ["Virtual Cards", "USD Cards for global online payments"],
      ])}
      <p style="margin:14px 0 0 0;font-size:14px;line-height:21px;color:#5C5546;">Open the Proxim app or Telegram bot anytime to view your account details and choose whether incoming deposits stay in their local currency or auto-convert to USD.</p>
    `;
    return sendTransactionalEmail({
      to,
      subject: `Your Proxim ${label} Is Now VERIFIED!`,
      html: renderProximEmailShell({
        badge: "VERIFIED",
        badgeBg: "#007840",
        badgeColor: "#FFFFFF",
        heading: `Your Proxim ${escapeEmailHtml(label)} is verified`,
        bodyHtml,
      }),
    });
  } else if (status === "pending") {
    const bodyHtml = `
      <p style="margin:0 0 14px 0;font-size:15px;line-height:22px;color:#3A352C;">${greeting}</p>
      <p style="margin:0 0 14px 0;font-size:15px;line-height:22px;color:#3A352C;">We received your ${isBiz ? "Business Verification (KYB)" : "Identity Verification (KYC)"} for your <strong>${escapeEmailHtml(label)}</strong>. Our compliance team is reviewing your submission now.</p>
      <p style="margin:0;font-size:14px;line-height:21px;color:#5C5546;">We will email you as soon as your Global Accounts (USD, GBP, EUR, NGN, CAD, AED, GHS, KES, TZS) and Virtual USD Cards are active.</p>
    `;
    return sendTransactionalEmail({
      to,
      subject: `Verification Received — Your Proxim ${label} Is Under Review`,
      html: renderProximEmailShell({
        badge: "UNDER REVIEW",
        badgeBg: "#E0A82E",
        badgeColor: "#002018",
        heading: "We received your verification",
        bodyHtml,
      }),
    });
  } else if (status === "failed" || status === "rejected" || status === "action_required") {
    const bodyHtml = `
      <p style="margin:0 0 14px 0;font-size:15px;line-height:22px;color:#3A352C;">${greeting}</p>
      <p style="margin:0 0 14px 0;font-size:15px;line-height:22px;color:#3A352C;">Additional information or a clearer document is needed to finish verifying your <strong>${escapeEmailHtml(label)}</strong>.</p>
      <p style="margin:0;font-size:14px;line-height:21px;color:#5C5546;">Open Proxim and head to <strong>Profile &rarr; Verify ID</strong> to review and resubmit. Your standard wallet remains active.</p>
    `;
    return sendTransactionalEmail({
      to,
      subject: "Action Required: Proxim Verification Update",
      html: renderProximEmailShell({
        badge: "ACTION NEEDED",
        badgeBg: "#E11D48",
        badgeColor: "#FFFFFF",
        heading: "Verification update needed",
        bodyHtml,
      }),
    });
  }
}

async function sendWelcomeEmail({ to, name } = {}) {
  const greeting = name ? `Hello ${escapeEmailHtml(name)},` : "Welcome to Proxim,";
  const subject = "Welcome to Proxim — Your Global Account Is Ready";
  const featureRows = [
    ["Instant Deposits", "Fund via Nigerian bank transfer (NGN), card, or crypto"],
    ["Send Locally & Abroad", "Pay Nigerian banks in seconds, free @username transfers, and 27+ currencies"],
    ["Global Bank Accounts", "Verify ID in Profile to unlock USD, GBP, EUR, NGN, CAD, AED & Virtual USD Cards"],
    ["Dollar Savings & Bills", "Earn yield with Dollar Savings, swap USD/EUR, and pay airtime, data & utilities"],
    ["Business Mode", "Dedicated Business Account for invoices, payment links, expenses & payroll"],
  ];
  const bodyHtml = `
    <p style="margin:0 0 14px 0;font-size:15px;line-height:22px;color:#3A352C;">${greeting}</p>
    <p style="margin:0 0 16px 0;font-size:15px;line-height:22px;color:#3A352C;">Thanks for joining <strong>Proxim</strong>. Your account is secured with your device passkey and 4-digit PIN. Here is what you can do right away:</p>
    ${renderKeyValueTable(featureRows)}
    <p style="margin:14px 0 0 0;font-size:14px;line-height:21px;color:#5C5546;"><strong>Quick tip:</strong> Open <strong>Profile</strong> in the app to claim your <strong>@username</strong> so friends and clients can pay you for free.</p>
  `;
  const text = [
    name ? `Hello ${name},` : "Welcome to Proxim,",
    "",
    "Welcome to Proxim! Your passkey and self-custodial wallet are ready.",
    "",
    ...featureRows.map(([k, v]) => `- ${k}: ${v}`),
    "",
    `Need help? Contact us at ${SUPPORT_EMAIL}.`,
    `X: ${PROXIM_SOCIAL_LINKS.x} | Facebook: ${PROXIM_SOCIAL_LINKS.facebook} | Website: ${PROXIM_SOCIAL_LINKS.website}`,
  ].join("\n");

  return sendTransactionalEmail({
    to,
    subject,
    html: renderProximEmailShell({
      badge: "WELCOME",
      badgeBg: "#E0A82E",
      badgeColor: "#002018",
      heading: "Your Proxim account is ready",
      bodyHtml,
    }),
    text,
  });
}

async function sendGlobalAccountCreatedEmail({ to, name, currency, accountType = "personal", detail = {} } = {}) {
  const code = String(currency || detail?.currency || "USD").toUpperCase();
  const isBiz = accountType === "business";
  const acctLabel = isBiz ? "Business Account" : "Personal Account";
  const greeting = name ? `Hello ${escapeEmailHtml(name)},` : "Hello,";

  const rows = [["Account Name", detail?.beneficiary_name || name || acctLabel]];
  if (detail?.bank_name) rows.push(["Bank Name", detail.bank_name]);
  if (detail?.account_number) rows.push(["Account Number", detail.account_number]);
  if (detail?.iban) rows.push(["IBAN", detail.iban]);
  if (detail?.routing_number) rows.push(["Routing Number", detail.routing_number]);
  if (detail?.sort_code) rows.push(["Sort Code", detail.sort_code]);
  if (detail?.swift_code) rows.push(["SWIFT / BIC", detail.swift_code]);
  rows.push(["Deposit Fee", "0%"]);

  const bodyHtml = `
    <p style="margin:0 0 14px 0;font-size:15px;line-height:22px;color:#3A352C;">${greeting}</p>
    <p style="margin:0 0 14px 0;font-size:15px;line-height:22px;color:#3A352C;">Your new <strong>${escapeEmailHtml(code)}</strong> receiving account on your Proxim <strong>${escapeEmailHtml(acctLabel)}</strong> is live and ready to receive bank transfers with <strong>0% deposit fee</strong>.</p>
    ${renderKeyValueTable(rows)}
    <p style="margin:14px 0 0 0;font-size:13.5px;line-height:20px;color:#5C5546;">Open Proxim anytime to copy or share these details, or choose in <strong>Profile</strong> whether deposits remain in ${escapeEmailHtml(code)} or auto-convert to USD.</p>
  `;
  const text = [
    name ? `Hello ${name},` : "Hello,",
    "",
    `Your new ${code} receiving account on your Proxim ${acctLabel} is active (0% deposit fee).`,
    "",
    ...rows.map(([k, v]) => `- ${k}: ${v}`),
    "",
    `Open Proxim anytime to view or share your details. Need help? Contact ${SUPPORT_EMAIL}.`,
    `X: ${PROXIM_SOCIAL_LINKS.x} | Facebook: ${PROXIM_SOCIAL_LINKS.facebook} | Website: ${PROXIM_SOCIAL_LINKS.website}`,
  ].join("\n");

  return sendTransactionalEmail({
    to,
    subject: `Your Proxim ${code} Bank Account Is Ready`,
    html: renderProximEmailShell({
      badge: `${code} ACCOUNT`,
      badgeBg: "#E0A82E",
      badgeColor: "#002018",
      heading: `Your ${escapeEmailHtml(code)} bank account is live`,
      bodyHtml,
    }),
    text,
  });
}

const TX_ALERT_LABELS = {
  deposit_naira: { label: "Naira Bank Deposit", credit: true },
  deposit_fiat: { label: "International Bank Deposit", credit: true },
  deposit_crosschain: { label: "Crypto Deposit", credit: true },
  deposit_crypto: { label: "Crypto Deposit", credit: true },
  crypto_deposit: { label: "Crypto Deposit", credit: true },
  onramp: { label: "Naira Deposit", credit: true },
  paj_onramp: { label: "Naira Deposit", credit: true },
  p2p_receive: { label: "Money Received", credit: true },
  p2p_refund: { label: "Gift Link Refund", credit: true },
  invoice_payment: { label: "Invoice Payment Received", credit: true },
  yield_withdraw: { label: "Savings Withdrawal", credit: true },
  auto_earn_liquidate: { label: "Auto-Save Returned to Balance", credit: true },
  offramp: { label: "Bank Transfer", credit: false },
  offramp_request: { label: "Bank Transfer", credit: false },
  withdraw_naira: { label: "Naira Bank Transfer", credit: false },
  payout: { label: "Bank Payout", credit: false },
  payout_global: { label: "International Transfer", credit: false },
  global_payout: { label: "International Transfer", credit: false },
  card_load: { label: "Virtual USD Card Funding", credit: false },
  card_spend: { label: "Virtual USD Card Spend", credit: false },
  send_usdc: { label: "USD Transfer Sent", credit: false },
  send_eurc: { label: "EUR Transfer Sent", credit: false },
  transfer: { label: "Transfer Sent", credit: false },
  p2p_send: { label: "Proxim Transfer Sent", credit: false },
  p2p_escrow: { label: "Gift Link Sent", credit: false },
  scheduled_transfer: { label: "Scheduled Transfer", credit: false },
  yield_deposit: { label: "Dollar Savings Deposit", credit: false },
  savings_deposit: { label: "Dollar Savings Deposit", credit: false },
  auto_earn_deposit: { label: "Auto-Save Deposit", credit: false },
  swap: { label: "FX Currency Swap", credit: false },
  swap_usdc_eurc: { label: "FX Swap (USD → EUR)", credit: false },
  swap_eurc_usdc: { label: "FX Swap (EUR → USD)", credit: false },
  stock_buy: { label: "US Stock Purchase", credit: false },
  stock_sell: { label: "US Stock Sale", credit: true },
  monthly_maintenance_fee: { label: "Monthly Account & Alert Fee", credit: false },
};

function _formatAlertAmount({ sourceCurrency, sourceAmount, amountUsd }) {
  const cur = sourceCurrency ? String(sourceCurrency).toUpperCase() : null;
  const srcAmt = Number(sourceAmount);
  if (cur && Number.isFinite(srcAmt) && srcAmt > 0) {
    if (cur === "NGN") return `₦${Math.round(srcAmt).toLocaleString("en-NG")}`;
    const syms = { USD: "$", GBP: "£", EUR: "€", CAD: "CA$", AED: "AED ", GHS: "GH₵", KES: "KSh ", TZS: "TSh ", MXN: "MX$" };
    const sym = syms[cur] || `${cur} `;
    return `${sym}${srcAmt.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  const usd = Number(amountUsd || 0);
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
}

async function sendTransactionAlertEmail({
  to,
  name,
  type,
  amountUsd = 0,
  sourceCurrency = null,
  sourceAmount = null,
  accountType = "personal",
  status = "confirmed",
  narration = null,
  txHash = null,
  timestamp = null,
  counterpartyName = null,
  counterpartyBank = null,
  counterpartyAccount = null,
} = {}) {
  const rawType = String(type || "transaction").toLowerCase();
  const meta = TX_ALERT_LABELS[rawType] || (rawType.startsWith("bill_")
    ? { label: `Bill Payment (${rawType.slice(5).toUpperCase()})`, credit: false }
    : { label: rawType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), credit: false });

  const safe = (v) => String(v || "").replace(/[<>&]/g, "");
  const sign = meta.credit ? "+" : "-";
  const amtText = _formatAlertAmount({ sourceCurrency, sourceAmount, amountUsd });
  const badgeBg = meta.credit ? "#007840" : "#002018";
  const badgeColor = meta.credit ? "#FFFFFF" : "#E0A82E";
  const badgeLabel = meta.credit ? "CREDIT ALERT" : "DEBIT ALERT";
  const acctLabel = accountType === "business" ? "Business Account" : "Personal Account";
  const whenStr = new Date(timestamp || Date.now()).toUTCString();
  const greeting = name ? `Hello ${safe(name)},` : "Hello,";

  const rawStatus = String(status || "confirmed").trim().toLowerCase();
  const displayStatus = ["confirmed", "completed", "submitted", "success", "successful", "paid", "settled"].includes(rawStatus)
    ? "SUCCESSFUL"
    : rawStatus.toUpperCase();

  const rows = [
    ["Transaction Type", meta.label],
    ["Amount", `${sign}${amtText}`],
    ["Account", acctLabel],
  ];
  const cpNameClean = counterpartyName ? String(counterpartyName).trim() : "";
  const cpBankClean = counterpartyBank ? String(counterpartyBank).trim() : "";
  const cpAcctClean = counterpartyAccount ? String(counterpartyAccount).trim() : "";
  if (cpNameClean) {
    rows.push([meta.credit ? "From" : "Recipient", cpNameClean.slice(0, 100)]);
  }
  const cpBankAcct = [cpBankClean, cpAcctClean].filter(Boolean).join(" · ");
  if (cpBankAcct) {
    rows.push([meta.credit ? "Sender Bank / Account" : "Destination Bank / Account", cpBankAcct.slice(0, 120)]);
  }
  rows.push(
    ["Status", displayStatus],
    ["Date (UTC)", whenStr]
  );
  if (narration) rows.push(["Description", String(narration).slice(0, 120)]);
  if (txHash) rows.push(["Reference", String(txHash).slice(0, 48)]);

  const textRows = rows.map(([k, v]) => `- ${k}: ${v}`).join("\n");
  const subject = `Proxim ${meta.credit ? "Credit" : "Debit"} Alert: ${sign}${amtText} — ${meta.label}`;
  const bodyHtml = `
    <p style="margin:0 0 14px 0;font-size:15px;line-height:22px;color:#3A352C;">${greeting} Here are the details of your recent ${escapeEmailHtml(acctLabel.toLowerCase())} transaction:</p>
    ${renderKeyValueTable(rows)}
    <p style="margin:14px 0 0 0;font-size:13px;line-height:20px;color:#776F5F;">If you did not authorize this transaction, freeze your account immediately in Proxim or contact <a href="mailto:${SUPPORT_EMAIL}" style="color:#002018;font-weight:700;text-decoration:none;">${SUPPORT_EMAIL}</a>.</p>
  `;
  const html = renderProximEmailShell({
    badge: badgeLabel,
    badgeBg,
    badgeColor,
    heading: escapeEmailHtml(`${sign}${amtText}`),
    subheading: escapeEmailHtml(meta.label),
    bodyHtml,
    footerNote: `Automated Proxim Transaction Alert &middot; Support: <a href="mailto:${SUPPORT_EMAIL}" style="color:#002018;font-weight:700;text-decoration:none;">${SUPPORT_EMAIL}</a>`,
    footerBrand: "Proxim &middot; Global Banking &amp; Payments",
    showSocials: true,
  });
  const text = [
    name ? `Hello ${name},` : "Hello,",
    "",
    `${badgeLabel}: ${sign}${amtText} (${meta.label})`,
    "",
    textRows,
    "",
    `If you did not authorize this transaction, freeze your account in Proxim or contact ${SUPPORT_EMAIL} immediately.`,
    "",
    `X: ${PROXIM_SOCIAL_LINKS.x}`,
    `Facebook: ${PROXIM_SOCIAL_LINKS.facebook}`,
    `Website: ${PROXIM_SOCIAL_LINKS.website}`,
  ].join("\n");

  return sendTransactionalEmail({ to, subject, html, text });
}

const PAJ_TX_TYPES = new Set([
  "deposit_naira",
  "onramp",
  "paj_onramp",
  "offramp",
  "offramp_request",
  "payout",
]);

/**
 * Send a transaction alert email:
 * - For ALL Paj Naira transactions (`deposit_naira`, `onramp`, `paj_onramp`, `offramp`, `offramp_request`, `payout`):
 *   fires whenever the user has ANY email on file in the DB (from signup, KYC/KYB, or KYC draft).
 * - For ALL other transactions: fires for verified (approved KYC/KYB) users.
 * Idempotent per (telegramId, txHash || txId) so status updates never duplicate alerts.
 */
async function dispatchVerifiedTransactionEmail({
  telegramId,
  txId = null,
  type,
  amountMicro = "0",
  decimals = 18,
  status = "confirmed",
  txHash = null,
  accountType = "personal",
  narration = null,
  sourceCurrency = null,
  sourceAmount = null,
  counterpartyName = null,
  counterpartyBank = null,
  counterpartyAccount = null,
} = {}) {
  try {
    if (!telegramId) return { skipped: true, reason: "no_user" };
    const cleanStatus = String(status || "").toLowerCase();
    if (!["confirmed", "completed", "submitted", "success"].includes(cleanStatus)) {
      return { skipped: true, reason: `status_${cleanStatus}` };
    }
    const rawType = String(type || "").toLowerCase();
    const isPajTx = PAJ_TX_TYPES.has(rawType);
    const db = require("./db");

    const to = resolveUserEmail(telegramId);
    if (!to) return { skipped: true, reason: "no_email" };

    if (!isPajTx && typeof db.isUserAnyKycApproved === "function" && !db.isUserAnyKycApproved(telegramId)) {
      return { skipped: true, reason: "user_not_verified" };
    }

    const dedupRef = txHash ? String(txHash).trim() : (txId ? `txid_${txId}` : null);
    if (dedupRef) {
      const idempotency = require("./idempotency");
      const claimKey = `tx_alert_email:${telegramId}:${dedupRef}`;
      if (!idempotency.tryClaimWebhookEvent(claimKey, "tx_alert_email", dedupRef)) {
        return { skipped: true, duplicate: true };
      }
    }

    // Outbound Naira transfers MUST always display in Naira (₦), never USD!
    const isOutboundNgnTx = ["offramp", "offramp_request", "payout", "withdraw_naira"].includes(rawType);
    let finalSourceCur = sourceCurrency;
    let finalSourceAmt = sourceAmount;
    const dec = Number(decimals ?? 18);
    const amountUsd = Number(String(amountMicro || "0")) / 10 ** dec;

    if ((isPajTx || isOutboundNgnTx) && (!finalSourceAmt || Number(finalSourceAmt) <= 0) && txHash && db.db) {
      const found = _lookupFiatAmountFromOrders(db, telegramId, rawType, txHash, amountUsd);
      if (found) {
        finalSourceCur = found.currency;
        finalSourceAmt = found.amount;
      }
    }

    // Final guarantee: outbound Naira transactions ALWAYS render in Naira (₦), never USD
    if (isOutboundNgnTx && (!finalSourceAmt || Number(finalSourceAmt) <= 0) && amountUsd > 0) {
      let rateNgn = 1500;
      try {
        const live = await require("./app_api/features").getLiveUsdNgnRate();
        if (live && Number(live) > 100) rateNgn = Number(live);
      } catch (_) { }
      finalSourceCur = "NGN";
      finalSourceAmt = Math.round(amountUsd * rateNgn);
    }

    let finalCpName = counterpartyName;
    let finalCpBank = counterpartyBank;
    let finalCpAccount = counterpartyAccount;
    if ((!finalCpName || !finalCpBank || !finalCpAccount) && txHash && db.db) {
      const cp = _lookupCounterpartyFromOrders(db, telegramId, rawType, txHash);
      if (cp) {
        if (!finalCpName) finalCpName = cp.name;
        if (!finalCpBank) finalCpBank = cp.bank;
        if (!finalCpAccount) finalCpAccount = cp.account;
      }
    }

    const user = db.getUser?.(telegramId);
    const name = user?.sender_name || user?.username || null;

    return await sendTransactionAlertEmail({
      to,
      name,
      type,
      amountUsd: Number.isFinite(amountUsd) ? amountUsd : 0,
      sourceCurrency: finalSourceCur,
      sourceAmount: finalSourceAmt,
      accountType,
      status: cleanStatus,
      narration,
      txHash,
      counterpartyName: finalCpName,
      counterpartyBank: finalCpBank,
      counterpartyAccount: finalCpAccount,
    });
  } catch (err) {
    console.warn("[email:tx_alert] dispatch note:", err?.message || err);
    return { sent: false, reason: "dispatch_error", error: err?.message };
  }
}

module.exports = {
  resolveUserEmail,
  getEmailConfigDiagnostics,
  sendTransactionalEmail,
  sendKycStatusEmail,
  sendWelcomeEmail,
  sendGlobalAccountCreatedEmail,
  sendTransactionAlertEmail,
  dispatchVerifiedTransactionEmail,
};
