// tests/integration_demo.js
// Simple deterministic demo that uses USE_MOCK_AI=1 to exercise the intent
// classifier, orchestrator parsing, spreadsheet mapping, and voice parsing.

process.env.USE_MOCK_AI = '1';

const { classifyIntent, getMissingQuestion, buildConfirmationText } = require('../agent/intent_router');
const { parsePaymentIntent } = require('../agent/orchestrator');
const { mapSpreadsheetRows } = require('../agent/file_parser');
const { transcribeVoice } = require('../agent/voice_parser');

async function run() {
  console.log('--- Intent classifier demo');
  const c1 = await classifyIntent('Send $50 to Emeka', 123, {});
  console.log('Input: Send $50 to Emeka');
  console.log('Classified:', JSON.stringify(c1, null, 2));
  console.log('Missing question:', getMissingQuestion(c1));

  console.log('\n--- Orchestrator demo');
  const p = await parsePaymentIntent('Send $75 to 0xabc0000000000000000000000000000000000000', {});
  console.log('Parsed plan:', JSON.stringify(p, null, 2));

  console.log('\n--- Spreadsheet mapping demo');
  const rows = [
    { "Name": "Amaka", "Amount": "100", "Account": "0123456789" },
    { "Name": "Bayo",  "Amount": "150", "Account": "0987654321" },
  ];
  const mapped = mapSpreadsheetRows(rows);
  console.log('Mapped rows:', JSON.stringify(mapped, null, 2));

  console.log('\n--- Voice transcription demo');
  const t = await transcribeVoice(Buffer.from(''), 'audio/ogg');
  console.log('Transcribed text:', t.text);
}

run().catch(err => { console.error(err); process.exit(1); });
