// agent/voice_parser.js
// Transcribes voice notes (Telegram OGG/Voice or audio files) to text
// Uses OpenAI speech-to-text when `OPENAI_API_KEY` is set.

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getActiveProvider } = require('./ai_provider');

async function transcribeVoice(buffer, mimeType = 'audio/ogg') {
  // Mock transcription for offline tests
  if (process.env.USE_MOCK_AI === '1') {
    return { text: 'send $50 to Emeka' };
  }

  // Only OpenAI transcription is implemented for now
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[voice_parser] No ASR provider (OPENAI_API_KEY missing)');
    return { error: 'no_asr_provider', message: 'Voice transcription requires OPENAI_API_KEY. Set it in .env or continue typing.' };
  }

  const OpenAI = require('openai');
  const clientOptions = { apiKey: process.env.OPENAI_API_KEY };
  if (process.env.OPENAI_BASE_URL) clientOptions.baseURL = process.env.OPENAI_BASE_URL;
  const client = new OpenAI(clientOptions);
  const model  = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

  // Write a temp file so the SDK can stream from disk
  const tmpDir = os.tmpdir();
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp3') ? 'mp3' : 'm4a';
  const tmpPath = path.join(tmpDir, `payit_voice_${Date.now()}.${ext}`);

  try {
    await fs.promises.writeFile(tmpPath, buffer);
    const stream = fs.createReadStream(tmpPath);
    // openai SDK: client.audio.transcriptions.create
    const res = await client.audio.transcriptions.create({ file: stream, model });
    // Remove file and return
    try { await fs.promises.unlink(tmpPath); } catch (_) {}
    console.log(`[voice_parser] Transcribed ${(buffer.length/1024).toFixed(1)}KB to ${(res.text || '').length} chars`);
    return { text: res.text };
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch (_) {}
    const errMsg = err.message?.slice(0, 100) || String(err).slice(0, 100);
    console.error(`[voice_parser] Transcription failed (${model}):`, errMsg);
    return { error: 'transcription_failed', message: `Could not transcribe audio. Please try again or type the message manually.` };
  }
}

module.exports = { transcribeVoice };
