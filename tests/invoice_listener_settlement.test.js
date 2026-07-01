const test = require('node:test');
const assert = require('node:assert/strict');
const ethers = require('ethers');
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

test('settleInvoiceFunds forwards a fee to the fee recipient when configured', async () => {
  const walletLib = require('../src/wallet');
  const invoiceDb = require('../src/invoice_db');
  const originalDecrypt = walletLib.decryptSensitiveValue;
  const originalWalletFromPrivateKey = walletLib.walletFromPrivateKey;
  const originalGetInvoice = invoiceDb.getInvoice;
  const originalUpdateInvoiceSettlementTxHash = invoiceDb.updateInvoiceSettlementTxHash;

  const feeRecipientAddress = '0x1111111111111111111111111111111111111111';
  process.env.APP_FEE_RECIPIENT_ADDRESS = feeRecipientAddress;
  process.env.INVOICE_SETTLEMENT_FEE_BPS = '100';
  process.env.INVOICE_SETTLEMENT_MIN_FEE_USDC = '0.25';
  process.env.INVOICE_SETTLEMENT_MAX_FEE_USDC = '2';

  let sentTransactions = [];
  let updatedInvoiceId = null;

  walletLib.decryptSensitiveValue = () => '0xprivate-key';
  walletLib.walletFromPrivateKey = () => ({
    address: '0xabc123',
    provider: {
      getBalance: async () => 10_000_000_000_000_000_000n,
      getFeeData: async () => ({ gasPrice: 1n }),
    },
    estimateGas: async ({ to }) => (to === feeRecipientAddress ? 21000n : 21000n),
    sendTransaction: async ({ to, value }) => {
      sentTransactions.push({ to, value });
      return { wait: async () => ({ hash: to === feeRecipientAddress ? '0xfee' : '0xsettled' }) };
    },
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
    assert.equal(updatedInvoiceId, 77);
    assert.equal(sentTransactions.length, 2);
    assert.equal(sentTransactions[0].to, feeRecipientAddress);
    assert(sentTransactions[0].value > 0n, 'fee transfer should send some amount');
    assert.equal(sentTransactions[1].to, '0xrecipient');
    assert(sentTransactions[1].value > 0n, 'destination transfer should send the remainder');
  } finally {
    walletLib.decryptSensitiveValue = originalDecrypt;
    walletLib.walletFromPrivateKey = originalWalletFromPrivateKey;
    invoiceDb.getInvoice = originalGetInvoice;
    invoiceDb.updateInvoiceSettlementTxHash = originalUpdateInvoiceSettlementTxHash;
    delete process.env.APP_FEE_RECIPIENT_ADDRESS;
    delete process.env.INVOICE_SETTLEMENT_FEE_BPS;
    delete process.env.INVOICE_SETTLEMENT_MIN_FEE_USDC;
    delete process.env.INVOICE_SETTLEMENT_MAX_FEE_USDC;
  }
});

test('settleInvoiceFunds throws when fee recipient address is invalid', async () => {
  const walletLib = require('../src/wallet');
  const invoiceDb = require('../src/invoice_db');
  const originalDecrypt = walletLib.decryptSensitiveValue;
  const originalWalletFromPrivateKey = walletLib.walletFromPrivateKey;
  const originalGetInvoice = invoiceDb.getInvoice;

  process.env.APP_FEE_RECIPIENT_ADDRESS = 'invalid-address';
  process.env.INVOICE_SETTLEMENT_FEE_BPS = '100';

  walletLib.decryptSensitiveValue = () => '0xprivate-key';
  walletLib.walletFromPrivateKey = () => ({
    address: '0xabc123',
    provider: {
      getBalance: async () => 10_000_000_000_000_000_000n,
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

  try {
    await assert.rejects(
      async () => {
        await invoiceListener.settleInvoiceFunds(77, 'personal');
      },
      {
        message: /Invalid fee recipient address configured/
      }
    );
  } finally {
    walletLib.decryptSensitiveValue = originalDecrypt;
    walletLib.walletFromPrivateKey = originalWalletFromPrivateKey;
    invoiceDb.getInvoice = originalGetInvoice;
    delete process.env.APP_FEE_RECIPIENT_ADDRESS;
    delete process.env.INVOICE_SETTLEMENT_FEE_BPS;
  }
});

test('settleInvoiceFunds uses the contract address env alias and submits the total amount to the settlement contract', async () => {
  const walletLib = require('../src/wallet');
  const invoiceDb = require('../src/invoice_db');
  const invoiceListenerModulePath = require.resolve('../agent/invoice_listener');
  const originalDecrypt = walletLib.decryptSensitiveValue;
  const originalWalletFromPrivateKey = walletLib.walletFromPrivateKey;
  const originalGetInvoice = invoiceDb.getInvoice;
  const originalUpdateInvoiceSettlementTxHash = invoiceDb.updateInvoiceSettlementTxHash;
  const originalContract = ethers.Contract;

  let capturedArgs = null;
  const fakeContract = class {
    constructor(address, abi, signer) {
      this.address = address;
      this.abi = abi;
      this.signer = signer;
      this.estimateGas = {
        settleInvoice: async (...args) => {
          capturedArgs = { mode: 'estimate', args };
          return 21000n;
        },
      };
      this.settleInvoice = async (...args) => {
        capturedArgs = { mode: 'send', args };
        return { wait: async () => ({ hash: '0xcontract-settled' }) };
      };
    }
  };

  Object.defineProperty(ethers, 'Contract', {
    value: fakeContract,
    configurable: true,
    writable: true,
  });

  process.env.INVOICE_SETTLEMENT_ADDRESS = '0x1111111111111111111111111111111111111111';
  delete process.env.INVOICE_SETTLEMENT_CONTRACT_ADDRESS;
  process.env.INVOICE_SETTLEMENT_FEE_BPS = '100';
  process.env.INVOICE_SETTLEMENT_MIN_FEE_USDC = '0';
  process.env.INVOICE_SETTLEMENT_MAX_FEE_USDC = '2';

  delete require.cache[invoiceListenerModulePath];

  walletLib.decryptSensitiveValue = () => '0xprivate-key';
  walletLib.walletFromPrivateKey = () => ({
    address: '0xabc123',
    provider: {
      getBalance: async () => 2_000_000_000_000_000_000n,
      getFeeData: async () => ({ gasPrice: 1n }),
    },
  });
  invoiceDb.getInvoice = () => ({
    id: 77,
    invoice_private_key_encrypted: 'encrypted',
    wallet_address: '0xrecipient',
  });
  invoiceDb.updateInvoiceSettlementTxHash = () => {};

  try {
    const freshInvoiceListener = require('../agent/invoice_listener');
    const result = await freshInvoiceListener.settleInvoiceFunds(77, 'personal');

    assert.equal(result, '0xcontract-settled');
    assert.equal(capturedArgs.mode, 'send');
    assert.equal(capturedArgs.args[0], 77);
    assert.equal(capturedArgs.args[1], '0xrecipient');
    assert.equal(capturedArgs.args[5], 2_000_000_000_000_000_000n);
  } finally {
    Object.defineProperty(ethers, 'Contract', {
      value: originalContract,
      configurable: true,
      writable: true,
    });
    delete require.cache[invoiceListenerModulePath];
    require('../agent/invoice_listener');
    walletLib.decryptSensitiveValue = originalDecrypt;
    walletLib.walletFromPrivateKey = originalWalletFromPrivateKey;
    invoiceDb.getInvoice = originalGetInvoice;
    invoiceDb.updateInvoiceSettlementTxHash = originalUpdateInvoiceSettlementTxHash;
    delete process.env.INVOICE_SETTLEMENT_ADDRESS;
    delete process.env.INVOICE_SETTLEMENT_CONTRACT_ADDRESS;
    delete process.env.INVOICE_SETTLEMENT_FEE_BPS;
    delete process.env.INVOICE_SETTLEMENT_MIN_FEE_USDC;
    delete process.env.INVOICE_SETTLEMENT_MAX_FEE_USDC;
  }
});
