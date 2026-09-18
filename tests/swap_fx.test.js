// tests/swap_fx.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const swapLib = require("../src/swap");

test("SwapFX: getFxRates retrieves live Arc stablecoin exchange rates", async () => {
  const rates = await swapLib.getFxRates();
  assert.ok(typeof rates === "object" && rates !== null);

  const usdcAddress = "0x3600000000000000000000000000000000000000";
  const eurcAddress = "0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1";

  if (rates[usdcAddress]) {
    assert.ok(rates[usdcAddress].priceUSD);
    assert.equal(rates[usdcAddress].decimals, 6);
  }
  if (rates[eurcAddress]) {
    assert.ok(rates[eurcAddress].priceUSD);
    assert.equal(rates[eurcAddress].decimals, 6);
  }
});
