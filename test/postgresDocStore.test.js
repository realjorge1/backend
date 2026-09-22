/**
 * B2 — PostgresDocStore query construction.
 *
 * These run without a database: the pool is replaced with a recorder, so what
 * is checked is the SQL/parameter pairing and the transaction flow. The full
 * behavioural contract runs against a real database in docStore.test.js when
 * TEST_DATABASE_URL is set.
 */

const { test } = require("node:test");
const assert = require("node:assert");

const PostgresDocStore = require("../src/services/postgresDocStore");

function fakePool({ onQuery } = {}) {
  const queries = [];
  const record = async (text, params) => {
    queries.push({ text: String(text).trim(), params });
    if (onQuery) {
      const result = await onQuery(String(text).trim(), params);
      if (result) return result;
    }
    return { rowCount: 0, rows: [] };
  };
  return {
    queries,
    query: record,
    connect: async () => ({ query: record, release() {} }),
    end: async () => {},
    on() {},
  };
}

function storeWith(pool) {
  const store = new PostgresDocStore("postgres://user:pw@localhost:5432/db");
  store.pool = pool;
  return store;
}

/** Every $n placeholder must have a matching parameter, and vice versa. */
function assertPlaceholdersMatch(query) {
  const used = new Set();
  for (const match of query.text.matchAll(/\$(\d+)/g)) used.add(Number(match[1]));
  if (used.size === 0) {
    assert.ok(
      !query.params || query.params.length === 0,
      `query has params but no placeholders: ${query.text.slice(0, 60)}`,
    );
    return;
  }
  const max = Math.max(...used);
  assert.strictEqual(
    max,
    query.params.length,
    `highest placeholder $${max} but ${query.params.length} params: ${query.text.slice(0, 80)}`,
  );
  for (let i = 1; i <= max; i++) {
    assert.ok(used.has(i), `placeholder $${i} is missing from: ${query.text.slice(0, 80)}`);
  }
}

const DOC = {
  filename: "big.pdf",
  fileType: "pdf",
  locatorType: "page",
  units: Array.from({ length: 120 }, (_, i) => ({
    index: i + 1,
    label: `Page ${i + 1}`,
    text: `Text of page ${i + 1}`,
  })),
  chunks: Array.from({ length: 70 }, (_, i) => ({
    chunkId: i,
    text: `chunk ${i}`,
    unitIndexes: [i + 1],
    embedding: [0.1, 0.2],
  })),
  meta: { totalPages: 120 },
  embedding: { provider: "openai", model: "text-embedding-3-small", dims: 2 },
  contentHash: "abc",
  userHash: "user-1",
};

test("saveDocument commits one transaction with batched inserts", async () => {
  const pool = fakePool();
  const store = storeWith(pool);

  const docId = await store.saveDocument(DOC);
  assert.match(docId, /^[a-f0-9]{24}$/);

  const texts = pool.queries.map((q) => q.text);
  assert.strictEqual(texts[0], "BEGIN");
  assert.strictEqual(texts[texts.length - 1], "COMMIT");
  assert.ok(texts.some((t) => t.startsWith("INSERT INTO ai_documents")));

  const unitInserts = pool.queries.filter((q) => q.text.includes("ai_document_units"));
  const chunkInserts = pool.queries.filter((q) => q.text.includes("ai_document_chunks"));
  // 120 units and 70 chunks at 50 rows per statement.
  assert.strictEqual(unitInserts.length, 3);
  assert.strictEqual(chunkInserts.length, 2);

  for (const query of pool.queries) assertPlaceholdersMatch(query);

  // The document row carries the embedding record.
  const docInsert = pool.queries.find((q) => q.text.startsWith("INSERT INTO ai_documents"));
  assert.ok(docInsert.params.includes("openai"));
  assert.ok(docInsert.params.includes("abc"));
  assert.ok(docInsert.params.includes("user-1"));
  // meta is serialized for the jsonb column.
  assert.ok(docInsert.params.some((p) => typeof p === "string" && p.startsWith("{")));
});

test("saveDocument rolls back when an insert fails", async () => {
  let failed = false;
  const pool = fakePool({
    onQuery: (text) => {
      if (text.includes("ai_document_units") && !failed) {
        failed = true;
        throw new Error("connection terminated");
      }
    },
  });
  const store = storeWith(pool);

  await assert.rejects(() => store.saveDocument(DOC), (err) => {
    assert.strictEqual(err.code, "STORE_UNAVAILABLE");
    return true;
  });
  assert.ok(pool.queries.some((q) => q.text === "ROLLBACK"), "should roll back");
});

test("getDocument returns null for an expired or unknown id", async () => {
  const pool = fakePool({ onQuery: () => ({ rowCount: 0, rows: [] }) });
  const store = storeWith(pool);
  assert.strictEqual(await store.getDocument("a".repeat(24)), null);
});

test("getDocument rebuilds the document and its legacy views", async () => {
  const pool = fakePool({
    onQuery: (text) => {
      if (text.startsWith("SELECT id, content_hash")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "a".repeat(24),
              content_hash: "abc",
              user_hash: "user-1",
              filename: "deck.pptx",
              file_type: "pptx",
              locator_type: "slide",
              total_units: 2,
              meta: { totalPages: 2 },
              embedding_provider: "openai",
              embedding_model: "text-embedding-3-small",
              embedding_dims: 2,
              created_at: new Date("2026-09-01T00:00:00Z"),
              last_used_at: new Date("2026-09-02T00:00:00Z"),
              expires_at: new Date("2026-09-09T00:00:00Z"),
            },
          ],
        };
      }
      if (text.includes("FROM ai_document_units")) {
        return {
          rowCount: 2,
          rows: [
            { unit_index: 1, label: "Slide 1", text: "Title slide" },
            { unit_index: 2, label: "Slide 2", text: "Revenue grew" },
          ],
        };
      }
      if (text.includes("FROM ai_document_chunks")) {
        return {
          rowCount: 1,
          rows: [
            {
              chunk_id: 0,
              unit_indexes: [1, 2],
              text: "[Slide 1]\nTitle slide",
              embedding: [0.1, 0.2],
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    },
  });

  const store = storeWith(pool);
  const doc = await store.getDocument("a".repeat(24), { userHash: "user-1" });

  assert.strictEqual(doc.locatorType, "slide");
  assert.strictEqual(doc.units[1].label, "Slide 2");
  assert.strictEqual(doc.embedding.provider, "openai");
  assert.deepStrictEqual(doc.chunks[0].pages, [1, 2]);
  assert.strictEqual(doc.pages[0].page, 1);
  assert.strictEqual(doc.expiresAt, new Date("2026-09-09T00:00:00Z").getTime());
});

test("a database failure surfaces as STORE_UNAVAILABLE, not a generic error", async () => {
  const pool = fakePool({
    onQuery: () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const store = storeWith(pool);
  await assert.rejects(
    () => store.getDocument("a".repeat(24)),
    (err) => err.code === "STORE_UNAVAILABLE",
  );
});

test("expiry slides forward but is capped from creation", async () => {
  const pool = fakePool();
  const store = storeWith(pool);
  await store.touch("a".repeat(24));
  const sql = pool.queries[0].text;
  assert.match(sql, /LEAST\(now\(\) \+ interval '\d+ days', created_at \+ interval '\d+ days'\)/);
});
