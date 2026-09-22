// ============================================
// FILE: middleware/aiRateLimit.js
// Rate limits for /api/ai. Counters are per-instance (memory store), which is
// acceptable while the pool is two servers behind round-robin failover: the
// effective ceiling is roughly 2x the configured limit.
// ============================================
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const apiConfig = require("../config/apiConfig");
const logger = require("../utils/logger");
const tokenBudget = require("../services/tokenBudget");

/** Prefer the user id (hashed) so one abusive device can't spend a shared IP budget. */
function userOrIpKey(req) {
  if (req.userHash) return `u:${req.userHash}`;
  return `i:${ipKeyGenerator(req.ip)}`;
}

function ipKey(req) {
  return ipKeyGenerator(req.ip);
}

function retryAfterSeconds(req, res) {
  const resetTime = req.rateLimit?.resetTime;
  if (resetTime instanceof Date) {
    return Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000));
  }
  return 60;
}

function limitHandler(scope) {
  return (req, res) => {
    const retryAfterSec = retryAfterSeconds(req, res);
    res.setHeader("Retry-After", String(retryAfterSec));
    logger.warn("rate_limited", {
      requestId: req.requestId,
      scope,
      route: `${req.method} ${req.originalUrl}`,
      retryAfterSec,
    });
    res.status(429).json({
      success: false,
      code: "RATE_LIMITED",
      error: `Too many requests. Try again in ${retryAfterSec} seconds.`,
      retryAfterSec,
      requestId: req.requestId,
    });
  };
}

function build(scope, { windowMs, limit, keyGenerator }) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: limitHandler(scope),
    skip: () => !apiConfig.rateLimit.enabled,
    // The AI router answers capability discovery without auth; don't spend
    // budget on it.
    skipSuccessfulRequests: false,
  });
}

const perUserMinute = build("user/min", {
  windowMs: 60 * 1000,
  limit: apiConfig.rateLimit.aiPerMin,
  keyGenerator: userOrIpKey,
});

const perUserDay = build("user/day", {
  windowMs: 24 * 60 * 60 * 1000,
  limit: apiConfig.rateLimit.aiPerDay,
  keyGenerator: userOrIpKey,
});

const perIpMinute = build("ip/min", {
  windowMs: 60 * 1000,
  limit: apiConfig.rateLimit.ipPerMin,
  keyGenerator: ipKey,
});

const perExtractHour = build("extract/hour", {
  windowMs: 60 * 60 * 1000,
  limit: apiConfig.rateLimit.extractPerHour,
  keyGenerator: userOrIpKey,
});

/** Blocks a user who has burned through DAILY_TOKEN_BUDGET_PER_USER. */
function tokenBudgetGuard(req, res, next) {
  if (!apiConfig.dailyTokenBudgetPerUser) return next();
  if (!tokenBudget.isOverBudget(req.userHash)) return next();

  const secondsToMidnight = Math.ceil(
    (Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate() + 1,
    ) -
      Date.now()) /
      1000,
  );
  res.setHeader("Retry-After", String(secondsToMidnight));
  logger.warn("rate_limited", {
    requestId: req.requestId,
    scope: "token-budget",
    used: tokenBudget.usedToday(req.userHash),
  });
  return res.status(429).json({
    success: false,
    code: "RATE_LIMITED",
    error: "Daily usage limit reached. Try again tomorrow.",
    retryAfterSec: secondsToMidnight,
    requestId: req.requestId,
  });
}

/** Limiters that apply to every /api/ai route. */
const aiLimiters = [perIpMinute, perUserMinute, perUserDay, tokenBudgetGuard];

/** Extra limiter for the upload-heavy routes. */
const extractLimiters = [perExtractHour];

module.exports = {
  aiLimiters,
  extractLimiters,
  perUserMinute,
  perUserDay,
  perIpMinute,
  perExtractHour,
  tokenBudgetGuard,
  userOrIpKey,
};
