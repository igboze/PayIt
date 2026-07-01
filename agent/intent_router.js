// agent/intent_router.js
// The primary text handler for the agentic layer.
//
// Every message that isn't caught by a specific bot.hears() or bot.command()
// passes through here first. The router classifies the intent, resolves
// any named payees from the payee book, then either:
//   a) routes to the appropriate handler (transfer, offramp, invoice, etc.)
//   b) asks a single clarifying question if something is missing
//   c) falls back to a general AI response if intent is unclear
//
// Intent types (mirrors orchestrator.js + adds new ones):
//   transfer        — send USDC/EURC on-chain
//   offramp         — cash out to Naira
//   bulk_transfer   — multiple recipients in one instruction
//   scheduled       — recurring payment
//   balance         — check balance
//   history         — transaction history
//   invoice_create  — create an invoice
//   invoice_list    — list invoices
//   save_payee      — "save 0xABC as Emeka"
//   list_payees     — "show my contacts"
//   delete_payee    — "remove Emeka from contacts"
//   expense_log     — log a business expense
//   cash_flow       — show cash flow summary
//   help            — general help / what can you do
//   unknown         — couldn't classify

const { getJSONCompletion } = require("./ai_provider");
const { resolvePayee }      = require("../src/payee_book");

// ─── Classification prompt ────────────────────────────────────────────────────

function buildClassifierPrompt(userContext) {
  return `You are the intent classifier for PayIT, a dollar wallet inside Telegram used by Nigerians.
Users may write in English, Pidgin English, or a mix of both.

Classify the user's message into one intent and extract the key parameters.

Return ONLY valid JSON — no markdown, no explanation:

{
  "intent": "<one of the intent types listed below>",
  "confidence": "high" | "medium" | "low",
  "params": {
    "recipients": [
      {
        "name_or_address": "<wallet address, saved name, or person name mentioned>",
        "amount": <numeric or null>,
        "currency": "<USDC | EURC | NGN | USD | null>",
        "bank_name": "<bank name if offramp, or null>",
        "account_number": "<10-digit account number if offramp, or null>",
        "description": "<what this payment is for, or null>"
      }
    ],
    "schedule": {
      "frequency": "daily" | "weekly" | "monthly" | "once" | null,
      "day": "<day name or date, or null>",
      "time": "<HH:MM or null>"
    },
    "save_as": "<name to save payee as, or null>",
    "invoice_instruction": "<full invoice instruction if intent is invoice_create, or null>",
    "expense_description": "<full expense description if intent is expense_log, or null>",
    "missing": "<what information is still needed, or null>"
  },
  "raw_summary": "<one sentence plain English summary of what the user wants>"
}

Intent types:
- transfer         : send dollars/USDC/EURC to a wallet address or saved name
- offramp          : cash out / withdraw to Naira / bank account
- bulk_transfer    : send to multiple people in one message
- scheduled        : any payment with "every", "weekly", "monthly", "every Friday", etc.
- balance          : "how much do I have", "check balance", "wetin I get"
- history          : "show my transactions", "what did I spend", "last payments"
- invoice_create   : "invoice [name] for [amount]", "bill TechCorp", "create invoice"
- invoice_list     : "show my invoices", "list invoices", "unpaid invoices"
- save_payee       : "save [address/account] as [name]", "add [name] to contacts"
- list_payees      : "show contacts", "who do I have saved", "my payees"
- delete_payee     : "remove [name]", "delete [name] from contacts"
- expense_log      : "log expense", "I spent", "record payment of" (business context)
- cash_flow        : "cash flow", "how much did I earn", "this month's summary"
- help             : "what can you do", "help", "how does this work"
- unknown          : cannot classify with confidence

Pidgin English hints:
  "wetin I get" / "how much I get" → balance
  "send am" / "pay am" → transfer (resolve "am" to context if possible)
  "cash am out" / "convert am" → offramp
  "sharp sharp" → urgency, not an intent modifier
  "abeg" → polite request prefix, ignore for classification

User context: ${JSON.stringify(userContext)}`;
}

// ─── Main classification function ─────────────────────────────────────────────

/**
 * Classify a text message and resolve any named payees.
 *
 * @param {string} message      — raw user text
 * @param {number} telegramId   — used for payee resolution
 * @param {object} userContext  — { balance, address, active_context, ... }
 * @returns {Promise<object>}   — classified intent with resolved recipients
 */
async function classifyIntent(message, telegramId, userContext = {}) {
  let parsed;
  // Quick heuristic classifier for short inputs / obvious patterns to avoid
  // unnecessary LLM calls and make single-word commands 100% reliable.
  function quickClassify(msg) {
    const m = String(msg || "").trim();
    if (!m) return null;
    const low = m.toLowerCase();

    // Exact short commands
    if (low === "balance" || low === "bal" || low === "wetin i get" || low === "how much") {
      return { intent: "balance", confidence: "high", params: { recipients: [], schedule: {}, missing: null }, raw_summary: "Check balance" };
    }
    if (low === "history" || low === "transactions" || low === "txs") {
      return { intent: "history", confidence: "high", params: { recipients: [], schedule: {}, missing: null }, raw_summary: "Show recent transactions" };
    }
    if (low === "help" || low === "what can you do" || low === "commands") {
      return { intent: "help", confidence: "high", params: { recipients: [], schedule: {}, missing: null }, raw_summary: "Help" };
    }
    if (low === "invoices" || low === "invoice list" || low === "my invoices") {
      return { intent: "invoice_list", confidence: "high", params: { recipients: [], schedule: {}, missing: null }, raw_summary: "List invoices" };
    }
    if (low === "contacts" || low === "payees" || low === "list payees") {
      return { intent: "list_payees", confidence: "high", params: { recipients: [], schedule: {}, missing: null }, raw_summary: "List contacts" };
    }

    // 0x address alone -> transfer (recipient known, amount missing)
    const addrMatch = m.match(/^0x[a-fA-F0-9]{40}$/);
    if (addrMatch) {
      return {
        intent: "transfer",
        confidence: "high",
        params: { recipients: [{ name_or_address: m, amount: null, currency: null }], schedule: {}, missing: null },
        raw_summary: `Send to ${m}`,
      };
    }

    // Cash out shorthand
    if (/^(cash out|withdraw|withdrawal)/i.test(m) || m.includes("cash out") || m.includes("withdraw")) {
      return {
        intent: "offramp",
        confidence: "high",
        params: {
          recipients: [{
            name_or_address: null,
            amount: null,
            currency: null,
            bank_name: null,
            account_number: null,
            account_name: null,
          }],
          schedule: {},
          missing: null,
        },
        raw_summary: "Cash out to Naira",
      };
    }

    // Simple "send $50 to Emeka" pattern
    const sendMatch = m.match(/^send\s+\$?(\d+(?:\.\d+)?)\s+to\s+(.+)$/i);
    if (sendMatch) {
      return {
        intent: "transfer",
        confidence: "high",
        params: { recipients: [{ name_or_address: sendMatch[2].trim(), amount: Number(sendMatch[1]), currency: "USDC" }], schedule: {}, missing: null },
        raw_summary: `Send $${sendMatch[1]} to ${sendMatch[2].trim()}`,
      };
    }

    return null;
  }

  const quick = quickClassify(message);
  if (quick) return quick;

  function containsKeyword(msg, keywords) {
    const lower = String(msg || "").toLowerCase();
    return keywords.some((keyword) => lower.includes(keyword));
  }

  function shouldRejectPaymentIntent(parsedIntent, msg) {
    const lower = String(msg || "").toLowerCase();
    if (parsedIntent === "offramp") {
      return !containsKeyword(lower, ["cash out", "withdraw", "naira", "bank", "account", "convert"]);
    }
    if (parsedIntent === "transfer" || parsedIntent === "bulk_transfer") {
      return !containsKeyword(lower, ["send", "pay", "transfer", "wallet", "address", "to", "payee"]);
    }
    if (parsedIntent === "scheduled") {
      return !containsKeyword(lower, ["every", "weekly", "monthly", "daily", "schedule", "repeat", "recurring"]);
    }
    if (parsedIntent === "invoice_create") {
      return !containsKeyword(lower, ["invoice", "bill", "due", "quote"]);
    }
    return false;
  }

  try {
    parsed = await getJSONCompletion(
      buildClassifierPrompt(userContext),
      message
    );

    if (parsed && parsed.intent && shouldRejectPaymentIntent(parsed.intent, message)) {
      return {
        intent: "unknown",
        confidence: "low",
        params: { recipients: [], schedule: {}, missing: null },
        raw_summary: message,
      };
    }
  } catch (err) {
    console.error("[intent_router] Classification failed:", err.message);
    return {
      intent:     "unknown",
      confidence: "low",
      params:     { recipients: [], schedule: {}, missing: null },
      raw_summary: message,
    };
  }

  // ── Resolve named payees ──────────────────────────────────────────────────
  if (parsed.params?.recipients?.length) {
    const resolved = [];
    for (const r of parsed.params.recipients) {
      const nameOrAddr = r.name_or_address;
      if (!nameOrAddr) { resolved.push(r); continue; }

      const payee = resolvePayee(telegramId, nameOrAddr);

      if (!payee) {
        // Unknown name — keep as-is, caller will handle
        resolved.push({ ...r, _resolved: false });
        continue;
      }

      if (Array.isArray(payee)) {
        // Multiple matches — caller needs to disambiguate
        resolved.push({ ...r, _resolved: false, _candidates: payee });
        continue;
      }

      // Single resolved payee — merge details
      resolved.push({
        ...r,
        _resolved:      true,
        name_or_address: payee.name,
        wallet_address:  r.wallet_address  || payee.wallet_address  || null,
        bank_name:       r.bank_name       || payee.bank_name       || null,
        account_number:  r.account_number  || payee.account_number  || null,
        account_name:    r.account_name    || payee.account_name    || null,
      });
    }
    parsed.params.recipients = resolved;
  }

  return parsed;
}

// ─── Clarification builder ────────────────────────────────────────────────────

/**
 * Given a classified intent with missing information, return the single most
 * important question to ask the user.
 *
 * @param {object} classified — result of classifyIntent
 * @returns {string|null}     — question text, or null if nothing is missing
 */
function getMissingQuestion(classified) {
  const { intent, params } = classified;
  const r = params?.recipients?.[0] || {};

  // Missing recipient
  if (["transfer", "offramp", "bulk_transfer", "scheduled"].includes(intent)) {
    if (!params.recipients?.length || !r.name_or_address) {
      return "Who would you like to send to? (Name from your contacts, or paste a wallet address / bank account number)";
    }
  }

  // Missing amount
  if (["transfer", "offramp", "scheduled"].includes(intent)) {
    if (!r.amount) return "How much would you like to send?";
  }

  // Offramp — missing bank details and no saved bank for this payee
  if (intent === "offramp") {
    if (!r.account_number) return "What's the bank account number to cash out to?";
    if (!r.bank_name)      return "Which bank is that account with?";
  }

  // Transfer — address unresolved and not a raw 0x
  if (intent === "transfer" && r._resolved === false && !r._candidates) {
    return `I don't have "${r.name_or_address}" in your contacts. What's their wallet address?`;
  }

  // Scheduled — missing frequency
  if (intent === "scheduled" && !params.schedule?.frequency) {
    return "How often should this run? (e.g. every Friday, monthly on the 1st, daily at 8am)";
  }

  // Invoice — missing instruction
  if (intent === "invoice_create" && !params.invoice_instruction) {
    return `Who are you invoicing and for how much? (e.g. "Invoice Acme 500 dollars for web design, due July 15")`;
  }

  // Save payee — missing address
  if (intent === "save_payee") {
    if (!r.wallet_address && !r.account_number) {
      return `What's the wallet address or bank account number for ${r.name_or_address || "this contact"}?`;
    }
    if (!params.save_as && !r.name_or_address) {
      return "What name should I save this contact as?";
    }
  }

  return null;
}

/**
 * Build a plain-English confirmation summary before PIN entry.
 * Used for transfer, offramp, and bulk_transfer intents.
 *
 * @param {object} classified
 * @param {object[]} resolvedRecipients — same as classified.params.recipients
 * @returns {string}
 */
function buildConfirmationText(classified, resolvedRecipients) {
  const { intent } = classified;

  if (intent === "balance")  return null;
  if (intent === "history")  return null;

  const lines = [];

  if (intent === "transfer" || intent === "bulk_transfer") {
    lines.push("📤 Payment Summary\n──────────────────────────");
    let total = 0;
    for (const r of resolvedRecipients) {
      const dest = r.wallet_address
        ? `\`${r.wallet_address.slice(0, 8)}...${r.wallet_address.slice(-6)}\``
        : r.name_or_address;
      lines.push(`• ${r.name_or_address || dest}  →  ${r.amount} ${r.currency || "USDC"}`);
      total += Number(r.amount) || 0;
    }
    if (resolvedRecipients.length > 1) {
      lines.push(`──────────────────────────\nTotal: ${total.toFixed(2)} ${resolvedRecipients[0]?.currency || "USDC"}`);
    }
  }

  if (intent === "offramp") {
    lines.push("💵 Cash Out Summary\n──────────────────────────");
    for (const r of resolvedRecipients) {
      lines.push(`Amount: ${r.amount} USDC`);
      if (r.bank_name)      lines.push(`Bank: ${r.bank_name}`);
      if (r.account_number) lines.push(`Account: ${r.account_number}`);
      if (r.account_name)   lines.push(`Name: ${r.account_name}`);
    }
    lines.push("(Naira rate shown at confirmation)");
  }

  if (intent === "scheduled") {
    const s = classified.params.schedule || {};
    const freq = s.frequency === "weekly"
      ? `every ${s.day || "week"}`
      : s.frequency === "monthly"
      ? `monthly on the ${s.day || "1st"}`
      : s.frequency || "on schedule";
    lines.push(`🔁 Scheduled Payment\n──────────────────────────`);
    for (const r of resolvedRecipients) {
      lines.push(`• ${r.name_or_address}  →  ${r.amount} ${r.currency || "USDC"}`);
    }
    lines.push(`Runs: ${freq}${s.time ? " at " + s.time : ""}`);
  }

  return lines.join("\n");
}

module.exports = { classifyIntent, getMissingQuestion, buildConfirmationText };
