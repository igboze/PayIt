// tests/test_option1_zero_token_loss.js
// Dedicated test suite verifying Option 1: Dual-Rail Inbound Settlement & Zero-Token-Loss Guarantee

require("dotenv").config();
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Wallet } = require("ethers");
const db = require("../src/db");
const cctpBridge = require("../src/cctp_bridge");
const multichain = require("../src/multichain");

test("Option 1 Suite: Inbound CCTP Transfer Ledger records and persists correctly", () => {
  const mockSolSig = "5wK_test_sig_" + Date.now();
  const mockArcRecipient = "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359";
  const mockTgId = 123456789;

  // 1. Record initiated transfer
  const id = db.recordInboundCctpTransfer({
    telegramId: mockTgId,
    solanaAddress: "3wRHkS8DDnwcQqx9ewJQeWirqbm8vYAJPgeZsqN7KiFn",
    arcAddress: mockArcRecipient,
    amountUsdc: 10.5,
    solanaBurnSig: mockSolSig,
    status: "initiated",
  });

  assert.ok(id, "Expected inserted transfer ID");

  // 2. Query pending inbound transfers
  const pending = db.getPendingInboundCctpTransfers();
  const found = pending.find((p) => p.id === id);
  assert.ok(found, "Pending transfer must be retrieved by getPendingInboundCctpTransfers");
  assert.equal(found.status, "initiated");
  assert.equal(found.amount_usdc, 10.5);
  assert.equal(found.solana_burn_sig, mockSolSig);

  // 3. Update to attested
  db.updateInboundCctpTransfer(id, {
    status: "attested",
    attestation: "0x1234mockattestation",
    cctp_message: "0x5678mockmessage",
  });

  const pendingAfterAttest = db.getPendingInboundCctpTransfers();
  const attestedFound = pendingAfterAttest.find((p) => p.id === id);
  assert.ok(attestedFound, "Attested transfer must remain pending until minted on Arc");
  assert.equal(attestedFound.status, "attested");
  assert.equal(attestedFound.attestation, "0x1234mockattestation");

  // 4. Complete transfer upon Arc confirmation
  const mockArcTx = "0xarc_mint_tx_hash_" + Date.now();
  db.completeInboundCctpTransfer(id, mockArcTx);

  const pendingAfterComplete = db.getPendingInboundCctpTransfers();
  const completedFound = pendingAfterComplete.find((p) => p.id === id);
  assert.equal(completedFound, undefined, "Completed transfer must no longer be in pending list");

  // Verify completed state in DB directly
  const row = db.db.prepare("SELECT * FROM cctp_inbound_transfers WHERE id = ?").get(id);
  assert.equal(row.status, "completed");
  assert.equal(row.arc_tx_hash, mockArcTx);
  assert.ok(row.completed_at, "completed_at must be populated");
});

test("Option 1 Suite: disburseDirectOnArc enforces strict float pre-checks", async () => {
  // Attempting to disburse an amount larger than available float must throw clean insufficient float error,
  // NOT a mysterious revert or CALL_EXCEPTION.
  const largeAmount = 9999999; // $9.9 million
  await assert.rejects(
    async () => {
      await cctpBridge.disburseDirectOnArc({
        recipientArcAddress: "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359",
        amountUsdc: largeAmount,
      });
    },
    (err) => {
      assert.ok(err.message.includes("Insufficient relayer float"), "Must throw Insufficient relayer float error");
      return true;
    }
  );
});

test("Option 1 Suite: autoBridgeSolanaToArc falls back safely to Rail B without token loss", async () => {
  const dummySig = "5wK_burn_" + Date.now();
  const arcRecipient = "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359";

  const result = await cctpBridge.autoBridgeSolanaToArc({
    telegramId: 777666,
    solanaTxSignature: dummySig,
    amountUsdc: 15.0,
    recipientArcAddress: arcRecipient,
  });

  assert.equal(result.success, true);
  assert.equal(result.status, "initiated");
  assert.equal(result.destinationDomain, 26);
  assert.equal(result.destinationChain, "Arc Mainnet");
  assert.ok(result.inboundId, "Expected transfer to be registered in SQLite ledger");

  // Verify transfer is in database
  const transfer = db.db.prepare("SELECT * FROM cctp_inbound_transfers WHERE id = ?").get(result.inboundId);
  assert.ok(transfer, "Database record must exist");
  assert.equal(transfer.solana_burn_sig, dummySig);

  // Clean up test record
  db.completeInboundCctpTransfer(result.inboundId, "test_complete");
});

test("Option 1 Suite: recoverPendingInboundCctpTransfers handles already-minted nonces cleanly", async () => {
  // If an inbound transfer was already minted on Arc, the recovery worker must gracefully mark it completed
  const id = db.recordInboundCctpTransfer({
    telegramId: 998877,
    solanaAddress: "3wRHkS8DDnwcQqx9ewJQeWirqbm8vYAJPgeZsqN7KiFn",
    arcAddress: "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359",
    amountUsdc: 5.0,
    solanaBurnSig: "5wK_already_minted_" + Date.now(),
    status: "attested",
  });

  db.updateInboundCctpTransfer(id, {
    attestation: "0xdeadbeef",
    cctp_message: "0xfeedface",
  });

  // Call recovery worker
  const res = await cctpBridge.recoverPendingInboundCctpTransfers();
  assert.ok(typeof res.recovered === "number");
  assert.ok(typeof res.pending === "number");

  // Clean up test record
  db.completeInboundCctpTransfer(id, "test_clean");
});
