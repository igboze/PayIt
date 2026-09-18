// agent/file_parser.js
// Extracts payment data from PDF, PPTX, DOCX, Excel/CSV and plain text files.
// Handles multi-rail payroll: NGN bank transfers, Arc EVM on-chain, and Solana on-chain.
// Attaches deterministic idempotency keys to each payment record to prevent duplicate payouts.

require("dotenv").config();
const crypto = require("crypto");
const { getJSONCompletion } = require("./ai_provider");
const { resolveBankCode } = require("../src/bank_resolver");
const { isSolanaAddress } = require("../src/multichain");
const { generateIdempotencyKey } = require("../src/idempotency");

function parseAmountValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[,₦$€]/g, "").trim();
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseScheduleFromInstruction(instruction) {
  const text = String(instruction || "").trim().toLowerCase();
  const timeMatch = text.match(/at\s+(\d{1,2}:\d{2})/i);
  const time = timeMatch ? timeMatch[1] : null;

  const monthlyMatch = text.match(/every\s+(\d{1,2})(?:st|nd|rd|th)?\s+of\s+the\s+month/i);
  if (monthlyMatch) {
    return { frequency: "monthly", day: monthlyMatch[1], time: time || "08:00" };
  }

  const weeklyMatch = text.match(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
  if (weeklyMatch) {
    const day = weeklyMatch[1].charAt(0).toUpperCase() + weeklyMatch[1].slice(1);
    return { frequency: "weekly", day, time: time || null };
  }

  const dailyMatch = text.match(/every\s+day/i);
  if (dailyMatch) {
    return { frequency: "daily", day: null, time: time || null };
  }

  return { frequency: null, day: null, time: null };
}

function buildLocalPaymentPlan(rows, instruction, options = {}) {
  const schedule = parseScheduleFromInstruction(instruction);
  const batchId = options.batchId || `batch_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  const payments = (rows || []).map((r, index) => {
    const isSolana = r.chain === "solana" || (r.wallet_address && isSolanaAddress(r.wallet_address));
    const isEvm = (r.wallet_address && r.wallet_address.startsWith("0x")) || r.chain === "arc" || r.chain === "evm";
    const isOfframp = r.method === "fiat_offramp" || (!isSolana && !isEvm && (r.account_number || r.bank_name || r.currency === "NGN"));

    let method = "onchain_evm";
    let chain = "arc";
    let to = r.wallet_address;

    if (isOfframp) {
      method = "fiat_offramp";
      chain = "fiat";
      to = "__offramp__";
    } else if (isSolana) {
      method = "onchain_solana";
      chain = "solana";
      to = r.wallet_address;
    } else {
      method = "onchain_evm";
      chain = r.chain || "arc";
      to = r.wallet_address || "__offramp__";
    }

    const item = {
      to,
      amount: parseAmountValue(r.amount),
      label: r.description || r.name || "Payment",
      bank_name: r.bank_name || null,
      bank_code: r.bank_code || null,
      account_number: r.account_number || null,
      account_name: r.account_name || r.name || null,
      currency: r.currency || (isOfframp ? "NGN" : "USDC"),
      method,
      chain,
      id: r.id || null,
    };

    item.idempotency_key = r.idempotency_key || generateIdempotencyKey(batchId, index, item);
    return item;
  }).filter((payment) => payment.amount > 0);

  const type = schedule.frequency ? "scheduled" : (payments.length === 1 ? "one_time" : "bulk");
  const summary = schedule.frequency
    ? `Pay ${payments.length} recipient${payments.length !== 1 ? "s" : ""} ${schedule.day ? `on ${schedule.day}` : ""}${schedule.time ? ` at ${schedule.time}` : ""}.`
    : `Process ${payments.length} recipient${payments.length !== 1 ? "s" : ""}.`;

  return { type, payments, schedule, summary, batchId };
}

// ─── PPTX extraction (slide text) ───────────────────────────────────────────
async function parsePptx(buffer) {
  try {
    const JSZip = require("jszip");
    const zip = await JSZip.loadAsync(buffer);
    const slideFiles = Object.keys(zip.files).filter(f => f.match(/^ppt\/slides\/slide[0-9]+\.xml$/i)).sort();
    const slides = [];
    for (const sf of slideFiles) {
      const content = await zip.files[sf].async("string");
      const texts = [];
      const re = /<a:t[^>]*>(.*?)<\/a:t>/gms;
      let m;
      while ((m = re.exec(content)) !== null) texts.push(m[1]);
      slides.push(texts.join(" "));
    }
    const raw = slides.join("\n\n");
    if (!raw || raw.trim().length < 20) {
      return { type: "unknown", rows: [], total: 0, currency: null, error: "PPTX appears empty or contains images only." };
    }
    return await structureWithLLM(raw, "pptx");
  } catch (err) {
    console.error("[file_parser/pptx]", err.message || err);
    return { type: "unknown", rows: [], total: 0, currency: null, error: "Could not read the PPTX file." };
  }
}

async function parseDocx(buffer) {
  try {
    const JSZip = require("jszip");
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = zip.file("word/document.xml");
    if (!documentXml) {
      return { type: "unknown", rows: [], total: 0, currency: null, error: "DOCX appears empty or unsupported." };
    }

    const content = await documentXml.async("string");
    const texts = [];
    const re = /<w:t[^>]*>(.*?)<\/w:t>/gms;
    let match;
    while ((match = re.exec(content)) !== null) {
      texts.push(match[1]);
    }

    const raw = texts.join(" ");
    if (!raw || raw.trim().length < 20) {
      return { type: "unknown", rows: [], total: 0, currency: null, error: "DOCX appears empty or contains non-text content." };
    }

    return await structureWithLLM(raw, "DOCX");
  } catch (err) {
    console.error("[file_parser/docx]", err.message || err);
    return { type: "unknown", rows: [], total: 0, currency: null, error: "Could not read the DOCX file." };
  }
}

async function parseTextFile(buffer) {
  try {
    const raw = buffer.toString("utf8");
    if (!raw || raw.trim().length < 20) {
      return { type: "unknown", rows: [], total: 0, currency: null, error: "Text file appears empty." };
    }
    return await structureWithLLM(raw, "text file");
  } catch (err) {
    console.error("[file_parser/text]", err.message || err);
    return { type: "unknown", rows: [], total: 0, currency: null, error: "Could not read the text file." };
  }
}

async function buildFilePaymentPlan(rows, instruction, userContext = {}) {
  const trimmed = String(instruction || "").trim();
  if (!trimmed || !rows || rows.length === 0) {
    return null;
  }

  const batchId = userContext.batchId || `batch_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  const systemPrompt = `You are a payment planning assistant for PayIT, a Nigerian multi-chain and fiat wallet bot.

Users attach files containing payroll/payment rows and instructions.
Each row can specify payment in Nigerian Naira (NGN bank transfer) or on-chain (Arc EVM USDC/EURC or Solana USDC).

Your job is to return a structured payment plan in JSON only, no markdown, no explanation.

Rows have: name, wallet_address, bank_name, bank_code, account_number, account_name, amount, currency, description, chain, method.

Rules:
- If a row has an EVM 0x wallet address, set "to" to that address, "chain" to "arc", and "method" to "onchain_evm".
- If a row has a Solana Base58 address, set "to" to that address, "chain" to "solana", and "method" to "onchain_solana".
- If a row has bank details (account_number, bank_name) or currency is NGN, set "to" to "__offramp__", "chain" to "fiat", and "method" to "fiat_offramp".
- Keep currency from the row (NGN, USDC, EURC).
- If the instruction is a recurring payment, set schedule.frequency to "monthly", "weekly", or "daily" and set schedule.day/time when specified.
- If the instruction says "every 30th of the month", use { "frequency": "monthly", "day": "30", "time": "08:00" } unless another time is specified.
- Return exactly this JSON schema:
{
  "type": "one_time" | "scheduled" | "split" | "bulk" | "offramp" | "scheduled_offramp",
  "payments": [
    {
      "to": "<0x address, Solana address, or __offramp__>",
      "amount": <number>,
      "label": "<short description>",
      "bank_name": "<bank name or null>",
      "bank_code": "<6-digit NIBSS code or null>",
      "account_number": "<account number or null>",
      "account_name": "<beneficiary name or null>",
      "currency": "<USDC | EURC | NGN | USD | EUR>",
      "method": "<onchain_evm | onchain_solana | fiat_offramp>",
      "chain": "<arc | solana | fiat>"
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
    bank_code: r.bank_code || null,
    account_number: r.account_number || null,
    account_name: r.account_name || null,
    amount: parseAmountValue(r.amount),
    currency: r.currency || null,
    chain: r.chain || null,
    method: r.method || null,
    description: r.description || null,
  })), null, 2);

  try {
    const plan = await getJSONCompletion(systemPrompt, `Instruction: ${trimmed}\n\nRows: ${rowsText}`);
    if (plan && Array.isArray(plan.payments) && plan.payments.length >= 0) {
      plan.batchId = batchId;
      plan.payments = plan.payments.map((p, idx) => {
        const item = { ...p };
        item.idempotency_key = item.idempotency_key || generateIdempotencyKey(batchId, idx, item);
        return item;
      });
      return plan;
    }
    return buildLocalPaymentPlan(rows, instruction, { batchId });
  } catch (err) {
    console.error("[file_parser/buildFilePaymentPlan]", err.message || err);
    return buildLocalPaymentPlan(rows, instruction, { batchId });
  }
}

// ─── PDF extraction ───────────────────────────────────────────────────────────

async function extractPdfText(buffer) {
  const pdfParse = require("pdf-parse");
  const data = await pdfParse(buffer);
  return data.text;
}

// ─── Excel / CSV extraction ───────────────────────────────────────────────────

async function parseSpreadsheet(buffer, isCSV = false) {
  const XLSX = require("xlsx");
  try {
    const input = isCSV ? buffer.toString("utf8") : buffer;
    const workbook = XLSX.read(input, { type: isCSV ? "string" : "buffer", raw: false, cellDates: true });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return { headers: [], rows: [] };

    const worksheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "" });
    if (!rawRows || rawRows.length === 0) return { headers: [], rows: [] };

    const headerRow = rawRows[0].map((v) => String(v || ""));
    const rows = [];

    for (let rowIndex = 1; rowIndex < rawRows.length; rowIndex += 1) {
      const row = rawRows[rowIndex];
      const obj = {};
      headerRow.forEach((header, colIndex) => {
        obj[header] = String(row[colIndex] || "");
      });
      if (Object.keys(obj).some((k) => obj[k])) rows.push(obj);
    }

    return { headers: headerRow, rows };
  } catch (err) {
    console.error("[file_parser/spreadsheet] error:", err.message);
    throw err;
  }
}

/**
 * Maps spreadsheet rows to payment records using column name heuristics.
 * Understands preferred payout rails: NGN bank transfers, Arc EVM, and Solana.
 */
function mapSpreadsheetRows(rows) {
  const normalise = (s) => String(s).toLowerCase().replace(/[\s_-]/g, "");

  const ALIASES = {
    name:           ["name", "recipient", "payee", "employee", "staff", "to", "beneficiary"],
    wallet_address: ["wallet", "address", "walletaddress", "0x", "pubkey", "publickey", "cryptoaddress", "destination", "payoutdetail"],
    bank_name:      ["bank", "bankname", "institution"],
    account_number: ["account", "acct", "accountnumber", "acctnumber", "nuban", "accountno", "acctno"],
    account_name:   ["accountname", "acctname", "accountholder"],
    amount:         ["amount", "usdc", "value", "pay", "salary", "sum", "total", "netpay", "net"],
    currency:       ["currency", "token", "ccy", "curr"],
    description:    ["description", "note", "reason", "for", "purpose", "memo", "dept", "department", "role"],
    chain:          ["chain", "network", "blockchain", "rail"],
    method:         ["method", "payoutmethod", "type", "paymentmethod", "channel", "mode", "preferred"],
    bank_code:      ["bankcode", "sortcode", "nibss"],
    id:             ["id", "employeeid", "ref", "reference", "staffid"],
    idempotency_key:["idempotencykey", "idemp"],
  };

  if (!rows || rows.length === 0) return null;

  // Collect all unique column headers across rows
  const allCols = new Set();
  rows.forEach((r) => Object.keys(r).forEach((k) => allCols.add(k)));

  const colMap = {};
  // Pass 1: exact matches
  allCols.forEach((col) => {
    const n = normalise(col);
    for (const [field, aliases] of Object.entries(ALIASES)) {
      if (aliases.some((a) => n === a)) {
        colMap[col] = field;
        break;
      }
    }
  });

  // Pass 2: substring matches for unmapped columns
  allCols.forEach((col) => {
    if (colMap[col]) return;
    const n = normalise(col);
    for (const [field, aliases] of Object.entries(ALIASES)) {
      if (aliases.some((a) => a.length >= 4 && n.includes(a))) {
        colMap[col] = field;
        break;
      }
    }
  });

  const mappedFields = new Set(Object.values(colMap));
  if (!mappedFields.has("name") || !mappedFields.has("amount")) return null;

  return rows.map((row) => {
    const record = {
      name: "",
      wallet_address: null,
      bank_name: null,
      bank_code: null,
      account_number: null,
      account_name: null,
      amount: 0,
      currency: "USDC",
      chain: null,
      method: null,
      description: null,
      id: null,
      idempotency_key: null,
    };

    for (const [col, field] of Object.entries(colMap)) {
      const val = row[col];
      if (val === "" || val === undefined || val === null) continue;
      const strVal = String(val).trim();

      if (field === "amount") {
        record.amount = parseAmountValue(strVal);
        if (strVal.includes("₦") || strVal.toUpperCase().includes("NGN")) {
          record.currency = "NGN";
        } else if (strVal.includes("€") || strVal.toUpperCase().includes("EUR")) {
          record.currency = "EURC";
        }
      } else if (field === "currency") {
        const c = strVal.toUpperCase();
        if (c.includes("NGN") || c.includes("NAIRA") || c === "₦") record.currency = "NGN";
        else if (c.includes("EUR")) record.currency = "EURC";
        else if (c.includes("USDC") || c.includes("USD") || c === "$") record.currency = "USDC";
        else record.currency = c;
      } else {
        record[field] = strVal;
      }
    }

    // Auto-detect destination details if user passed an address or account
    const candidateDest = record.wallet_address;
    if (candidateDest) {
      if (candidateDest.startsWith("0x") && candidateDest.length === 42) {
        record.chain = "arc";
        record.method = "onchain_evm";
      } else if (isSolanaAddress(candidateDest)) {
        record.chain = "solana";
        record.method = "onchain_solana";
      } else if (/^\d{10}$/.test(candidateDest)) {
        record.account_number = candidateDest;
        record.wallet_address = null;
        record.chain = "fiat";
        record.method = "fiat_offramp";
      }
    }

    // Classify rail if specified in method or chain columns
    const normMethod = (record.method || "").toLowerCase();
    const normChain = (record.chain || "").toLowerCase();

    if (normChain.includes("sol") || normMethod.includes("sol")) {
      record.chain = "solana";
      record.method = "onchain_solana";
    } else if (normChain.includes("arc") || normChain.includes("evm") || normChain.includes("eth") || normChain.includes("onchain") || normMethod.includes("onchain")) {
      record.chain = "arc";
      record.method = "onchain_evm";
    } else if (normMethod.includes("bank") || normMethod.includes("fiat") || normMethod.includes("naira") || normChain.includes("fiat") || normChain.includes("bank") || record.currency === "NGN") {
      record.chain = "fiat";
      record.method = "fiat_offramp";
    }

    // If destination has bank details and no on-chain address
    if (!record.wallet_address && (record.account_number || record.bank_name)) {
      record.chain = "fiat";
      record.method = "fiat_offramp";
    }

    return record;
  }).filter((r) => r.name && r.amount > 0);
}

// ─── LLM structuring fallback ─────────────────────────────────────────────────

async function structureWithLLM(rawText, fileType) {
  const systemPrompt = `You are a payroll and bulk payment extraction assistant for PayIT.
Extract payment records from the following ${fileType} content.
Supports multi-rail payments: Nigerian Bank (NGN), Arc EVM (USDC/EURC), and Solana (USDC).

Return ONLY valid JSON:
{
  "type": "payroll" | "bulk_payment" | "invoice" | "expense_list" | "unknown",
  "rows": [
    {
      "name": "<recipient name>",
      "wallet_address": "<0x address or Solana Base58 address or null>",
      "bank_name": "<bank name or null>",
      "bank_code": "<6-digit NIBSS code or null>",
      "account_number": "<account number or null>",
      "account_name": "<account holder name or null>",
      "amount": <numeric>,
      "currency": "<NGN | USDC | EURC | USD>",
      "chain": "<arc | solana | fiat | null>",
      "method": "<onchain_evm | onchain_solana | fiat_offramp | null>",
      "description": "<role or note or null>"
    }
  ],
  "total": <sum of all amounts>,
  "currency": "<dominant currency>",
  "error": null
}

Rules:
- If a row contains a Solana address, set chain to "solana" and method to "onchain_solana".
- If a row contains a 0x EVM address, set chain to "arc" and method to "onchain_evm".
- If a row contains a bank account or NGN amount, set chain to "fiat" and method to "fiat_offramp".
- If no payment data is found, return { "type": "unknown", "rows": [], "total": 0, "currency": null, "error": "No payment records found." }`;

  return await getJSONCompletion(systemPrompt, rawText.slice(0, 8000));
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function parsePdf(buffer) {
  try {
    const text = await extractPdfText(buffer);
    if (!text || text.trim().length < 20) {
      return { type: "unknown", rows: [], total: 0, currency: null, error: "PDF appears to be empty or image-only." };
    }
    return await structureWithLLM(text, "PDF");
  } catch (err) {
    console.error("[file_parser/pdf]", err.message);
    return { type: "unknown", rows: [], total: 0, currency: null, error: "Could not read the PDF." };
  }
}

async function parseSpreadsheetFile(buffer, isCSV = false) {
  try {
    const { headers, rows } = await parseSpreadsheet(buffer, isCSV);
    if (rows.length === 0) {
      return { type: "unknown", rows: [], total: 0, currency: null, error: "The spreadsheet appears to be empty." };
    }

    const mapped = mapSpreadsheetRows(rows);
    if (mapped && mapped.length > 0) {
      const total = mapped.reduce((s, r) => s + r.amount, 0);
      const currency = mapped[0].currency || "USDC";
      return { type: "payroll", rows: mapped, total, currency, error: null };
    }

    const sample = rows.slice(0, 50);
    const text = `Headers: ${headers.join(", ")}\n\nData:\n${JSON.stringify(sample, null, 2)}`;
    return await structureWithLLM(text, "spreadsheet");
  } catch (err) {
    console.error("[file_parser/xlsx]", err.message);
    return { type: "unknown", rows: [], total: 0, currency: null, error: "Could not read the spreadsheet." };
  }
}

/**
 * Format the parsed file result as a Telegram confirmation message with multi-rail breakdown.
 */
function formatFilePreview(parsed, maxPreviewRows = 8) {
  if (parsed.error && (!parsed.rows || parsed.rows.length === 0)) {
    return `❌ ${parsed.error}`;
  }

  const typeLabel = {
    payroll:       "👥 Multi-Rail Payroll",
    bulk_payment:  "💸 Bulk Payment",
    invoice:       "🧾 Invoice",
    expense_list:  "📋 Expense List",
    unknown:       "📎 Document",
  }[parsed.type] || "👥 Multi-Rail Payroll";

  // Categorize rows by preferred rail
  const ngnRows = parsed.rows.filter(
    (r) => r.currency === "NGN" || r.method === "fiat_offramp" || (!r.wallet_address && r.account_number)
  );
  const solanaRows = parsed.rows.filter(
    (r) => r.chain === "solana" || r.method === "onchain_solana" || (r.wallet_address && isSolanaAddress(r.wallet_address))
  );
  const evmRows = parsed.rows.filter(
    (r) => !ngnRows.includes(r) && !solanaRows.includes(r)
  );

  const preview = parsed.rows.slice(0, maxPreviewRows).map((r, i) => {
    let railBadge = "⚡ Arc EVM";
    let dest = r.wallet_address ? `\`${r.wallet_address.slice(0, 6)}...${r.wallet_address.slice(-4)}\`` : "—";

    if (r.chain === "solana" || (r.wallet_address && isSolanaAddress(r.wallet_address))) {
      railBadge = "🟣 Solana";
      dest = `\`${r.wallet_address.slice(0, 6)}...${r.wallet_address.slice(-4)}\``;
    } else if (r.currency === "NGN" || r.account_number || r.method === "fiat_offramp") {
      railBadge = "🏦 Bank (NGN)";
      dest = `${r.bank_name || "Bank"} · \`${r.account_number || "—"}\``;
    }

    const formattedAmount = r.currency === "NGN"
      ? `₦${Number(r.amount).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} NGN`
      : `${Number(r.amount).toFixed(2)} ${r.currency || "USDC"}`;

    return `${i + 1}. *${r.name}* — ${formattedAmount}\n   ${railBadge} → ${dest}${r.description ? `\n   _${r.description}_` : ""}`;
  }).join("\n\n");

  const more = parsed.rows.length > maxPreviewRows
    ? `\n\n...and ${parsed.rows.length - maxPreviewRows} more recipients.`
    : "";

  // Summary breakdown
  const railSummary = [];
  if (ngnRows.length > 0) {
    const sumNgn = ngnRows.reduce((acc, r) => acc + (r.currency === "NGN" ? r.amount : 0), 0);
    railSummary.push(`🏦 Bank (NGN): ${ngnRows.length} recipients · ₦${sumNgn.toLocaleString("en-NG", { minimumFractionDigits: 2 })}`);
  }
  if (evmRows.length > 0) {
    const sumEvm = evmRows.reduce((acc, r) => acc + r.amount, 0);
    railSummary.push(`⚡ Arc EVM: ${evmRows.length} recipients · ${sumEvm.toFixed(2)} USDC`);
  }
  if (solanaRows.length > 0) {
    const sumSol = solanaRows.reduce((acc, r) => acc + r.amount, 0);
    railSummary.push(`🟣 Solana: ${solanaRows.length} recipients · ${sumSol.toFixed(2)} USDC`);
  }

  return (
    `*${typeLabel} Detected*\n` +
    `──────────────────────────\n` +
    `Total: ${parsed.rows.length} recipient${parsed.rows.length !== 1 ? "s" : ""}\n` +
    (railSummary.length > 0 ? `${railSummary.join("\n")}\n` : "") +
    `──────────────────────────\n\n` +
    `${preview}${more}\n\n` +
    `*Idempotency & Replay Protection:* Enabled\n` +
    `Confirm to execute payout across all preferred chains & accounts.`
  );
}

module.exports = {
  parsePdf,
  parseSpreadsheetFile,
  parsePptx,
  parseDocx,
  parseTextFile,
  buildFilePaymentPlan,
  buildLocalPaymentPlan,
  formatFilePreview,
  mapSpreadsheetRows,
};
