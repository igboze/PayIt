// agent/invoice_parser.js
// Uses Gemini to parse plain English invoice instructions into
// structured invoice data that invoice_generator.js can render.
//
// Example input:  "Invoice Acme Ltd for 500 USDC for web design, due Jan 15"
// Example output: { clientName, amount, description, dueDate, items, invoiceNumber }

require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

/**
 * Parse a plain English invoice instruction into structured data.
 *
 * @param {string} userMessage   - e.g. "Invoice Acme Ltd 500 USDC for web design due Jan 15"
 * @param {object} businessInfo  - { businessName, walletAddress }
 * @returns {object} Structured invoice data or { error: "..." }
 */
async function parseInvoiceIntent(userMessage, businessInfo) {
  const today = new Date().toISOString().split("T")[0];

  const prompt = `You are an invoice assistant for PayIT, a USDC payment bot.

Parse the following invoice instruction into a structured JSON object.
Return ONLY valid JSON — no markdown, no code fences, no explanation.

Return this exact structure:
{
  "clientName": "<name of the client/business being invoiced>",
  "clientEmail": "<client email if mentioned, or null>",
  "items": [
    {
      "description": "<service or product description>",
      "quantity": <number, default 1>,
      "unitPrice": <price per unit in USDC>
    }
  ],
  "dueDate": "<due date in YYYY-MM-DD format, or null if not specified>",
  "notes": "<any extra notes or payment terms mentioned, or null>",
  "invoiceNumber": null
}

Rules:
- If multiple services/items are mentioned, list them separately in items[].
- If only a total amount is given with one description, use 1 item with quantity 1.
- Infer reasonable due dates: "end of month" = last day of current month, "next week" = 7 days from today, "30 days" = 30 days from today.
- If the client name is missing, return { "error": "Please include the client or business name." }
- If no amount is mentioned, return { "error": "Please include the amount in USDC." }
- Do not invent information not present in the instruction.

Today's date: ${today}
Business info: ${JSON.stringify(businessInfo)}

Invoice instruction: ${userMessage}`;

  try {
    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();
    const clean = raw.replace(/^```json|^```|```$/gm, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error("[invoice_parser] Error:", err.message);
    return { error: "Could not understand the invoice instruction. Please rephrase and try again." };
  }
}

module.exports = { parseInvoiceIntent };
