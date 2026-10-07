// tests/in_chat_buttons_and_guidance.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("In-Chat Buttons: bot.js includes quick action buttons for Cash Out and Yields", () => {
  const botContent = fs.readFileSync(path.join(__dirname, "../bot.js"), "utf8");

  // Verify withdraw / cashout keyboard
  assert.ok(botContent.includes('Markup.button.callback("$10", "cashout_amt_10")'), "Must include $10 cashout button");
  assert.ok(botContent.includes('Markup.button.callback("$25", "cashout_amt_25")'), "Must include $25 cashout button");
  assert.ok(botContent.includes('Markup.button.callback("$50", "cashout_amt_50")'), "Must include $50 cashout button");
  assert.ok(botContent.includes('Markup.button.callback("💰 All / Max", "cashout_amt_max")'), "Must include Max cashout button");

  // Verify yield deposit buttons
  assert.ok(botContent.includes('Markup.button.callback("$5", "yield_amt_5")'), "Must include $5 yield deposit button");
  assert.ok(botContent.includes('Markup.button.callback("$10", "yield_amt_10")'), "Must include $10 yield deposit button");
  assert.ok(botContent.includes('Markup.button.callback("$25", "yield_amt_25")'), "Must include $25 yield deposit button");
  assert.ok(botContent.includes('yield_amt_max'), "Must include Max yield deposit button");

  // Verify sendout buttons
  assert.ok(botContent.includes('sendout_amt_5'), "Must include sendout amount buttons");
  assert.ok(botContent.includes('sendout_amt_max'), "Must include sendout max button");

  // Verify Paj onramp buttons
  assert.ok(botContent.includes('onramp_amt_10000'), "Must include onramp quick amount button");
  assert.ok(botContent.includes('onramp_amt_25000'), "Must include onramp quick amount button");
});

test("In-Chat Guidance: bot.js provides explicit chat prompt examples", () => {
  const botContent = fs.readFileSync(path.join(__dirname, "../bot.js"), "utf8");

  // Cash out bank example
  assert.ok(botContent.includes("GTBank · 0123456789"), "Must include bank detail example");

  // PIN example
  assert.ok(botContent.includes("💬 <i>Send your 4-digit PIN into the chat (e.g. 1234)"), "Must include 4-digit PIN sample guidance");

  // Business onboarding skips and terms
  assert.ok(botContent.includes("onboard_skip_email"), "Must include email skip button");
  assert.ok(botContent.includes("onboard_skip_phone"), "Must include phone skip button");
  assert.ok(botContent.includes("biz_terms_14"), "Must include 14 days default term button");
});

test("In-Chat Buttons: flows_multichain.js includes quick amount buttons for Move Funds", () => {
  const mcContent = fs.readFileSync(path.join(__dirname, "../src/flows_multichain.js"), "utf8");

  assert.ok(mcContent.includes('move_amt_5'), "Must include move amount button");
  assert.ok(mcContent.includes('move_amt_10'), "Must include move amount button");
  assert.ok(mcContent.includes('move_amt_25'), "Must include move amount button");
  assert.ok(mcContent.includes('move_amt_max'), "Must include move amount max button");
  assert.ok(mcContent.includes("💬 <i>Send your 4-digit PIN into the chat (e.g. 1234) to confirm:</i>"), "Must include move funds PIN guidance");
});
