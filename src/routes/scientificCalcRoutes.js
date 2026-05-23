/**
 * Scientific Calculator API Router
 * Mounted at: /api/scientific-calc
 */

const express = require("express");
const router = express.Router();
const { calculate, getSuggestions } = require("../services/scientificCalcService");

// Simple in-memory rate limiter (30 req/min per IP)
const requestCounts = new Map();
const RATE_LIMIT = 30;
const WINDOW_MS = 60 * 1000;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = requestCounts.get(ip) || { count: 0, start: now };

  if (now - entry.start > WINDOW_MS) {
    entry.count = 0;
    entry.start = now;
  }

  entry.count++;
  requestCounts.set(ip, entry);

  if (entry.count > RATE_LIMIT) {
    return res.status(429).json({
      error: "Rate limit exceeded. Please wait before making more requests.",
      retryAfter: Math.ceil((entry.start + WINDOW_MS - now) / 1000),
    });
  }

  next();
}

// POST /api/scientific-calc/calculate
router.post("/calculate", rateLimit, async (req, res) => {
  try {
    const { query, category, variables } = req.body;

    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return res.status(400).json({ error: "A query string is required." });
    }

    if (query.trim().length > 2000) {
      return res.status(400).json({ error: "Query too long. Maximum 2000 characters." });
    }

    const result = await calculate(query.trim(), category || null, variables || {});

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    console.error("[ScientificCalc] Calculate error:", err);

    if (err instanceof SyntaxError) {
      return res.status(500).json({
        error: "Failed to parse AI response. Please try rephrasing your query.",
      });
    }

    if (err.status === 401) {
      return res.status(500).json({ error: "API authentication failed." });
    }

    if (err.status === 529 || err.status === 503) {
      return res.status(503).json({
        error: "AI service temporarily overloaded. Please retry in a moment.",
      });
    }

    return res.status(500).json({
      error: "An unexpected error occurred. Please try again.",
      details: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

// GET /api/scientific-calc/suggestions/:category
router.get("/suggestions/:category", rateLimit, async (req, res) => {
  try {
    const { category } = req.params;
    const validCategories = [
      "Medical", "Chemistry", "Physics", "Biology",
      "Mathematics", "Astronomy", "Engineering", "Conversions",
    ];

    if (!validCategories.includes(category)) {
      return res.status(400).json({
        error: `Invalid category. Must be one of: ${validCategories.join(", ")}`,
      });
    }

    const suggestions = await getSuggestions(category);
    return res.status(200).json({ success: true, category, suggestions });
  } catch (err) {
    console.error("[ScientificCalc] Suggestions error:", err);
    return res.status(500).json({ error: "Failed to load suggestions." });
  }
});

// GET /api/scientific-calc/health
router.get("/health", (req, res) => {
  res.json({ status: "ok", service: "GozlinScientia API", timestamp: new Date().toISOString() });
});

module.exports = router;
