const { getJSONCompletion } = require("./ai_provider");

function formatYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseDueDate(str) {
  if (!str) return null;
  const s = String(str).toLowerCase().trim();
  const now = new Date();
  if (s.includes("next week")) {
    const d = new Date(now.getTime() + 7 * 86400000);
    return formatYMD(d);
  }
  if (s.includes("end of month")) {
    const d = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return formatYMD(d);
  }
  const daysMatch = s.match(/(\d+)\s*days?/);
  if (daysMatch) {
    const d = new Date(now.getTime() + parseInt(daysMatch[1], 10) * 86400000);
    return formatYMD(d);
  }
  let d = new Date(str);
  if (isNaN(d.getTime()) || d.getFullYear() < 2020) {
    d = new Date(`${str} ${now.getFullYear()}`);
  }
  if (!isNaN(d.getTime())) {
    return formatYMD(d);
  }
  return null;
}

function parseSmartInvoiceHeuristic(userMessage) {
  if (!userMessage || typeof userMessage !== "string") return null;
  const raw = userMessage.trim();
  if (!raw) return null;

  let currency = "USDC";
  if (/\b(eurc|eur|euros?)\b/i.test(raw)) {
    currency = "EURC";
  }

  let dueDate = null;
  let text = raw;
  const dueMatch = text.match(/[,;\s]+due(?:\s+(?:on|by|in|date))?\s+([^,;\n]+)$/i) ||
                   text.match(/\bdue(?:\s+(?:on|by|in|date))?\s+([^,;\n]+)/i);
  if (dueMatch) {
    dueDate = parseDueDate(dueMatch[1].trim());
    text = text.replace(dueMatch[0], "").trim();
  }

  // Remove leading invoice/bill commands
  let clean = text.replace(/^(?:create\s+(?:an?\s+)?invoice\s+for|send\s+(?:an?\s+)?invoice\s+to|make\s+(?:an?\s+)?invoice\s+for|invoice|bill)\s+/i, "").trim();

  let clientName = null;
  let clientEmail = null;
  const items = [];

  const emailMatch = clean.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  if (emailMatch) {
    clientEmail = emailMatch[0];
  }

  // Match: "$200 to Jerry for attending Arc event"
  const startAmountMatch = clean.match(/^[\$]?([\d,]+(?:\.\d+)?)\s*(?:usdc|eurc|usd|eur)?\s+(?:to|for)\s+([A-Za-z0-9_.\s@-]+?)\s+(?:for\s+)(.+)$/i);
  if (startAmountMatch) {
    const amount = parseFloat(startAmountMatch[1].replace(/,/g, ""));
    clientName = startAmountMatch[2].trim();
    const desc = startAmountMatch[3].trim();
    if (amount > 0 && clientName && desc) {
      items.push({ description: desc, quantity: 1, unitPrice: amount });
    }
  }

  if (!items.length) {
    // Match: "Jerry $200 for attending Arc event" or "Acme Ltd $500 for web design"
    const clientSplit = clean.match(/^([A-Za-z0-9_.\s@-]+?)\s+(?:for\s+)?[\$]?([\d,]+(?:\.\d+)?)\s*(?:usdc|eurc|usd|eur)?\s+(?:for\s+)?(.+)$/i);
    if (clientSplit) {
      clientName = clientSplit[1].trim();
      const firstAmount = parseFloat(clientSplit[2].replace(/,/g, ""));
      const rest = clientSplit[3].trim();

      // Check if 'rest' contains multiple items: e.g. "consulting and $100 hosting"
      const restMultiMatch = rest.match(/^(.+?)\s+(?:and|,|\+)\s+[\$]?([\d,]+(?:\.\d+)?)\s*(?:usdc|eurc|usd|eur)?\s+(?:for\s+)?(.+)$/i);
      if (restMultiMatch) {
        items.push({ description: restMultiMatch[1].trim(), quantity: 1, unitPrice: firstAmount });
        items.push({ description: restMultiMatch[3].trim(), quantity: 1, unitPrice: parseFloat(restMultiMatch[2].replace(/,/g, "")) });
      } else {
        items.push({ description: rest, quantity: 1, unitPrice: firstAmount });
      }
    }
  }

  if (!clientName && clientEmail) {
    clientName = clientEmail;
  }

  if (clientName && items.length > 0) {
    return {
      clientName,
      clientEmail,
      currency,
      items,
      dueDate,
      notes: null,
      invoiceNumber: null
    };
  }

  return null;
}

function normalizeInvoiceParsed(parsed, rawUserMessage = "") {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.error) return parsed;

  const clientName = parsed.clientName || parsed.client_name || parsed.client || parsed.to || null;
  const clientEmail = parsed.clientEmail || parsed.client_email || parsed.email || null;
  const currency = (parsed.currency || "USDC").toUpperCase();
  const notes = parsed.notes || parsed.summary || parsed.memo || null;

  let dueDate = parsed.dueDate || parsed.due_date || null;
  if (!dueDate && (parsed.due_days || parsed.dueDays)) {
    const days = parseInt(parsed.due_days || parsed.dueDays, 10);
    if (!isNaN(days) && days > 0) {
      const d = new Date(Date.now() + days * 86400000);
      dueDate = formatYMD(d);
    }
  }

  let items = [];
  if (Array.isArray(parsed.items) && parsed.items.length > 0) {
    items = parsed.items.map((i) => {
      const desc = i.description || i.desc || i.item || i.service || "Services";
      const qty = Number(i.quantity || i.qty || 1) || 1;
      const unitPrice = Number(i.unitPrice !== undefined ? i.unitPrice : (i.amount !== undefined ? i.amount : i.price || 0)) || 0;
      return {
        description: desc,
        quantity: qty,
        unitPrice: unitPrice
      };
    }).filter(i => i.unitPrice > 0);
  } else if (parsed.amount || parsed.total || parsed.totalUsdc || parsed.total_usdc) {
    const amount = Number(parsed.amount || parsed.total || parsed.totalUsdc || parsed.total_usdc);
    if (amount > 0) {
      items.push({
        description: parsed.description || "Services",
        quantity: 1,
        unitPrice: amount
      });
    }
  }

  if (!clientName || items.length === 0) {
    const fallback = parseSmartInvoiceHeuristic(rawUserMessage);
    if (fallback) return fallback;
    return { error: "Could not understand the invoice details. Please provide client name and amount." };
  }

  return {
    clientName,
    clientEmail,
    currency,
    items,
    dueDate,
    notes,
    invoiceNumber: parsed.invoiceNumber || null
  };
}

async function parseSmartInvoiceIntent(userMessage, userContext = {}) {
  const systemPrompt = `You are a Smart Invoicing Agent for PayIT — an Agentic Stablecoins Payment Solution.
Users will provide raw, unstructured text describing work they have done or an invoice to create.
Extract the relevant details to generate a professional invoice.

Respond with ONLY a valid JSON object matching this exact shape — no markdown, no explanation:
{
  "clientName": "<Name of the client, individual, or company>",
  "clientEmail": "<Email of the client, or null if not mentioned>",
  "items": [
    {
      "description": "<Description of the service or product>",
      "quantity": 1,
      "unitPrice": <number representing cost in USDC/EURC>
    }
  ],
  "currency": "<USDC | EURC — default USDC unless user specifies EUR/EURC/euros>",
  "dueDate": "<YYYY-MM-DD or null if not specified>",
  "notes": "<A short polite note thanking the client for business, or null>"
}

Rules:
- Amounts must be positive numbers.
- If no specific currency is mentioned, assume USDC.
- Infer reasonable due dates: "end of month" = last day of current month, "next week" = 7 days from today, "in 14 days" = 14 days from today.
- If crucial details like client name or total amount cannot be derived, return {"error": "Please provide client name and amount."}.

User context: ${JSON.stringify(userContext)}`;

  try {
    const rawParsed = await getJSONCompletion(systemPrompt, userMessage);
    const normalized = normalizeInvoiceParsed(rawParsed, userMessage);
    if (normalized && !normalized.error) {
      return normalized;
    }
    const fallback = parseSmartInvoiceHeuristic(userMessage);
    if (fallback) return fallback;
    return normalized || { error: "Could not understand the invoice details. Please provide client name and amount." };
  } catch (err) {
    console.error("[smart_invoice_agent] Error:", err.message);
    const fallback = parseSmartInvoiceHeuristic(userMessage);
    if (fallback) return fallback;
    return { error: "Could not understand the invoice details. Please provide client name and amount." };
  }
}

module.exports = {
  parseSmartInvoiceIntent,
  parseSmartInvoiceHeuristic,
  normalizeInvoiceParsed
};
