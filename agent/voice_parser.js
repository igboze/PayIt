// agent/voice_parser.js
// Transcribes voice notes (Telegram OGG/Voice or audio files) to text
// Supports OpenAI Whisper, Groq Whisper (ultra-fast), and Google Gemini (native audio understanding).

require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getActiveProvider } = require("./ai_provider");

async function transcribeVoice(buffer, mimeType = "audio/ogg") {
  // Mock transcription for offline tests
  if (process.env.USE_MOCK_AI === "1") {
    return { text: "send $50 to Emeka" };
  }

  const provider = getActiveProvider();
  if (!provider) {
    console.warn("[voice_parser] No AI provider configured");
    return {
      error: "no_asr_provider",
      message: "Voice transcription requires an AI provider (OPENAI_API_KEY, GROQ_API_KEY, or GEMINI_API_KEY). Type your message instead.",
    };
  }

  // ── 1. Groq Whisper (Ultra-fast speech-to-text) ──
  if (provider === "groq" || (process.env.GROQ_API_KEY && !process.env.OPENAI_API_KEY)) {
    try {
      const Groq = require("groq-sdk");
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const tmpDir = os.tmpdir();
      const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp3") ? "mp3" : "m4a";
      const tmpPath = path.join(tmpDir, `payit_voice_groq_${Date.now()}.${ext}`);

      await fs.promises.writeFile(tmpPath, buffer);
      const stream = fs.createReadStream(tmpPath);

      const translation = await groq.audio.transcriptions.create({
        file: stream,
        model: "whisper-large-v3",
      });

      try { await fs.promises.unlink(tmpPath); } catch (_) {}
      console.log(`[voice_parser] Groq Whisper transcribed to ${translation.text?.length || 0} chars`);
      return { text: translation.text || "" };
    } catch (groqErr) {
      console.warn("[voice_parser] Groq transcription error:", groqErr.message);
    }
  }

  // ── 2. Google Gemini Native Audio Understanding ──
  if (provider === "gemini" || (process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY)) {
    try {
      const { GoogleGenerativeAI } = require("@google/generative-ai");
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

      const audioPart = {
        inlineData: {
          data: buffer.toString("base64"),
          mimeType: mimeType || "audio/ogg",
        },
      };

      const prompt = "Transcribe the spoken audio message verbatim. Return only the plain transcribed text without markdown formatting or introductory commentary.";
      const result = await model.generateContent([prompt, audioPart]);
      const text = result.response.text().trim();
      console.log(`[voice_parser] Gemini transcribed to ${text.length} chars`);
      return { text };
    } catch (geminiErr) {
      console.warn("[voice_parser] Gemini transcription error:", geminiErr.message);
    }
  }

  // ── 3. OpenAI / NVIDIA Whisper ──
  if (process.env.OPENAI_API_KEY) {
    const OpenAI = require("openai");
    const clientOptions = { apiKey: process.env.OPENAI_API_KEY };
    if (process.env.OPENAI_BASE_URL) clientOptions.baseURL = process.env.OPENAI_BASE_URL;
    const client = new OpenAI(clientOptions);
    const configuredModel = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";

    const tmpDir = os.tmpdir();
    const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp3") ? "mp3" : "m4a";
    const tmpPath = path.join(tmpDir, `payit_voice_openai_${Date.now()}.${ext}`);

    try {
      await fs.promises.writeFile(tmpPath, buffer);
      const stream = fs.createReadStream(tmpPath);
      const res = await client.audio.transcriptions.create({ file: stream, model: configuredModel });
      try { await fs.promises.unlink(tmpPath); } catch (_) {}
      return { text: res.text || "" };
    } catch (err) {
      try { await fs.promises.unlink(tmpPath); } catch (_) {}
      console.error("[voice_parser] OpenAI transcription error:", err.message);
    }
  }

  return {
    error: "transcription_failed",
    message: "Could not transcribe audio with configured AI providers. Please type the message manually.",
  };
}

module.exports = { transcribeVoice };
