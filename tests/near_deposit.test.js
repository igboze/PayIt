// tests/near_deposit.test.js
// NEAR Intents (1Click) deposit flow — derivation, quote persistence, status
// polling, terminal-state notifications. All 1Click API calls are mocked.

const test = require("node:test");
const assert = require("node:assert/strict");

const near = require("../src/near");
const multichain = require("../src/multichain");
const db = require("../src/db");

const testUserId = 555666777;

// ─── 1. Address derivation ───────────────────────────────────────────────────

test("deriveNearAddress: deterministic, domain-separated from Solana, valid implicit account", () => {
  const evmKey = "0x0123456789012345678901234567890123456789012345678901234567890123";

  const a = near.deriveNearAddress(evmKey);
  const b = near.deriveNearAddress(evmKey);
  assert.equal(a.nearAddress, b.nearAddress, "derivation must be deterministic");
  assert.match(a.nearAddress, /^[0-9a-f]{64}$/, "NEAR implicit account is 64 lowercase hex chars");

  const sol = multichain.deriveSolanaFromEvmKey(evmKey);
  assert.notEqual(a.nearAddress, sol.solanaAddress, "NEAR and Solana addresses must differ (salt separation)");

  const other = near.deriveNearAddress("0x" + "ff".repeat(32));
  assert.notEqual(a.nearAddress, other.nearAddress, "different key -> different NEAR account");
});

// ─── 2. Quote → deposit row lifecycle (mocked API) ──────────────────────────

test("NEAR deposit lifecycle: quote, poll transitions, terminal notifications", async (t) => {
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

  // cleanup any residue
  db.db.prepare("DELETE FROM near_deposits WHERE telegram_id = ?").run(testUserId);

  try {
    let statusQueue = [];
    near.getQuote = async ({ amount, recipient, refundTo, originAsset }) => {
      assert.equal(amount, "5000000", "quote amount must be base units (6 decimals)");
      assert.equal(recipient, "0x1111111111111111111111111111111111111111");
      assert.match(refundTo, /^[0-9a-f]{64}$/);
      assert.equal(originAsset, near.ASSETS.NEAR_USDC);
      return {
        correlationId: "corr-test-1",
        quoteRequest: { deadline: "2099-01-01T00:00:00Z" },
        quote: {
          depositAddress: "1clickDepositAddr.testnet",
          amountOut: "4996590",
          amountOutFormatted: "4.99659",
        },
      };
    };
    near.getExecutionStatus = async (depositAddress) => {
      assert.equal(depositAddress, "1clickDepositAddr.testnet");
      return { status: statusQueue.shift() || "PENDING_DEPOSIT" };
    };

    await t.test("createNearDeposit persists quote and one-time deposit address", async () => {
      const row = await near.createNearDeposit({
        telegramId: testUserId,
        accountType: "personal",
        originAsset: near.ASSETS.NEAR_USDC,
        amountUsdc: 5,
        recipientAddress: "0x1111111111111111111111111111111111111111",
        refundTo: "ab".repeat(32),
      });

      assert.equal(row.status, "awaiting_deposit");
      assert.equal(row.deposit_address, "1clickDepositAddr.testnet");
      assert.ok(Math.abs(row.amount_out - 4.99659) < 1e-9, "amount_out parsed from quote");
      assert.equal(row.correlation_id, "corr-test-1");
    });

    await t.test("poll transitions to SUCCESS and notifies without crediting", async () => {
      statusQueue = ["PROCESSING", "SUCCESS"];
      let res = await near.pollPendingNearDeposits(mockBot);
      assert.equal(res.updated, 1);

      res = await near.pollPendingNearDeposits(mockBot);
      assert.equal(res.updated, 1);
      assert.equal(res.terminal, 1);

      const successMsg = sentMessages.find((m) => m.text.includes("NEAR Deposit Bridged"));
      assert.ok(successMsg, "must notify on SUCCESS");
      assert.equal(successMsg.chatId, testUserId);

      // Never credits here — sweeper owns crediting.
      const tx = db.db.prepare(
        "SELECT COUNT(*) c FROM transactions WHERE telegram_id = ? AND type LIKE '%near%'"
      ).get(testUserId);
      assert.equal(tx.c, 0, "pollPendingNearDeposits must not insert credit transactions");
    });

    await t.test("terminal rows are excluded from future polls", async () => {
      const res = await near.pollPendingNearDeposits(mockBot);
      assert.equal(res.updated, 0, "SUCCESS row must no longer be polled");
    });
  } finally {
    near.getQuote = originalGetQuote;
    near.getExecutionStatus = originalGetStatus;
    db.db.prepare("DELETE FROM near_deposits WHERE telegram_id = ?").run(testUserId);
  }
});

// ─── 3. Refund notification path ─────────────────────────────────────────────

test("REFUNDED deposits notify with the refund address", async () => {
  const sentMessages = [];
  const mockBot = {
    telegram: { sendMessage: async (chatId, text) => { sentMessages.push({ chatId, text }); } },
  };
  const originalGetStatus = near.getExecutionStatus;
  try {
    near.getExecutionStatus = async () => ({ status: "REFUNDED" });
    const id = db.createNearDeposit({
      telegramId: testUserId,
      accountType: "personal",
      originAsset: near.ASSETS.NEAR_USDC,
      amountUsdc: 5,
      recipientAddress: "0x1111111111111111111111111111111111111111",
      refundTo: "cd".repeat(32),
      status: "awaiting_deposit",
    });
    db.updateNearDeposit(id, { deposit_address: "refundCase.testnet" });

    const res = await near.pollPendingNearDeposits(mockBot);
    assert.equal(res.terminal, 1);
    const msg = sentMessages.find((m) => m.text.includes("Refunded"));
    assert.ok(msg, "must notify on REFUNDED");
    assert.match(msg.text, /cdcd/, "refund message must show the refund address");

    db.db.prepare("DELETE FROM near_deposits WHERE id = ?").run(id);
  } finally {
    near.getExecutionStatus = originalGetStatus;
  }
});

// ─── 4. toBaseUnits unit tests ───────────────────────────────────────────────

test("toBaseUnits: accurately converts amounts across varying token decimals", () => {
  assert.equal(near.toBaseUnits(5, 6), "5000000", "USDC 6 dec");
  assert.equal(near.toBaseUnits("5.0", 6), "5000000", "USDC 6 dec string");
  assert.equal(near.toBaseUnits(2.5, 24), "2500000000000000000000000", "NEAR 24 dec");
  assert.equal(near.toBaseUnits("0.005", 18), "5000000000000000", "WETH 18 dec");
  assert.equal(near.toBaseUnits("0.12345678", 8), "12345678", "WBTC 8 dec");
});

// ─── 5. Token resolution ─────────────────────────────────────────────────────

test("resolveNearToken: resolves standard tokens, symbols, and custom NEP-141", async () => {
  const nearTok = await near.resolveNearToken("NEAR");
  assert.equal(nearTok.symbol, "NEAR");
  assert.equal(nearTok.decimals, 24);
  assert.equal(nearTok.assetId, near.ASSETS.NEAR_WNEAR);

  const usdtTok = await near.resolveNearToken("usdt");
  assert.equal(usdtTok.symbol, "USDT");
  assert.equal(usdtTok.decimals, 6);

  const custom = await near.resolveNearToken("nep141:custom-token.near");
  assert.equal(custom.assetId, "nep141:custom-token.near");
  assert.equal(custom.decimals, 18);
});

// ─── 6. Multi-token deposit quote & conversion into Base USDC ───────────────

test("createNearDeposit with non-USDC token (e.g. NEAR): converts to 24-dec base units and quotes Base USDC", async () => {
  const originalGetQuote = near.getQuote;
  const originalGetStatus = near.getExecutionStatus;
  const sentMessages = [];
  const mockBot = {
    telegram: { sendMessage: async (chatId, text) => { sentMessages.push({ chatId, text }); } },
  };

  db.db.prepare("DELETE FROM near_deposits WHERE telegram_id = ?").run(testUserId);

  try {
    near.getQuote = async ({ amount, recipient, refundTo, originAsset, destinationAsset }) => {
      assert.equal(originAsset, near.ASSETS.NEAR_WNEAR, "origin asset must be wNEAR");
      assert.equal(destinationAsset, near.ASSETS.BASE_USDC, "destination asset must be Base USDC");
      assert.equal(amount, "2500000000000000000000000", "2.5 NEAR in 24 decimals");
      assert.equal(recipient, "0x2222222222222222222222222222222222222222");
      return {
        correlationId: "corr-near-multi",
        quoteRequest: { deadline: "2099-01-01T00:00:00Z" },
        quote: {
          depositAddress: "nearMultitokenDeposit.testnet",
          amountOut: "12500000", // $12.50 USDC
          amountOutFormatted: "12.50",
        },
      };
    };

    near.getExecutionStatus = async () => ({ status: "SUCCESS" });

    const row = await near.createNearDeposit({
      telegramId: testUserId,
      accountType: "personal",
      originAsset: near.ASSETS.NEAR_WNEAR,
      originSymbol: "NEAR",
      originDecimals: 24,
      amount: 2.5,
      recipientAddress: "0x2222222222222222222222222222222222222222",
      refundTo: "ee".repeat(32),
    });

    assert.equal(row.status, "awaiting_deposit");
    assert.equal(row.origin_symbol, "NEAR");
    assert.equal(row.deposit_address, "nearMultitokenDeposit.testnet");
    assert.equal(row.amount_out, 12.5);

    await near.pollPendingNearDeposits(mockBot);
    const msg = sentMessages.find((m) => m.text.includes("NEAR Deposit Bridged"));
    assert.ok(msg, "must notify with converted output");
    assert.match(msg.text, /2\.5 NEAR/, "message should mention deposited token and amount");
    assert.match(msg.text, /\$12\.50 USDC/, "message should mention received USDC");
  } finally {
    near.getQuote = originalGetQuote;
    near.getExecutionStatus = originalGetStatus;
    db.db.prepare("DELETE FROM near_deposits WHERE telegram_id = ?").run(testUserId);
  }
});

