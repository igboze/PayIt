const test = require('node:test');
const assert = require('node:assert/strict');
const { safeAnswerCbQuery } = require('../src/telegram_utils');

test('safeAnswerCbQuery resolves when callback answer succeeds', async () => {
  const ctx = {
    answerCbQuery: async () => 'ok',
  };

  const result = await safeAnswerCbQuery(ctx, 'done');
  assert.equal(result, 'ok');
});

test('safeAnswerCbQuery ignores stale callback queries', async () => {
  const ctx = {
    answerCbQuery: async () => {
      const err = new Error('query is too old');
      err.code = 400;
      throw err;
    },
  };

  const result = await safeAnswerCbQuery(ctx, 'done');
  assert.equal(result, null);
});
