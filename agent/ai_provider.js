// agent/ai_provider.js
// One function the rest of the app calls for "give me JSON back from an
// LLM" - it auto-picks the provider based on which API key is actually set
// in .env, so switching providers never requires touching invoice_parser.js
// or orchestrator.js again.
//
// Precedence: GROQ_API_KEY wins if set, then OPENAI_API_KEY, then
// GEMINI_API_KEY. Throws a clear error if none are configured.
//
// NVIDIA note: NVIDIA's API is OpenAI-compatible. To use it, set:
//   OPENAI_API_KEY=your_nvidia_key
//   OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1
//   OPENAI_VISION_MODEL=nvidia/llama-3.2-90b-vision-instruct
//   OPENAI_MODEL=nvidia/llama-3.1-70b-instruct
//
// Groq note: Groq's API is OpenAI-compatible, so we reuse the same
// "openai" SDK package and just point it at Groq's base URL instead of
// installing a separate Groq SDK.

require("dotenv").config();

function isSet(value) {
  return !!value && !value.includes("PASTE_YOUR") && !value.includes("PASTE_");
}

function getActiveProvider() {
  // Prefer OpenAI-compatible providers when an OpenAI key is configured.
  // This includes NVIDIA via OPENAI_BASE_URL as well as native OpenAI.
  if (isSet(process.env.OPENAI_API_KEY)) return "openai";
  if (isSet(process.env.GROQ_API_KEY)) return "groq";
  if (isSet(process.env.GEMINI_API_KEY)) return "gemini";
  return null;
}

async function callGroq(systemPrompt, userMessage) {
  const OpenAI = require("openai");
  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
  });
  const model = process.env.GROQ_MODEL || "llama3-70b-8192";

  const response = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });
  const raw = response.choices[0].message.content.trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error("No JSON object found");
  return JSON.parse(raw.substring(start, end + 1));
}

async function callOpenAI(systemPrompt, userMessage) {
  const OpenAI = require("openai");
  // Respects OPENAI_BASE_URL so NVIDIA, Together, or any OpenAI-compatible
  // provider works by just changing the env var — no code change needed.
  const clientOptions = { apiKey: process.env.OPENAI_API_KEY };
  if (process.env.OPENAI_BASE_URL) {
    clientOptions.baseURL = process.env.OPENAI_BASE_URL;
  }
  const client = new OpenAI(clientOptions);
  let model  = process.env.OPENAI_MODEL || "meta/llama-3.1-70b-instruct";
  if (model === "nvidia/llama-3.1-70b-instruct") {
    model = "meta/llama-3.1-70b-instruct";
  }

  const response = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });
  const raw   = response.choices[0].message.content.trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error("No JSON object found");
  return JSON.parse(raw.substring(start, end + 1));
}

async function callGemini(systemPrompt, userMessage) {
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const modelName = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const model = genAI.getGenerativeModel({ model: modelName });

  // Gemini's SDK JSON-mode support varies by version, so ask explicitly and
  // strip any markdown fences defensively rather than relying on a flag.
  const fullPrompt =
    `${systemPrompt}\n\nRespond with ONLY valid JSON. No markdown fences, no explanation.\n\n` +
    `User message: ${userMessage}`;
  const result = await model.generateContent(fullPrompt);
  const raw = result.response.text().trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error("No JSON object found");
  return JSON.parse(raw.substring(start, end + 1));
}

/**
 * @param {string} systemPrompt - instructions + desired JSON shape
 * @param {string} userMessage  - the actual user input to parse
 * @returns {Promise<object>} parsed JSON response
 */
async function getJSONCompletion(systemPrompt, userMessage) {
  // Mock mode for tests and offline demos
  if (process.env.USE_MOCK_AI === '1') {
    try {
      // Simple heuristics to return predictable JSON for common prompts
      const user = String(userMessage || "");
      // Intent classifier prompt
      if (/intent classifier/i.test(systemPrompt)) {
        // rudimentary parse: 'send $50 to Emeka' or 'send 50 to 0x...'
        const sendMatch = user.match(/send\s+\$?(\d+(?:\.\d+)?)\s+to\s+(.+)/i);
        if (sendMatch) {
          return {
            intent: "transfer",
            confidence: "high",
            params: { recipients: [{ name_or_address: sendMatch[2].trim(), amount: Number(sendMatch[1]), currency: "USDC" }], schedule: {}, missing: null },
            raw_summary: `Send $${sendMatch[1]} to ${sendMatch[2].trim()}`,
          };
        }
        if (/balance|wetin i get|how much/i.test(user)) {
          return { intent: "balance", confidence: "high", params: { recipients: [] , schedule: {}, missing: null }, raw_summary: "Check balance" };
        }
        return { intent: "unknown", confidence: "low", params: { recipients: [], schedule: {}, missing: null }, raw_summary: user };
      }

      // File payment plan prompt
      if (/payment planning assistant/i.test(systemPrompt) || /Rows:/i.test(user)) {
        try {
          const rowsMatch = user.match(/Rows:\s*(\[.*\])$/s);
          const rows = rowsMatch ? JSON.parse(rowsMatch[1]) : [];
          const lowerUser = String(user || '').toLowerCase();
          const timeMatch = lowerUser.match(/at\s+(\d{1,2}:\d{2})/i);
          const time = timeMatch ? timeMatch[1] : null;
          const monthlyMatch = lowerUser.match(/every\s+(\d{1,2})(?:st|nd|rd|th)?\s+of\s+the\s+month/i);
          const weeklyMatch = lowerUser.match(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
          const dailyMatch = lowerUser.match(/every\s+day/i);
          const schedule = monthlyMatch
            ? { frequency: "monthly", day: monthlyMatch[1], time: time || "08:00" }
            : weeklyMatch
              ? { frequency: "weekly", day: weeklyMatch[1].charAt(0).toUpperCase() + weeklyMatch[1].slice(1), time }
              : dailyMatch
                ? { frequency: "daily", day: null, time }
                : { frequency: null, day: null, time: null };
          const payments = rows.map((r) => ({
            to: r.wallet_address || "__offramp__",
            amount: Number(r.amount || 0),
            label: r.description || r.name || "Payment",
            bank_name: r.bank_name || null,
            account_number: r.account_number || null,
            account_name: r.account_name || null,
            currency: r.currency || "USDC",
          }));
          return {
            type: schedule.frequency ? "scheduled" : "bulk",
            payments,
            schedule,
            summary: schedule.frequency
              ? `Pay ${payments.length} recipient${payments.length !== 1 ? "s" : ""} ${lowerUser}.`
              : `Process ${payments.length} recipient${payments.length !== 1 ? "s" : ""}.`,
          };
        } catch (err) {
          return { error: "Could not understand the payment instruction." };
        }
      }

      // Orchestrator payment parsing prompt
      if (/payment orchestration agent/i.test(systemPrompt) || /payment plan/i.test(systemPrompt)) {
        // reuse simple send pattern
        const sendMatch = user.match(/send\s+\$?(\d+(?:\.\d+)?)\s+to\s+(.+)/i);
        if (sendMatch) {
          return {
            type: "one_time",
            payments: [{ to: sendMatch[2].trim().startsWith('0x') ? sendMatch[2].trim() : `__name__:${sendMatch[2].trim()}`, amount: Number(sendMatch[1]), label: `Payment to ${sendMatch[2].trim()}`, bank_name: null, account_number: null, account_name: null, currency: "USDC" }],
            schedule: { frequency: null, day: null, time: null },
            summary: `Send $${sendMatch[1]} to ${sendMatch[2].trim()}`,
          };
        }
        return { error: "Could not understand the payment instruction." };
      }

      // Fallback for other prompts — return a generic unknown
      return {};
    } catch (err) {
      throw err;
    }
  }

  const provider = getActiveProvider();
  if (!provider) {
    throw new Error(
      "No AI provider configured - set GROQ_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY in .env"
    );
  }
  if (provider === "groq") return callGroq(systemPrompt, userMessage);
  if (provider === "openai") return callOpenAI(systemPrompt, userMessage);
  if (provider === "gemini") return callGemini(systemPrompt, userMessage);
}

module.exports = { getJSONCompletion, getActiveProvider };