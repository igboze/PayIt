// tests/vault_visibility_and_withdrawal.test.js
// Tests for vault savings balance visibility, profit accrual display, and immediate withdrawal

const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/db");
const savings = require("../src/savings");
const { classifyIntent } = require("../agent/intent_router");

test("Vault Visibility: formatPosition clearly details principal, profit, and total vault value", () => {
  const mockPos = {
    amount_usdc: 250,
    apy: 8.0,
    opened_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    project: "Steakhouse Prime USDC",
    chain: "Arc Mainnet",
    symbol: "USDC",
    vault_address: "0xa8fd51b78370c7ca948566d7ba97d252bc325124",
  };

  const formatted = savings.formatPosition(mockPos);
  assert.ok(formatted.includes("Principal Saved:</b> $250.00 USDC"));
  assert.ok(formatted.includes("Profit Earned (Interest):"));
  assert.ok(formatted.includes("Current Vault Total:"));
  assert.ok(formatted.includes("Steakhouse Prime USDC"));
});

test("Vault Intent Router: correctly routes vault and profit queries", async () => {
  const q1 = await classifyIntent("my vault");
  assert.equal(q1.intent, "savings_view");

  const q2 = await classifyIntent("vault balance");
  assert.equal(q2.intent, "savings_view");

  const q3 = await classifyIntent("how much profit in my vault");
  assert.equal(q3.intent, "savings_view");

  const q4 = await classifyIntent("my savings");
  assert.equal(q4.intent, "savings_view");

  const q5 = await classifyIntent("withdraw from vault");
  assert.equal(q5.intent, "savings_withdraw");

  const q6 = await classifyIntent("withdraw vault");
  assert.equal(q6.intent, "savings_withdraw");
});

test("Vault Pool Address: getYieldPools returns valid vaultAddress used by deposit flow", async () => {
  const pools = await savings.getYieldPools();
  const pool = pools[0];
  assert.ok(pool.vaultAddress, "Pool must have vaultAddress");

  // Verify the address resolution fallback works with vaultAddress
  const resolvedAddress = pool.vaultAddress || pool.address || pool.id;
  assert.ok(resolvedAddress.startsWith("0x"));
});

test("Vault DB: open, read, and close yield position tracks principal and payout", () => {
  const tgId = 1122334455;
  db.prepare("DELETE FROM yield_positions WHERE telegram_id = ?").run(tgId);

  const pool = {
    project: "Steakhouse Prime USDC",
    symbol: "USDC",
    chain: "Arc",
    userApy: 10.0,
    vaultAddress: "0xa8fd51b78370c7ca948566d7ba97d252bc325124",
  };

  // Open personal position
  savings.openYieldPosition(tgId, 150.0, pool, {
    vaultAddress: pool.vaultAddress,
    accountType: "personal",
  });

  const openPos = db.getOpenYieldPosition(tgId, "personal");
  assert.ok(openPos, "Position should be found");
  assert.equal(openPos.amount_usdc, 150.0);
  assert.equal(openPos.status, "active");

  // Calculate yield
  const grossYield = savings.calcAccruedYield(openPos);
  assert.ok(typeof grossYield === "number");

  // Close position
  db.closeYieldPosition(tgId, 150.0 + 1.25, {
    devFee: 0.125,
    accountType: "personal",
    positionId: openPos.id,
  });

  const closedPos = db.getOpenYieldPosition(tgId, "personal");
  assert.equal(closedPos, null, "Closed position should no longer be active");
});
