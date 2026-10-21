// src/receipt_generator.js
// Generates a clean, physical-slip payment receipt PNG after every successful transfer.
// Styled after the modern Proxim receipt slip design:
// - Deep forest green hero card with typographic hierarchy & vibrant checkmark badge
// - Clean recipient card with circular monogram avatar
// - Transaction details list with clear monospace hashes and references
// - Authentic serrated (sawtooth) receipt bottom edge with soft stage drop-shadow
// - High-performance SVG -> PNG rendering via resvg-js and DejaVu fonts

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getFontCss } = require("./svg_fonts");
const { renderSvgToPngFile } = require("./svg_render");

// Load the real Proxim logo once at module boot and embed as a base64 data URI.
// Falls back gracefully if the asset file is missing (e.g. in tests).
let PROXIM_LOGO_DATA_URI = "";
try {
  const logoPath = path.join(__dirname, "assets", "proxim_logo.png");
  const logoBytes = fs.readFileSync(logoPath);
  PROXIM_LOGO_DATA_URI = `data:image/png;base64,${logoBytes.toString("base64")}`;
} catch (_) {
  // Asset not found — header will show no logo rather than crashing
}

function escape(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getInitials(name) {
  if (!name) return "PX";
  const cleaned = String(name).replace(/[^a-zA-Z0-9\s]/g, "").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "PX";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Builds a realistic serrated (sawtooth) bottom receipt slip path.
 * Rounded top-left & top-right corners, straight sides, and a classic
 * zig-zag torn-ticket edge along the bottom.
 */
function buildSerratedSlipPath(x, y, w, h, toothW = 14, toothH = 7, r = 20) {
  let p = `M ${x + r} ${y} `;
  p += `H ${x + w - r} `;
  p += `A ${r} ${r} 0 0 1 ${x + w} ${y + r} `;
  p += `V ${y + h} `;

  const numTeeth = Math.floor(w / toothW);
  const rem = w - numTeeth * toothW;
  let currX = x + w;

  for (let i = 0; i < numTeeth; i++) {
    const midX = currX - toothW / 2;
    const nextX = currX - toothW;
    p += `L ${midX.toFixed(1)} ${(y + h - toothH).toFixed(1)} L ${nextX.toFixed(1)} ${(y + h).toFixed(1)} `;
    currX = nextX;
  }
  if (rem > 0) {
    p += `L ${x} ${y + h} `;
  }

  p += `V ${y + r} `;
  p += `A ${r} ${r} 0 0 1 ${x + r} ${y} `;
  p += `Z`;
  return p;
}

/**
 * Build the modern Proxim receipt slip SVG.
 *
 * @param {object} opts
 * @param {string} opts.receiptId        — e.g. "CO-6ad618ad9d" or internal reference
 * @param {string} opts.senderName       — "Proxim Wallet" or business name
 * @param {string} opts.senderAddress    — 0x... or Solana/NEAR address
 * @param {string} opts.recipientName    — payee name, account name, or address
 * @param {string} opts.recipientAddress — bank account number (10-digit NUBAN) or crypto address
 * @param {number} opts.amountUsdc       — numeric amount
 * @param {string} opts.token            — "USDC" | "EURC" (default: "USDC")
 * @param {string|null} opts.nairaEquiv  — formatted string, e.g. "₦337,500.00"
 * @param {string} opts.type             — "Cash Out" | "Payment" | "Deposit" | "Payroll" | "Transfer"
 * @param {string} opts.timestamp        — ISO string or formatted date
 * @param {string} opts.status           — "Confirmed" | "Completed" | "Pending" | "Received"
 * @param {string|null} opts.txHash      — full on-chain transaction hash or null
 */
function buildReceiptSvg(opts = {}) {
  const {
    receiptId = `R-${Date.now()}`,
    senderName = "Proxim Wallet",
    senderAddress = "",
    recipientName = "Recipient",
    recipientAddress = "",
    bankName = "",
    amountUsdc = 0,
    token = "USDC",
    nairaEquiv = null,
    type = "Payment",
    timestamp = new Date().toISOString(),
    status = "Confirmed",
    txHash = null,
    narration = null,
  } = opts;

  const typeLower = (type || "").toLowerCase();
  const isDeposit = typeLower.includes("deposit") || typeLower.includes("received");
  const isCashOut = typeLower.includes("cash out") || typeLower.includes("offramp");
  const isWithdrawal = typeLower.includes("withdraw");
  const isSavingsWithdraw = typeLower.includes("savings") && isWithdrawal;
  const isPending = (status || "").toLowerCase().includes("pending");
  const isFailed = (status || "").toLowerCase().includes("fail") || (status || "").toLowerCase().includes("decline");
  const isConfirmed = !isPending && !isFailed;

  let heroLabel = "Amount sent";
  if (isFailed) heroLabel = `${escape(type)} Failed`;
  else if (isDeposit) heroLabel = "Amount received";
  else if (isSavingsWithdraw) heroLabel = "Savings Withdrawn";
  else if (isCashOut) heroLabel = isPending ? "Cash Out Processing" : "Cash Out Delivered";
  else if (isWithdrawal) heroLabel = isPending ? "Withdrawal Submitted" : "Withdrawal Delivered";
  else heroLabel = `${escape(type)} Successful`;

  let dateStr = "";
  try {
    const d = timestamp ? new Date(timestamp) : new Date();
    if (isNaN(d.getTime())) {
      dateStr = String(timestamp);
    } else {
      dateStr = d.toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  } catch {
    dateStr = String(timestamp || "");
  }

  const shortHash = txHash
    ? (txHash.length > 22 ? `${txHash.slice(0, 10)}...${txHash.slice(-8)}` : txHash)
    : null;

  const shortSender = senderAddress
    ? (senderAddress.length > 18 ? `${senderAddress.slice(0, 6)}...${senderAddress.slice(-4)}` : senderAddress)
    : "";

  let cleanRecipientName = String(recipientName || "").trim();
  let detectedBank = bankName ? String(bankName).trim() : "";
  const bankMatch = cleanRecipientName.match(/^(.+?)\s*\(([^)]+)\)$/);
  if (bankMatch) {
    cleanRecipientName = bankMatch[1].trim();
    if (!detectedBank) detectedBank = bankMatch[2].trim();
  }

  const isBankPayout = isCashOut || /^\d{7,12}$/.test(String(recipientAddress || "").trim());
  let shortRecip = "";
  if (recipientAddress) {
    const rawRecip = String(recipientAddress).trim();
    if (isBankPayout || /^\d{7,12}$/.test(rawRecip)) {
      shortRecip = `Acct: ${rawRecip}`;
    } else if (rawRecip.length > 18) {
      shortRecip = `${rawRecip.slice(0, 6)}...${rawRecip.slice(-4)}`;
    } else {
      shortRecip = rawRecip;
    }
  }

  let destSubinfo = "";
  if (detectedBank && shortRecip) {
    destSubinfo = `${detectedBank} · ${shortRecip}`;
  } else if (detectedBank) {
    destSubinfo = detectedBank;
  } else if (shortRecip) {
    destSubinfo = shortRecip;
  } else if (isDeposit && shortSender) {
    destSubinfo = shortSender;
  }

  const displayRecipientName = cleanRecipientName.length > 28
    ? `${cleanRecipientName.slice(0, 26)}...`
    : (cleanRecipientName || detectedBank || "Recipient");

  let cleanNaira = null;
  if (nairaEquiv !== null && nairaEquiv !== undefined && nairaEquiv !== "") {
    if (typeof nairaEquiv === "number") {
      cleanNaira = `₦${nairaEquiv.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else {
      const s = String(nairaEquiv).trim();
      cleanNaira = s.startsWith("₦") ? s : `₦${s}`;
    }
  }

  const amtNum = Number(amountUsdc || 0);
  const amtFormatted = isNaN(amtNum)
    ? "0.00"
    : amtNum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const amtFontSize = amtFormatted.length > 10 ? 30 : (amtFormatted.length > 8 ? 34 : 38);

  // Dimensions & Layout
  const canvasW = 460;
  const slipW = 400;
  const slipX = (canvasW - slipW) / 2; // 30
  const slipY = 24;

  const heroY = slipY + 68;
  const heroH = cleanNaira ? 156 : 126;

  const toY = heroY + heroH + 14;
  const toH = 68;

  // Key-value rows
  let statusDisplay = "✓ Completed";
  let statusFill = "#08B766";
  if (isFailed) {
    statusDisplay = "✕ Failed";
    statusFill = "#DC2626";
  } else if (isPending) {
    statusDisplay = "Pending";
    statusFill = "#D97706";
  }

  const destSubtitle = isDeposit
    ? "Credited Account"
    : (isSavingsWithdraw
        ? "Returned to Account"
        : ((isCashOut || isWithdrawal)
            ? (isBankPayout ? "Destination Account" : "Destination Wallet")
            : "Recipient"));
  const initials = getInitials(cleanRecipientName || senderName);

  const rows = [];
  rows.push({ label: "Payment type", val: type });
  if (senderName) {
    rows.push({
      label: isDeposit ? "Source" : "From",
      val: senderName,
      sub: (shortSender && shortSender !== senderName) ? shortSender : null,
    });
  }
  if (narration && String(narration).trim()) {
    rows.push({ label: "Narration", val: String(narration).trim() });
  }
  rows.push({ label: "Date & time", val: dateStr });
  rows.push({ label: "Reference", val: receiptId, isMono: true });
  if (shortHash) {
    rows.push({ label: "Transaction ID", val: shortHash, isMono: true });
  }
  rows.push({
    label: "Status",
    val: statusDisplay,
    customFill: statusFill,
    isStatus: true,
  });

  const dlY = toY + toH + 12;
  const rowHeight = 36;
  const dlH = rows.length * rowHeight;

  const footY = dlY + dlH + 8;
  const footH = 62;

  const slipH = (footY + footH) - slipY + 14;
  const canvasH = slipY + slipH + 28;

  const slipPath = buildSerratedSlipPath(slipX, slipY, slipW, slipH, 14, 7, 20);

  // Rows SVG
  let rowsSvg = "";
  rows.forEach((r, idx) => {
    const currRowY = dlY + idx * rowHeight;
    const isLast = idx === rows.length - 1;
    const divider = !isLast
      ? `<line x1="${slipX + 22}" y1="${currRowY + 28}" x2="${slipX + slipW - 22}" y2="${currRowY + 28}" stroke="#E4EBE7" stroke-width="1"/>`
      : "";

    let valFill = "#0B2A22";
    let valWeight = "700";
    let fontFam = "'DejaVu Sans', sans-serif";

    if (r.isMono) {
      valFill = "#0F5540";
      fontFam = "'DejaVu Sans Mono', monospace";
    } else if (r.isStatus) {
      valFill = r.customFill || (isConfirmed ? "#08B766" : "#D97706");
      valWeight = "800";
    }

    let displayVal = r.val || "";
    let subText = "";
    if (r.sub) {
      if (displayVal.length > 18) {
        displayVal = `${displayVal.slice(0, 16)}...`;
      }
      subText = ` <tspan font-size="10.5" font-weight="500" fill="#5F766E" font-family="'DejaVu Sans Mono', monospace">(${escape(r.sub)})</tspan>`;
    } else if (r.label === "Narration") {
      if (displayVal.length > 36) {
        displayVal = `${displayVal.slice(0, 34)}...`;
      }
    } else if (displayVal.length > 28) {
      displayVal = `${displayVal.slice(0, 26)}...`;
    }

    rowsSvg += `
    <text x="${slipX + 22}" y="${currRowY + 18}" font-size="13" font-weight="500" fill="#5F766E">${escape(r.label)}</text>
    <text x="${slipX + slipW - 22}" y="${currRowY + 18}" font-size="13" font-weight="${valWeight}" fill="${valFill}" font-family="${fontFam}" text-anchor="end">${escape(displayVal)}${subText}</text>
    ${divider}`;
  });

  // Hero figure & naira
  const heroMidX = slipX + slipW / 2; // 230
  const tickY = heroY + 36;
  const tickR = 21;
  const labelY = tickY + tickR + 18;
  const figY = labelY + 38;
  const ngnY = figY + 24;

  const nairaLine = cleanNaira
    ? `<text x="${heroMidX}" y="${ngnY}" font-size="14.5" font-weight="700" fill="#ffffff" text-anchor="middle">
        ${escape(cleanNaira)} <tspan font-size="12" font-weight="500" fill="#A9C9BC">NGN</tspan>
      </text>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${canvasW}" height="${canvasH}" viewBox="0 0 ${canvasW} ${canvasH}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      ${getFontCss()}
    </style>
    <filter id="slipShadow" x="-10%" y="-5%" width="120%" height="115%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#05231E" flood-opacity="0.18"/>
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#05231E" flood-opacity="0.08"/>
    </filter>
    <linearGradient id="forestGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0F5540"/>
      <stop offset="100%" stop-color="#0A3E30"/>
    </linearGradient>
  </defs>

  <!-- Stage Canvas Background -->
  <rect width="${canvasW}" height="${canvasH}" fill="#E7EEEA"/>

  <!-- Receipt Slip (With Serrated Bottom & Drop Shadow) -->
  <path d="${slipPath}" fill="#ffffff" filter="url(#slipShadow)"/>

  <!-- ==================== HEADER (.top) ==================== -->
  <g transform="translate(${slipX + 22}, ${slipY + 16})">
    <!-- Proxim Logo (40x40) -->
    ${PROXIM_LOGO_DATA_URI
      ? `<image href="${PROXIM_LOGO_DATA_URI}" x="0" y="0" width="40" height="40"/>`
      : `<rect width="40" height="40" rx="12" fill="#0A3E30"/>`
    }

    <!-- Brand Name -->
    <text x="50" y="26" font-size="18" font-weight="800" fill="#0B2A22" letter-spacing="-0.3">Proxim</text>

    <!-- Subtitle / Receipt Badge -->
    <text x="${slipW - 44}" y="25" font-size="12" font-weight="600" fill="#5F766E" text-anchor="end">${escape(receiptId)}</text>
  </g>

  <!-- ==================== HERO BOX (.hero) ==================== -->
  <rect x="${slipX + 14}" y="${heroY}" width="${slipW - 28}" height="${heroH}" rx="14" fill="#0A3E30"/>

  <!-- Tick Badge Circle -->
  <circle cx="${heroMidX}" cy="${tickY}" r="${tickR}" fill="${isConfirmed ? '#08B766' : (isFailed ? '#DC2626' : '#F59E0B')}"/>
  ${
    isConfirmed
      ? `<!-- Checkmark -->
  <path d="M ${heroMidX - 7} ${tickY} L ${heroMidX - 2} ${tickY + 5} L ${heroMidX + 8} ${tickY - 5}" 
        fill="none" stroke="#05231E" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`
      : (isFailed
          ? `<!-- Cross / Failed Icon -->
  <path d="M ${heroMidX - 5} ${tickY - 5} L ${heroMidX + 5} ${tickY + 5} M ${heroMidX + 5} ${tickY - 5} L ${heroMidX - 5} ${tickY + 5}" 
        fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round"/>`
          : `<!-- Clock / Pending Icon -->
  <circle cx="${heroMidX}" cy="${tickY}" r="7" fill="none" stroke="#05231E" stroke-width="2.2"/>
  <path d="M ${heroMidX} ${tickY - 4} L ${heroMidX} ${tickY} L ${heroMidX + 3} ${tickY + 2}" 
        fill="none" stroke="#05231E" stroke-width="2.2" stroke-linecap="round"/>`
        )
  }

  <!-- Hero Label -->
  <text x="${heroMidX}" y="${labelY}" font-size="13" font-weight="600" fill="#A9C9BC" text-anchor="middle">${escape(heroLabel)}</text>

  <!-- Figure: Amount + Token -->
  <text x="${heroMidX}" y="${figY}" text-anchor="middle">
    <tspan font-size="${amtFontSize}" font-weight="800" fill="#ffffff" letter-spacing="-1">${escape(amtFormatted)}</tspan>
    <tspan dx="6" font-size="16" font-weight="700" fill="#A9C9BC">${escape(token)}</tspan>
  </text>

  <!-- NGN Equivalent -->
  ${nairaLine}

  <!-- ==================== DESTINATION / RECIPIENT CARD (.to) ==================== -->
  <rect x="${slipX + 14}" y="${toY}" width="${slipW - 28}" height="${toH}" rx="14" fill="#F2F6F4"/>

  <!-- Avatar -->
  <circle cx="${slipX + 14 + 32}" cy="${toY + toH / 2}" r="19" fill="#0F5540"/>
  <text x="${slipX + 14 + 32}" y="${toY + toH / 2 + 5}" font-size="13" font-weight="800" fill="#ffffff" text-anchor="middle">${escape(initials)}</text>

  <!-- Destination Text -->
  <g transform="translate(${slipX + 14 + 60}, ${toY + 18})">
    <text x="0" y="0" font-size="11" font-weight="500" fill="#5F766E">${escape(destSubtitle)}</text>
    <text x="0" y="18" font-size="14" font-weight="800" fill="#0B2A22">${escape(displayRecipientName)}</text>
    ${destSubinfo ? `<text x="0" y="34" font-size="12" font-weight="600" fill="#5F766E">${escape(destSubinfo)}</text>` : ""}
  </g>

  <!-- ==================== DETAILS LIST (dl / .row) ==================== -->
  ${rowsSvg}

  <!-- ==================== FOOTER (.foot) ==================== -->
  <g transform="translate(0, ${footY})">
    <line x1="${slipX + 22}" y1="0" x2="${slipX + slipW - 22}" y2="0" stroke="#CBD8D2" stroke-width="1.5" stroke-dasharray="4 4"/>
    <text x="${heroMidX}" y="24" font-size="13.5" font-weight="800" fill="#0F5540" text-anchor="middle">Proxim</text>
    <text x="${heroMidX}" y="42" font-size="11.5" font-weight="500" fill="#5F766E" text-anchor="middle">Save in dollars. Spend in Naira.</text>
  </g>
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
  const svg = buildReceiptSvg({ ...opts, receiptId });
  const outPath = path.join(os.tmpdir(), `receipt-${receiptId}-${Date.now()}.png`);
  renderSvgToPngFile(svg, outPath);
  return outPath;
}

module.exports = { generateReceiptPNG, buildReceiptSvg };
