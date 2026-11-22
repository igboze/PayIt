// tests/api_nuvion_builder.test.js
// Tests Nuvion Global Payouts & Virtual Cards Builder API routes, upfront fee capture,
// tenant isolation, 1MB DoS body limit, and feature scoping.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const apiKeys = require("../src/api_keys");
const apiRoutes = require("../src/api_routes");
const db = require("../src/db");
const walletLib = require("../src/wallet");
const nuvionPayouts = require("../src/nuvion_payouts");

function createMockReqRes(method, reqUrl, headers = {}, bodyObj = null) {
  const req = new EventEmitter();
  req.method = method;
  req.url = reqUrl;
  req.headers = headers;

  let statusCode = 200;
  let responseHeaders = {};
  let rawBody = "";

  const res = {
    writeHead(code, hdrs = {}) {
      statusCode = code;
      responseHeaders = hdrs;
    },
    end(chunk) {
      if (chunk) rawBody += chunk.toString();
    },
  };

  const run = async () => {
    const p = apiRoutes.handleApiRequest(req, res, null);
    if (bodyObj !== null) {
      const payload = typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj);
      req.emit("data", Buffer.from(payload));
    }
    req.emit("end");
    await p;
    return {
      statusCode,
      headers: responseHeaders,
      json: rawBody ? JSON.parse(rawBody) : null,
    };
  };

  return { run };
}

test("Builder API rejects oversized >1MB payloads with 413", async () => {
  const ownerId = 666555444;
  const created = apiKeys.generateApiKey({
    telegramId: ownerId,
    appName: "DoS Guard Test",
    features: ["global_payouts"],
  });

  try {
    const huge = "x".repeat(1024 * 1024 + 64);
    const { run } = createMockReqRes(
      "POST",
      "/api/v1/global/payouts/quote",
      { Authorization: `Bearer ${created.secretKey}` },
      huge
    );
    const out = await run();
    assert.equal(out.statusCode, 413);
  } finally {
    db._db.prepare("DELETE FROM api_keys WHERE key_id = ?").run(created.keyId);
  }
});

test("Builder API enforces feature scoping & tenant isolation on /api/v1/global/*", async () => {
  const ownerId = 666555445;
  const strangerId = 666555446;

  db._db.prepare("DELETE FROM users WHERE telegram_id IN (?, ?)").run(ownerId, strangerId);
  const w1 = walletLib.generateUserWallet();
  const w2 = walletLib.generateUserWallet();
  db.createUserWithWallet(ownerId, "builder_owner_test", w1.address, w1.privateKey, "1234");
  db.createUserWithWallet(strangerId, "builder_stranger_test", w2.address, w2.privateKey, "1234");

  const scopedKey = apiKeys.generateApiKey({
    telegramId: ownerId,
    appName: "Global Payouts App",
    features: ["global_payouts"],
  });

  const origQuote = nuvionPayouts.quoteGlobalPayout;
  try {
    // 1. Virtual cards endpoint must be 403 for global_payouts-only key
    const cardsCall = createMockReqRes(
      "GET",
      `/api/v1/global/cards/${ownerId}`,
      { Authorization: `Bearer ${scopedKey.secretKey}` }
    );
    const cardsOut = await cardsCall.run();
    assert.equal(cardsOut.statusCode, 403);

    // 2. Accessing another tenant's wallet must be 403
    const crossTenantCall = createMockReqRes(
      "POST",
      "/api/v1/global/payouts/quote",
      { Authorization: `Bearer ${scopedKey.secretKey}` },
      { userId: strangerId, railKey: "usd_ach", targetCurrency: "USD", targetAmountMajor: 50 }
    );
    const crossOut = await crossTenantCall.run();
    assert.equal(crossOut.statusCode, 403);

    // 3. Valid quote returns transferAmountUsd + transferFeeUsd + totalDebitUsd
    nuvionPayouts.quoteGlobalPayout = async () => ({
      nuvionQuoteId: "fx_api_1",
      rail: { key: "gbp_fps", label: "UK Faster Payments (FPS)" },
      targetCurrency: "GBP",
      targetAmountMajor: 50,
      nuvionPrincipalUsd: 66.98,
      nuvionRailFeeUsd: 6.7,
      marginUsd: 0.67,
      userTotalUsd: 74.35,
      effectiveRate: 0.6725,
      expiresAt: Date.now() + 60000,
      validForSec: 60,
    });

    const quoteCall = createMockReqRes(
      "POST",
      "/api/v1/global/payouts/quote",
      { Authorization: `Bearer ${scopedKey.secretKey}` },
      { userId: ownerId, railKey: "gbp_fps", targetCurrency: "GBP", targetAmountMajor: 50 }
    );
    const quoteOut = await quoteCall.run();
    assert.equal(quoteOut.statusCode, 200);
    assert.equal(quoteOut.json.quote.transferAmountUsd, 66.98);
    assert.equal(quoteOut.json.quote.transferFeeUsd, 7.37);
    assert.equal(quoteOut.json.quote.totalDebitUsd, 74.35);

    // 4. Sanctioned jurisdiction on /api/v1/global/kyc must return 403
    const kycSanctionCall = createMockReqRes(
      "POST",
      "/api/v1/global/kyc",
      { Authorization: `Bearer ${scopedKey.secretKey}` },
      { userId: ownerId, countryCode: "KP" }
    );
    const kycSanctionOut = await kycSanctionCall.run();
    assert.equal(kycSanctionOut.statusCode, 403);

    // 5. Invalid card quote < $1 returns 400 (never 500)
    const fullKey = apiKeys.generateApiKey({
      telegramId: ownerId,
      appName: "Full Access Test",
      features: ["all"],
    });
    const badCardCall = createMockReqRes(
      "POST",
      "/api/v1/global/cards/quote",
      { Authorization: `Bearer ${fullKey.secretKey}` },
      { userId: ownerId, action: "issue", amountUsd: 0.5 }
    );
    const badCardOut = await badCardCall.run();
    assert.equal(badCardOut.statusCode, 400);
    db._db.prepare("DELETE FROM api_keys WHERE key_id = ?").run(fullKey.keyId);
  } finally {
    nuvionPayouts.quoteGlobalPayout = origQuote;
    db._db.prepare("DELETE FROM api_keys WHERE key_id = ?").run(scopedKey.keyId);
    db._db.prepare("DELETE FROM users WHERE telegram_id IN (?, ?)").run(ownerId, strangerId);
  }
});
