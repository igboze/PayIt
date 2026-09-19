const test = require('node:test');
const assert = require('node:assert/strict');
const { getVolumeStats } = require('../src/db');

test('getVolumeStats returns complete metrics structure without SQL errors', () => {
  const stats = getVolumeStats();
  assert.ok(stats, 'Expected stats object');
  assert.ok(stats.onramp, 'Expected onramp metrics');
  assert.ok(stats.crypto, 'Expected crypto metrics');
  assert.ok(stats.offramp, 'Expected offramp metrics');
  assert.ok(stats.sends, 'Expected sends metrics');
  assert.ok(stats.savings, 'Expected savings metrics');
  assert.ok(stats.totalAll, 'Expected totalAll metrics');
  assert.ok(stats.users, 'Expected users metrics');
  assert.ok(Array.isArray(stats.topUsers), 'Expected topUsers array');

  // Verify structure of topUsers entries if any exist
  for (const user of stats.topUsers) {
    assert.ok(user.telegram_id, 'User should have telegram_id');
    assert.ok(typeof user.username === 'string', 'User should have string username');
    assert.ok(typeof user.usdc === 'number', 'User should have numeric usdc volume');
    assert.ok(typeof user.tx_count === 'number', 'User should have numeric tx_count');
  }
});
