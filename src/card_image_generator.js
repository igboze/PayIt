// src/card_image_generator.js
// Generates Proxim-branded Virtual & Disposable USD Debit Card PNGs.
// Matches the official Proxim emerald debit card industrial design:
// - Deep emerald body with metallic green bevel rim, diagonal sheen, and bottom-left neon corner accent
// - Giant Proxim "P↗" watermark emblem across the right side
// - Top-left rounded-square Proxim icon + bold "Proxim" wordmark
// - Top-right tracked "D E B I T" (or "D I S P O S A B L E") label
// - Realistic metallic gold EMV chip + 4-arc white contactless NFC wave icon
// - Dynamic 16-digit card number (masked `•••• •••• •••• 3456` or ephemeral in-memory full PAN on PIN reveal)
// - Dynamic VALID THRU expiry (`MM/YY`), optional CVV badge on PIN reveal, uppercase Cardholder Name, and Mastercard mark
//
// SECURITY INVARIANT:
// Unmasked PAN/CVV card renders ALWAYS use `generateProximCardBuffer()` in memory (Buffer)
// and NEVER write full PAN or CVV to disk or SQLite.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { getFontCss, FONT, FONT_MONO } = require("./svg_fonts");
const { renderSvgToPngBuffer, renderSvgToPngFile } = require("./svg_render");

let PROXIM_ICON_DATA_URI = "";
try {
  const iconPath = path.join(__dirname, "assets", "proxim_logo_80.png");
  const iconBytes = fs.readFileSync(iconPath);
  PROXIM_ICON_DATA_URI = `data:image/png;base64,${iconBytes.toString("base64")}`;
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
 * Build the Proxim Emerald Debit Card SVG (1024 x 682 canvas).
 *
 * @param {object} opts
 * @param {string} [opts.cardholderName="PROXIM MEMBER"]
 * @param {string} [opts.number=null]          - Full PAN (only used when masked === false)
 * @param {string} [opts.last4="••••"]         - Last 4 digits
 * @param {boolean} [opts.masked=true]         - If true, masks first 12 digits
 * @param {string} [opts.expirationMonth="--"]
 * @param {string} [opts.expirationYear="--"]
 * @param {string} [opts.cvv=null]             - Only rendered when masked === false and cvv is provided
 * @param {string} [opts.cardType="virtual"]   - "virtual" | "disposable"
 * @param {string} [opts.cardName=null]        - Optional nickname subtitle
 * @param {number|null} [opts.availableUsd=null] - Optional spend limit badge
 * @param {string} [opts.status="active"]      - "active" | "blocked" | "deactivated"
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
    cardType = "virtual",
    cardName = null,
    availableUsd = null,
    status = "active",
  } = opts;

  const isDisposable = String(cardType).toLowerCase() === "disposable";
  const isFrozen = String(status).toLowerCase() === "blocked";
  const panDisplay = formatCardNumberDisplay({ number, last4, masked });

  const mm = String(expirationMonth || "--").padStart(2, "0").slice(-2);
  const yy = String(expirationYear || "--").slice(-2);
  const expiryDisplay = `${mm}/${yy}`;

  const holderClean = String(cardholderName || "PROXIM MEMBER")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 26);

  const topRightLabel = isFrozen
    ? "F R O Z E N"
    : (isDisposable ? "D I S P O S A B L E" : "D E B I T");

  const showCvvOnCard = !masked && cvv && String(cvv).trim();
  const hasBalanceBadge = availableUsd !== null && availableUsd !== undefined && Number.isFinite(Number(availableUsd));
  const subtitleText = cardName ? String(cardName).trim().slice(0, 28) : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 682" width="1024" height="682">
  <defs>
    <style>${getFontCss()}</style>

    <!-- Card Clip Path -->
    <clipPath id="cardClip">
      <rect x="28" y="34" width="968" height="614" rx="48" ry="48" />
    </clipPath>

    <!-- Metallic Emerald Rim Gradient -->
    <linearGradient id="rimGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1cf081" />
      <stop offset="25%" stop-color="#057a40" />
      <stop offset="55%" stop-color="#023d1f" />
      <stop offset="80%" stop-color="#07944e" />
      <stop offset="100%" stop-color="#19e67a" />
    </linearGradient>

    <!-- Deep Emerald Card Base Gradient -->
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="95%" y2="100%">
      <stop offset="0%" stop-color="#012b17" />
      <stop offset="42%" stop-color="#045d32" />
      <stop offset="72%" stop-color="#023b1f" />
      <stop offset="100%" stop-color="#011e0f" />
    </linearGradient>

    <!-- Soft Center-Left Ambient Emerald Glow -->
    <radialGradient id="ambientGlow" cx="38%" cy="42%" r="55%">
      <stop offset="0%" stop-color="#078c4b" stop-opacity="0.52" />
      <stop offset="60%" stop-color="#034a27" stop-opacity="0.18" />
      <stop offset="100%" stop-color="#012412" stop-opacity="0" />
    </radialGradient>

    <!-- Lower-Right Diagonal Emerald Sheen -->
    <linearGradient id="diagSheen" x1="25%" y1="15%" x2="95%" y2="95%">
      <stop offset="0%" stop-color="#00a859" stop-opacity="0.45" />
      <stop offset="35%" stop-color="#024423" stop-opacity="0.82" />
      <stop offset="100%" stop-color="#011c0e" stop-opacity="0.96" />
    </linearGradient>

    <!-- Bottom-Left Neon Emerald Corner Slice -->
    <linearGradient id="cornerAccent" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00ea77" />
      <stop offset="100%" stop-color="#009e50" />
    </linearGradient>

    <!-- Giant Proxim "P" Watermark Gradient -->
    <linearGradient id="giantPGrad" x1="15%" y1="100%" x2="90%" y2="0%">
      <stop offset="0%" stop-color="#024d28" stop-opacity="0.85" />
      <stop offset="45%" stop-color="#008c4a" stop-opacity="0.92" />
      <stop offset="100%" stop-color="#00d670" stop-opacity="0.95" />
    </linearGradient>

    <!-- Giant Proxim Arrow "↗" Gradient -->
    <linearGradient id="giantArrowGrad" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#00c868" />
      <stop offset="100%" stop-color="#00f07c" />
    </linearGradient>

    <!-- Realistic Gold EMV Chip Gradient -->
    <linearGradient id="goldChip" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#e3b857" />
      <stop offset="28%" stop-color="#fae29c" />
      <stop offset="52%" stop-color="#c99333" />
      <stop offset="78%" stop-color="#f5d77f" />
      <stop offset="100%" stop-color="#b37d22" />
    </linearGradient>

    <!-- Top-Left Badge Background -->
    <linearGradient id="logoBoxGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#04522c" />
      <stop offset="100%" stop-color="#012614" />
    </linearGradient>

    <!-- Mastercard Red/Orange Overlap Clip -->
    <clipPath id="mcLeftCircle">
      <circle cx="816" cy="518" r="50" />
    </clipPath>
  </defs>

  <!-- Outer Metallic Rim -->
  <rect x="24" y="30" width="976" height="622" rx="52" ry="52" fill="url(#rimGrad)" />
  <rect x="28" y="34" width="968" height="614" rx="48" ry="48" fill="url(#bgGrad)" />

  <!-- Clipped Interior Artwork -->
  <g clip-path="url(#cardClip)">
    <!-- Ambient Emerald Glow -->
    <rect x="28" y="34" width="968" height="614" fill="url(#ambientGlow)" />

    <!-- Diagonal Lower-Right Sheen Plane -->
    <path d="M 455 648 L 996 226 L 996 648 Z" fill="url(#diagSheen)" />

    <!-- Giant Proxim "P" Watermark Ribbon -->
    <path
      d="M 418 648
         L 418 525
         C 418 442, 472 396, 560 396
         L 632 396
         C 668 396, 692 375, 692 346
         C 692 317, 668 296, 632 296
         L 436 296
         L 492 216
         L 640 216
         C 734 216, 786 268, 786 346
         C 786 424, 734 476, 640 476
         L 562 476
         C 528 476, 512 494, 512 528
         L 512 648
         Z"
      fill="url(#giantPGrad)"
    />

    <!-- Giant Proxim Arrow "↗" Head -->
    <path
      d="M 678 214
         L 732 146
         C 739 138, 749 134, 760 134
         L 852 134
         C 868 134, 878 144, 878 160
         L 878 268
         C 878 279, 873 289, 864 296
         L 808 340
         C 799 347, 790 341, 790 330
         L 790 228
         C 790 220, 784 214, 776 214
         L 678 214
         Z"
      fill="url(#giantArrowGrad)"
    />

    <!-- Bottom-Left Neon Emerald Corner Slice -->
    <path d="M 28 504 L 178 648 L 28 648 Z" fill="url(#cornerAccent)" />

    <!-- Top-Left Proxim Icon Container (Pure Razor-Sharp Vector "P↗") -->
    <rect
      x="96"
      y="88"
      width="124"
      height="124"
      rx="28"
      ry="28"
      fill="url(#logoBoxGrad)"
      stroke="#1ea861"
      stroke-width="1.8"
    />
    <!-- Vector Proxim "P" inside badge -->
    <path
      d="M 127 186
         L 127 163
         C 127 148, 137 140, 153 140
         L 166 140
         C 173 140, 177 136, 177 131
         C 177 126, 173 122, 166 122
         L 130 122
         L 140 107
         L 167 107
         C 184 107, 194 117, 194 131
         C 194 145, 184 155, 167 155
         L 153 155
         C 147 155, 144 158, 144 164
         L 144 186
         Z"
      fill="#ffffff"
    />
    <!-- Vector Proxim Arrow "↗" inside badge -->
    <path
      d="M 171 107
         L 179 97
         C 180 96, 182 95, 184 95
         L 198 95
         C 201 95, 203 97, 203 100
         L 203 116
         C 203 118, 202 120, 200 121
         L 191 128
         C 189 129, 188 128, 188 126
         L 188 110
         C 188 108, 187 107, 185 107
         L 171 107
         Z"
      fill="#00e676"
    />

    <!-- "Proxim" Wordmark -->
    <text
      x="240"
      y="167"
      fill="#ffffff"
      font-family="${FONT}"
      font-size="52"
      font-weight="700"
      letter-spacing="-0.5"
    >Proxim</text>

    ${
      subtitleText
        ? `<text x="242" y="198" fill="#7be8b2" font-family="${FONT}" font-size="19" font-weight="700" letter-spacing="1">${escapeXml(subtitleText.toUpperCase())}</text>`
        : ""
    }

    <!-- Top-Right Card Type Label ("D E B I T" / "D I S P O S A B L E") -->
    <text
      x="936"
      y="128"
      text-anchor="end"
      fill="#e8fff3"
      font-family="${FONT}"
      font-size="25"
      font-weight="400"
      letter-spacing="7"
    >${escapeXml(topRightLabel)}</text>

    ${
      hasBalanceBadge
        ? `<rect x="752" y="150" width="186" height="40" rx="20" ry="20" fill="#012412" fill-opacity="0.72" stroke="#1fd477" stroke-width="1.5" />
           <text x="845" y="176" text-anchor="middle" fill="#52ffaa" font-family="${FONT_MONO}" font-size="20" font-weight="700">$${Number(availableUsd).toFixed(2)} USD</text>`
        : ""
    }

    <!-- Realistic Metallic Gold EMV Chip -->
    <g transform="translate(118, 246)">
      <rect x="0" y="0" width="128" height="96" rx="16" ry="16" fill="url(#goldChip)" stroke="#8a5a10" stroke-width="2" />
      <!-- EMV Circuit Pads -->
      <line x1="42" y1="0" x2="42" y2="96" stroke="#6b4409" stroke-width="2.2" />
      <line x1="86" y1="0" x2="86" y2="96" stroke="#6b4409" stroke-width="2.2" />
      <line x1="0" y1="32" x2="42" y2="32" stroke="#6b4409" stroke-width="2.2" />
      <line x1="0" y1="64" x2="42" y2="64" stroke="#6b4409" stroke-width="2.2" />
      <line x1="86" y1="32" x2="128" y2="32" stroke="#6b4409" stroke-width="2.2" />
      <line x1="86" y1="64" x2="128" y2="64" stroke="#6b4409" stroke-width="2.2" />
      <rect x="42" y="20" width="44" height="56" rx="8" ry="8" fill="none" stroke="#6b4409" stroke-width="2.2" />
    </g>

    <!-- Contactless NFC Wave Icon (4 Arcs) -->
    <g transform="translate(274, 294)" fill="none" stroke="#ffffff" stroke-width="6.5" stroke-linecap="round">
      <path d="M 12 -14 A 22 22 0 0 1 12 14" />
      <path d="M 27 -24 A 36 36 0 0 1 27 24" />
      <path d="M 42 -34 A 50 50 0 0 1 42 34" />
      <path d="M 57 -44 A 64 64 0 0 1 57 44" />
    </g>

    <!-- 16-Digit Card Number -->
    <text
      x="114"
      y="436"
      fill="#ffffff"
      font-family="${FONT_MONO}"
      font-size="50"
      font-weight="400"
      letter-spacing="2"
    >${escapeXml(panDisplay)}</text>

    <!-- VALID THRU + Expiry Date -->
    <text x="116" y="502" fill="#d7f5e5" font-family="${FONT}" font-size="16" font-weight="400" letter-spacing="1">VALID</text>
    <text x="116" y="522" fill="#d7f5e5" font-family="${FONT}" font-size="16" font-weight="400" letter-spacing="1">THRU</text>
    <text x="184" y="522" fill="#ffffff" font-family="${FONT_MONO}" font-size="34" font-weight="400" letter-spacing="1">${escapeXml(expiryDisplay)}</text>

    ${
      showCvvOnCard
        ? `<!-- Ephemeral CVV Display (Only on 60s PIN Reveal) -->
           <text x="348" y="502" fill="#7be8b2" font-family="${FONT}" font-size="16" font-weight="700" letter-spacing="1">SECURITY</text>
           <text x="348" y="522" fill="#7be8b2" font-family="${FONT}" font-size="16" font-weight="700" letter-spacing="1">CVV</text>
           <text x="442" y="522" fill="#52ffaa" font-family="${FONT_MONO}" font-size="34" font-weight="700" letter-spacing="2">${escapeXml(String(cvv).trim())}</text>`
        : ""
    }

    <!-- Cardholder Name -->
    <text
      x="116"
      y="586"
      fill="#ffffff"
      font-family="${FONT}"
      font-size="32"
      font-weight="400"
      letter-spacing="5"
    >${escapeXml(holderClean)}</text>

    <!-- Mastercard Interlocking Circles + Wordmark -->
    <g>
      <circle cx="816" cy="518" r="50" fill="#EB001B" />
      <circle cx="880" cy="518" r="50" fill="#F79E1B" />
      <circle cx="880" cy="518" r="50" fill="#FF5F00" clip-path="url(#mcLeftCircle)" />
      <text
        x="848"
        y="596"
        text-anchor="middle"
        fill="#ffffff"
        font-family="${FONT}"
        font-size="25"
        font-weight="400"
        letter-spacing="0.3"
      >mastercard</text>
    </g>
  </g>

  <!-- Subtle Inner Highlight Border -->
  <rect
    x="30"
    y="36"
    width="964"
    height="610"
    rx="46"
    ry="46"
    fill="none"
    stroke="#38f294"
    stroke-opacity="0.42"
    stroke-width="2"
  />
</svg>`;
}

/**
 * Render a Proxim Virtual/Disposable Card directly to an in-memory PNG Buffer.
 * Always used for PIN-gated card reveals so full PAN & CVV NEVER touch disk!
 */
function generateProximCardBuffer(opts = {}) {
  const svg = buildProximCardSvg(opts);
  return renderSvgToPngBuffer(svg, { zoom: Number(opts.zoom) || 2 });
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
  renderSvgToPngFile(svg, outPath, { zoom: 2 });
  return outPath;
}

module.exports = {
  formatCardNumberDisplay,
  buildProximCardSvg,
  generateProximCardBuffer,
  generateMaskedProximCardPNG,
};
