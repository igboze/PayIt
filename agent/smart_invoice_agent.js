const { getJSONCompletion } = require("./ai_provider");

async function parseSmartInvoiceIntent(userMessage, userContext) {
  const systemPrompt = `You are a Smart Invoicing Agent for PayIT — an Agentic Stablecoins Payment Solution.
Users will provide raw, unstructured text (like a forwarded email or voice note transcription) describing work they have done.
Extract the relevant details to generate a professional invoice.

Respond with ONLY a valid JSON object — no markdown, no explanation.

{
  "client_name": "<Name of the client or company>",
  "client_email": "<Email of the client, or null if missing>",
  "items": [
    {
      "description": "<Description of the service or product>",
      "amount": <number representing cost>
    }
  ],
  "currency": "<USDC | EURC — default USDC>",
  "due_days": <number of days until due, default 14>,
  "summary": "<A short polite note thanking the client for business>"
}

Rules:
- Amounts must be positive numbers.
- If no specific currency is mentioned, assume USDC.
- If no specific due date is mentioned, assume 14 days.
- If crucial details like client name or total amount cannot be derived, return {"error": "<what is missing>"}.

User context: ${JSON.stringify(userContext)}`;

  try {
    return await getJSONCompletion(systemPrompt, userMessage);
  } catch (err) {
    console.error("[smart_invoice_agent] Error:", err.message);
    return { error: "Could not understand the invoice details. Please provide client name and amount." };
  }
}

module.exports = { parseSmartInvoiceIntent };
