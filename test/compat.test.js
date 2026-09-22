/**
 * Backward-compatibility snapshots.
 *
 * Recorded against the pre-v2 code and asserted after every change: existing
 * routes must keep every key, type and status code they had. New keys are
 * allowed; removals and retypes are not.
 *
 * Re-record deliberately with: RECORD_BASELINE=1 node --test test/compat.test.js
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const request = require("supertest");

const { buildTestApp } = require("./helpers/app");
const { installFakeProvider, restoreProvider } = require("./helpers/fakeProvider");
const { shapeOf, checkCompatible } = require("./helpers/shape");
const { makePdf, makeDocx } = require("./helpers/fixtures");

const BASELINE_PATH = path.join(__dirname, "__snapshots__", "compat.baseline.json");
const RECORDING = process.env.RECORD_BASELINE === "1";

let app;
let baseline = {};
const recorded = {};

before(() => {
  installFakeProvider();
  app = buildTestApp();
  if (fs.existsSync(BASELINE_PATH)) {
    baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  }
});

after(() => {
  restoreProvider();
  if (RECORDING) {
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    const merged = { ...baseline, ...recorded };
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(merged, null, 2) + "\n");
  }
});

/** Record or assert one response. */
function snapshot(name, res) {
  const entry = { status: res.status, shape: shapeOf(res.body) };
  recorded[name] = entry;

  if (RECORDING || !baseline[name]) return;

  assert.strictEqual(
    res.status,
    baseline[name].status,
    `${name}: status changed ${baseline[name].status} -> ${res.status}`,
  );
  checkCompatible(name, baseline[name].shape, entry.shape);
}

const DOC_TEXT =
  "Revenue grew by 15 percent. The board approved the budget on Friday. " +
  "Alice must review the report before the quarterly meeting.";

test("GET /status", async () => {
  const res = await request(app).get("/api/ai/status");
  snapshot("GET /status", res);
});

test("POST /summarize", async () => {
  const res = await request(app).post("/api/ai/summarize").send({ text: DOC_TEXT });
  snapshot("POST /summarize", res);
});

test("POST /translate", async () => {
  const res = await request(app)
    .post("/api/ai/translate")
    .send({ text: DOC_TEXT, targetLanguage: "Spanish" });
  snapshot("POST /translate", res);
});

test("POST /translate — validation error", async () => {
  const res = await request(app).post("/api/ai/translate").send({ text: DOC_TEXT });
  snapshot("POST /translate (error)", res);
});

test("POST /chat", async () => {
  const res = await request(app)
    .post("/api/ai/chat")
    .send({ message: "What is this about?", documentText: DOC_TEXT });
  snapshot("POST /chat", res);
});

test("POST /analyze", async () => {
  const res = await request(app).post("/api/ai/analyze").send({ text: DOC_TEXT });
  snapshot("POST /analyze", res);
});

test("POST /extract-tasks", async () => {
  const res = await request(app).post("/api/ai/extract-tasks").send({ text: DOC_TEXT });
  snapshot("POST /extract-tasks", res);
});

test("POST /highlight", async () => {
  const res = await request(app).post("/api/ai/highlight").send({ text: DOC_TEXT });
  snapshot("POST /highlight", res);
});

test("POST /explain", async () => {
  const res = await request(app).post("/api/ai/explain").send({ text: DOC_TEXT });
  snapshot("POST /explain", res);
});

test("POST /quiz", async () => {
  const res = await request(app).post("/api/ai/quiz").send({ text: DOC_TEXT });
  snapshot("POST /quiz", res);
});

test("POST /extract-pdf then /ask-pdf", async () => {
  const pdf = await makePdf([DOC_TEXT]);
  const extract = await request(app)
    .post("/api/ai/extract-pdf")
    .attach("pdf", pdf, "sample.pdf");
  snapshot("POST /extract-pdf", extract);

  assert.ok(extract.body.docId, "extract-pdf should return a docId");

  const ask = await request(app)
    .post("/api/ai/ask-pdf")
    .send({ docId: extract.body.docId, question: "What grew by 15 percent?" });
  snapshot("POST /ask-pdf", ask);
});

test("POST /ask-pdf — unknown docId", async () => {
  const res = await request(app)
    .post("/api/ai/ask-pdf")
    .send({ docId: "a".repeat(24), question: "Anything?" });
  snapshot("POST /ask-pdf (missing doc)", res);
});

test("POST /extract-document then /chat-document", async () => {
  const docx = makeDocx([{ text: DOC_TEXT }]);
  const extract = await request(app)
    .post("/api/ai/extract-document")
    .attach("document", docx, "sample.docx");
  snapshot("POST /extract-document", extract);

  assert.ok(extract.body.docId, "extract-document should return a docId");

  const chat = await request(app)
    .post("/api/ai/chat-document")
    .send({ docId: extract.body.docId, question: "What grew by 15 percent?" });
  snapshot("POST /chat-document", chat);
});

test("DELETE /doc/:docId", async () => {
  const res = await request(app).delete(`/api/ai/doc/${"b".repeat(24)}`);
  snapshot("DELETE /doc/:docId", res);
});
