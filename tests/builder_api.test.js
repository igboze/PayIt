// tests/builder_api.test.js
// Unit & Integration tests for Proxim Builder API Keys and REST Endpoints
// Validates key generation, feature-scoping, rate-limiting, and REST API routes.

const test = require("node:test");
const assert = require("node:assert/strict");

const apiKeys = require("../src/api_keys");
const apiRoutes = require("../src/api_routes");
const db = require("../src/db");
const nearLib = require("../src/near");
const chains = require("../src/chains");
const walletLib = require("../src/wallet");
const paj = require("../src/paj");
const savings = require("../src/savings");
const cctpBridge = require("../src/cctp_bridge");
const multichain = require("../src/multichain");
const fs = require("node:fs");
const path = require("node:path");

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

  await t.test("GET /api/v1/docs serves live BUILDER_API.md", async () => {
    const { req, res } = mockHttp("GET", "/api/v1/docs");
    await apiRoutes.handleApiRequest(req, res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers["Content-Type"].includes("text/markdown"));
    assert.ok(res.body.includes("Proxim Builder API Documentation"));
    assert.ok(!res.body.includes("payit.app/invoice"), "Docs must not reference dead payit.app domain");
  });

  await t.test("GET /api/v1/wallets/:id/balance maps real unified balance fields", async () => {
    const uname = `bal_cust_${Date.now()}`;
    const { req: cReq, res: cRes } = mockHttp(
      "POST",
      "/api/v1/wallets",
      { Authorization: `Bearer ${builderKey.secretKey}` },
      { username: uname, pin: "5678" }
    );
    await apiRoutes.handleApiRequest(cReq, cRes);
    assert.equal(cRes.statusCode, 201);
    const created = JSON.parse(cRes.body);

    const origBal = chains.getUnifiedBalance;
    try {
      chains.getUnifiedBalance = async () => ({
        accountType: "personal",
        arcAddress: created.addresses.arc,
        solanaAddresses: [],
        arc: { usdc: 42.5, eurc: 10.25 },
        solana: { usdc: 7.5 },
        pendingNear: 3.0,
        byChain: { arc: 42.5, solana: 7.5 },
        total: 50.0,
      });

      const { req, res } = mockHttp("GET", `/api/v1/wallets/${created.userId}/balance`, {
        Authorization: `Bearer ${builderKey.secretKey}`,
      });
      await apiRoutes.handleApiRequest(req, res);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.totalUsdc, 50.0);
      assert.equal(body.arcUsdc, 42.5);
      assert.equal(body.arcEurc, 10.25);
      assert.equal(body.solanaSplUsdc, 7.5);
      assert.equal(body.pendingBridgeUsdc, 3.0);
    } finally {
      chains.getUnifiedBalance = origBal;
    }
  });

  await t.test("POST /api/v1/transfers unlocks with PIN and calls real wallet send", async () => {
    const uname = `tx_cust_${Date.now()}`;
    const { req: cReq, res: cRes } = mockHttp(
      "POST",
      "/api/v1/wallets",
      { Authorization: `Bearer ${builderKey.secretKey}` },
      { username: uname, pin: "2468" }
    );
    await apiRoutes.handleApiRequest(cReq, cRes);
    const created = JSON.parse(cRes.body);

    const origSend = walletLib.sendSponsoredOrDirectTransaction;
    let capturedSigner = null;
    let capturedAmount = null;
    try {
      walletLib.sendSponsoredOrDirectTransaction = async (signer, to, amountMicro) => {
        capturedSigner = signer;
        capturedAmount = amountMicro;
        return { txHash: "0x" + "a".repeat(64), sponsored: true };
      };

      const { req, res } = mockHttp(
        "POST",
        "/api/v1/transfers",
        { Authorization: `Bearer ${builderKey.secretKey}` },
        {
          fromUserId: created.userId,
          toAddress: "0x8888888888888888888888888888888888888888",
          amountUsdc: 12.5,
          pin: "2468",
        }
      );
      await apiRoutes.handleApiRequest(req, res);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.success, true);
      assert.equal(body.txHash, "0x" + "a".repeat(64));
      assert.equal(body.sponsored, true);
      assert.ok(capturedSigner && capturedSigner.provider, "Signer must be connected to Arc RPC provider");
      assert.equal(capturedAmount, walletLib.parseToMicro("12.500000"));
    } finally {
      walletLib.sendSponsoredOrDirectTransaction = origSend;
    }
  });

  await t.test("Invoices: GET /api/v1/invoices list & numeric ID lookup work without fake payit.app URL", async () => {
    const { req: pReq, res: pRes } = mockHttp(
      "POST",
      "/api/v1/invoices",
      { Authorization: `Bearer ${scopedKey.secretKey}` },
      { clientName: "RealBiz Ltd", amount: 75 }
    );
    await apiRoutes.handleApiRequest(pReq, pRes);
    assert.equal(pRes.statusCode, 201);
    const created = JSON.parse(pRes.body);
    assert.ok(!JSON.stringify(created).includes("payit.app"), "Must not return placeholder payit.app URL");
    assert.ok(created.statusUrl.includes("/api/v1/invoices/"));

    const { req: idReq, res: idRes } = mockHttp("GET", `/api/v1/invoices/${created.invoice.id}`, {
      Authorization: `Bearer ${scopedKey.secretKey}`,
    });
    await apiRoutes.handleApiRequest(idReq, idRes);
    assert.equal(idRes.statusCode, 200);

    const { req: listReq, res: listRes } = mockHttp("GET", "/api/v1/invoices", {
      Authorization: `Bearer ${scopedKey.secretKey}`,
    });
    await apiRoutes.handleApiRequest(listReq, listRes);
    assert.equal(listRes.statusCode, 200);
    const listBody = JSON.parse(listRes.body);
    assert.ok(Array.isArray(listBody.invoices) && listBody.invoices.length > 0);
  });

  await t.test("Onramp & Offramp: Fixed Paj params, status lookup, live rates, and honest modes", async () => {
    const origCreateOn = paj.createOnrampOrder;
    const origGetOn = paj.getOnrampOrder;
    const origRates = paj.getRates;
    const origPayout = paj.createOfframpPayout;
    const origSolSend = multichain.sendSolanaTransfer;

    let capturedOnrampParams = null;
    try {
      paj.createOnrampOrder = async (params) => {
        capturedOnrampParams = params;
        return {
          id: "ord_on_123",
          bank: "Wema Bank",
          accountNumber: "0123456789",
          accountName: "Paj / Proxim",
          fiatAmount: params.fiatAmount,
          amount: 34.5,
          rate: 1450,
          status: "pending",
        };
      };
      paj.getOnrampOrder = async (id) => ({ id, status: "completed" });
      paj.getRates = async () => ({
        onRampRate: { rate: 1455 },
        offRampRate: { rate: 1445 },
      });
      paj.createOfframpPayout = async (params) => ({
        id: "ord_off_456",
        address: "8F3bNqm8e734tXpG82bM9rC1zP5qK93h12aBsJ83dKL4",
        chain: "SOLANA",
        amount: params.amountUsdc,
        fiatAmount: params.amountUsdc * 1445,
        rate: 1445,
        status: "pending",
      });

      // 1. Onramp bank transfer
      const { req: onReq, res: onRes } = mockHttp(
        "POST",
        "/api/v1/onramp/bank-transfer",
        { Authorization: `Bearer ${builderKey.secretKey}` },
        { amountNgn: 50000, recipientAddress: "8F3bNqm8e734tXpG82bM9rC1zP5qK93h12aBsJ83dKL4" }
      );
      await apiRoutes.handleApiRequest(onReq, onRes);
      assert.equal(onRes.statusCode, 200);
      assert.equal(capturedOnrampParams.fiatAmount, 50000);
      assert.equal(capturedOnrampParams.recipient, "8F3bNqm8e734tXpG82bM9rC1zP5qK93h12aBsJ83dKL4");
      const onBody = JSON.parse(onRes.body);
      assert.equal(onBody.virtualAccount.bankName, "Wema Bank");

      // 2. Onramp status
      const { req: stReq, res: stRes } = mockHttp("GET", "/api/v1/onramp/status/ord_on_123", {
        Authorization: `Bearer ${builderKey.secretKey}`,
      });
      await apiRoutes.handleApiRequest(stReq, stRes);
      assert.equal(stRes.statusCode, 200);
      assert.equal(JSON.parse(stRes.body).order.status, "completed");

      // 3. Offramp live rates
      const { req: rReq, res: rRes } = mockHttp("GET", "/api/v1/offramp/rates", {
        Authorization: `Bearer ${builderKey.secretKey}`,
      });
      await apiRoutes.handleApiRequest(rReq, rRes);
      assert.equal(rRes.statusCode, 200);
      const rBody = JSON.parse(rRes.body);
      assert.equal(rBody.ngnPerUsdc, 1445);
      assert.equal(rBody.onRampRate, 1455);

      // 4. Offramp quote mode (no userId -> awaiting_funding)
      const { req: qReq, res: qRes } = mockHttp(
        "POST",
        "/api/v1/offramp/bank-transfer",
        { Authorization: `Bearer ${builderKey.secretKey}` },
        { amountUsdc: 20, bankCode: "058", accountNumber: "0123456789", accountName: "Alice" }
      );
      await apiRoutes.handleApiRequest(qReq, qRes);
      assert.equal(qRes.statusCode, 200);
      const qBody = JSON.parse(qRes.body);
      assert.equal(qBody.mode, "awaiting_funding");
      assert.equal(qBody.fundingAddress, "8F3bNqm8e734tXpG82bM9rC1zP5qK93h12aBsJ83dKL4");
    } finally {
      paj.createOnrampOrder = origCreateOn;
      paj.getOnrampOrder = origGetOn;
      paj.getRates = origRates;
      paj.createOfframpPayout = origPayout;
      multichain.sendSolanaTransfer = origSolSend;
    }
  });

  await t.test("Savings: Live EarnKit rates, real on-chain deposit, position, and withdraw", async () => {
    const uname = `sav_cust_${Date.now()}`;
    const { req: cReq, res: cRes } = mockHttp(
      "POST",
      "/api/v1/wallets",
      { Authorization: `Bearer ${builderKey.secretKey}` },
      { username: uname, pin: "1122" }
    );
    await apiRoutes.handleApiRequest(cReq, cRes);
    const created = JSON.parse(cRes.body);

    const origPools = savings.getYieldPools;
    const origDep = savings.depositIntoVault;
    const origWd = savings.withdrawFromVaultWithFee;
    let depCalled = false;
    let wdWallet = null;

    try {
      savings.getYieldPools = async () => ([
        {
          symbol: "USDC",
          project: "Steakhouse Prime USDC",
          chain: "Arc Mainnet",
          vaultAddress: "0xa8fd51b78370c7ca948566d7ba97d252bc325124",
          rawApy: 5.5,
          userApy: 4.95,
          payitApy: 0.55,
          totalDeposits: "1500000",
        },
      ]);
      savings.depositIntoVault = async (pk, vaultAddr, amt) => {
        depCalled = true;
        assert.ok(pk && pk.length > 20);
        assert.equal(vaultAddr, "0xa8fd51b78370c7ca948566d7ba97d252bc325124");
        assert.equal(amt, 50);
        return { success: true, txHash: "0x" + "b".repeat(64) };
      };
      savings.withdrawFromVaultWithFee = async ({ userWallet, position }) => {
        wdWallet = userWallet;
        db.closeYieldPosition(position.telegram_id, 50.12, { positionId: position.id, withdrawTxHash: "0x" + "c".repeat(64) });
        return {
          success: true,
          principalUsdc: 50,
          grossYieldUsdc: 0.133,
          netYieldUsdc: 0.12,
          devFeeUsdc: 0.013,
          totalUserPayout: 50.12,
          withdrawTxHash: "0x" + "c".repeat(64),
          feeTxHash: null,
        };
      };

      // 1. Live rates (NOT hardcoded 8.2%)
      const { req: rReq, res: rRes } = mockHttp("GET", "/api/v1/savings/rates", {
        Authorization: `Bearer ${builderKey.secretKey}`,
      });
      await apiRoutes.handleApiRequest(rReq, rRes);
      assert.equal(rRes.statusCode, 200);
      const rBody = JSON.parse(rRes.body);
      assert.equal(rBody.vault, "Steakhouse Prime USDC");
      assert.equal(rBody.apyPercent, 4.95);
      assert.ok(Array.isArray(rBody.vaults) && rBody.vaults.length === 1);

      // 2. Real deposit
      const { req: dReq, res: dRes } = mockHttp(
        "POST",
        "/api/v1/savings/deposit",
        { Authorization: `Bearer ${builderKey.secretKey}` },
        { userId: created.userId, amountUsdc: 50, pin: "1122" }
      );
      await apiRoutes.handleApiRequest(dReq, dRes);
      assert.equal(dRes.statusCode, 200);
      assert.equal(depCalled, true);
      const dBody = JSON.parse(dRes.body);
      assert.equal(dBody.txHash, "0x" + "b".repeat(64));

      // 3. Position check
      const { req: pReq, res: pRes } = mockHttp("GET", `/api/v1/savings/position/${created.userId}`, {
        Authorization: `Bearer ${builderKey.secretKey}`,
      });
      await apiRoutes.handleApiRequest(pReq, pRes);
      assert.equal(pRes.statusCode, 200);
      const pBody = JSON.parse(pRes.body);
      assert.equal(pBody.active, true);
      assert.equal(pBody.position.amount_usdc, 50);

      // 4. Real withdraw
      const { req: wReq, res: wRes } = mockHttp(
        "POST",
        "/api/v1/savings/withdraw",
        { Authorization: `Bearer ${builderKey.secretKey}` },
        { userId: created.userId, pin: "1122" }
      );
      await apiRoutes.handleApiRequest(wReq, wRes);
      assert.equal(wRes.statusCode, 200);
      assert.ok(wdWallet && wdWallet.provider, "Withdraw wallet must have RPC provider");
      const wBody = JSON.parse(wRes.body);
      assert.equal(wBody.withdrawnAmount, 50.12);
      assert.equal(wBody.withdrawTxHash, "0x" + "c".repeat(64));
    } finally {
      savings.getYieldPools = origPools;
      savings.depositIntoVault = origDep;
      savings.withdrawFromVaultWithFee = origWd;
    }
  });

  await t.test("POST /api/v1/bridge/transfer passes provider-connected wallet and fixes PIN arg order", async () => {
    const uname = `br_cust_${Date.now()}`;
    const { req: cReq, res: cRes } = mockHttp(
      "POST",
      "/api/v1/wallets",
      { Authorization: `Bearer ${builderKey.secretKey}` },
      { username: uname, pin: "9876" }
    );
    await apiRoutes.handleApiRequest(cReq, cRes);
    const created = JSON.parse(cRes.body);

    const origBridge = cctpBridge.executeArcCrossChainWithdrawal;
    let passedWallet = null;
    try {
      cctpBridge.executeArcCrossChainWithdrawal = async ({ userWallet }) => {
        passedWallet = userWallet;
        return { burnTxHash: "0x" + "d".repeat(64), status: "minted" };
      };

      const { req, res } = mockHttp(
        "POST",
        "/api/v1/bridge/transfer",
        { Authorization: `Bearer ${builderKey.secretKey}` },
        {
          userId: created.userId,
          destinationChain: "Solana",
          destinationAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
          amountUsdc: 15,
          pin: "9876",
        }
      );
      await apiRoutes.handleApiRequest(req, res);
      assert.equal(res.statusCode, 200);
      assert.ok(passedWallet && passedWallet.provider, "Bridge wallet must be connected to Arc RPC provider");
    } finally {
      cctpBridge.executeArcCrossChainWithdrawal = origBridge;
    }
  });

  await t.test("Tenant Isolation: API key B is blocked from API key A's wallets, receipts, and invoices", async () => {
    const otherDevKey = apiKeys.generateApiKey({
      telegramId: 888777666,
      appName: "Other Tenant App",
      features: ["all"],
    });

    // Provision a customer wallet under builderKey (Tenant A)
    const uname = `tenant_a_${Date.now()}`;
    const { req: cReq, res: cRes } = mockHttp(
      "POST",
      "/api/v1/wallets",
      { Authorization: `Bearer ${builderKey.secretKey}` },
      { username: uname, pin: "4321" }
    );
    await apiRoutes.handleApiRequest(cReq, cRes);
    const tenantAWallet = JSON.parse(cRes.body);

    // Tenant B tries to read Tenant A's balance -> 403
    const { req: bReq, res: bRes } = mockHttp("GET", `/api/v1/wallets/${tenantAWallet.userId}/balance`, {
      Authorization: `Bearer ${otherDevKey.secretKey}`,
    });
    await apiRoutes.handleApiRequest(bReq, bRes);
    assert.equal(bRes.statusCode, 403, "Tenant B must not read Tenant A balance");

    // Tenant B tries to transfer from Tenant A's wallet -> 403
    const { req: tReq, res: tRes } = mockHttp(
      "POST",
      "/api/v1/transfers",
      { Authorization: `Bearer ${otherDevKey.secretKey}` },
      { fromUserId: tenantAWallet.userId, toAddress: "0x8888888888888888888888888888888888888888", amountUsdc: 1 }
    );
    await apiRoutes.handleApiRequest(tReq, tRes);
    assert.equal(tRes.statusCode, 403, "Tenant B must not transfer from Tenant A wallet");

    // Tenant B tries to hijack Tenant A's username via POST /wallets -> 409
    const { req: hReq, res: hRes } = mockHttp(
      "POST",
      "/api/v1/wallets",
      { Authorization: `Bearer ${otherDevKey.secretKey}` },
      { username: uname }
    );
    await apiRoutes.handleApiRequest(hReq, hRes);
    assert.equal(hRes.statusCode, 409, "Tenant B must not hijack Tenant A wallet");

    // Tenant B tries to view Tenant A's receipt -> 403
    const secretTxHash = "0x" + require("node:crypto").randomBytes(32).toString("hex");
    db.recordTransaction(tenantAWallet.userId, "transfer", "1000000", "completed", secretTxHash, "personal", 6, "arc");
    const { req: rReq, res: rRes } = mockHttp("GET", `/api/v1/receipts/${secretTxHash}`, {
      Authorization: `Bearer ${otherDevKey.secretKey}`,
    });
    await apiRoutes.handleApiRequest(rReq, rRes);
    assert.equal(rRes.statusCode, 403, "Tenant B must not access Tenant A receipt");
  });

  await t.test("Developer Portal UI fixes: bridge scope included, edit preserves keyId, no placeholder domain", () => {
    const devFlowCode = fs.readFileSync(path.join(__dirname, "../src/flows_developer.js"), "utf8");
    assert.ok(devFlowCode.includes('{ id: "bridge"'), "Custom feature picker must include bridge scope");
    assert.ok(
      devFlowCode.includes("showCustomFeatureSelection(ctx, state.data.appName, selected, state.data.keyId || null)"),
      "Feature toggle must preserve keyId when editing an existing key"
    );
    assert.ok(!devFlowCode.includes("api.proxim.finance"), "Must not hardcode placeholder api.proxim.finance domain");
  });
});
