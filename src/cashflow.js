// src/cashflow.js
// Morning briefing scheduler for business users.
// Sends daily business snapshots at 8:00 AM.

const cron = require("node-cron");
const { Markup } = require("telegraf");
const business = require("./business");
const db = require("./db");

let _botInstance = null;
let _cronJob = null;

/**
 * Initialize morning cash flow scheduler.
 *
 * @param {object} bot - Telegraf bot instance
 */
function initCashFlowScheduler(bot) {
  _botInstance = bot;

  // Run at 8:00 AM every day
  _cronJob = cron.schedule("0 8 * * *", async () => {
    console.log("[cashflow] Running scheduled morning briefings...");
    await sendAllBriefings();
  });

  console.log("[cashflow] Morning briefing scheduled for 8:00 AM daily");
}

/**
 * Send daily briefing to all registered business users.
 */
async function sendAllBriefings() {
  if (!_botInstance) return;

  try {
    const users = db.getAllUsers ? db.getAllUsers() : [];
    const bizUsers = users.filter((u) => u.business_deposit_address && !u.is_blocked);

    console.log(`[cashflow] Sending daily briefings to ${bizUsers.length} business user(s)...`);

    for (const user of bizUsers) {
      try {
        await sendBriefingToUser(user.telegram_id);
      } catch (userErr) {
        console.warn(`[cashflow] Failed to send briefing to TG:${user.telegram_id}:`, userErr.message);
      }
    }
  } catch (err) {
    console.error("[cashflow] sendAllBriefings error:", err.message);
  }
}

/**
 * Send briefing to a single user.
 *
 * @param {number} telegramId
 */
async function sendBriefingToUser(telegramId) {
  if (!_botInstance) return;

  const user = db.getUser(telegramId);
  if (!user || !user.business_deposit_address) return;

  try {
    const data = await business.generateCashFlowBriefing(telegramId, user.business_deposit_address);
    const message = business.formatCashFlowBriefing(data);

    await _botInstance.telegram.sendMessage(telegramId, message, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("📋 Invoices", "action_biz_list_invoices"),
          Markup.button.callback("🧾 New Invoice", "action_biz_create_invoice"),
        ],
        [
          Markup.button.callback("💰 Treasury Balance", "action_biz_balance"),
          Markup.button.callback("🔄 Switch Mode", "action_switch_context"),
        ],
      ]),
    });
  } catch (err) {
    console.error(`[cashflow] Briefing failed for TG:${telegramId}:`, err.message);
  }
}

/**
 * Stop the scheduler (for graceful shutdown).
 */
function stopCashFlowScheduler() {
  if (_cronJob) {
    _cronJob.stop();
    _cronJob = null;
  }
}

module.exports = {
  initCashFlowScheduler,
  sendBriefingToUser,
  sendAllBriefings,
  stopCashFlowScheduler,
};
