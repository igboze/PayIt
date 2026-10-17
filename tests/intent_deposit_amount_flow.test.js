const test = require("node:test");
const assert = require("node:assert");
const convState = require("../src/conversation_state");
const nearLib = require("../src/near");
const flowsMultichain = require("../src/flows_multichain");

test("Intent Deposit Amount Flow Suite", async (t) => {
  const userId = 77665544;

  await t.test("near_dep_token sets await_near_amount with token info", async () => {
    convState.clearState(userId);
    const tokenInfo = await nearLib.resolveNearToken("NEAR");
    assert.ok(tokenInfo, "NEAR token resolved");

    convState.setState(
      userId,
      "await_near_amount",
      {
        originAsset: tokenInfo.assetId,
        originSymbol: "NEAR",
        originDecimals: tokenInfo.decimals,
        minDeposit: tokenInfo.minDeposit || 0.5,
      },
      "personal"
    );

    const st = convState.getState(userId);
    assert.strictEqual(st.type, "await_near_amount");
    assert.strictEqual(st.data.originSymbol, "NEAR");
    assert.strictEqual(st.data.originDecimals, 24);
    assert.ok(flowsMultichain.handlesState(st.type), "flowsMultichain must handle await_near_amount");
  });

  await t.test("starknet_dep_token sets await_starknet_amount with token info", async () => {
    convState.clearState(userId);
    const tokenInfo = await nearLib.resolveStarknetToken("STRK");
    assert.ok(tokenInfo, "STRK token resolved");

    convState.setState(
      userId,
      "await_starknet_amount",
      {
        originAsset: tokenInfo.assetId,
        originSymbol: "STRK",
        originDecimals: tokenInfo.decimals,
        minDeposit: tokenInfo.minDeposit || 1,
      },
      "personal"
    );

    const st = convState.getState(userId);
    assert.strictEqual(st.type, "await_starknet_amount");
    assert.strictEqual(st.data.originSymbol, "STRK");
    assert.ok(flowsMultichain.handlesState(st.type), "flowsMultichain must handle await_starknet_amount");
  });

  await t.test("solana_dep_token sets await_solana_amount with token info", async () => {
    convState.clearState(userId);
    const tokenInfo = await nearLib.resolveSolanaToken("SOL");
    assert.ok(tokenInfo, "SOL token resolved");

    convState.setState(
      userId,
      "await_solana_amount",
      {
        originAsset: tokenInfo.assetId,
        originSymbol: "SOL",
        originDecimals: tokenInfo.decimals,
        minDeposit: tokenInfo.minDeposit || 0.02,
      },
      "personal"
    );

    const st = convState.getState(userId);
    assert.strictEqual(st.type, "await_solana_amount");
    assert.strictEqual(st.data.originSymbol, "SOL");
    assert.ok(flowsMultichain.handlesState(st.type), "flowsMultichain must handle await_solana_amount");
  });

  await t.test("hood_dep_token sets await_robinhood_amount with token info", async () => {
    convState.clearState(userId);
    const tokenInfo = await nearLib.resolveRobinhoodToken("USDG");
    assert.ok(tokenInfo, "USDG token resolved");

    convState.setState(
      userId,
      "await_robinhood_amount",
      {
        originAsset: tokenInfo.assetId,
        originSymbol: "USDG",
        originDecimals: tokenInfo.decimals,
        minDeposit: tokenInfo.minDeposit || 1,
      },
      "personal"
    );

    const st = convState.getState(userId);
    assert.strictEqual(st.type, "await_robinhood_amount");
    assert.strictEqual(st.data.originSymbol, "USDG");
    assert.ok(flowsMultichain.handlesState(st.type), "flowsMultichain must handle await_robinhood_amount");
  });

  convState.clearState(userId);
});
