// src/email.js
// Transactional email dispatch for Proxim end-users (KYC approval, receipts, security alerts).
// Uses Resend API (standard), Postmark, or SMTP if configured.
// Prevents Nuvion internal admin notifications from being the only communication channel:
// alerts are sent directly to the customer's personal email.

const axios = require("axios");

async function sendTransactionalEmail({ to, subject, html, text }) {
  if (!to || !to.includes("@")) {
    return { sent: false, reason: "invalid_recipient" };
  }

  // 1. Resend (https://resend.com)
  const resendApiKey = process.env.RESEND_API_KEY;
  if (resendApiKey) {
    try {
      const from = process.env.RESEND_FROM_EMAIL || "Proxim Global Banking <support@proxim.app>";
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
      console.warn(`[email:resend] Failed to send email to ${to}:`, err.response?.data || err.message);
    }
  }

  // 2. Postmark (https://postmarkapp.com)
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  if (postmarkToken) {
    try {
      const from = process.env.POSTMARK_FROM_EMAIL || "support@proxim.app";
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
      console.warn(`[email:postmark] Failed to send email to ${to}:`, err.response?.data || err.message);
    }
  }

  // If no email provider is configured, log for operational observability
  console.log(`[email:simulated] To: ${to} | Subject: "${subject}"`);
  return { sent: false, reason: "no_provider_configured", simulated: true };
}

async function sendKycStatusEmail({ to, name, status, accountType = "personal" }) {
  const isBiz = accountType === "business";
  const label = isBiz ? "Business Account" : "Personal Account";

  if (status === "approved") {
    return sendTransactionalEmail({
      to,
      subject: `🎉 Your Proxim Tier-1 Verification is Approved!`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #111;">
          <h2 style="color: #0052FF; margin-bottom: 8px;">Tier-1 Global Banking Approved!</h2>
          <p style="font-size: 16px; line-height: 1.5; color: #333;">
            Hello ${name || "there"},
          </p>
          <p style="font-size: 16px; line-height: 1.5; color: #333;">
            Great news! Your <b>${label}</b> has successfully completed Tier-1 verification. Your global accounts and virtual cards are now active.
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
            Proxim Platform · Regulated Global Banking & Compliance Infrastructure powered by Nuvion
          </p>
        </div>
      `,
    });
  } else if (status === "failed" || status === "rejected" || status === "action_required") {
    return sendTransactionalEmail({
      to,
      subject: `Action Required: Proxim Tier-1 Verification Update`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #111;">
          <h2 style="color: #E11D48; margin-bottom: 8px;">Verification Update Needed</h2>
          <p style="font-size: 16px; line-height: 1.5; color: #333;">
            Hello ${name || "there"},
          </p>
          <p style="font-size: 16px; line-height: 1.5; color: #333;">
            We reviewed your Tier-1 verification submission for your <b>${label}</b> and additional information or a clearer document is required to complete verification.
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

module.exports = {
  sendTransactionalEmail,
  sendKycStatusEmail,
};
