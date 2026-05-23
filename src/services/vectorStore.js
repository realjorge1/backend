/**
 * Vector Store
 * In-memory vector index with cosine similarity search.
 * Stores chunk embeddings and retrieves the most relevant ones for a query.
 */

const logger = require("../utils/logger");

/**
 * Compute cosine similarity between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} Similarity score between -1 and 1
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Search for the most similar chunks to a query embedding.
 *
 * @param {number[]} queryEmbedding - The query vector
 * @param {Array<{chunkId: number, embedding: number[], text: string, pages: number[]}>} chunkEmbeddings
 * @param {number} topK - Number of results to return
 * @param {number} minScore - Minimum similarity score threshold
 * @returns {Array<{chunkId: number, text: string, pages: number[], score: number}>}
 */
function searchSimilar(
  queryEmbedding,
  chunkEmbeddings,
  topK = 5,
  minScore = 0.1,
) {
  const scored = chunkEmbeddings.map((chunk) => ({
    chunkId: chunk.chunkId,
    text: chunk.text,
    pages: chunk.pages,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Filter by minimum score and take top K
  const results = scored.filter((r) => r.score >= minScore).slice(0, topK);

  return results;
}

/**
 * Hybrid search: combines embedding similarity with keyword matching.
 * Returns chunks ranked by a weighted combination of both signals.
 *
 * @param {string} query - The user's question
 * @param {number[]} queryEmbedding - Embedding of the query
 * @param {Array<{chunkId, embedding, text, pages}>} chunkEmbeddings
 * @param {number} topK
 * @returns {Array<{chunkId, text, pages, score, embeddingScore, keywordScore}>}
 */
function hybridSearch(query, queryEmbedding, chunkEmbeddings, topK = 5) {
  const queryWords = tokenize(query);

  const scored = chunkEmbeddings.map((chunk) => {
    // Embedding similarity score
    const embeddingScore = cosineSimilarity(queryEmbedding, chunk.embedding);

    // Keyword overlap score (normalized)
    const chunkWords = tokenize(chunk.text);
    const keywordHits = queryWords.reduce((acc, word) => {
      return acc + (chunkWords.includes(word) ? 1 : 0);
    }, 0);
    const keywordScore =
      queryWords.length > 0 ? keywordHits / queryWords.length : 0;

    // Weighted combination: 70% embedding, 30% keyword
    const combinedScore = embeddingScore * 0.7 + keywordScore * 0.3;

    return {
      chunkId: chunk.chunkId,
      text: chunk.text,
      pages: chunk.pages,
      score: combinedScore,
      embeddingScore,
      keywordScore,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  // Always include first chunk (intro context) if not already present
  const top = scored.slice(0, topK);
  const hasFirstChunk = top.some((c) => c.chunkId === 0);
  if (!hasFirstChunk && chunkEmbeddings.length > 0 && top.length > 0) {
    const firstChunk = scored.find((c) => c.chunkId === 0);
    if (firstChunk) {
      top[top.length - 1] = firstChunk;
    }
  }

  // Re-sort by document order for coherent reading
  top.sort((a, b) => a.chunkId - b.chunkId);

  return top;
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

module.exports = { cosineSimilarity, searchSimilar, hybridSearch };
