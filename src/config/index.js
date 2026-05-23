// ============================================
// FILE: config/index.js
// Centralized environment configuration
// ============================================
const path = require("path");
const os = require("os");

const config = {
  // Server
  port: parseInt(process.env.PORT, 10) || 5000,
  host: process.env.HOST || "0.0.0.0",
  env: process.env.NODE_ENV || "development",
  isDev: (process.env.NODE_ENV || "development") === "development",
  isProd: process.env.NODE_ENV === "production",

  // CORS
  frontendUrl: process.env.FRONTEND_URL || "*",

  // File uploads
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 50, // MB
  uploadTimeout: parseInt(process.env.UPLOAD_TIMEOUT_MS, 10) || 120000, // 2 min
  tempDir: process.env.TEMP_DIR || path.join(os.tmpdir(), "docu-assistant"),

  // AI
  aiProvider: process.env.AI_PROVIDER || "openai",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",

  // Request limits
  bodyLimit: process.env.BODY_LIMIT || "50mb",

  // Graceful shutdown timeout
  shutdownTimeout: parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 10000,
};

// Derived values
config.maxFileSizeBytes = config.maxFileSize * 1024 * 1024;

module.exports = config;
