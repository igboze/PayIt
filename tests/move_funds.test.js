// tests/move_funds.test.js
// Phase 2: user-triggered CCTP rebalancing (Move Funds) via
// agent/executor.js moveFundsBetweenChains.
// Mocks all network-touching modules; no live RPC, no live CCTP.

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/db");
const walletLib = require("../src/wallet");
const multichain = require("../src/multichain");
const cctpBridge = require("../src/cctp_bridge");
const { moveFundsBetweenChains } = require("../agent/executor");

const testUserId = 777888000;
const userWallet = {
  address: "0x1111111111111111111111111111111111111111",
  privateKey: "0x0123456789012345678901234567890123456789012345678901234567890123",
};
const SOL_ADDR = "SolDerived1111111111111111111111111111111111";

function micro(usdc) {
  return walletLib.parseToMicro(usdc.toFixed ? usdc.toFixed(6) : String(usdc));
}

function cleanup(keys) {
  db.db.prepare("DELETE FROM universal_idempotency WHERE key IN (" + keys.map(() => "?").join(",") + ")").run(...keys);
  db.db.prepare("DELETE FROM transactions WHERE telegram_id = ?").run(testUserId);
  db.db.prepare("DELETE FROM cctp_pending_burns WHERE telegram_id = ?").run(testUserId);
  db.db.prepare("DELETE FROM cctp_inbound_transfers WHERE telegram_id = ?").run(testUserId);
}

test("moveFundsBetweenChains: Arc→Solana and Solana→Arc, guards, idempotency", async (t) => {
  const orig = {
    getNativeBalanceMicro: walletLib.getNativeBalanceMicro,
    getSplTokenBalance: multichain.getSplTokenBalance,
    deriveSolanaFromEvmKey: multichain.deriveSolanaFromEvmKey,
    executeSolanaCctpBurn: multichain.executeSolanaCctpBurn,
    executeArcToSolanaCctpBurn: cctpBridge.executeArcToSolanaCctpBurn,
    checkSolanaFeePayerBalance: cctpBridge.checkSolanaFeePayerBalance,
    completeInboundCctpTransferFlow: cctpBridge.completeInboundCctpTransferFlow,
  };

  // Test-controlled state
  let arcUsdc = 0;
  let solUsdc = 0;
  let feePayerOk = true;
  const calls = {
    arcBurns: [],
    solBurns: [],
    inboundFlows: [],
  };

  walletLib.getNativeBalanceMicro = async () => micro(arcUsdc);
  multichain.getSplTokenBalance = async () => ({ uiAmount: solUsdc });
  multichain.deriveSolanaFromEvmKey = () => ({
    keypair: { publicKey: { toBase58: () => SOL_ADDR } },
    solanaAddress: SOL_ADDR,
  });
  multichain.executeSolanaCctpBurn = async ({ userKeypair, amountUsdc: amt, recipientArcAddress }) => {
    calls.solBurns.push({ from: userKeypair.publicKey.toBase58(), amountUsdc: amt, recipientArcAddress });
    return { success: true, txSignature: "sol_burn_sig" };
  };
  cctpBridge.executeArcToSolanaCctpBurn = async (args) => {
    calls.arcBurns.push(args);
    return { success: true, txHash: "0xarc_burn_hash" };
  };
  cctpBridge.checkSolanaFeePayerBalance = async () =>
    feePayerOk
      ? { ok: true, balanceSol: 0.5, address: "FeePayer111111111111111111111111111111111" }
      : { ok: false, balanceSol: 0, address: "FeePayer111111111111111111111111111111111" };
  cctpBridge.completeInboundCctpTransferFlow = async (args) => {
    calls.inboundFlows.push(args);
    return "0xarc_mint_hash";
  };

  const idemKeys = [
    `move:${testUserId}:arc_to_solana:25`,
    `move:${testUserId}:arc_to_solana:20`,
    `move:${testUserId}:arc_to_solana:10`,
    `move:${testUserId}:solana_to_arc:12`,
    `move:${testUserId}:solana_to_arc:8`,
    `move:${testUserId}:solana_to_arc:5`,
    `move:${testUserId}:solana_to_arc:40`,
    `move:${testUserId}:doge_to_moon:1`,
  ];
  cleanup(idemKeys);

  try {
    await t.test("Arc→Solana: burns exact amount on Arc to the derived Solana address", async () => {
      arcUsdc = 100; solUsdc = 0;
      const res = await moveFundsBetweenChains(userWallet, {
        direction: "arc_to_solana", amountUsdc: 25, telegramId: testUserId,
      });
      assert.equal(res.success, true, JSON.stringify(res));
      assert.equal(res.fromChain, "arc");
      assert.equal(res.toChain, "solana");
      assert.equal(res.txHash, "0xarc_burn_hash");
      assert.equal(calls.arcBurns.length, 1);
      assert.equal(calls.arcBurns[0].amountUsdc, 25);
      assert.equal(calls.arcBurns[0].recipientSolanaAddress, SOL_ADDR);
      assert.equal(calls.arcBurns[0].autoCompleteOnSolana, true);
    });

    await t.test("Arc→Solana: rejects when Arc balance is insufficient and never burns", async () => {
      arcUsdc = 10; solUsdc = 0;
      const burnCountBefore = calls.arcBurns.length;
      const res = await moveFundsBetweenChains(userWallet, {
        direction: "arc_to_solana", amountUsdc: 20, telegramId: testUserId,
      });
      assert.equal(res.success, false);
      assert.match(res.error, /Not enough USDC on Arc/);
      assert.equal(calls.arcBurns.length, burnCountBefore);
    });

    await t.test("Arc→Solana: identical repeat returns the cached completed result (idempotent)", async () => {
      arcUsdc = 100; solUsdc = 0;
      const first = await moveFundsBetweenChains(userWallet, {
        direction: "arc_to_solana", amountUsdc: 10, telegramId: testUserId,
      });
      assert.equal(first.success, true, JSON.stringify(first));
      const burnCountBefore = calls.arcBurns.length;
      const second = await moveFundsBetweenChains(userWallet, {
        direction: "arc_to_solana", amountUsdc: 10, telegramId: testUserId,
      });
      assert.equal(second.success, true);
      assert.equal(second.duplicate, true);
      assert.equal(second.txHash, "0xarc_burn_hash");
      assert.equal(calls.arcBurns.length, burnCountBefore, "duplicate must not burn again");
    });

    await t.test("Solana→Arc: burns the requested amount (not the whole balance) and starts inbound flow", async () => {
      arcUsdc = 0; solUsdc = 50; feePayerOk = true;
      const res = await moveFundsBetweenChains(userWallet, {
        direction: "solana_to_arc", amountUsdc: 12, telegramId: testUserId,
      });
      assert.equal(res.success, true, JSON.stringify(res));
      assert.equal(res.fromChain, "solana");
      assert.equal(res.toChain, "arc");
      assert.equal(res.txHash, "sol_burn_sig");
      assert.equal(calls.solBurns.length, 1);
      assert.equal(calls.solBurns[0].amountUsdc, 12, "must burn the requested amount only");
      assert.equal(calls.solBurns[0].from, SOL_ADDR);
      assert.equal(calls.solBurns[0].recipientArcAddress, userWallet.address);
      assert.equal(calls.inboundFlows.length, 1);
      assert.equal(calls.inboundFlows[0].solanaBurnSig, "sol_burn_sig");
      assert.equal(calls.inboundFlows[0].recipientArcAddress, userWallet.address);
      assert.equal(calls.inboundFlows[0].amountUsdc, 12);
    });

    await t.test("Solana→Arc: inbound ledger row is recorded, marked burned, and visible in user history", () => {
      const rows = db.getRecentInboundByUser(testUserId, 5);
      assert.ok(rows.length >= 1, "expected at least one inbound row");
      const row = rows.find((r) => r.solana_burn_sig === "sol_burn_sig");
      assert.ok(row, "burned inbound row missing");
      assert.equal(row.status, "burned");
      assert.equal(row.amount_usdc, 12);
      assert.equal(row.arc_address, userWallet.address);
      assert.equal(row.solana_address, SOL_ADDR);
    });

    await t.test("Solana→Arc: move tx row carries the burn sig so the background flow can confirm it", () => {
      const row = db.db.prepare(
        "SELECT * FROM transactions WHERE telegram_id = ? AND type = 'move_funds' AND chain = 'solana' ORDER BY id DESC LIMIT 1"
      ).get(testUserId);
      assert.ok(row, "move_funds transaction row missing");
      assert.equal(row.tx_hash, "sol_burn_sig");
      assert.equal(row.status, "submitted");
    });

    await t.test("Solana→Arc: rejects when SPL balance is insufficient without burning", async () => {
      arcUsdc = 0; solUsdc = 5; feePayerOk = true;
      const burnCountBefore = calls.solBurns.length;
      const res = await moveFundsBetweenChains(userWallet, {
        direction: "solana_to_arc", amountUsdc: 8, telegramId: testUserId,
      });
      assert.equal(res.success, false);
      assert.match(res.error, /Not enough USDC on Solana/);
      assert.equal(calls.solBurns.length, burnCountBefore);
    });

    await t.test("Solana→Arc: refuses to burn when the fee payer is low on SOL", async () => {
      arcUsdc = 0; solUsdc = 50; feePayerOk = false;
      const burnCountBefore = calls.solBurns.length;
      const res = await moveFundsBetweenChains(userWallet, {
        direction: "solana_to_arc", amountUsdc: 5, telegramId: testUserId,
      });
      assert.equal(res.success, false);
      assert.match(res.error, /insufficient SOL/i);
      assert.equal(calls.solBurns.length, burnCountBefore, "must not burn when fee payer is low");
    });

    await t.test("unknown direction is rejected", async () => {
      const res = await moveFundsBetweenChains(userWallet, {
        direction: "doge_to_moon", amountUsdc: 1, telegramId: testUserId,
      });
      assert.equal(res.success, false);
      assert.match(res.error, /Unknown direction/);
    });
  } finally {
    walletLib.getNativeBalanceMicro = orig.getNativeBalanceMicro;
    multichain.getSplTokenBalance = orig.getSplTokenBalance;
    multichain.deriveSolanaFromEvmKey = orig.deriveSolanaFromEvmKey;
    multichain.executeSolanaCctpBurn = orig.executeSolanaCctpBurn;
    cctpBridge.executeArcToSolanaCctpBurn = orig.executeArcToSolanaCctpBurn;
    cctpBridge.checkSolanaFeePayerBalance = orig.checkSolanaFeePayerBalance;
    cctpBridge.completeInboundCctpTransferFlow = orig.completeInboundCctpTransferFlow;
    cleanup(idemKeys);
  }
});
