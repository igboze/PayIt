// tests/savings_earn.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const savings = require("../src/savings");

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

