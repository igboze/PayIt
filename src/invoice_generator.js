// src/invoice_generator.js
// Executive Branded Invoice Generator (SVG -> 3x Retina PNG via resvg-js).
// - Automatically extracts dominant brand color from the business logo via sharp
//   and derives a WCAG-readable executive palette unique to each business.
// - Adaptive font scaling for large values (millions/billions never clip or overflow).
// - Includes dedicated fiat virtual account, on-chain payment address, brand-tinted QR code,
//   and clean "Powered by Proxim" footer.

const path = require("path");
const os = require("os");
const sharp = require("sharp");
const QRCode = require("qrcode");
const { FONT, FONT_MONO, getFontCss } = require("./svg_fonts");
const { renderSvgToPngFile } = require("./svg_render");

function escape(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeNum(val) {
  return parseFloat(String(val || "0").replace(/[^0-9.]/g, "")) || 0;
}

function formatMoney(num) {
  return Number(num || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const CURRENCY_SYMBOLS = {
  NGN: "₦",
  USD: "$",
  USDC: "$",
  USDT: "$",
  USDG: "$",
  GBP: "£",
  EUR: "€",
  EURC: "€",
  AED: "AED ",
  KES: "KSh ",
  GHS: "GH₵",
  TZS: "TSh ",
  MXN: "MX$",
  CAD: "CA$",
};

function formatCurrencyAmount(num, currency = "USDC") {
  const cur = String(currency || "USDC").toUpperCase();
  const sym = CURRENCY_SYMBOLS[cur];
  if (cur === "NGN") {
    return `₦${Number(num || 0).toLocaleString("en-NG", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (sym) {
    return `${sym}${formatMoney(num)}`;
  }
  return `${formatMoney(num)} ${cur}`;
}

function fitFontSize(text, maxWidthPx, baseSize, minSize = 9.5, charWidthRatio = 0.62) {
  const len = String(text || "").length;
  if (!len) return baseSize;
  const needed = len * baseSize * charWidthRatio;
  if (needed <= maxWidthPx) return baseSize;
  const scaled = (maxWidthPx / (len * charWidthRatio));
  return Math.max(minSize, Math.floor(scaled * 10) / 10);
}

function truncateText(text, maxChars) {
  const s = String(text || "").trim();
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(1, maxChars - 1)).trimEnd() + "…";
}

// ── Color Utilities & Logo Brand Theme Extraction ────────────────────────────

function clampByte(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function rgbToHex(r, g, b) {
  return (
    "#" +
    [clampByte(r), clampByte(g), clampByte(b)]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

function mixRgb(a, b, ratioB) {
  const w = Math.max(0, Math.min(1, ratioB));
  return [
    clampByte(a[0] * (1 - w) + b[0] * w),
    clampByte(a[1] * (1 - w) + b[1] * w),
    clampByte(a[2] * (1 - w) + b[2] * w),
  ];
}

function relativeLuminance(r, g, b) {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function buildThemeFromRgb(r, g, b) {
  // Ensure header primary has rich, authoritative contrast for white text (luminance <= 0.16)
  let primaryRgb = [r, g, b];
  let guard = 0;
  while (relativeLuminance(...primaryRgb) > 0.16 && guard < 12) {
    primaryRgb = mixRgb(primaryRgb, [15, 23, 42], 0.18);
    guard++;
  }

  // Ensure vibrant accent isn't washed out or pitch black
  let accentRgb = [r, g, b];
  if (relativeLuminance(...accentRgb) > 0.45) {
    accentRgb = mixRgb(accentRgb, [15, 23, 42], 0.3);
  } else if (relativeLuminance(...accentRgb) < 0.06) {
    accentRgb = mixRgb(accentRgb, [255, 255, 255], 0.2);
  }

  const primaryDarkRgb = mixRgb(primaryRgb, [9, 13, 24], 0.28);
  const tintBgRgb = mixRgb(accentRgb, [255, 255, 255], 0.94);
  const tintBorderRgb = mixRgb(accentRgb, [255, 255, 255], 0.78);
  const headerSubRgb = mixRgb(accentRgb, [255, 255, 255], 0.80);

  return {
    primary: rgbToHex(...primaryRgb),
    primaryDark: rgbToHex(...primaryDarkRgb),
    accent: rgbToHex(...accentRgb),
    tintBg: rgbToHex(...tintBgRgb),
    tintBorder: rgbToHex(...tintBorderRgb),
    headerSub: rgbToHex(...headerSubRgb),
  };
}

const DEFAULT_THEME = {
  primary: "#0f172a",     // Deep Executive Obsidian Navy
  primaryDark: "#090f1d", // Rich Dark Slate
  accent: "#059669",      // Crisp Emerald Accent
  tintBg: "#f0fdf4",      // Soft Mint Paper Tint
  tintBorder: "#bbf7d0",  // Clean Subtle Border
  headerSub: "#cbd5e1",   // Crisp Cool Silver on Dark Header
};

/**
 * Extract the dominant vibrant brand color from a base64 logo data URI using sharp.
 * Ignores transparent, near-white, near-black, and grey pixels so true brand hues win.
 */
async function extractBrandThemeFromLogo(logoDataUri) {
  if (!logoDataUri || typeof logoDataUri !== "string") return DEFAULT_THEME;
  try {
    const match = logoDataUri.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
    if (!match) return DEFAULT_THEME;
    const buf = Buffer.from(match[1], "base64");
    const { data, info } = await sharp(buf)
      .resize(32, 32, { fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const buckets = new Map();
    const channels = info.channels || 4;
    for (let i = 0; i < data.length; i += channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = channels >= 4 ? data[i + 3] : 255;
      if (a < 180) continue;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max - min;
      // Skip near-white, near-black, and neutral greys
      if (max < 28 || min > 230 || sat < 24) continue;

      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      const weight = 1 + (sat / 255) * 2.5;
      const cur = buckets.get(key) || { w: 0, rSum: 0, gSum: 0, bSum: 0, count: 0 };
      cur.w += weight;
      cur.rSum += r;
      cur.gSum += g;
      cur.bSum += b;
      cur.count += 1;
      buckets.set(key, cur);
    }

    let best = null;
    for (const bkt of buckets.values()) {
      if (!best || bkt.w > best.w) best = bkt;
    }
    if (!best || best.count === 0) return DEFAULT_THEME;

    return buildThemeFromRgb(
      best.rSum / best.count,
      best.gSum / best.count,
      best.bSum / best.count
    );
  } catch (err) {
    console.warn("[invoice_generator:brand_theme_fallback]", err.message);
    return DEFAULT_THEME;
  }
}

function buildSvg(opts) {
  const {
    invoiceNumber,
    clientName,
    clientEmail = null,
    items = [],
    dueDate = null,
    notes = null,
    businessName,
    businessEmail = null,
    businessPhone = null,
    businessAddress = null,
    logoDataUri = null,
    walletAddress = null,
    cryptoPaymentDetails = null,
    issueDate,
    currency = "USDC",
    fiatDetails = null,
    qrDataUri = null,
    theme = DEFAULT_THEME,
  } = opts;

  const displayCur = String(currency || "USDC").toUpperCase();
  const isNgn = displayCur === "NGN";
  const curSym = CURRENCY_SYMBOLS[displayCur] || "";

  const W = 760;
  const total = items.reduce(
    (s, i) => s + (Number(i.quantity || 1) || 1) * safeNum(i.unitPrice),
    0
  );

  // ── Item rows (with zebra striping & adaptive font sizing for big values) ──
  const tableHeaderY = 212;
  let y = tableHeaderY + 42;
  const ROW = 36;

  const itemsSvg = items
    .map((item, idx) => {
      const qty = Number(item.quantity || 1) || 1;
      const price = safeNum(item.unitPrice);
      const lineTotal = qty * price;
      const descText = truncateText(item.description || "Item", 44);
      const priceStr = curSym ? `${curSym}${formatMoney(price)}` : formatMoney(price);
      const lineStr = curSym ? `${curSym}${formatMoney(lineTotal)}` : formatMoney(lineTotal);
      const priceFont = fitFontSize(priceStr, 108, 12.5, 9.0);
      const lineFont = fitFontSize(lineStr, 124, 13, 9.0);
      const rowBg = idx % 2 === 1 ? `<rect x="36" y="${y - 22}" width="${W - 72}" height="${ROW}" fill="#f8fafc" rx="4"/>` : "";

      const row = `
      ${rowBg}
      <text x="48"  y="${y}" font-size="13" fill="#0f172a" font-family="${FONT}">${escape(descText)}</text>
      <text x="455" y="${y}" font-size="12.5" fill="#334155" font-family="${FONT}" text-anchor="middle">${qty}</text>
      <text x="580" y="${y}" font-size="${priceFont}" fill="#334155" font-family="${FONT_MONO}" text-anchor="end">${escape(priceStr)}</text>
      <text x="712" y="${y}" font-size="${lineFont}" fill="${theme.primary}" font-family="${FONT_MONO}" text-anchor="end" font-weight="bold">${escape(lineStr)}</text>`;
      y += ROW;
      return row;
    })
    .join("");

  // ── Adaptive Total Due Card ────────────────────────────────────────────────
  const totalY = y + 20;
  const totalDisplayStr = isNgn
    ? `₦${formatMoney(total)}`
    : curSym && !curSym.trim().endsWith(displayCur)
      ? `${curSym}${formatMoney(total)} ${displayCur}`
      : `${formatMoney(total)} ${displayCur}`;
  const totalCardW = Math.min(360, Math.max(255, totalDisplayStr.length * 14 + 95));
  const totalCardX = W - 36 - totalCardW;
  const totalValueFont = fitFontSize(totalDisplayStr, totalCardW - 108, 19, 12.0, 0.64);

  const notesY = totalY + 62;
  const paySectionY = notes ? notesY + 34 : totalY + 68;

  const hasFiat = Boolean(fiatDetails && (fiatDetails.accountNumber || fiatDetails.iban));
  const cryptoAddr = cryptoPaymentDetails?.depositAddress || walletAddress || null;
  const hasCrypto = Boolean(cryptoAddr);
  const hasCryptoMemo = Boolean(cryptoPaymentDetails?.depositMemo);

  const hasExtraBankCodes = Boolean(
    hasFiat && (fiatDetails.routingNumber || fiatDetails.sortCode || fiatDetails.swiftCode || (fiatDetails.iban && fiatDetails.accountNumber))
  );
  const fiatBoxHeight = hasFiat ? (hasExtraBankCodes ? 114 : 92) : 0;
  const cryptoBoxY = paySectionY + (hasFiat ? fiatBoxHeight + 16 : 0);
  const cryptoBoxHeight = hasCrypto
    ? (qrDataUri ? (hasCryptoMemo ? 142 : 128) : (hasCryptoMemo ? 104 : 86))
    : 0;

  const afterPayY = hasCrypto
    ? cryptoBoxY + cryptoBoxHeight
    : hasFiat
      ? paySectionY + fiatBoxHeight
      : paySectionY;
  const footerY = afterPayY + 34;
  const H = footerY + 52;

  // ── Header (Business Logo + Branded Color Block) ───────────────────────────
  const bizNameStr = String(businessName || "Proxim Account");
  const bizNameFont = fitFontSize(bizNameStr, 310, 18, 12.5);
  const bizLines = [businessEmail, businessPhone, businessAddress].filter(Boolean).slice(0, 3);
  const bizInfoSvg = bizLines
    .map(
      (line, i) =>
        `<text x="${W - 36}" y="${60 + i * 16}" font-size="11" fill="${theme.headerSub}" font-family="${FONT}" text-anchor="end">${escape(truncateText(line, 48))}</text>`
    )
    .join("");

  const logoX = 36;
  const textX = logoDataUri ? 108 : 36;
  const logoSvg = logoDataUri
    ? `
    <rect x="${logoX}" y="22" width="58" height="58" rx="12" fill="#ffffff"/>
    <image href="${logoDataUri}" x="${logoX + 5}" y="27" width="48" height="48" preserveAspectRatio="xMidYMid meet"/>`
    : "";

  // ── Fiat / Global Bank Transfer Box ────────────────────────────────────────
  let fiatSectionSvg = "";
  if (hasFiat) {
    const fiatCur = String(fiatDetails.currency || "NGN").toUpperCase();
    const railTag = fiatDetails.railHint ? ` · ${String(fiatDetails.railHint).toUpperCase()}` : "";
    const fiatTitle = `${hasCrypto ? "OPTION 1 · " : ""}BANK TRANSFER (${fiatCur}${railTag})`;

    const primaryNumLabel = fiatDetails.accountNumber ? "Account No" : "IBAN";
    const primaryNumVal = fiatDetails.accountNumber || fiatDetails.iban;

    const fiatAmtFormatted = fiatDetails.fiatAmount != null
      ? formatCurrencyAmount(fiatDetails.fiatAmount, fiatCur)
      : null;
    const fiatAmtFont = fiatAmtFormatted ? fitFontSize(fiatAmtFormatted, 200, 12.5, 10) : 12;

    const extraPlainParts = [];
    const extraParts = [];
    if (fiatDetails.routingNumber) {
      extraPlainParts.push(`Routing: ${fiatDetails.routingNumber}`);
      extraParts.push(`Routing: <tspan font-weight="bold" fill="${theme.primary}" font-family="${FONT_MONO}">${escape(fiatDetails.routingNumber)}</tspan>`);
    }
    if (fiatDetails.sortCode) {
      extraPlainParts.push(`Sort Code: ${fiatDetails.sortCode}`);
      extraParts.push(`Sort Code: <tspan font-weight="bold" fill="${theme.primary}" font-family="${FONT_MONO}">${escape(fiatDetails.sortCode)}</tspan>`);
    }
    if (fiatDetails.iban && fiatDetails.accountNumber) {
      extraPlainParts.push(`IBAN: ${fiatDetails.iban}`);
      extraParts.push(`IBAN: <tspan font-weight="bold" fill="${theme.primary}" font-family="${FONT_MONO}">${escape(fiatDetails.iban)}</tspan>`);
    }
    if (fiatDetails.swiftCode) {
      extraPlainParts.push(`SWIFT: ${fiatDetails.swiftCode}`);
      extraParts.push(`SWIFT: <tspan font-weight="bold" fill="${theme.primary}" font-family="${FONT_MONO}">${escape(fiatDetails.swiftCode)}</tspan>`);
    }

    const extraLineFont = fitFontSize(extraPlainParts.join("   ·   "), W - 110, 11.5, 8.5, 0.58);
    const extraLineSvg = hasExtraBankCodes
      ? `<text x="54" y="${paySectionY + 95}" font-size="${extraLineFont}" fill="#334155" font-family="${FONT}">${extraParts.join("   ·   ")}</text>`
      : "";

    const amountPartSvg = fiatAmtFormatted
      ? `   ·   Amount: <tspan font-size="${fiatAmtFont}" font-weight="bold" fill="${theme.accent}">${escape(fiatAmtFormatted)}</tspan>`
      : "";

    fiatSectionSvg = `
    <rect x="36" y="${paySectionY}" width="${W - 72}" height="${fiatBoxHeight}" fill="${theme.tintBg}" rx="10" stroke="${theme.tintBorder}" stroke-width="1.2"/>
    <rect x="36" y="${paySectionY}" width="5" height="${fiatBoxHeight}" fill="${theme.accent}" rx="2"/>
    <text x="54" y="${paySectionY + 25}" font-size="12.5" font-weight="bold" fill="${theme.primary}" font-family="${FONT}">${escape(truncateText(fiatTitle, 74))}</text>
    <text x="54" y="${paySectionY + 49}" font-size="12" fill="#334155" font-family="${FONT}">Bank: <tspan font-weight="bold" fill="#0f172a">${escape(truncateText(fiatDetails.bankName || "Partner Bank", 30))}</tspan>   ·   ${primaryNumLabel}: <tspan font-weight="bold" fill="${theme.primary}" font-family="${FONT_MONO}">${escape(primaryNumVal)}</tspan></text>
    <text x="54" y="${paySectionY + 72}" font-size="12" fill="#334155" font-family="${FONT}">Account Name: <tspan font-weight="bold" fill="#0f172a">${escape(truncateText(fiatDetails.accountName || clientName, 30))}</tspan>${amountPartSvg}</text>
    ${extraLineSvg}
  `;
  }

  // ── On-Chain / NEAR Intents Crypto Box (optional) ──────────────────────────
  let cryptoSectionSvg = "";
  if (hasCrypto) {
    const qrImageSvg = qrDataUri
      ? `
    <rect x="${W - 154}" y="${cryptoBoxY + 12}" width="104" height="104" rx="8" fill="#ffffff" stroke="${theme.tintBorder}" stroke-width="1"/>
    <image href="${qrDataUri}" x="${W - 148}" y="${cryptoBoxY + 18}" width="92" height="92" preserveAspectRatio="xMidYMid meet"/>`
      : "";

    const addrBoxW = qrDataUri ? W - 224 : W - 108;
    const chainLabel = cryptoPaymentDetails?.chainLabel || "ARC MAINNET";
    const tokenSymbol = cryptoPaymentDetails?.tokenSymbol || (isNgn ? "USDC" : displayCur);
    const exactCryptoAmt = cryptoPaymentDetails?.exactAmount != null
      ? `${formatMoney(cryptoPaymentDetails.exactAmount)} ${tokenSymbol}`
      : `$${formatMoney(total)} ${tokenSymbol}`;
    const viaTag = cryptoPaymentDetails?.viaNearIntents ? " · NEAR INTENTS" : "";
    const cryptoHeading = `${hasFiat ? "OPTION 2 · " : ""}CRYPTO PAYMENT (${chainLabel.toUpperCase()}${viaTag})`;
    const addrFont = fitFontSize(cryptoAddr, addrBoxW - 24, 11, 8.0, 0.62);
    const memoSvg = hasCryptoMemo
      ? `<text x="54" y="${cryptoBoxY + 109}" font-size="11" fill="#334155" font-family="${FONT}">Memo: <tspan font-weight="bold" fill="${theme.primary}" font-family="${FONT_MONO}">${escape(truncateText(cryptoPaymentDetails.depositMemo, 48))}</tspan></text>`
      : "";
    const hintY = hasCryptoMemo ? cryptoBoxY + 127 : cryptoBoxY + 111;
    const hintText = cryptoPaymentDetails?.viaNearIntents
      ? `Send exact ${exactCryptoAmt} on ${chainLabel}. Auto-settles via NEAR Intents.`
      : `Scan QR or send exact ${exactCryptoAmt} on ${chainLabel} for instant settlement.`;

    cryptoSectionSvg = `
    <rect x="36" y="${cryptoBoxY}" width="${W - 72}" height="${cryptoBoxHeight}" fill="#f8fafc" rx="10" stroke="#cbd5e1" stroke-width="1.2"/>
    <rect x="36" y="${cryptoBoxY}" width="5" height="${cryptoBoxHeight}" fill="${theme.primary}" rx="2"/>
    <text x="54" y="${cryptoBoxY + 26}" font-size="12.5" font-weight="bold" fill="${theme.primary}" font-family="${FONT}">${escape(cryptoHeading)}</text>
    <text x="54" y="${cryptoBoxY + 49}" font-size="12" fill="#334155" font-family="${FONT}">Send exact <tspan font-weight="bold" fill="${theme.primary}">${escape(exactCryptoAmt)}</tspan> to this dedicated invoice address:</text>
    <rect x="54" y="${cryptoBoxY + 60}" width="${addrBoxW}" height="32" fill="#ffffff" rx="6" stroke="#cbd5e1" stroke-width="1"/>
    <text x="66" y="${cryptoBoxY + 80}" font-size="${addrFont}" font-weight="bold" fill="#0f172a" font-family="${FONT_MONO}">${escape(cryptoAddr)}</text>
    ${memoSvg}
    <text x="54" y="${hintY}" font-size="10.5" fill="#64748b" font-family="${FONT}">${escape(truncateText(hintText, 78))}</text>
    ${qrImageSvg}
  `;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
     xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink">

  <defs>
    <style>
      ${getFontCss()}
    </style>
  </defs>

  <!-- Crisp Paper Card -->
  <rect width="${W}" height="${H}" fill="#ffffff" rx="14"/>

  <!-- Branded Executive Header -->
  <rect width="${W}" height="114" fill="${theme.primary}" rx="14"/>
  <rect y="94" width="${W}" height="20" fill="${theme.primary}"/>
  <rect y="110" width="${W}" height="4" fill="${theme.accent}"/>

  ${logoSvg}

  <text x="${textX}" y="52" font-size="26" font-weight="bold" fill="#ffffff" font-family="${FONT}" letter-spacing="1">INVOICE</text>
  <text x="${textX}" y="76" font-size="12.5" font-weight="bold" fill="${theme.headerSub}" font-family="${FONT_MONO}">#${escape(invoiceNumber)}</text>

  <text x="${W - 36}" y="38" font-size="${bizNameFont}" font-weight="bold" fill="#ffffff" font-family="${FONT}" text-anchor="end">${escape(bizNameStr)}</text>
  ${bizInfoSvg}

  <!-- Client & Date Metadata Band -->
  <rect y="114" width="${W}" height="78" fill="${theme.tintBg}"/>
  <line x1="0" y1="192" x2="${W}" y2="192" stroke="${theme.tintBorder}" stroke-width="1"/>

  <text x="36" y="140" font-size="10.5" font-weight="bold" fill="#64748b" font-family="${FONT}" letter-spacing="0.8">BILL TO</text>
  <text x="36" y="164" font-size="16" font-weight="bold" fill="#0f172a" font-family="${FONT}">${escape(truncateText(clientName, 36))}</text>
  ${clientEmail ? `<text x="36" y="182" font-size="11.5" fill="#475569" font-family="${FONT}">${escape(truncateText(clientEmail, 44))}</text>` : ""}

  <text x="${W - 185}" y="140" font-size="10.5" font-weight="bold" fill="#64748b" font-family="${FONT}" text-anchor="end" letter-spacing="0.8">DATE ISSUED</text>
  <text x="${W - 36}"  y="140" font-size="12.5" font-weight="bold" fill="#0f172a" font-family="${FONT}" text-anchor="end">${escape(issueDate)}</text>

  <text x="${W - 185}" y="166" font-size="10.5" font-weight="bold" fill="#64748b" font-family="${FONT}" text-anchor="end" letter-spacing="0.8">DUE DATE</text>
  <text x="${W - 36}"  y="166" font-size="12.5" font-weight="bold" fill="${dueDate ? "#b91c1c" : "#475569"}" font-family="${FONT}" text-anchor="end">${escape(dueDate || "On receipt")}</text>

  <!-- Line Items Table Header -->
  <rect x="36" y="${tableHeaderY}" width="${W - 72}" height="32" fill="${theme.primary}" rx="6"/>
  <text x="48"  y="${tableHeaderY + 21}" font-size="11.5" font-weight="bold" fill="#ffffff" font-family="${FONT}" letter-spacing="0.6">DESCRIPTION</text>
  <text x="455" y="${tableHeaderY + 21}" font-size="11.5" font-weight="bold" fill="#ffffff" font-family="${FONT}" text-anchor="middle" letter-spacing="0.6">QTY</text>
  <text x="580" y="${tableHeaderY + 21}" font-size="11.5" font-weight="bold" fill="#ffffff" font-family="${FONT}" text-anchor="end" letter-spacing="0.6">UNIT PRICE</text>
  <text x="712" y="${tableHeaderY + 21}" font-size="11.5" font-weight="bold" fill="#ffffff" font-family="${FONT}" text-anchor="end" letter-spacing="0.6">AMOUNT (${escape(currency)})</text>

  <!-- Line Items -->
  ${itemsSvg}

  <!-- Total Due Card -->
  <line x1="36" y1="${totalY - 12}" x2="${W - 36}" y2="${totalY - 12}" stroke="#e2e8f0" stroke-width="1.2"/>
  <rect x="${totalCardX}" y="${totalY}" width="${totalCardW}" height="48" fill="${theme.primaryDark}" rx="8"/>
  <rect x="${totalCardX}" y="${totalY}" width="5" height="48" fill="${theme.accent}" rx="2"/>
  <text x="${totalCardX + 18}" y="${totalY + 29}" font-size="12" font-weight="bold" fill="${theme.headerSub}" font-family="${FONT}" letter-spacing="0.6">TOTAL DUE</text>
  <text x="${W - 50}" y="${totalY + 31}" font-size="${totalValueFont}" font-weight="bold" fill="#ffffff" font-family="${FONT_MONO}" text-anchor="end">${escape(totalDisplayStr)}</text>

  ${notes ? `<text x="36" y="${notesY}" font-size="11.5" fill="#475569" font-family="${FONT}"><tspan font-weight="bold" fill="#0f172a">Note:</tspan> ${escape(truncateText(notes, 96))}</text>` : ""}

  <!-- Payment Methods -->
  ${fiatSectionSvg}
  ${cryptoSectionSvg}

  <!-- Branded Footer -->
  <line x1="36" y1="${footerY}" x2="${W - 36}" y2="${footerY}" stroke="#e2e8f0" stroke-width="1"/>
  <text x="${W / 2}" y="${footerY + 28}" font-size="12" font-weight="bold" fill="#64748b" font-family="${FONT}" text-anchor="middle">Powered by Proxim</text>

</svg>`;
}

/**
 * Build a clean, copy-and-forward Telegram HTML message that the merchant can
 * send directly to their client alongside the invoice PNG image.
 */
function buildClientInvoiceCopyText(opts) {
  const {
    invoiceNumber,
    businessName,
    clientName,
    currency = "USDC",
    totalDisplay = null,
    totalUsdc = 0,
    totalNgn = null,
    dueDate = null,
    fiatDetails = null,
    cryptoPaymentDetails = null,
    walletAddress = null,
  } = opts || {};

  const cur = String(currency || "USDC").toUpperCase();
  const amountLine = totalDisplay
    || (cur === "NGN" && totalNgn != null
      ? `₦${Number(totalNgn).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : cur === "USD"
        ? `$${formatMoney(totalUsdc)} USD`
        : `${formatCurrencyAmount(totalUsdc, cur)}${CURRENCY_SYMBOLS[cur] && !CURRENCY_SYMBOLS[cur].trim().endsWith(cur) ? ` ${cur}` : ""}`);

  const hasFiat = Boolean(fiatDetails && (fiatDetails.accountNumber || fiatDetails.iban));
  const cryptoAddr = cryptoPaymentDetails?.depositAddress || walletAddress || null;
  const hasCrypto = Boolean(cryptoAddr);

  let text =
    `🧾 <b>Invoice #${escape(invoiceNumber)} — ${escape(businessName || "Proxim")}</b>\n` +
    `Hi <b>${escape(clientName || "there")}</b>,\n\n` +
    `Please find your invoice attached.\n` +
    `• <b>Amount Due:</b> ${escape(amountLine)}\n` +
    (dueDate ? `• <b>Due Date:</b> ${escape(dueDate)}\n` : "");

  if (hasFiat) {
    const fiatCur = String(fiatDetails.currency || "NGN").toUpperCase();
    const isNgnBank = fiatCur === "NGN";
    const railLabel = fiatDetails.railHint ? ` (${fiatDetails.railHint})` : "";
    const bankHeading = isNgnBank
      ? `🇳🇬 <b>${hasCrypto ? "Option 1: " : ""}Pay via Nigerian Bank Transfer (NGN)</b>`
      : `🏦 <b>${hasCrypto ? "Option 1: " : ""}Pay via ${escape(fiatCur)} Bank Transfer${escape(railLabel)}</b>`;

    const fiatAmtStr = fiatDetails.fiatAmount != null
      ? formatCurrencyAmount(fiatDetails.fiatAmount, fiatCur)
      : null;

    text += `\n${bankHeading}\n`;
    if (fiatDetails.bankName) text += `• <b>Bank:</b> ${escape(fiatDetails.bankName)}\n`;
    if (fiatDetails.accountNumber) text += `• <b>Account Number:</b> <code>${escape(fiatDetails.accountNumber)}</code>\n`;
    if (fiatDetails.iban) text += `• <b>IBAN:</b> <code>${escape(fiatDetails.iban)}</code>\n`;
    if (fiatDetails.routingNumber) text += `• <b>Routing Number:</b> <code>${escape(fiatDetails.routingNumber)}</code>\n`;
    if (fiatDetails.sortCode) text += `• <b>Sort Code:</b> <code>${escape(fiatDetails.sortCode)}</code>\n`;
    if (fiatDetails.swiftCode) text += `• <b>SWIFT / BIC:</b> <code>${escape(fiatDetails.swiftCode)}</code>\n`;
    text += `• <b>Account Name:</b> ${escape(fiatDetails.accountName || clientName || "Proxim")}\n`;
    if (fiatAmtStr) text += `• <b>Exact Amount:</b> <code>${escape(fiatAmtStr)}</code>\n`;
  }

  if (hasCrypto) {
    const chainLabel = cryptoPaymentDetails?.chainLabel || "Arc Mainnet";
    const tokenSymbol = cryptoPaymentDetails?.tokenSymbol || "USDC";
    const exactAmt = cryptoPaymentDetails?.exactAmount != null
      ? `${formatMoney(cryptoPaymentDetails.exactAmount)} ${tokenSymbol}`
      : `${formatMoney(totalUsdc)} ${tokenSymbol}`;

    text +=
      `\n🌐 <b>${hasFiat ? "Option 2: " : ""}Pay via Crypto (${escape(chainLabel)} · ${escape(tokenSymbol)})</b>\n` +
      `• <b>Exact Amount:</b> <code>${escape(exactAmt)}</code>\n` +
      `• <b>Network:</b> ${escape(chainLabel)}\n` +
      `• <b>Deposit Address:</b> <code>${escape(cryptoAddr)}</code>\n` +
      (cryptoPaymentDetails?.depositMemo
        ? `• <b>Memo / Tag:</b> <code>${escape(cryptoPaymentDetails.depositMemo)}</code>\n`
        : "");
  }

  text += `\n⚡ <i>Please pay the exact amount shown above for instant automatic confirmation. Powered by Proxim.</i>`;
  return text;
}

/**
 * Generate a dynamically logo-branded 3x Retina invoice PNG with adaptive value sizing & QR code.
 */
async function generateInvoicePNG(data) {
  const theme = await extractBrandThemeFromLogo(data.logoDataUri);

  const qrTarget = data.cryptoPaymentDetails?.depositAddress || data.walletAddress || null;
  let qrDataUri = null;
  if (qrTarget) {
    try {
      qrDataUri = await QRCode.toDataURL(qrTarget, {
        margin: 1,
        width: 140,
        color: {
          dark: theme.primary,
          light: "#ffffff",
        },
      });
    } catch (err) {
      console.warn("[invoice_generator] QR code generation notice:", err.message);
    }
  }

  const svg = buildSvg({ ...data, qrDataUri, theme });
  const outPath = path.join(
    os.tmpdir(),
    `invoice-${data.invoiceNumber}-${Date.now()}.png`
  );
  renderSvgToPngFile(svg, outPath);
  return outPath;
}

module.exports = {
  generateInvoicePNG,
  buildClientInvoiceCopyText,
  extractBrandThemeFromLogo,
  fitFontSize,
  formatCurrencyAmount,
  DEFAULT_THEME,
};
