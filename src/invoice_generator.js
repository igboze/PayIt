// src/invoice_generator.js
// Renders invoices as PNG using sharp (SVG pipeline).
//
// Font strategy: DejaVu fonts are loaded from disk by svg_render.js (resvg-js).
// Avoids sharp/librsvg missing-font tofu boxes on Railway.

const path  = require("path");
const os    = require("os");
const { FONT, FONT_MONO, getFontCss } = require("./svg_fonts");
const { renderSvgToPngFile } = require("./svg_render");

function escape(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#39;");
}

function safeNum(val) {
  return parseFloat(String(val || "0").replace(/[^0-9.]/g, "")) || 0;
}

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

  const total = items.reduce((s, i) =>
    s + (Number(i.quantity || 1) || 1) * safeNum(i.unitPrice), 0);

  // ── Item rows ──────────────────────────────────────────────────────────────
  let y = 300;
  const ROW = 32;

  const itemsSvg = items.map(item => {
    const qty       = Number(item.quantity || 1) || 1;
    const price     = safeNum(item.unitPrice);
    const lineTotal = qty * price;
    const row = `
      <text x="40"  y="${y}" font-size="13" fill="#334155" font-family="${FONT}">${escape(item.description)}</text>
      <text x="440" y="${y}" font-size="13" fill="#334155" font-family="${FONT}" text-anchor="middle">${qty}</text>
      <text x="530" y="${y}" font-size="13" fill="#334155" font-family="${FONT}" text-anchor="end">${price.toFixed(2)}</text>
      <text x="630" y="${y}" font-size="13" fill="#0f766e" font-family="${FONT}" text-anchor="end" font-weight="bold">${lineTotal.toFixed(2)}</text>`;
    y += ROW;
    return row;
  }).join("");

  // ── Heights ────────────────────────────────────────────────────────────────
  const totalY  = y + 20;
  const notesY  = totalY + 60;
  const walletY = notesY + (notes ? 55 : 20);
  const footerY = walletY + 55;
  const H       = footerY + 60;

  // ── Business contact lines top-right ──────────────────────────────────────
  const bizLines    = [businessEmail, businessPhone, businessAddress].filter(Boolean);
  const bizInfoSvg  = bizLines.map((line, i) =>
    `<text x="640" y="${54 + i * 16}" font-size="11" fill="#a7f3d0" font-family="${FONT}" text-anchor="end">${escape(line)}</text>`
  ).join("");

  // ── Logo ──────────────────────────────────────────────────────────────────
  const logoX   = 40;
  const textX   = logoDataUri ? 102 : 40;
  const logoSvg = logoDataUri
    ? `<image href="${logoDataUri}" x="${logoX}" y="10" width="50" height="50" preserveAspectRatio="xMidYMid meet"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="680" height="${H}" viewBox="0 0 680 ${H}"
     xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink">

  <defs>
    <style>
      ${getFontCss()}
    </style>
  </defs>

  <!-- Background -->
  <rect width="680" height="${H}" fill="#f8fafc" rx="12"/>

  <!-- Header -->
  <rect width="680" height="90" fill="#0f766e" rx="12"/>
  <rect y="70" width="680" height="28" fill="#0f766e"/>

  ${logoSvg}

  <text x="${textX}" y="36" font-size="22" font-weight="bold" fill="#ffffff" font-family="${FONT}">INVOICE</text>
  <text x="${textX}" y="56" font-size="12" fill="#a7f3d0" font-family="${FONT}">#${escape(invoiceNumber)}</text>
  <text x="640" y="28" font-size="14" font-weight="bold" fill="#ffffff" font-family="${FONT}" text-anchor="end">${escape(businessName)}</text>
  ${bizInfoSvg}

  <!-- Meta row -->
  <rect y="90" width="680" height="66" fill="#f0fdf4"/>
  <text x="40"  y="118" font-size="12" fill="#475569" font-family="${FONT}">Bill to</text>
  <text x="40"  y="140" font-size="14" font-weight="bold" fill="#1e293b" font-family="${FONT}">${escape(clientName)}${clientEmail ? "  ·  " + escape(clientEmail) : ""}</text>
  <text x="500" y="118" font-size="12" fill="#475569" font-family="${FONT}" text-anchor="end">Date issued</text>
  <text x="640" y="118" font-size="12" fill="#1e293b"  font-family="${FONT}" text-anchor="end">${escape(issueDate)}</text>
  <text x="500" y="140" font-size="12" fill="#475569" font-family="${FONT}" text-anchor="end">Due date</text>
  <text x="640" y="140" font-size="12" fill="${dueDate ? "#dc2626" : "#94a3b8"}" font-family="${FONT}" text-anchor="end">${escape(dueDate || "On receipt")}</text>

  <!-- Table header -->
  <rect y="160" width="680" height="30" fill="#0f766e" opacity="0.09"/>
  <text x="40"  y="179" font-size="12" font-weight="bold" fill="#0f766e" font-family="${FONT}">Description</text>
  <text x="440" y="179" font-size="12" font-weight="bold" fill="#0f766e" font-family="${FONT}" text-anchor="middle">Qty</text>
  <text x="530" y="179" font-size="12" font-weight="bold" fill="#0f766e" font-family="${FONT}" text-anchor="end">Unit price</text>
  <text x="630" y="179" font-size="12" font-weight="bold" fill="#0f766e" font-family="${FONT}" text-anchor="end">Amount</text>

  <line x1="30" y1="196" x2="650" y2="196" stroke="#e2e8f0" stroke-width="1"/>
  <text x="640" y="215" font-size="10" fill="#94a3b8" font-family="${FONT}" text-anchor="end">All amounts in ${escape(currency)}</text>

  <!-- Items -->
  ${itemsSvg}

  <!-- Total -->
  <line x1="30" y1="${totalY - 14}" x2="650" y2="${totalY - 14}" stroke="#e2e8f0" stroke-width="1"/>
  <rect x="440" y="${totalY - 4}" width="210" height="40" fill="#0f766e" rx="6"/>
  <text x="435" y="${totalY + 18}" font-size="12" font-weight="bold" fill="#ffffff" font-family="${FONT}">Due</text>
  <text x="642" y="${totalY + 20}" font-size="17" font-weight="bold" fill="#ffffff" font-family="${FONT}" text-anchor="end">${total.toFixed(2)} ${escape(currency)}</text>

  ${notes ? `
  <text x="40" y="${notesY}" font-size="12" fill="#64748b" font-family="${FONT}">Note: ${escape(notes)}</text>` : ""}

  <!-- Payment address -->
  <rect x="30" y="${walletY - 18}" width="620" height="42" fill="#f0fdf4" rx="6" stroke="#6ee7b7" stroke-width="1"/>
  <text x="40" y="${walletY - 2}"  font-size="11" fill="#64748b" font-family="${FONT}">Send payment to this address:</text>
  <text x="40" y="${walletY + 16}" font-size="10" fill="#0f766e" font-weight="bold" font-family="${FONT_MONO}">${escape(walletAddress)}</text>

  <!-- Footer -->
  <line x1="30" y1="${footerY + 8}" x2="650" y2="${footerY + 8}" stroke="#e2e8f0" stroke-width="1"/>
  <text x="340" y="${footerY + 30}" font-size="11" fill="#94a3b8" font-family="${FONT}" text-anchor="middle">Generated by PayIT · Save in dollars. Spend in Naira.</text>

</svg>`;
}

async function generateInvoicePNG(data) {
  const svg     = buildSvg(data);
  const outPath = path.join(
    os.tmpdir(),
    `invoice-${data.invoiceNumber}-${Date.now()}.png`
  );
  renderSvgToPngFile(svg, outPath);
  return outPath;
}

module.exports = { generateInvoicePNG };