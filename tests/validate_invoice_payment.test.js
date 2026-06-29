const test = require('node:test');
const assert = require('node:assert/strict');
const wallet = require('../src/wallet');

test('validateInvoicePayment uses the transaction value from the transaction object', async () => {
  const provider = {
    getTransactionReceipt: async () => ({ to: '0xabc' }),
    getTransaction: async () => ({ to: '0xabc', value: 10_000_000_000_000_000_000n }),
  };

  const result = await wallet.validateInvoicePayment(
    1,
    10_000_000_000_000_000_000n,
    '0x123',
    '0xabc',
    provider
  );

  assert.equal(result, true);
});
