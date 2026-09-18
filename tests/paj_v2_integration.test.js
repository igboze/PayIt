// tests/paj_v2_integration.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const paj = require("../src/paj");
const { deriveSolanaFromEvmKey } = require("../src/multichain");
const { Wallet } = require("ethers");
const cctpBridge = require("../src/cctp_bridge");
const webhookServer = require("../src/webhook_server");
const db = require("../src/db");

test("Paj v2: getRates returns live onRampRate and offRampRate with fee applied", async () => {
  const rates = await paj.getRates("NGN");
  assert.ok(rates, "Expected rates object");
  assert.ok(rates.onRampRate, "Expected onRampRate");
  assert.ok(rates.offRampRate, "Expected offRampRate");
  assert.equal(typeof rates.onRampRate.rate, "number");
  assert.equal(typeof rates.offRampRate.rate, "number");
  assert.ok(rates.onRampRate.rate > 0, "Rate must be positive");
  assert.ok(rates.offRampRate.rate > 0, "Rate must be positive");
});

test("Paj v2: getBanks returns verified Nigerian banks and filters by code", async () => {
  const allBanks = await paj.getBanks({ country: "NG" });
  assert.ok(Array.isArray(allBanks), "Expected array of banks");
  assert.ok(allBanks.length > 50, `Expected many banks, got ${allBanks.length}`);

  // Test filter by GTBank code (000013)
  const gtbank = await paj.getBanks({ code: "000013" });
  assert.ok(Array.isArray(gtbank) && gtbank.length > 0, "Expected GTBank match");
  assert.equal(gtbank[0].code, "000013");
  assert.ok(gtbank[0].name.toLowerCase().includes("guaranty"));

  // Test filter by Wema code (000017)
  const wema = await paj.getBanks({ code: "000017" });
  assert.ok(Array.isArray(wema) && wema.length > 0, "Expected Wema match");
  assert.equal(wema[0].code, "000017");
});

test("Paj v2: createOnrampOrder generates dynamic single-order virtual account", async () => {
  // Generate random deterministic wallet
  const evmWallet = Wallet.createRandom();
  const sol = deriveSolanaFromEvmKey(evmWallet.privateKey);

  const order = await paj.createOnrampOrder({
    fiatAmount: 15000,
    currency: "NGN",
    recipient: sol.solanaAddress,
    chain: "SOLANA",
    userExternalId: "test-unit-user-1",
    businessUSDCFee: 0.1,
  });

  assert.ok(order, "Expected order response");
  assert.ok(order.id, "Expected order ID");
  assert.ok(order.accountNumber, "Expected virtual account number");
  assert.ok(order.accountName, "Expected account name");
  assert.ok(order.bank, "Expected bank name");
  assert.equal(order.status, "INIT", "Order should start in INIT status");
  // Paj v2 adds businessUSDCFee and Solana rent to fiatAmount as documented:
  assert.ok(order.fiatAmount >= 15000, "Fiat amount should be at least input plus fee");
});

test("Paj v2: verifyWebhookSignature validates HMAC-SHA256 signatures", () => {
  const webhookSecret = "whsec_798f601d45a40000000000000000000000000000000000000000000000000000";
  const now = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({ id: "order_123", status: "COMPLETED", amount: 20 });

  const signature = crypto
    .createHmac("sha256", webhookSecret)
    .update(`${now}.${rawBody}`)
    .digest("hex");

  const headers = {
    "x-paj-timestamp": String(now),
    "x-paj-signature": `v1=${signature}`,
  };

  const isValid = paj.verifyWebhookSignature(rawBody, headers, webhookSecret);
  assert.equal(isValid, true, "Signature should be verified");

  // Corrupted payload must fail
  const isInvalid = paj.verifyWebhookSignature(rawBody + "tampered", headers, webhookSecret);
  assert.equal(isInvalid, false, "Tampered payload should fail verification");
});

test("Multi-chain: Deterministic Solana derivation from EVM key", () => {
  const evmWallet = Wallet.createRandom();
  const sol1 = deriveSolanaFromEvmKey(evmWallet.privateKey);
  const sol2 = deriveSolanaFromEvmKey(evmWallet.privateKey);

  assert.equal(sol1.solanaAddress, sol2.solanaAddress, "Must be 100% deterministic");
  assert.ok(sol1.keypair.publicKey, "Expected valid Solana publicKey");
  assert.ok(sol1.secretKeyBase58, "Expected valid base58 secret");
});

test("DB: deterministic Solana address stored and queryable", () => {
  const evmWallet = Wallet.createRandom();
  const testTgId = Date.now();
  const user = db.createUserWithWallet(testTgId, "soltest", evmWallet.address, evmWallet.privateKey, "1234");

  assert.ok(user, "User created");
  assert.ok(user.solana_deposit_address, "Solana address must be auto-derived and stored");

  const queried = db.getUserBySolanaAddress(user.solana_deposit_address);
  assert.ok(queried, "Must look up user by derived Solana address");
  assert.equal(queried.telegram_id, testTgId);
});

test("CCTP Bridge: Domain mapping and auto-bridge initiation", async () => {
  assert.equal(cctpBridge.CCTP_DOMAINS.ARC, 26, "Arc domain must be 26");
  assert.equal(cctpBridge.CCTP_DOMAINS.SOLANA, 5, "Solana domain must be 5");

  const bridgeRes = await cctpBridge.autoBridgeSolanaToArc({
    telegramId: 99999,
    solanaTxSignature: "5wK...mock",
    amountUsdc: 25.0,
    recipientArcAddress: "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359",
  });

  assert.equal(bridgeRes.success, true);
  assert.equal(bridgeRes.status, "initiated");
  assert.equal(bridgeRes.destinationChain, "Arc Mainnet");
  assert.equal(bridgeRes.destinationDomain, 26);
});

test("Webhook Server: processes onramp event and notifies Telegram user", async () => {
  const sentMessages = [];

  const mockBot = {
    telegram: {
      sendMessage: async (id, msg) => {
        sentMessages.push({ id: String(id), msg });
        return { message_id: 1 };
      },
    },
  };

  const dynamicOrderId = `paj_order_test_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const payload = {
    event: "onramp.successful",
    data: {
      id: dynamicOrderId,
      amount: 50.0,
      fiatAmount: 69400,
      userExternalId: "888777",
      destinationArcAddress: "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359",
      txHash: `5wK...solanaSignature${Date.now()}`,
    },
  };

  await webhookServer.processPajEvent(payload, mockBot);

  assert.ok(sentMessages.length >= 1, "At least one Telegram message sent");
  const onrampNotice = sentMessages.find((m) => m.msg.includes("Naira Deposit Confirmed"));
  assert.ok(onrampNotice, "Expected onramp confirmation message");
  assert.equal(onrampNotice.id, "888777");
  assert.ok(onrampNotice.msg.includes("69,400"));
});
