const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Wallet } = require("ethers");
const db = require("../src/db");
const multichain = require("../src/multichain");
const webhookServer = require("../src/webhook_server");

describe("Account Isolation & Multi-User Separation Suite", () => {
  it("guarantees unique addresses and complete isolation between Personal, Business, and different Users", () => {
    const tgIdA = Math.floor(Math.random() * 800000) + 100000;
    const tgIdB = Math.floor(Math.random() * 800000) + 100000;

    // 1. Create User A (Personal + Business)
    const walletA_Pers = Wallet.createRandom();
    const walletA_Biz  = Wallet.createRandom();
    const userA = db.createUserWithWallet(
      tgIdA,
      `user_a_${tgIdA}`,
      walletA_Pers.address,
      walletA_Pers.privateKey,
      "1234",
      walletA_Biz.address,
      walletA_Biz.privateKey
    );

    // 2. Create User B (Personal + Business)
    const walletB_Pers = Wallet.createRandom();
    const walletB_Biz  = Wallet.createRandom();
    const userB = db.createUserWithWallet(
      tgIdB,
      `user_b_${tgIdB}`,
      walletB_Pers.address,
      walletB_Pers.privateKey,
      "5678",
      walletB_Biz.address,
      walletB_Biz.privateKey
    );

    // Verify all 4 Arc EVM addresses are distinct
    const evmAddresses = [
      userA.deposit_address,
      userA.business_deposit_address,
      userB.deposit_address,
      userB.business_deposit_address,
    ];
    const uniqueEvm = new Set(evmAddresses);
    assert.strictEqual(uniqueEvm.size, 4, "All EVM deposit addresses must be completely distinct");

    // Verify all 4 Solana deposit addresses are distinct
    const solAddresses = [
      userA.solana_deposit_address,
      userA.biz_solana_deposit_address,
      userB.solana_deposit_address,
      userB.biz_solana_deposit_address,
    ];
    const uniqueSol = new Set(solAddresses);
    assert.strictEqual(uniqueSol.size, 4, "All Solana deposit addresses must be completely distinct");

    // Verify db lookup by Solana address correctly identifies the exact user and account
    const foundUserA_Pers = db.getUserBySolanaAddress(userA.solana_deposit_address);
    assert.strictEqual(foundUserA_Pers.telegram_id, tgIdA);

    const foundUserA_Biz = db.getUserByBizSolanaAddress(userA.biz_solana_deposit_address);
    assert.strictEqual(foundUserA_Biz.telegram_id, tgIdA);

    const foundUserB_Pers = db.getUserBySolanaAddress(userB.solana_deposit_address);
    assert.strictEqual(foundUserB_Pers.telegram_id, tgIdB);

    const foundUserB_Biz = db.getUserByBizSolanaAddress(userB.biz_solana_deposit_address);
    assert.strictEqual(foundUserB_Biz.telegram_id, tgIdB);
  });
});
