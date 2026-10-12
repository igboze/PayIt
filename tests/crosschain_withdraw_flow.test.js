const test = require("node:test");
const assert = require("node:assert/strict");

const { shouldReprocessConversationState } = require("../src/conversation_flow");
const {
  validateAddressForChain,
  handleMultichainState,
  registerMultichainFlows,
  CCW_CHAINS,
} = require("../src/flows_multichain");
const convState = require("../src/conversation_state");
const walletLib = require("../src/wallet");

test("validateAddressForChain correctly validates NEAR addresses", () => {
  // Valid named accounts
  assert.equal(validateAddressForChain("near", "nackam.near"), true);
  assert.equal(validateAddressForChain("near", "alice.near"), true);
  assert.equal(validateAddressForChain("near", "NACKAM.NEAR"), true); // Case-insensitive
  assert.equal(validateAddressForChain("near", "Sub.Alice.near"), true);
  assert.equal(validateAddressForChain("near", "wallet.tg"), true); // TG named accounts

  // Valid 64-char implicit accounts
  const implicitNear = "a".repeat(64);
  assert.equal(validateAddressForChain("near", implicitNear), true);

  // Invalid accounts
  assert.equal(validateAddressForChain("near", ""), false);
  assert.equal(validateAddressForChain("near", "not an address"), false);
  assert.equal(validateAddressForChain("near", "invalid$name.near"), false);
});

test("validateAddressForChain validates other destination chains", () => {
  assert.equal(validateAddressForChain("solana", "So11111111111111111111111111111111111111112"), true);
  assert.equal(validateAddressForChain("base", "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"), true);
  assert.equal(validateAddressForChain("bitcoin", "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"), true);
  assert.equal(validateAddressForChain("tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"), true);
  assert.equal(validateAddressForChain("base", "invalid_evm"), false);
});

test("shouldReprocessConversationState handles cross-chain withdrawal states", () => {
  // Address entry: casual text or slash commands should reprocess, actual addresses should NOT
  assert.equal(shouldReprocessConversationState("await_ccw_address", "nackam.near"), false);
  assert.equal(shouldReprocessConversationState("await_ccw_address", "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"), false);
  assert.equal(shouldReprocessConversationState("await_ccw_address", "hello there"), true);
  assert.equal(shouldReprocessConversationState("await_ccw_address", "/menu"), true);

  // Amount entry: valid amounts should NOT reprocess, casual text should
  assert.equal(shouldReprocessConversationState("await_ccw_amount", "10"), false);
  assert.equal(shouldReprocessConversationState("await_ccw_amount", "$25.50"), false);
  assert.equal(shouldReprocessConversationState("await_ccw_amount", "hey bot"), true);
});

test("handleMultichainState: entering NEAR address responds and advances state to await_ccw_amount", async () => {
  convState.initStateTable();

  const originalGetNativeBalance = walletLib.getNativeBalanceMicro;
  walletLib.getNativeBalanceMicro = async () => walletLib.parseToMicro("100");

  try {
    const testUserId = 987654321;
    convState.clearState(testUserId);

    let repliedMessage = "";
    let repliedOptions = null;

    const mockCtx = {
      reply: async (msg, opts) => {
        repliedMessage = msg;
        repliedOptions = opts;
        return true;
      },
    };

    const mockBot = {
      action: () => {},
      handleUpdate: () => {},
    };

    registerMultichainFlows(mockBot, {
      requireUser: () => ({ telegram_id: testUserId }),
      getContext: () => "personal",
      getActiveWallet: () => "0x1111111111111111111111111111111111111111",
      getOrDeriveSolanaAddress: () => "So11111111111111111111111111111111111111112",
      deleteSensitiveMessage: async () => {},
      backToMenu: {},
    });

    const state = {
      type: "await_ccw_address",
      data: {
        destinationChain: "near",
        chainInfo: CCW_CHAINS.near,
      },
      context: "personal",
    };

    await handleMultichainState(mockBot, mockCtx, state, "nackam.near", testUserId);

    // Verify response was sent
    assert.match(repliedMessage, /Withdraw to Ⓝ NEAR/);
    assert.match(repliedMessage, /nackam\.near/);
    assert.match(repliedMessage, /How much USD would you like to withdraw\?/);

    // Verify conversation state was updated to await_ccw_amount
    const nextState = convState.getState(testUserId);
    assert.ok(nextState);
    assert.equal(nextState.type, "await_ccw_amount");
    assert.equal(nextState.data.destinationAddress, "nackam.near");
    assert.equal(nextState.data.destinationChain, "near");

    // Step 2: User provides amount (e.g. 10)
    await handleMultichainState(mockBot, mockCtx, nextState, "10", testUserId);

    assert.match(repliedMessage, /Confirm Cross-Chain Withdrawal/);
    assert.match(repliedMessage, /10\.00 USDC/);
    assert.match(repliedMessage, /Enter your 4-digit PIN to confirm/);

    const confirmState = convState.getState(testUserId);
    assert.ok(confirmState);
    assert.equal(confirmState.type, "confirm_ccw");
    assert.equal(confirmState.data.amountUsdc, 10);
    assert.equal(confirmState.data.destinationAddress, "nackam.near");

    convState.clearState(testUserId);
  } finally {
    walletLib.getNativeBalanceMicro = originalGetNativeBalance;
  }
});

test("registerCrossChainWithdrawActions: quick amount button advances to confirm_ccw", async () => {
  convState.initStateTable();

  const originalGetNativeBalance = walletLib.getNativeBalanceMicro;
  walletLib.getNativeBalanceMicro = async () => walletLib.parseToMicro("100");

  try {
    const testUserId = 987654322;
    convState.clearState(testUserId);

    let registeredActions = new Map();
    const mockBot = {
      action: (regex, handler) => {
        registeredActions.set(regex.toString(), handler);
      },
      handleUpdate: () => {},
    };

    registerMultichainFlows(mockBot, {
      requireUser: () => ({ telegram_id: testUserId }),
      getContext: () => "personal",
      getActiveWallet: () => "0x1111111111111111111111111111111111111111",
      getOrDeriveSolanaAddress: () => "So11111111111111111111111111111111111111112",
      deleteSensitiveMessage: async () => {},
      backToMenu: {},
    });

    // Put user into await_ccw_amount
    convState.setState(
      testUserId,
      "await_ccw_amount",
      {
        destinationChain: "near",
        chainInfo: CCW_CHAINS.near,
        destinationAddress: "nackam.near",
      },
      "personal"
    );

    let repliedMessage = "";
    const mockCtx = {
      from: { id: testUserId },
      match: ["action_ccw_amt_25", "25"],
      answerCbQuery: () => {},
      reply: async (msg) => {
        repliedMessage = msg;
        return true;
      },
    };

    const amtHandler = [...registeredActions.entries()].find(([k]) => k.includes("action_ccw_amt"))[1];
    await amtHandler(mockCtx);

    assert.match(repliedMessage, /Confirm Cross-Chain Withdrawal/);
    assert.match(repliedMessage, /25\.00 USDC/);

    const confirmState = convState.getState(testUserId);
    assert.ok(confirmState);
    assert.equal(confirmState.type, "confirm_ccw");
    assert.equal(confirmState.data.amountUsdc, 25);

    convState.clearState(testUserId);
  } finally {
    walletLib.getNativeBalanceMicro = originalGetNativeBalance;
  }
});

test("executeCrossChainWithdrawal: passes netAmountUsdc to intent burn and collects fee only after burn", async () => {
  const executor = require("../agent/executor");
  const cctpBridge = require("../src/cctp_bridge");

  const originalGetNativeBalance = walletLib.getNativeBalanceMicro;
  const originalSendSponsored = walletLib.sendSponsoredOrDirectTransaction;
  const originalBurn = cctpBridge.executeArcToEvmCctpBurn;

  let feeCollected = false;
  let feeCollectedAmount = null;
  let burnedAmount = null;
  let burnSucceeded = true;

  walletLib.getNativeBalanceMicro = async () => walletLib.parseToMicro("50");
  walletLib.sendSponsoredOrDirectTransaction = async (wallet, recipient, micro) => {
    feeCollected = true;
    feeCollectedAmount = micro;
    return { txHash: "0xfeefee", sponsored: false };
  };

  cctpBridge.executeArcToEvmCctpBurn = async ({ amountUsdc }) => {
    burnedAmount = amountUsdc;
    // Check that fee has NOT been collected before burn is initiated
    assert.equal(feeCollected, false, "Fee must NOT be collected before the burn completes");
    if (!burnSucceeded) {
      return { success: false, error: "Simulation burn failure" };
    }
    return { success: true, txHash: "0xburn123" };
  };

  try {
    const dummyWallet = { address: "0x1111111111111111111111111111111111111111" };

    // Case 1: Successful Intent withdrawal (e.g. $10 to NEAR)
    // Fee is $0.30 flat, so netAmountUsdc is $9.70
    const res = await executor.executeCrossChainWithdrawal(dummyWallet, {
      destinationChain: "near",
      destinationAddress: "nackam.near",
      amountUsdc: 10,
      telegramId: 12345,
    });

    assert.equal(res.success, true);
    assert.equal(burnedAmount, 9.70, "Burn amount must be net of platform fee (10 - 0.30 = 9.70)");
    assert.equal(feeCollected, true, "Fee should be collected after successful burn");
    assert.equal(feeCollectedAmount, walletLib.parseToMicro("0.30"));

    // Case 2: Failed burn must NOT collect platform fee
    feeCollected = false;
    burnedAmount = null;
    burnSucceeded = false;

    const failRes = await executor.executeCrossChainWithdrawal(dummyWallet, {
      destinationChain: "near",
      destinationAddress: "nackam.near",
      amountUsdc: 15,
      telegramId: 54321,
    });

    assert.equal(failRes.success, false);
    assert.equal(feeCollected, false, "Fee must NOT be collected if burn failed");
  } finally {
    walletLib.getNativeBalanceMicro = originalGetNativeBalance;
    walletLib.sendSponsoredOrDirectTransaction = originalSendSponsored;
    cctpBridge.executeArcToEvmCctpBurn = originalBurn;
  }
});


