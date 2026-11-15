const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('../src/fx');

test('parseMoneyInput reads Naira the way users type it', () => {
  for (const input of ['₦20,000', 'N20,000', 'n20000', '20k naira', 'NGN 20000', '20,000 naira', '20000']) {
    assert.deepEqual(fx.parseMoneyInput(input), { currency: 'NGN', amount: 20000 }, input);
  }
});

test('parseMoneyInput reads dollar amounts', () => {
  for (const input of ['$50', '50 usd', '50 USDC', '50 dollars']) {
    assert.deepEqual(fx.parseMoneyInput(input), { currency: 'USD', amount: 50 }, input);
  }
  assert.deepEqual(fx.parseMoneyInput('12.5', { defaultCurrency: 'USD' }), { currency: 'USD', amount: 12.5 });
});

test('parseMoneyInput handles euros, millions and junk', () => {
  assert.deepEqual(fx.parseMoneyInput('€20'), { currency: 'EUR', amount: 20 });
  assert.deepEqual(fx.parseMoneyInput('₦1.5m'), { currency: 'NGN', amount: 1500000 });
  assert.equal(fx.parseMoneyInput('hello'), null);
  assert.equal(fx.parseMoneyInput('0'), null);
});

test('roundUsdc never exceeds 6 decimals and rounds down', () => {
  assert.equal(fx.roundUsdc(20000 / 1620), 12.345679);
  assert.equal(String(fx.roundUsdc(0.1 + 0.2)), '0.3');
});

test('formatDual shows Naira first', () => {
  assert.equal(fx.formatDual(10, 1500), '₦15,000 (≈ $10.00)');
});
