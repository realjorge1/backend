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
  if (!text || text.length <= chunkSize) return [text || ""];

  const chunks = [];
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
        chunks[chunks.length - 1] =
          chunks[chunks.length - 1] +
          (last.length > chunkSize ? "\n\n[…document continues; truncated for length…]" : "\n\n" + last);
      }
      break;
    }
  }
  return chunks;
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
}) {
  const safeText = String(text || "");

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
    };
  }

  const chunks = chunkText(safeText);
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
  };
}

module.exports = {
  chunkText,
  pMap,
  mapReduceLong,
  CHUNK_SIZE,
  CHUNK_THRESHOLD,
  CHUNK_OVERLAP,
  MAX_CHUNKS,
};
