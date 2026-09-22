/**
 * B4 — whole-document tasks by docId (contract C5).
 *
 * The central claim: with a docId, the model sees the WHOLE document, not the
 * excerpt a client had room to send. A fake provider records every prompt it
 * receives so that can be checked directly.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const request = require("supertest");

const { buildTestApp } = require("./helpers/app");
const { installFakeProvider, restoreProvider } = require("./helpers/fakeProvider");
const docStore = require("../src/services/docStore");
const aiService = require("../src/services/aiService");

let app;
let fake;

before(() => {
  app = buildTestApp();
});

beforeEach(() => {
  restoreProvider();
  fake = installFakeProvider();
});

after(() => restoreProvider());

/** Everything the fake was asked, concatenated. */
function allPrompts() {
  return fake.calls
    .map((c) => c.messages.map((m) => m.content).join("\n"))
    .join("\n=====\n");
}

/** Store a document of roughly `chars` characters with a unique fact at the end. */
async function storeLongDocument(chars, { userHash = null, marker = "ZEBRAFISH-9317" } = {}) {
  const paragraph =
    "The committee reviewed the quarterly operating figures and confirmed the " +
    "reported totals against the underlying ledgers. ";
  const units = [];
  let produced = 0;
  let index = 1;
  while (produced < chars) {
    const body = paragraph.repeat(20);
    units.push({ index, label: `Page ${index}`, text: body });
    produced += body.length;
    index++;
  }
  // The unique fact lives in the final unit — the part a 15k-char excerpt
  // would never include.
  units.push({
    index,
    label: `Page ${index}`,
    text: `Final note: the internal project codename is ${marker}.`,
  });

  const chunks = units.map((u, i) => ({
    chunkId: i,
    text: `[${u.label}]\n${u.text}`,
    unitIndexes: [u.index],
  }));

  const docId = await docStore.saveDocument({
    filename: "long-report.pdf",
    fileType: "pdf",
    locatorType: "page",
    units,
    chunks,
    meta: { totalPages: units.length, filename: "long-report.pdf", fileType: "pdf" },
    userHash,
  });

  return { docId, marker, totalChars: units.reduce((n, u) => n + u.text.length, 0) };
}

// ─── The whole document reaches the model ────────────────────────────────────

test("summarize by docId sends a fact from the last 10% of a ~300k document", async () => {
  const { docId, marker, totalChars } = await storeLongDocument(300000);
  assert.ok(totalChars > 250000, `fixture should be large, was ${totalChars}`);

  const res = await request(app).post("/api/ai/summarize").send({ docId });
  assert.strictEqual(res.status, 200);

  assert.ok(
    allPrompts().includes(marker),
    "the unique fact from the end of the document never reached the model",
  );
});

test("a long docId summarize reports chunked coverage", async () => {
  const { docId, totalChars } = await storeLongDocument(300000);
  const res = await request(app).post("/api/ai/summarize").send({ docId });

  const coverage = res.body.data.coverage;
  assert.strictEqual(coverage.chunked, true);
  assert.ok(coverage.chunkCount > 1, `expected several chunks, got ${coverage.chunkCount}`);
  assert.ok(
    coverage.totalChars >= totalChars * 0.9,
    `coverage.totalChars (${coverage.totalChars}) should reflect the whole document`,
  );
  assert.ok(coverage.processedChars > 100000);
  assert.strictEqual(typeof coverage.truncated, "boolean");
});

test("a short docId summarize reports a single unchunked pass", async () => {
  const docId = await docStore.saveDocument({
    filename: "short.pdf",
    fileType: "pdf",
    locatorType: "page",
    units: [{ index: 1, label: "Page 1", text: "Revenue grew by 15 percent." }],
    chunks: [{ chunkId: 0, text: "[Page 1]\nRevenue grew by 15 percent.", unitIndexes: [1] }],
    meta: { totalPages: 1, fileType: "pdf" },
  });

  const res = await request(app).post("/api/ai/summarize").send({ docId });
  assert.strictEqual(res.status, 200);
  // 27 chars of text plus the "[Page 1]\n" anchor the model needs to cite it.
  assert.deepStrictEqual(res.body.data.coverage, {
    totalChars: 36,
    processedChars: 36,
    chunked: false,
    chunkCount: 1,
    truncated: false,
  });
});

test("stored text carries unit anchors so the model can cite locations", async () => {
  const docId = await docStore.saveDocument({
    filename: "deck.pptx",
    fileType: "pptx",
    locatorType: "slide",
    units: [
      { index: 1, label: "Slide 1", text: "Title" },
      { index: 2, label: "Slide 2", text: "Growth plan" },
    ],
    chunks: [{ chunkId: 0, text: "[Slide 1]\nTitle", unitIndexes: [1] }],
    meta: { totalPages: 2, fileType: "pptx" },
  });

  await request(app).post("/api/ai/summarize").send({ docId });
  const prompts = allPrompts();
  assert.ok(prompts.includes("[Slide 1]"), "slide anchors should reach the model");
  assert.ok(prompts.includes("[Slide 2]"));
});

// ─── docId on every C5 route ─────────────────────────────────────────────────

for (const [route, task] of [
  ["/api/ai/summarize", "summarize"],
  ["/api/ai/analyze", "analyze"],
  ["/api/ai/extract-tasks", "tasks"],
  ["/api/ai/highlight", "highlight"],
  ["/api/ai/explain", "explain"],
  ["/api/ai/quiz", "quiz"],
]) {
  test(`${route} accepts a docId`, async () => {
    const docId = await docStore.saveDocument({
      filename: "doc.pdf",
      fileType: "pdf",
      locatorType: "page",
      units: [
        {
          index: 1,
          label: "Page 1",
          text: "Revenue grew by 15 percent. Alice must review the report by Friday.",
        },
      ],
      chunks: [
        {
          chunkId: 0,
          text: "[Page 1]\nRevenue grew by 15 percent. Alice must review the report by Friday.",
          unitIndexes: [1],
        },
      ],
      meta: { totalPages: 1, fileType: "pdf" },
    });

    const res = await request(app).post(route).send({ docId });
    assert.strictEqual(res.status, 200, `${task} failed: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.data.coverage, "coverage should be reported");
    assert.ok(["markdown", "text", "json"].includes(res.body.data.format));
  });
}

test("translate accepts a docId and reports coverage", async () => {
  const docId = await docStore.saveDocument({
    filename: "doc.pdf",
    fileType: "pdf",
    locatorType: "page",
    units: [{ index: 1, label: "Page 1", text: "Good morning." }],
    chunks: [{ chunkId: 0, text: "[Page 1]\nGood morning.", unitIndexes: [1] }],
    meta: { totalPages: 1, fileType: "pdf" },
  });

  const res = await request(app)
    .post("/api/ai/translate")
    .send({ docId, targetLanguage: "Spanish" });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.data.coverage);
  assert.strictEqual(typeof res.body.translatedText, "string");
});

// ─── Unknown docId ───────────────────────────────────────────────────────────

test("an unknown docId on a task route answers 404 DOC_NOT_FOUND", async () => {
  const res = await request(app)
    .post("/api/ai/summarize")
    .send({ docId: "a1b2c3d4e5f6a1b2c3d4e5f6" });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.code, "DOC_NOT_FOUND");
  assert.strictEqual(typeof res.body.error, "string");
  assert.strictEqual(res.body.success, false);
});

// ─── instruction ─────────────────────────────────────────────────────────────

test("instruction reaches the model, clearly separated from the document", async () => {
  const docId = await docStore.saveDocument({
    filename: "doc.pdf",
    fileType: "pdf",
    locatorType: "page",
    units: [{ index: 1, label: "Page 1", text: "Quarterly numbers." }],
    chunks: [{ chunkId: 0, text: "[Page 1]\nQuarterly numbers.", unitIndexes: [1] }],
    meta: { totalPages: 1, fileType: "pdf" },
  });

  await request(app)
    .post("/api/ai/summarize")
    .send({ docId, instruction: "focus on the risks" });

  const prompts = allPrompts();
  assert.ok(prompts.includes("focus on the risks"));
  assert.ok(
    prompts.includes("ADDITIONAL REQUEST FROM THE USER"),
    "the instruction must be delimited, not blended into the document",
  );
});

test("an over-long instruction is a 400 VALIDATION_ERROR", async () => {
  const res = await request(app)
    .post("/api/ai/summarize")
    .send({ text: "Some text.", instruction: "x".repeat(2001) });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error.code, "VALIDATION_ERROR");
});

test("an instruction of exactly 2000 characters is accepted", async () => {
  const res = await request(app)
    .post("/api/ai/summarize")
    .send({ text: "Some text.", instruction: "x".repeat(2000) });
  assert.strictEqual(res.status, 200);
});

// ─── Without docId, nothing changes ──────────────────────────────────────────

test("without a docId the model sees exactly the supplied text", async () => {
  const res = await request(app)
    .post("/api/ai/summarize")
    .send({ text: "Just this sentence." });
  assert.strictEqual(res.status, 200);
  const prompts = allPrompts();
  assert.ok(prompts.includes("Just this sentence."));
  assert.strictEqual(res.body.data.coverage.chunked, false);
});

// ─── resolveDocumentInput ────────────────────────────────────────────────────

test("resolveDocumentInput caps a stored document and flags truncation", async () => {
  const aiConfig = require("../src/config/aiConfig");
  const oversized = "y".repeat(aiConfig.maxDocumentLength + 5000);
  const docId = await docStore.saveDocument({
    filename: "huge.txt",
    fileType: "txt",
    locatorType: "section",
    units: [{ index: 1, label: "Section 1", text: oversized }],
    chunks: [{ chunkId: 0, text: oversized, unitIndexes: [1] }],
    meta: { totalPages: 1, fileType: "txt" },
  });

  const resolved = await aiService.resolveDocumentInput({ docId });
  assert.strictEqual(resolved.truncated, true);
  assert.strictEqual(resolved.text.length, aiConfig.maxDocumentLength);
  assert.ok(resolved.totalChars > aiConfig.maxDocumentLength);
});

test("resolveDocumentInput without a docId returns the supplied text untouched", async () => {
  const resolved = await aiService.resolveDocumentInput({ text: "hello" });
  assert.strictEqual(resolved.text, "hello");
  assert.strictEqual(resolved.source, "text");
  assert.strictEqual(resolved.truncated, false);
});

// ─── Translation chunking ────────────────────────────────────────────────────

test("a long translation is split, kept in order and joined without a merge call", async () => {
  const { translateLong } = require("../src/services/aiChunker");

  // Each part is answered with a marker naming the part it saw, so ordering
  // is verifiable in the joined output.
  const seen = [];
  fake.responder = async (messages) => {
    const user = messages[messages.length - 1].content;
    const match = user.match(/PART-(\d+)/);
    const id = match ? match[1] : "?";
    seen.push(id);
    return `translated-${id}`;
  };

  const parts = 5;
  const source = Array.from(
    { length: parts },
    (_, i) => `PART-${i} ` + "palabra ".repeat(1500),
  ).join("\n\n");

  const result = await translateLong({
    text: source,
    chunkChars: 12000,
    maxOutputChars: 200000,
    buildMessages: (chunk) => [
      { role: "system", content: "translate" },
      { role: "user", content: chunk },
    ],
  });

  const order = result.content.match(/translated-(\d+)/g);
  assert.deepStrictEqual(
    order,
    order.slice().sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1])),
    `parts came back out of order: ${order}`,
  );
  assert.ok(result.coverage.chunkCount > 1);
  assert.strictEqual(result.coverage.chunked, true);
  // No merge call: one call per part (plus any max_tokens retries).
  assert.strictEqual(fake.calls.length, result.coverage.chunkCount);
});

test("translation stops at a part boundary when the output limit is reached", async () => {
  const { translateLong } = require("../src/services/aiChunker");
  fake.responder = async () => "x".repeat(5000);

  const source = Array.from({ length: 8 }, () => "palabra ".repeat(1500)).join("\n\n");
  const result = await translateLong({
    text: source,
    chunkChars: 12000,
    maxOutputChars: 12000,
    buildMessages: (chunk) => [{ role: "user", content: chunk }],
  });

  assert.strictEqual(result.coverage.truncated, true);
  assert.ok(
    result.coverage.processedChars < source.length,
    "stopping early means not all of the source was processed",
  );
  // Whole parts only — never a half-translated part.
  const emitted = result.content.split("\n\n");
  assert.ok(emitted.every((part) => part.length === 5000), "every part is complete");
  assert.ok(emitted.length < 8, "it stopped before translating everything");
});

test("a part cut off at max_tokens is split and retried once", async () => {
  const { translateLong } = require("../src/services/aiChunker");

  let call = 0;
  const original = fake.chat.bind(fake);
  fake.chat = async (messages, options) => {
    call++;
    const result = await original(messages, options);
    // Only the very first call reports being cut off.
    return { ...result, stopReason: call === 1 ? "max_tokens" : "end_turn" };
  };

  const source = "palabra ".repeat(2000);
  const result = await translateLong({
    text: source,
    chunkChars: 100000, // one part
    maxOutputChars: 200000,
    buildMessages: (chunk) => [{ role: "user", content: chunk }],
  });

  assert.ok(call >= 3, `expected a retry in halves, saw ${call} calls`);
  assert.strictEqual(result.coverage.truncated, false, "a successful retry is not truncation");
});
