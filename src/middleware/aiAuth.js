// ============================================
// FILE: middleware/aiAuth.js
// App-key and premium-entitlement checks for /api/ai.
//
// AUTH_MODE=off      nothing is checked
// AUTH_MODE=monitor  everything is checked and logged, nothing is blocked
// AUTH_MODE=enforce  a bad app key is 401, a non-premium user is 403
//
// GET /status is always exempt so the app can discover capabilities before it
// has an app key.
// ============================================
const crypto = require("crypto");
const apiConfig = require("../config/apiConfig");
const logger = require("../utils/logger");
const { checkPremium } = require("../services/entitlements");
const { shortHash } = require("./requestContext");

// Rolling counters for GET /api/ai/admin/auth-stats.
const WINDOW_MS = 24 * 60 * 60 * 1000;
const events = [];

function recordEvent(event) {
  const now = Date.now();
  events.push({ ...event, at: now });
  // Drop anything older than the window (and keep memory bounded).
  while (events.length > 0 && now - events[0].at > WINDOW_MS) events.shift();
  if (events.length > 50000) events.splice(0, events.length - 50000);
}

function authStats() {
  const cutoff = Date.now() - WINDOW_MS;
  const recent = events.filter((e) => e.at >= cutoff);
  const stats = {
    windowHours: 24,
    total: recent.length,
    withAppKey: 0,
    validAppKey: 0,
    withUserId: 0,
    premiumActive: 0,
    premiumInactive: 0,
    premiumUnknown: 0,
    clientVersions: {},
  };
  for (const e of recent) {
    if (e.hasAppKey) stats.withAppKey++;
    if (e.appKeyValid) stats.validAppKey++;
    if (e.hasUserId) stats.withUserId++;
    if (e.premium === true) stats.premiumActive++;
    else if (e.premium === false) stats.premiumInactive++;
    else stats.premiumUnknown++;
    const v = e.clientVersion || "unknown";
    stats.clientVersions[v] = (stats.clientVersions[v] || 0) + 1;
  }
  return stats;
}

/**
 * Constant-time comparison against every configured key, so keys can be
 * rotated without a window where only one is accepted.
 */
function isValidAppKey(presented) {
  if (!presented) return false;
  const presentedBuf = Buffer.from(String(presented));
  let valid = false;
  for (const key of apiConfig.appKeys) {
    const keyBuf = Buffer.from(key);
    // timingSafeEqual throws on length mismatch; compare a padded digest
    // instead so length alone doesn't leak through an exception.
    const a = crypto.createHash("sha256").update(presentedBuf).digest();
    const b = crypto.createHash("sha256").update(keyBuf).digest();
    if (crypto.timingSafeEqual(a, b)) valid = true;
  }
  return valid;
}

function sendAuthError(res, req, status, code, message) {
  return res.status(status).json({
    success: false,
    code,
    error: message,
    requestId: req.requestId,
  });
}

/**
 * Express middleware. Never throws: an internal failure falls through to the
 * route rather than blocking a paying user.
 */
async function aiAuth(req, res, next) {
  const mode = apiConfig.authMode;

  // Capability discovery and preflight are always open.
  if (req.method === "OPTIONS") return next();
  const routePath = req.path || "";
  if (routePath === "/status" || routePath === "/status/") return next();

  if (mode === "off") return next();

  const hasAppKey = Boolean(req.appKey);
  const appKeyValid = apiConfig.appKeys.length > 0 ? isValidAppKey(req.appKey) : false;
  const hasUserId = Boolean(req.userId);
  const allowlisted = hasUserId && apiConfig.allowlistUserIds.has(req.userId);

  let premium = "unknown";
  if (hasUserId && !allowlisted) {
    try {
      premium = await checkPremium(req.userId);
    } catch (err) {
      logger.warn("premium_check_unavailable", { error: err.message });
      premium = "unknown";
    }
  } else if (allowlisted) {
    premium = "active";
  } else {
    premium = "inactive";
  }

  const event = {
    requestId: req.requestId,
    route: `${req.method} /api/ai${routePath}`,
    hasAppKey,
    appKeyValid,
    hasUserId,
    premium: premium === "unknown" ? "unknown" : premium === "active",
    clientVersion: req.clientVersion,
    user: shortHash(req.userHash),
  };
  recordEvent(event);
  req.auth = { mode, hasAppKey, appKeyValid, hasUserId, premium, allowlisted };

  if (mode === "monitor") {
    logger.info("ai_auth_monitor", event);
    return next();
  }

  // ── enforce ──────────────────────────────────────────────────────────────
  // Missing server-side configuration must not take the API down: log loudly
  // and let the request through rather than 401-ing every user.
  if (apiConfig.appKeys.length === 0) {
    logger.error("auth_enforce_without_app_keys", {
      requestId: req.requestId,
      hint: "AUTH_MODE=enforce but AI_APP_KEYS is empty — app key check skipped",
    });
  } else if (!appKeyValid) {
    logger.warn("ai_auth_rejected", { ...event, reason: "app_key" });
    return sendAuthError(res, req, 401, "UNAUTHORIZED", "Invalid or missing app key.");
  }

  if (!allowlisted) {
    if (!hasUserId) {
      logger.warn("ai_auth_rejected", { ...event, reason: "no_user_id" });
      return sendAuthError(
        res,
        req,
        403,
        "PREMIUM_REQUIRED",
        "This feature requires an active premium subscription.",
      );
    }
    if (premium === "inactive") {
      logger.warn("ai_auth_rejected", { ...event, reason: "not_premium" });
      return sendAuthError(
        res,
        req,
        403,
        "PREMIUM_REQUIRED",
        "This feature requires an active premium subscription.",
      );
    }
    // premium === "unknown" falls through on purpose.
  }

  logger.info("ai_auth_allowed", event);
  return next();
}

/** Admin-only view of what monitor mode has seen. */
function authStatsHandler(req, res) {
  if (!apiConfig.adminToken) return res.status(404).json({ error: "Not found" });
  const header = req.get("Authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = crypto.createHash("sha256").update(presented).digest();
  const b = crypto.createHash("sha256").update(apiConfig.adminToken).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, code: "UNAUTHORIZED", error: "Invalid admin token." });
  }
  return res.json({ success: true, authMode: apiConfig.authMode, stats: authStats() });
}

module.exports = { aiAuth, authStatsHandler, isValidAppKey, authStats, _events: events };
