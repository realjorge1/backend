// ============================================
// FILE: ai/mountAiApi.js
// Single definition of how the AI API is mounted, so the server and the
// tests always agree on the middleware chain in front of /api/ai.
// ============================================

/**
 * Mount the AI router (and everything that guards it) onto an Express app.
 * @param {import("express").Express} app
 */
function mountAiApi(app) {
  app.use("/api/ai", require("../routes/aiRoutes"));
}

module.exports = { mountAiApi };
