// ============================================
// FILE: middleware/proofreadRateLimit.js
// Limits for POST /api/ai/proofread.
//
// This route is called on a typing debounce, so it is the only one that can
// realistically exhaust the model budget or the container's CPU. It therefore
// gets its own buckets (tighter than the shared AI limits), a character budget
// on top of request counting — 30 requests of 20,000 chars is nothing like 30
// requests of 200 — and a concurrency cap so a burst can't starve the document
// tasks running on the same instance.
//
// Counters are per-instance and per-container, like the existing AI limiters:
// with two servers behind failover the effective ceiling is roughly 2x.
// ============================================
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const apiConfig = require("../config/apiConfig");
const logger = require("../utils/logger");

/** Same keying as the shared AI limiters: user first, IP only as a fallback. */
function userOrIpKey(req) {
  if (req.userHash) return `u:${req.userHash}`;
  return `i:${ipKeyGenerator(req.ip)}`;
}

function sendRateLimited(req, res, scope, retryAfterSec, message) {
  res.setHeader("Retry-After", String(retryAfterSec));
  logger.warn("rate_limited", {
    requestId: req.requestId,
    scope,
    route: `${req.method} ${req.originalUrl}`,
    retryAfterSec,
  });
  return res.status(429).json({
    success: false,
    code: "RATE_LIMITED",
    error: message || `Too many requests. Try again in ${retryAfterSec} seconds.`,
    retryAfterSec,
    requestId: req.requestId,
  });
}

function limitHandler(scope) {
  return (req, res) => {
    const resetTime = req.rateLimit?.resetTime;
    const retryAfterSec =
      resetTime instanceof Date
        ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
        : 60;
    return sendRateLimited(req, res, scope, retryAfterSec);
  };
}

function build(scope, windowMs, limitKey) {
  return rateLimit({
    windowMs,
    // Read through apiConfig on every request so tests can rebuild the module
    // with a different environment, exactly like the shared limiters.
    limit: () => apiConfig.proofread[limitKey],
    keyGenerator: userOrIpKey,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: limitHandler(scope),
    skip: () => !apiConfig.rateLimit.enabled,
  });
}

const proofreadPerMinute = build("proofread/min", 60 * 1000, "perMin");
const proofreadPerHour = build("proofread/hour", 60 * 60 * 1000, "perHour");

// ─── Character budget ────────────────────────────────────────────────────────
// Request counting alone says nothing about load: this tracks how much text a
// user actually sends per minute. Fixed 60-second windows, per instance.

const charWindows = new Map(); // key -> { windowStart, chars }

function pruneCharWindows(now) {
  if (charWindows.size < 5000) return;
  for (const [key, entry] of charWindows) {
    if (now - entry.windowStart > 120000) charWindows.delete(key);
  }
}

/**
 * Counts the characters in the body against a per-minute budget. Runs before
 * the route so an over-budget user never reaches the model, and deliberately
 * charges for the request that crosses the line rather than splitting it.
 */
function charBudget(req, res, next) {
  if (!apiConfig.rateLimit.enabled) return next();
  const budget = apiConfig.proofread.charsPerMin;
  if (!budget || budget <= 0) return next();

  const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
  let chars = 0;
  for (const block of blocks) {
    if (typeof block?.text === "string") chars += block.text.length;
  }
  if (chars === 0) return next();

  const now = Date.now();
  pruneCharWindows(now);
  const key = userOrIpKey(req);
  let entry = charWindows.get(key);
  if (!entry || now - entry.windowStart >= 60000) {
    entry = { windowStart: now, chars: 0 };
    charWindows.set(key, entry);
  }

  if (entry.chars >= budget) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.windowStart + 60000 - now) / 1000));
    return sendRateLimited(
      req,
      res,
      "proofread/chars",
      retryAfterSec,
      `Too much text checked in the last minute. Try again in ${retryAfterSec} seconds.`,
    );
  }

  entry.chars += chars;
  return next();
}

// ─── Concurrency cap ─────────────────────────────────────────────────────────
// A bounded number of proofread requests may hold a model call at once. Over
// the cap they queue briefly; if the wait would eat the 15-second budget we
// tell the app to back off, which is cheaper for everyone than a timeout.

let inFlight = 0;
const waiting = [];

function releaseSlot() {
  const nextWaiter = waiting.shift();
  if (nextWaiter) {
    clearTimeout(nextWaiter.timer);
    nextWaiter.resolve(true);
    return;
  }
  inFlight = Math.max(0, inFlight - 1);
}

/**
 * Acquire a slot, waiting at most `queueWaitMs`.
 * @returns {Promise<boolean>} false when the queue wait ran out
 */
function acquireSlot() {
  const cap = apiConfig.proofread.maxConcurrent;
  if (!cap || cap <= 0 || inFlight < cap) {
    inFlight++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const waiter = { resolve: null, timer: null };
    waiter.resolve = resolve;
    waiter.timer = setTimeout(() => {
      const at = waiting.indexOf(waiter);
      if (at !== -1) waiting.splice(at, 1);
      resolve(false);
    }, apiConfig.proofread.queueWaitMs);
    waiting.push(waiter);
  });
}

/**
 * Express middleware: hold a concurrency slot for the lifetime of the request.
 * Releases on response finish/close so a dropped connection can't leak a slot.
 */
async function concurrencyGuard(req, res, next) {
  const acquired = await acquireSlot();
  if (!acquired) {
    const retryAfterSec = Math.max(1, Math.ceil(apiConfig.proofread.queueWaitMs / 1000));
    return sendRateLimited(
      req,
      res,
      "proofread/concurrency",
      retryAfterSec,
      `Busy. Try again in ${retryAfterSec} seconds.`,
    );
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseSlot();
  };
  res.on("finish", release);
  res.on("close", release);

  return next();
}

/** Applied to /api/ai/proofread only, in this order. */
const proofreadLimiters = [
  proofreadPerMinute,
  proofreadPerHour,
  charBudget,
  concurrencyGuard,
];

/** Test seam: forget every counter and queued waiter. */
function _reset() {
  charWindows.clear();
  inFlight = 0;
  for (const waiter of waiting.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.resolve(false);
  }
}

module.exports = {
  proofreadLimiters,
  proofreadPerMinute,
  proofreadPerHour,
  charBudget,
  concurrencyGuard,
  userOrIpKey,
  _reset,
  _stats: () => ({ inFlight, waiting: waiting.length, charWindows: charWindows.size }),
};
