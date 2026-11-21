// src/chain_logo_generator.js
// Renders authentic official vector logos for supported blockchains and tokens
// (Ethereum, Solana, Base, Arbitrum, Optimism, Polygon, Avalanche, NEAR, Starknet,
// Bitcoin, Tron, BNB Chain, USDC, USDT) on a Proxim Global Neobank visual card.
// Replaces abstract color-circle / cartoon emojis with authentic vector brand marks.

const path = require("node:path");
const os = require("node:os");
const { getFontCss, FONT, FONT_MONO } = require("./svg_fonts");
const { renderSvgToPngFile } = require("./svg_render");

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
 * Return authentic vector SVG mark centered at (0, 0) within a 64x64 coordinate box (-32..32).
 */
function getAuthenticLogoVector(key) {
  const k = String(key || "").toLowerCase();

  switch (k) {
    case "base":
      // Official Base (#0052FF) blue circle with white circle & horizontal left-split cut
      return `
        <circle cx="0" cy="0" r="28" fill="#0052FF" />
        <circle cx="0" cy="0" r="17" fill="#FFFFFF" />
        <rect x="-20" y="-3.2" width="21" height="6.4" fill="#0052FF" />
      `;

    case "ethereum":
    case "eth":
    case "weth":
      // Official Ethereum (#627EEA) badge with 6-facet 3D crystal octahedron
      return `
        <circle cx="0" cy="0" r="28" fill="#627EEA" />
        <polygon points="0,-20 -12,0 0,5" fill="#FFFFFF" fill-opacity="0.95" />
        <polygon points="0,-20 12,0 0,5" fill="#FFFFFF" fill-opacity="0.65" />
        <polygon points="0,-6 -12,0 0,5" fill="#FFFFFF" fill-opacity="0.80" />
        <polygon points="0,-6 12,0 0,5" fill="#FFFFFF" fill-opacity="0.50" />
        <polygon points="0,8 -12,2 0,20" fill="#FFFFFF" fill-opacity="0.95" />
        <polygon points="0,8 12,2 0,20" fill="#FFFFFF" fill-opacity="0.65" />
      `;

    case "solana":
    case "sol":
      // Official Solana (#14F195 -> #9945FF) 3 angled parallelogram bars on dark badge
      return `
        <circle cx="0" cy="0" r="28" fill="#0B0E14" stroke="#232B38" stroke-width="1.5" />
        <path d="M -13,-14 L 15,-14 L 11,-8 L -17,-8 Z" fill="url(#solGrad)" />
        <path d="M -17,-3 L 11,-3 L 15,3 L -13,3 Z" fill="url(#solGrad)" />
        <path d="M -13,8 L 15,8 L 11,14 L -17,14 Z" fill="url(#solGrad)" />
      `;

    case "arbitrum":
      // Official Arbitrum One hexagon shield (#213147) with cyan (#12AAFF) & white slashes
      return `
        <circle cx="0" cy="0" r="28" fill="#1B2838" stroke="#28A0F0" stroke-width="2" />
        <polygon points="0,-21 18,-10 18,10 0,21 -18,10 -18,-10" fill="#213147" stroke="#28A0F0" stroke-width="1.5" />
        <path d="M -4,-13 L 2,-13 L -9,13 L -15,13 Z" fill="#FFFFFF" />
        <path d="M 4,-13 L 10,-13 L 1,10 L -5,10 Z" fill="#FFFFFF" />
        <path d="M 5,-4 L 10,-4 L 15,12 L 9,12 Z" fill="#12AAFF" />
      `;

    case "polygon":
      // Official Polygon (#8247E5) purple badge with interlocking isometric infinity loop
      return `
        <circle cx="0" cy="0" r="28" fill="#8247E5" />
        <path
          d="M 7,-8 L 15,-3 L 15,7 L 7,12 L -1,7 L -1,-7 L -9,-12 L -17,-7 L -17,3 L -9,8 L -4,5"
          fill="none"
          stroke="#FFFFFF"
          stroke-width="4.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      `;

    case "optimism":
      // Official Optimism (#FF0420) red circle with bold white "OP" mark
      return `
        <circle cx="0" cy="0" r="28" fill="#FF0420" />
        <text x="0" y="7" text-anchor="middle" fill="#FFFFFF" font-family="${FONT}" font-size="20" font-weight="700" font-style="italic" letter-spacing="-0.5">OP</text>
      `;

    case "avalanche":
      // Official Avalanche (#E84142) red circle with white "A" mountain peak & right triangle
      return `
        <circle cx="0" cy="0" r="28" fill="#E84142" />
        <path d="M -2,-15 L 4,-15 L 11,-2 L 2,13 L -15,13 Z" fill="#FFFFFF" />
        <polygon points="10,2 17,13 3,13" fill="#FFFFFF" />
      `;

    case "near":
      // Official NEAR Protocol geometric "N" ribbon mark on dark-emerald/black circle
      return `
        <circle cx="0" cy="0" r="28" fill="#0D1117" stroke="#00EC97" stroke-width="1.8" />
        <path
          d="M -13,14 L -13,-14 L -8,-14 L 9,8 L 9,-14 L 14,-14 L 14,14 L 9,14 L -8,-8 L -8,14 Z"
          fill="#FFFFFF"
        />
      `;

    case "starknet":
    case "strk":
      // Official Starknet (#0C0C4F) navy badge with coral (#EC796B) & white star-orbit emblem
      return `
        <circle cx="0" cy="0" r="28" fill="#0C0C4F" stroke="#3B3B8F" stroke-width="1.8" />
        <path d="M -16,4 C -6,-12 8,-14 17,-8 C 9,-6 -2,2 -10,12 Z" fill="#FFFFFF" />
        <path d="M -12,12 C 0,6 10,0 16,-8 C 12,4 2,12 -12,12 Z" fill="#EC796B" />
        <circle cx="11" cy="-12" r="3.5" fill="#EC796B" />
      `;

    case "bitcoin":
    case "btc":
    case "wbtc":
      // Official Bitcoin (#F7931A) orange circle with pure vector white "B" & vertical bars
      return `
        <circle cx="0" cy="0" r="28" fill="#F7931A" />
        <rect x="-5" y="-19" width="3.2" height="38" rx="1" fill="#FFFFFF" />
        <rect x="2" y="-19" width="3.2" height="38" rx="1" fill="#FFFFFF" />
        <path
          d="M -10,-14 L 4,-14 C 10,-14 13,-11 13,-6.5 C 13,-3 10.5,-1 7,-0.5 C 11.5,0 14,2.5 14,6.8 C 14,11.5 10.5,14 4,14 L -10,14 L -10,-14 Z
             M -4.5,-9 L -4.5,-2 L 3,-2 C 6,-2 7.5,-3.5 7.5,-5.5 C 7.5,-7.5 6,-9 3,-9 L -4.5,-9 Z
             M -4.5,2.5 L -4.5,9.5 L 3.8,9.5 C 7,9.5 8.5,8 8.5,6 C 8.5,4 7,2.5 3.8,2.5 L -4.5,2.5 Z"
          fill="#FFFFFF"
          fill-rule="evenodd"
        />
      `;

    case "tron":
      // Official TRON (#FF0013) red circle with geometric white delta wireframe
      return `
        <circle cx="0" cy="0" r="28" fill="#EB0029" />
        <polygon points="-14,-12 15,-5 -3,16" fill="none" stroke="#FFFFFF" stroke-width="2.5" stroke-linejoin="round" />
        <line x1="-14" y1="-12" x2="3" y2="-1" stroke="#FFFFFF" stroke-width="2" />
        <line x1="15" y1="-5" x2="3" y2="-1" stroke="#FFFFFF" stroke-width="2" />
        <line x1="-3" y1="16" x2="3" y2="-1" stroke="#FFFFFF" stroke-width="2" />
      `;

    case "bsc":
    case "bnb":
      // Official BNB Chain (#F3BA2F) gold badge with white diamond lattice
      return `
        <circle cx="0" cy="0" r="28" fill="#F3BA2F" />
        <polygon points="0,-16 6,-10 0,-4 -6,-10" fill="#FFFFFF" />
        <polygon points="0,4 6,10 0,16 -6,10" fill="#FFFFFF" />
        <polygon points="-12,-4 -7,0 -12,4 -17,0" fill="#FFFFFF" />
        <polygon points="12,-4 17,0 12,4 7,0" fill="#FFFFFF" />
        <polygon points="0,-4 4,0 0,4 -4,0" fill="#FFFFFF" />
      `;

    case "usdc":
      // Official Circle USD Coin (#2775CA) blue circle with white "$" and outer coin brackets
      return `
        <circle cx="0" cy="0" r="28" fill="#2775CA" />
        <path d="M -11,-17 A 20,20 0 0,0 -11,17" fill="none" stroke="#FFFFFF" stroke-width="3.2" stroke-linecap="round" />
        <path d="M 11,-17 A 20,20 0 0,1 11,17" fill="none" stroke="#FFFFFF" stroke-width="3.2" stroke-linecap="round" />
        <text x="0" y="9" text-anchor="middle" fill="#FFFFFF" font-family="${FONT}" font-size="25" font-weight="700">$</text>
      `;

    case "usdt":
      // Official Tether (#26A17B) teal circle with white "T" and horizontal oval ring
      return `
        <circle cx="0" cy="0" r="28" fill="#26A17B" />
        <rect x="-13" y="-14" width="26" height="4.5" rx="1.5" fill="#FFFFFF" />
        <rect x="-3" y="-12" width="6" height="26" rx="1.5" fill="#FFFFFF" />
        <ellipse cx="0" cy="-2" rx="15" ry="4.5" fill="none" stroke="#FFFFFF" stroke-width="2.5" />
      `;

    default:
      return `
        <circle cx="0" cy="0" r="28" fill="#045D32" stroke="#1CF081" stroke-width="2" />
        <text x="0" y="7" text-anchor="middle" fill="#FFFFFF" font-family="${FONT}" font-size="16" font-weight="700">${escapeXml(k.slice(0, 4).toUpperCase())}</text>
      `;
  }
}

/**
 * Build a multi-network & token visual banner SVG (1024 x 440) displaying
 * authentic vector logos for all supported blockchains and digital assets.
 */
function buildCryptoNetworksBannerSvg({ mode = "deposit" } = {}) {
  const isWithdraw = mode === "withdraw";
  const title = isWithdraw
    ? "EXTERNAL NETWORK WITHDRAWALS"
    : "SUPPORTED BLOCKCHAINS & DIGITAL ASSETS";
  const subtitle = isWithdraw
    ? "Instant 1:1 USD settlement across major networks"
    : "Every deposit automatically settles as Dollars ($) in your Proxim account";

  const row1 = [
    { key: "base", label: "Base" },
    { key: "ethereum", label: "Ethereum" },
    { key: "solana", label: "Solana" },
    { key: "arbitrum", label: "Arbitrum" },
    { key: "polygon", label: "Polygon" },
    { key: "optimism", label: "Optimism" },
  ];

  const row2 = isWithdraw
    ? [
        { key: "avalanche", label: "Avalanche" },
        { key: "bitcoin", label: "Bitcoin" },
        { key: "tron", label: "Tron" },
        { key: "near", label: "NEAR" },
        { key: "usdc", label: "USDC" },
        { key: "usdt", label: "USDT" },
      ]
    : [
        { key: "avalanche", label: "Avalanche" },
        { key: "near", label: "NEAR" },
        { key: "starknet", label: "Starknet" },
        { key: "usdc", label: "USDC" },
        { key: "usdt", label: "USDT" },
        { key: "btc", label: "WBTC / BTC" },
      ];

  const renderBadgeRow = (items, centerY) => {
    const startX = 112;
    const stepX = 160;
    return items
      .map((item, idx) => {
        const cx = startX + idx * stepX;
        return `
          <g transform="translate(${cx}, ${centerY})">
            <rect x="-66" y="-46" width="132" height="112" rx="18" fill="#032C18" fill-opacity="0.88" stroke="#157A46" stroke-width="1.5" />
            <g transform="translate(0, -8)">
              ${getAuthenticLogoVector(item.key)}
            </g>
            <text x="0" y="46" text-anchor="middle" fill="#E8FFF3" font-family="${FONT}" font-size="16" font-weight="700">${escapeXml(item.label)}</text>
          </g>
        `;
      })
      .join("\n");
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 440" width="1024" height="440">
  <defs>
    <style>${getFontCss()}</style>
    <linearGradient id="bgCard" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#012413" />
      <stop offset="50%" stop-color="#034424" />
      <stop offset="100%" stop-color="#011B0E" />
    </linearGradient>
    <linearGradient id="solGrad" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#9945FF" />
      <stop offset="50%" stop-color="#14F195" />
      <stop offset="100%" stop-color="#00C2FF" />
    </linearGradient>
  </defs>

  <rect x="12" y="12" width="1000" height="416" rx="32" fill="url(#bgCard)" stroke="#19D674" stroke-width="2" />

  <!-- Header -->
  <text x="56" y="64" fill="#1CF081" font-family="${FONT}" font-size="18" font-weight="700" letter-spacing="3">PROXIM GLOBAL NEOBANK · ${escapeXml(title)}</text>
  <text x="56" y="96" fill="#B8E6CE" font-family="${FONT}" font-size="18" font-weight="400">${escapeXml(subtitle)}</text>

  <!-- Row 1 Authentic Logos -->
  ${renderBadgeRow(row1, 182)}

  <!-- Row 2 Authentic Logos -->
  ${renderBadgeRow(row2, 322)}
</svg>`;
}

/**
 * Render the multi-network authentic logos banner PNG to os.tmpdir().
 */
async function generateCryptoNetworksBannerPNG(opts = {}) {
  const svg = buildCryptoNetworksBannerSvg(opts);
  const outPath = path.join(os.tmpdir(), `proxim_chains_${opts.mode || "deposit"}_${Date.now()}.png`);
  renderSvgToPngFile(svg, outPath, { zoom: 1.5 });
  return outPath;
}

module.exports = {
  getAuthenticLogoVector,
  buildCryptoNetworksBannerSvg,
  generateCryptoNetworksBannerPNG,
};
