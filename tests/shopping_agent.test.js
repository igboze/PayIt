const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseShoppingIntent,
  parseShoppingHeuristic,
  normalizeShoppingParsed,
  searchForProduct
} = require("../agent/shopping_agent");

test("parses product with budget: Find a Macbook Pro under $2000", async () => {
  const result = await parseShoppingIntent("Find a Macbook Pro under $2000");
  assert.equal(result.product_name, "Macbook Pro");
  assert.equal(result.max_price, 2000);
  assert.equal(result.currency, "USDC");
});

test("parses product without budget: Buy a new ergonomic office chair", async () => {
  const result = await parseShoppingIntent("Buy a new ergonomic office chair");
  assert.equal(result.product_name, "new ergonomic office chair");
  assert.equal(result.max_price, null);
  assert.equal(result.currency, "USDC");
});

test("parses product with delivery address: Order Sony headphones for $350 deliver to 12 Broad St, Lagos", async () => {
  const result = await parseShoppingIntent("Order Sony headphones for $350 deliver to 12 Broad St, Lagos");
  assert.equal(result.product_name, "Sony headphones");
  assert.equal(result.max_price, 350);
  assert.equal(result.delivery_address, "12 Broad St, Lagos");
});

test("parses Naira shopping instruction: Buy iPhone 13 for ₦800,000", async () => {
  const result = await parseShoppingIntent("Buy iPhone 13 for ₦800,000");
  assert.equal(result.product_name, "iPhone 13");
  assert.equal(result.max_price, 800000);
  assert.equal(result.currency, "NGN");
});

test("searchForProduct retrieves real product under budget from dummyjson", async () => {
  const product = await searchForProduct("Macbook Pro", 2000);
  assert.ok(product);
  assert.ok(product.name.includes("MacBook Pro") || product.name.includes("Macbook Pro"));
  assert.ok(Number(product.price) <= 2000);
  assert.ok(product.seller_wallet);
});
