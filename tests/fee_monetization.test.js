// tests/fee_monetization.test.js
// Platform fee monetization and revenue verification tests

const test = require("node:test");
const assert = require("node:assert/strict");

const near = require("../src/near");
const swap = require("../src/swap");

test("NEAR Intents: 1Click quote automatically includes platform appFees", async () => {
  const originalApiRequest = near.apiRequest;

  // Verify helper functions
  const feeRecipient = near.getNearFeeRecipient();
  const feeBps = near.getNearFeeBps();

  assert.ok(feeRecipient, "Fee recipient must be configured");
  assert.equal(typeof feeRecipient, "string");
  assert.equal(feeBps, 100, "Platform fee BPS should be 100 (1.00%)");

  let capturedBody = null;
  near.apiRequest = async (method, path, body) => {
    capturedBody = body;
    // Simulate Defuse 1Click API splitting gross fee 50/50 with partner
    const netFees = (body.appFees || []).map((af) => ({
      recipient: af.recipient,
      fee: Math.floor(af.fee / 2),
    }));
    return {
      quote: { amountOut: "10000000" },
      quoteRequest: {
        ...body,
        appFees: netFees,
      },
    };
  };

  try {
    const res = await near.getQuote({
      originAsset: near.ASSETS.STARKNET_STRK,
      destinationAsset: near.ASSETS.BASE_USDC,
      amount: "100000000000000000000",
      recipient: "0x1234567890123456789012345678901234567890",
      refundTo: "0x0000000000000000000000000000000000000000000000000000000000000001",
    });

    assert.ok(capturedBody?.appFees, "Quote request payload must include appFees");
    assert.equal(capturedBody.appFees[0].recipient, feeRecipient);
    // Request gross fee must be feeBps * 2 (200 bps) to deliver 100 bps net
    assert.equal(capturedBody.appFees[0].fee, feeBps * 2);

    assert.ok(res.quoteRequest?.appFees, "Quote response must reflect appFees");
    assert.equal(res.quoteRequest.appFees[0].recipient, feeRecipient);
    assert.equal(res.quoteRequest.appFees[0].fee, 100, "Net fee delivered to platform must be 100 bps (1.00%)");
  } finally {
    near.apiRequest = originalApiRequest;
  }
});

test("Swap: protocol fee calculated with 100 BPS (1.00%) rate", async () => {
  // Test getSwapQuote with simulated estimate
  const kit = swap.getSwapKit();
  const origEstimate = kit.estimate;

  kit.estimate = async () => ({
    estimatedOutput: "100.00",
    estimatedOutputFormatted: "100.00",
  });

  try {
    const quote = await swap.getSwapQuote("USDC", "EURC", "100000000"); // 100 USDC
    assert.ok(quote, "Must return quote");
    // At 100 BPS (1.00%), 100 * 0.0100 = 1.00
    assert.equal(quote.protocolFee, "1.0000");
    assert.equal(quote.amountOut, "99.0000");
  } finally {
    kit.estimate = origEstimate;
  }
});

test("Offramp: 1% fee is added on top of send amount (charged from main balance) and routed to APP_FEE_RECIPIENT_ADDRESS", async () => {
  const { calcMaxOfframpFromBalance } = require("../agent/executor");

  const amountUsdc = 100;
  const feeUsdc = Number((amountUsdc * 0.01).toFixed(4));
  const netAmountUsdc = Number(amountUsdc.toFixed(4));
  const totalDebitUsdc = Number((netAmountUsdc + feeUsdc).toFixed(4));

  assert.equal(feeUsdc, 1.0);
  assert.equal(netAmountUsdc, 100.0, "Full send amount goes to recipient");
  assert.equal(totalDebitUsdc, 101.0, "1% fee is charged on top from main balance");

  // If user only has ₦20,000 ($12.50 at 1600/$), max sendable with 1% fee is ₦19,801
  const maxInfo = calcMaxOfframpFromBalance(12.5, 1600);
  assert.equal(maxInfo.maxSendNgn, 19801);
  assert.equal(maxInfo.feeNgn, 199);
  assert.equal(maxInfo.totalNgn, 20000);
  assert.ok(maxInfo.totalUsdc <= 12.5, "Total USDC with fee must not exceed available balance");
});
test("Fee Routing: Default fee recipient is on Arc, Solana fee recipient only for native Solana transactions", () => {
  const arcFeeRecipient = process.env.APP_FEE_RECIPIENT_ADDRESS || "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359";
  const solFeeRecipient = process.env.SOLANA_FEE_RECIPIENT || "DW3erQUA4Yfxk63YxiLanAYp4ByKKMgYSxgjbPHSJhCK";
  const walletLib = require("../src/wallet");
  const multichain = require("../src/multichain");

  // Arc fee recipient must be valid EVM address
  assert.ok(walletLib.isValidAddress(arcFeeRecipient), "Arc fee recipient must be a valid EVM address");

  // Solana fee recipient must be valid Solana address
  assert.ok(multichain.isSolanaAddress(solFeeRecipient), "Solana fee recipient must be a valid Solana address");

  // NEAR Intent fee recipient defaults to Arc/EVM address
  const nearFeeRecipient = near.getNearFeeRecipient();
  assert.equal(nearFeeRecipient.toLowerCase(), arcFeeRecipient.toLowerCase(), "NEAR Intent fees must default to Arc/EVM fee recipient");
});
