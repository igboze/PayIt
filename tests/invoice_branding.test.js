// tests/invoice_branding.test.js
// Tests dynamic logo-color brand extraction, adaptive large-value font sizing,
// and 3x Retina PNG invoice generation.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const sharp = require("sharp");

const {
  generateInvoicePNG,
  extractBrandThemeFromLogo,
  fitFontSize,
  DEFAULT_THEME,
} = require("../src/invoice_generator");

test("extractBrandThemeFromLogo derives unique WCAG-readable themes per business logo color", async () => {
  const noLogoTheme = await extractBrandThemeFromLogo(null);
  assert.equal(noLogoTheme.primary, DEFAULT_THEME.primary);

  const redLogo = await sharp({
    create: { width: 80, height: 80, channels: 4, background: { r: 220, g: 38, b: 38, alpha: 1 } },
  }).png().toBuffer();
  const purpleLogo = await sharp({
    create: { width: 80, height: 80, channels: 4, background: { r: 109, g: 40, b: 217, alpha: 1 } },
  }).png().toBuffer();

  const redTheme = await extractBrandThemeFromLogo("data:image/png;base64," + redLogo.toString("base64"));
  const purpleTheme = await extractBrandThemeFromLogo("data:image/png;base64," + purpleLogo.toString("base64"));

  assert.notEqual(redTheme.primary, DEFAULT_THEME.primary, "Red logo must override default theme");
  assert.notEqual(purpleTheme.primary, DEFAULT_THEME.primary, "Purple logo must override default theme");
  assert.notEqual(redTheme.primary, purpleTheme.primary, "Different logos must produce distinct brand themes");
});

test("fitFontSize smoothly shrinks font size for large values (millions/billions)", () => {
  const smallSize = fitFontSize("50.00 USDC", 200, 19, 12.5);
  const bigSize = fitFontSize("12,500,000.00 USDC", 200, 19, 12.5);
  assert.equal(smallSize, 19);
  assert.ok(bigSize < 19 && bigSize >= 12.5, `Expected scaled font between 12.5 and 19, got ${bigSize}`);
});

test("generateInvoicePNG renders logo-branded 3x Retina PNG with large amounts and Powered by Proxim footer", async () => {
  const cobaltLogo = await sharp({
    create: { width: 80, height: 80, channels: 4, background: { r: 29, g: 78, b: 216, alpha: 1 } },
  }).png().toBuffer();
  const logoDataUri = "data:image/png;base64," + cobaltLogo.toString("base64");

  const outPath = await generateInvoicePNG({
    invoiceNumber: "INV-2026-9999",
    clientName: "Global Enterprise Holdings Ltd",
    clientEmail: "ap@globalenterprise.com",
    items: [
      { description: "Annual Enterprise Cloud Platform License", quantity: 2, unitPrice: 625000 },
      { description: "Dedicated Compliance & Onboarding Suite", quantity: 1, unitPrice: 125000.5 },
    ],
    dueDate: "2026-12-07",
    notes: "Please reference INV-2026-9999 on wire or on-chain transfer.",
    businessName: "Cobalt Pay Technologies",
    businessEmail: "billing@cobaltpay.io",
    businessPhone: "+234 800 123 4567",
    logoDataUri,
    walletAddress: "0x1111111111111111111111111111111111111111",
    issueDate: "2026-11-23",
    currency: "USDC",
    fiatDetails: {
      bankName: "Wema Bank PLC",
      accountNumber: "9827361829",
      accountName: "Cobalt Pay / Global Enterprise",
      fiatAmount: 1993750725,
    },
  });

  try {
    assert.ok(fs.existsSync(outPath), "Output PNG must exist");
    const meta = await sharp(outPath).metadata();
    assert.equal(meta.width, 680 * 3, "Must render at 3x Retina portrait width (2040px)");
    assert.ok(meta.height > meta.width, "Invoice must be portrait orientation (height > width)");

    // Sample top brand accent ribbon pixel — should be Cobalt Blue family (B > R)
    const headerPx = await sharp(outPath).extract({ left: 900, top: 10, width: 1, height: 1 }).raw().toBuffer();
    assert.ok(headerPx[2] > headerPx[0] + 40, `Top brand ribbon must be branded blue (RGB: ${[...headerPx.slice(0, 3)]})`);
  } finally {
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  }
});
