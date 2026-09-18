// tests/network_onramp.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { getNetworkConfig, getExplorerUrl, NETWORKS } = require("../src/network");
const { buildCircleOnrampUrl, getOnrampDetails } = require("../src/onramp");

test("Network: resolves mainnet by default", () => {
  const origNetwork = process.env.ARC_NETWORK;
  const origRpc = process.env.ARC_RPC_URL;
  const origChainId = process.env.ARC_CHAIN_ID;

  try {
    delete process.env.ARC_NETWORK;
    delete process.env.ARC_RPC_URL;
    delete process.env.ARC_CHAIN_ID;

    const net = getNetworkConfig();
    assert.equal(net.chainId, 5042);
    assert.equal(net.rpcUrl, "https://rpc.mainnet.arc.io");
    assert.equal(net.explorerUrl, "https://explorer.arc.io");
    assert.equal(net.isTestnet, false);
  } finally {
    if (origNetwork !== undefined) process.env.ARC_NETWORK = origNetwork;
    if (origRpc !== undefined) process.env.ARC_RPC_URL = origRpc;
    if (origChainId !== undefined) process.env.ARC_CHAIN_ID = origChainId;
  }
});

test("Network: resolves testnet when configured", () => {
  const origNetwork = process.env.ARC_NETWORK;
  const origRpc = process.env.ARC_RPC_URL;
  const origChainId = process.env.ARC_CHAIN_ID;

  try {
    process.env.ARC_NETWORK = "testnet";
    delete process.env.ARC_RPC_URL;
    delete process.env.ARC_CHAIN_ID;

    const net = getNetworkConfig();
    assert.equal(net.chainId, 5042002);
    assert.equal(net.rpcUrl, "https://rpc.testnet.arc.network");
    assert.equal(net.explorerUrl, "https://testnet.arcscan.app");
    assert.equal(net.isTestnet, true);
  } finally {
    if (origNetwork !== undefined) process.env.ARC_NETWORK = origNetwork;
    else delete process.env.ARC_NETWORK;
    if (origRpc !== undefined) process.env.ARC_RPC_URL = origRpc;
    if (origChainId !== undefined) process.env.ARC_CHAIN_ID = origChainId;
  }
});

test("Network: getExplorerUrl generates valid links for address and tx", () => {
  const origExplorer = process.env.ARC_EXPLORER_URL;
  try {
    process.env.ARC_EXPLORER_URL = "https://explorer.arc.io";
    const addrUrl = getExplorerUrl("0x1234567890123456789012345678901234567890");
    const txUrl = getExplorerUrl("0xabcdef123456", "tx");

    assert.equal(addrUrl, "https://explorer.arc.io/address/0x1234567890123456789012345678901234567890");
    assert.equal(txUrl, "https://explorer.arc.io/tx/0xabcdef123456");
  } finally {
    if (origExplorer !== undefined) process.env.ARC_EXPLORER_URL = origExplorer;
    else delete process.env.ARC_EXPLORER_URL;
  }
});

test("Onramp: buildCircleOnrampUrl generates pre-filled checkout link", () => {
  const dummyWallet = "0x9876543210987654321098765432109876543210";
  const urlStr = buildCircleOnrampUrl(dummyWallet, { fiatCurrency: "USD", fiatAmount: 100 });
  const parsed = new URL(urlStr);

  assert.equal(parsed.searchParams.get("destinationAddress"), dummyWallet);
  assert.equal(parsed.searchParams.get("destinationAsset"), "USDC");
  assert.equal(parsed.searchParams.get("fiatCurrency"), "USD");
  assert.equal(parsed.searchParams.get("fiatAmount"), "100");
  assert.ok(parsed.searchParams.get("destinationNetwork").includes("arc"));
});

test("Onramp: getOnrampDetails returns complete structured data", () => {
  const dummyWallet = "0x9876543210987654321098765432109876543210";
  const details = getOnrampDetails(dummyWallet);

  assert.equal(details.walletAddress, dummyWallet);
  assert.ok(details.onrampUrl.includes(dummyWallet));
  assert.ok(Array.isArray(details.supportedMethods));
  assert.ok(details.supportedMethods.length > 0);
  assert.ok(details.currencies.includes("USD"));
});
