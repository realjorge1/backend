/**
 * Retrieval
 *
 * One function selects the chunks every grounded answer is built from —
 * /chat-document, /ask-pdf and quiz generation all go through it, so they
 * cannot drift apart.
 *
 * Scoring is BM25 over chunk text, optionally blended with cosine similarity
 * when the document has real embeddings:
 *
 *   hybrid  = 0.7 * cosine + 0.3 * bm25normalized
 *   keyword = bm25normalized
 *
 * There is no third mode: a document without embeddings, or a question whose
 * embedding could not be produced, is answered from BM25 alone. A zero vector
 * is never used as a stand-in.
 */

const apiConfig = require("../config/apiConfig");
const logger = require("../utils/logger");

const K1 = 1.2;
const B = 0.75;
const EMBEDDING_WEIGHT = 0.7;
const BM25_WEIGHT = 0.3;
// Two chunks sharing this much of their vocabulary are near-duplicates.
const DUPLICATE_JACCARD = 0.9;

// Deliberately short: only words that carry no retrieval signal in any
// document. Anything longer starts hurting non-English text.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has",
  "have", "he", "her", "his", "in", "is", "it", "its", "of", "on", "or", "our",
  "she", "that", "the", "their", "them", "there", "these", "they", "this",
  "to", "was", "were", "what", "when", "where", "which", "who", "will",
  "with", "you", "your",
]);

const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/u;

/**
 * Unicode-aware tokenizer: keeps numbers and non-ASCII letters, drops
 * punctuation. Scripts that don't separate words (Chinese, Japanese) also
 * yield character bigrams, without which a whole sentence would collapse into
 * one unmatchable token.
 */
function tokenize(text) {
  const raw = String(text || "").toLowerCase().match(WORD_PATTERN) || [];
  const tokens = [];
  for (const token of raw) {
    if (CJK_PATTERN.test(token)) {
      tokens.push(token);
      for (let i = 0; i < token.length - 1; i++) tokens.push(token.slice(i, i + 2));
      continue;
    }
    if (token.length < 2) continue;
    if (STOPWORDS.has(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

/** Precompute document frequencies and lengths for a set of chunks. */
function buildIndex(chunks) {
  const tokensByChunk = chunks.map((c) => tokenize(c.text));
  const docFreq = new Map();
  for (const tokens of tokensByChunk) {
    for (const term of new Set(tokens)) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
  }
  const lengths = tokensByChunk.map((t) => t.length);
  const avgLength = lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1);
  return { tokensByChunk, docFreq, lengths, avgLength, total: chunks.length };
}

/** Okapi BM25 score of every chunk against the query. */
function bm25Scores(query, index) {
  const queryTerms = tokenize(query);
  const scores = new Array(index.total).fill(0);
  if (queryTerms.length === 0) return scores;

  const termCounts = index.tokensByChunk.map((tokens) => {
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    return counts;
  });

  for (const term of new Set(queryTerms)) {
    const df = index.docFreq.get(term) || 0;
    if (df === 0) continue;
    // BM25's probabilistic idf, floored so very common terms can't go negative.
    const idf = Math.max(
      0,
      Math.log((index.total - df + 0.5) / (df + 0.5) + 1),
    );
    for (let i = 0; i < index.total; i++) {
      const tf = termCounts[i].get(term) || 0;
      if (tf === 0) continue;
      const norm = 1 - B + (B * index.lengths[i]) / (index.avgLength || 1);
      scores[i] += (idf * (tf * (K1 + 1))) / (tf + K1 * norm);
    }
  }
  return scores;
}

function minMaxNormalize(values) {
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = max - min;
  if (range === 0) return values.map(() => 0);
  return values.map((v) => (v - min) / range);
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Rank and select chunks for a question.
 *
 * @param {object} params
 *   chunks         — [{ chunkId, text, unitIndexes, embedding? }]
 *   question       — the user's question
 *   queryEmbedding — question vector, or null for keyword mode
 *   topK           — how many chunks to consider (default RAG_TOP_K)
 *   budgetChars    — total context budget (default RAG_CONTEXT_CHARS)
 * @returns {{chunks: Array, mode: "hybrid"|"keyword", scores: Array}}
 */
function selectChunks({
  chunks,
  question,
  queryEmbedding = null,
  topK = apiConfig.retrieval.topK,
  budgetChars = apiConfig.retrieval.contextChars,
}) {
  const source = Array.isArray(chunks) ? chunks.filter((c) => c && c.text) : [];
  if (source.length === 0) return { chunks: [], mode: "keyword", scores: [] };

  const index = buildIndex(source);
  const keywordScores = minMaxNormalize(bm25Scores(question, index));

  const usable =
    Array.isArray(queryEmbedding) &&
    queryEmbedding.length > 0 &&
    source.some(
      (c) => Array.isArray(c.embedding) && c.embedding.length === queryEmbedding.length,
    );
  const mode = usable ? "hybrid" : "keyword";

  const ranked = source.map((chunk, i) => {
    const embeddingScore =
      usable && Array.isArray(chunk.embedding)
        ? cosineSimilarity(queryEmbedding, chunk.embedding)
        : 0;
    const score = usable
      ? EMBEDDING_WEIGHT * embeddingScore + BM25_WEIGHT * keywordScores[i]
      : keywordScores[i];
    return {
      ...chunk,
      score,
      embeddingScore,
      keywordScore: keywordScores[i],
      _tokens: index.tokensByChunk[i],
    };
  });

  const byScore = [...ranked].sort((a, b) => b.score - a.score);

  // Take the best chunks, skipping near-duplicates and respecting the budget.
  const picked = [];
  let used = 0;
  for (const candidate of byScore) {
    if (picked.length >= topK) break;
    if (picked.some((p) => jaccard(p._tokens, candidate._tokens) >= DUPLICATE_JACCARD)) {
      continue;
    }
    const cost = candidate.text.length + 2;
    if (used + cost > budgetChars) continue;
    picked.push(candidate);
    used += cost;
  }

  // The opening chunk usually carries the title and framing — worth having,
  // but never at the cost of a better-scoring chunk.
  if (!picked.some((c) => c.chunkId === source[0].chunkId)) {
    const first = ranked.find((c) => c.chunkId === source[0].chunkId);
    if (first && used + first.text.length + 2 <= budgetChars && picked.length < topK) {
      picked.push(first);
      used += first.text.length + 2;
    }
  }

  // Hand them back in document order so the model reads them coherently.
  picked.sort((a, b) => a.chunkId - b.chunkId);

  return {
    chunks: picked.map(({ _tokens, ...chunk }) => chunk),
    mode,
    scores: ranked.map((r) => r.score),
  };
}

/**
 * Retrieve for a stored document, embedding the question with the same
 * provider and model the document was embedded with. Anything that makes that
 * impossible falls back to keyword mode for this question only.
 *
 * @returns {Promise<{chunks, mode, embeddingProvider}>}
 */
async function retrieveForQuestion(doc, question, options = {}) {
  let queryEmbedding = null;
  let embeddingProvider = null;

  if (doc?.embedding?.provider) {
    try {
      const { embedQuery } = require("./embeddingService");
      queryEmbedding = await embedQuery(question, doc.embedding);
      if (queryEmbedding) embeddingProvider = doc.embedding.provider;
    } catch (err) {
      logger.warn("[retrieval] Question embedding failed; using keyword mode", {
        error: err.message,
      });
      queryEmbedding = null;
    }
  }

  const result = selectChunks({
    chunks: doc?.chunks || [],
    question,
    queryEmbedding,
    ...options,
  });

  return {
    ...result,
    embeddingProvider: result.mode === "hybrid" ? embeddingProvider : null,
  };
}

/**
 * Context for quiz generation. A quiz has no question, so coverage matters
 * more than relevance: weak topics (when the app supplies them) are scored
 * with the same BM25 machinery and go in first, then evenly spaced chunks
 * fill the remaining budget so questions can be drawn from the whole
 * document rather than only its opening.
 *
 * @returns {string} context text, chunks in document order
 */
function buildQuizContext(doc, { weakTopics = [], budgetChars = 14000 } = {}) {
  let chunks = Array.isArray(doc?.chunks) ? doc.chunks.filter((c) => c && c.text) : [];

  // Very small documents may have been stored without chunks; fall back to
  // their units so a one-page file can still produce a quiz.
  if (chunks.length === 0 && Array.isArray(doc?.units)) {
    chunks = doc.units
      .filter((u) => u && u.text && u.text.trim())
      .map((u, i) => ({
        chunkId: i,
        text: `[${u.label}]\n${u.text.trim()}`,
        unitIndexes: [u.index],
      }));
  }
  if (chunks.length === 0) return "";

  const picked = new Set();
  let used = 0;

  const take = (chunk) => {
    if (!chunk || picked.has(chunk.chunkId)) return;
    const cost = chunk.text.length + 2;
    if (used + cost > budgetChars) return;
    picked.add(chunk.chunkId);
    used += cost;
  };

  const topics = (weakTopics || []).filter((t) => String(t || "").trim().length > 2);
  if (topics.length > 0) {
    const { chunks: relevant } = selectChunks({
      chunks,
      question: topics.join(" "),
      topK: Math.min(8, chunks.length),
      budgetChars,
    });
    for (const chunk of relevant) take(chunk);
  }

  take(chunks[0]);
  const samples = Math.min(6, chunks.length);
  for (let s = 1; s < samples - 1; s++) {
    take(chunks[Math.floor((s * chunks.length) / samples)]);
  }
  take(chunks[chunks.length - 1]);
  for (const chunk of chunks) take(chunk);

  return chunks
    .filter((c) => picked.has(c.chunkId))
    .map((c) => c.text.trim())
    .join("\n\n");
}

/** Join selected chunks into a single context string within the budget. */
function buildContext(chunks, budgetChars = apiConfig.retrieval.contextChars) {
  let context = "";
  for (const chunk of chunks) {
    if (context.length + chunk.text.length + 8 > budgetChars) break;
    context += (context ? "\n\n---\n\n" : "") + chunk.text;
  }
  return context;
}

module.exports = {
  tokenize,
  buildIndex,
  bm25Scores,
  cosineSimilarity,
  selectChunks,
  retrieveForQuestion,
  buildQuizContext,
  buildContext,
};
