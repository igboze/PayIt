// src/notify.js
// One place to tell a user something, whichever client they use:
//   - Telegram message when the user has a Telegram account (positive telegram_id)
//   - push notification (Firebase Cloud Messaging HTTP v1) to every registered app device
// Push needs GOOGLE_SERVICE_ACCOUNT_JSON and FCM_PROJECT_ID; without them only Telegram is used.
// Existing code that calls bot.telegram.sendMessage keeps working; new code should call notify().

const axios = require("axios");
const { getGoogleAccessToken, getServiceAccount } = require("./app_api/google_auth");
const appStore = require("./app_api/store");

let _bot = null;

function setNotifyBot(bot) {
  _bot = bot;
}

function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

async function sendPush(telegramId, { title, body, data = {} }) {
  const projectId = (process.env.FCM_PROJECT_ID || "").trim();
  if (!projectId || !getServiceAccount()) return { sent: 0, skipped: "fcm_not_configured" };
  const devices = appStore.getPushTokens(telegramId);
  if (!devices.length) return { sent: 0 };
  const accessToken = await getGoogleAccessToken("https://www.googleapis.com/auth/firebase.messaging");
  const stringData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
  let sent = 0;
  for (const d of devices) {
    try {
      await axios.post(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
        { message: { token: d.push_token, notification: { title, body }, data: stringData } },
        { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
      );
      sent++;
    } catch (err) {
      const status = err.response?.data?.error?.status;
      // Token no longer valid (app uninstalled): forget it.
      if (status === "NOT_FOUND" || status === "UNREGISTERED") appStore.setPushToken(d.device_id, null);
      else console.warn(`[notify] push to device ${d.device_id} failed:`, err.message);
    }
  }
  return { sent };
}

/**
 * Notify a user on every channel they have.
 * @param {number} telegramId
 * @param {{ title?: string, html: string, data?: object, telegramExtra?: object }} message
 */
async function notify(telegramId, { title = "Proxim", html, data = {}, telegramExtra = {} }) {
  const result = { telegram: false, push: 0 };
  if (Number(telegramId) > 0 && _bot?.telegram) {
    try {
      await _bot.telegram.sendMessage(telegramId, html, { parse_mode: "HTML", ...telegramExtra });
      result.telegram = true;
    } catch (err) {
      console.warn(`[notify] Telegram message to ${telegramId} failed:`, err.message);
    }
  }
  try {
    const push = await sendPush(telegramId, { title, body: stripHtml(html).slice(0, 240), data });
    result.push = push.sent || 0;
  } catch (err) {
    console.warn(`[notify] push to ${telegramId} failed:`, err.message);
  }
  return result;
}

function getNotifyBot() {
  return _bot;
}

module.exports = { notify, setNotifyBot, getNotifyBot, sendPush };
