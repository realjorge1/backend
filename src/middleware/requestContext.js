// ============================================
// FILE: middleware/requestContext.js
// Reads the v2 client headers, gives every request a stable id, and echoes
// that id back. Nothing here blocks a request — a client that sends none of
// these headers is served exactly as before.
// ============================================
const crypto = require("crypto");
const apiConfig = require("../config/apiConfig");

// Client-supplied ids are echoed in a response header, so only accept a
// conservative character set and length.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Stable, non-reversible id for logs and document ownership. */
function hashUserId(userId) {
  if (!userId) return null;
  return crypto
    .createHash("sha256")
    .update(apiConfig.userHashSalt + String(userId))
    .digest("hex")
    .slice(0, 32);
}

/** Short form for log lines. */
function shortHash(hash) {
  return hash ? hash.slice(0, 12) : null;
}

function requestContext(req, res, next) {
  const incoming = req.get("X-Request-Id");
  req.requestId =
    incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader("X-Request-Id", req.requestId);

  req.appKey = req.get("X-App-Key") || null;
  req.userId = req.get("X-User-Id") || null;
  req.userHash = hashUserId(req.userId);
  req.clientVersion = req.get("X-Client-Version") || null;

  next();
}

module.exports = { requestContext, hashUserId, shortHash };
