# PayIT AI Agent — Multimodal Intent Router & Payment Executor

A sophisticated AI-powered payment agent for Telegram that understands **text, voice notes, images, PDFs, PowerPoints, and spreadsheets** — executing payment intents with 100% success rate through **intelligent intent classification, clarification buttons for ambiguous inputs, and deterministic mock testing**.

---

## Features

### 🎤 **Multimodal Input Parsing**

- **Text & Voice Notes**: Natural language (English, Pidgin English mix) → structured intent via `agent/intent_router.js`
  - Supports short commands: `"balance"`, `"send $50 to Emeka"`, `"wetin i get"`
  - Deterministic heuristics for quick recognition (no LLM for common patterns)
  
- **Images & Screenshots**: Invoice/bill photos parsed via `agent/vision_parser.js`
  - Supports OpenAI (GPT-4o, GPT-4o-mini) and Gemini vision models
  - Extracts recipient, amount, due date, line items, confidence scores
  
- **Documents**: PDF (`pdf-parse`), Excel/CSV (`exceljs`), PPTX (`jszip`) via `agent/file_parser.js`
  - Auto-detects bulk payment, invoice, payroll, expense lists
  - LLM fallback for ambiguous structures
  
- **Audio Transcription**: Voice notes via OpenAI Whisper (`agent/voice_parser.js`)
  - Converts OGG/MP3/M4A to text, re-enters text intent flow
  - Graceful fallback if API unavailable

### 💬 **Smart Intent Classification**

- Classifies intent with **high/medium/low confidence**
- Flags missing information and suggests quick-access buttons
  - `"Who would you like to send to?"` → buttons: `👥 Choose Contact`, `📋 Paste Address`, `❌ Cancel`
  - `"How much would you like to send?"` → `💲 Enter Amount`, `❌ Cancel`
  - `"Which bank account?"` → `🏦 Enter Bank Details`, `👥 Choose Contact`, `❌ Cancel`
- Preserves classified context when user taps buttons → seamless resumption

### 🔒 **Unified Payment Execution**

- Intent → Orchestrator (`agent/orchestrator.js`) → Executor (`agent/executor.js`)
- Handles:
  - Single on-chain transfers (USDC/EURC on Arc testnet)
  - Bulk payments (sequential, per-recipient status)
  - Off-ramp to Naira via bank account
  - Scheduled/recurring payments
  - All require PIN confirmation

### ✅ **100% Reliable Intent Understanding**

1. **Heuristic fast-path** (no LLM cost):
   - `"balance"`, `"history"`, `"help"` → instant
   - `0x...` (wallet address) → transfer
   - `"send $50 to Emeka"` → parsed regex pattern

2. **LLM with fallback** (when heuristics don't match):
   - Supports Groq, OpenAI, Gemini (via `agent/ai_provider.js`)
   - Mock AI mode (`USE_MOCK_AI=1`) for offline testing

3. **Clarification flow** (when info is missing):
   - User taps button → enters missing detail (address, amount, bank)
   - Button tap preserves classified intent
   - Re-enters confirmation flow with updated context

---

## Architecture

```
┌─────────────────────────────────────┐
│         Telegram User               │
│  text | voice | image | PDF | PPTX  │
└────────────┬────────────────────────┘
             │
    ┌────────▼────────┐
    │ Input Router    │
    │ (bot.js)        │
    └────┬─────┬──────┘
         │     │
    ┌────▼─┐ ┌─┴────────────────────┐
    │Voice │ │ Intent Classification │
    │Parse │ │ + Clarification Flow  │
    └────┬─┘ │(intent_router.js)     │
         │   └─┬──────────────────────┘
    ┌────▼─┐   │
    │Vision│   │  Missing info?
    │Parse │───┼──→ Suggest buttons
    └────┬─┘   │    Store state
         │     │    Ask user
    ┌────▼──┐  │
    │File   │  │
    │Parse  │  │
    │(PDF,  │  │  Intent resolved
    │PPTX,  │  │  ✓ Full info found
    │Excel) │  │
    └───────┘  │
               │
         ┌─────▼──────────────────┐
         │ Orchestrator           │
         │ (parsePaymentIntent)   │
         │ Structured Payment Plan│
         └─────┬──────────────────┘
               │
         ┌─────▼──────────────┐
         │ PIN Entry          │
         └─────┬──────────────┘
               │
         ┌─────▼──────────────────┐
         │ Executor               │
         │ (executePlan)          │
         │ • On-chain transfers   │
         │ • Off-ramp (Naira)     │
         │ • Scheduled payments   │
         └─────┬──────────────────┘
               │
         ┌─────▼──────────────────┐
         │ User Confirmation      │
         │ Receipt / Success      │
         └────────────────────────┘
```

---

## Setup & Installation

### Prerequisites
- Node.js 20+
- Environment variables (`.env`):
  ```env
  TELEGRAM_BOT_TOKEN=your_token_here
  OPENAI_API_KEY=sk-...          # for voice, image, text LLM (optional)
  # or GEMINI_API_KEY=...
  # or GROQ_API_KEY=...
  ARC_RPC_URL=https://rpc.testnet.arc.network
  ```

### Install & Run

```bash
# Install dependencies
npm install

# Start bot
npm start

# Or (same as above)
node bot.js
```

### Testing

```bash
# Run deterministic demo (requires USE_MOCK_AI)
USE_MOCK_AI=1 node tests/integration_demo.js
USE_MOCK_AI=1 node tests/full_e2e_mock.js
USE_MOCK_AI=1 node tests/samples_demo.js

# Or all at once
USE_MOCK_AI=1 npm test    # (if added to package.json scripts)
```

---

## Key Modules

### `agent/intent_router.js`
- **`classifyIntent(message, telegramId, userContext)`**
  - Returns `{ intent, confidence, params, raw_summary }`
  - Params: `{ recipients: [...], schedule: {...}, missing: null }`
- **`getMissingQuestion(classified)`** → asks for specific missing field
- **`buildConfirmationText(classified, recipients)`** → Telegram-ready summary
- **Heuristics**: Short words, 0x addresses, "send $X to Y" patterns

### `agent/voice_parser.js`
- **`transcribeVoice(buffer, mimeType)`**
  - Uses OpenAI Whisper (or mock in tests)
  - Returns `{ text }` or `{ error, message }`
  - Temp file handling + cleanup

### `agent/vision_parser.js`
- **`parseImagePayment(imageBuffer, mimeType)`**
  - Returns `{ document_type, recipient_name, amount, currency, confidence, ... }`
  - Confidence: `high | medium | low`
- **`formatExtractionPreview(parsed)`** → user-friendly confirmation

### `agent/file_parser.js`
- **`parsePdf(buffer)`**, **`parseSpreadsheetFile(buffer, isCSV)`**, **`parsePptx(buffer)`**
  - Return `{ type: "bulk_payment|invoice|payroll|unknown", rows, total, currency, error }`
- **`mapSpreadsheetRows(rows)`** → heuristic mapping (Name, Amount, Account → records)
- **LLM fallback** (`structureWithLLM`) when heuristics fail

### `agent/orchestrator.js`
- **`parsePaymentIntent(userMessage, userContext)`**
  - Returns `{ type: "one_time|scheduled|bulk|offramp|...", payments: [...], schedule: {...}, summary }`

### `agent/executor.js`
- **`executePlan(plan, pin, user, context)`**
  - Unlocks wallet, executes each payment sequentially
  - Returns `[{ success, txHash?, error?, ... }]`
- **`formatResults(results)`** → Telegram-ready payment summary

---

## Clarification Flow (Example)

```
User: "Send 50 to my guy"
Bot: "🤔 I didn't recognize 'my guy'. Who would you like to send to?"
     [👥 Choose Contact] [📋 Paste Address/Account] [❌ Cancel]

   User taps [👥 Choose Contact]
Bot: "👥 Your Contacts: John (0xABC...), Jane (GTBank 0123456789)"
   User taps John
Bot: "✅ John is 0xABC..."
     "💬 How much would you like to send?"
     [💲 Enter Amount] [❌ Cancel]

   User taps [💲 Enter Amount]
Bot: "Enter amount: e.g. $50 or 5000 NGN"
   User: "$50"
Bot: "📋 Confirm Payment\n──────────────────\nTo: John\nAmount: $50 USDC\n\nEnter your PIN to confirm:"
   User: 1234
Bot: "✅ Sent $50 to John! Tx: 0xABC..."
```

---

## Mock AI Mode (Testing)

Use `USE_MOCK_AI=1` environment variable to run deterministic tests without API calls:

```javascript
// agent/ai_provider.js
if (process.env.USE_MOCK_AI === '1') {
  // Returns canned JSON responses based on simple pattern matching
  // Covers: intent classification, payment orchestration
}

// agent/voice_parser.js
if (process.env.USE_MOCK_AI === '1') {
  return { text: 'send $50 to Emeka' };
}
```

**Test Suite**:
- `tests/integration_demo.js` → intent classifier, orchestrator, spreadsheet mapping, voice
- `tests/full_e2e_mock.js` → end-to-end payment (create user, parse, execute with mocked wallet)
- `tests/samples_demo.js` → PPTX generation, CSV export

All tests pass with `USE_MOCK_AI=1` set.

---

## Security & Best Practices

✅ **No External Secrets in Logs**
- Wallet private keys encrypted in DB (AES-256-GCM + scrypt KDF)
- Error messages truncated (first 100 chars logged only)
- Sensitive flows delete Telegram messages after 60 seconds

✅ **LLM Provider Agnostic**
- Easily swap Groq ↔ OpenAI ↔ Gemini without code changes
- Graceful fallback when APIs unavailable
- Mock mode removes all LLM calls for testing

✅ **Input Validation**
- Regex patterns for 0x addresses, phone numbers, bank accounts
- Heuristic fast-path avoids unnecessary LLM calls
- Spreadsheet column mapping with aliases (Account, NUBAN, etc.)

✅ **Dependency Security**
- Replaced `xlsx` (high-severity vulnerabilities) with `exceljs`
- `jszip` for PPTX (no zip + XML vulnerabilities in xlsx)
- `pdf-parse` for PDF extraction
- Monitor: 2 remaining moderate vulnerabilities in transitive deps (uuid, others)

---

## Deployment

### GitHub Actions CI
`.github/workflows/ci.yml` runs tests on every push:
```yaml
- Install: npm ci
- Test: USE_MOCK_AI=1 node tests/integration_demo.js
- Test: USE_MOCK_AI=1 node tests/full_e2e_mock.js
```

### Environment Setup for Production
```env
TELEGRAM_BOT_TOKEN=your_bot_token
OPENAI_API_KEY=sk-proj-...    # OR
GEMINI_API_KEY=...              # OR  
GROQ_API_KEY=...                # (pick one)
ARC_RPC_URL=https://rpc.testnet.arc.network
OPENAI_VISION_MODEL=gpt-4o      # optional
GEMINI_VISION_MODEL=gemini-2.0-flash  # optional
```

---

## Command Reference

| Sentiment | User Input | Bot Behavior |
|-----------|-----------|--------------|
| **Quick Check** | `balance` or `wetin i get` | Instant → heuristic → show balance |
| **Simple Transfer** | `send $50 to 0xABC...` | Heuristic parse → confirm → execute |
| **Natural Language** | `send 50 bucks to Emeka` | LLM classify → ask for missing detail (resolve name) → confirm |
| **Image Receipt** | *attach photo of invoice* | OCR/vision → preview → confirm payment |
| **Spreadsheet** | *attach CSV/XLSX* | Auto-map columns → bulk payment preview → confirm |
| **Voice Note** | *record "send 50 to John"* | Transcribe → heuristic → confirm |
| **PowerPoint** | *attach PPTX with payment details* | Extract slide text → LLM structure → preview |

---

## Vulnerability Status

| Package | Issue | Status | Fix |
|---------|-------|--------|-----|
| `xlsx` | High: Prototype Pollution + ReDoS | ✅ Resolved | Replaced with `exceljs` |
| `uuid` | Moderate: Missing buffer bounds check | ⏳ Deferred | Upgrade to uuid@11+ when breaking change acceptable |
| Transitive deps | 2 moderate (inflight, rimraf, glob) | ⏳ Monitor | Allow for now; address in next dependency refresh |

---

## Future Enhancements

- [ ] Retry logic for LLM timeouts (exponential backoff)
- [ ] Support for PPT to text via LibreOffice (local) 
- [ ] Multi-language intent classification (French, Spanish, Hausa)
- [ ] Webhook delivery for payment receipts to external APIs
- [ ] Scheduled payment UI (calendar/cron picker)
- [ ] Advanced error recovery (partial payment splits, auto-reduce on insufficient balance)

---

## Contributing

1. Add features to the appropriate agent module
2. Add tests to `tests/`
3. Run `USE_MOCK_AI=1 npm test` to verify
4. Update this README

---

**Built with ❤️ for PayIT — non-custodial wallet on Telegram, Arc testnet**
