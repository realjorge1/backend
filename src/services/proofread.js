// ============================================
// FILE: services/proofread.js
// POST /api/ai/proofread — spelling / grammar / punctuation / clarity pass
// over short blocks of text.
//
// The contract deliberately carries NO character offsets. Models hallucinate
// positions, and a wrong position means the app corrupts the user's document.
// So the model is asked only for verbatim text ("original") and the server
// locates every suggestion itself, dropping anything it cannot find. Read
// verifyBlock() as the heart of this file; the prompt is just how we feed it.
// ============================================
const crypto = require("crypto");
const aiProvider = require("./aiProvider");
const aiConfig = require("../config/aiConfig");
const apiConfig = require("../config/apiConfig");
const logger = require("../utils/logger");

/**
 * Bumped whenever the prompt below changes. It is part of the cache key, so a
 * prompt change can never be served from entries produced by the old one.
 */
const PROMPT_VERSION = "p2";

const SUGGESTION_TYPES = ["spelling", "grammar", "punctuation", "clarity", "tone", "style"];
const GOALS = ["spelling", "grammar", "punctuation", "clarity", "tone"];
const DEFAULT_GOALS = ["spelling", "grammar", "punctuation"];

const MAX_ORIGINAL_CHARS = 200;
const MAX_REPLACEMENT_CHARS = 400;
const MAX_REASON_CHARS = 140;
const MAX_BEFORE_CHARS = 32;
const MAX_SUGGESTIONS_PER_BLOCK = 50;
const MAX_SUGGESTIONS_PER_RESPONSE = 200;

// Every reason a proposed suggestion can fail to reach the client. These are
// counted per request and logged (B4): the drop rate is the quality signal for
// the prompt, and a rising not_substring rate means the model is paraphrasing.
const DROP_REASONS = ["not_substring", "identical", "overlap", "cap", "bad_shape"];

// ─── Cache ───────────────────────────────────────────────────────────────────
// Per block, not per request, so editing paragraph 3 still serves 1, 2 and 4
// from memory. In-process only: the free tier has no disk and no Redis.

const cache = new Map(); // key -> { text, language, suggestions, at }

function cacheGet(key, text) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > apiConfig.proofread.cacheTtlMs) {
    cache.delete(key);
    return null;
  }
  // The key hashes NFC-normalized text, so two byte-different blocks can share
  // one key. Cached `original` values were verified against `entry.text`, not
  // against this one — serving them would be exactly the unverified-position
  // bug this module exists to prevent. An exact compare closes that gap.
  if (entry.text !== text) return null;
  // Refresh LRU position.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function cacheSet(key, value) {
  cache.delete(key);
  cache.set(key, { ...value, at: Date.now() });
  while (cache.size > apiConfig.proofread.cacheMaxBlocks) {
    cache.delete(cache.keys().next().value);
  }
}

function clearCache() {
  cache.clear();
}

function blockCacheKey(text, { language, dialect, goals, model }) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        String(text).normalize("NFC"),
        language,
        dialect,
        [...goals].sort(),
        model,
        PROMPT_VERSION,
      ]),
    )
    .digest("hex");
}

// ─── Verification (P4) ───────────────────────────────────────────────────────

/** All non-overlapping match positions of `needle` in `hay`, left to right. */
function matchPositions(hay, needle) {
  const out = [];
  if (!needle) return out;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + needle.length;
  }
}

/** Markdown emphasis/code/link syntax has no place in a one-line reason. */
function stripMarkdown(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*\*|\*\*|\*|___|__|_|~~)/g, "")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

const WHITESPACE = /\s/;

/**
 * Narrow a suggestion to the part that actually changes.
 *
 * Models over-quote: asked to capitalise one letter they will happily return
 * the whole line as `original`, because a shorter span would be ambiguous.
 * That verifies fine but is bad for the app — a 40-character span overlaps
 * every other suggestion in the block and makes the edit look far bigger than
 * it is. Trimming the shared prefix and suffix is a pure text operation, so
 * the result is still an exact substring of the block.
 *
 * Cuts are snapped to whitespace, so a span is always whole words: "recieve"
 * stays "recieve" rather than narrowing to "ie" -> "ei", and "it's" -> "its"
 * stays a readable word pair rather than becoming "'" -> "".
 *
 * @returns {{ offset: number, original: string, replacement: string }}
 */
function shrinkSpan(original, replacement) {
  // Leave at least one character of `original`: an empty one could not be
  // located, and `replacement` may legitimately be "" for a deletion.
  let prefix = 0;
  const maxPrefix = Math.min(original.length - 1, replacement.length);
  while (prefix < maxPrefix && original[prefix] === replacement[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(original.length - 1 - prefix, replacement.length - prefix);
  while (
    suffix < maxSuffix &&
    original[original.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]
  ) {
    suffix++;
  }

  // Snap both cuts back to whitespace, so the span is always whole words.
  while (prefix > 0 && !WHITESPACE.test(original[prefix - 1])) prefix--;
  while (suffix > 0 && !WHITESPACE.test(original[original.length - suffix])) suffix--;

  return {
    offset: prefix,
    original: original.slice(prefix, original.length - suffix),
    replacement: replacement.slice(prefix, replacement.length - suffix),
  };
}

function clampConfidence(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/**
 * Order candidates so the highest-confidence suggestion claims its position
 * first. That single ordering satisfies both "take the first free match" and
 * "when spans overlap, keep the higher confidence" without a second pass.
 * Ties fall back to the earliest possible start, then to model order, so the
 * result is fully deterministic for a given model reply (P4.6).
 */
function candidateOrder(a, b) {
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  if (a.firstMatch !== b.firstMatch) return a.firstMatch - b.firstMatch;
  return a.index - b.index;
}

/**
 * Turn one block's raw model output into suggestions that are provably
 * locatable in `text`. Never repairs by guessing: a suggestion that does not
 * verify is dropped.
 *
 * @param {string} text  the block's text, exactly as the client sent it
 * @param {Array<object>} raw  model-proposed suggestions for this block
 * @returns {{ suggestions: Array<object>, drops: object, coercedTypes: number }}
 */
function verifyBlock(text, raw) {
  const drops = Object.fromEntries(DROP_REASONS.map((r) => [r, 0]));
  let coercedTypes = 0;

  const candidates = [];

  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      drops.bad_shape++;
      return;
    }

    // 1. `original` must be an exact, case-sensitive substring. No
    //    normalization, no trimming, no fuzzy matching — "close enough" is how
    //    documents get corrupted.
    const original = typeof item.original === "string" ? item.original : "";
    if (!original || original.length > MAX_ORIGINAL_CHARS) {
      drops.not_substring++;
      return;
    }
    const positions = matchPositions(text, original);
    if (positions.length === 0) {
      drops.not_substring++;
      return;
    }

    // 2. `replacement` must exist, fit, and actually change something.
    if (typeof item.replacement !== "string" || item.replacement.length > MAX_REPLACEMENT_CHARS) {
      drops.bad_shape++;
      return;
    }
    if (item.replacement === original) {
      drops.identical++;
      return;
    }

    const type = SUGGESTION_TYPES.includes(item.type) ? item.type : "style";
    if (type !== item.type) coercedTypes++;

    // 3. Narrow the span to what actually changes — but only when every one of
    //    the model's candidate positions survives the narrowing as a real,
    //    countable match. If the shorter string self-overlaps in this text
    //    (e.g. "aa" inside "aaaa"), the occurrence the app would count could
    //    differ from ours, so we keep the model's wider span instead.
    const shrunk = shrinkSpan(original, item.replacement);
    let effective = {
      original,
      replacement: item.replacement,
      // Where this suggestion may land...
      positions,
      // ...and every match of the same string in the block, which is what the
      // app counts when it resolves `occurrence`. They differ once a span has
      // been narrowed: "the mat" -> "mat" can land at one position while being
      // the second "mat" in the block.
      allPositions: positions,
    };
    if (shrunk.original !== original) {
      const shrunkPositions = matchPositions(text, shrunk.original);
      const mapped = positions.map((p) => p + shrunk.offset);
      if (mapped.every((p) => shrunkPositions.includes(p))) {
        effective = {
          original: shrunk.original,
          replacement: shrunk.replacement,
          positions: mapped,
          allPositions: shrunkPositions,
        };
      }
    }
    if (effective.replacement === effective.original) {
      drops.identical++;
      return;
    }

    candidates.push({
      index,
      original: effective.original,
      replacement: effective.replacement,
      type,
      reason: stripMarkdown(item.reason).slice(0, MAX_REASON_CHARS),
      confidence: clampConfidence(item.confidence),
      // A verbatim snippet the model may supply to say *which* occurrence it
      // meant. Used only to pick among real match positions and verified
      // against the text like everything else; a hallucinated context simply
      // fails to match and we fall back to the first free occurrence.
      context: typeof item.context === "string" ? item.context : "",
      positions: effective.positions,
      allPositions: effective.allPositions,
      firstMatch: effective.positions[0],
    });
  });

  candidates.sort(candidateOrder);

  const accepted = [];
  const taken = []; // [start, end) spans already claimed

  for (const cand of candidates) {
    const free = cand.positions.filter(
      (start) => !taken.some(([s, e]) => start < e && start + cand.original.length > s),
    );
    if (free.length === 0) {
      drops.overlap++;
      continue;
    }

    let start = free[0];
    // Disambiguate with the model's context hint when it resolves to exactly
    // one place in the text and that place is still free.
    if (cand.context && cand.context !== cand.original && free.length > 1) {
      const ctxPositions = matchPositions(text, cand.context);
      if (ctxPositions.length === 1) {
        const ctxStart = ctxPositions[0];
        const ctxEnd = ctxStart + cand.context.length;
        const inside = free.find((p) => p >= ctxStart && p + cand.original.length <= ctxEnd);
        if (inside !== undefined) start = inside;
      }
    }

    taken.push([start, start + cand.original.length]);
    accepted.push({
      order: start,
      type: cand.type,
      original: cand.original,
      replacement: cand.replacement,
      // Computed here from the chosen position — never taken from the model.
      occurrence: cand.allPositions.indexOf(start) + 1,
      before: text.slice(Math.max(0, start - MAX_BEFORE_CHARS), start),
      reason: cand.reason,
      confidence: cand.confidence,
    });
  }

  // Per-block cap, lowest confidence first.
  if (accepted.length > MAX_SUGGESTIONS_PER_BLOCK) {
    accepted.sort((a, b) => b.confidence - a.confidence || a.order - b.order);
    drops.cap += accepted.length - MAX_SUGGESTIONS_PER_BLOCK;
    accepted.length = MAX_SUGGESTIONS_PER_BLOCK;
  }

  accepted.sort((a, b) => a.order - b.order);
  return { suggestions: accepted, drops, coercedTypes };
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

const GOAL_HINTS = {
  spelling: "misspellings and typos",
  grammar: "grammatical errors (agreement, tense, articles, word form)",
  punctuation: "punctuation and capitalisation errors",
  clarity: "wording that is genuinely unclear or redundant",
  tone: "wording that clashes with the surrounding register",
};

function systemPrompt() {
  return (
    "You are a precise proofreader. You find real errors in short blocks of " +
    "text and return them as strict JSON.\n\n" +
    "Absolute rules:\n" +
    '- "original" MUST be copied character-for-character from the block it ' +
    "belongs to, including case, punctuation and internal spacing. Never " +
    "paraphrase it, never re-case it, never fix it, never add or remove " +
    "surrounding whitespace. If you cannot quote it exactly, omit the " +
    "suggestion.\n" +
    '- Keep "original" as SHORT as the correction allows — usually one word or ' +
    "a short phrase, never a whole sentence to fix one character. If that " +
    "short span occurs more than once in the block, do NOT pad it out: leave " +
    'it short and set "context" to a longer verbatim snippet of the block ' +
    "containing the occurrence you mean.\n" +
    "- Never report character positions, offsets, indices or occurrence " +
    "numbers. They are not part of the format and will be ignored.\n" +
    '- "replacement" must differ from "original". Use an empty string to ' +
    "delete.\n" +
    "- Report only real errors. A block with nothing wrong yields no " +
    "suggestions. Do not rewrite for style unless asked.\n" +
    "- Return ONLY minified JSON. No prose, no markdown, no code fences."
  );
}

function userPrompt(blocks, { language, dialect, goals }) {
  const goalText = goals.map((g) => `${g} (${GOAL_HINTS[g]})`).join("; ");
  const languageLine =
    language === "auto"
      ? "Detect the language of each block yourself."
      : `Treat every block as ${language}.`;
  const dialectLine = dialect
    ? `For English blocks use ${dialect === "uk" ? "British" : "American"} spelling and conventions.`
    : "";

  return (
    `Proofread each block below. Look for: ${goalText}.\n` +
    `${languageLine}${dialectLine ? " " + dialectLine : ""}\n\n` +
    `Blocks (JSON):\n${JSON.stringify(blocks.map((b) => ({ id: b.id, text: b.text })))}\n\n` +
    "Reply with exactly this JSON shape:\n" +
    '{"languages":{"<blockId>":"<BCP-47 tag>"},"suggestions":[' +
    '{"blockId":"<blockId>","type":"spelling|grammar|punctuation|clarity|tone|style",' +
    '"original":"<verbatim substring of that block>","replacement":"<corrected text>",' +
    '"context":"<optional longer verbatim snippet containing this occurrence>",' +
    '"reason":"<one short sentence, max 140 characters>","confidence":<0..1>}]}\n' +
    'Include every block id in "languages". Omit "suggestions" entries for ' +
    "blocks with no errors."
  );
}

/** Parse JSON that may arrive wrapped in prose or code fences. */
function parseJsonLoosely(content) {
  const raw = String(content || "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  const slice = start !== -1 && end > start ? candidate.slice(start, end + 1) : candidate;
  try {
    const parsed = JSON.parse(slice);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ─── Model call ──────────────────────────────────────────────────────────────

/** The model this route uses. Undefined means "the provider's own default". */
function proofreadModel() {
  return apiConfig.proofread.model || undefined;
}

/** Model id as it appears in the cache key and the logs. */
function modelId() {
  const provider = aiProvider._initialized ? aiProvider.currentProvider : aiConfig.provider;
  return `${provider}:${apiConfig.proofread.model || aiConfig[provider]?.model || "default"}`;
}

/** Whether this instance could actually serve a proofread request right now. */
function isConfigured() {
  try {
    if (!aiProvider._initialized) aiProvider.initialize();
    return aiProvider.providers.size > 0;
  } catch {
    return false;
  }
}

/**
 * One model call for all uncached blocks, retried once when the reply cannot
 * be parsed. Returns the raw (unverified) suggestion list and language map.
 */
async function callModel(blocks, opts, deadline, stats) {
  const system = systemPrompt();
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadline - Date.now();
    // Don't start an attempt we cannot finish inside the request budget.
    if (remaining < apiConfig.proofread.minAttemptMs) {
      if (attempt === 1) {
        const err = new Error("Proofreading timed out before the model could be reached.");
        err.code = "TIMEOUT";
        throw err;
      }
      break;
    }

    const correction =
      attempt === 1
        ? ""
        : `\n\nYour previous reply could not be parsed (${lastError}). Return ONLY ` +
          "the minified JSON object described above, with no commentary.";

    let result;
    try {
      result = await aiProvider.chat(
        [
          { role: "system", content: system },
          { role: "user", content: userPrompt(blocks, opts) + correction },
        ],
        {
          // P4.6: the same request must produce the same response.
          temperature: 0,
          maxTokens: apiConfig.proofread.maxTokens,
          model: proofreadModel(),
          // minAttemptMs already refused an attempt that can't finish; the
          // floor here only stops a non-positive timeout reaching the SDK.
          timeoutMs: Math.max(250, Math.min(remaining - 250, apiConfig.proofread.modelTimeoutMs)),
        },
      );
    } catch (err) {
      stats.retries = attempt - 1;
      throw err;
    }

    stats.provider = result.provider;
    stats.usage = result.usage;

    const parsed = parseJsonLoosely(result.content);
    if (parsed && Array.isArray(parsed.suggestions)) {
      stats.retries = attempt - 1;
      return parsed;
    }
    // An object that at least names the languages is usable: it means "no
    // errors found", which is a legitimate answer.
    if (parsed && parsed.languages && typeof parsed.languages === "object") {
      stats.retries = attempt - 1;
      return { languages: parsed.languages, suggestions: [] };
    }

    lastError = parsed ? 'the reply had no "suggestions" array' : "the reply was not valid JSON";
    logger.warn("proofread_invalid_model_output", {
      requestId: opts.requestId,
      attempt,
      reason: lastError,
    });
  }

  stats.retries = 1;
  const err = new Error(`The model did not return a usable proofread result (${lastError}).`);
  err.code = "AI_BAD_OUTPUT";
  throw err;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Proofread a validated request.
 *
 * @param {object} params
 * @param {Array<{id: string, text: string}>} params.blocks
 * @param {string} params.language  "auto" or a BCP-47 tag
 * @param {string|null} params.dialect
 * @param {string[]} params.goals
 * @param {string} [params.requestId]
 * @returns {Promise<{ blocks: Array<object>, stats: object }>}
 */
async function proofread({ blocks, language, dialect, goals, requestId }) {
  const startedAt = Date.now();
  const deadline = startedAt + apiConfig.proofread.budgetMs;
  const model = modelId();
  const keyOpts = { language, dialect, goals, model };

  const stats = {
    model,
    provider: null,
    usage: null,
    cacheHits: 0,
    cacheMisses: 0,
    proposed: 0,
    returned: 0,
    retries: 0,
    coercedTypes: 0,
    drops: Object.fromEntries(DROP_REASONS.map((r) => [r, 0])),
    modelLatencyMs: 0,
    partial: false,
  };

  // 1. Serve what we can from cache.
  const verified = new Map(); // blockId -> { language, suggestions }
  const misses = [];
  for (const block of blocks) {
    const hit = cacheGet(blockCacheKey(block.text, keyOpts), block.text);
    if (hit) {
      stats.cacheHits++;
      verified.set(block.id, { language: hit.language, suggestions: hit.suggestions });
    } else {
      stats.cacheMisses++;
      misses.push(block);
    }
  }

  // 2. One model call for everything left.
  if (misses.length > 0) {
    const modelStart = Date.now();
    let reply = null;
    try {
      reply = await callModel(misses, { language, dialect, goals, requestId }, deadline, stats);
    } catch (err) {
      stats.modelLatencyMs = Date.now() - modelStart;
      // A partial answer beats a timeout: the app's background checks fail
      // silently, so a timeout shows the user nothing at all (P5.5 / B2.7).
      // Only fall back to partial when something was genuinely verified.
      if (err.code === "TIMEOUT" && verified.size > 0) {
        stats.partial = true;
        logger.warn("proofread_partial", {
          requestId,
          served: verified.size,
          unserved: misses.length,
        });
        for (const block of misses) {
          verified.set(block.id, { language: resolveLanguage(language, null), suggestions: [] });
        }
      } else {
        throw err;
      }
    }
    stats.modelLatencyMs = Date.now() - modelStart;

    if (reply) {
      const byBlock = new Map(misses.map((b) => [b.id, []]));
      for (const item of reply.suggestions) {
        const list = byBlock.get(item?.blockId);
        if (!list) {
          // A blockId the request never mentioned: nothing to verify against.
          stats.drops.bad_shape++;
          continue;
        }
        list.push(item);
      }
      stats.proposed += reply.suggestions.length;

      for (const block of misses) {
        const raw = byBlock.get(block.id) || [];
        const outcome = verifyBlock(block.text, raw);
        for (const reason of DROP_REASONS) stats.drops[reason] += outcome.drops[reason];
        stats.coercedTypes += outcome.coercedTypes;

        const detected = resolveLanguage(language, reply.languages?.[block.id]);
        verified.set(block.id, { language: detected, suggestions: outcome.suggestions });
        cacheSet(blockCacheKey(block.text, keyOpts), {
          text: block.text,
          language: detected,
          suggestions: outcome.suggestions,
        });
      }
    }
  }

  // 3. Assemble in request order, apply the per-response cap, mint ids.
  const assembled = blocks.map((block) => {
    const entry = verified.get(block.id) || {
      language: resolveLanguage(language, null),
      suggestions: [],
    };
    return { id: block.id, language: entry.language, suggestions: [...entry.suggestions] };
  });

  applyResponseCap(assembled, stats);

  for (const block of assembled) {
    block.suggestions = block.suggestions.map((s, i) => ({
      id: `s${i + 1}`,
      type: s.type,
      original: s.original,
      replacement: s.replacement,
      occurrence: s.occurrence,
      before: s.before,
      reason: s.reason,
      confidence: s.confidence,
    }));
    stats.returned += block.suggestions.length;
  }

  stats.totalLatencyMs = Date.now() - startedAt;
  return { blocks: assembled, stats };
}

/** Cap the whole response at 200 suggestions, dropping lowest confidence first. */
function applyResponseCap(assembled, stats) {
  const total = assembled.reduce((n, b) => n + b.suggestions.length, 0);
  if (total <= MAX_SUGGESTIONS_PER_RESPONSE) return;

  const flat = [];
  assembled.forEach((block, blockIndex) => {
    block.suggestions.forEach((s, i) => flat.push({ blockIndex, i, s }));
  });
  flat.sort(
    (a, b) =>
      b.s.confidence - a.s.confidence ||
      a.blockIndex - b.blockIndex ||
      a.s.occurrence - b.s.occurrence ||
      a.i - b.i,
  );
  const keep = new Set(
    flat.slice(0, MAX_SUGGESTIONS_PER_RESPONSE).map((e) => `${e.blockIndex}:${e.i}`),
  );
  stats.drops.cap += total - MAX_SUGGESTIONS_PER_RESPONSE;

  assembled.forEach((block, blockIndex) => {
    block.suggestions = block.suggestions.filter((_, i) => keep.has(`${blockIndex}:${i}`));
  });
}

/**
 * An explicit `language` is honoured and echoed back; "auto" lets the model
 * report what it saw, falling back to "und" (BCP-47 for undetermined) rather
 * than guessing English.
 */
function resolveLanguage(requested, detected) {
  if (requested && requested !== "auto") return requested;
  if (typeof detected === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(detected)) {
    return detected;
  }
  return "und";
}

module.exports = {
  proofread,
  verifyBlock,
  isConfigured,
  modelId,
  clearCache,
  blockCacheKey,
  matchPositions,
  stripMarkdown,
  resolveLanguage,
  PROMPT_VERSION,
  GOALS,
  DEFAULT_GOALS,
  SUGGESTION_TYPES,
  DROP_REASONS,
  MAX_SUGGESTIONS_PER_BLOCK,
  MAX_SUGGESTIONS_PER_RESPONSE,
  _cache: cache,
};
