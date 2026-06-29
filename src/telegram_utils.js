async function safeAnswerCbQuery(ctx, text) {
  if (!ctx || typeof ctx.answerCbQuery !== 'function') return null;
  try {
    return await ctx.answerCbQuery(text);
  } catch (err) {
    const message = err?.message || '';
    const code = err?.code || err?.response?.error_code;
    if (code === 400 || /query is too old|timeout expired|invalid/i.test(message)) {
      return null;
    }
    throw err;
  }
}

module.exports = {
  safeAnswerCbQuery,
};
