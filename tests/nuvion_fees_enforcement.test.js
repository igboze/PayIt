// tests/nuvion_fees_enforcement.test.js
// Tests Nuvion rail fee capture across all international corridors + strict Proxim fee enforcement

const test = require("node:test");
const assert = require("node:assert/strict");

const corridors = require("../src/nuvion_corridors");
const payouts = require("../src/nuvion_payouts");
const nuvion = require("../src/nuvion");
const nuvionWebhooks = require("../src/nuvion_webhooks");
const db = require("../src/db");
const walletLib = require("../src/wallet");
const chains = require("../src/chains");

test("estimateNuvionRailFeeUsd covers local & SWIFT rails accurately across currencies", () => {
  const gbpFps = corridors.estimateNuvionRailFeeUsd("gbp_fps", "GBP", 66.98, 50, 0.746535);
  assert.ok(Math.abs(gbpFps.nuvionRailFeeUsd - 6.7) < 0.05, `Expected ~$6.70 for GBP FPS, got ${gbpFps.nuvionRailFeeUsd}`);

  const gbpSwift = corridors.estimateNuvionRailFeeUsd("swift_iban", "GBP", 1000, 746, 0.746);
  assert.equal(gbpSwift.nuvionRailFeeUsd, 55, "SWIFT must capture $50 + 0.5%");

  const eurSepa = corridors.estimateNuvionRailFeeUsd("eur_sepa", "EUR", 55, 50, 0.909);
  assert.ok(eurSepa.nuvionRailFeeUsd >= 5.4, `Expected >= $5.40 for EUR SEPA, got ${eurSepa.nuvionRailFeeUsd}`);

  const usdAch = corridors.estimateNuvionRailFeeUsd("usd_ach", "USD", 50, 50, 1);
  assert.equal(usdAch.nuvionRailFeeUsd, 5.0);

  const ngnNip = corridors.estimateNuvionRailFeeUsd("ngn_nip", "NGN", 35, 50000, 1428.57);
  assert.ok(ngnNip.nuvionRailFeeUsd >= 0.14 && ngnNip.nuvionRailFeeUsd <= 0.30);
});

test("quoteGlobalPayout captures Principal + Nuvion Rail Fee + Proxim Platform Fee upfront", async () => {
  const origBootstrap = nuvionWebhooks.bootstrapApprovedEntity;
  const origQuote = nuvion.createFxQuote;

  const testTgId = 777666555;
  db._db.prepare("DELETE FROM nuvion_entities WHERE telegram_id = ?").run(testTgId);

  try {
    const mockEnt = {
      telegram_id: testTgId,
      account_type: "personal",
      entity_id: "ent_fee_test_1",
      entity_type: "individual",
      status: "approved",
      usc_account_id: "acct_usc_1",
      usc_base_address: "0x2222222222222222222222222222222222222222",
    };
    db.upsertNuvionEntity({
      telegramId: testTgId,
      accountType: "personal",
      entityId: mockEnt.entity_id,
      entityType: mockEnt.entity_type,
      status: mockEnt.status,
      uscAccountId: mockEnt.usc_account_id,
      uscBaseAddress: mockEnt.usc_base_address,
    });
    nuvionWebhooks.bootstrapApprovedEntity = async () => mockEnt;

    nuvion.createFxQuote = async () => ({
      id: "fx_test_1",
      from: "USC",
      to: "USD",
      amount_to: 5000,
      amount_from: 5000,
      rate: 1.0,
      quote: { expires_at: Date.now() + 60000, valid_for: 60 },
    });

    const q = await payouts.quoteGlobalPayout({
      telegramId: testTgId,
      accountType: "personal",
      railKey: "usd_ach",
      targetCurrency: "USD",
      targetAmountMajor: 50,
    });

    assert.equal(q.nuvionPrincipalUsd, 50);
    assert.equal(q.nuvionRailFeeUsd, 5);
    assert.equal(q.nuvionCostUsd, 55, "Nuvion bridge amount must include $50 principal + $5 rail fee");
    assert.ok(q.marginUsd >= 0.5, "Proxim fee must be at least $0.50");
    assert.equal(q.userTotalUsd, Number((55 + q.marginUsd).toFixed(2)), "Total user debit = principal + Nuvion fee + Proxim fee");
  } finally {
    nuvionWebhooks.bootstrapApprovedEntity = origBootstrap;
    nuvion.createFxQuote = origQuote;
    db._db.prepare("DELETE FROM nuvion_entities WHERE telegram_id = ?").run(testTgId);
  }
});

test("fundNuvionBaseBridge enforces Proxim fee collection strictly and throws if fee fails", async () => {
  const origGetUnified = chains.getUnifiedBalance;
  const origSendTx = walletLib.sendSponsoredOrDirectTransaction;
  const origGateway = require("../src/gateway").transferBetweenChains;

  const w = walletLib.generateUserWallet();
  const enc = walletLib.encryptPrivateKey(w.privateKey, "1234");
  const mockUser = {
    telegram_id: 777666556,
    deposit_address: w.address,
    encrypted_key: enc.encryptedKey,
    key_salt: enc.salt,
    key_iv: enc.iv,
    key_tag: enc.tag,
  };

  try {
    chains.getUnifiedBalance = async () => ({
      total: 60,
      arc: { usdc: 5, eurc: 0 },
      base: { usdc: 0 },
      gateway: { usdc: 55 },
      solana: { usdc: 0 },
    });
    require("../src/gateway").transferBetweenChains = async () => ({ txHash: "gw_ok_1" });
    walletLib.sendSponsoredOrDirectTransaction = async () => {
      throw new Error("Fee transfer rejected");
    };

    await assert.rejects(
      async () => {
        await payouts.fundNuvionBaseBridge({
          user: mockUser,
          pin: "1234",
          accountType: "personal",
          nuvionBaseAddress: "0x3333333333333333333333333333333333333333",
          nuvionCostUsd: 55,
          marginUsd: 0.55,
        });
      },
      /Fee transfer rejected|Insufficient balance to cover Proxim platform fee/,
      "Must fail closed when Proxim fee transfer fails"
    );
  } finally {
    chains.getUnifiedBalance = origGetUnified;
    walletLib.sendSponsoredOrDirectTransaction = origSendTx;
    require("../src/gateway").transferBetweenChains = origGateway;
  }
});
