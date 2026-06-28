// src/invoice_generator.js
// Generates a clean black & white invoice PNG from structured invoice data.
// Uses sharp (SVG → PNG) — no canvas or native deps needed.
//
// npm install sharp   (already in package-lock)

const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const OUTPUT_DIR = path.join(__dirname, "../data/invoices");

/**
 * Escape special XML characters so SVG doesn't break.
 */
function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Format a number as USDC string.
 */
function fmt(n) {
  return Number(n).toFixed(2);
}

/**
 * Wrap long text into lines of max `maxChars` characters.
 */
function wrapText(text, maxChars = 55) {
  const words = String(text).split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > maxChars) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + " " + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

/**
 * Generate an invoice PNG and save it to disk.
 *
 * @param {object} invoice - structured invoice data
 * @param {string} invoice.invoiceNumber
 * @param {string} invoice.clientName
 * @param {string} invoice.clientEmail
 * @param {Array}  invoice.items          - [{ description, quantity, unitPrice }]
 * @param {string} invoice.dueDate        - YYYY-MM-DD or null
 * @param {string} invoice.notes
 * @param {string} invoice.businessName   - owner's business / display name
 * @param {string} invoice.walletAddress  - Arc USDC address to pay
 * @param {string} invoice.issueDate      - YYYY-MM-DD
 *
 * @returns {string} absolute path to the generated PNG file
 */
async function generateInvoicePNG(invoice) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const W = 794;   // A4 width at 96dpi
  const MARGIN = 56;
  const COL1 = MARGIN;
  const COL2 = 420;
  const COL3 = 580;
  const COL4 = W - MARGIN;

  // Calculate total
  const total = invoice.items.reduce((sum, item) => {
    return sum + (Number(item.quantity || 1) * Number(item.unitPrice || 0));
  }, 0);

  // Build item rows
  let itemY = 430;
  const itemRowHeight = 36;
  let itemRows = "";
  let altRow = false;

  for (const item of invoice.items) {
    const qty = Number(item.quantity || 1);
    const price = Number(item.unitPrice || 0);
    const subtotal = qty * price;
    const descLines = wrapText(esc(item.description), 42);
    const rowH = Math.max(itemRowHeight, descLines.length * 20 + 16);

    if (altRow) {
      itemRows += `<rect x="${MARGIN}" y="${itemY}" width="${W - MARGIN * 2}" height="${rowH}" fill="#f9f9f9"/>`;
    }

    // Description (possibly multi-line)
    descLines.forEach((line, i) => {
      itemRows += `<text x="${COL1 + 8}" y="${itemY + 20 + i * 20}" font-family="DejaVu Sans" font-size="13" fill="#222">${line}</text>`;
    });

    itemRows += `<text x="${COL2}" y="${itemY + 20}" font-family="DejaVu Sans" font-size="13" fill="#222" text-anchor="middle">${qty}</text>`;
    itemRows += `<text x="${COL3}" y="${itemY + 20}" font-family="DejaVu Sans" font-size="13" fill="#222" text-anchor="middle">${fmt(price)}</text>`;
    itemRows += `<text x="${COL4 - 8}" y="${itemY + 20}" font-family="DejaVu Sans" font-size="13" fill="#222" text-anchor="end">${fmt(subtotal)}</text>`;

    itemY += rowH;
    altRow = !altRow;
  }

  // Notes lines
  let notesSVG = "";
  if (invoice.notes) {
    const noteLines = wrapText(esc(invoice.notes), 80);
    noteLines.forEach((line, i) => {
      notesSVG += `<text x="${MARGIN}" y="${itemY + 90 + i * 18}" font-family="DejaVu Sans" font-size="12" fill="#555">${line}</text>`;
    });
  }

  // Wallet address — split into two lines if long
  const addr = esc(invoice.walletAddress || "");
  const addrMid = Math.floor(addr.length / 2);
  const addrLine1 = addr.slice(0, addrMid);
  const addrLine2 = addr.slice(addrMid);

  const totalSectionY = itemY + 20;
  const footerY = totalSectionY + 180;
  const H = footerY + 120;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="white"/>

  <!-- Top accent bar -->
  <rect x="0" y="0" width="${W}" height="8" fill="#111"/>

  <!-- INVOICE heading -->
  <text x="${MARGIN}" y="70" font-family="DejaVu Sans" font-size="42" font-weight="bold" fill="#111">INVOICE</text>

  <!-- Invoice number + dates -->
  <text x="${W - MARGIN}" y="50" font-family="DejaVu Sans" font-size="13" fill="#444" text-anchor="end">#${esc(invoice.invoiceNumber)}</text>
  <text x="${W - MARGIN}" y="72" font-family="DejaVu Sans" font-size="13" fill="#444" text-anchor="end">Issued: ${esc(invoice.issueDate)}</text>
  ${invoice.dueDate ? `<text x="${W - MARGIN}" y="94" font-family="DejaVu Sans" font-size="13" fill="#c0392b" font-weight="bold" text-anchor="end">Due: ${esc(invoice.dueDate)}</text>` : ""}

  <!-- Divider -->
  <line x1="${MARGIN}" y1="100" x2="${W - MARGIN}" y2="100" stroke="#111" stroke-width="2"/>

  <!-- FROM section -->
  <text x="${MARGIN}" y="135" font-family="DejaVu Sans" font-size="11" font-weight="bold" fill="#888" letter-spacing="2">FROM</text>
  <text x="${MARGIN}" y="158" font-family="DejaVu Sans" font-size="15" font-weight="bold" fill="#111">${esc(invoice.businessName)}</text>
  <text x="${MARGIN}" y="178" font-family="DejaVu Sans" font-size="12" fill="#555">Arc Testnet · USDC</text>

  <!-- TO section -->
  <text x="${W / 2}" y="135" font-family="DejaVu Sans" font-size="11" font-weight="bold" fill="#888" letter-spacing="2">BILL TO</text>
  <text x="${W / 2}" y="158" font-family="DejaVu Sans" font-size="15" font-weight="bold" fill="#111">${esc(invoice.clientName)}</text>
  ${invoice.clientEmail ? `<text x="${W / 2}" y="178" font-family="DejaVu Sans" font-size="12" fill="#555">${esc(invoice.clientEmail)}</text>` : ""}

  <!-- Divider -->
  <line x1="${MARGIN}" y1="210" x2="${W - MARGIN}" y2="210" stroke="#ddd" stroke-width="1"/>

  <!-- Table header -->
  <rect x="${MARGIN}" y="220" width="${W - MARGIN * 2}" height="32" fill="#111"/>
  <text x="${COL1 + 8}" y="241" font-family="DejaVu Sans" font-size="12" font-weight="bold" fill="white">DESCRIPTION</text>
  <text x="${COL2}" y="241" font-family="DejaVu Sans" font-size="12" font-weight="bold" fill="white" text-anchor="middle">QTY</text>
  <text x="${COL3}" y="241" font-family="DejaVu Sans" font-size="12" font-weight="bold" fill="white" text-anchor="middle">UNIT PRICE</text>
  <text x="${COL4 - 8}" y="241" font-family="DejaVu Sans" font-size="12" font-weight="bold" fill="white" text-anchor="end">AMOUNT (USDC)</text>

  <!-- Column separators in header -->
  <line x1="${COL2 - 40}" y1="220" x2="${COL2 - 40}" y2="252" stroke="#444" stroke-width="1"/>
  <line x1="${COL3 - 40}" y1="220" x2="${COL3 - 40}" y2="252" stroke="#444" stroke-width="1"/>
  <line x1="${COL4 - 100}" y1="220" x2="${COL4 - 100}" y2="252" stroke="#444" stroke-width="1"/>

  <!-- Table bottom border (header) -->
  <line x1="${MARGIN}" y1="252" x2="${W - MARGIN}" y2="252" stroke="#ddd" stroke-width="1"/>

  <!-- Item rows -->
  ${itemRows}

  <!-- Table bottom border -->
  <line x1="${MARGIN}" y1="${itemY}" x2="${W - MARGIN}" y2="${itemY}" stroke="#ddd" stroke-width="1"/>

  <!-- Total box -->
  <rect x="${COL3 - 40}" y="${totalSectionY + 10}" width="${COL4 - COL3 + 48}" height="44" fill="#111" rx="4"/>
  <text x="${COL3 - 20}" y="${totalSectionY + 28}" font-family="DejaVu Sans" font-size="11" font-weight="bold" fill="white">TOTAL DUE</text>
  <text x="${COL4 - 8}" y="${totalSectionY + 45}" font-family="DejaVu Sans" font-size="16" font-weight="bold" fill="white" text-anchor="end">${fmt(total)} USDC</text>

  <!-- Notes -->
  ${invoice.notes ? `
  <text x="${MARGIN}" y="${totalSectionY + 75}" font-family="DejaVu Sans" font-size="11" font-weight="bold" fill="#888" letter-spacing="1">NOTES</text>
  ${notesSVG}` : ""}

  <!-- Payment instructions box -->
  <rect x="${MARGIN}" y="${footerY - 10}" width="${W - MARGIN * 2}" height="88" fill="#f4f4f4" rx="4"/>
  <text x="${MARGIN + 14}" y="${footerY + 14}" font-family="DejaVu Sans" font-size="11" font-weight="bold" fill="#111" letter-spacing="1">PAYMENT INSTRUCTIONS</text>
  <text x="${MARGIN + 14}" y="${footerY + 34}" font-family="DejaVu Sans" font-size="12" fill="#444">Send ${fmt(total)} USDC on Arc Testnet to:</text>
  <text x="${MARGIN + 14}" y="${footerY + 54}" font-family="DejaVu Sans Mono" font-size="11" fill="#111" font-weight="bold">${addrLine1}</text>
  <text x="${MARGIN + 14}" y="${footerY + 70}" font-family="DejaVu Sans Mono" font-size="11" fill="#111" font-weight="bold">${addrLine2}</text>

  <!-- Bottom border -->
  <rect x="0" y="${H - 6}" width="${W}" height="6" fill="#111"/>

</svg>`;

  const filename = `invoice_${invoice.invoiceNumber}_${Date.now()}.png`;
  const outPath = path.join(OUTPUT_DIR, filename);

  await sharp(Buffer.from(svg)).png({ quality: 100 }).toFile(outPath);

  return outPath;
}

module.exports = { generateInvoicePNG };