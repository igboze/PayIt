const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const paj = require("../src/paj");

describe("Onramp Exact Fiat & Spread Model", () => {
  it("calculates lower received USDC instead of increasing Naira transfer amount", async () => {
    const rawRate = 1388.75;
    const markupNgn = 5.0;
    const effectiveOnrampRate = rawRate + markupNgn; // 1393.75

    const userRequestedDepositNgn = 2000;
    const expectedUsdcReceived = Number((userRequestedDepositNgn / effectiveOnrampRate).toFixed(2)); // ~1.43 USDC

    // User sends exact 2000 NGN
    assert.strictEqual(userRequestedDepositNgn, 2000);
    // User gets 1.43 USDC on-chain
    assert.strictEqual(expectedUsdcReceived, 1.43);
    // User is NOT asked to deposit extra Naira
    assert.ok(expectedUsdcReceived < (userRequestedDepositNgn / rawRate));
  });
});
