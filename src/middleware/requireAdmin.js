// ============================================
// FILE: middleware/requireAdmin.js
// Bearer-token guard for operator-only routes. With no ADMIN_TOKEN set the
// route answers 404 — an unconfigured admin surface should look absent, not
// merely locked.
// ============================================
const crypto = require("crypto");
const apiConfig = require("../config/apiConfig");
const logger = require("../utils/logger");

function requireAdmin(req, res, next) {
  if (!apiConfig.adminToken) {
    return res.status(404).json({ error: "Not found" });
  }

  const header = req.get("Authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = crypto.createHash("sha256").update(presented).digest();
  const b = crypto.createHash("sha256").update(apiConfig.adminToken).digest();

  if (!crypto.timingSafeEqual(a, b)) {
    logger.warn("admin_rejected", {
      requestId: req.requestId,
      route: `${req.method} ${req.originalUrl}`,
    });
    return res.status(401).json({
      success: false,
      code: "UNAUTHORIZED",
      error: "Invalid admin token.",
    });
  }

  return next();
}

module.exports = { requireAdmin };
