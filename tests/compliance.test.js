// tests/compliance.test.js
// Tests for Partner, Platform & Legal Compliance Controls (src/compliance.js, db, fraud_guard)

const test = require("node:test");
const assert = require("node:assert/strict");

const compliance = require("../src/compliance");
const db = require("../src/db");
const fraudGuard = require("../src/fraud_guard");

test("Sanctioned jurisdictions (OFAC/FATF) are blocked while supported countries pass", () => {
  for (const blocked of ["KP", "ir", "SY", "cu", "RU", "by", "MM", "AF", "VE"]) {
    assert.equal(compliance.isSanctionedCountry(blocked), true, `Must block ${blocked}`);
    const msg = compliance.getSanctionedCountryMessage(blocked);
    assert.ok(msg.includes("Not Supported"), `Message must explain block for ${blocked}`);
    assert.ok(msg.includes("not a bank"), "Message must include regulated-partner disclaimer");
  }

  for (const allowed of ["NG", "US", "GB", "CA", "GH", "KE", "DE", "AE"]) {
    assert.equal(compliance.isSanctionedCountry(allowed), false, `Must allow ${allowed}`);
  }
});

test("Terms of Service & Privacy Policy acceptance is persisted in SQLite", () => {
  const testTgId = 999888776;
  db._db.prepare("DELETE FROM users WHERE telegram_id = ?").run(testTgId);

  try {
    db.createUserWithWallet(
      testTgId,
      "compliance_test_user",
      "0x1111111111111111111111111111111111111111",
      "0x" + "11".repeat(32),
      "1234"
    );

    let user = db.getUser(testTgId);
    assert.equal(db.hasAcceptedTerms(user), false, "New row without recordTermsAcceptance has no timestamp");

    const updated = db.recordTermsAcceptance(testTgId, compliance.TERMS_VERSION);
    assert.equal(updated, true, "recordTermsAcceptance must update user row");

    user = db.getUser(testTgId);
    assert.equal(db.hasAcceptedTerms(user), true, "hasAcceptedTerms must return true after acceptance");
    assert.equal(user.accepted_terms_version, compliance.TERMS_VERSION);
  } finally {
    db._db.prepare("DELETE FROM users WHERE telegram_id = ?").run(testTgId);
  }
});

test("Tier-0 unverified caps are tightened to <= $300/hr and <= $500/day by default", () => {
  const cfg = fraudGuard.getVelocityConfig();
  assert.ok(cfg.tier0HourlyLimitUsd <= 300, `Expected Tier-0 hourly <= 300, got ${cfg.tier0HourlyLimitUsd}`);
  assert.ok(cfg.tier0DailyLimitUsd <= 500, `Expected Tier-0 daily <= 500, got ${cfg.tier0DailyLimitUsd}`);
});
