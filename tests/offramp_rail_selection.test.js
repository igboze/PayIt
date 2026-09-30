// tests/offramp_rail_selection.test.js
// Phase 1: dual-chain cash-out — rail selection in executeOfframp.
// Mocks all network-touching modules; no live RPC, no live Paj calls.

// Configure Arc rail BEFORE requiring src/paj.js (RAILS is built at load time).
process.env.PAJ_ARC_OFFRAMP_ENABLED = "true";
process.env.PAJ_ARC_MINT = "0x3600000000000000000000000000000000000000";

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/db");
const walletLib = require("../src/wallet");
const multichain = require("../src/multichain");
const offramp = require("../src/offramp");
const paj = require("../src/paj");
const autoEarn = require("../src/auto_earn");
const { executeOfframp } = require("../agent/executor");

const testUserId = 777888999;
const userWallet = {
  address: "0x1111111111111111111111111111111111111111",
  privateKey: "0x0123456789012345678901234567890123456789012345678901234567890123",
};

function micro(usdc) {
  return walletLib.parseToMicro(usdc.toFixed ? usdc.toFixed(6) : String(usdc));
}

test("Rail selection: Arc rail, auto-pick, Solana-only, and disabled-Arc cases", async (t) => {
  // ── Snapshot originals ────────────────────────────────────────────────────
  const orig = {
    getNativeBalanceMicro: walletLib.getNativeBalanceMicro,
    sendFromWallet: walletLib.sendFromWallet,
    getSplTokenBalance: multichain.getSplTokenBalance,
    getOrDeriveSolanaAddress: multichain.getOrDeriveSolanaAddress,
    deriveSolanaFromEvmKey: multichain.deriveSolanaFromEvmKey,
    sendSolanaTransfer: multichain.sendSolanaTransfer,
    requestOfframp: offramp.requestOfframp,
    getUser: db.getUser,
    ensureLiquidBalance: autoEarn.ensureLiquidBalance,
  };

  // Test-controlled state
  let arcUsdc = 0;
  let solUsdc = 0;
  const calls = { orderChains: [], solanaTransfers: 0, arcSends: 0 };

  walletLib.getNativeBalanceMicro = async () => micro(arcUsdc);
  walletLib.sendFromWallet = async (wallet, to, amountMicro) => {
    calls.arcSends++;
    return "0xarc_tx_hash";
  };
  multichain.getSplTokenBalance = async () => ({ uiAmount: solUsdc });
  multichain.getOrDeriveSolanaAddress = () => "SolDerived1111111111111111111111111111111111";
  multichain.deriveSolanaFromEvmKey = () => ({
    keypair: { publicKey: { toBase58: () => "SolDerived1111111111111111111111111111111111" } },
    solanaAddress: "SolDerived1111111111111111111111111111111111",
  });
  multichain.sendSolanaTransfer = async ({ recipientAddress, amount }) => {
    calls.solanaTransfers++;
    return { txHash: "sol_tx_signature", recipientAddress, amount };
  };
  offramp.requestOfframp = async (telegramId, amountMicroArg, bankDetails) => {
    calls.orderChains.push({ chain: bankDetails.chain, mint: bankDetails.mint });
    const isSolana = bankDetails.chain === paj.RAILS.solana.chain;
    return {
      success: true,
      reference: "ord_test_1",
      address: isSolana ? "PajSolanaOrderAddr1111111111111111111111" : "0x2222222222222222222222222222222222222222",
      amount: Number(walletLib.formatMicro(amountMicroArg)),
      fiatAmount: 50000,
      accountName: "Test Account",
      rate: 1500,
      status: "pending",
    };
  };
  db.getUser = () => ({
    telegram_id: testUserId,
    solana_deposit_address: null,
  });
  autoEarn.ensureLiquidBalance = async () => ({ liquidated: false });

  // Fresh ledger state for the idempotency keys used below
  const idemKeys = [
    `offramp:${testUserId}:0111111111:20`,
    `offramp:${testUserId}:0111111111:15`,
    `offramp:${testUserId}:0111111111:10`,
    `offramp:${testUserId}:0111111111:8`,
    `offramp:${testUserId}:0111111111:5`,
  ];
  db.db.prepare("DELETE FROM universal_idempotency WHERE key IN (" + idemKeys.map(() => "?").join(",") + ")").run(...idemKeys);
  db.db.prepare("DELETE FROM transactions WHERE telegram_id = ?").run(testUserId);

  try {
    await t.test("explicit Solana rail sends SPL USDC to the Solana order address", async () => {
      arcUsdc = 100; solUsdc = 50;
      const res = await executeOfframp(userWallet, 20, {
        accountNumber: "0111111111",
        bankCode: "000013",
        bankName: "GTBank",
      }, testUserId, "Cash Out", { rail: "solana" });

      assert.equal(res.success, true, JSON.stringify(res));
      assert.equal(res.rail, "solana");
      assert.equal(res.txHash, "sol_tx_signature");
      assert.equal(calls.solanaTransfers, 1);
      assert.equal(calls.arcSends, 0);
      assert.deepEqual(calls.orderChains.at(-1), { chain: paj.RAILS.solana.chain, mint: paj.RAILS.solana.mint });
    });

    await t.test("explicit Arc rail sends native USDC to the EVM order address", async () => {
      const res = await executeOfframp(userWallet, 15, {
        accountNumber: "0111111111",
        bankCode: "000013",
        bankName: "GTBank",
      }, testUserId, "Cash Out", { rail: "arc" });

      assert.equal(res.success, true, JSON.stringify(res));
      assert.equal(res.rail, "arc");
      assert.equal(res.txHash, "0xarc_tx_hash");
      assert.deepEqual(calls.orderChains.at(-1), { chain: paj.RAILS.arc.chain, mint: paj.RAILS.arc.mint });
    });

    await t.test("auto rail prefers Arc when it funds the amount", async () => {
      arcUsdc = 100; solUsdc = 50;
      const res = await executeOfframp(userWallet, 10, {
        accountNumber: "0111111111",
        bankCode: "000013",
        bankName: "GTBank",
      }, testUserId, "Cash Out", {});

      assert.equal(res.success, true, JSON.stringify(res));
      assert.equal(res.rail, "arc");
    });

    await t.test("auto rail falls back to Solana when Arc is short", async () => {
      arcUsdc = 3; solUsdc = 50;
      const res = await executeOfframp(userWallet, 8, {
        accountNumber: "0111111111",
        bankCode: "000013",
        bankName: "GTBank",
      }, testUserId, "Cash Out", {});

      assert.equal(res.success, true, JSON.stringify(res));
      assert.equal(res.rail, "solana");
    });

    await t.test("explicit Arc rail is rejected while the Arc rail is disabled", async () => {
      const prev = process.env.PAJ_ARC_OFFRAMP_ENABLED;
      process.env.PAJ_ARC_OFFRAMP_ENABLED = "false";
      try {
        const res = await executeOfframp(userWallet, 5, {
          accountNumber: "0111111111",
          bankCode: "000013",
          bankName: "GTBank",
        }, testUserId, "Cash Out", { rail: "arc" });

        assert.equal(res.success, false);
        assert.match(res.error, /not enabled/i);
      } finally {
        process.env.PAJ_ARC_OFFRAMP_ENABLED = prev;
      }
    });

    await t.test("offramp transaction is recorded with the rail's chain column", () => {
      const rows = db.db.prepare(
        "SELECT chain FROM transactions WHERE telegram_id = ? AND type = 'offramp' ORDER BY id DESC LIMIT 4"
      ).all(testUserId);
      const chains = rows.map((r) => r.chain).sort();
      assert.deepEqual(chains, ["arc", "arc", "solana", "solana"]);
    });
  } finally {
    // ── Restore originals ───────────────────────────────────────────────────
    walletLib.getNativeBalanceMicro = orig.getNativeBalanceMicro;
    walletLib.sendFromWallet = orig.sendFromWallet;
    multichain.getSplTokenBalance = orig.getSplTokenBalance;
    multichain.getOrDeriveSolanaAddress = orig.getOrDeriveSolanaAddress;
    multichain.deriveSolanaFromEvmKey = orig.deriveSolanaFromEvmKey;
    multichain.sendSolanaTransfer = orig.sendSolanaTransfer;
    offramp.requestOfframp = orig.requestOfframp;
    db.getUser = orig.getUser;
    autoEarn.ensureLiquidBalance = orig.ensureLiquidBalance;
    db.db.prepare("DELETE FROM transactions WHERE telegram_id = ?").run(testUserId);
    db.db.prepare("DELETE FROM universal_idempotency WHERE key IN (" + idemKeys.map(() => "?").join(",") + ")").run(...idemKeys);
  }
});
