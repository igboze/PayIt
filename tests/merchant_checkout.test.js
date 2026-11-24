// tests/merchant_checkout.test.js
// End-to-end test for Proxim Merchant Payment Acceptance:
// - Headless & Hosted Checkout Sessions (NGN Bank + NEAR Intents Crypto)
// - White-labeled Hosted Checkout HTML (/checkout/:sessionId)
// - Drop-in JS Embed SDK (/sdk/proxim-checkout.js)
// - Reusable Payment Links (/api/v1/payment-links + /pay/:slug)
// - Public status polling + HMAC-SHA256 checkout.session.completed webhook + tenant isolation

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

process.env.PAYIT_DB_PATH = path.join(os.tmpdir(), `test_merchant_checkout_${Date.now()}.db`);
process.env.NODE_ENV = "test";

const db = require("../src/db");
const apiKeys = require("../src/api_keys");
const paj = require("../src/paj");
const nearLib = require("../src/near");
const merchantCheckout = require("../src/merchant_checkout");
const webhookServer = require("../src/webhook_server");

function httpReq(port, method, reqPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: reqPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

test("Merchant Checkout Sessions, Hosted UI, Drop-in SDK, Payment Links & Tenant Isolation", async () => {
  // Stub Paj + NEAR Intents so test runs fast & offline
  const origRates = paj.getRates;
  const origOnramp = paj.createOnrampOrder;
  const origSolDep = nearLib.createSolanaDeposit;
  const origDispatch = apiKeys.dispatchBuilderWebhook;

  const webhookCalls = [];
  paj.getRates = async () => ({ onRampRate: { rate: 1500 } });
  paj.createOnrampOrder = async (p) => ({
    id: "paj_ord_1",
    bank: "Wema Bank PLC",
    accountNumber: "0123456789",
    accountName: "Acme Store / Checkout",
    fiatAmount: p.fiatAmount,
  });
  let solSeq = 0;
  nearLib.createSolanaDeposit = async () => ({
    id: 55 + (++solSeq),
    deposit_address: solSeq === 1 ? "So11111111111111111111111111111111111111112" : `So111111111111111111111111111111111111111${solSeq}2`,
    deposit_memo: null,
  });
  apiKeys.dispatchBuilderWebhook = async (keyObj, event, data) => {
    webhookCalls.push({ keyObj, event, data });
    return { delivered: true };
  };

  // Seed merchant user + 2 scoped API keys (one with checkout, one without)
  const merchantId = 88112233;
  const { Wallet } = require("ethers");
  const w = Wallet.createRandom();
  db.createUserWithWallet(merchantId, "acme_merchant", w.address, w.privateKey, "1234");
  const keyA = apiKeys.generateApiKey({ telegramId: merchantId, appName: "Acme Store", features: ["checkout"], webhookUrl: "https://acme.test/webhook" });
  const keyB = apiKeys.generateApiKey({ telegramId: merchantId, appName: "Other App", features: ["wallets"] });

  const server = webhookServer.createWebhookServer({ bot: null });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  try {
    // 1. Key without 'checkout' scope is rejected (403)
    const denied = await httpReq(port, "POST", "/api/v1/checkout/sessions", {
      headers: { Authorization: `Bearer ${keyB.secretKey}`, "Content-Type": "application/json" },
      body: { amount: 50, currency: "USD" },
    });
    assert.equal(denied.status, 403);

    // 2. Create branded NGN + Crypto Checkout Session
    const created = await httpReq(port, "POST", "/api/v1/checkout/sessions", {
      headers: { Authorization: `Bearer ${keyA.secretKey}`, "Content-Type": "application/json" },
      body: {
        amount: 150000,
        currency: "NGN",
        channels: ["ngn_bank", "crypto"],
        cryptoChain: "sol_usdc",
        reference: "ORD-1001",
        description: "Annual SaaS Plan",
        brand: { businessName: "Acme Cloud", primaryColor: "#1e3a8a", accentColor: "#10b981" },
        successUrl: "https://acme.test/success",
      },
    });
    assert.equal(created.status, 201);
    const s = created.json.session;
    assert.ok(s.sessionId.startsWith("cs_live_"));
    assert.equal(s.amountNgn, 150000);
    assert.equal(s.amountUsdc, 100);
    assert.equal(s.paymentMethods.ngnBank.accountNumber, "0123456789");
    assert.equal(s.paymentMethods.crypto.depositAddress, "So11111111111111111111111111111111111111112");

    // 3. Hosted Branded Checkout HTML renders merchant branding & payment details
    const hosted = await httpReq(port, "GET", `/checkout/${s.sessionId}`);
    assert.equal(hosted.status, 200);
    assert.ok(hosted.text.includes("Acme Cloud"));
    assert.ok(hosted.text.includes("0123456789"));
    assert.ok(hosted.text.includes("So11111111111111111111111111111111111111112"));
    assert.ok(hosted.text.includes("Powered by Proxim"));

    // 4. Drop-in Inline JS SDK is served cleanly
    const sdk = await httpReq(port, "GET", "/sdk/proxim-checkout.js");
    assert.equal(sdk.status, 200);
    assert.ok(sdk.text.includes("ProximCheckout"));

    // 5. Mark session paid -> public status flips & merchant webhook fires
    await merchantCheckout.markCheckoutSessionPaid(s.sessionId, { paidChannel: "ngn_bank", txHash: "paj_tx_9" });
    const pubStatus = await httpReq(port, "GET", `/api/v1/checkout/public/${s.sessionId}`);
    assert.equal(pubStatus.status, 200);
    assert.equal(pubStatus.json.status, "paid");
    assert.equal(webhookCalls.length, 1);
    assert.equal(webhookCalls[0].event, "checkout.session.completed");

    // 6. Reusable Payment Link creation + landing HTML + customer session launch
    const plRes = await httpReq(port, "POST", "/api/v1/payment-links", {
      headers: { Authorization: `Bearer ${keyA.secretKey}`, "Content-Type": "application/json" },
      body: { title: "Acme Pro", slug: "acme-pro", amount: 50, currency: "USD", channels: ["crypto"] },
    });
    assert.equal(plRes.status, 201);
    assert.equal(plRes.json.paymentLink.slug, "acme-pro");

    const plPage = await httpReq(port, "GET", "/pay/acme-pro");
    assert.equal(plPage.status, 200);
    assert.ok(plPage.text.includes("Acme Pro"));

    const plStart = await httpReq(port, "POST", "/api/v1/payment-links/acme-pro/checkout", {
      headers: { "Content-Type": "application/json" },
      body: { customerName: "Bob", customerEmail: "bob@example.com" },
    });
    assert.equal(plStart.status, 201);
    assert.ok(plStart.json.checkoutUrl.includes("/checkout/cs_live_"));

    // 7. Merchant White-Label Profile (PUT + GET) inherited by new Checkout Sessions
    const putProfile = await httpReq(port, "PUT", "/api/v1/merchant/profile", {
      headers: { Authorization: `Bearer ${keyA.secretKey}`, "Content-Type": "application/json" },
      body: {
        businessName: "Acme Global Corp",
        primaryColor: "#7c3aed",
        accentColor: "#06b6d4",
        defaultChannels: ["crypto"],
        defaultCryptoChain: "sol_usdc",
        successUrl: "https://acme.test/done",
      },
    });
    assert.equal(putProfile.status, 200);
    assert.equal(putProfile.json.profile.businessName, "Acme Global Corp");

    // Create session without specifying brand/channels -> inherits merchant_settings automatically!
    const inherited = await httpReq(port, "POST", "/api/v1/checkout/sessions", {
      headers: { Authorization: `Bearer ${keyA.secretKey}`, "Content-Type": "application/json" },
      body: { amount: 75, currency: "USD" },
    });
    assert.equal(inherited.status, 201);
    assert.equal(inherited.json.session.brand.businessName, "Acme Global Corp");
    assert.equal(inherited.json.session.brand.primaryColor, "#7c3aed");
    assert.equal(inherited.json.session.successUrl, "https://acme.test/done");

    // 8. Auto-settlement via NEAR Intents matcher (trySettleSessionByNearIntent)
    const settledNear = await merchantCheckout.trySettleSessionByNearIntent({
      id: 55,
      deposit_address: inherited.json.session.paymentMethods.crypto.depositAddress,
      correlation_id: "corr_near_75",
    });
    assert.ok(settledNear);
    assert.equal(settledNear.status, "paid");
    assert.ok(settledNear.paidChannel.startsWith("crypto_"));

    // 9. Unified Merchant Analytics across all rails
    const analyticsRes = await httpReq(port, "GET", "/api/v1/merchant/analytics", {
      headers: { Authorization: `Bearer ${keyA.secretKey}` },
    });
    assert.equal(analyticsRes.status, 200);
    assert.equal(analyticsRes.json.analytics.paidCount, 2);
    assert.equal(analyticsRes.json.analytics.totalVolumeUsdc, 175);
  } finally {
    server.close();
    paj.getRates = origRates;
    paj.createOnrampOrder = origOnramp;
    nearLib.createSolanaDeposit = origSolDep;
    apiKeys.dispatchBuilderWebhook = origDispatch;
  }
});
