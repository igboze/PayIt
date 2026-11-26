// Sending dollars out as a chosen NEAR Intents token: the executor must take the intent
// route (Arc -> Base hop -> 1Click) for that token, store the token on the withdrawal so the
// background sweeper delivers the same one, and keep plain USDC sends on the direct CCTP route.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDb = path.join(os.tmpdir(), `intent_token_routing_${process.pid}_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = tmpDb;
process.env.INVOICE_FORWARDING_SECRET = process.env.INVOICE_FORWARDING_SECRET || "intent-routing-test-secret-not-real";

const db = require("../src/db");
const walletLib = require("../src/wallet");
const cctpBridge = require("../src/cctp_bridge");
const executor = require("../agent/executor");

const ETH_ON_BASE = "nep141:base.omft.near";
const calls = [];
const saved = {};

test.before(() => {
  for (const k of ["getNativeBalanceMicro", "sendSponsoredOrDirectTransaction", "encryptSensitiveValue"]) saved[k] = walletLib[k];
  for (const k of ["executeArcToEvmCctpBurn", "executeArcCrossChainWithdrawal", "completeIntentWithdrawal", "completeCctpWithdrawalOnEvm"]) saved[k] = cctpBridge[k];
  walletLib.getNativeBalanceMicro = async () => 10n ** 30n;
  walletLib.sendSponsoredOrDirectTransaction = async () => ({ txHash: "0xfee" });
  walletLib.encryptSensitiveValue = () => "enc";
  let n = 0;
  cctpBridge.executeArcToEvmCctpBurn = async (args) => {
    calls.push({ fn: "evmBurn", args });
    return { success: true, txHash: `0xburn${++n}`, rawCctpMessage: "0x", messageHash: "0x" };
  };
  cctpBridge.executeArcCrossChainWithdrawal = async (args) => {
    calls.push({ fn: "directCctp", args });
    return { success: true, txHash: `0xdirect${++n}`, rawCctpMessage: "0x", messageHash: "0x" };
  };
  cctpBridge.completeIntentWithdrawal = async (args) => {
    calls.push({ fn: "intent", args });
    return { success: true };
  };
  cctpBridge.completeCctpWithdrawalOnEvm = async () => ({ success: true });
});

test.after(() => {
  Object.assign(walletLib, { getNativeBalanceMicro: saved.getNativeBalanceMicro, sendSponsoredOrDirectTransaction: saved.sendSponsoredOrDirectTransaction, encryptSensitiveValue: saved.encryptSensitiveValue });
  Object.assign(cctpBridge, { executeArcToEvmCctpBurn: saved.executeArcToEvmCctpBurn, executeArcCrossChainWithdrawal: saved.executeArcCrossChainWithdrawal, completeIntentWithdrawal: saved.completeIntentWithdrawal, completeCctpWithdrawalOnEvm: saved.completeCctpWithdrawalOnEvm });
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
});

const wallet = { address: "0x1111111111111111111111111111111111111111", privateKey: "0x" + "11".repeat(32) };

test("a chosen token on Base goes through the intent route and is stored for the sweeper", async () => {
  calls.length = 0;
  const res = await executor.executeCrossChainWithdrawal(wallet, {
    destinationChain: "base",
    destinationAddress: "0x2222222222222222222222222222222222222222",
    destinationAsset: ETH_ON_BASE,
    amountUsdc: 20,
    telegramId: 770001,
  });
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.engine, "NEAR_INTENTS");
  assert.equal(calls.some((c) => c.fn === "directCctp"), false, "must not deliver plain USDC via CCTP");
  const burn = calls.find((c) => c.fn === "evmBurn");
  assert.equal(burn.args.destinationRecipientAddress, wallet.address, "hop to the user's own Base address");
  await new Promise((r) => setImmediate(r));
  const intent = calls.find((c) => c.fn === "intent");
  assert.equal(intent.args.destinationAsset, ETH_ON_BASE);
  const row = db.getCrosschainWithdrawalByArcTx ? db.getCrosschainWithdrawalByArcTx(res.txHash) : db.db.prepare("SELECT * FROM crosschain_pending_withdrawals WHERE arc_tx_hash = ?").get(res.txHash);
  assert.equal(row.destination_asset, ETH_ON_BASE);
  assert.equal(row.engine, "NEAR_INTENTS");
});

test("plain USDC to Base still uses the direct CCTP route", async () => {
  calls.length = 0;
  const res = await executor.executeCrossChainWithdrawal(wallet, {
    destinationChain: "base",
    destinationAddress: "0x3333333333333333333333333333333333333333",
    amountUsdc: 15,
    telegramId: 770001,
  });
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.engine, "CCTP");
  assert.ok(calls.some((c) => c.fn === "directCctp"));
  assert.equal(calls.some((c) => c.fn === "intent"), false);
});

test("a non-intents asset string is ignored (no accidental intent route)", async () => {
  calls.length = 0;
  const res = await executor.executeCrossChainWithdrawal(wallet, {
    destinationChain: "base",
    destinationAddress: "0x4444444444444444444444444444444444444444",
    destinationAsset: "USDC",
    amountUsdc: 12,
    telegramId: 770001,
  });
  assert.equal(res.engine, "CCTP");
});
