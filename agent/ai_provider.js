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
  if (isSet(process.env.GROQ_API_KEY)) return "groq";
  if (isSet(process.env.OPENAI_API_KEY)) return "openai";
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
  const clean = raw.replace(/^```json|^```|```$/gm, "").trim();
  return JSON.parse(clean);
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
  const model  = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const response = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });
  const raw   = response.choices[0].message.content.trim();
  const clean = raw.replace(/^```json|^```|```$/gm, "").trim();
  return JSON.parse(clean);
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
  const clean = raw.replace(/^```json|^```|```$/gm, "").trim();
  return JSON.parse(clean);
}

/**
 * @param {string} systemPrompt - instructions + desired JSON shape
 * @param {string} userMessage  - the actual user input to parse
 * @returns {Promise<object>} parsed JSON response
 */
async function getJSONCompletion(systemPrompt, userMessage) {
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