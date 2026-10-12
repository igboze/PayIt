// tests/robinhood_deposit.test.js
// NEAR Intents (1Click) Robinhood Chain integration tests
// Tests token resolution, quoting, deposit creation, and terminal notifications.

const test = require("node:test");
const assert = require("node:assert/strict");

const near = require("../src/near");
const db = require("../src/db");

const testUserId = 888999111;

test("Robinhood Chain token catalog and resolution", async () => {
  const tokens = await near.getSupportedRobinhoodTokens();
  assert.ok(Array.isArray(tokens) && tokens.length >= 6, "Must contain all 6 Robinhood Chain tokens");

  const usdg = await near.resolveRobinhoodToken("USDG");
  assert.ok(usdg, "Must resolve USDG");
  assert.equal(usdg.symbol, "USDG");
  assert.equal(usdg.decimals, 6);
  assert.equal(usdg.blockchain, "hood");

  const eth = await near.resolveRobinhoodToken("eth");
  assert.ok(eth, "Must resolve ETH (case-insensitive)");
  assert.equal(eth.symbol, "ETH");
  assert.equal(eth.decimals, 18);

  const byContract = await near.resolveRobinhoodToken("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
  assert.ok(byContract, "Must resolve by contract address");
  assert.equal(byContract.symbol, "USDG");

  const unknown = await near.resolveRobinhoodToken("NONEXISTENT_TOKEN_XYZ");
  assert.equal(unknown, null, "Must return null for unknown token");
});

test("Robinhood Chain deposit lifecycle: quote, poll, and notifications", async (t) => {
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

  // Cleanup DB residue
  db._db.prepare("DELETE FROM near_deposits WHERE telegram_id = ?").run(testUserId);

  try {
    let statusQueue = [];
    near.getQuote = async ({ amount, recipient, refundTo, originAsset, destinationAsset }) => {
      assert.equal(amount, "10000000", "Amount must be in base units (6 decimals for USDG)");
      assert.equal(recipient, "0x1234567890123456789012345678901234567890");
      assert.equal(refundTo, "0x1234567890123456789012345678901234567890");
      assert.equal(destinationAsset, near.ASSETS.BASE_USDC);
      assert.ok(originAsset.includes("hood"), "Origin asset must be on Robinhood Chain");
      return {
        correlationId: "corr-hood-test-1",
        quoteRequest: { deadline: "2099-01-01T00:00:00Z" },
        quote: {
          depositAddress: "0x7777777777777777777777777777777777777777",
          amountOut: "9965000",
          amountOutFormatted: "9.965",
        },
      };
    };

    near.getExecutionStatus = async (depositAddress) => {
      assert.equal(depositAddress, "0x7777777777777777777777777777777777777777");
      return { status: statusQueue.shift() || "PENDING_DEPOSIT" };
    };

    await t.test("createRobinhoodDeposit stores quote and one-time Robinhood Chain EVM address", async () => {
      const usdgToken = await near.resolveRobinhoodToken("USDG");
      const row = await near.createRobinhoodDeposit({
        telegramId: testUserId,
        accountType: "personal",
        originAsset: usdgToken.assetId,
        originSymbol: usdgToken.symbol,
        originDecimals: usdgToken.decimals,
        amount: 10,
        recipientAddress: "0x1234567890123456789012345678901234567890",
        refundTo: "0x1234567890123456789012345678901234567890",
      });

      assert.equal(row.status, "awaiting_deposit");
      assert.equal(row.deposit_address, "0x7777777777777777777777777777777777777777");
      assert.equal(row.origin_symbol, "USDG");
      assert.equal(row.amount_token, 10);
      assert.ok(Math.abs(row.amount_out - 9.965) < 1e-4);
      assert.equal(row.correlation_id, "corr-hood-test-1");
    });

    await t.test("pollPendingNearDeposits handles Robinhood Chain SUCCESS with Robinhood branding", async () => {
      statusQueue = ["PROCESSING", "SUCCESS"];
      let res = await near.pollPendingNearDeposits(mockBot);
      assert.equal(res.updated, 1);

      res = await near.pollPendingNearDeposits(mockBot);
      assert.equal(res.updated, 1);
      assert.equal(res.terminal, 1);

      const successMsg = sentMessages.find((m) => m.text.includes("Robinhood Chain Deposit Bridged"));
      assert.ok(successMsg, "Must notify with Robinhood Chain specific header");
      assert.ok(successMsg.text.includes("Robinhood Chain → NEAR Intents (1Click) → Base USDC"));
      assert.equal(successMsg.chatId, testUserId);
    });
  } finally {
    near.getQuote = originalGetQuote;
    near.getExecutionStatus = originalGetStatus;
    db._db.prepare("DELETE FROM near_deposits WHERE telegram_id = ?").run(testUserId);
  }
});
