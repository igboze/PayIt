// agent/vision_parser.js
// Extracts structured payment or invoice data from images, screenshots,
// and photos sent directly to the bot.
//
// Use cases:
//   - User forwards a screenshot of a supplier invoice → bot pays it
//   - User photos a handwritten payment list → bot processes bulk transfer
//   - User screenshots a bill (electricity, rent notice) → bot extracts amount
//   - User sends a bank transfer request image → bot reads account details
//
// Provider support:
//   - GPT-4o / GPT-4o-mini  (via OpenAI API, vision built-in)
//   - Gemini 2.0 Flash       (via Google GenAI SDK, vision built-in)
//   - Groq: no vision model available yet — falls back to a text-only notice
//
// The function always returns the same shape so callers don't need to know
// which provider handled it.

require("dotenv").config();

function getVisionProvider() {
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  const isSet = (k) => !!k && !k.includes("PASTE_");

  if (isSet(openaiKey)) return "openai";
  if (isSet(geminiKey)) return "gemini";
  return null;
}

// ─── System prompt (shared) ───────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a payment extraction assistant for PayIT, a dollar wallet app used in Nigeria.

Analyse the image and extract any payment or invoice details visible.

Return ONLY valid JSON — no markdown, no explanation — in this exact shape:

{
  "document_type": "invoice" | "bank_transfer" | "bill" | "payment_list" | "receipt" | "unknown",
  "recipient_name": "<name of person or business to pay, or null>",
  "recipient_account": "<bank account number if visible, or null>",
  "recipient_bank": "<bank name if visible, or null>",
  "recipient_wallet": "<0x wallet address if visible, or null>",
  "amount": <numeric amount, or null>,
  "currency": "<NGN | USD | USDC | EUR | GBP | or null>",
  "due_date": "<YYYY-MM-DD if visible, or null>",
  "description": "<what the payment is for, or null>",
  "line_items": [
    { "description": "<item>", "quantity": <n>, "unit_price": <price> }
  ],
  "sender_name": "<name of sender/issuer if visible, or null>",
  "reference": "<invoice number, reference, or null>",
  "notes": "<any other relevant text, or null>",
  "confidence": "high" | "medium" | "low",
  "unreadable": false
}

If the image is blurry, not payment-related, or you cannot extract useful data,
return: { "unreadable": true, "document_type": "unknown" }

Rules:
- Do not invent data not visible in the image.
- For Nigerian bank transfers, account_number is typically 10 digits.
- If an amount is in Naira (₦ or NGN), set currency to "NGN".
- If amounts appear in multiple currencies, capture the primary one.
- line_items should only be populated if multiple distinct items are visible.
- confidence: "high" = clear document; "medium" = partially legible; "low" = guessing.`;

// ─── OpenAI vision ────────────────────────────────────────────────────────────

async function parseWithOpenAI(imageBuffer, mimeType = "image/jpeg") {
  const OpenAI = require("openai");
  const clientOptions = { apiKey: process.env.OPENAI_API_KEY };
  if (process.env.OPENAI_BASE_URL) clientOptions.baseURL = process.env.OPENAI_BASE_URL;
  const client = new OpenAI(clientOptions);
  const model  = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";

  const base64 = imageBuffer.toString("base64");
  const response = await client.chat.completions.create({
    model,
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: [
        { type: "text",      text: EXTRACTION_PROMPT },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}`, detail: "high" } },
      ],
    }],
  });

  const raw   = response.choices[0].message.content.trim();
  const clean = raw.replace(/^```json|^```|```$/gm, "").trim();
  return JSON.parse(clean);
}

// ─── Gemini vision ────────────────────────────────────────────────────────────

async function parseWithGemini(imageBuffer, mimeType = "image/jpeg") {
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const genAI    = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model    = genAI.getGenerativeModel({
    model: process.env.GEMINI_VISION_MODEL || "gemini-2.0-flash",
  });

  const result = await model.generateContent([
    EXTRACTION_PROMPT,
    { inlineData: { data: imageBuffer.toString("base64"), mimeType } },
  ]);

  const raw   = result.response.text().trim();
  const clean = raw.replace(/^```json|^```|```$/gm, "").trim();
  return JSON.parse(clean);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse an image buffer and extract payment details.
 *
 * @param {Buffer} imageBuffer  — raw image bytes
 * @param {string} mimeType     — "image/jpeg" | "image/png" | "image/webp"
 * @returns {Promise<object>}   — structured extraction result
 */
async function parseImagePayment(imageBuffer, mimeType = "image/jpeg") {
  const provider = getVisionProvider();

  if (!provider) {
    console.warn('[vision_parser] No vision provider configured');
    return {
      unreadable: true,
      document_type: "unknown",
      error: "no_vision_provider",
      message: "Image reading requires an OpenAI or Gemini API key. Set OPENAI_API_KEY or GEMINI_API_KEY in .env.",
    };
  }

  try {
    if (provider === "openai") return await parseWithOpenAI(imageBuffer, mimeType);
    if (provider === "gemini") return await parseWithGemini(imageBuffer, mimeType);
  } catch (err) {
    const size = (imageBuffer.length / 1024).toFixed(1);
    const short = err.message?.slice(0, 200) || String(err).slice(0, 200);
    console.error(`[vision_parser] Extraction failed (${provider}, ${size}KB):`, short);
    // If the provider returned a quota/rate-limit error, surface that specifically
    if (err?.response?.status === 429 || /quota|rate limit|exceeded/i.test(short)) {
      return {
        unreadable: true,
        document_type: "unknown",
        error: "quota_exceeded",
        message: "Image reading is rate-limited or quota exceeded. Please try again later.",
      };
    }
    return {
      unreadable: true,
      document_type: "unknown",
      error: "parse_failed",
      message: "Could not read the image. Please try a clearer photo or type the details manually.",
    };
  }
}

/**
 * Format the extracted result into a human-readable Telegram confirmation message.
 * The bot sends this so the user can verify before confirming payment.
 *
 * @param {object} parsed — result from parseImagePayment
 * @returns {string}
 */
function formatExtractionPreview(parsed) {
  if (parsed.unreadable || parsed.error) {
    return (
      `❌ Couldn't read that image clearly.\n\n` +
      `Please try:\n` +
      `• A clearer photo with better lighting\n` +
      `• Typing the payment details directly\n` +
      `• Sending a PDF version of the document`
    );
  }

  const docLabel = {
    invoice:       "📄 Invoice",
    bank_transfer: "🏦 Bank Transfer Request",
    bill:          "🧾 Bill",
    payment_list:  "📋 Payment List",
    receipt:       "🧾 Receipt",
    unknown:       "📎 Document",
  }[parsed.document_type] || "📎 Document";

  const confidenceNote = parsed.confidence === "low"
    ? "\n⚠️ Low confidence — please double-check these details before confirming."
    : parsed.confidence === "medium"
    ? "\n📋 Some details may be approximate — verify before confirming."
    : "";

  const lines = [`${docLabel} detected\n──────────────────────────`];

  if (parsed.recipient_name)    lines.push(`To: ${parsed.recipient_name}`);
  if (parsed.recipient_bank)    lines.push(`Bank: ${parsed.recipient_bank}`);
  if (parsed.recipient_account) lines.push(`Account: ${parsed.recipient_account}`);
  if (parsed.recipient_wallet)  lines.push(`Wallet: \`${parsed.recipient_wallet}\``);
  if (parsed.amount)            lines.push(`Amount: ${parsed.currency || ""} ${parsed.amount}`);
  if (parsed.due_date)          lines.push(`Due: ${parsed.due_date}`);
  if (parsed.description)       lines.push(`For: ${parsed.description}`);
  if (parsed.reference)         lines.push(`Ref: ${parsed.reference}`);

  if (parsed.line_items && parsed.line_items.length > 1) {
    lines.push("\nItems:");
    parsed.line_items.forEach(item => {
      const total = (item.quantity || 1) * (item.unit_price || 0);
      lines.push(`  • ${item.description} × ${item.quantity || 1} = ${total}`);
    });
  }

  lines.push(confidenceNote);
  lines.push("\nIs this correct?");

  return lines.join("\n");
}

module.exports = { parseImagePayment, formatExtractionPreview, getVisionProvider };