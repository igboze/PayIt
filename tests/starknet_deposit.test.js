// tests/starknet_deposit.test.js
// NEAR Intents (1Click) Starknet integration tests
// Tests token resolution, address derivation, fee inclusion, quote creation, and polling transitions.

const test = require("node:test");
const assert = require("node:assert/strict");

const near = require("../src/near");
const db = require("../src/db");

const testUserId = 999111222;

test("Starknet token catalog and resolution", async () => {
  const tokens = await near.getSupportedStarknetTokens();
  assert.ok(Array.isArray(tokens) && tokens.length >= 4, "Must contain Starknet tokens");

  const strk = await near.resolveStarknetToken("STRK");
  assert.ok(strk, "Must resolve STRK");
  assert.equal(strk.symbol, "STRK");
  assert.equal(strk.decimals, 18);
  assert.equal(strk.blockchain, "starknet");

  const eth = await near.resolveStarknetToken("eth");
  assert.ok(eth, "Must resolve ETH (case-insensitive)");
  assert.equal(eth.symbol, "ETH");
  assert.equal(eth.decimals, 18);

  const zec = await near.resolveStarknetToken("ZEC");
  assert.ok(zec, "Must resolve ZEC");
  assert.equal(zec.symbol, "ZEC");

  const byContract = await near.resolveStarknetToken("0x05ce53b9b68fb8e9ecab9283a96d97948914733fd6ed8d9a53a276a419497841");
  assert.ok(byContract, "Must resolve by contract address");
  assert.equal(byContract.symbol, "ZEC");

  const unknown = await near.resolveStarknetToken("NONEXISTENT_STARK_TOKEN");
  assert.equal(unknown, null, "Must return null for unknown token");
});

test("deriveStarknetAddress: deterministic, domain-separated 32-byte hex address", () => {
  const evmKey = "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7dc1a931674b7";
  const a = near.deriveStarknetAddress(evmKey);
  const b = near.deriveStarknetAddress(evmKey);

  assert.equal(a.starknetAddress, b.starknetAddress, "derivation must be deterministic");
  assert.ok(a.starknetAddress.startsWith("0x"), "Starknet address must start with 0x");
  assert.equal(a.starknetAddress.length, 66, "Starknet address must be 32 bytes hex prefixed with 0x");

  const other = near.deriveStarknetAddress("0x" + "ff".repeat(32));
  assert.notEqual(a.starknetAddress, other.starknetAddress, "different key -> different Starknet account");

  const nearAccount = near.deriveNearAddress(evmKey);
  assert.notEqual(a.publicKeyHex, nearAccount.nearAddress, "salt separation between Starknet and NEAR accounts");
});

test("Starknet deposit lifecycle: quote, fee inclusion, poll, and notifications", async (t) => {
  const sentMessages = [];
  const mockBot = {
    telegram: {
      sendMessage: async (chatId, text) => {
        sentMessages.push({ chatId, text });
        return { message_id: 1 };
      },
    },
  };

  const originalGetQuote = near.getQuote;
  const originalGetStatus = near.getExecutionStatus;

  // Cleanup residue
  try {
    db.db.prepare("DELETE FROM near_deposits WHERE telegram_id = ?").run(testUserId);
  } catch (_) {
    try {
      db._db.prepare("DELETE FROM near_deposits WHERE telegram_id = ?").run(testUserId);
    } catch (_) {}
  }

  try {
    let capturedQuoteArgs = null;
    near.getQuote = async (args) => {
      capturedQuoteArgs = args;
      const { amount, recipient, refundTo, originAsset, destinationAsset } = args;
      assert.equal(amount, "100000000000000000000", "Amount must be in base units (18 decimals for STRK)");
      assert.equal(recipient, "0x1234567890123456789012345678901234567890");
      assert.ok(refundTo.startsWith("0x"), "Refund address must be Starknet hex address");
      assert.equal(destinationAsset, near.ASSETS.BASE_USDC);
      assert.ok(originAsset.includes("starknet"), "Origin asset must be on Starknet");

      return {
        quote: {
          depositAddress: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          depositMemo: null,
          amountOut: "10500000", // 10.50 USDC
        },
        quoteRequest: {
          deadline: "2026-10-12T15:00:00Z",
        },
        correlationId: "starknet-corr-123",
      };
    };

    let statusQueue = [];
    near.getExecutionStatus = async (depositAddress) => {
      assert.equal(depositAddress, "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
      return statusQueue.shift() || { status: "AWAITING_DEPOSIT" };
    };

    await t.test("createStarknetDeposit stores quote and one-time Starknet address", async () => {
      const strkToken = await near.resolveStarknetToken("STRK");
      const row = await near.createStarknetDeposit({
        telegramId: testUserId,
        originAsset: strkToken.assetId,
        originSymbol: strkToken.symbol,
        originDecimals: strkToken.decimals,
        amount: 100, // 100 STRK
        recipientAddress: "0x1234567890123456789012345678901234567890",
        refundTo: "0x0000000000000000000000000000000000000000000000000000000000000001",
      });

      assert.ok(row.id, "Must return row with ID");
      assert.equal(row.status, "awaiting_deposit");
      assert.equal(row.deposit_address, "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
      assert.equal(row.amount_out, 10.5);
      assert.equal(row.origin_symbol, "STRK");
    });

    await t.test("pollPendingNearDeposits handles Starknet SUCCESS with Starknet branding", async () => {
      statusQueue = [{ status: "PROCESSING" }, { status: "SUCCESS" }];

      let res = await near.pollPendingNearDeposits(mockBot);
      assert.equal(res.updated, 1, "Must update from awaiting_deposit -> PROCESSING");

      res = await near.pollPendingNearDeposits(mockBot);
      assert.equal(res.updated, 1, "Must update from PROCESSING -> SUCCESS");
      assert.equal(res.terminal, 1, "SUCCESS is terminal");

      const successMsg = sentMessages.find((m) => m.chatId === testUserId && m.text.includes("Starknet Deposit Bridged"));
      assert.ok(successMsg, "Must send Starknet Deposit Bridged notification");
      assert.ok(successMsg.text.includes("Starknet → NEAR Intents (1Click) → Base USDC"));
      assert.ok(successMsg.text.includes("Auto-sweeping to your Arc balance"));
    });

    await t.test("Platform fee collection: getNearFeeBps and getNearFeeRecipient configured", () => {
      const feeBps = near.getNearFeeBps();
      assert.ok(feeBps >= 20, "Platform fee BPS must be at least 20 (default 50 bps)");
      const recipient = near.getNearFeeRecipient();
      assert.ok(recipient && recipient.startsWith("0x"), "Platform fee recipient must be configured");
    });
  } finally {
    near.getQuote = originalGetQuote;
    near.getExecutionStatus = originalGetStatus;
    try {
      db.db.prepare("DELETE FROM near_deposits WHERE telegram_id = ?").run(testUserId);
    } catch (_) {
      try {
        db._db.prepare("DELETE FROM near_deposits WHERE telegram_id = ?").run(testUserId);
      } catch (_) {}
    }
  }
});
