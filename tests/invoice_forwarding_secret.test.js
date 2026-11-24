const test = require('node:test');
const assert = require('node:assert/strict');
const wallet = require('../src/wallet');

function withEnv(vars, fn) {
  const previous = {};
  for (const k of Object.keys(vars)) previous[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('encrypt/decrypt refuses to run when INVOICE_FORWARDING_SECRET is unset (no hardcoded fallback)', () => {
  withEnv({ INVOICE_FORWARDING_SECRET: undefined }, () => {
    assert.throws(() => wallet.encryptSensitiveValue('test-secret', undefined), /INVOICE_FORWARDING_SECRET is required/);
    assert.throws(() => wallet.getSystemSecret(), /INVOICE_FORWARDING_SECRET is required/);
  });
});

test('encrypt/decrypt round-trips with the configured secret', () => {
  withEnv({ INVOICE_FORWARDING_SECRET: 'unit-test-secret-not-real' }, () => {
    const encrypted = wallet.encryptSensitiveValue('test-secret', undefined);
    assert.equal(wallet.decryptSensitiveValue(encrypted, undefined), 'test-secret');
  });
});

test('an explicitly passed secret is used even when the env var is unset', () => {
  withEnv({ INVOICE_FORWARDING_SECRET: undefined }, () => {
    const enc = wallet.encryptSensitiveValue('test-secret', 'explicit-secret');
    assert.equal(wallet.decryptSensitiveValue(enc, 'explicit-secret'), 'test-secret');
  });
});
