const test = require('node:test');
const assert = require('node:assert/strict');
const wallet = require('../src/wallet');

test('encrypt/decrypt works even when INVOICE_FORWARDING_SECRET is unset', () => {
  const previous = process.env.INVOICE_FORWARDING_SECRET;
  delete process.env.INVOICE_FORWARDING_SECRET;

  try {
    const encrypted = wallet.encryptSensitiveValue('test-secret', undefined);
    assert.equal(wallet.decryptSensitiveValue(encrypted, undefined), 'test-secret');
  } finally {
    if (previous === undefined) {
      delete process.env.INVOICE_FORWARDING_SECRET;
    } else {
      process.env.INVOICE_FORWARDING_SECRET = previous;
    }
  }
});
