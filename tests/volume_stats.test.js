const test = require('node:test');
const assert = require('node:assert/strict');
const { getVolumeStats, reconcileLiveProductVolume } = require('../src/db');

test('getVolumeStats returns complete metrics structure without SQL errors', () => {
  const stats = getVolumeStats();
  assert.ok(stats, 'Expected stats object');
  assert.ok(stats.onramp, 'Expected onramp metrics');
  assert.ok(stats.crypto, 'Expected crypto metrics');
  assert.ok(stats.offramp, 'Expected offramp metrics');
  assert.ok(stats.sends, 'Expected sends metrics');
  assert.ok(stats.savings, 'Expected savings metrics');
  assert.ok(stats.invoices, 'Expected invoices metrics');
  assert.ok(stats.swaps, 'Expected swaps metrics');
  assert.ok(stats.totalAll, 'Expected totalAll metrics');
  assert.ok(stats.users, 'Expected users metrics');
  assert.ok(Array.isArray(stats.topUsers), 'Expected topUsers array');

  // Verify users growth stats are all non-null numbers
  assert.equal(typeof stats.users.total, 'number', 'users.total must be a number');
  assert.equal(typeof stats.users.today, 'number', 'users.today must be a number');
  assert.equal(typeof stats.users.week, 'number', 'users.week must be a number');
  assert.equal(typeof stats.users.month, 'number', 'users.month must be a number');
  assert.ok(!isNaN(stats.users.today), 'users.today must not be NaN');
  assert.ok(!isNaN(stats.users.week), 'users.week must not be NaN');
  assert.ok(!isNaN(stats.users.month), 'users.month must not be NaN');

  // Verify structure of topUsers entries if any exist
  for (const user of stats.topUsers) {
    assert.ok(user.telegram_id, 'User should have telegram_id');
    assert.ok(typeof user.username === 'string', 'User should have string username');
    assert.ok(typeof user.usdc === 'number', 'User should have numeric usdc volume');
    assert.ok(typeof user.tx_count === 'number', 'User should have numeric tx_count');
  }
});

test('reconcileLiveProductVolume executes safely and returns scan summary', () => {
  const result = reconcileLiveProductVolume();
  assert.ok(result, 'Expected reconciliation result object');
  assert.equal(typeof result.fixedScale, 'number');
  assert.equal(typeof result.backfilledInvoices, 'number');
  assert.equal(typeof result.backfilledPayments, 'number');
  assert.equal(typeof result.backfilledYield, 'number');
});

