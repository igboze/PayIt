// agent/orchestrator.js
// Uses Groq (llama-3.3-70b-versatile) to parse plain-English payment instructions.
// Hard rule: never invents a recipient address — must be a real 0x address in the instruction.

const Groq = require("groq-sdk");

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `You are a payment parser for PayIT, a crypto wallet bot on Arc testnet.

Parse the user's instruction into a structured payment plan. Respond ONLY with valid JSON — no markdown, no explanation, no code fences.

JSON schema:
{
  "payments": [
    { "to": "0x...", "amount": "5.00", "label": "description" }
  ],
  "schedule": {
    "frequency": "weekly" | "monthly" | "daily" | null,
    "day": "Friday" | "1st" | null,
    "time": "09:00" | null
  },
  "summary": "one-line human-readable summary"
}

Critical rules:
- "to" must be a valid 0x Ethereum address copied exactly from the user's message. NEVER invent one.
- If no valid 0x address is present, return: {"error": "No valid wallet address found. Please include a 0x address."}
- "amount" must be a positive number string. If unclear, return: {"error": "Could not determine the amount to send."}
- For one-time payments set schedule to null.
- Output ONLY the JSON object. No other text.`;

async function parsePaymentIntent(instruction, { balance, address }) {
  if (!process.env.GROQ_API_KEY) {
    return { error: "GROQ_API_KEY not set in .env — get a free key at console.groq.com" };
  }
  try {
    const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const res = await client.chat.completions.create({
      model: GROQ_MODEL,
      temperature: 0.1,
      max_tokens: 1024,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: `User wallet: ${address}\nBalance: ${balance} USDC\n\nInstruction: ${instruction}` },
      ],
    });
    const raw   = res.choices[0]?.message?.content || "";
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error("[orchestrator] Parse error:", err.message);
    return { error: "Couldn't parse your instruction. Try: 'Send 5 USDC to 0x... now' or 'Pay 0x... 10 USDC every Friday'." };
  }
}

module.exports = { parsePaymentIntent };
