// tests/builder_api.test.js
// Unit & Integration tests for Proxim Builder API Keys and REST Endpoints
// Validates key generation, feature-scoping, rate-limiting, and REST API routes.

const test = require("node:test");
const assert = require("node:assert/strict");

const apiKeys = require("../src/api_keys");
const apiRoutes = require("../src/api_routes");
const db = require("../src/db");
const nearLib = require("../src/near");

const testDevId = 999111222;

test("Builder API Keys: Generation, Verification, and Feature Permissions", async () => {
  // 1. Generate full-access API key
  const fullKey = apiKeys.generateApiKey({
    telegramId: testDevId,
    appName: "Test Omnichain App",
    features: ["all"],
  });

  assert.ok(fullKey.secretKey.startsWith("prx_live_"), "Secret key must start with prx_live_");
  assert.equal(fullKey.appName, "Test Omnichain App");
  assert.deepEqual(fullKey.allowedFeatures, ["all"]);

  // Verify full-access key allows any feature
  const authFull = apiKeys.verifyApiKey(fullKey.secretKey, "wallets");
  assert.equal(authFull.valid, true);

  const authIntents = apiKeys.verifyApiKey(fullKey.secretKey, "near_intents");
  assert.equal(authIntents.valid, true);

  // 2. Generate customized scoped API key (only wallets & invoices)
  const scopedKey = apiKeys.generateApiKey({
    telegramId: testDevId,
    appName: "Invoicing Only App",
    features: ["wallets", "invoices"],
  });

  assert.deepEqual(scopedKey.allowedFeatures, ["wallets", "invoices"]);

  // Permitted features succeed
  const authWallet = apiKeys.verifyApiKey(scopedKey.secretKey, "wallets");
  assert.equal(authWallet.valid, true);

  const authInv = apiKeys.verifyApiKey(scopedKey.secretKey, "invoices");
  assert.equal(authInv.valid, true);

  // Unpermitted features fail with 403 Forbidden
  const authBlocked = apiKeys.verifyApiKey(scopedKey.secretKey, "near_intents");
  assert.equal(authBlocked.valid, false);
  assert.equal(authBlocked.code, 403);
  assert.ok(authBlocked.error.includes("Feature 'near_intents' is not enabled"));

  // 3. Customize features on existing key
  apiKeys.updateApiKeyFeatures(scopedKey.keyId, ["wallets", "invoices", "near_intents"], testDevId);
  const authNowAllowed = apiKeys.verifyApiKey(scopedKey.secretKey, "near_intents");
  assert.equal(authNowAllowed.valid, true, "Should succeed after feature is added");

  // 4. Revocation
  apiKeys.revokeApiKey(scopedKey.keyId, testDevId);
  const authRevoked = apiKeys.verifyApiKey(scopedKey.secretKey, "wallets");
  assert.equal(authRevoked.valid, false);
  assert.equal(authRevoked.code, 401);
  assert.ok(authRevoked.error.includes("revoked"));
});

test("Builder REST API Endpoints (/api/v1/*)", async (t) => {
  // Helper to simulate HTTP req / res
  function mockHttp(method, urlPath, headers = {}, bodyObj = null) {
    const { EventEmitter } = require("node:events");
    const req = new EventEmitter();
    req.method = method;
    req.url = urlPath;
    req.headers = { ...headers };

    const res = {
      statusCode: 200,
      headers: {},
      body: "",
      writeHead(code, h) {
        this.statusCode = code;
        this.headers = h;
      },
      end(chunk) {
        if (chunk) {
          if (Buffer.isBuffer(chunk)) {
            this.rawBuffer = chunk;
          }
          this.body += chunk;
        }
      },
    };

    process.nextTick(() => {
      if (bodyObj) req.emit("data", Buffer.from(JSON.stringify(bodyObj)));
      req.emit("end");
    });

    return { req, res };
  }

  const builderKey = apiKeys.generateApiKey({
    telegramId: testDevId,
    appName: "REST Suite App",
    features: ["all"],
  });

  const scopedKey = apiKeys.generateApiKey({
    telegramId: testDevId,
    appName: "Scoped App",
    features: ["invoices"],
  });

  await t.test("GET /api/v1/health (Public)", async () => {
    const { req, res } = mockHttp("GET", "/api/v1/health");
    await apiRoutes.handleApiRequest(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.ok(body.supportedChains.includes("Robinhood Chain"));
  });

  await t.test("GET /api/v1/features (Public)", async () => {
    const { req, res } = mockHttp("GET", "/api/v1/features");
    await apiRoutes.handleApiRequest(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.ok(body.features.some((f) => f.id === "near_intents"));
  });

  await t.test("GET /api/v1/auth/me (Authenticated)", async () => {
    const { req, res } = mockHttp("GET", "/api/v1/auth/me", {
      Authorization: `Bearer ${builderKey.secretKey}`,
    });
    await apiRoutes.handleApiRequest(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.appName, "REST Suite App");
    assert.deepEqual(body.allowedFeatures, ["all"]);
  });

  await t.test("POST /api/v1/wallets provisions customer wallet", async () => {
    const { req, res } = mockHttp(
      "POST",
      "/api/v1/wallets",
      { Authorization: `Bearer ${builderKey.secretKey}` },
      { username: `customer_${Date.now()}`, pin: "1234" }
    );
    await apiRoutes.handleApiRequest(req, res);
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.ok(body.addresses.arc.startsWith("0x"));
    assert.ok(body.addresses.robinhood.startsWith("0x"));
  });

  await t.test("GET /api/v1/intents/tokens returns tokens including Robinhood Chain", async () => {
    const { req, res } = mockHttp("GET", "/api/v1/intents/tokens", {
      Authorization: `Bearer ${builderKey.secretKey}`,
    });
    await apiRoutes.handleApiRequest(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.chains.robinhood));
    assert.ok(body.chains.robinhood.some((t) => t.symbol === "USDG"));
  });

  await t.test("POST /api/v1/intents/deposits/robinhood creates Robinhood deposit", async () => {
    const origGetQuote = nearLib.getQuote;
    try {
      nearLib.getQuote = async () => ({
        correlationId: "corr-api-test",
        quote: { depositAddress: "0x8888888888888888888888888888888888888888", amountOut: "4995000" },
      });

      const { req, res } = mockHttp(
        "POST",
        "/api/v1/intents/deposits/robinhood",
        { Authorization: `Bearer ${builderKey.secretKey}` },
        {
          originSymbol: "USDG",
          amount: 5,
          recipientAddress: "0x9999999999999999999999999999999999999999",
        }
      );
      await apiRoutes.handleApiRequest(req, res);
      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.success, true);
      assert.equal(body.depositAddress, "0x8888888888888888888888888888888888888888");
      assert.ok(body.instructions.includes("Robinhood Chain"));
    } finally {
      nearLib.getQuote = origGetQuote;
    }
  });

  await t.test("Feature enforcement: Scoped key is blocked from unauthorized endpoint", async () => {
    const { req, res } = mockHttp(
      "POST",
      "/api/v1/intents/deposits/robinhood",
      { Authorization: `Bearer ${scopedKey.secretKey}` },
      { originSymbol: "USDG", amount: 5, recipientAddress: "0x9999999999999999999999999999999999999999" }
    );
    await apiRoutes.handleApiRequest(req, res);
    assert.equal(res.statusCode, 403, "Should be forbidden for scoped key without near_intents feature");
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);
    assert.ok(body.error.includes("Feature 'near_intents' is not enabled"));
  });

  await t.test("POST & GET /api/v1/invoices creates and fetches invoice", async () => {
    const { req, res } = mockHttp(
      "POST",
      "/api/v1/invoices",
      { Authorization: `Bearer ${scopedKey.secretKey}` },
      { clientName: "Acme Corp", amount: 150, memo: "Consulting Services" }
    );
    await apiRoutes.handleApiRequest(req, res);
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.equal(body.invoice.client_name, "Acme Corp");
    assert.equal(body.invoice.total, 150);

    // Fetch the created invoice
    const invNum = body.invoice.invoice_number;
    const { req: getReq, res: getRes } = mockHttp("GET", `/api/v1/invoices/${invNum}`, {
      Authorization: `Bearer ${scopedKey.secretKey}`,
    });
    await apiRoutes.handleApiRequest(getReq, getRes);
    assert.equal(getRes.statusCode, 200);
    const getBody = JSON.parse(getRes.body);
    assert.equal(getBody.invoice.invoice_number, invNum);
  });

  await t.test("GET /api/v1/deposits/crypto/chains returns EVM chain configs", async () => {
    const { req, res } = mockHttp("GET", "/api/v1/deposits/crypto/chains", {
      Authorization: `Bearer ${builderKey.secretKey}`,
    });
    await apiRoutes.handleApiRequest(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.chains));
    const chainNames = body.chains.map((c) => c.name);
    assert.ok(chainNames.includes("Base"));
    assert.ok(chainNames.includes("Arbitrum"));
  });

  await t.test("GET /api/v1/bridge/supported returns CCTP domains", async () => {
    const { req, res } = mockHttp("GET", "/api/v1/bridge/supported", {
      Authorization: `Bearer ${builderKey.secretKey}`,
    });
    await apiRoutes.handleApiRequest(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.equal(body.protocol, "Circle CCTP");
    assert.ok(body.supportedChains.includes("Arc"));
    assert.ok(body.supportedChains.includes("Solana"));
  });

  await t.test("GET /api/v1/receipts/:txHash returns receipt JSON and handles PNG format", async () => {
    const dummyHash = "0x" + require("node:crypto").randomBytes(32).toString("hex");
    db.recordTransaction(testDevId, "transfer", "50000000", "completed", dummyHash, "personal", 6, "arc");

    // 1. JSON receipt
    const { req, res } = mockHttp("GET", `/api/v1/receipts/${dummyHash}`, {
      Authorization: `Bearer ${builderKey.secretKey}`,
    });
    await apiRoutes.handleApiRequest(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.equal(body.receipt.txHash, dummyHash);
    assert.equal(body.receipt.amountUsdc, 50);

    // 2. PNG receipt
    const { req: pngReq, res: pngRes } = mockHttp("GET", `/api/v1/receipts/${dummyHash}?format=png`, {
      Authorization: `Bearer ${builderKey.secretKey}`,
    });
    await apiRoutes.handleApiRequest(pngReq, pngRes);
    assert.equal(pngRes.statusCode, 200);
    assert.equal(pngRes.headers["Content-Type"], "image/png");
    assert.ok(pngRes.rawBuffer && pngRes.rawBuffer.length > 0, "Should return binary PNG buffer");
  });
});
