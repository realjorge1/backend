// ============================================
// FILE: ai/capabilities.js
// What this instance can actually do, reported by GET /api/ai/status.
//
// Every flag is a live check against the code and configuration present on
// this server — never a hand-maintained constant — so a half-deployed pool
// can't advertise a feature one of its servers lacks.
// ============================================
const apiConfig = require("../config/apiConfig");

function safe(fn) {
  try {
    return Boolean(fn());
  } catch {
    return false;
  }
}

function getCapabilities() {
  return {
    docIdTasks: safe(
      () => typeof require("../services/aiService").resolveDocumentInput === "function",
    ),
    persistentDocs: safe(() => require("../services/docStore").isPersistent()),
    citationsV2: safe(
      () => typeof require("../services/citations").verifyCitations === "function",
    ),
    // The SSE helper only exists once the streaming routes ship, so requiring
    // it doubles as "are the /stream endpoints deployed here".
    streamChat: safe(
      () =>
        apiConfig.streaming.enabled &&
        typeof require("../utils/sse").openSse === "function" &&
        require("../services/aiProvider").supportsStreaming(),
    ),
    streamChatDocument: safe(
      () =>
        apiConfig.streaming.enabled &&
        typeof require("../utils/sse").openSse === "function" &&
        require("../services/aiProvider").supportsStreaming() &&
        typeof require("../services/documentChatService").chatWithDocumentStream ===
          "function",
    ),
    devilsAdvocate: safe(() =>
      require("../services/aiService").supportsTask("devils-advocate"),
    ),
    narrativeArc: safe(() =>
      require("../services/aiService").supportsTask("narrative-arc"),
    ),
    markdown: safe(() => require("../services/aiService").MARKDOWN_OUTPUT === true),
    authMode: apiConfig.authMode,
  };
}

module.exports = { getCapabilities };
