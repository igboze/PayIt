// agent/ai_provider.js
// Groq AI provider — fast, free inference via groq-sdk
// Model: llama-3.3-70b-versatile (best free model for structured JSON output)
// Set GROQ_API_KEY in .env — get a free key at console.groq.com

const Groq = require("groq-sdk");

// Best free Groq model for reliable JSON parsing tasks
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

function getAiProvider() {
  if (!process.env.GROQ_API_KEY) return null;

  const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

  return {
    name: "groq",
    model: GROQ_MODEL,
    async complete(systemPrompt, userMessage) {
      const res = await client.chat.completions.create({
        model: GROQ_MODEL,
        temperature: 0.1,   // low temp = more deterministic JSON
        max_tokens: 1024,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userMessage  },
        ],
      });
      return res.choices[0]?.message?.content || "";
    },
  };
}

module.exports = { getAiProvider };
