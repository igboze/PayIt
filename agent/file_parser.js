// agent/file_parser.js
// Extracts payment data from PDF and Excel/CSV files sent to the bot.
//
// PDF:   text extracted via pdf-parse, then sent to the LLM for structuring
// Excel: parsed via xlsx, rows mapped to payment records directly (no LLM needed
//        if columns are recognisable), LLM fallback if structure is ambiguous
// CSV:   same pipeline as Excel
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
 */
function parseSpreadsheet(buffer, isCSV = false) {
  const XLSX = require("xlsx");
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet     = workbook.Sheets[sheetName];
  const rows      = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const headers   = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { headers, rows };
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
    const { headers, rows } = parseSpreadsheet(buffer, isCSV);
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

module.exports = { parsePdf, parseSpreadsheetFile, formatFilePreview };
