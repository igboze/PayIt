const test = require("node:test");
const assert = require("node:assert/strict");

const invoiceListener = require("../agent/invoice_listener");
const invoiceDb = require("../src/invoice_db");
const bizDb = require("../src/biz_db");

test("startInvoiceListener uses a single async poll loop instead of overlapping intervals", async () => {
  invoiceListener.stopInvoiceListener();

  let intervalCalls = 0;
  let timeoutCalls = 0;

  const originalSetInterval = global.setInterval;
  const originalSetTimeout = global.setTimeout;
  global.setInterval = () => {
    intervalCalls += 1;
    return 1;
  };
  global.setTimeout = (fn) => {
    timeoutCalls += 1;
    return 1;
  };

  const originalPersonal = invoiceDb.getUnpaidPersonalInvoices;
  const originalBiz = bizDb.getUnpaidBizInvoices;
  invoiceDb.getUnpaidPersonalInvoices = () => [];
  bizDb.getUnpaidBizInvoices = () => [];

  try {
    await invoiceListener.startInvoiceListener({ telegram: { sendMessage: async () => {} } }, {
      getBlockNumber: async () => 0,
      getBlockWithTransactions: async () => null,
      getBalance: async () => 0n,
    }, 10);

    assert.equal(intervalCalls, 0, "should not use setInterval for polling");
    assert.equal(timeoutCalls, 1, "should schedule the first poll with setTimeout");
  } finally {
    global.setInterval = originalSetInterval;
    global.setTimeout = originalSetTimeout;
    invoiceDb.getUnpaidPersonalInvoices = originalPersonal;
    bizDb.getUnpaidBizInvoices = originalBiz;
    invoiceListener.stopInvoiceListener();
  }
});
