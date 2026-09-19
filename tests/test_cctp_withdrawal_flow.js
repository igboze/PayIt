// tests/test_cctp_withdrawal_flow.js
// End-to-end verification and diagnostic test for Arc→Solana CCTP withdrawal pipeline

require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const bs58 = require("bs58");
const { Keypair, PublicKey, Connection } = require("@solana/web3.js");
const { JsonRpcProvider, Contract } = require("ethers");
const multichain = require("../src/multichain");
const cctpBridge = require("../src/cctp_bridge");
const { getNetworkConfig } = require("../src/network");

const bs58Decode = bs58.default ? bs58.default.decode : bs58.decode;

test("CCTP Withdrawal Suite: Fee Payer Key & Solana Configuration", async (t) => {
  const feePayerKey = process.env.SOLANA_FEE_PAYER_KEY;
  assert.ok(feePayerKey, "SOLANA_FEE_PAYER_KEY must be defined in environment");

  const secretBytes = bs58Decode(feePayerKey);
  assert.equal(secretBytes.length, 64, "Fee payer secret key must be 64 bytes");

  const keypair = Keypair.fromSecretKey(secretBytes);
  const expectedAddress = "5ba1CAazPrdYYcaTYyzTqMExgCadu2aFauW24r28dh5g";
  assert.equal(keypair.publicKey.toBase58(), expectedAddress, "Fee payer address must match expected public address");

  const conn = multichain.getSolanaConnection();
  const balance = await conn.getBalance(keypair.publicKey);
  assert.ok(balance > 0, `Fee payer wallet has ${balance / 1e9} SOL (expected > 0 SOL)`);
  console.log(`[CCTP Test] Fee payer: ${keypair.publicKey.toBase58()} | Balance: ${balance / 1e9} SOL`);
});

test("CCTP Withdrawal Suite: Arc Mainnet CCTP V2 Setup", async (t) => {
  const net = getNetworkConfig();
  const provider = new JsonRpcProvider(net.rpcUrl);

  const tmAddress = cctpBridge.ARC_CCTP_CONTRACTS.TOKEN_MESSENGER;
  const mtAddress = cctpBridge.ARC_CCTP_CONTRACTS.MESSAGE_TRANSMITTER;
  const usdcAddress = net.usdcAddress || "0x3600000000000000000000000000000000000000";

  // Check contract code exists
  const tmCode = await provider.getCode(tmAddress);
  const mtCode = await provider.getCode(mtAddress);
  const usdcCode = await provider.getCode(usdcAddress);

  assert.ok(tmCode.length > 2, "TokenMessenger contract must be deployed on Arc");
  assert.ok(mtCode.length > 2, "MessageTransmitter contract must be deployed on Arc");
  assert.ok(usdcCode.length > 2, "USDC precompile contract must be deployed on Arc");

  // Check USDC decimals is 6
  const usdcContract = new Contract(usdcAddress, ["function decimals() view returns (uint8)"], provider);
  const decimals = await usdcContract.decimals();
  assert.equal(Number(decimals), 6, "Arc USDC contract decimals must be 6");

  // Check remote messenger for Solana (Domain 5)
  const tmContract = new Contract(tmAddress, ["function remoteTokenMessengers(uint32) view returns (bytes32)"], provider);
  const remoteSol = await tmContract.remoteTokenMessengers(5);
  const solMessengerBase58 = (bs58.default || bs58).encode(Buffer.from(remoteSol.slice(2), "hex"));
  assert.equal(solMessengerBase58, "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe", "Arc TokenMessenger must point to Solana TokenMessengerMinterV2");
});

test("CCTP Withdrawal Suite: Solana Mainnet CCTP V2 Verification", async (t) => {
  const conn = multichain.getSolanaConnection();
  const TM_V2 = new PublicKey("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
  const MT_V2 = new PublicKey("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");

  // Check programs exist
  const tmInfo = await conn.getAccountInfo(TM_V2);
  const mtInfo = await conn.getAccountInfo(MT_V2);
  assert.ok(tmInfo?.executable, "TokenMessengerMinterV2 must be executable on Solana");
  assert.ok(mtInfo?.executable, "MessageTransmitterV2 must be executable on Solana");

  // Check remote token messenger for Arc (domain 26)
  const [remoteTmPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("remote_token_messenger"), Buffer.from("26", "utf8")],
    TM_V2
  );
  const remoteTmInfo = await conn.getAccountInfo(remoteTmPda);
  assert.ok(remoteTmInfo !== null, "RemoteTokenMessenger for domain 26 (Arc) must exist on Solana");

  // Check token pair for Arc USDC
  const arcUsdc32 = Buffer.concat([Buffer.alloc(12, 0), Buffer.from("3600000000000000000000000000000000000000", "hex")]);
  const [tokenPairPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_pair"), Buffer.from("26", "utf8"), arcUsdc32],
    TM_V2
  );
  const tokenPairInfo = await conn.getAccountInfo(tokenPairPda);
  assert.ok(tokenPairInfo !== null, "TokenPair for Arc USDC must exist on Solana");
});

test("CCTP Withdrawal Suite: CCTP V2 Message Parsing & Nonce PDA", () => {
  // Construct dummy 228-byte CCTP V2 message
  const msgBuf = Buffer.alloc(228);
  msgBuf.writeUInt32BE(0, 0);   // version
  msgBuf.writeUInt32BE(26, 4);  // source domain = Arc (26)
  msgBuf.writeUInt32BE(5, 8);   // destination domain = Solana (5)
  msgBuf.writeBigUInt64BE(123456789n, 12); // nonce

  // 32-byte sender (Arc TokenMessenger)
  Buffer.from("28b5a0e9C621a5BadaA536219b3a228C8168cf5d", "hex").copy(msgBuf, 32);

  // messageBody at offset 116
  msgBuf.writeUInt32BE(0, 116); // body version

  // burnToken at offset 120 (32 bytes)
  const arcUsdc32 = Buffer.concat([Buffer.alloc(12, 0), Buffer.from("3600000000000000000000000000000000000000", "hex")]);
  arcUsdc32.copy(msgBuf, 120);

  // mintRecipient at offset 152 (32 bytes Solana recipient)
  const dummyRecipient = Keypair.generate().publicKey;
  dummyRecipient.toBuffer().copy(msgBuf, 152);

  const parsed = multichain.parseCctpMessage(msgBuf.toString("hex"));
  assert.equal(parsed.sourceDomain, 26, "Source domain must be 26");
  assert.equal(parsed.nonce, 123456789n, "Nonce must match");
  assert.deepEqual(parsed.burnToken, arcUsdc32, "Burn token must match Arc USDC");
  assert.deepEqual(parsed.mintRecipient, dummyRecipient.toBuffer(), "Mint recipient must match Solana pubkey");

  // Derive used_nonce PDA
  const noncePda = multichain.getUsedNoncePda(parsed.nonceBytes);
  assert.ok(noncePda instanceof PublicKey, "used_nonce PDA must be a valid Solana PublicKey");
});
