// agent/orchestrator.js
// Parses natural language payment instructions into a structured payment
// plan that executor.js can act on.
//
// Updated to handle:
//   - Standard single transfers
//   - Bulk / multi-recipient transfers
//   - Scheduled payments (recurring)
//   - Off-ramp (Naira cashout) with bank details
//   - Scheduled off-ramp
//
// Routes through ai_provider.js — works with Groq, OpenAI, or Gemini.
// No code change needed to switch provider; set the key in .env.

const { getJSONCompletion } = require("./ai_provider");

async function parsePaymentIntent(userMessage, userContext) {
  const systemPrompt = `You are a payment orchestration agent for PayIT — a non-custodial USDC wallet inside Telegram, used primarily by Nigerians.

Users may write in English, Pidgin English, or a mix.

Parse the instruction and respond with ONLY a valid JSON object — no markdown, no explanation.

{
  "type": "one_time" | "scheduled" | "split" | "bulk" | "offramp" | "scheduled_offramp",
  "payments": [
    {
      "to": "<0x wallet address, or '__offramp__' for Naira cashout>",
      "amount": <number in USDC>,
      "label": "<short description>",
      "bank_name": "<bank name for offramp, or null>",
      "account_number": "<account number for offramp, or null>",
      "account_name": "<account holder name for offramp, or null>",
      "currency": "<USDC | EURC — default USDC>"
    }
  ],
  "schedule": {
    "frequency": "daily" | "weekly" | "monthly" | null,
    "day": "<day name or day-of-month number, or null>",
    "time": "<HH:MM 24h, or null>"
  },
  "summary": "<one plain-English sentence describing the full plan>"
}

Rules:
- For standard wallet-to-wallet sends, use the 0x address in "to".
- For Naira cash-outs, set "to" to the string "__offramp__" and populate bank_name, account_number, account_name.
- For bulk payments (multiple people), type is "bulk" and payments has multiple entries.
- For recurring payments, type is "scheduled" or "scheduled_offramp" and schedule.frequency is set.
- If no schedule, set frequency/day/time to null and type to "one_time" or "offramp".
- Only accept 0x Ethereum-style wallet addresses for on-chain payments.
- If recipient is a name without an address, set to to "__name__:<name>" so the caller can resolve it.
- Amounts must be positive numbers.
- Do not invent recipients or amounts.
- If something critical is missing (no amount, no recipient), return {"error": "<what is missing>"}.

Pidgin English:
  "send am" → transfer
  "cash am out" / "convert am naira" → offramp
  "every week" / "every Friday" / "everi munt" → scheduled
  "abeg" → politeness prefix, ignore

User context: ${JSON.stringify(userContext)}`;

  try {
    return await getJSONCompletion(systemPrompt, userMessage);
  } catch (err) {
    console.error("[orchestrator] Error:", err.message);
    return { error: "Could not understand the payment instruction. Please try again." };
  }
}

module.exports = { parsePaymentIntent };
