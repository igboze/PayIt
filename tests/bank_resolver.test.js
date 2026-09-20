// tests/bank_resolver.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveBankCode, parseBankDetails } = require("../src/bank_resolver");

test("resolveBankCode: resolves known bank names and aliases correctly", async () => {
  const gtb = await resolveBankCode("GTBank");
  assert.equal(gtb?.bankCode, "000013");

  const access = await resolveBankCode("Access Bank Nigeria PLC");
  assert.equal(access?.bankCode, "000014");

  const kuda = await resolveBankCode("kuda");
  assert.equal(kuda?.bankCode, "090267");

  const opay = await resolveBankCode("OPAY");
  assert.equal(opay?.bankCode, "100004");

  const moniepoint = await resolveBankCode("Moniepoint MFB");
  assert.equal(moniepoint?.bankCode, "090405");
});

test("resolveBankCode: returns null for stop words, empty input, or unknown banks without silent fallback", async () => {
  assert.equal(await resolveBankCode(""), null);
  assert.equal(await resolveBankCode(null), null);
  assert.equal(await resolveBankCode("bank"), null);
  assert.equal(await resolveBankCode("microfinance"), null);
  assert.equal(await resolveBankCode("unknown fictitious entity 99"), null);
});

test("parseBankDetails: correctly identifies bank regardless of segment order", async () => {
  // Format: Name · Account · Bank
  const res1 = await parseBankDetails("John Doe · 0123456789 · GTBank");
  assert.equal(res1.accountNumber, "0123456789");
  assert.equal(res1.bankCode, "000013");
  assert.equal(res1.accountName, "John Doe");

  // Format: Bank · Account · Name
  const res2 = await parseBankDetails("Kuda · 2001234567 · Jane Smith");
  assert.equal(res2.accountNumber, "2001234567");
  assert.equal(res2.bankCode, "090267");
  assert.equal(res2.accountName, "Jane Smith");

  // Format: Account · Name · Bank
  const res3 = await parseBankDetails("0123456789 - Babatunde Adeleke - Access Bank");
  assert.equal(res3.accountNumber, "0123456789");
  assert.equal(res3.bankCode, "000014");
  assert.equal(res3.accountName, "Babatunde Adeleke");

  // Format: Freeform without delimiters
  const res4 = await parseBankDetails("0123456789 Zenith Bank Fatima Aliyu");
  assert.equal(res4.accountNumber, "0123456789");
  assert.equal(res4.bankCode, "000015");
  assert.equal(res4.accountName, "Fatima Aliyu");
});

test("parseBankDetails: does not fall back to GTBank when bank is unrecognized", async () => {
  const res = await parseBankDetails("UnrecognizedCorp · 0123456789 · John Doe");
  assert.equal(res.accountNumber, "0123456789");
  assert.equal(res.bankCode, null);
  assert.equal(res.bankName, null);
});
