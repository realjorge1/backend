// ============================================
// FILE: ai/mountAiApi.js
// Single definition of how the AI API is mounted, so the server and the
// tests always agree on the middleware chain in front of /api/ai.
// ============================================
const { requestContext } = require("../middleware/requestContext");
const { aiTelemetry } = require("../middleware/aiTelemetry");
const { aiAuth } = require("../middleware/aiAuth");
const { aiLimiters, extractLimiters } = require("../middleware/aiRateLimit");
const { proofreadLimiters } = require("../middleware/proofreadRateLimit");

// Upload-heavy routes carry an extra hourly limit.
const EXTRACT_ROUTES = [
  "/api/ai/extract-document",
  "/api/ai/extract-pdf",
  "/api/ai/ocr-scan",
];

// The typing-debounce route: tighter buckets, a character budget and a
// concurrency cap of its own (see middleware/proofreadRateLimit.js).
const PROOFREAD_ROUTE = "/api/ai/proofread";

/**
 * Mount the AI router and everything that guards it onto an Express app.
 * Order matters: context first (so every later layer can log a request id),
 * then telemetry, then rate limits, then auth, then the router.
 * @param {import("express").Express} app
 */
function mountAiApi(app) {
  app.use("/api/ai", requestContext);
  app.use("/api/ai", aiTelemetry);
  app.use("/api/ai", ...aiLimiters);
  app.use(EXTRACT_ROUTES, ...extractLimiters);
  app.use(PROOFREAD_ROUTE, ...proofreadLimiters);
  app.use("/api/ai", aiAuth);
  app.use("/api/ai", require("../routes/aiRoutes"));
}

module.exports = { mountAiApi, EXTRACT_ROUTES, PROOFREAD_ROUTE };
