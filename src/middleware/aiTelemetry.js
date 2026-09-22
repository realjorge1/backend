// ============================================
// FILE: middleware/aiTelemetry.js
// One structured log line per AI request, and per-user token accounting.
//
// Never logs document text, questions, answers, keys or raw user ids — only
// the request id, route, status, latency, provider, token usage, chunk counts
// and a short hash of the user id.
// ============================================
const logger = require("../utils/logger");
const tokenBudget = require("../services/tokenBudget");
const { shortHash } = require("./requestContext");

function chunkCountOf(body) {
  if (!body || typeof body !== "object") return undefined;
  if (typeof body.chunkCount === "number") return body.chunkCount;
  if (Array.isArray(body.retrievedChunks)) return body.retrievedChunks.length;
  if (typeof body.data?.coverage?.chunkCount === "number") {
    return body.data.coverage.chunkCount;
  }
  return undefined;
}

function aiTelemetry(req, res, next) {
  const start = Date.now();
  let captured = null;

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    captured = body;
    return originalJson(body);
  };

  res.on("finish", () => {
    const usage = captured?.data?.usage || captured?.usage || null;
    const totalTokens = usage?.totalTokens || res.locals?.tokensUsed || 0;
    if (totalTokens) tokenBudget.record(req.userHash, totalTokens);

    logger.info("ai_request", {
      requestId: req.requestId,
      route: `${req.method} ${req.baseUrl || ""}${req.path}`,
      status: res.statusCode,
      latencyMs: Date.now() - start,
      provider: captured?.provider || res.locals?.provider || undefined,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      totalTokens: totalTokens || undefined,
      chunks: chunkCountOf(captured),
      user: shortHash(req.userHash),
      clientVersion: req.clientVersion || undefined,
    });
  });

  next();
}

module.exports = { aiTelemetry };
