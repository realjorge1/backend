// ============================================
// FILE: services/proofreadRequest.js
// Request validation for POST /api/ai/proofread (contract P2).
//
// Every limit is checked before any work happens: a bad request must never
// reach the model. Nothing is silently truncated and nothing is silently
// split — the app splits its own work to stay inside these limits.
// ============================================
const { GOALS, DEFAULT_GOALS } = require("./proofread");

const MAX_BLOCKS = 20;
const MAX_BLOCK_ID_CHARS = 64;
const MAX_BLOCK_TEXT_CHARS = 4000;
const MAX_TOTAL_CHARS = 20000;
const DIALECTS = ["us", "uk"];

// BCP-47, loosely: a 2-3 letter primary tag plus optional subtags. Deliberately
// permissive about which tags exist and strict about the shape.
const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function bad(message) {
  const err = new Error(message);
  err.code = "BAD_REQUEST";
  return err;
}

/**
 * Validate and normalize a proofread request body.
 * @throws {Error} with code "BAD_REQUEST" on any violation
 * @returns {{ blocks: Array<{id: string, text: string}>, language: string,
 *             dialect: string|null, goals: string[], totalChars: number }}
 */
function parseProofreadRequest(body) {
  const input = body && typeof body === "object" ? body : {};

  // ── blocks ────────────────────────────────────────────────────────────────
  if (!Array.isArray(input.blocks)) {
    throw bad('"blocks" must be an array.');
  }
  if (input.blocks.length === 0) {
    throw bad('"blocks" must contain at least 1 block.');
  }
  if (input.blocks.length > MAX_BLOCKS) {
    throw bad(`"blocks" must contain at most ${MAX_BLOCKS} blocks.`);
  }

  const seen = new Set();
  const blocks = [];
  let totalChars = 0;

  for (let i = 0; i < input.blocks.length; i++) {
    const block = input.blocks[i];
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      throw bad(`blocks[${i}] must be an object.`);
    }
    const { id, text } = block;

    if (typeof id !== "string" || id.length === 0) {
      throw bad(`blocks[${i}].id must be a non-empty string.`);
    }
    if (id.length > MAX_BLOCK_ID_CHARS) {
      throw bad(`blocks[${i}].id must be at most ${MAX_BLOCK_ID_CHARS} characters.`);
    }
    if (seen.has(id)) {
      throw bad(`blocks[${i}].id "${id}" is duplicated; ids must be unique within a request.`);
    }
    seen.add(id);

    if (typeof text !== "string" || text.length === 0) {
      throw bad(`blocks[${i}].text must be a non-empty string.`);
    }
    if (text.length > MAX_BLOCK_TEXT_CHARS) {
      throw bad(`blocks[${i}].text must be at most ${MAX_BLOCK_TEXT_CHARS} characters.`);
    }

    totalChars += text.length;
    blocks.push({ id, text });
  }

  if (totalChars > MAX_TOTAL_CHARS) {
    throw bad(`Total text across all blocks must be at most ${MAX_TOTAL_CHARS} characters.`);
  }

  // ── language ──────────────────────────────────────────────────────────────
  let language = "auto";
  if (input.language !== undefined && input.language !== null) {
    if (typeof input.language !== "string") {
      throw bad('"language" must be "auto" or a BCP-47 tag.');
    }
    if (input.language !== "auto" && !BCP47.test(input.language)) {
      throw bad(`"language" must be "auto" or a BCP-47 tag (got "${input.language}").`);
    }
    language = input.language;
  }

  // ── dialect ───────────────────────────────────────────────────────────────
  let dialect = null;
  if (input.dialect !== undefined && input.dialect !== null) {
    if (typeof input.dialect !== "string" || !DIALECTS.includes(input.dialect)) {
      throw bad('"dialect" must be "us", "uk" or null.');
    }
    dialect = input.dialect;
  }

  // ── goals ─────────────────────────────────────────────────────────────────
  let goals = DEFAULT_GOALS;
  if (input.goals !== undefined && input.goals !== null) {
    if (!Array.isArray(input.goals) || input.goals.length === 0) {
      throw bad(`"goals" must be a non-empty array drawn from: ${GOALS.join(", ")}.`);
    }
    for (const goal of input.goals) {
      if (typeof goal !== "string" || !GOALS.includes(goal)) {
        throw bad(`"goals" must be a subset of: ${GOALS.join(", ")}.`);
      }
    }
    // De-duplicate but keep the caller's order; the cache key sorts separately.
    goals = [...new Set(input.goals)];
  }

  return { blocks, language, dialect, goals, totalChars };
}

module.exports = {
  parseProofreadRequest,
  MAX_BLOCKS,
  MAX_BLOCK_ID_CHARS,
  MAX_BLOCK_TEXT_CHARS,
  MAX_TOTAL_CHARS,
};
