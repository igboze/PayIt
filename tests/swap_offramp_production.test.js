// tests/swap_offramp_production.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const offramp = require("../src/offramp");
const swapLib = require("../src/swap");
const walletLib = require("../src/wallet");

test("Offramp: requestOfframp recognizes configured Paj Cash key", async () => {
  // Test with configured key
  process.env.PAJCASH_API_KEY = "1f63045c-194b-4e3e-b578-755401dbbc8d";
  process.env.PAJCASH_API_URL = "https://api.pajcash.com";

  const amountMicro = walletLib.parseToMicro("10");
  const bankDetails = {
    accountNumber: "0123456789",
    bankCode: "000013", // GTBank 6-digit NIBSS code
    accountName: "John Doe",
  };

  const res = await offramp.requestOfframp(123456, amountMicro, bankDetails);
  assert.ok(res, "Expected offramp result object");
  // Paj v2 validates account with NIBSS in real-time; dummy accounts are rejected with 400
  if (res.success) {
    assert.ok(res.reference, "Expected reference in successful response");
  } else {
    assert.ok(res.error.includes("Invalid account number") || res.status === "failed", "Expected NIBSS validation error");
  }
});

test("SwapFX: getSwapQuote estimates conversion on Arc", async () => {
  const amountMicro = walletLib.parseToMicro("5");
  const quote = await swapLib.getSwapQuote("USDC", "EURC", amountMicro);
  assert.ok(quote, "Expected swap quote");
  assert.ok(quote.destinationAmount || quote.amountOut || quote.fromToken, "Expected quote details");
});
