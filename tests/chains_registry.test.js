// tests/chains_registry.test.js
// Phase 4: src/chains.js — registry shape, address derivation, unified balance.
// Mocks all RPC-touching modules; no live network.

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/db");
const walletLib = require("../src/wallet");
const multichain = require("../src/multichain");
const tokens = require("../src/tokens");
const chains = require("../src/chains");

const TG_ID = 777888111;

function cleanupNearRows() {
  db.db.prepare("DELETE FROM near_deposits WHERE telegram_id = ?").run(TG_ID);
}

test("chains registry: shape, rails, and address derivation", async (t) => {
  await t.test("registry contains the four product chains with correct families", () => {
    const all = chains.listChains();
    const keys = all.map((c) => c.key).sort();
    assert.deepEqual(keys, ["arc", "base", "near", "solana"]);
    assert.equal(chains.getChain("arc").family, "evm");
    assert.equal(chains.getChain("solana").family, "solana");
    assert.equal(chains.getChain("base").family, "evm");
    assert.equal(chains.getChain("near").family, "near");
    assert.equal(chains.getChain("does_not_exist"), null);
  });

  await t.test("paj rails map to exactly the two cash-out chains", () => {
    const rails = chains.getPajRailChains();
    assert.deepEqual(rails.map((c) => c.key).sort(), ["arc", "solana"]);
    assert.ok(chains.getChain("arc").pajRail.chain);
    assert.ok(chains.getChain("solana").pajRail.chain);
    assert.equal(chains.getChain("base").pajRail, null);
  });

  await t.test("base carries its CCTP domain for the sweeper", () => {
    const base = chains.getChain("base");
    assert.equal(base.cctp.domain, 6);
    assert.ok(base.usdc.address.startsWith("0x"));
  });

  await t.test("arc deriveAddress respects account type", () => {
    const user = {
      telegram_id: TG_ID,
      deposit_address: "0xaaaa000000000000000000000000000000000001",
      business_deposit_address: "0xbbbb000000000000000000000000000000000002",
    };
    assert.equal(chains.deriveAddress(user, "personal", "arc"), user.deposit_address);
    assert.equal(chains.deriveAddress(user, "business", "arc"), user.business_deposit_address);
    // Business falls back to personal when no business wallet exists
    assert.equal(chains.deriveAddress({ ...user, business_deposit_address: null }, "business", "arc"), user.deposit_address);
  });

  await t.test("solana deriveAddress falls back to the stored column when derivation is unavailable", () => {
    const user = {
      telegram_id: TG_ID,
      deposit_address: "0xaaaa000000000000000000000000000000000001",
      solana_deposit_address: "StoredSol11111111111111111111111111111111",
      biz_solana_deposit_address: "BizSol1111111111111111111111111111111111",
    };
    // No encrypted key columns on this fake user → derivation returns null → stored fallback
    assert.equal(chains.deriveAddress(user, "personal", "solana"), user.solana_deposit_address);
    assert.equal(chains.deriveAddress(user, "business", "solana"), user.biz_solana_deposit_address);
  });
});

test("getUnifiedBalance: single read path across Arc + Solana + pending NEAR", async (t) => {
  const orig = {
    getNativeBalanceMicro: walletLib.getNativeBalanceMicro,
    getSplTokenBalance: multichain.getSplTokenBalance,
    getEurcBalance: tokens.getEurcBalance,
  };

  let arcMicro = walletLib.parseToMicro("40");
  let solByAddr = {};
  walletLib.getNativeBalanceMicro = async () => arcMicro;
  multichain.getSplTokenBalance = async (addr) => ({ uiAmount: solByAddr[addr] || 0 });
  tokens.getEurcBalance = async () => walletLib.parseToMicro("7");

  const user = {
    telegram_id: TG_ID,
    deposit_address: "0xaaaa000000000000000000000000000000000001",
    solana_deposit_address: "SolA111111111111111111111111111111111111",
  };

  cleanupNearRows();
  db.db.prepare(`
    INSERT INTO near_deposits (telegram_id, account_type, origin_asset, amount_usdc, recipient_address, refund_to, status)
    VALUES (?, 'personal', 'nep141:test', 15, '0xrecip', 'nearrefund', 'awaiting_deposit')
  `).run(TG_ID);
  db.db.prepare(`
    INSERT INTO near_deposits (telegram_id, account_type, origin_asset, amount_usdc, recipient_address, refund_to, status)
    VALUES (?, 'personal', 'nep141:test', 999, '0xrecip', 'nearrefund', 'SUCCESS')
  `).run(TG_ID); // terminal — must NOT count toward pendingNear

  try {
    await t.test("sums Arc native + SPL across addresses + pending NEAR, skipping terminal rows", async () => {
      solByAddr = { SolA111111111111111111111111111111111111: 25 };
      const bal = await chains.getUnifiedBalance(user, "personal");
      assert.equal(bal.arc.usdc, 40);
      assert.equal(bal.solana.usdc, 25);
      assert.equal(bal.arc.eurc, 7);
      assert.equal(bal.pendingNear, 15, "only non-terminal NEAR deposits count");
      assert.equal(bal.total, 65);
      assert.deepEqual(bal.byChain, { arc: 40, solana: 25 });
      assert.equal(bal.arcAddress, user.deposit_address);
      assert.ok(bal.solanaAddresses.includes(user.solana_deposit_address));
    });

    await t.test("legacy stored address is also scanned for SPL balance", async () => {
      const legacyUser = { ...user, solana_deposit_address_legacy: undefined };
      // simulate a second distinct address via monkey-patched derive is not possible;
      // instead verify the stored column is included in the scan list
      solByAddr = { [user.solana_deposit_address]: 10 };
      const bal = await chains.getUnifiedBalance(legacyUser, "personal");
      assert.equal(bal.solana.usdc, 10);
    });

    await t.test("RPC failure on one chain does not break the others", async () => {
      walletLib.getNativeBalanceMicro = async () => { throw new Error("rpc down"); };
      solByAddr = { [user.solana_deposit_address]: 5 };
      const bal = await chains.getUnifiedBalance(user, "personal");
      assert.equal(bal.arc.usdc, 0);
      assert.equal(bal.solana.usdc, 5);
      assert.equal(bal.total, 5);
      walletLib.getNativeBalanceMicro = orig.getNativeBalanceMicro;
    });
  } finally {
    walletLib.getNativeBalanceMicro = orig.getNativeBalanceMicro;
    multichain.getSplTokenBalance = orig.getSplTokenBalance;
    tokens.getEurcBalance = orig.getEurcBalance;
    cleanupNearRows();
  }
});
