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
