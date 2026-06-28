// tests/full_e2e_mock.js
// Full end-to-end mock: create user, parse instruction, execute plan with mocked wallet
process.env.USE_MOCK_AI = '1';

const db = require('../src/db');
const walletLib = require('../src/wallet');
const { parsePaymentIntent } = require('../agent/orchestrator');
const { executePlan } = require('../agent/executor');
const { v4: uuidv4 } = require('uuid');

async function run() {
  console.log('--- Full E2E Mock Test');

  // Monkeypatch wallet functions to avoid network calls
  walletLib.sendFromWallet = async (signer, toAddress, amountMicro) => {
    // Return fake tx hash
    return `0xFAKE${Date.now().toString(16).slice(-8)}`;
  };
  walletLib.getNativeBalanceMicro = async (address) => {
    // Return BigInt representing 100 USDC (18 decimals)
    return walletLib.parseToMicro('100');
  };

  // Create test user
  const testId = Math.floor(Math.random() * 900000000) + 100000; // random test id to avoid conflicts
  const pin = '1234';
  const wallet = walletLib.generateUserWallet();
  db.createUserWithWallet(testId, 'testuser', wallet.address, wallet.privateKey, pin);
  const user = db.getUser(testId);
  console.log('Created test user:', { telegram_id: user.telegram_id, address: user.deposit_address });

  // Parse a payment instruction via orchestrator (mock AI)
  const instruction = 'Send $12 to 0xabc0000000000000000000000000000000000000';
  console.log('Instruction:', instruction);
  const plan = await parsePaymentIntent(instruction, { balance: '100', address: user.deposit_address });
  console.log('Parsed plan:', JSON.stringify(plan, null, 2));

  // Execute plan
  console.log('Executing plan...');
  const results = await executePlan(plan, pin, user, 'personal');
  console.log('Results:', JSON.stringify(results, null, 2));
}

run().catch(err => { console.error(err); process.exit(1); });
