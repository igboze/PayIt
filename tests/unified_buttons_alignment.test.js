// tests/unified_buttons_alignment.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const flowsMultichain = require("../src/flows_multichain");
const { isLikelyNewIntent } = require("../src/conversation_flow");

test("Fixed Bottom Keyboards: Unified Send and Cashout removal", () => {
  const botCode = fs.readFileSync(path.join(__dirname, "../bot.js"), "utf8");

  // Check personal keyboard has Send Money and no redundant Cashout
  const personalKeyboardMatch = botCode.match(/function mainMenu\(context\) \{([\s\S]*?)\n\}/);
  assert.ok(personalKeyboardMatch, "mainMenu function should exist in bot.js");
  const menuCode = personalKeyboardMatch[1];

  // Must have 📤 Send Money in personal and business
  assert.ok(menuCode.includes('"📤 Send Money"'), "Must include '📤 Send Money' on main menus");

  // Must not have standalone Cash Out / Withdraw on the main menu rows (unified into Send Money)
  assert.ok(!menuCode.includes('"💵 Cash Out / Withdraw"'), "Must not have separate Cash Out / Withdraw button on mainMenu");
});

test("In-Chat Balance Cards: Symmetrical Add and Send buttons", () => {
  const botCode = fs.readFileSync(path.join(__dirname, "../bot.js"), "utf8");

  // showBalance in-chat buttons
  assert.ok(botCode.includes('btnPrimary("📤 Send Money",        "action_send_menu")'), "showBalance must have aligned 📤 Send Money button");
  assert.ok(botCode.includes('btnSuccess("📥 Add Money",         "action_receive")'), "showBalance must have 📥 Add Money button");

  // showBizBalance in-chat buttons
  assert.ok(botCode.includes('btnPrimary("📤 Send Money",    "action_send_menu")'), "showBizBalance must have aligned 📤 Send Money button");
  assert.ok(botCode.includes('btnSuccess("📥 Add Money",     "action_receive")'), "showBizBalance must have 📥 Add Money button");
  assert.ok(botCode.includes('btnPrimary("👥 Pay Team",      "action_pay_team")'), "showBizBalance must have 👥 Pay Team button");
});

test("Unified Send & Withdraw Menu: Includes all rails", () => {
  const botCode = fs.readFileSync(path.join(__dirname, "../bot.js"), "utf8");

  assert.ok(botCode.includes('async function showSendMoneyMenu(ctx)'), "showSendMoneyMenu must be defined");
  assert.ok(botCode.includes('"action_withdraw_menu"'), "Must include Bank Transfer (Naira cash-out)");
  assert.ok(botCode.includes('"action_crosschain_withdraw"'), "Must include Multi-chain crypto withdraw");
  assert.ok(botCode.includes('"action_sendout_menu"'), "Must include 0x wallet transfer");
  assert.ok(botCode.includes('"action_send_contact"'), "Must include saved contacts transfer");

  // action_unified_withdraw and action_send_menu both route to showSendMoneyMenu
  assert.ok(botCode.includes('bot.action("action_send_menu", async (ctx) => {'), "action_send_menu must be wired");
  assert.ok(botCode.includes('bot.action("action_unified_withdraw", async (ctx) => {'), "action_unified_withdraw must be wired");
});

test("Fixed Button Responsiveness & State Clearing", () => {
  const botCode = fs.readFileSync(path.join(__dirname, "../bot.js"), "utf8");

  // Navigation interceptor before state
  assert.ok(botCode.includes("Fixed Menu Button & Navigation Interceptor"), "Must have navigation interceptor in bot.on('text')");
  assert.ok(botCode.includes("cleanNav"), "Must normalize and strip leading emojis for button matches");
  assert.ok(botCode.includes("showSendMoneyMenu(ctx)"), "Must route Send/Cashout to showSendMoneyMenu");

  // flowsMultichain export
  assert.equal(typeof flowsMultichain.showCrossChainWithdrawChainSelection, "function", "showCrossChainWithdrawChainSelection must be exported");
});

test("Conversation Flow: isLikelyNewIntent recognizes emoji-prefixed and plain navigation phrases", () => {
  assert.equal(isLikelyNewIntent("📤 Send Money"), true, "Should recognize 📤 Send Money");
  assert.equal(isLikelyNewIntent("Send Money"), true, "Should recognize Send Money");
  assert.equal(isLikelyNewIntent("send"), true, "Should recognize send");
  assert.equal(isLikelyNewIntent("💵 Cash Out"), true, "Should recognize 💵 Cash Out");
  assert.equal(isLikelyNewIntent("💰 My Money"), true, "Should recognize 💰 My Money");
  assert.equal(isLikelyNewIntent("📥 Add Money"), true, "Should recognize 📥 Add Money");
  assert.equal(isLikelyNewIntent("🧾 New Invoice"), true, "Should recognize 🧾 New Invoice");
  assert.equal(isLikelyNewIntent("👥 Pay Team"), true, "Should recognize 👥 Pay Team");
  assert.equal(isLikelyNewIntent("🔁 Switch Account"), true, "Should recognize 🔁 Switch Account");
  assert.equal(isLikelyNewIntent("⚙️ Settings & Help"), true, "Should recognize ⚙️ Settings & Help");
});
