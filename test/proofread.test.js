/**
 * POST /api/ai/proofread — validation, verification, occurrence resolution,
 * caching, model failure, auth and rate limits.
 *
 * The verification pass is the reason this route exists in this shape: the
 * model never supplies a position, so most of these tests are about what the
 * server does with output it cannot trust.
 */

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const express = require("express");

const { installFakeProvider, restoreProvider } = require("./helpers/fakeProvider");

const ENV_KEYS = [
  "AUTH_MODE",
  "AI_APP_KEYS",
  "AUTH_ALLOWLIST_USER_IDS",
  "REVENUECAT_SECRET_API_KEY",
  "RATE_LIMIT_ENABLED",
  "RATE_LIMIT_AI_PER_MIN",
  "RATE_LIMIT_IP_PER_MIN",
  "PROOFREAD_PER_MIN",
  "PROOFREAD_PER_HOUR",
  "PROOFREAD_CHARS_PER_MIN",
  "PROOFREAD_MAX_CONCURRENT",
  "PROOFREAD_QUEUE_WAIT_MS",
  "PROOFREAD_MODEL_TIMEOUT_MS",
  "PROOFREAD_MIN_ATTEMPT_MS",
  "PROOFREAD_BUDGET_MS",
  "PROOFREAD_CACHE_MAX_BLOCKS",
  "PROOFREAD_CACHE_TTL_MS",
];

const AI_MODULE_KEYS = [
  "apiConfig",
  "aiAuth",
  "aiTelemetry",
  "requestContext",
  "aiRateLimit",
  "proofreadRateLimit",
  "entitlements",
  "tokenBudget",
  "requireAdmin",
  "mountAiApi",
  "aiRoutes",
  "capabilities",
  "proofread",
  "proofreadRequest",
];

let savedEnv;
let fake;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // Off by default so a test that doesn't care about limits isn't throttled by
  // leftover counters from another one.
  process.env.RATE_LIMIT_ENABLED = "false";
  fake = installFakeProvider({ responder: () => JSON.stringify(EMPTY_REPLY) });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  restoreProvider();
});

/**
 * Rebuild the whole AI middleware chain against the current process.env, with
 * a cold proofread cache and cold rate-limit counters.
 */
function freshApp(env = {}) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  for (const key of Object.keys(require.cache)) {
    if (AI_MODULE_KEYS.some((name) => key.includes(name))) delete require.cache[key];
  }

  const { mountAiApi } = require("../src/ai/mountAiApi");
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "25mb" }));
  mountAiApi(app);
  return app;
}

/** The freshly-required proofread service that `freshApp` just wired up. */
function service() {
  return require("../src/services/proofread");
}

const EMPTY_REPLY = { languages: {}, suggestions: [] };

/** A responder that always replies with one fixed model payload. */
function replyWith(payload) {
  return () => (typeof payload === "string" ? payload : JSON.stringify(payload));
}

function post(app, body, headers = {}) {
  const req = request(app).post("/api/ai/proofread").send(body);
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req;
}

// ─── Validation (P2) ─────────────────────────────────────────────────────────

test("validation: rejects a request with no blocks, and never calls the model", async () => {
  const app = freshApp();
  for (const body of [{}, { blocks: [] }, { blocks: "nope" }]) {
    const res = await post(app, body);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.code, "BAD_REQUEST");
    assert.ok(typeof res.body.error === "string" && res.body.error.length > 0);
  }
  assert.strictEqual(fake.calls.length, 0, "a 400 must not reach the model");
});

test("validation: 20 blocks pass, 21 fail", async () => {
  const app = freshApp();
  const block = (i) => ({ id: `b${i}`, text: "Fine." });

  const ok = await post(app, { blocks: Array.from({ length: 20 }, (_, i) => block(i)) });
  assert.strictEqual(ok.status, 200);

  const tooMany = await post(app, { blocks: Array.from({ length: 21 }, (_, i) => block(i)) });
  assert.strictEqual(tooMany.status, 400);
  assert.strictEqual(tooMany.body.code, "BAD_REQUEST");
});

test("validation: a 4,000-char block passes and 4,001 fails", async () => {
  const app = freshApp();
  const ok = await post(app, { blocks: [{ id: "b1", text: "a".repeat(4000) }] });
  assert.strictEqual(ok.status, 200);

  const over = await post(app, { blocks: [{ id: "b1", text: "a".repeat(4001) }] });
  assert.strictEqual(over.status, 400);
  assert.match(over.body.error, /4000/);
});

test("validation: total 20,000 chars passes and 20,001 fails", async () => {
  const app = freshApp();
  // 20 blocks of 1,000 chars: exactly the total limit, and every block well
  // inside the per-block limit so this tests the total and nothing else.
  const exact = Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, text: "a".repeat(1000) }));
  const ok = await post(app, { blocks: exact });
  assert.strictEqual(ok.status, 200);

  const over = exact.map((b, i) => (i === 0 ? { ...b, text: "a".repeat(1001) } : b));
  const res = await post(app, { blocks: over });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /20000/);
});

test("validation: duplicate, empty and oversized block ids are rejected", async () => {
  const app = freshApp();
  const cases = [
    [{ id: "b1", text: "One." }, { id: "b1", text: "Two." }],
    [{ id: "", text: "One." }],
    [{ id: "x".repeat(65), text: "One." }],
    [{ id: 7, text: "One." }],
    [{ id: "b1", text: "" }],
    [{ id: "b1" }],
  ];
  for (const blocks of cases) {
    const res = await post(app, { blocks });
    assert.strictEqual(res.status, 400, JSON.stringify(blocks));
    assert.strictEqual(res.body.code, "BAD_REQUEST");
  }
  // A 64-char id is exactly at the boundary and must pass.
  const boundary = await post(app, { blocks: [{ id: "x".repeat(64), text: "One." }] });
  assert.strictEqual(boundary.status, 200);
});

test("validation: language, dialect and goals", async () => {
  const app = freshApp();
  const text = [{ id: "b1", text: "One." }];

  for (const language of ["auto", "en", "en-GB", "fr"]) {
    const res = await post(app, { blocks: text, language });
    assert.strictEqual(res.status, 200, language);
  }
  for (const language of ["english", "e", 7, "en_GB", ""]) {
    const res = await post(app, { blocks: text, language });
    assert.strictEqual(res.status, 400, String(language));
  }

  for (const dialect of ["us", "uk", null]) {
    const res = await post(app, { blocks: text, dialect });
    assert.strictEqual(res.status, 200, String(dialect));
  }
  for (const dialect of ["US", "gb", 1]) {
    const res = await post(app, { blocks: text, dialect });
    assert.strictEqual(res.status, 400, String(dialect));
  }

  const goodGoals = await post(app, { blocks: text, goals: ["spelling", "tone"] });
  assert.strictEqual(goodGoals.status, 200);
  for (const goals of [[], ["spelling", "vibes"], "spelling", [1]]) {
    const res = await post(app, { blocks: text, goals });
    assert.strictEqual(res.status, 400, JSON.stringify(goals));
  }
});

// ─── Verification (P4) ───────────────────────────────────────────────────────

test("verification: a suggestion whose original is not in the text is dropped", () => {
  const { verifyBlock } = service();
  const text = "The data shows that recieve rates are up.";
  const { suggestions, drops } = verifyBlock(text, [
    { type: "spelling", original: "recieve", replacement: "receive", confidence: 0.99 },
    // Paraphrased — the model rewrote instead of quoting.
    { type: "clarity", original: "the data indicates", replacement: "data shows", confidence: 0.8 },
    // Re-cased — not an exact substring.
    { type: "spelling", original: "Recieve", replacement: "Receive", confidence: 0.9 },
  ]);

  assert.strictEqual(suggestions.length, 1);
  assert.strictEqual(suggestions[0].original, "recieve");
  assert.strictEqual(drops.not_substring, 2);
});

test("verification: replacement identical to original is dropped", () => {
  const { verifyBlock } = service();
  const { suggestions, drops } = verifyBlock("The cat sat.", [
    { type: "spelling", original: "cat", replacement: "cat", confidence: 0.9 },
  ]);
  assert.deepStrictEqual(suggestions, []);
  assert.strictEqual(drops.identical, 1);
});

test("verification: a missing or oversized replacement is dropped", () => {
  const { verifyBlock } = service();
  const { suggestions, drops } = verifyBlock("The cat sat.", [
    { type: "spelling", original: "cat", confidence: 0.9 },
    { type: "spelling", original: "sat", replacement: "x".repeat(401), confidence: 0.9 },
    { type: "spelling", original: "x".repeat(201), replacement: "y", confidence: 0.9 },
    "not an object",
  ]);
  assert.deepStrictEqual(suggestions, []);
  assert.strictEqual(drops.bad_shape, 3);
  assert.strictEqual(drops.not_substring, 1);
});

test("verification: overlapping spans keep the higher confidence", () => {
  const { verifyBlock } = service();
  const text = "The quick brown fox jumps.";
  // Both edits change "brown", so they genuinely collide.
  const { suggestions, drops } = verifyBlock(text, [
    { type: "clarity", original: "quick brown", replacement: "fast red", confidence: 0.4 },
    { type: "clarity", original: "brown fox", replacement: "red hound", confidence: 0.9 },
  ]);

  assert.strictEqual(suggestions.length, 1);
  assert.strictEqual(suggestions[0].original, "brown fox");
  assert.strictEqual(drops.overlap, 1);
});

test("verification: an overlap tie keeps the earlier start", () => {
  const { verifyBlock } = service();
  const text = "The quick brown fox jumps.";
  const { suggestions } = verifyBlock(text, [
    { type: "clarity", original: "brown fox", replacement: "red hound", confidence: 0.6 },
    { type: "clarity", original: "quick brown", replacement: "fast red", confidence: 0.6 },
  ]);
  assert.strictEqual(suggestions.length, 1);
  assert.strictEqual(suggestions[0].original, "quick brown");
});

test("verification: edits that only looked overlapping both survive narrowing", () => {
  const { verifyBlock } = service();
  // "quick brown" and "brown fox" share a word, but neither edit touches it.
  const { suggestions, drops } = verifyBlock("The quick brown fox jumps.", [
    { type: "clarity", original: "quick brown", replacement: "fast brown", confidence: 0.4 },
    { type: "clarity", original: "brown fox", replacement: "brown hound", confidence: 0.9 },
  ]);

  assert.strictEqual(drops.overlap, 0);
  assert.deepStrictEqual(
    suggestions.map((s) => [s.original, s.replacement]),
    [
      ["quick", "fast"],
      ["fox", "hound"],
    ],
  );
});

test("verification: unknown types become style, confidence is clamped, reason is trimmed", () => {
  const { verifyBlock } = service();
  const { suggestions, coercedTypes } = verifyBlock("The cat sat on the rug.", [
    {
      type: "vibes",
      original: "cat",
      replacement: "dog",
      confidence: 7,
      reason: "**Bold** claim with `code` and a [link](http://x) " + "y".repeat(200),
    },
    { type: "grammar", original: "rug", replacement: "mat", confidence: -3 },
    { type: "grammar", original: "sat", replacement: "sits" },
  ]);

  const byOriginal = Object.fromEntries(suggestions.map((s) => [s.original, s]));
  assert.strictEqual(byOriginal.cat.type, "style");
  assert.strictEqual(coercedTypes, 1);
  assert.strictEqual(byOriginal.cat.confidence, 1);
  assert.strictEqual(byOriginal.rug.confidence, 0);
  assert.strictEqual(byOriginal.sat.confidence, 0.5, "absent confidence defaults to 0.5");

  assert.strictEqual(byOriginal.cat.reason.length, 140);
  assert.ok(!byOriginal.cat.reason.includes("**"));
  assert.ok(!byOriginal.cat.reason.includes("`"));
  assert.ok(!byOriginal.cat.reason.includes("]("));
});

test("verification: the per-block cap drops the lowest confidence first", () => {
  const { verifyBlock, MAX_SUGGESTIONS_PER_BLOCK } = service();
  const words = Array.from({ length: 60 }, (_, i) => `w${String(i).padStart(2, "0")}`);
  const text = words.join(" ");
  const raw = words.map((w, i) => ({
    type: "spelling",
    original: w,
    replacement: `${w}x`,
    // w00 is the least confident, w59 the most.
    confidence: (i + 1) / 100,
  }));

  const { suggestions, drops } = verifyBlock(text, raw);
  assert.strictEqual(suggestions.length, MAX_SUGGESTIONS_PER_BLOCK);
  assert.strictEqual(drops.cap, 10);
  const kept = suggestions.map((s) => s.original);
  assert.ok(!kept.includes("w00"), "lowest confidence dropped");
  assert.ok(!kept.includes("w09"));
  assert.ok(kept.includes("w10"));
  assert.ok(kept.includes("w59"), "highest confidence kept");
});

// ─── Span narrowing ──────────────────────────────────────────────────────────

test("an over-quoted span is narrowed to the words that actually change", () => {
  const { verifyBlock } = service();
  const text = "the cat sat on the mat and the mat was flat";
  // The model quotes the whole line to fix one capital letter.
  const { suggestions } = verifyBlock(text, [
    {
      type: "punctuation",
      original: text,
      replacement: "The cat sat on the mat and the mat was flat",
      confidence: 0.99,
    },
  ]);

  assert.strictEqual(suggestions.length, 1);
  assert.strictEqual(suggestions[0].original, "the");
  assert.strictEqual(suggestions[0].replacement, "The");
  assert.strictEqual(suggestions[0].occurrence, 1);
  assert.strictEqual(suggestions[0].before, "");
});

test("narrowing counts occurrence against the whole block, not the quoted span", () => {
  const { verifyBlock } = service();
  const text = "a mat and the mat";
  // "the mat" is unique, but it narrows to "mat" — which is the SECOND "mat".
  const { suggestions } = verifyBlock(text, [
    { type: "clarity", original: "the mat", replacement: "the rug", confidence: 0.9 },
  ]);

  assert.strictEqual(suggestions[0].original, "mat");
  assert.strictEqual(suggestions[0].replacement, "rug");
  assert.strictEqual(suggestions[0].occurrence, 2);

  // Prove it against the text the way the app will.
  const positions = [];
  for (let at = text.indexOf("mat"); at !== -1; at = text.indexOf("mat", at + 3)) positions.push(at);
  const start = positions[suggestions[0].occurrence - 1];
  assert.strictEqual(text.slice(start, start + 3), "mat");
  assert.strictEqual(text.slice(Math.max(0, start - 32), start), suggestions[0].before);
});

test("narrowing never splits a word", () => {
  const { verifyBlock } = service();
  const { suggestions } = verifyBlock("Please recieve the parcel and it's fine.", [
    { type: "spelling", original: "recieve", replacement: "receive", confidence: 0.99 },
    { type: "grammar", original: "it's", replacement: "its", confidence: 0.8 },
  ]);
  const byReplacement = Object.fromEntries(suggestions.map((s) => [s.replacement, s]));
  assert.strictEqual(byReplacement.receive.original, "recieve", "not narrowed to 'ie'");
  assert.strictEqual(byReplacement.its.original, "it's");
});

test("narrowing leaves a pure insertion intact", () => {
  const { verifyBlock } = service();
  const { suggestions } = verifyBlock("The cat sat.", [
    { type: "grammar", original: "cat", replacement: "cats", confidence: 0.8 },
  ]);
  assert.strictEqual(suggestions[0].original, "cat");
  assert.strictEqual(suggestions[0].replacement, "cats");
});

test("narrowing frees the rest of an over-quoted line for other suggestions", () => {
  const { verifyBlock } = service();
  const text = "the cat sat and teh dog ran";
  const { suggestions, drops } = verifyBlock(text, [
    // Over-quoted capital fix spanning the whole line.
    { type: "punctuation", original: text, replacement: "The cat sat and teh dog ran", confidence: 0.95 },
    { type: "spelling", original: "teh", replacement: "the", confidence: 0.99 },
  ]);

  assert.strictEqual(drops.overlap, 0, "the narrowed span no longer swallows the block");
  assert.strictEqual(suggestions.length, 2);
  assert.deepStrictEqual(
    suggestions.map((s) => [s.original, s.replacement]),
    [
      ["the", "The"],
      ["teh", "the"],
    ],
  );
});

// ─── Occurrence and before (P3 / P4.2) ───────────────────────────────────────

test("occurrence: the second 'mat' resolves to occurrence 2 with a matching before", () => {
  const { verifyBlock } = service();
  const text = "the cat sat on the mat and the mat was flat";
  const { suggestions } = verifyBlock(text, [
    {
      type: "spelling",
      original: "mat",
      replacement: "rug",
      // The model says which one it meant by quoting more of the text.
      context: "the mat was flat",
      confidence: 0.9,
    },
  ]);

  assert.strictEqual(suggestions.length, 1);
  const s = suggestions[0];
  assert.strictEqual(s.occurrence, 2);

  // The app locates by counting matches; prove the computed occurrence and
  // `before` agree with the text at that position.
  const positions = [];
  for (let at = text.indexOf("mat"); at !== -1; at = text.indexOf("mat", at + 3)) positions.push(at);
  const start = positions[s.occurrence - 1];
  assert.strictEqual(text.slice(start, start + s.original.length), s.original);
  assert.strictEqual(text.slice(Math.max(0, start - 32), start), s.before);
  assert.ok(s.before.endsWith("and the "));
});

test("occurrence: a longer unique span also lands on the second occurrence", () => {
  const { verifyBlock } = service();
  const text = "the cat sat on the mat and the mat was flat";
  // A unique longer quote, narrowed back to the one word that changes — the
  // occurrence has to follow the narrowed span, not the quote.
  const { suggestions } = verifyBlock(text, [
    { type: "clarity", original: "mat was flat", replacement: "rug was flat", confidence: 0.9 },
  ]);

  assert.strictEqual(suggestions[0].original, "mat");
  assert.strictEqual(suggestions[0].replacement, "rug");
  assert.strictEqual(suggestions[0].occurrence, 2);

  const start = text.indexOf("mat was flat");
  assert.strictEqual(text.slice(Math.max(0, start - 32), start), suggestions[0].before);
});

test("occurrence: a match at index 0 has an empty before", () => {
  const { verifyBlock } = service();
  const { suggestions } = verifyBlock("recieve the parcel", [
    { type: "spelling", original: "recieve", replacement: "receive", confidence: 0.99 },
  ]);
  assert.strictEqual(suggestions[0].occurrence, 1);
  assert.strictEqual(suggestions[0].before, "");
});

test("occurrence: five repeats of one word resolve to five distinct occurrences", () => {
  const { verifyBlock } = service();
  const text = "teh a teh b teh c teh d teh e";
  const raw = Array.from({ length: 5 }, () => ({
    type: "spelling",
    original: "teh",
    replacement: "the",
    confidence: 0.95,
  }));

  const { suggestions } = verifyBlock(text, raw);
  assert.strictEqual(suggestions.length, 5);
  assert.deepStrictEqual(
    suggestions.map((s) => s.occurrence),
    [1, 2, 3, 4, 5],
  );

  const positions = [];
  for (let at = text.indexOf("teh"); at !== -1; at = text.indexOf("teh", at + 3)) positions.push(at);
  for (const s of suggestions) {
    const start = positions[s.occurrence - 1];
    assert.strictEqual(text.slice(start, start + 3), "teh");
    assert.strictEqual(text.slice(Math.max(0, start - 32), start), s.before);
  }
});

test("occurrence: more suggestions than occurrences drops the surplus as overlap", () => {
  const { verifyBlock } = service();
  const raw = Array.from({ length: 3 }, () => ({
    type: "spelling",
    original: "teh",
    replacement: "the",
    confidence: 0.9,
  }));
  const { suggestions, drops } = verifyBlock("teh cat and teh dog", raw);
  assert.strictEqual(suggestions.length, 2);
  assert.strictEqual(drops.overlap, 1);
});

test("occurrence: a hallucinated context falls back to the first free match", () => {
  const { verifyBlock } = service();
  const text = "the mat and the mat";
  const { suggestions } = verifyBlock(text, [
    {
      type: "spelling",
      original: "mat",
      replacement: "rug",
      context: "a sentence that is nowhere in the block",
      confidence: 0.9,
    },
  ]);
  assert.strictEqual(suggestions[0].occurrence, 1);
});

// ─── Response shape (P3) ─────────────────────────────────────────────────────

test("the worked example from the contract", async () => {
  const text = "The data shows that recieve rates are up. it is unclear why.";
  const app = freshApp();
  fake.responder = replyWith({
    languages: { b1: "en" },
    suggestions: [
      {
        blockId: "b1",
        type: "spelling",
        original: "recieve",
        replacement: "receive",
        reason: 'Common misspelling of "receive".',
        confidence: 0.99,
      },
      {
        blockId: "b1",
        type: "punctuation",
        original: "it",
        replacement: "It",
        context: "are up. it is unclear",
        reason: "Sentences start with a capital letter.",
        confidence: 0.95,
      },
    ],
  });

  const res = await post(app, { blocks: [{ id: "b1", text }] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.task, "proofread");
  assert.strictEqual(res.body.data.blocks.length, 1);

  const block = res.body.data.blocks[0];
  assert.strictEqual(block.id, "b1");
  assert.strictEqual(block.language, "en");

  const spelling = block.suggestions.find((s) => s.original === "recieve");
  assert.ok(spelling, "the misspelling survived verification");
  assert.strictEqual(spelling.replacement, "receive");
  assert.strictEqual(spelling.occurrence, 1);
  assert.strictEqual(spelling.before, "The data shows that ");

  // "it" also occurs inside "it is unclear" only — but the capital-I check
  // must land on the sentence start, which the context hint disambiguates.
  const capital = block.suggestions.find((s) => s.replacement === "It");
  assert.ok(capital, "the missing capital survived verification");
  const start = text.indexOf(capital.original, capital.occurrence === 1 ? 0 : 0);
  assert.ok(start !== -1);
  assert.strictEqual(capital.before, text.slice(Math.max(0, start - 32), start));

  // Every original is a real substring, every id unique, every field in range.
  const ids = new Set();
  for (const s of block.suggestions) {
    assert.ok(text.includes(s.original), `${s.original} is a substring`);
    assert.ok(!ids.has(s.id));
    ids.add(s.id);
    assert.ok(s.reason.length <= 140);
    assert.ok(s.confidence >= 0 && s.confidence <= 1);
  }
});

test("every requested block comes back once, in order, including empty ones", async () => {
  const app = freshApp();
  fake.responder = replyWith({
    languages: { b2: "en" },
    // Only the middle block has anything wrong.
    suggestions: [
      { blockId: "b2", type: "spelling", original: "teh", replacement: "the", confidence: 0.9 },
    ],
  });

  const blocks = [
    { id: "b1", text: "All fine here." },
    { id: "b2", text: "teh middle one." },
    { id: "b3", text: "Also fine." },
  ];
  const res = await post(app, { blocks });

  assert.deepStrictEqual(
    res.body.data.blocks.map((b) => b.id),
    ["b1", "b2", "b3"],
  );
  assert.deepStrictEqual(res.body.data.blocks[0].suggestions, []);
  assert.strictEqual(res.body.data.blocks[1].suggestions.length, 1);
  assert.deepStrictEqual(res.body.data.blocks[2].suggestions, []);
});

test("a paraphrased original is absent from a 200 that still carries the rest", async () => {
  const app = freshApp();
  fake.responder = replyWith({
    languages: { b1: "en" },
    suggestions: [
      // Re-cased: not an exact substring, so it must never reach the client.
      { blockId: "b1", type: "spelling", original: "Teh", replacement: "The", confidence: 0.99 },
      // Paraphrased.
      { blockId: "b1", type: "clarity", original: "the cat was sitting", replacement: "the cat sat", confidence: 0.8 },
      // Verbatim.
      { blockId: "b1", type: "spelling", original: "teh", replacement: "the", confidence: 0.95 },
    ],
  });

  const res = await post(app, { blocks: [{ id: "b1", text: "teh cat sat down." }] });
  assert.strictEqual(res.status, 200);
  const { suggestions } = res.body.data.blocks[0];
  assert.strictEqual(suggestions.length, 1);
  assert.strictEqual(suggestions[0].original, "teh");
});

test("two overlapping suggestions yield exactly one over the wire", async () => {
  const app = freshApp();
  fake.responder = replyWith({
    languages: { b1: "en" },
    suggestions: [
      // Both rewrite "quick", so only the more confident one can be applied.
      { blockId: "b1", type: "clarity", original: "very quick", replacement: "very fast", confidence: 0.5 },
      { blockId: "b1", type: "clarity", original: "quick brown", replacement: "swift brown", confidence: 0.8 },
    ],
  });

  const res = await post(app, { blocks: [{ id: "b1", text: "A very quick brown fox." }] });
  assert.strictEqual(res.status, 200);
  const { suggestions } = res.body.data.blocks[0];
  assert.strictEqual(suggestions.length, 1);
  assert.strictEqual(suggestions[0].original, "quick");
  assert.strictEqual(suggestions[0].replacement, "swift");
});

test("a suggestion aimed at a block id that was never requested is dropped", async () => {
  const app = freshApp();
  fake.responder = replyWith({
    languages: { b1: "en" },
    suggestions: [
      { blockId: "ghost", type: "spelling", original: "teh", replacement: "the", confidence: 0.9 },
      { blockId: "b1", type: "spelling", original: "teh", replacement: "the", confidence: 0.9 },
    ],
  });

  const res = await post(app, { blocks: [{ id: "b1", text: "teh block." }] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.blocks.length, 1);
  assert.strictEqual(res.body.data.blocks[0].suggestions.length, 1);
});

test("an explicit language is echoed back; auto falls back to und", async () => {
  const app = freshApp();

  fake.responder = replyWith({ languages: { b1: "fr" }, suggestions: [] });
  const auto = await post(app, { blocks: [{ id: "b1", text: "Bonjour le monde." }] });
  assert.strictEqual(auto.body.data.blocks[0].language, "fr");

  const explicit = await post(app, {
    blocks: [{ id: "b1", text: "Bonjour le monde." }],
    language: "en-GB",
  });
  assert.strictEqual(explicit.body.data.blocks[0].language, "en-GB");

  fake.responder = replyWith({ languages: {}, suggestions: [] });
  const unknown = await post(app, { blocks: [{ id: "b9", text: "???" }] });
  assert.strictEqual(unknown.body.data.blocks[0].language, "und");
});

test("the per-response cap keeps the 200 most confident suggestions", async () => {
  const app = freshApp();
  const words = (prefix) => Array.from({ length: 50 }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`);
  const blocks = ["a", "b", "c", "d", "e"].map((p) => ({ id: p, text: words(p).join(" ") }));

  const suggestions = [];
  blocks.forEach((block, blockIndex) => {
    words(block.id).forEach((w, i) => {
      suggestions.push({
        blockId: block.id,
        type: "spelling",
        original: w,
        replacement: `${w}x`,
        confidence: (blockIndex * 50 + i + 1) / 1000,
      });
    });
  });
  fake.responder = replyWith({ languages: {}, suggestions });

  const res = await post(app, { blocks });
  const total = res.body.data.blocks.reduce((n, b) => n + b.suggestions.length, 0);
  assert.strictEqual(total, 200);
  // Confidence rose with block order, so the least confident block loses all.
  assert.strictEqual(res.body.data.blocks[0].suggestions.length, 0);
  assert.strictEqual(res.body.data.blocks[4].suggestions.length, 50);
  // Ids are still contiguous and unique inside each surviving block.
  for (const block of res.body.data.blocks) {
    const ids = block.suggestions.map((s) => s.id);
    assert.deepStrictEqual(ids, [...new Set(ids)]);
  }
});

// ─── Model failure (P5.3) ────────────────────────────────────────────────────

test("invalid JSON is retried once, then answered with 500 AI_BAD_OUTPUT", async () => {
  const app = freshApp();
  fake.responder = () => "I'm afraid I can't do that.";

  const res = await post(app, { blocks: [{ id: "b1", text: "teh cat." }] });
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(res.body.code, "AI_BAD_OUTPUT");
  assert.strictEqual(fake.calls.length, 2, "exactly one retry");
});

test("a retry that parses is served normally", async () => {
  const app = freshApp();
  let call = 0;
  fake.responder = () => {
    call += 1;
    return call === 1
      ? "sorry"
      : JSON.stringify({
          languages: { b1: "en" },
          suggestions: [
            { blockId: "b1", type: "spelling", original: "teh", replacement: "the", confidence: 0.9 },
          ],
        });
  };

  const res = await post(app, { blocks: [{ id: "b1", text: "teh cat." }] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.blocks[0].suggestions.length, 1);
  assert.strictEqual(fake.calls.length, 2);
});

test("a model reply wrapped in a code fence still parses", async () => {
  const app = freshApp();
  fake.responder = () =>
    "```json\n" + JSON.stringify({ languages: { b1: "en" }, suggestions: [] }) + "\n```";

  const res = await post(app, { blocks: [{ id: "b1", text: "Fine." }] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(fake.calls.length, 1);
});

test("a provider timeout inside the budget answers 504, not a 500", async () => {
  const app = freshApp({ PROOFREAD_MODEL_TIMEOUT_MS: 300, PROOFREAD_MIN_ATTEMPT_MS: 100 });
  fake.responder = () => new Promise((resolve) => setTimeout(() => resolve("{}"), 900));

  const res = await post(app, { blocks: [{ id: "b1", text: "teh cat." }] });
  assert.strictEqual(res.status, 504);
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(res.body.error.code, "TIMEOUT");
});

test("a timeout still returns the blocks that were already verified", async () => {
  const app = freshApp({ PROOFREAD_MODEL_TIMEOUT_MS: 300, PROOFREAD_MIN_ATTEMPT_MS: 100 });

  // Warm one block into the cache with a fast reply.
  fake.responder = replyWith({
    languages: { b1: "en" },
    suggestions: [
      { blockId: "b1", type: "spelling", original: "teh", replacement: "the", confidence: 0.9 },
    ],
  });
  const warm = await post(app, { blocks: [{ id: "b1", text: "teh cat." }] });
  assert.strictEqual(warm.status, 200);

  // Now ask for that block plus a new one, and make the model hang.
  fake.responder = () => new Promise((resolve) => setTimeout(() => resolve("{}"), 900));
  const res = await post(app, {
    blocks: [
      { id: "b1", text: "teh cat." },
      { id: "b2", text: "teh dog." },
    ],
  });

  assert.strictEqual(res.status, 200, "a partial answer beats a timeout");
  assert.strictEqual(res.body.data.blocks[0].suggestions.length, 1);
  assert.deepStrictEqual(res.body.data.blocks[1].suggestions, []);
});

test("no provider configured answers 503, and the capability reports false", async () => {
  const app = freshApp();
  const aiProvider = require("../src/services/aiProvider");
  const saved = new Map(aiProvider.providers);
  aiProvider.providers.clear();
  try {
    const res = await post(app, { blocks: [{ id: "b1", text: "teh cat." }] });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.code, "UNAVAILABLE");

    const status = await request(app).get("/api/ai/status");
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.body.capabilities.proofread, false);
  } finally {
    for (const [k, v] of saved) aiProvider.providers.set(k, v);
  }
});

// ─── Cache (P4.6) ────────────────────────────────────────────────────────────

test("the same request twice is byte-identical and the second is a cache hit", async () => {
  const app = freshApp();
  fake.responder = replyWith({
    languages: { b1: "en" },
    suggestions: [
      { blockId: "b1", type: "spelling", original: "teh", replacement: "the", confidence: 0.9 },
    ],
  });

  const body = { blocks: [{ id: "b1", text: "teh cat sat." }] };
  const first = await post(app, body);
  const second = await post(app, body);

  assert.strictEqual(JSON.stringify(first.body), JSON.stringify(second.body));
  assert.strictEqual(fake.calls.length, 1, "the second request never reached the model");
});

test("changed goals, dialect or block text are cache misses", async () => {
  const app = freshApp();
  fake.responder = replyWith({ languages: { b1: "en" }, suggestions: [] });
  const blocks = [{ id: "b1", text: "teh cat sat." }];

  await post(app, { blocks });
  assert.strictEqual(fake.calls.length, 1);

  await post(app, { blocks, goals: ["spelling"] });
  assert.strictEqual(fake.calls.length, 2, "different goals miss");

  await post(app, { blocks, goals: ["spelling"], dialect: "uk" });
  assert.strictEqual(fake.calls.length, 3, "different dialect misses");

  await post(app, { blocks: [{ id: "b1", text: "teh cat sat!" }] });
  assert.strictEqual(fake.calls.length, 4, "different text misses");

  // ...and the original combination is still cached.
  await post(app, { blocks });
  assert.strictEqual(fake.calls.length, 4);
});

test("the cache evicts the least recently used block at its configured size", async () => {
  const app = freshApp({ PROOFREAD_CACHE_MAX_BLOCKS: 3 });
  fake.responder = replyWith({ languages: {}, suggestions: [] });
  const send = (n) => post(app, { blocks: [{ id: "b1", text: `Block number ${n}.` }] });

  await send(1);
  await send(2);
  await send(3);
  assert.strictEqual(fake.calls.length, 3);
  assert.strictEqual(service()._cache.size, 3);

  // Touch 1 so it is the most recent, then add a fourth: 2 is the victim.
  await send(1);
  assert.strictEqual(fake.calls.length, 3, "1 was still cached");
  await send(4);
  assert.strictEqual(service()._cache.size, 3);

  await send(2);
  assert.strictEqual(fake.calls.length, 5, "2 was evicted and had to be re-fetched");
  await send(1);
  assert.strictEqual(fake.calls.length, 5, "1 survived as the most recently used");
});

test("an expired cache entry is re-fetched", async () => {
  const app = freshApp({ PROOFREAD_CACHE_TTL_MS: 1 });
  fake.responder = replyWith({ languages: {}, suggestions: [] });
  const body = { blocks: [{ id: "b1", text: "Some text to check." }] };

  await post(app, body);
  assert.strictEqual(fake.calls.length, 1);
  await new Promise((r) => setTimeout(r, 5));
  await post(app, body);
  assert.strictEqual(fake.calls.length, 2);
});

test("the prompt version is part of the cache key", () => {
  const { blockCacheKey, PROMPT_VERSION } = service();
  const opts = { language: "auto", dialect: null, goals: ["spelling"], model: "m" };
  const key = blockCacheKey("hello", opts);
  assert.notStrictEqual(key, blockCacheKey("hello", { ...opts, model: "m2" }));
  assert.ok(PROMPT_VERSION.length > 0);
});

test("only the changed block of a multi-block request reaches the model", async () => {
  const app = freshApp();
  fake.responder = replyWith({ languages: {}, suggestions: [] });

  const original = [
    { id: "b1", text: "Paragraph one." },
    { id: "b2", text: "Paragraph two." },
    { id: "b3", text: "Paragraph three." },
    { id: "b4", text: "Paragraph four." },
  ];
  await post(app, { blocks: original });
  assert.strictEqual(fake.calls.length, 1);

  const edited = original.map((b) => (b.id === "b3" ? { ...b, text: "Paragraph three edited." } : b));
  await post(app, { blocks: edited });
  assert.strictEqual(fake.calls.length, 2);

  // The second call carried only the edited block.
  const sent = String(fake.calls[1].messages[1].content);
  assert.ok(sent.includes("Paragraph three edited."));
  assert.ok(!sent.includes("Paragraph one."));
  assert.ok(!sent.includes("Paragraph four."));
});

test("goals are order-insensitive for the cache but preserved in the prompt", async () => {
  const app = freshApp();
  fake.responder = replyWith({ languages: {}, suggestions: [] });
  const blocks = [{ id: "b1", text: "Some text." }];

  await post(app, { blocks, goals: ["spelling", "grammar"] });
  await post(app, { blocks, goals: ["grammar", "spelling"] });
  assert.strictEqual(fake.calls.length, 1, "reordered goals are the same cache entry");
});

// ─── Prompt hygiene ──────────────────────────────────────────────────────────

test("the prompt never asks the model for offsets or occurrence numbers", async () => {
  const app = freshApp();
  fake.responder = replyWith({ languages: {}, suggestions: [] });
  await post(app, { blocks: [{ id: "b1", text: "Some text." }] });

  const sent = fake.calls[0].messages.map((m) => String(m.content)).join("\n");
  assert.ok(!/"occurrence"/.test(sent));
  assert.ok(!/"offset"/.test(sent));
  assert.ok(!/"start"|"end"|"index"|"position"/.test(sent));
  assert.ok(/verbatim/i.test(sent), "it does insist on verbatim quoting");
});

test("the model is called at temperature 0", async () => {
  const app = freshApp();
  fake.responder = replyWith({ languages: {}, suggestions: [] });
  await post(app, { blocks: [{ id: "b1", text: "Some text." }] });
  assert.strictEqual(fake.calls[0].options.temperature, 0);
});

test("all uncached blocks go out in one model call", async () => {
  const app = freshApp();
  fake.responder = replyWith({ languages: {}, suggestions: [] });
  const blocks = Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, text: `Block ${i} text.` }));
  await post(app, { blocks });
  assert.strictEqual(fake.calls.length, 1);
  const sent = String(fake.calls[0].messages[1].content);
  for (let i = 0; i < 8; i++) assert.ok(sent.includes(`Block ${i} text.`));
});

// ─── Auth (P1.3) ─────────────────────────────────────────────────────────────

test("enforce mode: a bad app key is 401 on proofread exactly as elsewhere", async () => {
  const app = freshApp({ AUTH_MODE: "enforce", AI_APP_KEYS: "good-key" });
  const res = await post(app, { blocks: [{ id: "b1", text: "Text." }] }, { "X-App-Key": "wrong" });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.code, "UNAUTHORIZED");

  const summarize = await request(app)
    .post("/api/ai/summarize")
    .set("X-App-Key", "wrong")
    .send({ text: "Text." });
  assert.strictEqual(summarize.status, 401);
  assert.strictEqual(summarize.body.code, summarize.body.code);
  assert.strictEqual(fake.calls.length, 0);
});

test("enforce mode: a valid key without a premium user is 403 PREMIUM_REQUIRED", async () => {
  const app = freshApp({ AUTH_MODE: "enforce", AI_APP_KEYS: "good-key" });
  const res = await post(app, { blocks: [{ id: "b1", text: "Text." }] }, { "X-App-Key": "good-key" });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, "PREMIUM_REQUIRED");
  assert.strictEqual(fake.calls.length, 0);
});

test("enforce mode: an allowlisted user is served", async () => {
  const app = freshApp({
    AUTH_MODE: "enforce",
    AI_APP_KEYS: "good-key",
    AUTH_ALLOWLIST_USER_IDS: "user-1",
  });
  fake.responder = replyWith({ languages: {}, suggestions: [] });
  const res = await post(
    app,
    { blocks: [{ id: "b1", text: "Text." }] },
    { "X-App-Key": "good-key", "X-User-Id": "user-1" },
  );
  assert.strictEqual(res.status, 200);
});

test("monitor mode logs but never blocks", async () => {
  const app = freshApp({ AUTH_MODE: "monitor", AI_APP_KEYS: "good-key" });
  fake.responder = replyWith({ languages: {}, suggestions: [] });
  const res = await post(app, { blocks: [{ id: "b1", text: "Text." }] }, { "X-App-Key": "wrong" });
  assert.strictEqual(res.status, 200);
});

test("the request id is echoed back", async () => {
  const app = freshApp();
  fake.responder = replyWith({ languages: {}, suggestions: [] });
  const res = await post(
    app,
    { blocks: [{ id: "b1", text: "Text." }] },
    { "X-Request-Id": "req-abc-123" },
  );
  assert.strictEqual(res.headers["x-request-id"], "req-abc-123");
});

// ─── Rate limits (P5.2 / B3) ─────────────────────────────────────────────────

test("the per-minute bucket answers 429 with a matching Retry-After", async () => {
  const app = freshApp({ RATE_LIMIT_ENABLED: "true", PROOFREAD_PER_MIN: 3 });
  fake.responder = replyWith({ languages: {}, suggestions: [] });

  const body = (i) => ({ blocks: [{ id: "b1", text: `Attempt number ${i}.` }] });
  for (let i = 0; i < 3; i++) {
    const ok = await post(app, body(i), { "X-User-Id": "burst-user" });
    assert.strictEqual(ok.status, 200, `request ${i}`);
  }

  const limited = await post(app, body(99), { "X-User-Id": "burst-user" });
  assert.strictEqual(limited.status, 429);
  assert.strictEqual(limited.body.code, "RATE_LIMITED");
  assert.strictEqual(limited.body.retryAfterSec, Number(limited.headers["retry-after"]));
  assert.ok(limited.body.retryAfterSec >= 1 && limited.body.retryAfterSec <= 60);
});

test("rate limiting is active with authMode off", async () => {
  const app = freshApp({ AUTH_MODE: "off", RATE_LIMIT_ENABLED: "true", PROOFREAD_PER_MIN: 1 });
  fake.responder = replyWith({ languages: {}, suggestions: [] });

  const first = await post(app, { blocks: [{ id: "b1", text: "One." }] }, { "X-User-Id": "u" });
  assert.strictEqual(first.status, 200);
  const second = await post(app, { blocks: [{ id: "b1", text: "Two." }] }, { "X-User-Id": "u" });
  assert.strictEqual(second.status, 429);
});

test("the character budget limits by volume, not just request count", async () => {
  const app = freshApp({
    RATE_LIMIT_ENABLED: "true",
    PROOFREAD_PER_MIN: 100,
    PROOFREAD_CHARS_PER_MIN: 5000,
  });
  fake.responder = replyWith({ languages: {}, suggestions: [] });

  const big = (n) => ({ blocks: [{ id: "b1", text: "x".repeat(3000) + String(n) }] });
  const first = await post(app, big(1), { "X-User-Id": "heavy" });
  assert.strictEqual(first.status, 200);
  const second = await post(app, big(2), { "X-User-Id": "heavy" });
  assert.strictEqual(second.status, 200, "the request that crosses the line is still served");
  const third = await post(app, big(3), { "X-User-Id": "heavy" });
  assert.strictEqual(third.status, 429);
  assert.strictEqual(third.body.code, "RATE_LIMITED");
  assert.ok(third.body.retryAfterSec >= 1);

  // A different user has their own budget.
  const other = await post(app, big(4), { "X-User-Id": "light" });
  assert.strictEqual(other.status, 200);
});

test("the concurrency cap sheds load with 429 rather than timing out", async () => {
  const app = freshApp({
    RATE_LIMIT_ENABLED: "true",
    PROOFREAD_PER_MIN: 100,
    PROOFREAD_MAX_CONCURRENT: 1,
    PROOFREAD_QUEUE_WAIT_MS: 50,
  });

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  fake.responder = async () => {
    await gate;
    return JSON.stringify({ languages: {}, suggestions: [] });
  };

  // .then() is what actually sends a supertest request, so the first one must
  // be started explicitly rather than just held as a pending Test object.
  const slow = post(app, { blocks: [{ id: "b1", text: "First." }] }, { "X-User-Id": "a" }).then(
    (r) => r,
  );
  // Give the first request time to take the only slot.
  await new Promise((r) => setTimeout(r, 50));
  const shed = await post(app, { blocks: [{ id: "b1", text: "Second." }] }, { "X-User-Id": "b" });

  assert.strictEqual(shed.status, 429);
  assert.strictEqual(shed.body.code, "RATE_LIMITED");
  assert.ok(shed.body.retryAfterSec >= 1);
  assert.strictEqual(Number(shed.headers["retry-after"]), shed.body.retryAfterSec);

  release();
  const done = await slow;
  assert.strictEqual(done.status, 200);
});

test("a proofread burst does not rate-limit a concurrent summarize", async () => {
  const app = freshApp({
    RATE_LIMIT_ENABLED: "true",
    PROOFREAD_PER_MIN: 30,
    RATE_LIMIT_AI_PER_MIN: 5,
  });
  fake.responder = (messages) => {
    const user = String(messages[messages.length - 1]?.content || "");
    return user.includes('"languages"')
      ? JSON.stringify({ languages: {}, suggestions: [] })
      : "A summary.";
  };

  for (let i = 0; i < 10; i++) {
    const res = await post(app, { blocks: [{ id: "b1", text: `Block ${i}.` }] }, { "X-User-Id": "u" });
    assert.strictEqual(res.status, 200, `proofread ${i}`);
  }

  const summarize = await request(app)
    .post("/api/ai/summarize")
    .set("X-User-Id", "u")
    .send({ text: "Some document text to summarize." });
  assert.strictEqual(summarize.status, 200, "the shared AI bucket was not spent by proofread");
});

// ─── Status (B1) ─────────────────────────────────────────────────────────────

test("status advertises proofread and changes nothing else", async () => {
  const app = freshApp();
  const res = await request(app).get("/api/ai/status");

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.capabilities.proofread, true);

  // The fields the app parses are all still there, with their old types.
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(typeof res.body.currentProvider, "string");
  assert.ok(Array.isArray(res.body.availableProviders));
  assert.strictEqual(typeof res.body.fallbackEnabled, "boolean");
  assert.ok(Array.isArray(res.body.fallbackOrder));
  assert.strictEqual(res.body.apiVersion, 2);

  for (const key of [
    "docIdTasks",
    "persistentDocs",
    "citationsV2",
    "streamChat",
    "streamChatDocument",
    "devilsAdvocate",
    "narrativeArc",
    "markdown",
  ]) {
    assert.strictEqual(typeof res.body.capabilities[key], "boolean", key);
  }
  assert.strictEqual(typeof res.body.capabilities.authMode, "string");
});

test("status stays unauthenticated in enforce mode", async () => {
  const app = freshApp({ AUTH_MODE: "enforce", AI_APP_KEYS: "good-key" });
  const res = await request(app).get("/api/ai/status");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.capabilities.proofread, true);
});
