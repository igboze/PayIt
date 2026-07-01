const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFilePaymentPlan } = require('../agent/file_parser');

// Use mock AI mode for deterministic plan generation in tests.
process.env.USE_MOCK_AI = '1';

test('buildFilePaymentPlan creates a monthly salary schedule from spreadsheet rows and caption', async () => {
  const rows = [
    { name: 'Ada', wallet_address: null, bank_name: 'GTBank', account_number: '0123456789', account_name: 'Ada', amount: '500', currency: 'USDC', description: 'Salary' },
    { name: 'Chinedu', wallet_address: null, bank_name: 'Access Bank', account_number: '0987654321', account_name: 'Chinedu', amount: '650', currency: 'USDC', description: 'Salary' },
  ];
  const caption = 'Pay salaries every 30th of the month.';

  const plan = await buildFilePaymentPlan(rows, caption, { balance: '2000', address: '0xabc' });

  assert.equal(plan.type, 'scheduled');
  assert.equal(plan.schedule.frequency, 'monthly');
  assert.equal(plan.schedule.day, '30');
  assert.equal(plan.payments.length, 2);
  assert.equal(plan.payments[0].to, '__offramp__');
  assert.equal(plan.payments[0].account_number, '0123456789');
  assert.equal(plan.payments[1].account_number, '0987654321');
  assert.equal(plan.payments[0].amount, 500);
  assert.equal(plan.payments[1].amount, 650);
  assert.ok(plan.summary.includes('every 30th of the month'));
});

test('buildFilePaymentPlan falls back to a local weekly plan when AI is unavailable', async () => {
  delete process.env.USE_MOCK_AI;
  const rows = [
    { name: 'Mina', wallet_address: '0xabc', amount: '120', currency: 'USDC', description: 'Support' },
  ];

  const plan = await buildFilePaymentPlan(rows, 'Pay Mina every Friday at 10:00.', { balance: '1000' });

  assert.equal(plan.type, 'scheduled');
  assert.equal(plan.schedule.frequency, 'weekly');
  assert.equal(plan.schedule.day, 'Friday');
  assert.equal(plan.schedule.time, '10:00');
  assert.equal(plan.payments[0].to, '0xabc');
  assert.equal(plan.payments[0].amount, 120);
  assert.ok(plan.summary.includes('Friday'));
});
