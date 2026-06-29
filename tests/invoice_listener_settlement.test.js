const test = require('node:test');
const assert = require('node:assert/strict');
const invoiceListener = require('../agent/invoice_listener');
const { getSettlementDestination } = invoiceListener;

test('prefers the main business wallet address for settlement', () => {
  const invoice = {
    wallet_address: '0xmainwallet',
    payment_address: '0xvirtualinvoice',
  };

  assert.equal(getSettlementDestination(invoice), '0xmainwallet');
});

test('falls back to the virtual payment address when no main wallet address exists', () => {
  const invoice = {
    payment_address: '0xvirtualinvoice',
  };

  assert.equal(getSettlementDestination(invoice), '0xvirtualinvoice');
});

test('exposes settleInvoiceFunds for the manual settlement button', () => {
  assert.equal(typeof invoiceListener.settleInvoiceFunds, 'function');
});
