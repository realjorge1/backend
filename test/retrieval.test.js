/**
 * B3 — retrieval: BM25, hybrid blending, tokenization and the guarantee that
 * a zero vector is never used as a query embedding.
 */

const { test } = require("node:test");
const assert = require("node:assert");

const {
  tokenize,
  bm25Scores,
  buildIndex,
  selectChunks,
  retrieveForQuestion,
  buildQuizContext,
} = require("../src/services/retrieval");
const { isUsableVector, resolveProvider } = require("../src/services/embeddingService");

const CHUNKS = [
  {
    chunkId: 0,
    text: "[Page 1]\nThis annual report covers the fiscal year and its overall performance.",
    unitIndexes: [1],
  },
  {
    chunkId: 1,
    text: "[Page 2]\nThe warranty period extends twenty four months from the delivery date.",
    unitIndexes: [2],
  },
  {
    chunkId: 2,
    text: "[Page 3]\nEmployee headcount grew from 120 to 168 across the engineering org.",
    unitIndexes: [3],
  },
];

// ─── Tokenizer ───────────────────────────────────────────────────────────────

test("tokenizer keeps numbers and drops punctuation and stopwords", () => {
  const tokens = tokenize("The warranty is 24 months, from delivery!");
  assert.ok(tokens.includes("warranty"));
  assert.ok(tokens.includes("24"), "numbers must survive tokenization");
  assert.ok(tokens.includes("months"));
  assert.ok(!tokens.includes("the"), "stopwords should be dropped");
  assert.ok(!tokens.some((t) => t.includes(",")), "punctuation should be stripped");
});

test("tokenizer keeps non-ASCII letters", () => {
  assert.deepStrictEqual(tokenize("Größe beträgt 30 Zentimeter"), [
    "größe",
    "beträgt",
    "30",
    "zentimeter",
  ]);
  assert.ok(tokenize("garantía de instalación").includes("garantía"));
  assert.ok(tokenize("Гарантия составляет").includes("гарантия"));
});

test("tokenizer produces bigrams for scripts without word spacing", () => {
  const tokens = tokenize("保証期間");
  assert.ok(tokens.includes("保証期間"), "whole run is kept");
  assert.ok(tokens.includes("保証"), "bigrams make partial matches possible");
});

// ─── BM25 ────────────────────────────────────────────────────────────────────

test("BM25 ranks the obvious chunk first", () => {
  const index = buildIndex(CHUNKS);
  const scores = bm25Scores("How long is the warranty period?", index);
  const best = scores.indexOf(Math.max(...scores));
  assert.strictEqual(best, 1, "the warranty chunk should win");
  assert.ok(scores[1] > scores[0] && scores[1] > scores[2]);
});

test("BM25 matches on numbers", () => {
  const index = buildIndex(CHUNKS);
  const scores = bm25Scores("headcount 168", index);
  assert.strictEqual(scores.indexOf(Math.max(...scores)), 2);
});

test("a question matching nothing does not crash or invent a winner", () => {
  const result = selectChunks({ chunks: CHUNKS, question: "zzzz qqqq" });
  assert.strictEqual(result.mode, "keyword");
  assert.ok(Array.isArray(result.chunks));
});

// ─── Selection ───────────────────────────────────────────────────────────────

test("selection returns chunks in document order", () => {
  const { chunks } = selectChunks({ chunks: CHUNKS, question: "warranty headcount" });
  const ids = chunks.map((c) => c.chunkId);
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => a - b));
});

test("selection respects the character budget", () => {
  const { chunks } = selectChunks({
    chunks: CHUNKS,
    question: "warranty",
    budgetChars: 90,
  });
  const total = chunks.reduce((n, c) => n + c.text.length, 0);
  assert.ok(total <= 90, `selected ${total} chars, budget was 90`);
  assert.ok(chunks.length >= 1);
});

test("near-duplicate chunks are not both selected", () => {
  const duplicated = [
    CHUNKS[1],
    { ...CHUNKS[1], chunkId: 99 },
    CHUNKS[2],
  ];
  const { chunks } = selectChunks({ chunks: duplicated, question: "warranty period" });
  const warrantyChunks = chunks.filter((c) => c.text.includes("warranty"));
  assert.strictEqual(warrantyChunks.length, 1, "only one copy should survive");
});

test("the first chunk is included only when budget remains", () => {
  const roomy = selectChunks({ chunks: CHUNKS, question: "warranty", budgetChars: 16000 });
  assert.ok(roomy.chunks.some((c) => c.chunkId === 0), "first chunk fits here");

  const tight = selectChunks({ chunks: CHUNKS, question: "warranty", budgetChars: 85 });
  assert.ok(tight.chunks.some((c) => c.chunkId === 1), "the best chunk is kept");
  assert.ok(
    !tight.chunks.some((c) => c.chunkId === 0),
    "the first chunk must not push out a better one",
  );
});

test("topK caps how many chunks come back", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    chunkId: i,
    text: `[Page ${i + 1}]\nThe warranty section number ${i} describes coverage details.`,
    unitIndexes: [i + 1],
  }));
  const { chunks } = selectChunks({ chunks: many, question: "warranty coverage", topK: 8 });
  assert.ok(chunks.length <= 8, `expected at most 8, got ${chunks.length}`);
});

// ─── Hybrid mode ─────────────────────────────────────────────────────────────

function withEmbeddings(chunks, vectors) {
  return chunks.map((c, i) => ({ ...c, embedding: vectors[i] }));
}

test("hybrid mode uses embeddings when dimensions line up", () => {
  const embedded = withEmbeddings(CHUNKS, [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
  const { mode, chunks } = selectChunks({
    chunks: embedded,
    question: "totally unrelated words",
    queryEmbedding: [0, 1, 0],
  });
  assert.strictEqual(mode, "hybrid");
  // The embedding points at chunk 1 even though the words don't match.
  assert.ok(chunks.some((c) => c.chunkId === 1));
});

test("a dimension mismatch falls back to keyword mode instead of scoring garbage", () => {
  const embedded = withEmbeddings(CHUNKS, [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
  const { mode } = selectChunks({
    chunks: embedded,
    question: "warranty",
    queryEmbedding: [0.5, 0.5], // wrong size
  });
  assert.strictEqual(mode, "keyword");
});

test("a document without embeddings is keyword mode", () => {
  const { mode } = selectChunks({
    chunks: CHUNKS,
    question: "warranty",
    queryEmbedding: [0.1, 0.2, 0.3],
  });
  assert.strictEqual(mode, "keyword");
});

test("retrieveForQuestion drops to keyword mode when the query embedding fails", async () => {
  const doc = {
    chunks: withEmbeddings(CHUNKS, [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]),
    embedding: { provider: "openai", model: "text-embedding-3-small", dims: 3 },
  };

  const embeddingService = require("../src/services/embeddingService");
  const original = embeddingService.embedQuery;
  embeddingService.embedQuery = async () => {
    throw new Error("provider is down");
  };
  try {
    const result = await retrieveForQuestion(doc, "warranty period");
    assert.strictEqual(result.mode, "keyword");
    assert.strictEqual(result.embeddingProvider, null);
    assert.ok(result.chunks.length > 0, "an answer is still possible");
  } finally {
    embeddingService.embedQuery = original;
  }
});

test("retrieveForQuestion reports hybrid mode and the provider when it works", async () => {
  const doc = {
    chunks: withEmbeddings(CHUNKS, [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]),
    embedding: { provider: "openai", model: "text-embedding-3-small", dims: 3 },
  };

  const embeddingService = require("../src/services/embeddingService");
  const original = embeddingService.embedQuery;
  embeddingService.embedQuery = async () => [0, 1, 0];
  try {
    const result = await retrieveForQuestion(doc, "anything");
    assert.strictEqual(result.mode, "hybrid");
    assert.strictEqual(result.embeddingProvider, "openai");
  } finally {
    embeddingService.embedQuery = original;
  }
});

// ─── No zero vectors ─────────────────────────────────────────────────────────

test("a zero vector is never treated as usable", () => {
  assert.strictEqual(isUsableVector([0, 0, 0, 0]), false);
  assert.strictEqual(isUsableVector([]), false);
  assert.strictEqual(isUsableVector(null), false);
  assert.strictEqual(isUsableVector([0, 0, 0.0001]), true);
  assert.strictEqual(isUsableVector([NaN, NaN]), false);
});

test("with no embeddings provider configured, none is resolved", () => {
  const saved = {
    EMBEDDINGS_PROVIDER: process.env.EMBEDDINGS_PROVIDER,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
  };
  process.env.EMBEDDINGS_PROVIDER = "none";
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.includes("apiConfig") || key.includes("embeddingService")) {
        delete require.cache[key];
      }
    }
    const fresh = require("../src/services/embeddingService");
    assert.strictEqual(fresh.resolveProvider(), null);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const key of Object.keys(require.cache)) {
      if (key.includes("apiConfig") || key.includes("embeddingService")) {
        delete require.cache[key];
      }
    }
  }
});

test("resolveProvider is a function returning null or a provider/model pair", () => {
  const resolved = resolveProvider();
  if (resolved !== null) {
    assert.strictEqual(typeof resolved.provider, "string");
    assert.strictEqual(typeof resolved.model, "string");
  }
});

// ─── Quiz context ────────────────────────────────────────────────────────────

test("quiz context covers the document and honours weak topics", () => {
  const doc = { chunks: CHUNKS };
  const context = buildQuizContext(doc, { weakTopics: ["warranty"], budgetChars: 14000 });
  assert.ok(context.includes("warranty"), "weak topic content should be present");
  assert.ok(context.includes("headcount"), "other parts should still be covered");
});

test("quiz context falls back to units when a document has no chunks", () => {
  const doc = {
    chunks: [],
    units: [{ index: 1, label: "Page 1", text: "Revenue grew by 15 percent." }],
  };
  const context = buildQuizContext(doc, {});
  assert.ok(context.includes("Revenue grew"));
  assert.ok(context.includes("[Page 1]"));
});

test("quiz context stays within its budget", () => {
  const doc = { chunks: CHUNKS };
  const context = buildQuizContext(doc, { budgetChars: 100 });
  assert.ok(context.length <= 100, `got ${context.length} chars`);
});
