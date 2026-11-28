// tests/savings_earn.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDb = path.join(os.tmpdir(), `savings_earn_${process.pid}_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = tmpDb;

const savings = require("../src/savings");

test.after(() => {
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try { fs.unlinkSync(f); } catch (_) { }
  }
});

test("Savings: getYieldPools returns valid Arc vaults", async () => {
  const pools = await savings.getYieldPools();
  assert.ok(Array.isArray(pools));
  assert.ok(pools.length > 0);

  const first = pools[0];
  assert.ok(first.symbol === "USDC" || first.symbol === "EURC");
  assert.ok(first.project);
  assert.ok(typeof first.userApy === "number");
  assert.ok(first.vaultAddress.startsWith("0x"));
});

test("Savings: formatYieldList produces formatted telegram output", async () => {
  const pools = await savings.getYieldPools();
  const text = savings.formatYieldList(pools);
  assert.ok(text.includes("Arc Earn Vaults"));
  assert.ok(text.includes(pools[0].project));
});

test("Savings: calcAccruedYield and formatPosition calculate interest", () => {
  const position = {
    amount_usdc: 100,
    apy: 10,
    opened_at: new Date(Date.now() - 3600 * 1000 * 24).toISOString(), // 1 day ago
    project: "Steakhouse Prime USDC",
    chain: "Arc Mainnet",
    symbol: "USDC",
  };

  const accrued = savings.calcAccruedYield(position);
  assert.ok(accrued > 0);

  const formatted = savings.formatPosition(position);
  assert.ok(formatted.includes("$100.00"));
  assert.ok(formatted.includes("Principal"));
  assert.ok(formatted.includes("Steakhouse Prime USDC"));
});

test("Savings: calcAccruedYield and formatPosition handle string amount and missing opened_at safely", () => {
  const edgePosition = {
    amount_usdc: "50",
    apy: 5,
    opened_at: null,
    project: "Arc Morpho Vault",
  };

  const accrued = savings.calcAccruedYield(edgePosition);
  assert.equal(typeof accrued, "number");
  assert.ok(!Number.isNaN(accrued));
  assert.ok(accrued >= 0);

  const formatted = savings.formatPosition(edgePosition);
  assert.ok(formatted.includes("$50.00"));
  assert.ok(!formatted.includes("NaN"));
});

test("Savings: db getOpenYieldPosition handles case-insensitive and legacy null account_type", () => {
  const db = require("../src/db");
  const testTgId = 888777666;
  
  db.openYieldPosition(testTgId, 25, {
    userApy: 4.5,
    project: "Test Vault",
    vaultAddress: "0x1234567890123456789012345678901234567890",
  }, {
    accountType: "Personal",
  });

  // Query with lowercase 'personal'
  const posLower = db.getOpenYieldPosition(testTgId, "personal");
  assert.ok(posLower, "Should match 'personal' query when stored as 'Personal'");
  assert.equal(Number(posLower.amount_usdc), 25);

  // Query without accountType
  const posAny = db.getOpenYieldPosition(testTgId);
  assert.ok(posAny, "Should match when no accountType passed");

  // Query latest position
  const latest = db.getLatestYieldPosition(testTgId);
  assert.ok(latest, "getLatestYieldPosition should return record");

  // Clean up
  db.closeYieldPosition(testTgId, 25, {
    positionId: posLower.id,
    accountType: "personal",
    withdrawTxHash: "0xtest_hash",
  });
});

test("Savings: calcYieldBreakdown trusts real on-chain profit even when lower than time estimate", () => {
  const position = {
    amount_usdc: 1000,
    apy: 20, // timer estimate for 1 year = $200
    opened_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
  };

  // Real on-chain profit was only $5 (e.g. variable APY dropped) — must NOT inflate to $200
  const lowReal = savings.calcYieldBreakdown(position, 5);
  assert.equal(lowReal.grossYield, 5);
  assert.equal(lowReal.devFee, 0.5);
  assert.equal(lowReal.netYield, 4.5);

  // Real on-chain profit was $0 — must NOT charge any fee
  const zeroReal = savings.calcYieldBreakdown(position, 0);
  assert.equal(zeroReal.grossYield, 0);
  assert.equal(zeroReal.devFee, 0);
  assert.equal(zeroReal.netYield, 0);
});

test("Savings: parseRedeemedAssetsFromReceipt extracts exact USDC from Withdraw and Transfer logs", () => {
  const { Interface, parseUnits } = require("ethers");
  const vaultAddr = "0xbeeff419ecc98763045e0a26490b62adfb9103c1";
  const ownerAddr = "0x1111111111111111111111111111111111111111";
  const usdcAddr = "0x3600000000000000000000000000000000000000";

  // 1. ERC-4626 Withdraw event log
  const vaultIface = new Interface([
    "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  ]);
  const wLog = vaultIface.encodeEventLog(vaultIface.getEvent("Withdraw"), [
    ownerAddr,
    ownerAddr,
    ownerAddr,
    parseUnits("105.4321", 6),
    parseUnits("100", 18),
  ]);
  const fromWithdraw = savings.parseRedeemedAssetsFromReceipt(
    { logs: [{ address: vaultAddr, topics: wLog.topics, data: wLog.data }] },
    vaultAddr,
    ownerAddr,
    usdcAddr,
    6
  );
  assert.equal(fromWithdraw, 105.4321);

  // 2. ERC-20 Transfer(vault -> user) fallback log
  const erc20Iface = new Interface([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]);
  const tLog = erc20Iface.encodeEventLog(erc20Iface.getEvent("Transfer"), [
    vaultAddr,
    ownerAddr,
    parseUnits("50.123456", 6),
  ]);
  const fromTransfer = savings.parseRedeemedAssetsFromReceipt(
    { logs: [{ address: usdcAddr, topics: tLog.topics, data: tLog.data }] },
    vaultAddr,
    ownerAddr,
    usdcAddr,
    6
  );
  assert.equal(fromTransfer, 50.123456);
});

test("Savings: repeat deposits into same vault accumulate principal cleanly without orphan rows", () => {
  const db = require("../src/db");
  const testTgId = 888777999;
  const vaultAddr = "0xbeeff419ecc98763045e0a26490b62adfb9103c1";
  db.prepare("DELETE FROM yield_positions WHERE telegram_id = ?").run(testTgId);

  db.openYieldPosition(testTgId, 20, { project: "Steakhouse High Yield USDC", userApy: 18, rawApy: 20, vaultAddress: vaultAddr }, { accountType: "personal" });
  db.openYieldPosition(testTgId, 30, { project: "Steakhouse High Yield USDC", userApy: 18, rawApy: 20, vaultAddress: vaultAddr }, { accountType: "personal" });

  const activeRows = db.prepare("SELECT * FROM yield_positions WHERE telegram_id = ? AND status = 'active'").all(testTgId);
  assert.equal(activeRows.length, 1, "Repeat deposit into same vault should merge into single active position");
  assert.equal(Number(activeRows[0].amount_usdc), 50, "Principal should equal sum of both deposits ($20 + $30)");

  db.closeYieldPosition(testTgId, 50.5, { positionId: activeRows[0].id, accountType: "personal", vaultAddress: vaultAddr });
  assert.equal(db.getOpenYieldPosition(testTgId, "personal"), null);
});

test("Savings: production mode throws on failed on-chain withdrawal and keeps DB position active", async () => {
  const { Wallet } = require("ethers");
  const db = require("../src/db");
  const testTgId = 888778001;
  const vaultAddr = "0xbeeff419ecc98763045e0a26490b62adfb9103c1";
  db.prepare("DELETE FROM yield_positions WHERE telegram_id = ?").run(testTgId);

  db.openYieldPosition(testTgId, 25, { project: "Steakhouse High Yield USDC", userApy: 18, rawApy: 20, vaultAddress: vaultAddr }, { accountType: "personal" });
  const openPos = db.getOpenYieldPosition(testTgId, "personal");
  assert.ok(openPos);

  const randomWallet = Wallet.createRandom();
  randomWallet.telegramId = testTgId;

  await assert.rejects(
    () => savings.withdrawFromVaultWithFee({
      userWallet: randomWallet,
      position: openPos,
      allowSimulatedFallback: false,
    }),
    /no active vault shares|withdrawal failed/i
  );

  // Position MUST still be active in DB so funds are never orphaned
  const stillOpen = db.getOpenYieldPosition(testTgId, "personal");
  assert.ok(stillOpen, "Failed production withdrawal must NOT close DB position");
  assert.equal(stillOpen.id, openPos.id);

  // Clean up
  db.prepare("DELETE FROM yield_positions WHERE telegram_id = ?").run(testTgId);
});

test("Savings: formatPosition shows net interest cleanly without 10% performance fee line", () => {
  const pos = {
    amount_usdc: 100,
    apy: 20,
    user_apy: 18,
    opened_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
    project: "Steakhouse High Yield USDC",
    chain: "Arc Mainnet",
  };
  const formatted = savings.formatPosition(pos, { netYield: 1.5, grossYield: 1.666667, devFee: 0.166667, onChain: true });
  assert.ok(formatted.includes("+$1.5000 USDC"));
  assert.ok(formatted.includes("$101.5000 USDC"));
  assert.ok(!/10% performance fee/i.test(formatted));
  assert.ok(/net of service fees/i.test(formatted));
});

