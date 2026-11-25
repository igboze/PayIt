// Bank account name check: Paj directory search and NIBSS check run in parallel, the first
// name wins, verified names are cached, and concurrent checks share one lookup.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = process.env.NODE_ENV === "production" ? "test" : process.env.NODE_ENV || "test";
const features = require("../src/app_api/features");

const auth = { telegramId: 1, user: {} };
const bankResolver = { resolveBankCode: async (code) => ({ bankCode: String(code).padStart(6, "0"), bankName: "GTBank" }) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pajMock({ searchMs = 0, searchName = null, registerMs = 0, registerName = null, registerError = null } = {}) {
  const calls = { search: 0, register: 0 };
  return {
    calls,
    paj: {
      searchBankAccount: async () => {
        calls.search++;
        await sleep(searchMs);
        return searchName ? [{ accountName: searchName, bank: { code: "000058", name: "GTBank" } }] : [];
      },
      registerPermanentBankAccount: async () => {
        calls.register++;
        await sleep(registerMs);
        if (registerError) throw new Error(registerError);
        return registerName ? { accountName: registerName, bank: { name: "GTBank" } } : {};
      },
    },
  };
}

test("NIBSS answer wins when the directory search has nothing, without waiting on it", async () => {
  const { paj, calls } = pajMock({ searchMs: 300, registerMs: 20, registerName: "ADA OKAFOR" });
  features.__setTestDeps({ paj, bankResolver });
  const t0 = Date.now();
  const res = await features.resolveBankAccount(auth, { bankCode: "058", accountNumber: "0123456789" });
  assert.equal(res.data.accountName, "ADA OKAFOR");
  assert.ok(Date.now() - t0 < 250, "should not wait for the slow search");
  assert.equal(calls.register, 1);
});

test("a fast directory hit wins and the name is cached for the next check", async () => {
  const { paj, calls } = pajMock({ searchMs: 5, searchName: "MARY JONES", registerMs: 400, registerName: "MARY JONES" });
  features.__setTestDeps({ paj, bankResolver });
  const first = await features.resolveBankAccount(auth, { bankCode: "058", accountNumber: "1111111111" });
  assert.equal(first.data.accountName, "MARY JONES");
  const t0 = Date.now();
  const second = await features.resolveBankAccount(auth, { bankCode: "058", accountNumber: "1111111111" });
  assert.equal(second.data.accountName, "MARY JONES");
  assert.ok(Date.now() - t0 < 20, "cached check should be instant");
  assert.equal(calls.search, 1);
});

test("concurrent checks of the same account share one lookup", async () => {
  const { paj, calls } = pajMock({ registerMs: 30, registerName: "TOLU ADE" });
  features.__setTestDeps({ paj, bankResolver });
  const [a, b] = await Promise.all([
    features.resolveBankAccount(auth, { bankCode: "058", accountNumber: "2222222222" }),
    features.resolveBankAccount(auth, { bankCode: "058", accountNumber: "2222222222" }),
  ]);
  assert.equal(a.data.accountName, "TOLU ADE");
  assert.equal(b.data.accountName, "TOLU ADE");
  assert.equal(calls.register, 1);
});

test("an invalid account is reported as not found; a provider outage as unavailable", async () => {
  let m = pajMock({ registerError: "Paj registerPermanentBankAccount failed (400): invalid account" });
  features.__setTestDeps({ paj: m.paj, bankResolver });
  await assert.rejects(features.resolveBankAccount(auth, { bankCode: "058", accountNumber: "3333333333" }), (err) => err.status === 404 || err.code === "account_not_found");

  m = pajMock({ registerError: "Paj registerPermanentBankAccount failed (network): socket hang up" });
  features.__setTestDeps({ paj: m.paj, bankResolver });
  await assert.rejects(features.resolveBankAccount(auth, { bankCode: "058", accountNumber: "4444444444" }), (err) => err.status === 502 || err.code === "provider_error");
  features.__setTestDeps({});
});
