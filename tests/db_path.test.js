const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDbPath } = require('../src/db');

test('prefers an explicit database path override', () => {
  const previous = process.env.PAYIT_DB_PATH;
  process.env.PAYIT_DB_PATH = '/tmp/payit.db';
  try {
    assert.equal(resolveDbPath(), '/tmp/payit.db');
  } finally {
    if (previous === undefined) {
      delete process.env.PAYIT_DB_PATH;
    } else {
      process.env.PAYIT_DB_PATH = previous;
    }
  }
});
