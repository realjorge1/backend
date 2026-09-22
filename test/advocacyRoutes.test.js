/**
 * The two routes the app calls that did not exist: /devils-advocate and
 * /narrative-arc (contract C8).
 *
 * The app used to build these prompts itself and push them through /chat,
 * then clean up the model's output on the phone. Both now run server-side,
 * over the whole document, and validate their own output.
 */

const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const request = require("supertest");

const { buildTestApp } = require("./helpers/app");
const { installFakeProvider, restoreProvider } = require("./helpers/fakeProvider");
const docStore = require("../src/services/docStore");

let app;

before(() => {
  app = buildTestApp();
});

beforeEach(() => {
  restoreProvider();
});

after(() => restoreProvider());

const DA_JSON = {
  detectedRole: "Skeptical Investor",
  roleKey: "investor",
  documentType: "Pitch Deck",
  killerObjections: [
    { title: "No moat", detail: "Competitors can copy this in a quarter.", severity: "critical", reference: "Slide 7" },
    { title: "Unit economics", detail: "CAC exceeds LTV today.", severity: "high", reference: "" },
    { title: "Key-person risk", detail: "One engineer owns the platform.", severity: "high", reference: "" },
  ],
  secondaryChallenges: [
    { title: "Pricing untested", detail: "No willingness-to-pay evidence.", severity: "medium" },
    { title: "Aggressive roadmap", detail: "Three launches in one quarter.", severity: "medium" },
    { title: "Churn unproven", detail: "Only two months of retention data.", severity: "medium" },
  ],
  blindSpots: [
    { text: "Regulatory exposure", why: "Never mentioned anywhere in the deck." },
    { text: "Support cost at scale", why: "Omitted from the financial model." },
  ],
};

const NA_JSON = {
  verdict: "weak",
  verdictLine: "The ask arrives before the proof.",
  detectedType: "Business Proposal",
  diagnosis: "Evidence is buried after the pricing section.",
  idealStructure: ["Problem", "Solution", "Proof", "Ask"],
  detectedSections: [
    { title: "The Ask", index: 1, role: "request", status: "misplaced" },
    { title: "The Problem", index: 2, role: "setup", status: "ok" },
  ],
  reorder: [{ instruction: "Move the ask after the proof", from: 1, to: 3 }],
};

function respondWith(payload) {
  return installFakeProvider({ responder: async () => JSON.stringify(payload) });
}

async function storeDeck() {
  return docStore.saveDocument({
    filename: "pitch.pptx",
    fileType: "pptx",
    locatorType: "slide",
    units: [
      { index: 1, label: "Slide 1", text: "Acme raises $5M to change logistics." },
      { index: 7, label: "Slide 7", text: "Our moat is our team and our speed." },
    ],
    chunks: [
      { chunkId: 0, text: "[Slide 1]\nAcme raises $5M to change logistics.", unitIndexes: [1] },
      { chunkId: 1, text: "[Slide 7]\nOur moat is our team and our speed.", unitIndexes: [7] },
    ],
    meta: { totalPages: 2, filename: "pitch.pptx", fileType: "pptx" },
  });
}

// ─── Devil's Advocate ────────────────────────────────────────────────────────

test("devils-advocate returns the C8 response shape", async () => {
  respondWith(DA_JSON);

  const res = await request(app)
    .post("/api/ai/devils-advocate")
    .send({ text: "Acme raises $5M. Our moat is our team.", documentName: "pitch.pptx" });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.task, "devils-advocate");
  assert.strictEqual(res.body.format, "json");
  assert.ok(res.body.coverage, "coverage should be reported");

  assert.strictEqual(res.body.data.format, "json");
  assert.strictEqual(typeof res.body.data.text, "string");

  const json = res.body.data.json;
  assert.strictEqual(json.detectedRole, "Skeptical Investor");
  assert.strictEqual(json.roleKey, "investor");
  assert.strictEqual(json.killerObjections.length, 3);
  assert.strictEqual(json.killerObjections[0].severity, "critical");
  assert.strictEqual(json.killerObjections[0].reference, "Slide 7");
  assert.strictEqual(json.secondaryChallenges.length, 3);
  assert.strictEqual(json.blindSpots.length, 2);
  // No context document was given, so these keys stay absent.
  assert.strictEqual(json.groundedObjections, undefined);
  assert.strictEqual(json.rfpCoverage, undefined);
});

test("devils-advocate works from a docId over the whole document", async () => {
  const fake = respondWith(DA_JSON);
  const docId = await storeDeck();

  const res = await request(app).post("/api/ai/devils-advocate").send({ docId });
  assert.strictEqual(res.status, 200);

  const prompts = fake.calls.map((c) => c.messages.map((m) => m.content).join("\n")).join("\n");
  assert.ok(prompts.includes("Our moat is our team"), "the whole document should be challenged");
  assert.ok(prompts.includes("[Slide 7]"), "slide anchors let the model cite real locations");
});

test("the requested persona reaches the prompt", async () => {
  const fake = respondWith(DA_JSON);

  await request(app)
    .post("/api/ai/devils-advocate")
    .send({ text: "A proposal.", role: "custom", customRole: "hostile procurement officer" });

  const prompts = fake.calls.map((c) => c.messages.map((m) => m.content).join("\n")).join("\n");
  assert.ok(prompts.includes("Adopt this challenger persona: hostile procurement officer."));
});

test("with no role, the model is asked to infer the toughest reader", async () => {
  const fake = respondWith(DA_JSON);
  await request(app).post("/api/ai/devils-advocate").send({ text: "A proposal." });

  const prompts = fake.calls.map((c) => c.messages.map((m) => m.content).join("\n")).join("\n");
  assert.ok(prompts.includes("Infer the single most demanding realistic reader"));
});

test("a context document adds grounded objections and coverage", async () => {
  respondWith({
    ...DA_JSON,
    groundedObjections: [
      { claim: "Claims 99.9% uptime", evidence: "RFP requires 99.99%", source: "RFP section 4" },
    ],
    rfpCoverage: [
      { criterion: "Uptime SLA", status: "missing", note: "Not addressed." },
      { criterion: "Security review", status: "bogus-status", note: "" },
    ],
  });

  const res = await request(app)
    .post("/api/ai/devils-advocate")
    .send({ text: "Our proposal.", contextText: "RFP: 99.99% uptime required.", contextName: "RFP" });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.json.groundedObjections.length, 1);
  assert.strictEqual(res.body.data.json.rfpCoverage.length, 2);
  assert.strictEqual(
    res.body.data.json.rfpCoverage[1].status,
    "partial",
    "an invalid status is corrected, not passed through",
  );
});

test("invalid severities and roleKeys are corrected server-side", async () => {
  respondWith({
    ...DA_JSON,
    roleKey: "not-a-role",
    detectedRole: "",
    killerObjections: [
      { title: "No moat", detail: "d", severity: "catastrophic", reference: "" },
      { title: "", detail: "dropped because it has no title", severity: "high" },
    ],
    secondaryChallenges: [{ title: "Pricing", detail: "d", severity: "nonsense" }],
  });

  const res = await request(app)
    .post("/api/ai/devils-advocate")
    .send({ text: "A proposal.", role: "cfo" });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.json.roleKey, "cfo", "falls back to the requested role");
  assert.strictEqual(res.body.data.json.detectedRole, "Skeptical Reviewer");
  assert.strictEqual(res.body.data.json.killerObjections.length, 1, "title-less objections are dropped");
  assert.strictEqual(res.body.data.json.killerObjections[0].severity, "critical");
  assert.strictEqual(res.body.data.json.secondaryChallenges[0].severity, "medium");
});

test("counts are capped at the contract maximums", async () => {
  respondWith({
    ...DA_JSON,
    killerObjections: Array.from({ length: 9 }, (_, i) => ({
      title: `Objection ${i}`,
      detail: "d",
      severity: "high",
      reference: "",
    })),
    secondaryChallenges: Array.from({ length: 11 }, (_, i) => ({
      title: `Challenge ${i}`,
      detail: "d",
      severity: "medium",
    })),
    blindSpots: Array.from({ length: 8 }, (_, i) => ({ text: `Spot ${i}`, why: "w" })),
  });

  const res = await request(app).post("/api/ai/devils-advocate").send({ text: "A proposal." });
  assert.strictEqual(res.body.data.json.killerObjections.length, 5);
  assert.strictEqual(res.body.data.json.secondaryChallenges.length, 6);
  assert.strictEqual(res.body.data.json.blindSpots.length, 4);
});

test("output with no usable killer objections is retried, then 500 AI_BAD_OUTPUT", async () => {
  const fake = installFakeProvider({
    responder: async () => JSON.stringify({ ...DA_JSON, killerObjections: [] }),
  });

  const res = await request(app).post("/api/ai/devils-advocate").send({ text: "A proposal." });

  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.body.code, "AI_BAD_OUTPUT");
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(typeof res.body.error, "string");
  assert.strictEqual(fake.calls.length, 2, "exactly one retry");
});

test("a retry that succeeds is returned normally", async () => {
  let attempt = 0;
  installFakeProvider({
    responder: async () => {
      attempt++;
      return attempt === 1 ? "Sorry, I can't do that." : JSON.stringify(DA_JSON);
    },
  });

  const res = await request(app).post("/api/ai/devils-advocate").send({ text: "A proposal." });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.json.killerObjections.length, 3);
});

test("JSON wrapped in code fences is still accepted", async () => {
  installFakeProvider({
    responder: async () => "```json\n" + JSON.stringify(DA_JSON) + "\n```",
  });

  const res = await request(app).post("/api/ai/devils-advocate").send({ text: "A proposal." });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.json.roleKey, "investor");
});

// ─── Narrative Arc ───────────────────────────────────────────────────────────

test("narrative-arc returns the C8 response shape", async () => {
  respondWith(NA_JSON);

  const res = await request(app)
    .post("/api/ai/narrative-arc")
    .send({ text: "Our ask is $5M. The problem is logistics.", documentName: "proposal.docx" });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.task, "narrative-arc");
  assert.strictEqual(res.body.format, "json");
  assert.strictEqual(res.body.data.json.verdict, "weak");
  assert.strictEqual(res.body.data.json.verdictLine, "The ask arrives before the proof.");
  assert.strictEqual(res.body.data.json.detectedSections[0].index, 1);
  assert.strictEqual(res.body.data.json.detectedSections[0].status, "misplaced");
  assert.deepStrictEqual(res.body.data.json.reorder[0], {
    instruction: "Move the ask after the proof",
    from: 1,
    to: 3,
  });
  // The one-line summary is the verdict line.
  assert.strictEqual(res.body.data.json.verdictLine, NA_JSON.verdictLine);
});

test("format is inferred from the file name and drives editability", async () => {
  respondWith(NA_JSON);

  const pptx = await request(app)
    .post("/api/ai/narrative-arc")
    .send({ text: "Slides.", documentName: "deck.pptx" });
  assert.strictEqual(pptx.body.data.json.format, "pptx");
  assert.strictEqual(pptx.body.data.json.editable, true);

  const pdf = await request(app)
    .post("/api/ai/narrative-arc")
    .send({ text: "A report.", documentName: "report.pdf" });
  assert.strictEqual(pdf.body.data.json.format, "pdf");
  assert.strictEqual(pdf.body.data.json.editable, false, "a PDF cannot be reordered in place");
});

test("an explicit format wins over the file name", async () => {
  respondWith(NA_JSON);
  const res = await request(app)
    .post("/api/ai/narrative-arc")
    .send({ text: "Slides.", documentName: "deck.pdf", format: "docx" });
  assert.strictEqual(res.body.data.json.format, "docx");
});

test("an invalid verdict or section status is corrected", async () => {
  respondWith({
    ...NA_JSON,
    verdict: "catastrophic",
    detectedSections: [
      { title: "Intro", role: "setup", status: "sideways" },
      { title: "Body", index: "not a number", role: "", status: "ok" },
    ],
  });

  const res = await request(app).post("/api/ai/narrative-arc").send({ text: "A doc." });
  assert.strictEqual(res.body.data.json.verdict, "weak");
  assert.strictEqual(res.body.data.json.detectedSections[0].status, "ok");
  assert.strictEqual(res.body.data.json.detectedSections[0].index, 1, "missing index becomes position");
  assert.strictEqual(res.body.data.json.detectedSections[1].index, 2);
});

test("reorder entries keep from/to only when it is a simple move", async () => {
  respondWith({
    ...NA_JSON,
    reorder: [
      { instruction: "Move section 3 to the top", from: 3, to: 1 },
      { instruction: "Split the pricing section in two" },
    ],
  });

  const res = await request(app).post("/api/ai/narrative-arc").send({ text: "A doc." });
  assert.deepStrictEqual(res.body.data.json.reorder[0], {
    instruction: "Move section 3 to the top",
    from: 3,
    to: 1,
  });
  assert.deepStrictEqual(res.body.data.json.reorder[1], {
    instruction: "Split the pricing section in two",
  });
});

test("output with neither a verdict line nor sections is 500 AI_BAD_OUTPUT", async () => {
  installFakeProvider({
    responder: async () =>
      JSON.stringify({ verdict: "weak", verdictLine: "", detectedSections: [] }),
  });

  const res = await request(app).post("/api/ai/narrative-arc").send({ text: "A doc." });
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.body.code, "AI_BAD_OUTPUT");
});

test("narrative-arc accepts a context document by id", async () => {
  const fake = installFakeProvider({
    responder: async () =>
      JSON.stringify({
        ...NA_JSON,
        rfpCoverage: [{ criterion: "Timeline", status: "covered", note: "Section 2." }],
      }),
  });

  const contextDocId = await docStore.saveDocument({
    filename: "rfp.pdf",
    fileType: "pdf",
    locatorType: "page",
    units: [{ index: 1, label: "Page 1", text: "Required sections: timeline, pricing, team." }],
    chunks: [{ chunkId: 0, text: "Required sections: timeline, pricing, team.", unitIndexes: [1] }],
    meta: { totalPages: 1, fileType: "pdf" },
  });

  const res = await request(app)
    .post("/api/ai/narrative-arc")
    .send({ text: "Our proposal.", contextDocId });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.json.rfpCoverage.length, 1);

  const prompts = fake.calls.map((c) => c.messages.map((m) => m.content).join("\n")).join("\n");
  assert.ok(prompts.includes("Required sections: timeline"), "context text should reach the model");
});

test("an unknown contextDocId answers 404 DOC_NOT_FOUND", async () => {
  respondWith(NA_JSON);
  const res = await request(app)
    .post("/api/ai/narrative-arc")
    .send({ text: "Our proposal.", contextDocId: "b1b2c3d4e5f6b1b2c3d4e5f6" });

  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.code, "DOC_NOT_FOUND");
});

// ─── Capability reporting ────────────────────────────────────────────────────

test("status now advertises both features", async () => {
  const res = await request(app).get("/api/ai/status");
  assert.strictEqual(res.body.capabilities.devilsAdvocate, true);
  assert.strictEqual(res.body.capabilities.narrativeArc, true);
  assert.strictEqual(res.body.capabilities.citationsV2, true);
  assert.strictEqual(res.body.capabilities.docIdTasks, true);
});
