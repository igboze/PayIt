// src/card_image_generator.js
// Generates Proxim Virtual & Disposable USD Debit Card PNGs using the EXACT official
// Proxim Card artwork template (`src/assets/proxim_card_template.png`, 1024x682) with
// zero redesign of the Proxim logo, chip, watermark, or card shell — overlaying only
// the dynamic card number, expiry date, cardholder name, and (on 60s PIN reveal) CVV.
//
// SECURITY INVARIANT:
// Unmasked PAN/CVV card renders ALWAYS use `generateProximCardBuffer()` in memory (Buffer)
// and NEVER write full PAN or CVV to disk or SQLite.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { getFontCss, FONT, FONT_MONO } = require("./svg_fonts");
const { renderSvgToPngBuffer, renderSvgToPngFile } = require("./svg_render");

let CARD_TEMPLATE_DATA_URI = "";
try {
  const tplPath = path.join(__dirname, "assets", "proxim_card_template.png");
  const tplBytes = fs.readFileSync(tplPath);
  CARD_TEMPLATE_DATA_URI = `data:image/png;base64,${tplBytes.toString("base64")}`;
} catch (_) {}

function escapeXml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Format card number into 4 spaced groups of 4 digits (either full PAN or masked last4).
 */
function formatCardNumberDisplay({ number = null, last4 = null, masked = true } = {}) {
  const cleanPan = String(number || "").replace(/\D/g, "");
  if (!masked && cleanPan.length >= 12) {
    return cleanPan.replace(/(.{4})/g, "$1 ").trim();
  }
  const tail = String(last4 || cleanPan.slice(-4) || "••••").replace(/[^0-9•*]/g, "").slice(-4) || "••••";
  return `•••• •••• •••• ${tail.padStart(4, "•")}`;
}

/**
 * Build the Proxim Card SVG by overlaying the dynamic text fields at the exact pixel
 * coordinates of the official Proxim Card template (1024 x 682):
 *  - Card Number baseline: x=112, y=417 (cap height 39px)
 *  - Expiry Date baseline: x=186, y=490 (cap height 27px, right next to VALID THRU)
 *  - Cardholder Name baseline: x=114, y=542 (cap height 24px)
 */
function buildProximCardSvg(opts = {}) {
  const {
    cardholderName = "PROXIM MEMBER",
    number = null,
    last4 = "••••",
    masked = true,
    expirationMonth = "--",
    expirationYear = "--",
    cvv = null,
  } = opts;

  const panDisplay = formatCardNumberDisplay({ number, last4, masked });
  const mm = String(expirationMonth || "--").padStart(2, "0").slice(-2);
  const yy = String(expirationYear || "--").slice(-2);
  const expiryDisplay = `${mm}/${yy}`;

  const holderClean = String(cardholderName || "PROXIM MEMBER")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 26);

  const showCvvOnCard = !masked && cvv && String(cvv).trim();

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 682" width="1024" height="682">
  <title>Proxim mastercard Virtual Debit Card</title>
  <defs>
    <style>${getFontCss()}</style>
  </defs>

  <!-- Official Untouched Proxim Card Template (Proxim Logo + Chip + Watermark + Mastercard) -->
  ${
    CARD_TEMPLATE_DATA_URI
      ? `<image href="${CARD_TEMPLATE_DATA_URI}" x="0" y="0" width="1024" height="682" preserveAspectRatio="none" />`
      : `<rect x="28" y="34" width="968" height="614" rx="48" ry="48" fill="#023d1f" />
         <text x="240" y="167" fill="#ffffff" font-family="${FONT}" font-size="52" font-weight="700">Proxim</text>
         <text x="848" y="596" fill="#ffffff" font-family="${FONT}" font-size="25">mastercard</text>`
  }

  <!-- Dynamic 16-Digit Card Number (Exact Template Coordinates: x=112, y=417) -->
  <text
    x="112"
    y="417"
    fill="#ffffff"
    font-family="${FONT_MONO}"
    font-size="52"
    font-weight="400"
    letter-spacing="1.5"
  >${escapeXml(panDisplay)}</text>

  <!-- Dynamic Expiry Date Next to Original "VALID THRU" (Exact Template Coordinates: x=186, y=490) -->
  <text
    x="186"
    y="490"
    fill="#ffffff"
    font-family="${FONT_MONO}"
    font-size="35"
    font-weight="400"
    letter-spacing="0.5"
  >${escapeXml(expiryDisplay)}</text>

  ${
    showCvvOnCard
      ? `<!-- Ephemeral CVV (Only rendered in-memory on 60s PIN Reveal) -->
         <text x="332" y="473" fill="#d7f5e5" font-family="${FONT}" font-size="14" font-weight="400" letter-spacing="0.8">CVV</text>
         <text x="374" y="490" fill="#ffffff" font-family="${FONT_MONO}" font-size="35" font-weight="400" letter-spacing="1">${escapeXml(String(cvv).trim())}</text>`
      : ""
  }

  <!-- Dynamic Cardholder Name (Exact Template Coordinates: x=114, y=542) -->
  <text
    x="114"
    y="542"
    fill="#ffffff"
    font-family="${FONT}"
    font-size="31"
    font-weight="400"
    letter-spacing="5"
  >${escapeXml(holderClean)}</text>
</svg>`;
}

/**
 * Render a Proxim Virtual/Disposable Card directly to an in-memory PNG Buffer.
 * Always used for PIN-gated card reveals so full PAN & CVV NEVER touch disk!
 */
function generateProximCardBuffer(opts = {}) {
  const svg = buildProximCardSvg(opts);
  return renderSvgToPngBuffer(svg, { zoom: Number(opts.zoom) || 1 });
}

/**
 * Render a MASKED Proxim Card PNG file to os.tmpdir() (safe for card activation & control panel).
 * Enforces `masked: true` and `cvv: null` whenever writing to disk!
 */
async function generateMaskedProximCardPNG(opts = {}) {
  const safeOpts = {
    ...opts,
    masked: true,
    number: null,
    cvv: null,
  };
  const svg = buildProximCardSvg(safeOpts);
  const fileName = `proxim_card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.png`;
  const outPath = path.join(os.tmpdir(), fileName);
  renderSvgToPngFile(svg, outPath, { zoom: 1 });
  return outPath;
}

module.exports = {
  formatCardNumberDisplay,
  buildProximCardSvg,
  generateProximCardBuffer,
  generateMaskedProximCardPNG,
};
