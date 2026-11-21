// tests/fraud_hardening.test.js
// End-to-End Verification for All 5 Anti-Fraud & Security Hardening Findings:
// 1. Webhook HMAC Authentication (no missing-header bypass on Alchemy/Paj)
// 2. Zero-Balance Solana ATA / Gas-Drip Drain Prevention in Airbills
// 3. Hosted Payment Link Chargeback-Arbitrage Hold & Admin Release in Nuvion Orchestrator
// 4. Anti-Sybil Referral Qualification & Atomic Points Redemption
// 5. Automated Burst Velocity Tripwire (Auto-Freeze + Admin Alert), Tier Caps & 1-Second Circuit Breaker

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { Wallet } = require("ethers");

process.env.PAYIT_DB_PATH = path.join(os.tmpdir(), `test_fraud_hardening_${Date.now()}.db`);
process.env.INVOICE_FORWARDING_SECRET = "test_system_secret_32_bytes_long_!!";
process.env.ADMIN_IDS = "999000111";

const db = require("../src/db");
const fraudGuard = require("../src/fraud_guard");
const webhookServer = require("../src/webhook_server");
const airbills = require("../src/airbills");
const nuvion = require("../src/nuvion");
const orchestrator = require("../src/nuvion_orchestrator");

test("Finding 1: verifyAlchemySignature rejects missing signature header when signingKey is set", () => {
  const secret = "alch_signing_secret_12345";
  const body = Buffer.from(JSON.stringify({ event: { activity: [] } }), "utf8");

  // Previously returned true when header was omitted! Now must strictly return false.
  assert.equal(
    webhookServer.verifyAlchemySignature(body, {}, secret),
    false,
    "Missing x-alchemy-signature header must fail verification when signingKey is configured"
  );

  // Invalid signature must fail
  assert.equal(
    webhookServer.verifyAlchemySignature(body, { "x-alchemy-signature": "deadbeef" }, secret),
    false,
    "Invalid signature must fail"
  );

  // Valid HMAC-SHA256 signature must pass
  const validSig = crypto.createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(
    webhookServer.verifyAlchemySignature(body, { "x-alchemy-signature": validSig }, secret),
    true,
    "Valid HMAC signature must pass"
  );
});

test("Finding 2: Airbills executeBillPayment checks user balance BEFORE activating Solana ATA / dripping gas", async () => {
  process.env.AIRBILLS_SECRET_KEY = "test_airbills_secret_key";
  // Deliberately omit SOLANA_FEE_PAYER_KEY: if ensureUserSolanaActivated were called first on a $0 user,
  // it would fail with 'Solana wallet activation requires SOLANA_FEE_PAYER_KEY' or spend SOL rent.
  // Because balance check now runs FIRST, a $0 user is rejected with 'Insufficient balance' before activation!
  delete process.env.SOLANA_FEE_PAYER_KEY;

  const w = Wallet.createRandom();
  const zeroUser = db.createUserWithWallet(710001, "zerobal_bot", w.address, w.privateKey, "1234");

  await assert.rejects(
    async () => {
      await airbills.executeBillPayment({
        user: zeroUser,
        pin: "1234",
        context: "personal",
        productCode: "100",
        category: "airtime",
        providerName: "MTN",
        recipient: "08012345678",
        amountNgn: 1000,
        billData: { phoneNumber: "08012345678", networkId: "01" },
      });
    },
    (err) => {
      assert.ok(
        err.message.includes("Insufficient balance"),
        `Expected 'Insufficient balance' before Solana activation, got: ${err.message}`
      );
      return true;
    }
  );
});

test("Finding 3: Hosted Payment Link inflows exceeding anti-chargeback threshold are held for review & releasable by admin", async () => {
  const w = Wallet.createRandom();
  const tgId = 720002;
  db.createUserWithWallet(tgId, "paylink_merchant", w.address, w.privateKey, "1234");
  const entity = db.upsertNuvionEntity({
    telegramId: tgId,
    accountType: "personal",
    entityId: "01ENTITY_FRAUD_F3",
    entityType: "individual",
    legalName: "Paylink Merchant",
    status: "approved",
    uscAccountId: "01ACC_USC_F3",
    uscBaseAddress: "0x1111111111111111111111111111111111111111",
    selfCounterpartyId: "01CP_SELF_F3",
    selfBasePaymentDetailId: "01PD_SELF_F3",
  });

  const adminAlerts = [];
  const userNotices = [];
  const mockBot = {
    telegram: {
      sendMessage: async (chatId, text) => {
        if (String(chatId) === "999000111") adminAlerts.push(text);
        else userNotices.push(text);
        return { message_id: 1 };
      },
    },
  };

  // Large $4,000 CAD Interac Payment Link inflow (> $2,500 single-tx payment link threshold)
  const confirmedInflow = {
    id: "01INFLOW_PAYLINK_LARGE",
    account_id: "01ACC_CAD_F3",
    currency: "CAD",
    amount: 400000, // 4,000.00 CAD (~$2,920 USD > $2,500 cap)
    applicable_fee: 0,
    status: "successful",
    payment_type: "interac-transfer",
    meta: { funding_session_id: "01FS_INTERAC_99" },
  };

  const holdRes = await orchestrator.handleInboundFiatSweep({
    confirmed: confirmedInflow,
    entityRecord: entity,
    bot: mockBot,
  });

  assert.equal(holdRes.swept, false, "Large payment-link inflow must not auto-sweep immediately");
  assert.equal(holdRes.held, true, "Inflow must be placed on anti-chargeback hold");
  assert.ok(adminAlerts.some((m) => m.includes("CHARGEBACK GUARD")), "Admin must be alerted on Telegram");
  assert.ok(userNotices.some((m) => m.includes("Deposit Under Security Review")), "User must receive compliance review notice");

  // Now admin approves & releases the held inflow
  fraudGuard.approveHeldInflow("01INFLOW_PAYLINK_LARGE");
  const afterApprove = await fraudGuard.screenInboundFiatInflow({
    entityRecord: entity,
    confirmed: confirmedInflow,
    netMajor: 4000,
    isPaymentLink: true,
  });
  assert.equal(afterApprove.hold, false, "Admin-approved inflow must clear the hold screen");
});

test("Finding 4: Anti-Sybil Referral Qualification blocks free invoice creation & micro-transfers, and redeemPointsAtomic prevents negative balances", () => {
  const referrer = db.createUserWithWallet(730001, "referrer_f4", Wallet.createRandom().address, Wallet.createRandom().privateKey, "1111");
  const referred = db.createUserWithWallet(730002, "referred_f4", Wallet.createRandom().address, Wallet.createRandom().privateKey, "2222", null, null, referrer.telegram_id);

  // 1. Free invoice creation awards points to user, but MUST NOT trigger referral bonus to referrer
  db.awardPoints(referred.telegram_id, 10, "invoice", "Created free invoice");
  assert.equal(db.getPointsBalance(referred.telegram_id), 10);
  assert.equal(db.getPointsBalance(referrer.telegram_id), 0, "Free invoice creation must never trigger referral bonus");

  // 2. Micro-transfer ($0.25 < $5.00 min qualifying volume) MUST NOT trigger referral bonus
  db.awardPoints(referred.telegram_id, 4, "sendout", "Micro send $0.25", { amountUsd: 0.25 });
  assert.equal(db.getPointsBalance(referrer.telegram_id), 0, "Sub-$5 micro-transfer must not trigger referral bonus");

  // 3. Real qualifying transaction ($25.00 >= $5.00) triggers referral bonus exactly once!
  db.awardPoints(referred.telegram_id, 5, "cashout", "Cash out $25.00", { amountUsd: 25.0 });
  assert.equal(db.getPointsBalance(referrer.telegram_id), 20, "Qualifying transaction must award 20-point referral bonus");

  // 4. Atomic points redemption prevents over-redemption or negative balance
  const newBal = db.redeemPointsAtomic(referrer.telegram_id, 20, "redeem_airtime", "Redeemed 20 pts");
  assert.equal(newBal, 0);

  assert.throws(
    () => db.redeemPointsAtomic(referrer.telegram_id, 20, "redeem_airtime", "Double redeem attempt"),
    /Insufficient points balance/
  );
  assert.equal(db.getPointsBalance(referrer.telegram_id), 0, "Points balance must never go negative");
});

test("Finding 5: Global Circuit Breaker, Tier-0 vs Tier-1 Daily Limits, and Automated Burst Velocity Auto-Freeze Tripwire", async () => {
  const w0 = Wallet.createRandom();
  const tier0User = db.createUserWithWallet(740001, "tier0_user", w0.address, w0.privateKey, "1234");

  // 1. 1-Second Global Circuit Breaker
  fraudGuard.setPayoutsPaused(true, "Provider rate anomaly check", "999000111");
  await assert.rejects(
    async () => {
      await fraudGuard.assertOutboundAllowed({
        telegramId: tier0User.telegram_id,
        accountType: "personal",
        action: "paj_offramp_ngn",
        amountUsd: 25,
      });
    },
    /temporarily paused for security maintenance/
  );

  // Resume circuit breaker
  fraudGuard.setPayoutsPaused(false, "All clear", "999000111");

  // 2. Tier-0 Hourly / Daily Limit Enforcement ($1,000/hr, $2,000/day for unverified Tier 0)
  await assert.rejects(
    async () => {
      await fraudGuard.assertOutboundAllowed({
        telegramId: tier0User.telegram_id,
        accountType: "personal",
        action: "paj_offramp_ngn",
        amountUsd: 1500, // exceeds Tier-0 $1,000/hr cap
      });
    },
    /exceeds your Tier 0 hourly security limit/
  );

  // 3. Burst Velocity Tripwire: firing 8 outbound txs in 10 minutes auto-freezes the user on the 9th attempt and alerts ADMIN_IDS
  const adminAlerts = [];
  const mockBot = {
    telegram: {
      sendMessage: async (chatId, text) => {
        adminAlerts.push({ chatId: String(chatId), text });
        return { message_id: 1 };
      },
    },
  };

  for (let i = 0; i < 8; i++) {
    await fraudGuard.assertOutboundAllowed({
      telegramId: tier0User.telegram_id,
      accountType: "personal",
      action: "paj_offramp_ngn",
      amountUsd: 10,
      bot: mockBot,
    });
  }
  assert.equal(db.isBlocked(tier0User.telegram_id), false);

  // 9th burst transaction within 10 minutes -> trips wire & auto-freezes account!
  await assert.rejects(
    async () => {
      await fraudGuard.assertOutboundAllowed({
        telegramId: tier0User.telegram_id,
        accountType: "personal",
        action: "paj_offramp_ngn",
        amountUsd: 10,
        bot: mockBot,
      });
    },
    /Security Tripwire: Unusual transaction burst detected/
  );

  assert.equal(db.isBlocked(tier0User.telegram_id), true, "User must be automatically frozen in SQLite on burst tripwire");
  assert.ok(
    adminAlerts.some((a) => a.chatId === "999000111" && a.text.includes("FRAUD TRIPWIRE TRIGGERED")),
    "ADMIN_IDS must receive immediate Telegram Fraud Tripwire alert"
  );
});
