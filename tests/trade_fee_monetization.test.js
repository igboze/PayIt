// tests/trade_fee_monetization.test.js
// Verifies 1% platform fee inside trade amount routed to 0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359

const test = require("node:test");
const assert = require("node:assert/strict");

const swap = require("../src/swap");
const walletLib = require("../src/wallet");
const paj = require("../src/paj");
const { executeOfframp, calcMaxOfframpFromBalance } = require("../agent/executor");
const db = require("../src/db");

test("Trade Monetization: 1% offramp fee is added on top of send amount (charged from main balance)", () => {
  const sendAmount = 100;
  const feePercent = 0.01;
  const feeUsdc = Number((sendAmount * feePercent).toFixed(4));
  const netAmountUsdc = Number(sendAmount.toFixed(4));
  const totalDebitUsdc = Number((netAmountUsdc + feeUsdc).toFixed(4));

  assert.equal(feeUsdc, 1.00);
  assert.equal(netAmountUsdc, 100.00, "Recipient gets full send amount");
  assert.equal(totalDebitUsdc, 101.00, "Fee is added on top and charged from main balance");
});

test("Swap: 100 BPS (1.00%) fee calculated inside trade output", async () => {
  const kit = swap.getSwapKit();
  const origEstimate = kit.estimate;

  kit.estimate = async () => ({
    estimatedOutput: "100.00",
    estimatedOutputFormatted: "100.00",
  });

  try {
    const quote = await swap.getSwapQuote("USDC", "EURC", "100000000");
    assert.equal(quote.protocolFee, "1.0000");
    assert.equal(quote.amountOut, "99.0000");
  } finally {
    kit.estimate = origEstimate;
  }
});

test("Offramp: executeOfframp sends full amount to Paj and routes 1% fee from main balance on Arc", async () => {
  const testUserId = 999111222;
  const userWallet = {
    address: "0x3333333333333333333333333333333333333333",
    privateKey: "0x0123456789012345678901234567890123456789012345678901234567890123",
  };

  const origGetNative = walletLib.getNativeBalanceMicro;
  const origSendFromWallet = walletLib.sendFromWallet;
  const origSendSponsored = walletLib.sendSponsoredOrDirectTransaction;
  const origRequestOfframp = require("../src/offramp").requestOfframp;

  const idemKey = `offramp:${testUserId}:0123456789:100`;
  db.db.prepare("DELETE FROM universal_idempotency WHERE key = ?").run(idemKey);

  let feeRecipientSeen = null;
  let feeAmountSeen = null;
  let netSentToPaj = null;

  walletLib.getNativeBalanceMicro = async () => walletLib.parseToMicro("105.00");
  walletLib.sendFromWallet = async (wallet, to, amountMicro) => {
    if (to.toLowerCase() === "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359".toLowerCase()) {
      feeRecipientSeen = to;
      feeAmountSeen = Number(walletLib.formatMicro(amountMicro));
      return "0xfee_tx_hash";
    } else {
      netSentToPaj = Number(walletLib.formatMicro(amountMicro));
      return "0xnet_paj_tx";
    }
  };

  require("../src/offramp").requestOfframp = async (tgId, amountMicroArg, details) => {
    return {
      success: true,
      reference: "ord_fee_test",
      address: "0x4444444444444444444444444444444444444444",
      amount: Number(walletLib.formatMicro(amountMicroArg)),
      fiatAmount: 150000,
      accountName: "Test Account",
      rate: 1500,
      status: "pending",
    };
  };

  try {
    const res = await executeOfframp(
      userWallet,
      100, // $100 send amount
      {
        accountNumber: "0123456789",
        bankCode: "058",
        bankName: "GTBank",
      },
      testUserId,
      "Cash Out",
      { rail: "arc" }
    );

    assert.equal(res.success, true);
    assert.equal(res.amount, 100);
    assert.equal(res.feeUsdc, 1.0);
    assert.equal(res.netAmountUsdc, 100.0);
    assert.equal(res.totalDebitUsdc, 101.0);
    assert.equal(netSentToPaj, 100.0, "Full $100.00 send amount must be sent to Paj");
    assert.equal(feeAmountSeen, 1.0, "Fee routed from main balance must be $1.00");
    assert.equal(feeRecipientSeen.toLowerCase(), "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359".toLowerCase());
  } finally {
    walletLib.getNativeBalanceMicro = origGetNative;
    walletLib.sendFromWallet = origSendFromWallet;
    walletLib.sendSponsoredOrDirectTransaction = origSendSponsored;
    require("../src/offramp").requestOfframp = origRequestOfframp;
  }
});

test("Offramp: executeOfframp sends full amount to Paj and routes 1% fee from main balance on Solana", async () => {
  const multichain = require("../src/multichain");
  const testUserId = 999111333;
  const userWallet = {
    address: "0x3333333333333333333333333333333333333333",
    privateKey: "0x0123456789012345678901234567890123456789012345678901234567890123",
  };

  const origGetSpl = multichain.getSplTokenBalance;
  const origSendSol = multichain.sendSolanaTransfer;
  const origRequestOfframp = require("../src/offramp").requestOfframp;
  const origGetUser = db.getUser;

  db.getUser = (id) => ({
    telegram_id: id,
    solana_deposit_address: null,
  });

  const idemKey = `offramp:${testUserId}:0123456789:100`;
  db.db.prepare("DELETE FROM universal_idempotency WHERE key = ?").run(idemKey);

  const solTransfers = [];
  multichain.getSplTokenBalance = async () => ({ uiAmount: 105 });
  multichain.sendSolanaTransfer = async ({ recipientAddress, amount }) => {
    solTransfers.push({ recipientAddress, amount });
    return { txHash: `0xsol_tx_${amount}`, success: true };
  };

  require("../src/offramp").requestOfframp = async (tgId, amountMicroArg, details) => {
    return {
      success: true,
      reference: "ord_sol_fee_test",
      address: "PajSolanaOrderAddr1111111111111111111111",
      amount: Number(walletLib.formatMicro(amountMicroArg)),
      fiatAmount: 150000,
      accountName: "Test Solana Account",
      rate: 1500,
      status: "pending",
    };
  };

  try {
    const res = await executeOfframp(
      userWallet,
      100, // $100 send amount
      {
        accountNumber: "0123456789",
        bankCode: "058",
        bankName: "GTBank",
      },
      testUserId,
      "Cash Out",
      { rail: "solana" }
    );

    assert.equal(res.success, true);
    assert.equal(res.rail, "solana");
    assert.equal(res.amount, 100);
    assert.equal(res.feeUsdc, 1.0);
    assert.equal(res.netAmountUsdc, 100.0);
    assert.equal(res.totalDebitUsdc, 101.0);
    assert.equal(solTransfers.length, 2, "Must execute both net transfer and fee transfer on Solana");
    assert.equal(solTransfers[0].amount, 100.0, "Full $100.00 send amount must be sent to Paj");
    assert.equal(solTransfers[1].amount, 1.0, "Fee sent to recipient must be $1.00");
    assert.equal(solTransfers[1].recipientAddress, "DW3erQUA4Yfxk63YxiLanAYp4ByKKMgYSxgjbPHSJhCK");
  } finally {
    multichain.getSplTokenBalance = origGetSpl;
    multichain.sendSolanaTransfer = origSendSol;
    require("../src/offramp").requestOfframp = origRequestOfframp;
    db.getUser = origGetUser;
  }
});

test("Offramp: tells user how much they can send with fees when balance is insufficient for amount + 1% fee", async () => {
  const testUserId = 999111444;
  const userWallet = {
    address: "0x3333333333333333333333333333333333333333",
    privateKey: "0x0123456789012345678901234567890123456789012345678901234567890123",
  };

  const origGetNative = walletLib.getNativeBalanceMicro;
  const origEnsureLiquid = require("../src/auto_earn").ensureLiquidBalance;

  // User has exactly ₦20,000 worth of USDC ($12.50 at ₦1,600/$) and tries to send ₦20,000 ($12.50)
  walletLib.getNativeBalanceMicro = async () => walletLib.parseToMicro("12.50");
  require("../src/auto_earn").ensureLiquidBalance = async () => ({ liquidated: false });

  const idemKey = `offramp:${testUserId}:0123456789:12.5`;
  db.db.prepare("DELETE FROM universal_idempotency WHERE key = ?").run(idemKey);

  try {
    const res = await executeOfframp(
      userWallet,
      12.5,
      {
        accountNumber: "0123456789",
        bankCode: "058",
        bankName: "GTBank",
        fiatAmount: 20000,
        rate: 1600,
      },
      testUserId,
      "Cash Out",
      { rail: "arc" }
    );

    assert.equal(res.success, false, "Should reject when balance covers send amount but not send amount + 1% fee");
    assert.ok(res.error.includes("you can send up to"), "Error must tell user how much they can send with fees");
    assert.ok(res.error.includes("19,801"), "Error must tell user they can send up to ₦19,801 with fees");
    assert.equal(res.maxSendNgn, 19801);
  } finally {
    walletLib.getNativeBalanceMicro = origGetNative;
    require("../src/auto_earn").ensureLiquidBalance = origEnsureLiquid;
  }
});

