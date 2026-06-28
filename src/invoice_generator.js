// src/invoice_generator.js
// Renders a professional invoice as a PNG using sharp (SVG pipeline).
//
// Updated to:
//   - Embed business logo (base64 data URI) if available
//   - Pull full business profile (name, email, phone, address)
//   - Use plain language labels ("Amount Due" not "TOTAL DUE (USDC)")
//   - Show payment address with a plain label ("Send payment to:")
//   - Support EURC as well as USDC

const sharp = require("sharp");
const path  = require("path");
const os    = require("os");

function escape(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#39;");
}

/**
 * Build the invoice SVG.
 *
 * @param {object} opts
 * @param {string}   opts.invoiceNumber
 * @param {string}   opts.clientName
 * @param {string}   [opts.clientEmail]
 * @param {object[]} opts.items            — [{ description, quantity, unitPrice }]
 * @param {string}   [opts.dueDate]        — YYYY-MM-DD
 * @param {string}   [opts.notes]
 * @param {string}   opts.businessName
 * @param {string}   [opts.businessEmail]
 * @param {string}   [opts.businessPhone]
 * @param {string}   [opts.businessAddress]
 * @param {string}   [opts.logoDataUri]    — base64 PNG data URI or null
 * @param {string}   opts.walletAddress
 * @param {string}   opts.issueDate        — YYYY-MM-DD
 * @param {string}   [opts.currency]       — "USDC" | "EURC" (default USDC)
 */
function buildSvg(opts) {
  const {
    invoiceNumber,
    clientName,
    clientEmail      = null,
    items            = [],
    dueDate          = null,
    notes            = null,
    businessName,
    businessEmail    = null,
    businessPhone    = null,
    businessAddress  = null,
    logoDataUri      = null,
    walletAddress,
    issueDate,
    currency         = "USDC",
  } = opts;

  const total = items.reduce((s, i) => s + (Number(i.quantity || 1) || 1) * (parseFloat(String(i.unitPrice || '0').replace(/[^0-9.]/g, '')) || 0), 0);

  // ── Item rows ──────────────────────────────────────────────────────────────
  let y = 300;
  const rowSpacing = 32;

  const itemsSvg = items.map(item => {
    const qty       = Number(item.quantity || 1) || 1;
    const price     = parseFloat(String(item.unitPrice || '0').replace(/[^0-9.]/g, '')) || 0;
    const lineTotal = qty * price;
    const row = `
      <text x="40"  y="${y}" font-size="13" fill="#334155">${escape(item.description)}</text>
      <text x="440" y="${y}" font-size="13" fill="#334155" text-anchor="middle">${qty}</text>
      <text x="530" y="${y}" font-size="13" fill="#334155" text-anchor="end">${price.toFixed(2)}</text>
      <text x="630" y="${y}" font-size="13" fill="#0f766e" text-anchor="end" font-weight="600">${lineTotal.toFixed(2)}</text>`;
    y += rowSpacing;
    return row;
  }).join("");

  // ── Dynamic height ─────────────────────────────────────────────────────────
  const totalY   = y + 20;
  const notesY   = totalY + 60;
  const walletY  = notesY + (notes ? 55 : 20);
  const footerY  = walletY + 55;

  // ── Business info footer lines ─────────────────────────────────────────────
  const bizLines = [businessEmail, businessPhone, businessAddress].filter(Boolean);
  const bizInfoSvg = bizLines.map((line, i) =>
    `<text x="640" y="${54 + i * 16}" font-size="11" fill="#a7f3d0" text-anchor="end">${escape(line)}</text>`
  ).join("");

  // ── Logo (embedded as image element if available) ──────────────────────────
  const logoSvg = logoDataUri
    ? `<image href="${logoDataUri}" x="40" y="10" width="50" height="50" preserveAspectRatio="xMidYMid meet"/>`
    : "";

  const svgHeight = footerY + 60;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="680" height="${svgHeight}" viewBox="0 0 680 ${svgHeight}"
     xmlns="http://www.w3.org/2000/svg"
     font-family="Arial, Helvetica, sans-serif">

  <!-- Background -->
  <rect width="680" height="${svgHeight}" fill="#f8fafc" rx="12"/>

  <!-- Header stripe -->
  <rect width="680" height="90" fill="#0f766e" rx="12"/>
  <rect y="70" width="680" height="28" fill="#0f766e"/>

  <!-- Logo (if available) -->
  ${logoSvg}

  <!-- Header text -->
  <text x="${logoDataUri ? "102" : "40"}" y="36"
        font-size="22" font-weight="700" fill="#ffffff">INVOICE</text>
  <text x="${logoDataUri ? "102" : "40"}" y="56"
        font-size="12" fill="#a7f3d0">#${escape(invoiceNumber)}</text>

  <!-- Business name + contact top-right -->
  <text x="640" y="28" font-size="14" font-weight="700" fill="#ffffff" text-anchor="end">${escape(businessName)}</text>
  ${bizInfoSvg}

  <!-- Meta row -->
  <rect y="90" width="680" height="66" fill="#f0fdf4"/>
  <text x="40"  y="118" font-size="12" fill="#475569">Bill to</text>
  <text x="40"  y="140" font-size="14" font-weight="600" fill="#1e293b">${escape(clientName)}${clientEmail ? `  ·  ${escape(clientEmail)}` : ""}</text>
  <text x="500" y="118" font-size="12" fill="#475569" text-anchor="end">Date issued</text>
  <text x="640" y="118" font-size="12" fill="#1e293b"      text-anchor="end">${escape(issueDate)}</text>
  <text x="500" y="140" font-size="12" fill="#475569" text-anchor="end">Due date</text>
  <text x="640" y="140" font-size="12" fill="${dueDate ? "#dc2626" : "#94a3b8"}" text-anchor="end">
    ${escape(dueDate || "On receipt")}
  </text>

  <!-- Table header -->
  <rect y="160" width="680" height="30" fill="#0f766e" opacity="0.09"/>
  <text x="40"  y="179" font-size="12" font-weight="700" fill="#0f766e">Description</text>
  <text x="440" y="179" font-size="12" font-weight="700" fill="#0f766e" text-anchor="middle">Qty</text>
  <text x="530" y="179" font-size="12" font-weight="700" fill="#0f766e" text-anchor="end">Unit price</text>
  <text x="630" y="179" font-size="12" font-weight="700" fill="#0f766e" text-anchor="end">Amount</text>

  <!-- Divider -->
  <line x1="30" y1="196" x2="650" y2="196" stroke="#e2e8f0" stroke-width="1"/>

  <!-- Currency note -->
  <text x="640" y="215" font-size="10" fill="#94a3b8" text-anchor="end">All amounts in ${escape(currency)}</text>

  <!-- Items -->
  ${itemsSvg}

  <!-- Total block -->
  <line x1="30" y1="${totalY - 14}" x2="650" y2="${totalY - 14}" stroke="#e2e8f0" stroke-width="1"/>
  <rect x="440" y="${totalY - 4}" width="210" height="40" fill="#0f766e" rx="6"/>
  <text x="455"  y="${totalY + 18}" font-size="13" fill="#ffffff" font-weight="700">Amount Due</text>
  <text x="642"  y="${totalY + 20}" font-size="17" fill="#ffffff" font-weight="700" text-anchor="end">${total.toFixed(2)} ${escape(currency)}</text>

  ${notes ? `
  <!-- Notes -->
  <text x="40" y="${notesY}" font-size="12" fill="#64748b">Note: ${escape(notes)}</text>` : ""}

  <!-- Payment address -->
  <rect x="30" y="${walletY - 18}" width="620" height="42" fill="#f0fdf4" rx="6" stroke="#6ee7b7" stroke-width="1"/>
  <text x="40"  y="${walletY - 2}"  font-size="11" fill="#64748b">Send payment to this address:</text>
  <text x="40"  y="${walletY + 16}" font-size="10.5" fill="#0f766e" font-weight="600" font-family="monospace">${escape(walletAddress)}</text>

  <!-- Footer -->
  <line x1="30" y1="${footerY + 8}" x2="650" y2="${footerY + 8}" stroke="#e2e8f0" stroke-width="1"/>
  <text x="340" y="${footerY + 30}" font-size="11" fill="#94a3b8" text-anchor="middle">
    Generated by PayIT · Save in dollars. Spend in Naira.
  </text>

</svg>`;
}

/**
 * Generate an invoice PNG and return the file path.
 *
 * To pull business profile data automatically:
 *   const profile = getBizProfile(telegramId);
 *   generateInvoicePNG({ ..., businessName: profile.business_name, businessEmail: profile.business_email, ... })
 *
 * @param {object} data — same shape as buildSvg opts
 * @returns {Promise<string>} path to the generated PNG
 */
async function generateInvoicePNG(data) {
  const svg     = buildSvg(data);
  const outPath = path.join(
    os.tmpdir(),
    `invoice-${data.invoiceNumber}-${Date.now()}.png`
  );
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return outPath;
}

module.exports = { generateInvoicePNG };