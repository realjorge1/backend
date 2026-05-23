// ============================================
// FILE: config/aiConfig.js
// AI provider configuration — loaded from env vars
// ============================================
const path = require("path");

// Load .env.local as override for dev convenience (keys may live there)
try {
  require("dotenv").config({
    path: path.resolve(__dirname, "../../.env.local"),
    override: true,
  });
} catch (_) {
  /* ignore */
}

const aiConfig = {
  // Active provider — switch via env var
  provider: (process.env.AI_PROVIDER || "openai").toLowerCase().trim(),

  // Provider credentials & models
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
  },
  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    // Default model for all tasks except chat-with-document
    model: process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
    // Sonnet for chat-with-document (richer reasoning, multi-turn context)
    chatModel: process.env.CLAUDE_CHAT_MODEL || "claude-sonnet-4-6",
  },

  // Fallback: try other providers if primary fails
  enableFallback: process.env.ENABLE_FALLBACK === "true",
  fallbackProviders: process.env.FALLBACK_PROVIDERS
    ? process.env.FALLBACK_PROVIDERS.split(",").map((s) =>
        s.trim().toLowerCase(),
      )
    : ["openai", "gemini", "claude"],

  // Generation defaults
  maxTokens: parseInt(process.env.AI_MAX_TOKENS, 10) || 4000,
  temperature: parseFloat(process.env.AI_TEMPERATURE) || 0.7,

  // Safety limits
  requestTimeoutMs: parseInt(process.env.AI_TIMEOUT_MS, 10) || 60000,
  maxPromptLength: parseInt(process.env.AI_MAX_PROMPT_LENGTH, 10) || 100000,
  maxDocumentLength: parseInt(process.env.AI_MAX_DOCUMENT_LENGTH, 10) || 500000,
  maxRetries: parseInt(process.env.AI_MAX_RETRIES, 10) || 1,
};

module.exports = aiConfig;
