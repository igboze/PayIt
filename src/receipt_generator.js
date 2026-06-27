// src/receipt_generator.js
// Generates a clean payment receipt PNG after every successful transfer.
// Uses the same sharp/SVG pipeline as the invoice generator.
// Receipts are stored in tmp and sent to the user, not persisted long-term.

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
 * Build the receipt SVG.
 *
 * @param {object} opts
 * @param {string} opts.receiptId       — e.g. tx hash (truncated) or internal ID
 * @param {string} opts.senderName      — "Your PayIT Wallet" or business name
 * @param {string} opts.senderAddress   — 0x...
 * @param {string} opts.recipientName   — payee name or address
 * @param {string} opts.recipientAddress — 0x...
 * @param {number} opts.amountUsdc      — numeric
 * @param {string} opts.token           — "USDC" | "EURC"
 * @param {string|null} opts.nairaEquiv — "₦82,400" or null
 * @param {string} opts.type            — "Payment" | "Cash Out" | "Payroll" | "Scheduled"
 * @param {string} opts.timestamp       — ISO string
 * @param {string} opts.status          — "Confirmed" | "Pending"
 * @param {string|null} opts.txHash     — full on-chain tx hash or null
 */
function buildReceiptSvg(opts) {
  const {
    receiptId,
    senderName,
    senderAddress,
    recipientName,
    recipientAddress,
    amountUsdc,
    token        = "USDC",
    nairaEquiv   = null,
    type         = "Payment",
    timestamp,
    status       = "Confirmed",
    txHash       = null,
  } = opts;

  const statusColor  = status === "Confirmed" ? "#16a34a" : "#d97706";
  const statusBadge  = status === "Confirmed" ? "✓ Confirmed" : "⏳ Pending";
  const dateStr      = new Date(timestamp).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  const shortHash    = txHash ? `${txHash.slice(0, 10)}...${txHash.slice(-8)}` : null;
  const shortSender  = senderAddress
    ? `${senderAddress.slice(0, 8)}...${senderAddress.slice(-6)}`
    : "";
  const shortRecip   = recipientAddress
    ? `${recipientAddress.slice(0, 8)}...${recipientAddress.slice(-6)}`
    : "";

  const nairaLine = nairaEquiv
    ? `<text x="340" y="258" font-size="13" fill="#64748b" text-anchor="middle">≈ ${escape(nairaEquiv)} at today's rate</text>`
    : "";

  const hashLine = shortHash
    ? `
  <text x="40"  y="390" font-size="11" fill="#94a3b8">Transaction ID</text>
  <text x="640" y="390" font-size="10.5" fill="#0f766e" text-anchor="end" font-family="monospace">${escape(shortHash)}</text>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="680" height="460" viewBox="0 0 680 460"
     xmlns="http://www.w3.org/2000/svg"
     font-family="Arial, Helvetica, sans-serif">

  <!-- Background -->
  <rect width="680" height="460" fill="#f8fafc" rx="14"/>

  <!-- Top stripe -->
  <rect width="680" height="70" fill="#0f766e" rx="14"/>
  <rect y="50" width="680" height="28" fill="#0f766e"/>

  <!-- Header text -->
  <text x="40"  y="32" font-size="20" font-weight="700" fill="#ffffff">PayIT Receipt</text>
  <text x="40"  y="54" font-size="12" fill="#a7f3d0">${escape(type)}</text>
  <text x="640" y="36" font-size="12" fill="#6ee7b7" text-anchor="end">${escape(dateStr)}</text>
  <text x="640" y="54" font-size="11" fill="#a7f3d0" text-anchor="end">Ref: ${escape(receiptId)}</text>

  <!-- Amount block -->
  <rect x="140" y="90" width="400" height="80" fill="#ffffff" rx="10"
        filter="url(#shadow)"/>
  <defs>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="120%">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#00000015"/>
    </filter>
  </defs>
  <text x="340" y="130" font-size="13" fill="#64748b" text-anchor="middle">Amount sent</text>
  <text x="340" y="158" font-size="30" font-weight="700" fill="#0f766e" text-anchor="middle">${Number(amountUsdc).toFixed(2)} ${escape(token)}</text>
  ${nairaLine}

  <!-- Status badge -->
  <rect x="280" y="182" width="120" height="26" fill="${statusColor}20" rx="13"/>
  <text x="340" y="199" font-size="12" fill="${statusColor}" text-anchor="middle" font-weight="600">${statusBadge}</text>

  <!-- Divider -->
  <line x1="30" y1="224" x2="650" y2="224" stroke="#e2e8f0" stroke-width="1"/>

  <!-- From / To -->
  <text x="40"  y="250" font-size="12" fill="#94a3b8">From</text>
  <text x="640" y="250" font-size="13" fill="#1e293b" text-anchor="end" font-weight="600">${escape(senderName)}</text>
  <text x="640" y="267" font-size="10.5" fill="#64748b" text-anchor="end" font-family="monospace">${escape(shortSender)}</text>

  <line x1="30" y1="282" x2="650" y2="282" stroke="#f1f5f9" stroke-width="1"/>

  <text x="40"  y="306" font-size="12" fill="#94a3b8">To</text>
  <text x="640" y="306" font-size="13" fill="#1e293b" text-anchor="end" font-weight="600">${escape(recipientName)}</text>
  <text x="640" y="323" font-size="10.5" fill="#64748b" text-anchor="end" font-family="monospace">${escape(shortRecip)}</text>

  <line x1="30" y1="338" x2="650" y2="338" stroke="#f1f5f9" stroke-width="1"/>

  <!-- Type row -->
  <text x="40"  y="362" font-size="12" fill="#94a3b8">Payment type</text>
  <text x="640" y="362" font-size="13" fill="#1e293b" text-anchor="end">${escape(type)}</text>

  <line x1="30" y1="374" x2="650" y2="374" stroke="#f1f5f9" stroke-width="1"/>

  ${hashLine}

  <!-- Footer -->
  <line x1="30" y1="415" x2="650" y2="415" stroke="#e2e8f0" stroke-width="1"/>
  <text x="340" y="438" font-size="11" fill="#94a3b8" text-anchor="middle">
    Generated by PayIT · Save in dollars. Spend in Naira.
  </text>

</svg>`;
}

/**
 * Generate a receipt PNG and return the file path.
 *
 * @param {object} opts  — same shape as buildReceiptSvg
 * @returns {Promise<string>} path to the generated PNG
 */
async function generateReceiptPNG(opts) {
  const receiptId = opts.receiptId || `R-${Date.now()}`;
  const svg       = buildReceiptSvg({ ...opts, receiptId });
  const outPath   = path.join(os.tmpdir(), `receipt-${receiptId}-${Date.now()}.png`);
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return outPath;
}

module.exports = { generateReceiptPNG };
