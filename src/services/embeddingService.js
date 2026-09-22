/**
 * Embedding Service
 * Generates vector embeddings for text chunks using available AI providers.
 * Supports OpenAI, Gemini, and falls back to TF-IDF keyword vectors.
 */

const aiConfig = require("../config/aiConfig");
const logger = require("../utils/logger");

// Lazy-loaded provider clients
let _openai = null;
let _gemini = null;

function getOpenAI() {
  if (!_openai && aiConfig.openai.apiKey) {
    try {
      const OpenAI = require("openai");
      _openai = new OpenAI({ apiKey: aiConfig.openai.apiKey });
    } catch {
      _openai = null;
    }
  }
  return _openai;
}

function getGemini() {
  if (!_gemini && aiConfig.gemini.apiKey) {
    try {
      const { GoogleGenerativeAI } = require("@google/generative-ai");
      _gemini = new GoogleGenerativeAI(aiConfig.gemini.apiKey);
    } catch {
      _gemini = null;
    }
  }
  return _gemini;
}

/**
 * Generate embeddings for an array of text strings.
 * Tries: OpenAI → Gemini → local TF-IDF fallback.
 *
 * @param {string[]} texts - Array of text chunks to embed
 * @returns {Promise<{embeddings: number[][], provider: string}>}
 */
async function generateEmbeddings(texts) {
  if (!texts || texts.length === 0) {
    return { embeddings: [], provider: "none" };
  }

  // Try OpenAI embeddings
  const openai = getOpenAI();
  if (openai) {
    try {
      return await generateOpenAIEmbeddings(openai, texts);
    } catch (err) {
      logger.warn("[embeddings] OpenAI embeddings failed:", err.message);
    }
  }

  // Try Gemini embeddings
  const gemini = getGemini();
  if (gemini) {
    try {
      return await generateGeminiEmbeddings(gemini, texts);
    } catch (err) {
      logger.warn("[embeddings] Gemini embeddings failed:", err.message);
    }
  }

  // Fallback: local TF-IDF-style embeddings
  logger.info("[embeddings] Using local TF-IDF fallback");
  return { embeddings: generateLocalEmbeddings(texts), provider: "local" };
}

/**
 * Generate embedding for a single text string.
 */
async function generateSingleEmbedding(text) {
  const result = await generateEmbeddings([text]);
  return { embedding: result.embeddings[0], provider: result.provider };
}

// ─── OpenAI Embeddings ─────────────────────────────────────────────────────

async function generateOpenAIEmbeddings(client, texts) {
  // Process in batches of 100 (OpenAI limit is 2048)
  const BATCH_SIZE = 100;
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: batch,
    });
    for (const item of response.data) {
      allEmbeddings.push(item.embedding);
    }
  }

  logger.info(
    `[embeddings] OpenAI generated ${allEmbeddings.length} embeddings`,
  );
  return { embeddings: allEmbeddings, provider: "openai" };
}

// ─── Gemini Embeddings ─────────────────────────────────────────────────────

async function generateGeminiEmbeddings(client, texts) {
  const model = client.getGenerativeModel({ model: "text-embedding-004" });
  const allEmbeddings = [];

  // Gemini supports batch embedding
  const BATCH_SIZE = 100;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const result = await model.batchEmbedContents({
      requests: batch.map((text) => ({
        content: { parts: [{ text }] },
      })),
    });
    for (const emb of result.embeddings) {
      allEmbeddings.push(emb.values);
    }
  }

  logger.info(
    `[embeddings] Gemini generated ${allEmbeddings.length} embeddings`,
  );
  return { embeddings: allEmbeddings, provider: "gemini" };
}

// ─── Local TF-IDF Fallback Embeddings ──────────────────────────────────────

/**
 * Build a simple TF-IDF inspired vector for each text.
 * Not as good as neural embeddings but works offline.
 */
function generateLocalEmbeddings(texts) {
  // 1. Build vocabulary from all texts
  const vocab = new Map();
  const tokenizedTexts = texts.map((text) => tokenize(text));

  // Document frequency
  for (const tokens of tokenizedTexts) {
    const unique = new Set(tokens);
    for (const word of unique) {
      vocab.set(word, (vocab.get(word) || 0) + 1);
    }
  }

  // Keep top N most discriminative words (not too common, not too rare)
  const VECTOR_DIM = 256;
  const sorted = [...vocab.entries()]
    .filter(([, df]) => df >= 1 && df <= texts.length * 0.9)
    .sort((a, b) => b[1] - a[1])
    .slice(0, VECTOR_DIM);

  const wordToIdx = new Map(sorted.map(([word], idx) => [word, idx]));

  // 2. Generate TF-IDF vector for each text
  const embeddings = tokenizedTexts.map((tokens) => {
    const vec = new Array(VECTOR_DIM).fill(0);
    const tf = new Map();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    for (const [word, count] of tf.entries()) {
      const idx = wordToIdx.get(word);
      if (idx !== undefined) {
        const tfVal = count / tokens.length;
        const idfVal = Math.log(texts.length / (vocab.get(word) || 1));
        vec[idx] = tfVal * idfVal;
      }
    }

    // L2 normalize
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }
    return vec;
  });

  return embeddings;
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/**
 * Embed a document's chunks during ingestion.
 *
 * The local TF-IDF fallback is deliberately not treated as an embedding
 * provider: its vectors carry no cross-document meaning, so a document it
 * "embedded" is really a keyword-retrieval document.
 *
 * @param {Array<{chunkId: number, text: string}>} chunks
 * @returns {Promise<{chunks: Array, embedding: {provider, model, dims}|null}>}
 */
async function embedChunks(chunks) {
  if (!chunks || chunks.length === 0) return { chunks: chunks || [], embedding: null };

  const { embeddings, provider } = await generateEmbeddings(chunks.map((c) => c.text));
  if (provider === "local" || provider === "none") {
    return { chunks, embedding: null };
  }

  const embedded = chunks.map((chunk, i) => ({
    ...chunk,
    embedding: Array.isArray(embeddings[i]) && embeddings[i].length > 0 ? embeddings[i] : null,
  }));
  const dims = embedded.find((c) => c.embedding)?.embedding?.length || 0;
  if (!dims) return { chunks, embedding: null };

  const model =
    provider === "openai"
      ? "text-embedding-3-small"
      : provider === "gemini"
        ? "text-embedding-004"
        : provider;

  return { chunks: embedded, embedding: { provider, model, dims } };
}

module.exports = {
  generateEmbeddings,
  generateSingleEmbedding,
  embedChunks,
};
