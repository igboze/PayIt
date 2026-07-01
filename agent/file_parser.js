// agent/file_parser.js
// Extracts payment data from PDF, PPTX, DOCX, Excel/CSV and plain text files.
//
// PDF:   text extracted via pdf-parse, then sent to the LLM for structuring
// PPTX:  slide text extracted from XML and structured by the LLM
// DOCX:  document text extracted from XML and structured by the LLM
// TXT:   raw text sent to the LLM for structuring
// Excel: parsed via xlsx, rows mapped to payment records directly (no LLM needed
//        if columns are recognisable), LLM fallback if structure is ambiguous
// CSV:   parsed via xlsx from text, then mapped to payment rows
//
// Expected output shape (always):
// {
//   type: "bulk_payment" | "invoice" | "payroll" | "expense_list" | "unknown",
//   rows: [{ name, wallet_address, bank_name, account_number, amount, currency, description }],
//   total: <sum of all amounts>,
//   currency: <dominant currency>,
//   error: null | "<message>"
// }

require("dotenv").config();
const { getJSONCompletion } = require("./ai_provider");

function parseAmountValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[,₦$]/g, '').trim();
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseScheduleFromInstruction(instruction) {
  const text = String(instruction || '').trim().toLowerCase();
  const timeMatch = text.match(/at\s+(\d{1,2}:\d{2})/i);
  const time = timeMatch ? timeMatch[1] : null;

  const monthlyMatch = text.match(/every\s+(\d{1,2})(?:st|nd|rd|th)?\s+of\s+the\s+month/i);
  if (monthlyMatch) {
    return { frequency: 'monthly', day: monthlyMatch[1], time: time || '08:00' };
  }

  const weeklyMatch = text.match(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
  if (weeklyMatch) {
    const day = weeklyMatch[1].charAt(0).toUpperCase() + weeklyMatch[1].slice(1);
    return { frequency: 'weekly', day, time: time || null };
  }

  const dailyMatch = text.match(/every\s+day/i);
  if (dailyMatch) {
    return { frequency: 'daily', day: null, time: time || null };
  }

  return { frequency: null, day: null, time: null };
}

function buildLocalPaymentPlan(rows, instruction) {
  const schedule = parseScheduleFromInstruction(instruction);
  const payments = (rows || []).map((r) => ({
    to: r.wallet_address || '__offramp__',
    amount: parseAmountValue(r.amount),
    label: r.description || r.name || 'Payment',
    bank_name: r.bank_name || null,
    account_number: r.account_number || null,
    account_name: r.account_name || null,
    currency: r.currency || 'USDC',
  })).filter((payment) => payment.amount > 0);

  const type = schedule.frequency ? 'scheduled' : (payments.length === 1 ? 'one_time' : 'bulk');
  const summary = schedule.frequency
    ? `Pay ${payments.length} recipient${payments.length !== 1 ? 's' : ''} ${schedule.day ? `on ${schedule.day}` : ''}${schedule.time ? ` at ${schedule.time}` : ''}.`
    : `Process ${payments.length} recipient${payments.length !== 1 ? 's' : ''}.`;

  return { type, payments, schedule, summary };
}

// ─── PPTX extraction (slide text) ───────────────────────────────────────────
async function parsePptx(buffer) {
  try {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buffer);
    const slideFiles = Object.keys(zip.files).filter(f => f.match(/^ppt\/slides\/slide[0-9]+\.xml$/i)).sort();
    const slides = [];
    for (const sf of slideFiles) {
      const content = await zip.files[sf].async('string');
      // extract text nodes `<a:t>...</a:t>` which hold slide text
      const texts = [];
      const re = /<a:t[^>]*>(.*?)<\/a:t>/gms;
      let m;
      while ((m = re.exec(content)) !== null) texts.push(m[1]);
      slides.push(texts.join(' '));
    }
    const raw = slides.join('\n\n');
    if (!raw || raw.trim().length < 20) {
      return { type: 'unknown', rows: [], total: 0, currency: null, error: 'PPTX appears empty or contains images only.' };
    }
    // Use the LLM structuring fallback to interpret slides as a payment document
    const result = await structureWithLLM(raw, 'pptx');
    return result;
  } catch (err) {
    console.error('[file_parser/pptx]', err.message || err);
    return { type: 'unknown', rows: [], total: 0, currency: null, error: 'Could not read the PPTX file.' };
  }
}

async function parseDocx(buffer) {
  try {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = zip.file('word/document.xml');
    if (!documentXml) {
      return { type: 'unknown', rows: [], total: 0, currency: null, error: 'DOCX appears empty or unsupported.' };
    }

    const content = await documentXml.async('string');
    const texts = [];
    const re = /<w:t[^>]*>(.*?)<\/w:t>/gms;
    let match;
    while ((match = re.exec(content)) !== null) {
      texts.push(match[1]);
    }

    const raw = texts.join(' ');
    if (!raw || raw.trim().length < 20) {
      return { type: 'unknown', rows: [], total: 0, currency: null, error: 'DOCX appears empty or contains non-text content.' };
    }

    return await structureWithLLM(raw, 'DOCX');
  } catch (err) {
    console.error('[file_parser/docx]', err.message || err);
    return { type: 'unknown', rows: [], total: 0, currency: null, error: 'Could not read the DOCX file.' };
  }
}

async function parseTextFile(buffer) {
  try {
    const raw = buffer.toString('utf8');
    if (!raw || raw.trim().length < 20) {
      return { type: 'unknown', rows: [], total: 0, currency: null, error: 'Text file appears empty.' };
    }
    return await structureWithLLM(raw, 'text file');
  } catch (err) {
    console.error('[file_parser/text]', err.message || err);
    return { type: 'unknown', rows: [], total: 0, currency: null, error: 'Could not read the text file.' };
  }
}

async function buildFilePaymentPlan(rows, instruction, userContext = {}) {
  const trimmed = String(instruction || '').trim();
  if (!trimmed || !rows || rows.length === 0) {
    return null;
  }

  const systemPrompt = `You are a payment planning assistant for PayIT, a Nigerian dollar wallet bot.

Users may attach a spreadsheet, PDF, PPTX, or text file containing payment rows and add a caption or instruction about how those payments should be executed.

Your job is to return a structured payment plan in JSON only, no markdown, no explanation.

Rows are payment records with name, wallet_address, bank_name, account_number, account_name, amount, currency, and description.

Rules:
- If a row has a wallet_address, set "to" to that address.
- If a row has no wallet_address but has bank details, set "to" to "__offramp__" and include account_number, bank_name, account_name.
- Keep currency from the row when present; otherwise default to "USDC".
- If the instruction is a recurring payroll/salary payment, set schedule.frequency to "monthly" or the closest match, and set schedule.day/time when the instruction specifies it.
- If the instruction says "every 30th of the month", use { "frequency": "monthly", "day": "30", "time": "08:00" } unless a time is specified.
- If no schedule is required, set schedule.frequency, schedule.day, and schedule.time to null.
- Use "bulk" for multiple recipients and "one_time" for a single immediate payment.
- Do not invent amounts or recipients; use the provided rows.
- Return exactly this JSON schema:
{
  "type": "one_time" | "scheduled" | "split" | "bulk" | "offramp" | "scheduled_offramp",
  "payments": [
    {
      "to": "<0x address or __offramp__>",
      "amount": <number>,
      "label": "<short description>",
      "bank_name": "<bank name or null>",
      "account_number": "<account number or null>",
      "account_name": "<beneficiary name or null>",
      "currency": "<USDC | EURC | NGN | USD | EUR | null>"
    }
  ],
  "schedule": {
    "frequency": "daily" | "weekly" | "monthly" | null,
    "day": "<day name or date number or null>",
    "time": "<HH:MM 24h or null>"
  },
  "summary": "<one plain-English sentence describing the full plan>"
}`;

  const rowsText = JSON.stringify(rows.map((r) => ({
    name: r.name || null,
    wallet_address: r.wallet_address || null,
    bank_name: r.bank_name || null,
    account_number: r.account_number || null,
    account_name: r.account_name || null,
    amount: typeof r.amount === 'string' ? Number(r.amount.replace(/[,₦$]/g, '')) : r.amount,
    currency: r.currency || null,
    description: r.description || null,
  })), null, 2);

  try {
    const plan = await getJSONCompletion(systemPrompt, `Instruction: ${trimmed}\n\nRows: ${rowsText}`);
    if (plan && Array.isArray(plan.payments) && plan.payments.length >= 0) {
      return plan;
    }
    return buildLocalPaymentPlan(rows, instruction);
  } catch (err) {
    console.error('[file_parser/buildFilePaymentPlan]', err.message || err);
    return buildLocalPaymentPlan(rows, instruction);
  }
}

// ─── PDF extraction ───────────────────────────────────────────────────────────

async function extractPdfText(buffer) {
  const pdfParse = require("pdf-parse");
  const data     = await pdfParse(buffer);
  return data.text;
}

// ─── Excel / CSV extraction ───────────────────────────────────────────────────

/**
 * Parse an Excel or CSV buffer into row objects.
 * Returns { headers, rows } where rows is an array of plain objects.
 * Uses xlsx for broad spreadsheet and CSV compatibility.
 */
async function parseSpreadsheet(buffer, isCSV = false) {
  const XLSX = require('xlsx');
  try {
    const input = isCSV ? buffer.toString('utf8') : buffer;
    const workbook = XLSX.read(input, { type: isCSV ? 'string' : 'buffer', raw: false, cellDates: true });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return { headers: [], rows: [] };

    const worksheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    if (!rawRows || rawRows.length === 0) return { headers: [], rows: [] };

    const headerRow = rawRows[0].map((v) => String(v || ''));
    const rows = [];

    for (let rowIndex = 1; rowIndex < rawRows.length; rowIndex += 1) {
      const row = rawRows[rowIndex];
      const obj = {};
      headerRow.forEach((header, colIndex) => {
        obj[header] = String(row[colIndex] || '');
      });
      if (Object.keys(obj).some((k) => obj[k])) rows.push(obj);
    }

    return { headers: headerRow, rows };
  } catch (err) {
    console.error('[file_parser/spreadsheet] error:', err.message);
    throw err;
  }
}

/**
 * Try to map spreadsheet rows to payment records using common column name
 * heuristics before falling back to the LLM.
 *
 * Recognised column aliases:
 *   name/recipient/payee/employee → name
 *   wallet/address/0x → wallet_address
 *   bank → bank_name
 *   account/acct/account_number → account_number
 *   account_name/acct_name → account_name
 *   amount/usdc/value/pay/salary → amount
 *   currency/token → currency
 *   description/note/reason/for → description
 */
function mapSpreadsheetRows(rows) {
  const normalise = (s) => String(s).toLowerCase().replace(/[\s_-]/g, "");

  const ALIASES = {
    name:           ["name", "recipient", "payee", "employee", "staff", "to"],
    wallet_address: ["wallet", "address", "walletaddress", "0x"],
    bank_name:      ["bank", "bankname"],
    account_number: ["account", "acct", "accountnumber", "acctnumber", "nuban"],
    account_name:   ["accountname", "acctname", "beneficiary"],
    amount:         ["amount", "usdc", "value", "pay", "salary", "sum", "total"],
    currency:       ["currency", "token", "ccy"],
    description:    ["description", "note", "reason", "for", "purpose", "memo"],
  };

  // Build column → field mapping from first row headers
  const colMap = {};
  if (rows.length === 0) return null;
  Object.keys(rows[0]).forEach(col => {
    const n = normalise(col);
    for (const [field, aliases] of Object.entries(ALIASES)) {
      if (aliases.some(a => n.includes(a))) {
        colMap[col] = field;
        break;
      }
    }
  });

  // Need at least name + amount to consider this a match
  const mappedFields = new Set(Object.values(colMap));
  if (!mappedFields.has("name") || !mappedFields.has("amount")) return null;

  return rows.map(row => {
    const record = {
      name: "", wallet_address: null, bank_name: null,
      account_number: null, account_name: null,
      amount: 0, currency: "USDC", description: null,
    };
    for (const [col, field] of Object.entries(colMap)) {
      const val = row[col];
      if (val === "" || val === undefined || val === null) continue;
      if (field === "amount") record.amount = parseFloat(String(val).replace(/[,₦$]/g, "")) || 0;
      else record[field] = String(val).trim();
    }
    return record;
  }).filter(r => r.name && r.amount > 0);
}

// ─── LLM structuring fallback ─────────────────────────────────────────────────

async function structureWithLLM(rawText, fileType) {
  const systemPrompt = `You are a payment data extraction assistant for PayIT, a Nigerian dollar wallet.

Extract payment records from the following ${fileType} content.

Return ONLY valid JSON — no markdown, no explanation:
{
  "type": "bulk_payment" | "invoice" | "payroll" | "expense_list" | "unknown",
  "rows": [
    {
      "name": "<recipient name>",
      "wallet_address": "<0x address or null>",
      "bank_name": "<bank name or null>",
      "account_number": "<account number or null>",
      "account_name": "<account holder name or null>",
      "amount": <numeric>,
      "currency": "<USDC | NGN | USD | EUR | null>",
      "description": "<what this payment is for or null>"
    }
  ],
  "total": <sum of all amounts>,
  "currency": "<dominant currency>",
  "error": null
}

Rules:
- Each payable person or line item becomes one row.
- If currency is ambiguous, default to USDC.
- Ignore header rows, totals rows, and non-payment data.
- If no payment data is found, return { "type": "unknown", "rows": [], "total": 0, "currency": null, "error": "No payment records found." }`;

  return await getJSONCompletion(systemPrompt, rawText.slice(0, 8000)); // cap at 8k chars
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a PDF buffer and return structured payment records.
 *
 * @param {Buffer} buffer
 * @returns {Promise<object>}
 */
async function parsePdf(buffer) {
  try {
    const text = await extractPdfText(buffer);
    if (!text || text.trim().length < 20) {
      return { type: "unknown", rows: [], total: 0, currency: null, error: "PDF appears to be empty or image-only. Try sending a clearer scan." };
    }
    const result = await structureWithLLM(text, "PDF");
    return result;
  } catch (err) {
    console.error("[file_parser/pdf]", err.message);
    return { type: "unknown", rows: [], total: 0, currency: null, error: "Could not read the PDF. Please try again or type the details manually." };
  }
}

/**
 * Parse an Excel or CSV buffer and return structured payment records.
 *
 * @param {Buffer} buffer
 * @param {boolean} isCSV
 * @returns {Promise<object>}
 */
async function parseSpreadsheetFile(buffer, isCSV = false) {
  try {
    const { headers, rows } = await parseSpreadsheet(buffer, isCSV);
    if (rows.length === 0) {
      return { type: "unknown", rows: [], total: 0, currency: null, error: "The spreadsheet appears to be empty." };
    }

    // Try heuristic mapping first (faster, no LLM cost)
    const mapped = mapSpreadsheetRows(rows);
    if (mapped && mapped.length > 0) {
      const total    = mapped.reduce((s, r) => s + r.amount, 0);
      const currency = mapped[0].currency || "USDC";
      return { type: "bulk_payment", rows: mapped, total, currency, error: null };
    }

    // Heuristic failed — send first 50 rows as JSON text to LLM
    const sample = rows.slice(0, 50);
    const text   = `Headers: ${headers.join(", ")}\n\nData:\n${JSON.stringify(sample, null, 2)}`;
    const result = await structureWithLLM(text, "spreadsheet");
    return result;

  } catch (err) {
    console.error("[file_parser/xlsx]", err.message);
    return { type: "unknown", rows: [], total: 0, currency: null, error: "Could not read the spreadsheet. Please check the file format." };
  }
}

/**
 * Format the parsed file result as a Telegram confirmation message.
 *
 * @param {object} parsed
 * @param {number} [maxPreviewRows=8]
 * @returns {string}
 */
function formatFilePreview(parsed, maxPreviewRows = 8) {
  if (parsed.error && parsed.rows.length === 0) {
    return `❌ ${parsed.error}`;
  }

  const typeLabel = {
    bulk_payment:  "💸 Bulk Payment",
    payroll:       "👥 Payroll",
    invoice:       "🧾 Invoice",
    expense_list:  "📋 Expense List",
    unknown:       "📎 Document",
  }[parsed.type] || "📎 Document";

  const preview = parsed.rows.slice(0, maxPreviewRows).map((r, i) => {
    const dest = r.wallet_address
      ? `\`${r.wallet_address.slice(0, 8)}...\``
      : r.account_number
      ? `${r.bank_name || "Bank"} · ${r.account_number}`
      : "—";
    return `${i + 1}. ${r.name} — ${r.amount} ${r.currency || "USDC"}\n   → ${dest}${r.description ? "\n   " + r.description : ""}`;
  }).join("\n\n");

  const more = parsed.rows.length > maxPreviewRows
    ? `\n\n...and ${parsed.rows.length - maxPreviewRows} more recipients.`
    : "";

  return (
    `${typeLabel} detected\n` +
    `──────────────────────────\n` +
    `${parsed.rows.length} recipient${parsed.rows.length !== 1 ? "s" : ""} · ` +
    `Total: ${parsed.total.toFixed(2)} ${parsed.currency || "USDC"}\n\n` +
    `${preview}${more}\n\n` +
    `Does this look right?`
  );
}

module.exports = {
  parsePdf,
  parseSpreadsheetFile,
  parsePptx,
  parseDocx,
  parseTextFile,
  buildFilePaymentPlan,
  formatFilePreview,
  mapSpreadsheetRows,
};

