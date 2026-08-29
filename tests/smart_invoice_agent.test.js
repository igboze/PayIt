const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseSmartInvoiceIntent,
  parseSmartInvoiceHeuristic,
  normalizeInvoiceParsed
} = require("../agent/smart_invoice_agent");

test("parses single item invoice: Invoice Jerry $200 for attending Arc event", async () => {
  const result = await parseSmartInvoiceIntent("Invoice Jerry $200 for attending Arc event");
  assert.equal(result.clientName, "Jerry");
  assert.equal(result.currency, "USDC");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description, "attending Arc event");
  assert.equal(result.items[0].unitPrice, 200);
});

test("parses invoice with due date: Invoice Acme Ltd $500 for web design, due July 15", async () => {
  const result = await parseSmartInvoiceIntent("Invoice Acme Ltd $500 for web design, due July 15");
  assert.equal(result.clientName, "Acme Ltd");
  assert.equal(result.currency, "USDC");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description, "web design");
  assert.equal(result.items[0].unitPrice, 500);
  assert.ok(result.dueDate.includes("-07-15") || result.dueDate.includes("-07-14"));
});

test("parses multi-item invoice: Bill TechCorp $200 consulting and $100 hosting", async () => {
  const result = await parseSmartInvoiceIntent("Bill TechCorp $200 consulting and $100 hosting");
  assert.equal(result.clientName, "TechCorp");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].description, "consulting");
  assert.equal(result.items[0].unitPrice, 200);
  assert.equal(result.items[1].description, "hosting");
  assert.equal(result.items[1].unitPrice, 100);
});

test("parses email client: Invoice john@example.com $1,500 for brand identity", async () => {
  const result = await parseSmartInvoiceIntent("Invoice john@example.com $1,500 for brand identity");
  assert.equal(result.clientName, "john@example.com");
  assert.equal(result.clientEmail, "john@example.com");
  assert.equal(result.items[0].unitPrice, 1500);
  assert.equal(result.items[0].description, "brand identity");
});

test("parses EURC currency: Bill Alice 150 EURC for logo design", async () => {
  const result = await parseSmartInvoiceIntent("Bill Alice 150 EURC for logo design");
  assert.equal(result.clientName, "Alice");
  assert.equal(result.currency, "EURC");
  assert.equal(result.items[0].unitPrice, 150);
});

test("returns error for unparseable input missing amount and client", async () => {
  const result = await parseSmartInvoiceIntent("just a random greeting");
  assert.ok(result.error);
});

test("normalizes snake_case LLM response to camelCase structure expected by bot.js", () => {
  const rawLLM = {
    client_name: "Jerry",
    client_email: "jerry@arc.network",
    items: [
      { description: "Attending Arc event", amount: 200 }
    ],
    currency: "USDC",
    due_days: 14,
    summary: "Thanks for attending!"
  };
  const normalized = normalizeInvoiceParsed(rawLLM);
  assert.equal(normalized.clientName, "Jerry");
  assert.equal(normalized.clientEmail, "jerry@arc.network");
  assert.equal(normalized.currency, "USDC");
  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.items[0].description, "Attending Arc event");
  assert.equal(normalized.items[0].unitPrice, 200);
  assert.ok(normalized.dueDate);
  assert.equal(normalized.notes, "Thanks for attending!");
});
