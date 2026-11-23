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

  // True A4 Portrait executive canvas (680px -> 2040px @ 3x Retina, minH 920px -> 1:1.35 portrait)
  const W = 680;
  const PAD = 42;
  const INNER_W = W - PAD * 2;
  const MIN_PORTRAIT_H = 920;

  const total = items.reduce(
    (s, i) => s + (Number(i.quantity || 1) || 1) * safeNum(i.unitPrice),
    0
  );

  const heroAmountStr = isNgn
    ? `₦${formatMoney(total)}`
    : curSym && !curSym.trim().endsWith(displayCur)
      ? `${curSym}${formatMoney(total)}`
      : `${formatMoney(total)} ${displayCur}`;
  const totalWithCurStr = isNgn
    ? `₦${formatMoney(total)}`
    : curSym && !curSym.trim().endsWith(displayCur)
      ? `${curSym}${formatMoney(total)} ${displayCur}`
      : `${formatMoney(total)} ${displayCur}`;

  const bizNameStr = String(businessName || "Proxim Account").trim();
  const bizInitial = (bizNameStr.replace(/[^A-Za-z0-9]/g, "")[0] || "P").toUpperCase();
  const bizNameFont = fitFontSize(bizNameStr, 260, 19, 13);
  const bizMetaLine = [businessEmail, businessPhone, businessAddress].filter(Boolean).slice(0, 2).join("  ·  ");

  // ── Section Y coordinates (true portrait vertical rhythm) ──────────────────
  const headerTopY = 38;
  const summaryCardY = 128;
  const summaryCardH = 148;

  const tableHeaderY = summaryCardY + summaryCardH + 42;
  let y = tableHeaderY + 36;
  const ROW = 44;

  const itemsSvg = items
    .map((item, idx) => {
      const qty = Number(item.quantity || 1) || 1;
      const price = safeNum(item.unitPrice);
      const lineTotal = qty * price;
      const descText = truncateText(item.description || "Item", 34);
      const priceStr = curSym ? `${curSym}${formatMoney(price)}` : formatMoney(price);
      const lineStr = curSym ? `${curSym}${formatMoney(lineTotal)}` : formatMoney(lineTotal);
      const priceFont = fitFontSize(priceStr, 102, 12.5, 9.0);
      const lineFont = fitFontSize(lineStr, 122, 13, 9.0);
      const divider = idx < items.length - 1
        ? `<line x1="${PAD}" y1="${y + 16}" x2="${W - PAD}" y2="${y + 16}" stroke="#f1f5f9" stroke-width="1"/>`
        : "";

      const row = `
      <text x="${PAD + 4}" y="${y}" font-size="13.5" fill="#0f172a" font-family="${FONT}">${escape(descText)}</text>
      <text x="394" y="${y}" font-size="12.5" fill="#475569" font-family="${FONT}" text-anchor="middle">${qty}</text>
      <text x="508" y="${y}" font-size="${priceFont}" fill="#475569" font-family="${FONT_MONO}" text-anchor="end">${escape(priceStr)}</text>
      <text x="${W - PAD - 4}" y="${y}" font-size="${lineFont}" fill="#0f172a" font-family="${FONT_MONO}" text-anchor="end" font-weight="bold">${escape(lineStr)}</text>
      ${divider}`;
      y += ROW;
      return row;
    })
    .join("");

  // ── Totals Summary Block (refined right-aligned) ───────────────────────────
  const totalsTopY = y + 12;
  const totalCardW = Math.min(340, Math.max(264, totalWithCurStr.length * 13 + 118));
  const totalCardX = W - PAD - totalCardW;
  const totalValueFont = fitFontSize(totalWithCurStr, totalCardW - 120, 17.5, 11.5, 0.64);
  const totalCardH = 54;

  const notesY = totalsTopY + totalCardH + 28;
  const naturalPayY = notes ? notesY + 30 : totalsTopY + totalCardH + 36;

  // ── Payment Cards Layout ───────────────────────────────────────────────────
  const hasFiat = Boolean(fiatDetails && (fiatDetails.accountNumber || fiatDetails.iban));
  const cryptoAddr = cryptoPaymentDetails?.depositAddress || walletAddress || null;
  const hasCrypto = Boolean(cryptoAddr);
  const hasCryptoMemo = Boolean(cryptoPaymentDetails?.depositMemo);

  const hasExtraBankCodes = Boolean(
    hasFiat && (fiatDetails.routingNumber || fiatDetails.sortCode || fiatDetails.swiftCode || (fiatDetails.iban && fiatDetails.accountNumber))
  );
  const fiatBoxHeight = hasFiat ? (hasExtraBankCodes ? 158 : 126) : 0;
  const cryptoBoxHeight = hasCrypto
    ? (qrDataUri ? (hasCryptoMemo ? 186 : 170) : (hasCryptoMemo ? 136 : 118))
    : 0;

  const totalPayHeight =
    (hasFiat ? fiatBoxHeight : 0) +
    (hasFiat && hasCrypto ? 18 : 0) +
    (hasCrypto ? cryptoBoxHeight : 0);

  // Anchor payment block cleanly so short 1-item invoices still have balanced A4 portrait proportions
  const minPayYForPortrait = MIN_PORTRAIT_H - 92 - totalPayHeight;
  const paySectionY = Math.max(naturalPayY, minPayYForPortrait);
  const cryptoBoxY = paySectionY + (hasFiat ? fiatBoxHeight + 18 : 0);

  const afterPayY = paySectionY + totalPayHeight;
  const footerY = afterPayY + 34;
  const H = Math.max(MIN_PORTRAIT_H, footerY + 58);

  // ── Logo or Bespoke Brand Monogram Badge ───────────────────────────────────
  const brandMarkSvg = logoDataUri
    ? `
    <rect x="${PAD}" y="${headerTopY}" width="52" height="52" rx="14" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.2"/>
    <image href="${logoDataUri}" x="${PAD + 5}" y="${headerTopY + 5}" width="42" height="42" preserveAspectRatio="xMidYMid meet"/>`
    : `
    <rect x="${PAD}" y="${headerTopY}" width="52" height="52" rx="14" fill="url(#brandGrad)"/>
    <text x="${PAD + 26}" y="${headerTopY + 35}" font-size="24" font-weight="bold" fill="#ffffff" font-family="${FONT}" text-anchor="middle">${escape(bizInitial)}</text>`;

  // ── Hero Amount Sizing (inside Summary Card top row) ───────────────────────
  const heroFont = fitFontSize(heroAmountStr, 340, 30, 17, 0.62);
  const statusPillText = dueDate ? `DUE ${dueDate}` : "DUE ON RECEIPT";
  const statusPillW = Math.min(168, Math.max(112, statusPillText.length * 7.2 + 28));

  // ── Fiat / Global Bank Checkout Card ───────────────────────────────────────
  let fiatSectionSvg = "";
  if (hasFiat) {
    const fiatCur = String(fiatDetails.currency || "NGN").toUpperCase();
    const railTag = fiatDetails.railHint ? ` · ${String(fiatDetails.railHint).toUpperCase()}` : "";
    const fiatBadge = `${hasCrypto ? "OPTION 1 · " : ""}${fiatCur} BANK TRANSFER${railTag}`;

    const primaryNumLabel = fiatDetails.accountNumber ? "ACCOUNT NUMBER" : "IBAN";
    const primaryNumVal = fiatDetails.accountNumber || fiatDetails.iban;
    const primaryNumFont = fitFontSize(primaryNumVal, 250, 13.5, 9.5, 0.62);

    const fiatAmtFormatted = fiatDetails.fiatAmount != null
      ? formatCurrencyAmount(fiatDetails.fiatAmount, fiatCur)
      : "Per Invoice";
    const fiatAmtFont = fitFontSize(fiatAmtFormatted, 220, 13.5, 10.0, 0.62);

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

    const extraLineFont = fitFontSize(extraPlainParts.join("   ·   "), INNER_W - 44, 11, 8.2, 0.58);
    const extraLineSvg = hasExtraBankCodes
      ? `
      <line x1="${PAD + 20}" y1="${paySectionY + 118}" x2="${W - PAD - 20}" y2="${paySectionY + 118}" stroke="${theme.tintBorder}" stroke-width="1"/>
      <text x="${PAD + 20}" y="${paySectionY + 140}" font-size="${extraLineFont}" fill="#475569" font-family="${FONT}">${extraParts.join("   ·   ")}</text>`
      : "";

    fiatSectionSvg = `
    <rect x="${PAD}" y="${paySectionY}" width="${INNER_W}" height="${fiatBoxHeight}" fill="#ffffff" rx="14" stroke="${theme.tintBorder}" stroke-width="1.4"/>
    <rect x="${PAD}" y="${paySectionY}" width="${INNER_W}" height="34" fill="${theme.tintBg}" rx="14"/>
    <rect x="${PAD}" y="${paySectionY + 20}" width="${INNER_W}" height="14" fill="${theme.tintBg}"/>
    <line x1="${PAD}" y1="${paySectionY + 34}" x2="${W - PAD}" y2="${paySectionY + 34}" stroke="${theme.tintBorder}" stroke-width="1"/>
    <circle cx="${PAD + 20}" cy="${paySectionY + 17}" r="4" fill="${theme.accent}"/>
    <text x="${PAD + 32}" y="${paySectionY + 21}" font-size="10.5" font-weight="bold" fill="${theme.primary}" font-family="${FONT}" letter-spacing="0.6">${escape(truncateText(fiatBadge, 62))}</text>

    <text x="${PAD + 20}" y="${paySectionY + 56}" font-size="9" font-weight="bold" fill="#94a3b8" font-family="${FONT}" letter-spacing="0.8">BANK NAME</text>
    <text x="${PAD + 20}" y="${paySectionY + 75}" font-size="12.5" font-weight="bold" fill="#0f172a" font-family="${FONT}">${escape(truncateText(fiatDetails.bankName || "Partner Bank", 28))}</text>

    <text x="${PAD + 300}" y="${paySectionY + 56}" font-size="9" font-weight="bold" fill="#94a3b8" font-family="${FONT}" letter-spacing="0.8">${primaryNumLabel}</text>
    <text x="${PAD + 300}" y="${paySectionY + 76}" font-size="${primaryNumFont}" font-weight="bold" fill="${theme.primary}" font-family="${FONT_MONO}">${escape(primaryNumVal)}</text>

    <text x="${PAD + 20}" y="${paySectionY + 99}" font-size="9" font-weight="bold" fill="#94a3b8" font-family="${FONT}" letter-spacing="0.8">ACCOUNT HOLDER</text>
    <text x="${PAD + 20}" y="${paySectionY + 114}" font-size="12" font-weight="bold" fill="#334155" font-family="${FONT}">${escape(truncateText(fiatDetails.accountName || clientName, 28))}</text>

    <text x="${PAD + 300}" y="${paySectionY + 99}" font-size="9" font-weight="bold" fill="#94a3b8" font-family="${FONT}" letter-spacing="0.8">EXACT AMOUNT</text>
    <text x="${PAD + 300}" y="${paySectionY + 114}" font-size="${fiatAmtFont}" font-weight="bold" fill="${theme.accent}" font-family="${FONT_MONO}">${escape(fiatAmtFormatted)}</text>
    ${extraLineSvg}
  `;
  }

  // ── On-Chain / NEAR Intents Crypto Checkout Card ───────────────────────────
  let cryptoSectionSvg = "";
  if (hasCrypto) {
    const chainLabel = cryptoPaymentDetails?.chainLabel || "Arc Mainnet";
    const tokenSymbol = cryptoPaymentDetails?.tokenSymbol || (isNgn ? "USDC" : displayCur);
    const exactCryptoAmt = cryptoPaymentDetails?.exactAmount != null
      ? `${formatMoney(cryptoPaymentDetails.exactAmount)} ${tokenSymbol}`
      : `${formatMoney(total)} ${tokenSymbol}`;
    const viaTag = cryptoPaymentDetails?.viaNearIntents ? " · NEAR INTENTS" : "";
    const cryptoBadge = `${hasFiat ? "OPTION 2 · " : ""}${chainLabel.toUpperCase()} (${tokenSymbol})${viaTag}`;

    const qrCardX = W - PAD - 124;
    const qrCardY = cryptoBoxY + 46;
    const qrImageSvg = qrDataUri
      ? `
    <rect x="${qrCardX}" y="${qrCardY}" width="106" height="108" rx="10" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.2"/>
    <image href="${qrDataUri}" x="${qrCardX + 8}" y="${qrCardY + 6}" width="90" height="90" preserveAspectRatio="xMidYMid meet"/>
    <text x="${qrCardX + 53}" y="${qrCardY + 104}" font-size="7.5" font-weight="bold" fill="#94a3b8" font-family="${FONT}" text-anchor="middle" letter-spacing="0.8">SCAN TO PAY</text>`
      : "";

    const addrBoxW = qrDataUri ? INNER_W - 158 : INNER_W - 40;
    const addrFont = fitFontSize(cryptoAddr, addrBoxW - 22, 11, 7.5, 0.62);
    const memoSvg = hasCryptoMemo
      ? `<text x="${PAD + 20}" y="${cryptoBoxY + 134}" font-size="11" fill="#475569" font-family="${FONT}">Memo / Tag: <tspan font-weight="bold" fill="${theme.primary}" font-family="${FONT_MONO}">${escape(truncateText(cryptoPaymentDetails.depositMemo, 38))}</tspan></text>`
      : "";
    const hintY = hasCryptoMemo ? cryptoBoxY + 154 : cryptoBoxY + 138;
    const hintText = cryptoPaymentDetails?.viaNearIntents
      ? `Auto-converts and settles instantly via NEAR Intents.`
      : `Dedicated single-invoice address · settles on ${chainLabel}.`;

    cryptoSectionSvg = `
    <rect x="${PAD}" y="${cryptoBoxY}" width="${INNER_W}" height="${cryptoBoxHeight}" fill="#ffffff" rx="14" stroke="#e2e8f0" stroke-width="1.4"/>
    <rect x="${PAD}" y="${cryptoBoxY}" width="${INNER_W}" height="34" fill="#f8fafc" rx="14"/>
    <rect x="${PAD}" y="${cryptoBoxY + 20}" width="${INNER_W}" height="14" fill="#f8fafc"/>
    <line x1="${PAD}" y1="${cryptoBoxY + 34}" x2="${W - PAD}" y2="${cryptoBoxY + 34}" stroke="#e2e8f0" stroke-width="1"/>
    <circle cx="${PAD + 20}" cy="${cryptoBoxY + 17}" r="4" fill="${theme.primary}"/>
    <text x="${PAD + 32}" y="${cryptoBoxY + 21}" font-size="10.5" font-weight="bold" fill="${theme.primary}" font-family="${FONT}" letter-spacing="0.6">${escape(truncateText(cryptoBadge, 58))}</text>

    <text x="${PAD + 20}" y="${cryptoBoxY + 60}" font-size="12" fill="#475569" font-family="${FONT}">Send exact <tspan font-weight="bold" fill="${theme.primary}">${escape(exactCryptoAmt)}</tspan> on <tspan font-weight="bold" fill="#0f172a">${escape(chainLabel)}</tspan>:</text>
    <rect x="${PAD + 20}" y="${cryptoBoxY + 72}" width="${addrBoxW}" height="38" fill="#f8fafc" rx="9" stroke="#cbd5e1" stroke-width="1"/>
    <text x="${PAD + 31}" y="${cryptoBoxY + 95}" font-size="${addrFont}" font-weight="bold" fill="#0f172a" font-family="${FONT_MONO}">${escape(cryptoAddr)}</text>
    ${memoSvg}
    <text x="${PAD + 20}" y="${hintY}" font-size="10" fill="#64748b" font-family="${FONT}">${escape(truncateText(hintText, 62))}</text>
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
    <linearGradient id="brandGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${theme.primary}"/>
      <stop offset="100%" stop-color="${theme.accent}"/>
    </linearGradient>
    <linearGradient id="topAccentBar" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${theme.primary}"/>
      <stop offset="65%" stop-color="${theme.accent}"/>
      <stop offset="100%" stop-color="${theme.primary}"/>
    </linearGradient>
  </defs>

  <!-- Crisp Editorial Portrait Paper Card -->
  <rect width="${W}" height="${H}" fill="#ffffff" rx="18"/>

  <!-- Sleek Top Brand Accent Ribbon -->
  <rect x="0" y="0" width="${W}" height="7" fill="url(#topAccentBar)" rx="3"/>
  <rect x="0" y="4" width="${W}" height="3" fill="url(#topAccentBar)"/>

  <!-- Executive Header: Brand Identity (Left) + Invoice Wordmark (Right) -->
  ${brandMarkSvg}

  <text x="${PAD + 66}" y="${headerTopY + 23}" font-size="${bizNameFont}" font-weight="bold" fill="#0f172a" font-family="${FONT}">${escape(bizNameStr)}</text>
  ${bizMetaLine ? `<text x="${PAD + 66}" y="${headerTopY + 42}" font-size="10.5" fill="#64748b" font-family="${FONT}">${escape(truncateText(bizMetaLine, 46))}</text>` : ""}

  <text x="${W - PAD}" y="${headerTopY + 22}" font-size="24" font-weight="bold" fill="${theme.primary}" font-family="${FONT}" text-anchor="end" letter-spacing="1.5">INVOICE</text>
  <text x="${W - PAD}" y="${headerTopY + 42}" font-size="12" font-weight="bold" fill="#64748b" font-family="${FONT_MONO}" text-anchor="end">#${escape(invoiceNumber)}</text>

  <!-- Subtle Hairline -->
  <line x1="${PAD}" y1="110" x2="${W - PAD}" y2="110" stroke="#f1f5f9" stroke-width="1.2"/>

  <!-- 2-Row Portrait Summary Card: Hero Amount Due (Top) + Billed To & Dates (Bottom) -->
  <rect x="${PAD}" y="${summaryCardY}" width="${INNER_W}" height="${summaryCardH}" fill="#f8fafc" rx="14" stroke="#e2e8f0" stroke-width="1.1"/>

  <!-- Top Row: Hero Amount Due + Status Pill -->
  <text x="${PAD + 22}" y="${summaryCardY + 24}" font-size="9.5" font-weight="bold" fill="#94a3b8" font-family="${FONT}" letter-spacing="1">AMOUNT DUE (${escape(displayCur)})</text>
  <text x="${PAD + 22}" y="${summaryCardY + 58}" font-size="${heroFont}" font-weight="bold" fill="${theme.primary}" font-family="${FONT_MONO}">${escape(heroAmountStr)}</text>

  <rect x="${W - PAD - 22 - statusPillW}" y="${summaryCardY + 28}" width="${statusPillW}" height="24" rx="12" fill="${theme.tintBg}" stroke="${theme.tintBorder}" stroke-width="1.1"/>
  <text x="${W - PAD - 22 - statusPillW / 2}" y="${summaryCardY + 43.5}" font-size="9" font-weight="bold" fill="${theme.accent}" font-family="${FONT}" text-anchor="middle" letter-spacing="0.6">${escape(statusPillText)}</text>

  <!-- Horizontal Divider inside Summary Card -->
  <line x1="${PAD + 22}" y1="${summaryCardY + 76}" x2="${W - PAD - 22}" y2="${summaryCardY + 76}" stroke="#e2e8f0" stroke-width="1"/>

  <!-- Bottom Row: Billed To (Left) + Issued & Due Date (Right) -->
  <text x="${PAD + 22}" y="${summaryCardY + 98}" font-size="9" font-weight="bold" fill="#94a3b8" font-family="${FONT}" letter-spacing="1">BILLED TO</text>
  <text x="${PAD + 22}" y="${summaryCardY + 120}" font-size="15.5" font-weight="bold" fill="#0f172a" font-family="${FONT}">${escape(truncateText(clientName, 28))}</text>
  ${clientEmail ? `<text x="${PAD + 22}" y="${summaryCardY + 137}" font-size="10.5" fill="#64748b" font-family="${FONT}">${escape(truncateText(clientEmail, 34))}</text>` : ""}

  <text x="${PAD + 336}" y="${summaryCardY + 98}" font-size="9" font-weight="bold" fill="#94a3b8" font-family="${FONT}" letter-spacing="1">ISSUED</text>
  <text x="${PAD + 336}" y="${summaryCardY + 119}" font-size="12.5" font-weight="bold" fill="#334155" font-family="${FONT_MONO}">${escape(issueDate)}</text>

  <text x="${W - PAD - 22}" y="${summaryCardY + 98}" font-size="9" font-weight="bold" fill="#94a3b8" font-family="${FONT}" text-anchor="end" letter-spacing="1">DUE DATE</text>
  <text x="${W - PAD - 22}" y="${summaryCardY + 119}" font-size="12.5" font-weight="bold" fill="${dueDate ? "#b91c1c" : "#334155"}" font-family="${FONT_MONO}" text-anchor="end">${escape(dueDate || "On receipt")}</text>

  <!-- Editorial Line Items Table -->
  <text x="${PAD + 4}" y="${tableHeaderY}" font-size="9.5" font-weight="bold" fill="#94a3b8" font-family="${FONT}" letter-spacing="1">DESCRIPTION</text>
  <text x="394" y="${tableHeaderY}" font-size="9.5" font-weight="bold" fill="#94a3b8" font-family="${FONT}" text-anchor="middle" letter-spacing="1">QTY</text>
  <text x="508" y="${tableHeaderY}" font-size="9.5" font-weight="bold" fill="#94a3b8" font-family="${FONT}" text-anchor="end" letter-spacing="1">RATE</text>
  <text x="${W - PAD - 4}" y="${tableHeaderY}" font-size="9.5" font-weight="bold" fill="#94a3b8" font-family="${FONT}" text-anchor="end" letter-spacing="1">AMOUNT</text>
  <line x1="${PAD}" y1="${tableHeaderY + 11}" x2="${W - PAD}" y2="${tableHeaderY + 11}" stroke="${theme.primary}" stroke-width="1.6"/>

  <!-- Line Items -->
  ${itemsSvg}

  <!-- Clean Total Due Pill -->
  <line x1="${PAD}" y1="${totalsTopY - 12}" x2="${W - PAD}" y2="${totalsTopY - 12}" stroke="#e2e8f0" stroke-width="1.2"/>
  <rect x="${totalCardX}" y="${totalsTopY}" width="${totalCardW}" height="${totalCardH}" fill="${theme.tintBg}" rx="12" stroke="${theme.tintBorder}" stroke-width="1.3"/>
  <rect x="${totalCardX + 10}" y="${totalsTopY + 13}" width="4" height="${totalCardH - 26}" fill="${theme.accent}" rx="2"/>
  <text x="${totalCardX + 24}" y="${totalsTopY + 32}" font-size="10.5" font-weight="bold" fill="#475569" font-family="${FONT}" letter-spacing="0.9">TOTAL DUE</text>
  <text x="${W - PAD - 18}" y="${totalsTopY + 34}" font-size="${totalValueFont}" font-weight="bold" fill="${theme.primary}" font-family="${FONT_MONO}" text-anchor="end">${escape(totalWithCurStr)}</text>

  ${notes ? `<text x="${PAD}" y="${notesY}" font-size="11.5" fill="#475569" font-family="${FONT}"><tspan font-weight="bold" fill="#0f172a">Note:</tspan> ${escape(truncateText(notes, 84))}</text>` : ""}

  <!-- Elevated Payment Checkout Card(s) -->
  ${fiatSectionSvg}
  ${cryptoSectionSvg}

  <!-- Refined Footer -->
  <line x1="${PAD}" y1="${footerY}" x2="${W - PAD}" y2="${footerY}" stroke="#f1f5f9" stroke-width="1.2"/>
  <circle cx="${W / 2 - 72}" cy="${footerY + 27}" r="3.5" fill="${theme.accent}"/>
  <text x="${W / 2 + 6}" y="${footerY + 31}" font-size="11.5" font-weight="bold" fill="#64748b" font-family="${FONT}" text-anchor="middle" letter-spacing="0.3">Powered by Proxim</text>

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
