/**
 * Embedding Service
 *
 * Produces real vectors from a real provider, or nothing at all. There is no
 * local fallback: the previous TF-IDF "embeddings" produced an all-zero
 * vector for every question (a single text has no document frequencies to
 * work with), which silently reduced every search to keyword matching while
 * reporting itself as semantic.
 *
 * A document records which provider and model embedded it, and questions are
 * embedded the same way. If that isn't possible, retrieval drops to keyword
 * mode for that question — never to a zero vector.
 */

const apiConfig = require("../config/apiConfig");
const aiConfig = require("../config/aiConfig");
const logger = require("../utils/logger");

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

let _openai = null;
let _gemini = null;

function getOpenAI() {
  if (!_openai && aiConfig.openai.apiKey) {
    const OpenAI = require("openai");
    _openai = new OpenAI({ apiKey: aiConfig.openai.apiKey });
  }
  return _openai;
}

function getGemini() {
  if (!_gemini && aiConfig.gemini.apiKey) {
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    _gemini = new GoogleGenerativeAI(aiConfig.gemini.apiKey);
  }
  return _gemini;
}

/**
 * Which provider embeds new documents on this server.
 * EMBEDDINGS_PROVIDER wins; otherwise the first provider with a key.
 * @returns {{provider: string, model: string}|null}
 */
function resolveProvider() {
  const configured = apiConfig.retrieval.embeddingsProvider;

  const available = {
    openai: () =>
      aiConfig.openai.apiKey
        ? { provider: "openai", model: apiConfig.retrieval.openaiModel }
        : null,
    gemini: () =>
      aiConfig.gemini.apiKey
        ? { provider: "gemini", model: apiConfig.retrieval.geminiModel }
        : null,
    voyage: () =>
      apiConfig.retrieval.voyageApiKey
        ? { provider: "voyage", model: apiConfig.retrieval.voyageModel }
        : null,
  };

  if (configured === "none") return null;
  if (configured && available[configured]) {
    const resolved = available[configured]();
    if (!resolved) {
      logger.warn(
        `[embeddings] EMBEDDINGS_PROVIDER=${configured} but its API key is not set — ` +
          "documents will use keyword retrieval",
      );
      return null;
    }
    return resolved;
  }
  if (configured) {
    logger.warn(`[embeddings] Unknown EMBEDDINGS_PROVIDER=${configured}; auto-detecting`);
  }

  return available.openai() || available.gemini() || available.voyage() || null;
}

/** A vector is only usable if it exists and isn't all zeros. */
function isUsableVector(vector) {
  return (
    Array.isArray(vector) &&
    vector.length > 0 &&
    vector.some((v) => typeof v === "number" && Number.isFinite(v) && v !== 0)
  );
}

function isRetryable(err) {
  const status = err?.status ?? err?.response?.status;
  if (status && RETRYABLE_STATUS.has(status)) return true;
  return ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(err?.code);
}

async function withRetry(label, fn) {
  const maxAttempts = apiConfig.retrieval.maxRetries;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === maxAttempts) break;
      const backoffMs = 500 * 2 ** (attempt - 1);
      logger.warn(
        `[embeddings] ${label} attempt ${attempt}/${maxAttempts} failed; retrying in ${backoffMs}ms`,
        { error: err.message },
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastError;
}

// ─── Providers ───────────────────────────────────────────────────────────────

async function embedWithOpenAI(texts, model) {
  const client = getOpenAI();
  if (!client) throw new Error("OpenAI API key is not configured");
  const response = await client.embeddings.create({ model, input: texts });
  return response.data.map((item) => item.embedding);
}

async function embedWithGemini(texts, model) {
  const client = getGemini();
  if (!client) throw new Error("Gemini API key is not configured");
  const embedder = client.getGenerativeModel({ model });
  const result = await embedder.batchEmbedContents({
    requests: texts.map((text) => ({ content: { parts: [{ text }] } })),
  });
  return result.embeddings.map((e) => e.values);
}

async function embedWithVoyage(texts, model) {
  const apiKey = apiConfig.retrieval.voyageApiKey;
  if (!apiKey) throw new Error("VOYAGE_API_KEY is not configured");
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const err = new Error(`Voyage embeddings failed with ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const body = await response.json();
  return body.data.map((item) => item.embedding);
}

const PROVIDERS = {
  openai: embedWithOpenAI,
  gemini: embedWithGemini,
  voyage: embedWithVoyage,
};

/**
 * Embed texts with a specific provider and model, in batches with retries.
 * @returns {Promise<number[][]>} one vector per input, in order
 */
async function embedTexts(texts, { provider, model }) {
  const embed = PROVIDERS[provider];
  if (!embed) throw new Error(`Unknown embeddings provider: ${provider}`);

  const batchSize = apiConfig.retrieval.batchSize;
  const vectors = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchVectors = await withRetry(`${provider} batch ${i / batchSize + 1}`, () =>
      embed(batch, model),
    );
    vectors.push(...batchVectors);
  }
  return vectors;
}

/**
 * Embed a document's chunks during ingestion.
 * Failure is never fatal: the document is simply stored for keyword retrieval.
 *
 * @param {Array<{chunkId: number, text: string}>} chunks
 * @returns {Promise<{chunks: Array, embedding: {provider, model, dims}|null}>}
 */
async function embedChunks(chunks) {
  if (!chunks || chunks.length === 0) return { chunks: chunks || [], embedding: null };

  const resolved = resolveProvider();
  if (!resolved) return { chunks, embedding: null };

  let vectors;
  try {
    vectors = await embedTexts(
      chunks.map((c) => c.text),
      resolved,
    );
  } catch (err) {
    logger.warn(
      `[embeddings] ${resolved.provider} failed; storing document for keyword retrieval`,
      { error: err.message },
    );
    return { chunks, embedding: null };
  }

  const embedded = chunks.map((chunk, i) => ({
    ...chunk,
    embedding: isUsableVector(vectors[i]) ? vectors[i] : null,
  }));

  const dims = embedded.find((c) => c.embedding)?.embedding?.length || 0;
  if (!dims) {
    logger.warn("[embeddings] Provider returned no usable vectors; keyword retrieval");
    return { chunks, embedding: null };
  }

  logger.info(
    `[embeddings] Embedded ${embedded.filter((c) => c.embedding).length}/${chunks.length} ` +
      `chunks via ${resolved.provider}/${resolved.model} (${dims} dims)`,
  );

  return {
    chunks: embedded,
    embedding: { provider: resolved.provider, model: resolved.model, dims },
  };
}

/**
 * Embed a question with the provider and model the document was embedded
 * with. Returns null — never a zero vector — when that can't be done, which
 * puts this question into keyword mode.
 *
 * @param {string} text
 * @param {{provider: string, model: string, dims: number}} docEmbedding
 * @returns {Promise<number[]|null>}
 */
async function embedQuery(text, docEmbedding) {
  if (!docEmbedding?.provider || !PROVIDERS[docEmbedding.provider]) return null;

  const model = docEmbedding.model || resolveProvider()?.model;
  if (!model) return null;

  let vectors;
  try {
    vectors = await embedTexts([text], { provider: docEmbedding.provider, model });
  } catch (err) {
    logger.warn(`[embeddings] Query embedding failed via ${docEmbedding.provider}`, {
      error: err.message,
    });
    return null;
  }

  const vector = vectors[0];
  if (!isUsableVector(vector)) return null;

  // A model swap behind the same name would silently produce nonsense scores.
  if (docEmbedding.dims && vector.length !== docEmbedding.dims) {
    logger.warn(
      `[embeddings] Dimension mismatch (document ${docEmbedding.dims}, query ${vector.length}) — keyword mode`,
    );
    return null;
  }

  return vector;
}

module.exports = {
  resolveProvider,
  embedTexts,
  embedChunks,
  embedQuery,
  isUsableVector,
};
