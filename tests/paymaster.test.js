// tests/paymaster.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { Wallet, parseUnits } = require("ethers");
const paymaster = require("../src/paymaster");
const walletLib = require("../src/wallet");

test("Paymaster: getPaymasterConfig() returns expected default values", () => {
  const cfg = paymaster.getPaymasterConfig();
  assert.equal(typeof cfg.enabled, "boolean");
  assert.ok(cfg.paymasterUrl);
  assert.ok(cfg.bundlerUrl);
  assert.ok(cfg.entryPoint.startsWith("0x"));
  assert.equal(cfg.chainId, 5042002);
});

test("Paymaster: isPaymasterActive() reflects configuration state", () => {
  const originalEnabled = process.env.ARC_PAYMASTER_ENABLED;
  try {
    process.env.ARC_PAYMASTER_ENABLED = "true";
    assert.equal(paymaster.isPaymasterActive(), true);

    process.env.ARC_PAYMASTER_ENABLED = "false";
    assert.equal(paymaster.isPaymasterActive(), false);
  } finally {
    process.env.ARC_PAYMASTER_ENABLED = originalEnabled;
  }
});

test("Paymaster: buildBaseUserOp creates valid ERC-4337 structure", async () => {
  const dummySender = "0x1111111111111111111111111111111111111111";
  const dummyRecipient = "0x2222222222222222222222222222222222222222";
  const dummyValue = parseUnits("5", 18);

  const userOp = await paymaster.buildBaseUserOp({
    sender: dummySender,
    to: dummyRecipient,
    value: dummyValue,
    data: "0x",
    nonce: 0n,
  });

  assert.equal(userOp.sender.toLowerCase(), dummySender.toLowerCase());
  assert.ok(userOp.callData.startsWith("0xb61d27f6"));
  assert.equal(userOp.initCode, "0x");
  assert.ok(userOp.maxFeePerGas);
  assert.ok(userOp.maxPriorityFeePerGas);
});

test("Paymaster: getUserOpHash calculates deterministic 32-byte hash", async () => {
  const dummySender = "0x1111111111111111111111111111111111111111";
  const dummyRecipient = "0x2222222222222222222222222222222222222222";
  const dummyValue = parseUnits("1", 18);

  const userOp = await paymaster.buildBaseUserOp({
    sender: dummySender,
    to: dummyRecipient,
    value: dummyValue,
  });

  const hash1 = paymaster.getUserOpHash(userOp, paymaster.DEFAULT_ENTRY_POINT, 5042002);
  const hash2 = paymaster.getUserOpHash(userOp, paymaster.DEFAULT_ENTRY_POINT, 5042002);

  assert.equal(typeof hash1, "string");
  assert.equal(hash1.length, 66); // 0x + 64 hex chars
  assert.equal(hash1, hash2);
});

test("Paymaster: requestPaymasterSponsorship formats sponsorship response", async () => {
  // Test with custom config and verify request formatting
  const mockConfig = {
    paymasterUrl: "https://mock.paymaster",
    entryPoint: paymaster.DEFAULT_ENTRY_POINT,
    policyId: "test-policy",
    chainId: 5042002,
  };

  const userOp = await paymaster.buildBaseUserOp({
    sender: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    value: 1000n,
  });

  // Call with unreachable mock URL to verify graceful error catch and description
  await assert.rejects(
    async () => {
      await paymaster.requestPaymasterSponsorship(userOp, mockConfig);
    },
    {
      message: /Paymaster sponsorship rejected/,
    }
  );
});

test("Wallet: sendSponsoredOrDirectTransaction falls back to direct transaction on paymaster failure", async () => {
  const dummyWallet = Wallet.createRandom();
  let directSendCalled = false;

  // Temporarily stub sendDirectFromWallet
  const originalSendDirect = walletLib.sendDirectFromWallet;
    const origEnabled = process.env.ARC_PAYMASTER_ENABLED;
    const origUrl = process.env.ARC_PAYMASTER_RPC_URL;
    const origNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "test";
      process.env.ARC_PAYMASTER_RPC_URL = "http://127.0.0.1:54321/invalid";
      process.env.ARC_PAYMASTER_ENABLED = "true";

      const mockAmount = parseUnits("1", 18);
      const mockTo = "0x3333333333333333333333333333333333333333";
      const mockHash = "0x" + "a".repeat(64);

      // Mock direct signer sendTransaction
      dummyWallet.sendTransaction = async (tx) => {
        directSendCalled = true;
        return { hash: mockHash };
      };

      const result = await walletLib.sendSponsoredOrDirectTransaction(dummyWallet, mockTo, mockAmount);

      assert.ok(result);
      assert.equal(result.txHash, mockHash);
      assert.equal(result.sponsored, false);
      assert.equal(directSendCalled, true);
    } finally {
      process.env.ARC_PAYMASTER_RPC_URL = origUrl;
      process.env.ARC_PAYMASTER_ENABLED = origEnabled;
      if (origNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = origNodeEnv;
      }
    }
});
