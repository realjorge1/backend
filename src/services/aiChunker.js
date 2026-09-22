// ============================================
// FILE: services/aiChunker.js
// Map-reduce style chunked processing for long documents.
//
// When the document fits in a single LLM call (under CHUNK_THRESHOLD chars)
// the original single-call path is used. When it does not, the document is
// split into overlapping chunks, each chunk is processed via a `mapFn`, and
// the per-chunk results are merged via a `reduceFn`.
//
// This keeps existing behaviour for small documents while letting the AI
// "see" the full content of large ones instead of silently truncating.
// ============================================

const aiProvider = require("./aiProvider");
const aiConfig = require("../config/aiConfig");
const logger = require("../utils/logger");

// Tunables ------------------------------------------------------------------
// Chars per chunk. Keep well under the LLM context window so the system +
// user prompt + chunk + response all fit comfortably.
const CHUNK_SIZE = parseInt(process.env.AI_CHUNK_SIZE, 10) || 60_000;
// Soft cap above which we switch to chunked mode.
const CHUNK_THRESHOLD = parseInt(process.env.AI_CHUNK_THRESHOLD, 10) || 80_000;
// Char overlap between consecutive chunks so sentences spanning a boundary
// are not lost.
const CHUNK_OVERLAP = parseInt(process.env.AI_CHUNK_OVERLAP, 10) || 1_500;
// Hard upper bound on number of chunks to process. Even a 10MB text file
// caps at MAX_CHUNKS to keep cost / latency bounded.
const MAX_CHUNKS = parseInt(process.env.AI_MAX_CHUNKS, 10) || 12;
// Concurrency for the map step. AI providers throttle aggressively and large
// concurrency just means more 429s — keep this low.
const MAP_CONCURRENCY = parseInt(process.env.AI_MAP_CONCURRENCY, 10) || 2;

/**
 * Split text into roughly equal-sized chunks at sentence / paragraph
 * boundaries when possible.
 *
 * @param {string} text
 * @param {number} chunkSize
 * @param {number} overlap
 * @returns {string[]}
 */
function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  return chunkTextWithInfo(text, chunkSize, overlap).chunks;
}

/**
 * Like chunkText, but also reports how much of the document actually made it
 * into the chunks — MAX_CHUNKS can cut a very long document short, and the
 * caller has to be able to say so.
 *
 * @returns {{chunks: string[], truncated: boolean, processedChars: number}}
 */
function chunkTextWithInfo(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (!text || text.length <= chunkSize) {
    return {
      chunks: [text || ""],
      truncated: false,
      processedChars: (text || "").length,
    };
  }

  const chunks = [];
  let truncated = false;
  let processedChars = text.length;
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(pos + chunkSize, text.length);
    let sliceEnd = end;

    // Avoid slicing in the middle of a word — back off to last sensible
    // break (paragraph > sentence > newline > space) within the trailing
    // 2 KB of the chunk.
    if (end < text.length) {
      const tail = text.slice(end - 2_000, end);
      const candidates = [
        tail.lastIndexOf("\n\n"),
        tail.lastIndexOf(". "),
        tail.lastIndexOf("\n"),
        tail.lastIndexOf(" "),
      ].filter((i) => i > 0);
      if (candidates.length > 0) {
        const offsetFromEnd = 2_000 - Math.max(...candidates);
        if (offsetFromEnd < 1_500) sliceEnd = end - offsetFromEnd;
      }
    }

    chunks.push(text.slice(pos, sliceEnd));
    if (sliceEnd >= text.length) break;
    pos = Math.max(sliceEnd - overlap, pos + 1);
    if (chunks.length >= MAX_CHUNKS) {
      // Last chunk takes everything still remaining so no content is lost.
      const last = text.slice(pos);
      if (last && last !== chunks[chunks.length - 1]) {
        if (last.length > chunkSize) {
          chunks[chunks.length - 1] =
            chunks[chunks.length - 1] + "\n\n[…document continues; truncated for length…]";
          truncated = true;
          processedChars = pos;
        } else {
          chunks[chunks.length - 1] = chunks[chunks.length - 1] + "\n\n" + last;
        }
      }
      break;
    }
  }
  return { chunks, truncated, processedChars };
}

/**
 * Split text for translation: no overlap (it would duplicate sentences in the
 * output) and no chunk cap (the output limit is what bounds the work).
 *
 * @returns {string[]}
 */
function splitForTranslation(text, chunkChars) {
  const source = String(text || "");
  if (source.length <= chunkChars) return source ? [source] : [];

  const parts = [];
  let pos = 0;
  while (pos < source.length) {
    const end = Math.min(pos + chunkChars, source.length);
    let sliceEnd = end;

    if (end < source.length) {
      // Prefer a paragraph break, then a sentence end, then any line break.
      const window = source.slice(Math.max(pos, end - 2000), end);
      const candidates = [
        window.lastIndexOf("\n\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf("\n"),
      ].filter((i) => i > 0);
      if (candidates.length > 0) {
        sliceEnd = Math.max(pos, end - 2000) + Math.max(...candidates) + 1;
      }
    }
    if (sliceEnd <= pos) sliceEnd = end;

    parts.push(source.slice(pos, sliceEnd));
    pos = sliceEnd;
  }
  return parts;
}

/**
 * Run an async mapper over `items` with bounded concurrency.
 */
async function pMap(items, mapper, concurrency = MAP_CONCURRENCY) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await mapper(items[i], i);
      } catch (err) {
        results[i] = { __error: err };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Map-reduce a long text through the LLM.
 *
 * @param {object} opts
 *   text                      — full document text
 *   buildMapMessages(chunk,i) — returns messages array for a single chunk
 *   buildReduceMessages(parts,fullText) — returns messages array that
 *                                          merges chunk results
 *   chatOptions               — options passed to aiProvider.chat
 *   parseChunk(content,i)     — optional, parses a chunk response into a
 *                                richer shape; defaults to identity.
 *   threshold                 — char threshold above which to chunk
 * @returns {Promise<{provider:string, content:string, chunked:boolean, chunkCount:number, parts:any[]}>}
 */
async function mapReduceLong({
  text,
  buildMapMessages,
  buildReduceMessages,
  chatOptions = {},
  parseChunk = (c) => c,
  threshold = CHUNK_THRESHOLD,
  // What the caller already knows about the input: its true size before any
  // cap, and whether it was cut before reaching us.
  coverageInput = {},
}) {
  const safeText = String(text || "");
  const totalChars = coverageInput.totalChars ?? safeText.length;
  const inputTruncated = Boolean(coverageInput.truncated);

  if (safeText.length <= threshold) {
    // Small enough — run as a single call so the result quality matches the
    // original single-pass behaviour.
    const messages = buildMapMessages(safeText, 0);
    const result = await aiProvider.chat(messages, chatOptions);
    return {
      provider: result.provider,
      content: result.content,
      chunked: false,
      chunkCount: 1,
      parts: [parseChunk(result.content, 0)],
      usage: result.usage,
      coverage: {
        totalChars,
        processedChars: safeText.length,
        chunked: false,
        chunkCount: 1,
        truncated: inputTruncated,
      },
    };
  }

  const {
    chunks,
    truncated: chunkTruncated,
    processedChars,
  } = chunkTextWithInfo(safeText);
  logger.info(
    `[aiChunker] map-reduce over ${chunks.length} chunks ` +
      `(${safeText.length} chars, threshold=${threshold})`,
  );

  // Map step — process each chunk independently, with bounded concurrency.
  const mapResults = await pMap(
    chunks,
    async (chunk, i) => {
      const messages = buildMapMessages(chunk, i);
      const r = await aiProvider.chat(messages, chatOptions);
      return { content: r.content, parsed: parseChunk(r.content, i), provider: r.provider };
    },
    MAP_CONCURRENCY,
  );

  const goodParts = mapResults.filter((r) => r && !r.__error);
  if (goodParts.length === 0) {
    const firstErr = mapResults.find((r) => r && r.__error);
    throw firstErr ? firstErr.__error : new Error("All chunks failed during map step");
  }

  // Reduce step — let the LLM merge per-chunk outputs into one coherent answer.
  const partContents = goodParts.map((p) => p.content);
  const reduceMessages = buildReduceMessages(partContents, safeText);
  const reduced = await aiProvider.chat(reduceMessages, chatOptions);

  return {
    provider: reduced.provider || (goodParts[0] && goodParts[0].provider),
    content: reduced.content,
    chunked: true,
    chunkCount: chunks.length,
    parts: goodParts.map((p) => p.parsed),
    usage: reduced.usage,
    coverage: {
      totalChars,
      processedChars: Math.min(processedChars, safeText.length),
      chunked: true,
      chunkCount: chunks.length,
      truncated: inputTruncated || chunkTruncated,
    },
  };
}

/**
 * Translate a long document part by part.
 *
 * Translation can't map-reduce: the output is as long as the input, so a
 * 60k-char chunk could never fit in one reply. Parts are translated in order,
 * two at a time, and joined without a merge call — a merge would rewrite the
 * translation.
 *
 * @param {object} opts
 *   text            — full source text
 *   buildMessages(chunk, index, total) — messages for one part
 *   chatOptions     — passed to aiProvider.chat
 *   chunkChars      — target size of one part
 *   maxOutputChars  — stop cleanly at a part boundary once exceeded
 * @returns {Promise<{provider, content, chunked, chunkCount, usage, coverage}>}
 */
async function translateLong({
  text,
  buildMessages,
  chatOptions = {},
  chunkChars,
  maxOutputChars,
  concurrency = MAP_CONCURRENCY,
  coverageInput = {},
}) {
  const safeText = String(text || "");
  const totalChars = coverageInput.totalChars ?? safeText.length;
  const parts = splitForTranslation(safeText, chunkChars);

  const outputs = [];
  let processedChars = 0;
  let truncated = Boolean(coverageInput.truncated);
  let provider;
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  const addUsage = (u) => {
    if (!u) return;
    usage.promptTokens += u.promptTokens || 0;
    usage.completionTokens += u.completionTokens || 0;
    usage.totalTokens += u.totalTokens || 0;
  };

  /**
   * Translate one part. A reply cut off at max_tokens is retried once as two
   * halves, which is the only reliable way to fit it.
   */
  const translatePart = async (chunk, index) => {
    const result = await aiProvider.chat(buildMessages(chunk, index, parts.length), chatOptions);
    addUsage(result.usage);
    provider = provider || result.provider;

    if (result.stopReason !== "max_tokens") {
      return { text: result.content, complete: true };
    }

    logger.warn(
      `[translate] part ${index + 1}/${parts.length} hit the output limit — splitting and retrying`,
    );

    const halves = splitForTranslation(chunk, Math.ceil(chunk.length / 2));
    const translatedHalves = [];
    let complete = true;
    for (let h = 0; h < halves.length; h++) {
      const retry = await aiProvider.chat(
        buildMessages(halves[h], index, parts.length),
        chatOptions,
      );
      addUsage(retry.usage);
      translatedHalves.push(retry.content);
      if (retry.stopReason === "max_tokens") complete = false;
    }
    return { text: translatedHalves.join("\n\n"), complete };
  };

  for (let start = 0; start < parts.length; start += concurrency) {
    const batch = parts.slice(start, start + concurrency);
    const results = await Promise.all(
      batch.map((chunk, offset) => translatePart(chunk, start + offset)),
    );

    for (let i = 0; i < results.length; i++) {
      outputs.push(results[i].text);
      processedChars += batch[i].length;
      if (!results[i].complete) truncated = true;
    }

    const producedChars = outputs.reduce((n, part) => n + part.length, 0);
    if (producedChars >= maxOutputChars && start + concurrency < parts.length) {
      logger.warn(
        `[translate] stopping at part ${outputs.length}/${parts.length}: ` +
          `output limit of ${maxOutputChars} chars reached`,
      );
      truncated = true;
      break;
    }
  }

  return {
    provider,
    content: outputs.join("\n\n"),
    chunked: parts.length > 1,
    chunkCount: parts.length,
    usage: usage.totalTokens > 0 ? usage : undefined,
    coverage: {
      totalChars,
      processedChars,
      chunked: parts.length > 1,
      chunkCount: parts.length,
      truncated,
    },
  };
}

module.exports = {
  chunkText,
  chunkTextWithInfo,
  splitForTranslation,
  pMap,
  mapReduceLong,
  translateLong,
  CHUNK_SIZE,
  CHUNK_THRESHOLD,
  CHUNK_OVERLAP,
  MAX_CHUNKS,
};
