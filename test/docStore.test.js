/**
 * B2 — document store.
 *
 * The memory store is always exercised. The Postgres store runs the identical
 * contract suite when TEST_DATABASE_URL is set, and is skipped otherwise.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");

const {
  MemoryDocStore,
  normalizeForSave,
  withLegacyViews,
  isValidDocId,
  canRead,
} = require("../src/services/docStore");

const SAMPLE = {
  filename: "quarterly.pdf",
  fileType: "pdf",
  locatorType: "page",
  units: [
    { index: 1, label: "Page 1", text: "Revenue grew by 15 percent." },
    { index: 2, label: "Page 2", text: "Costs fell by 3 percent." },
  ],
  chunks: [
    { chunkId: 0, text: "[Page 1]\nRevenue grew by 15 percent.", unitIndexes: [1] },
    { chunkId: 1, text: "[Page 2]\nCosts fell by 3 percent.", unitIndexes: [2] },
  ],
  meta: { totalPages: 2, filename: "quarterly.pdf" },
  contentHash: "hash-abc",
  userHash: "user-1",
};

/** The behaviour both implementations must share. */
function storeContract(name, makeStore) {
  describe(name, () => {
    let store;

    before(async () => {
      store = await makeStore();
    });

    after(async () => {
      if (store) await store.close();
    });

    test("round-trips a document", async () => {
      const docId = await store.saveDocument(SAMPLE);
      assert.ok(isValidDocId(docId), `${docId} should be 24 hex chars`);

      const doc = await store.getDocument(docId, { userHash: "user-1" });
      assert.strictEqual(doc.filename, "quarterly.pdf");
      assert.strictEqual(doc.locatorType, "page");
      assert.strictEqual(doc.totalUnits, 2);
      assert.strictEqual(doc.units.length, 2);
      assert.strictEqual(doc.units[1].text, "Costs fell by 3 percent.");
      assert.strictEqual(doc.chunks.length, 2);
      assert.deepStrictEqual(doc.chunks[0].unitIndexes, [1]);
    });

    test("exposes the legacy pages/chunkEmbeddings views", async () => {
      const docId = await store.saveDocument(SAMPLE);
      const doc = await store.getDocument(docId, { userHash: "user-1" });
      assert.strictEqual(doc.pages.length, 2);
      assert.strictEqual(doc.pages[0].page, 1);
      assert.strictEqual(doc.pages[0].text, "Revenue grew by 15 percent.");
      assert.deepStrictEqual(doc.chunks[0].pages, [1]);
      assert.strictEqual(doc.chunkEmbeddings.length, 2);
      assert.strictEqual(doc.embeddingProvider, "none");
    });

    test("stores embeddings and reports the embedding record", async () => {
      const docId = await store.saveDocument({
        ...SAMPLE,
        chunks: SAMPLE.chunks.map((c) => ({ ...c, embedding: [0.1, 0.2, 0.3] })),
        embedding: { provider: "openai", model: "text-embedding-3-small", dims: 3 },
      });
      const doc = await store.getDocument(docId, { userHash: "user-1" });
      assert.strictEqual(doc.embedding.provider, "openai");
      assert.strictEqual(doc.embedding.dims, 3);
      assert.strictEqual(doc.chunks[0].embedding.length, 3);
      assert.ok(Math.abs(doc.chunks[0].embedding[0] - 0.1) < 1e-6);
    });

    test("returns null for an unknown or malformed docId", async () => {
      assert.strictEqual(await store.getDocument("f".repeat(24)), null);
      assert.strictEqual(await store.getDocument("not-a-doc-id"), null);
      assert.strictEqual(await store.getDocument(""), null);
    });

    test("deletes a document", async () => {
      const docId = await store.saveDocument(SAMPLE);
      await store.deleteDocument(docId);
      assert.strictEqual(await store.getDocument(docId, { userHash: "user-1" }), null);
    });

    test("finds an identical upload by content hash for the same user", async () => {
      const docId = await store.saveDocument({
        ...SAMPLE,
        contentHash: "dedupe-me",
        userHash: "user-dedupe",
      });
      assert.strictEqual(await store.findByContentHash("dedupe-me", "user-dedupe"), docId);
      assert.strictEqual(await store.findByContentHash("dedupe-me", "other-user"), null);
      assert.strictEqual(await store.findByContentHash("nope", "user-dedupe"), null);
    });

    test("touch extends the expiry", async () => {
      const docId = await store.saveDocument(SAMPLE);
      const before = await store.getDocument(docId, { userHash: "user-1" });
      await new Promise((r) => setTimeout(r, 25));
      await store.touch(docId);
      const after = await store.getDocument(docId, { userHash: "user-1" });
      assert.ok(
        after.expiresAt >= before.expiresAt,
        "expiry should move forward, never backward",
      );
    });
  });
}

storeContract("MemoryDocStore", async () => new MemoryDocStore());

if (process.env.TEST_DATABASE_URL) {
  storeContract("PostgresDocStore", async () => {
    const { migrate } = require("../scripts/migrate");
    await migrate(process.env.TEST_DATABASE_URL);
    const PostgresDocStore = require("../src/services/postgresDocStore");
    return new PostgresDocStore(process.env.TEST_DATABASE_URL);
  });
} else {
  test("PostgresDocStore (skipped: set TEST_DATABASE_URL to run)", { skip: true }, () => {});
}

// ─── Normalization ───────────────────────────────────────────────────────────

test("normalizes the legacy pages/chunkEmbeddings save shape", () => {
  const doc = normalizeForSave({
    filename: "old.pdf",
    pages: [{ page: 1, text: "Hello", wasOcr: false }],
    chunks: [{ chunkId: 0, text: "[Page 1]\nHello", pages: [1] }],
    chunkEmbeddings: [{ chunkId: 0, embedding: [0.5, 0.5] }],
    embeddingProvider: "openai",
    meta: { totalPages: 1, fileType: "pdf" },
  });

  assert.strictEqual(doc.locatorType, "page");
  assert.strictEqual(doc.units[0].label, "Page 1");
  assert.deepStrictEqual(doc.chunks[0].unitIndexes, [1]);
  assert.deepStrictEqual(doc.chunks[0].embedding, [0.5, 0.5]);
  assert.strictEqual(doc.embedding.provider, "openai");
  assert.strictEqual(doc.embedding.dims, 2);
});

test("an embedding record is dropped when no vectors landed", () => {
  const doc = normalizeForSave({
    filename: "x.pdf",
    pages: [{ page: 1, text: "Hello" }],
    chunks: [{ chunkId: 0, text: "Hello", pages: [1] }],
    embeddingProvider: "openai",
    meta: {},
  });
  assert.strictEqual(doc.embedding, null);
});

test("locator type follows the file type", () => {
  const cases = {
    pdf: "page",
    pptx: "slide",
    xlsx: "sheet",
    epub: "chapter",
    docx: "section",
    txt: "section",
  };
  for (const [fileType, expected] of Object.entries(cases)) {
    const doc = normalizeForSave({ filename: `f.${fileType}`, meta: { fileType } });
    assert.strictEqual(doc.locatorType, expected, `${fileType} -> ${expected}`);
  }
});

// ─── Ownership ───────────────────────────────────────────────────────────────

describe("ownership", () => {
  const savedMode = process.env.AUTH_MODE;

  after(() => {
    if (savedMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = savedMode;
  });

  function withMode(mode) {
    process.env.AUTH_MODE = mode;
    for (const key of Object.keys(require.cache)) {
      if (key.includes("apiConfig") || key.endsWith("docStore.js")) delete require.cache[key];
    }
    return require("../src/services/docStore");
  }

  test("enforce mode keeps a document private to its owner", () => {
    const store = withMode("enforce");
    assert.strictEqual(store.canRead({ userHash: "owner" }, "owner"), true);
    assert.strictEqual(store.canRead({ userHash: "owner" }, "someone-else"), false);
    assert.strictEqual(store.canRead({ userHash: "owner" }, null), false);
    // Documents saved without an owner stay open, as before.
    assert.strictEqual(store.canRead({ userHash: null }, "anyone"), true);
  });

  test("monitor mode does not restrict reads", () => {
    const store = withMode("monitor");
    assert.strictEqual(store.canRead({ userHash: "owner" }, "someone-else"), true);
  });
});

// ─── Legacy view helper ──────────────────────────────────────────────────────

test("withLegacyViews derives pages from units", () => {
  const view = withLegacyViews({
    units: [{ index: 3, label: "Slide 3", text: "Hi" }],
    chunks: [{ chunkId: 0, text: "Hi", unitIndexes: [3], embedding: null }],
    embedding: null,
  });
  assert.deepStrictEqual(view.pages, [
    { page: 3, text: "Hi", wasOcr: false, charCount: 2 },
  ]);
  assert.strictEqual(view.embeddingProvider, "none");
});
