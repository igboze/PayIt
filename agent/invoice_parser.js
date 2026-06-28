// agent/invoice_parser.js
// Uses agent/ai_provider.js (Groq) to parse plain English invoice
// instructions into structured invoice data for invoice_generator.js
// and the invoice ledger (src/db.js createInvoice).
//
// Example input:  "Invoice Acme Ltd for 500 USDC for web design, due Jan 15"
// Example output: { clientName, clientEmail, items, dueDate, notes, invoiceNumber }
//
// VAT/WHT awareness: if the user mentions VAT or withholding tax, or asks
// for it, the parser includes a vat/wht breakdown so the SME sees exactly
// what's owed vs. what's tax, rather than one opaque total. Nigerian
// defaults: VAT 7.5%, WHT 5% (10% for consultancy/technical services),
// only applied when explicitly mentioned, never invented silently.

const { getActiveProvider: getAiProvider } = require("./ai_provider");

function stripCodeFences(raw) {
  return raw.replace(/^```json|^```|```$/gm, "").trim();
}

async function parseInvoiceIntent(userMessage, businessInfo) {
  const today = new Date().toISOString().split("T")[0];

  const systemPrompt = `You are an invoice assistant for PayIT, a USDC/EURC payment bot.

Parse the user's invoice instruction into a structured JSON object.
Respond with ONLY valid JSON matching this exact structure — no markdown, no extra text:
{
  "clientName": "<name of the client/business being invoiced>",
  "clientEmail": "<client email if mentioned, or null>",
  "currency": "<USDC or EURC, default USDC unless the user specifies EUR/EURC/euros>",
  "items": [
    {
      "description": "<service or product description>",
      "quantity": <number, default 1>,
      "unitPrice": <price per unit, in the chosen currency>
    }
  ],
  "vatRate": <0.075 if VAT is mentioned or requested, otherwise null>,
  "whtRate": <0.05 for general services or 0.10 for consultancy/technical services if WHT is mentioned or requested, otherwise null>,
  "dueDate": "<due date in YYYY-MM-DD format, or null if not specified>",
  "notes": "<any extra notes or payment terms mentioned, or null>",
  "invoiceNumber": null
}

Rules:
- If multiple services/items are mentioned, list them separately in items[].
- If only a total amount is given with one description, use 1 item with quantity 1.
- Infer reasonable due dates: "end of month" = last day of current month, "next week" = 7 days from today, "30 days" = 30 days from today.
- Only set vatRate or whtRate if the user actually mentions VAT, WHT, withholding tax, or tax in their instruction. Never invent tax obligations the user did not ask about.
- If the client name is missing, respond with {"error": "Please include the client or business name."}
- If no amount is mentioned, respond with {"error": "Please include the amount."}
- Do not invent information not present in the instruction.

Today's date: ${today}
Business info: ${JSON.stringify(businessInfo)}`;

  const provider = getAiProvider();
  if (!provider) {
    return { error: "No AI provider configured — set GROQ_API_KEY in .env." };
  }

  try {
    const raw = await provider.complete(systemPrompt, userMessage);
    const clean = stripCodeFences(raw);
    return JSON.parse(clean);
  } catch (err) {
    console.error("[invoice_parser] Error:", err.message);
    return { error: "Could not understand the invoice instruction. Please rephrase and try again." };
  }
}

/**
 * Compute subtotal, VAT, WHT, and total from parsed invoice items and rates.
 * Kept separate from parsing itself so the math is deterministic, not
 * left to the LLM to calculate (LLMs are unreliable at arithmetic).
 *
 * @param {object} parsed - output of parseInvoiceIntent
 * @returns {object} { subtotal, vatRate, vatAmount, whtRate, whtAmount, total, currency }
 */
function computeInvoiceTotals(parsed) {
  const subtotal = parsed.items.reduce(
    (sum, item) => sum + (item.quantity || 1) * item.unitPrice,
    0
  );

  const vatRate = parsed.vatRate ?? null;
  const vatAmount = vatRate ? Math.round(subtotal * vatRate * 100) / 100 : null;

  const whtRate = parsed.whtRate ?? null;
  // WHT is typically deducted by the client before payment, so it reduces
  // what the SME nets, it does not add to what the client pays. Still
  // shown explicitly so the SME knows the net amount to expect.
  const whtAmount = whtRate ? Math.round(subtotal * whtRate * 100) / 100 : null;

  const total = Math.round((subtotal + (vatAmount || 0)) * 100) / 100;

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    vatRate,
    vatAmount,
    whtRate,
    whtAmount,
    total,
    currency: parsed.currency || "USDC",
  };
}

module.exports = { parseInvoiceIntent, computeInvoiceTotals };