// src/otp.js
// Termii SMS OTP — send and verify tokens
// Docs: https://developers.termii.com/send-token

const axios = require("axios");

const TERMII_BASE   = "https://api.ng.termii.com/api";
const TERMII_KEY    = process.env.TERMII_API_KEY   || "";
const TERMII_FROM   = process.env.TERMII_SENDER_ID || "PayIT";

async function sendOtp(phoneNumber) {
  if (!TERMII_KEY) throw new Error("TERMII_API_KEY not set in .env");
  const res = await axios.post(`${TERMII_BASE}/sms/otp/send`, {
    api_key:    TERMII_KEY,
    message_type: "NUMERIC",
    to:         phoneNumber,
    from:       TERMII_FROM,
    channel:    "generic",
    pin_attempts: 3,
    pin_time_to_live: 10, // minutes
    pin_length: 4,
    pin_placeholder: "<>",
    message_text: "Your PayIT verification code is <>. Valid for 10 minutes.",
  });
  return { pinId: res.data.pinId };
}

async function verifyOtp(pinId, pin) {
  if (!TERMII_KEY) throw new Error("TERMII_API_KEY not set in .env");
  const res = await axios.post(`${TERMII_BASE}/sms/otp/verify`, {
    api_key: TERMII_KEY,
    pin_id:  pinId,
    pin,
  });
  return res.data.verified === true || res.data.verified === "true";
}

module.exports = { sendOtp, verifyOtp };
