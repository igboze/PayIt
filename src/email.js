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
    } catch (_) { }
  }
  for (const c of candidates) {
    const clean = String(c || "").trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) return clean;
  }
  return null;
}

function getEmailConfigDiagnostics() {
  const smtpUser = (process.env.SMTP_USER || "").trim();
  const smtpPass = (process.env.SMTP_PASS || "").trim();
  const smtpHost = (process.env.SMTP_HOST || "mail.privateemail.com").trim();
  const smtpPort = Number(process.env.SMTP_PORT || 465);
  const smtpFrom = (process.env.SMTP_FROM_EMAIL || (smtpUser ? `Proxim <${smtpUser}>` : "")).trim();
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
      const rawFrom = (process.env.RESEND_FROM_EMAIL || "Proxim <igboze@proximfi.xyz>").trim();
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
      const from = (process.env.POSTMARK_FROM_EMAIL || "igboze@proximfi.xyz").trim().replace(/^["']+|["']+$/g, "").trim();
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
    const rawFrom = (process.env.SMTP_FROM_EMAIL || `Proxim <${smtpUser}>`).trim();
    const primaryFrom = rawFrom.replace(/^["']+|["']+$/g, "").trim();
    const fallbackFrom = `Proxim <${smtpUser}>`;

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

async function sendKycStatusEmail({ to, name, status, accountType = "personal" }) {
  const isBiz = accountType === "business";
  const label = isBiz ? "Business Account" : "Personal Account";

  if (status === "approved") {
    return sendTransactionalEmail({
      to,
      subject: `🎉 Your Proxim ${label} Is Now VERIFIED!`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #111;">
          <h2 style="color: #0052FF; margin-bottom: 8px;">Your Proxim Account Is VERIFIED!</h2>
          <p style="font-size: 16px; line-height: 1.5; color: #333;">
            Hello ${name || "there"},
          </p>
          <p style="font-size: 16px; line-height: 1.5; color: #333;">
            Great news! Your <b>${label}</b> is now <b>VERIFIED</b>. Your global accounts and virtual cards are now active.
          </p>
          <div style="background-color: #F4F6F8; border-radius: 8px; padding: 16px; margin: 20px 0;">
            <p style="margin: 0 0 8px 0; font-weight: 600;">What's unlocked on your Proxim account:</p>
            <ul style="margin: 0; padding-left: 20px; line-height: 1.6; color: #444;">
              <li>🏦 <b>Named Global Accounts:</b> USD, GBP, EUR, NGN, CAD, AED, KES, GHS, TZS</li>
              <li>💳 <b>Virtual USD Cards:</b> Pay for subscriptions, AWS, Apple, Google, and online shopping</li>
              <li>✈️ <b>Global Transfers:</b> Send directly to bank accounts and mobile money wallets across 27 currencies</li>
            </ul>
          </div>
          <p style="font-size: 14px; color: #666; margin-top: 24px;">
            Open your Proxim Mobile App or Telegram bot anytime to view your account coordinates and start transacting.
          </p>
          <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;" />
          <p style="font-size: 12px; color: #999;">
            Proxim Platform · Regulated Global Banking Infrastructure
          </p>
        </div>
      `,
    });
  } else if (status === "pending") {
    return sendTransactionalEmail({
      to,
      subject: `Verification Received — Your Proxim ${label} Is Under Review`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #111;">
          <h2 style="color: #002018; margin-bottom: 8px;">We Received Your Verification</h2>
          <p style="font-size: 16px; line-height: 1.5; color: #333;">
            Hello ${name || "there"},
          </p>
          <p style="font-size: 16px; line-height: 1.5; color: #333;">
            Thank you for submitting your ${isBiz ? "Business Verification (KYB)" : "Identity Verification (KYC)"} for your <b>${label}</b>. Our compliance team is reviewing your documents now.
          </p>
          <p style="font-size: 14px; color: #555; line-height: 1.5;">
            We'll email you and notify you in the Proxim app and Telegram bot as soon as your Global Accounts (USD, GBP, EUR, NGN, CAD, AED, GHS, KES, TZS) and Virtual USD Cards are unlocked.
          </p>
          <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;" />
          <p style="font-size: 12px; color: #999;">
            Proxim Platform · Regulated Global Banking Infrastructure
          </p>
        </div>
      `,
    });
  } else if (status === "failed" || status === "rejected" || status === "action_required") {
    return sendTransactionalEmail({
      to,
      subject: `Action Required: Proxim Verification Update`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #111;">
          <h2 style="color: #E11D48; margin-bottom: 8px;">Verification Update Needed</h2>
          <p style="font-size: 16px; line-height: 1.5; color: #333;">
            Hello ${name || "there"},
          </p>
          <p style="font-size: 16px; line-height: 1.5; color: #333;">
            We reviewed your verification submission for your <b>${label}</b> and additional information or a clearer document is required to complete verification.
          </p>
          <p style="font-size: 16px; line-height: 1.5; color: #333;">
            Please open the Proxim app or bot to review your documents and re-submit. Your regular Proxim wallet and local transfers remain 100% active.
          </p>
          <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;" />
          <p style="font-size: 12px; color: #999;">
            Proxim Platform · Support Team
          </p>
        </div>
      `,
    });
  }
}

async function sendWelcomeEmail({ to, name } = {}) {
  const greeting = name ? `Hello ${String(name).replace(/[<>&]/g, "")},` : "Welcome to Proxim,";
  const subject = "Welcome to Proxim — Your Global Dollar & Naira Account Is Ready";
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background-color: #F5F1E8; color: #13110C;">
      <div style="background-color: #FFFFFF; border: 1px solid #DCD3C1; border-radius: 18px; padding: 28px;">
        <div style="display: inline-block; background-color: #002018; color: #E0A82E; font-size: 11px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; padding: 5px 12px; border-radius: 999px; margin-bottom: 14px;">
          Welcome to Proxim
        </div>
        <h2 style="color: #002018; margin: 0 0 10px 0; font-size: 22px;">Your passkey &amp; self-custodial wallet are live!</h2>
        <p style="font-size: 15px; line-height: 1.6; color: #3A352C; margin: 0 0 14px 0;">
          ${greeting}
        </p>
        <p style="font-size: 15px; line-height: 1.6; color: #3A352C; margin: 0 0 18px 0;">
          Thanks for joining <b>Proxim</b>. Your account is secured with your device passkey and 4-digit transaction PIN. Here is a quick look at what you can do right from the app:
        </p>
        <div style="background-color: #FAF7F0; border: 1px solid #E6DEC9; border-radius: 14px; padding: 18px; margin: 18px 0;">
          <p style="margin: 0 0 10px 0; font-weight: 700; color: #002018; font-size: 14px;">What you can do on Proxim:</p>
          <ul style="margin: 0; padding-left: 20px; line-height: 1.7; color: #3A352C; font-size: 14px;">
            <li><b>💰 Fund Instantly:</b> Add money via Nigerian bank transfer (NGN), card, or crypto deposits across multiple chains.</li>
            <li><b>💸 Send Locally &amp; Globally:</b> Pay any Nigerian bank account in seconds, send free to Proxim <code>@usernames</code> or gift links, and transfer internationally across 27+ currencies.</li>
            <li><b>🏦 Global Bank Accounts &amp; Virtual USD Cards:</b> Complete quick ID verification in <b>Profile → Verify ID</b> to unlock named USD, GBP, EUR, CAD, AED, GHS, KES, and TZS accounts plus Virtual USD Cards for online spending.</li>
            <li><b>📈 Dollar Savings, FX Swap &amp; Bills:</b> Earn yield on idle dollars with Auto-Earn, swap USDC ↔ EURC, and pay airtime, data, electricity, and cable TV bills.</li>
            <li><b>💼 Business Mode:</b> Create a separate Business Account for client invoices, payment links, expense tracking, and multi-currency payroll.</li>
          </ul>
        </div>
        <p style="font-size: 14px; line-height: 1.6; color: #5C5546; margin: 0 0 16px 0;">
          <b>Quick tip:</b> Head to <b>Profile</b> in the app to claim your personal <code>@username</code> so friends and clients can pay you for free.
        </p>
        <p style="font-size: 13px; line-height: 1.5; color: #776F5F; margin: 0;">
          Need help anytime? Reply to this email, contact <a href="mailto:igboze@proximfi.xyz" style="color: #002018; font-weight: 600;">igboze@proximfi.xyz</a>, or chat with us on Telegram at <a href="https://t.me/payeetbot" style="color: #002018; font-weight: 600;">https://t.me/payeetbot</a>.
        </p>
        <hr style="border: none; border-top: 1px solid #E6DEC9; margin: 22px 0;" />
        <p style="font-size: 12px; color: #8A8170; margin: 0;">
          Proxim Platform · Self-Custodial Global Banking &amp; Payments
        </p>
      </div>
    </div>
  `;
  const text = [
    greeting,
    "",
    "Welcome to Proxim! Your passkey and self-custodial wallet are ready.",
    "",
    "Here is what you can do on the app:",
    "- Fund Instantly: Deposit via Nigerian bank transfer (NGN), card, or crypto.",
    "- Send Locally & Globally: Pay Nigerian banks in seconds, send free to @usernames or gift links, and send across 27+ currencies.",
    "- Global Bank Accounts & Virtual USD Cards: Verify your ID in Profile -> Verify ID to unlock named USD, GBP, EUR, CAD, AED, GHS, KES, and TZS accounts and Virtual USD Cards.",
    "- Dollar Savings, FX Swap & Bills: Earn yield with Auto-Earn, swap USDC <-> EURC, and pay airtime, data, electricity, and cable bills.",
    "- Business Mode: Create a dedicated Business Account for invoices, payment links, expenses, and global payroll.",
    "",
    "Quick tip: Visit Profile in the app to claim your @username so people can pay you for free.",
    "Need help? Email igboze@proximfi.xyz or reach us on Telegram at https://t.me/payeetbot.",
  ].join("\n");

  return sendTransactionalEmail({ to, subject, html, text });
}

async function sendGlobalAccountCreatedEmail({ to, name, currency, accountType = "personal", detail = {} } = {}) {
  const code = String(currency || detail?.currency || "USD").toUpperCase();
  const isBiz = accountType === "business";
  const acctLabel = isBiz ? "Business Account" : "Personal Account";
  const safe = (v) => String(v || "").replace(/[<>&]/g, "");
  const greeting = name ? `Hello ${safe(name)},` : "Hello,";

  const rows = [];
  const benName = detail?.beneficiary_name || name || acctLabel;
  rows.push(["Account Name", benName]);
  if (detail?.bank_name) rows.push(["Bank Name", detail.bank_name]);
  if (detail?.account_number) rows.push(["Account Number", detail.account_number]);
  if (detail?.iban) rows.push(["IBAN", detail.iban]);
  if (detail?.routing_number) rows.push(["Routing Number", detail.routing_number]);
  if (detail?.sort_code) rows.push(["Sort Code", detail.sort_code]);
  if (detail?.swift_code) rows.push(["SWIFT / BIC", detail.swift_code]);

  const htmlRows = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 0;color:#5C5546;font-size:14px;">${safe(k)}</td>` +
        `<td style="padding:6px 0;color:#002018;font-weight:700;font-size:14px;text-align:right;font-family:monospace;">${safe(v)}</td></tr>`
    )
    .join("");
  const textRows = rows.map(([k, v]) => `- ${k}: ${v}`).join("\n");

  const subject = `Your Proxim ${code} Bank Account Is Ready`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background-color: #F5F1E8; color: #13110C;">
      <div style="background-color: #FFFFFF; border: 1px solid #DCD3C1; border-radius: 18px; padding: 28px;">
        <div style="display: inline-block; background-color: #002018; color: #E0A82E; font-size: 11px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; padding: 5px 12px; border-radius: 999px; margin-bottom: 14px;">
          ${safe(code)} Global Account Ready
        </div>
        <h2 style="color: #002018; margin: 0 0 10px 0; font-size: 21px;">Your named ${safe(code)} receiving account is live!</h2>
        <p style="font-size: 15px; line-height: 1.6; color: #3A352C; margin: 0 0 14px 0;">${greeting}</p>
        <p style="font-size: 15px; line-height: 1.6; color: #3A352C; margin: 0 0 16px 0;">
          Your new <b>${safe(code)}</b> bank account on your Proxim <b>${safe(acctLabel)}</b> is active and ready to receive payments with <b>0% deposit fee</b>.
        </p>
        <div style="background-color: #FAF7F0; border: 1px solid #E6DEC9; border-radius: 14px; padding: 16px 18px; margin: 16px 0;">
          <table style="width:100%;border-collapse:collapse;">${htmlRows}</table>
        </div>
        <p style="font-size: 13.5px; line-height: 1.6; color: #5C5546; margin: 0 0 16px 0;">
          Open Proxim anytime to copy or share your details, or choose in <b>Profile</b> whether incoming deposits stay in ${safe(code)} or auto-convert to USD.
        </p>
        <hr style="border: none; border-top: 1px solid #E6DEC9; margin: 20px 0;" />
        <p style="font-size: 12px; color: #8A8170; margin: 0;">
          Proxim Platform · Regulated Global Banking Infrastructure · <a href="mailto:igboze@proximfi.xyz" style="color:#002018;">igboze@proximfi.xyz</a>
        </p>
      </div>
    </div>
  `;
  const text = [
    greeting,
    "",
    `Your new ${code} receiving account on your Proxim ${acctLabel} is active (0% deposit fee).`,
    "",
    textRows,
    "",
    "Open the Proxim app or Telegram bot (https://t.me/payeetbot) anytime to view or share your details.",
  ].join("\n");

  return sendTransactionalEmail({ to, subject, html, text });
}

module.exports = {
  resolveUserEmail,
  getEmailConfigDiagnostics,
  sendTransactionalEmail,
  sendKycStatusEmail,
  sendWelcomeEmail,
  sendGlobalAccountCreatedEmail,
};
