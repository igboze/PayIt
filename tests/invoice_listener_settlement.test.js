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

test('bizDb exports updateBizInvoiceSettlementTxHash for settlement bookkeeping', () => {
  const bizDb = require('../src/biz_db');
  assert.equal(typeof bizDb.updateBizInvoiceSettlementTxHash, 'function');
});

test('settleInvoiceFunds uses provider balance lookup instead of signer.getBalance', async () => {
  const walletLib = require('../src/wallet');
  const invoiceDb = require('../src/invoice_db');

  const originalDecrypt = walletLib.decryptSensitiveValue;
  const originalWalletFromPrivateKey = walletLib.walletFromPrivateKey;
  const originalGetInvoice = invoiceDb.getInvoice;
  const originalUpdateInvoiceSettlementTxHash = invoiceDb.updateInvoiceSettlementTxHash;

  let balanceLookupAddress = null;
  let updatedInvoiceId = null;

  walletLib.decryptSensitiveValue = () => '0xprivate-key';
  walletLib.walletFromPrivateKey = () => ({
    address: '0xabc123',
    provider: {
      getBalance: async (address) => {
        balanceLookupAddress = address;
        return 2_000_000_000_000_000_000n;
      },
      getFeeData: async () => ({ gasPrice: 1n }),
    },
    estimateGas: async () => 21000n,
    sendTransaction: async () => ({
      wait: async () => ({ hash: '0xsettled' }),
    }),
  });
  invoiceDb.getInvoice = () => ({
    id: 77,
    invoice_private_key_encrypted: 'encrypted',
    wallet_address: '0xrecipient',
  });
  invoiceDb.updateInvoiceSettlementTxHash = (id) => {
    updatedInvoiceId = id;
  };

  try {
    const result = await invoiceListener.settleInvoiceFunds(77, 'personal');
    assert.equal(result, '0xsettled');
    assert.equal(balanceLookupAddress, '0xabc123');
    assert.equal(updatedInvoiceId, 77);
  } finally {
    walletLib.decryptSensitiveValue = originalDecrypt;
    walletLib.walletFromPrivateKey = originalWalletFromPrivateKey;
    invoiceDb.getInvoice = originalGetInvoice;
    invoiceDb.updateInvoiceSettlementTxHash = originalUpdateInvoiceSettlementTxHash;
  }
});
