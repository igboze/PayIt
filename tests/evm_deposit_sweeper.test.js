// tests/evm_deposit_sweeper.test.js
// Comprehensive test suite for Automated EVM Cross-Chain Deposit Engine
// Tests database resolution, system key encryption, DEX router resolution,
// CCTP V2 contract mapping, webhook payload routing, and idempotency deduplication.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/db");
const walletLib = require("../src/wallet");
const cctpBridge = require("../src/cctp_bridge");
const evmDepositSweeper = require("../src/evm_deposit_sweeper");
const idempotency = require("../src/idempotency");

test("Automated EVM Cross-Chain Deposit Engine Test Suite", async (t) => {
  const testUserId = 777666555;
  const personalAddress = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
  const businessAddress = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4df";
  const testPrivateKey = "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d";
  const testBizPrivateKey = "0x6cbed15c793ce57650b9877cf26f5d7d9571f00cd8237e826ec7b4013e9a63f2";
  const testPin = "4321";

  // Cleanup any old test user
  db.db.prepare("DELETE FROM users WHERE telegram_id = ?").run(testUserId);
  db.db.prepare("DELETE FROM transactions WHERE telegram_id = ?").run(testUserId);
  db.db.prepare("DELETE FROM points_history WHERE telegram_id = ?").run(testUserId);

  await t.test("1. Database: User creation stores system_encrypted_key & biz_system_encrypted_key", () => {
    const user = db.createUserWithWallet(
      testUserId,
      "evm_test_user",
      personalAddress,
      testPrivateKey,
      testPin,
      businessAddress,
      testBizPrivateKey
    );

    assert.ok(user, "User record must be returned");
    assert.equal(user.telegram_id, testUserId);
    assert.ok(user.system_encrypted_key, "system_encrypted_key must be present");
    assert.ok(user.biz_system_encrypted_key, "biz_system_encrypted_key must be present");

    // Decrypt keys using system operational secret
    const decryptedPersonal = db.getSystemDecryptedPrivateKey(user, "personal");
    const decryptedBiz = db.getSystemDecryptedPrivateKey(user, "business");

    assert.equal(decryptedPersonal.toLowerCase(), testPrivateKey.toLowerCase());
    assert.equal(decryptedBiz.toLowerCase(), testBizPrivateKey.toLowerCase());
  });

  await t.test("2. Database: getUserByDepositAddress resolves personal and business wallets case-insensitively", () => {
    // Exact match personal
    const user1 = db.getUserByDepositAddress(personalAddress);
    assert.ok(user1, "Must find user by personal address");
    assert.equal(user1.telegram_id, testUserId);

    // Lowercase personal
    const user2 = db.getUserByDepositAddress(personalAddress.toLowerCase());
    assert.ok(user2, "Must find user by lowercase personal address");
    assert.equal(user2.telegram_id, testUserId);

    // Uppercase personal
    const user3 = db.getUserByDepositAddress(personalAddress.toUpperCase());
    assert.ok(user3, "Must find user by uppercase personal address");
    assert.equal(user3.telegram_id, testUserId);

    // Business address
    const userBiz = db.getUserByDepositAddress(businessAddress);
    assert.ok(userBiz, "Must find user by business address");
    assert.equal(userBiz.telegram_id, testUserId);

    // Non-existent address
    const nonExistent = db.getUserByDepositAddress("0x0000000000000000000000000000000000000999");
    assert.equal(nonExistent, null, "Must return null for unknown address");
  });

  await t.test("3. Database: Seamless backfilling of system_encrypted_key on PIN verification", () => {
    // Artificially clear system_encrypted_key to simulate legacy user
    db.db.prepare("UPDATE users SET system_encrypted_key = NULL, biz_system_encrypted_key = NULL WHERE telegram_id = ?").run(testUserId);
    let user = db.getUser(testUserId);
    assert.equal(user.system_encrypted_key, null);
    assert.equal(user.biz_system_encrypted_key, null);

    // Verify PIN -> triggers backfill
    const isPinValid = db.verifyPin(testUserId, testPin);
    assert.equal(isPinValid, true, "PIN must be verified");

    // Fetch fresh user record
    user = db.getUser(testUserId);
    assert.ok(user.system_encrypted_key, "system_encrypted_key must be backfilled");
    assert.ok(user.biz_system_encrypted_key, "biz_system_encrypted_key must be backfilled");

    const recoveredKey = db.getSystemDecryptedPrivateKey(user, "personal");
    assert.equal(recoveredKey.toLowerCase(), testPrivateKey.toLowerCase());
  });

  await t.test("4. DEX Configuration: Resolves routers and pairs for Base, Arbitrum, Ethereum, Avalanche, Polygon", () => {
    const baseDex = evmDepositSweeper.resolveDexConfig(8453);
    assert.ok(baseDex, "Must resolve Base DEX");
    assert.equal(baseDex.name, "Base");
    assert.equal(baseDex.routerAddress, "0x2626664c2603336E57B271c5C0b26F421741e481");
    assert.equal(baseDex.usdcAddress.toLowerCase(), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase());
    assert.equal(baseDex.nativeSymbol, "ETH");

    const arbDex = evmDepositSweeper.resolveDexConfig("Arbitrum");
    assert.ok(arbDex, "Must resolve Arbitrum DEX");
    assert.equal(arbDex.chainId, 42161);
    assert.equal(arbDex.usdcAddress.toLowerCase(), "0xaf88d065e77c8cC2239327C5EDb3A432268e5831".toLowerCase());

    const ethDex = evmDepositSweeper.resolveDexConfig(1);
    assert.ok(ethDex, "Must resolve Ethereum DEX");
    assert.equal(ethDex.usdcAddress.toLowerCase(), "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".toLowerCase());

    const avaxDex = evmDepositSweeper.resolveDexConfig("Avalanche");
    assert.ok(avaxDex, "Must resolve Avalanche DEX");
    assert.equal(avaxDex.nativeSymbol, "AVAX");

    const polyDex = evmDepositSweeper.resolveDexConfig(137);
    assert.ok(polyDex, "Must resolve Polygon DEX");
    assert.equal(polyDex.nativeSymbol, "POL");
  });

  await t.test("5. CCTP V2: Resolves TokenMessenger, MessageTransmitter, and domain IDs for Arc (26)", () => {
    const baseCctp = cctpBridge.resolveEvmCctpConfig(8453);
    assert.ok(baseCctp, "Must resolve Base CCTP");
    assert.equal(baseCctp.domain, 6);
    assert.equal(baseCctp.tokenMessenger.toLowerCase(), "0x1682Ae6375C4E4A97e4B583BC394c36577037E7e".toLowerCase());

    const arbCctp = cctpBridge.resolveEvmCctpConfig(42161);
    assert.ok(arbCctp, "Must resolve Arbitrum CCTP");
    assert.equal(arbCctp.domain, 3);
    assert.equal(arbCctp.tokenMessenger.toLowerCase(), "0x19330d10D9Cc8751218eaf51E8885D058642E08A".toLowerCase());

    const ethCctp = cctpBridge.resolveEvmCctpConfig(1);
    assert.ok(ethCctp, "Must resolve Ethereum CCTP");
    assert.equal(ethCctp.domain, 0);

    const avaxCctp = cctpBridge.resolveEvmCctpConfig(43114);
    assert.ok(avaxCctp, "Must resolve Avalanche CCTP");
    assert.equal(avaxCctp.domain, 1);

    const polyCctp = cctpBridge.resolveEvmCctpConfig(137);
    assert.ok(polyCctp, "Must resolve Polygon CCTP");
    assert.equal(polyCctp.domain, 7);

    assert.equal(cctpBridge.CCTP_DOMAINS.ARC, 26, "Arc Domain ID must be 26");
    assert.equal(
      cctpBridge.ARC_CCTP_CONTRACTS.TOKEN_MESSENGER.toLowerCase(),
      "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d".toLowerCase()
    );
  });

  await t.test("6. Token Type Detection: Correctly categorizes native gas vs ERC-20 tokens", () => {
    const baseCfg = evmDepositSweeper.resolveDexConfig(8453);
    assert.equal(evmDepositSweeper.isNativeToken("ETH", baseCfg), true);
    assert.equal(evmDepositSweeper.isNativeToken("native", baseCfg), true);
    assert.equal(evmDepositSweeper.isNativeToken(null, baseCfg), true);
    assert.equal(evmDepositSweeper.isNativeToken("USDC", baseCfg), false);
    assert.equal(evmDepositSweeper.isNativeToken("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", baseCfg), false);

    const avaxCfg = evmDepositSweeper.resolveDexConfig(43114);
    assert.equal(evmDepositSweeper.isNativeToken("AVAX", avaxCfg), true);
    assert.equal(evmDepositSweeper.isNativeToken("USDC", avaxCfg), false);
  });

  await t.test("7. Idempotency: Deduplicates repetitive webhook events with the same txHash", async () => {
    const testHash = `0xdeadbeef_${Date.now()}`;
    const eventKey = `evm_deposit_${testHash}_${personalAddress}`;

    assert.equal(idempotency.isWebhookProcessed(eventKey), false, "Initial check must be false");

    idempotency.markWebhookProcessed(eventKey, "crypto_deposit", testHash);
    assert.equal(idempotency.isWebhookProcessed(eventKey), true, "Subsequent check must be true");

    // Second processing of identical payload must be rejected as duplicate
    const mockPayload = {
      chainId: 8453,
      to: personalAddress,
      from: "0x123",
      token: "USDC",
      amount: "25.0",
      txHash: testHash,
    };

    const result = await evmDepositSweeper.processEvmDeposit(mockPayload);
    assert.equal(result.duplicate, true, "Duplicate deposit must return duplicate: true");
  });

  await t.test("8. Full Deposit Routing & User Notification Integration", async () => {
    const uniqueTxHash = `0xsuccess_tx_${Date.now()}`;
    const sentMessages = [];

    const mockBot = {
      telegram: {
        sendMessage: async (chatId, text, opts) => {
          sentMessages.push({ chatId, text, opts });
          return { message_id: 101 };
        },
      },
    };

    // Override disburseDirectOnArc temporarily to avoid broadcasting real funds on mainnet during unit test
    const originalDisburse = cctpBridge.disburseDirectOnArc;
    cctpBridge.disburseDirectOnArc = async ({ recipientArcAddress, amountUsdc }) => {
      return `0xarc_settlement_${Date.now()}`;
    };

    try {
      const depositPayload = {
        chainId: 8453,
        to: personalAddress,
        from: "0x5555555555555555555555555555555555555555",
        token: "USDC",
        amount: "50.00",
        txHash: uniqueTxHash,
      };

      const res = await evmDepositSweeper.processEvmDeposit(depositPayload, mockBot);

      assert.equal(res.success, true, "Deposit processing must succeed");
      assert.equal(res.amountUsdc, 50.0);
      assert.equal(res.recipient, personalAddress);
      assert.equal(res.sourceChain, "Base");

      // Verify Telegram notification was dispatched
      assert.equal(sentMessages.length, 1, "Must send 1 Telegram message");
      assert.equal(sentMessages[0].chatId, testUserId);
      assert.match(sentMessages[0].text, /Cross-Chain Deposit Credited/);
      assert.match(sentMessages[0].text, /50\.00/);
      assert.match(sentMessages[0].text, /Base/);

      // Verify transaction was logged in database
      const txs = db.getTransactions(testUserId, 5, "personal");
      const loggedTx = txs.find((t) => t.type === "deposit_crosschain");
      assert.ok(loggedTx, "deposit_crosschain transaction must be logged");

      // Verify loyalty points were awarded
      const points = db.getPointsBalance(testUserId);
      assert.ok(points >= 5, "Points balance should reflect deposit bonus");
    } finally {
      cctpBridge.disburseDirectOnArc = originalDisburse;
    }
  });

  await t.test("9. Security: Alchemy Webhook HMAC-SHA256 signature verification", () => {
    const { verifyAlchemySignature } = require("../src/webhook_server");
    const crypto = require("crypto");
    const signingKey = "alch_test_key_123456";
    const body = Buffer.from(JSON.stringify({ event: { network: "ETH_MAINNET", activity: [] } }));
    const validSig = crypto.createHmac("sha256", signingKey).update(body).digest("hex");

    // Correct signature
    const validResult = verifyAlchemySignature(body, { "x-alchemy-signature": validSig }, signingKey);
    assert.equal(validResult, true, "Signature must validate successfully with correct key");

    // Tampered body
    const tamperedResult = verifyAlchemySignature(Buffer.from("tampered"), { "x-alchemy-signature": validSig }, signingKey);
    assert.equal(tamperedResult, false, "Signature must fail with tampered body");

    // Wrong signature
    const wrongResult = verifyAlchemySignature(body, { "x-alchemy-signature": "0000000000000000000000000000000000000000000000000000000000000000" }, signingKey);
    assert.equal(wrongResult, false, "Signature must fail with invalid digest");
  });

  // Final cleanup
  db.db.prepare("DELETE FROM users WHERE telegram_id = ?").run(testUserId);
  db.db.prepare("DELETE FROM transactions WHERE telegram_id = ?").run(testUserId);
  db.db.prepare("DELETE FROM points_history WHERE telegram_id = ?").run(testUserId);
});
