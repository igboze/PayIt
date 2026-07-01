const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyIntent } = require('../agent/intent_router');
const { shouldReprocessConversationState } = require('../src/conversation_flow');

test('generic chat is not treated as a cashout request', async () => {
  const result = await classifyIntent('hello there, how are you?', 123, {});
  assert.equal(result.intent, 'unknown');
  assert.equal(result.confidence, 'low');
});

test('cash out requests still classify as offramp', async () => {
  const result = await classifyIntent('cash out $100 to my GTBank account', 123, {});
  assert.equal(result.intent, 'offramp');
});

test('withdraw flow should re-enter the main router for casual chat', () => {
  assert.equal(shouldReprocessConversationState('await_withdraw_amount', 'hello there'), true);
  assert.equal(shouldReprocessConversationState('await_withdraw_amount', '$50'), false);
  assert.equal(shouldReprocessConversationState('await_withdraw_bank', 'hello there'), true);
});
