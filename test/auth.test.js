/**
 * B1 — auth modes, app-key rotation, allowlist, RevenueCat states, rate limits.
 *
 * apiConfig is read at module load, so each scenario re-requires the middleware
 * chain with a fresh environment.
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
  "REVENUECAT_ENTITLEMENT_ID",
  "ADMIN_TOKEN",
  "RATE_LIMIT_ENABLED",
  "RATE_LIMIT_AI_PER_MIN",
  "RATE_LIMIT_IP_PER_MIN",
  "DAILY_TOKEN_BUDGET_PER_USER",
];

let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  installFakeProvider();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  restoreProvider();
});

/** Rebuild the middleware chain with the current process.env. */
function freshApp(env = {}) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  for (const key of Object.keys(require.cache)) {
    if (
      key.includes("apiConfig") ||
      key.includes("aiAuth") ||
      key.includes("aiTelemetry") ||
      key.includes("requestContext") ||
      key.includes("aiRateLimit") ||
      key.includes("entitlements") ||
      key.includes("tokenBudget") ||
      key.includes("requireAdmin") ||
      key.includes("mountAiApi") ||
      key.includes("aiRoutes") ||
      key.includes("capabilities")
    ) {
      delete require.cache[key];
    }
  }

  const { mountAiApi } = require("../src/ai/mountAiApi");
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  mountAiApi(app);
  return app;
}

/** Stub globalThis.fetch for the RevenueCat lookup. */
function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function rcResponse(entitlements) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ subscriber: { entitlements } }),
  };
}

const future = new Date(Date.now() + 86400000).toISOString();
const past = new Date(Date.now() - 86400000).toISOString();

// ── Status is always open ────────────────────────────────────────────────────

test("GET /status needs no auth even in enforce mode", async () => {
  const app = freshApp({ AUTH_MODE: "enforce", AI_APP_KEYS: "key-a" });
  const res = await request(app).get("/api/ai/status");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.apiVersion, 2);
  assert.strictEqual(res.body.capabilities.authMode, "enforce");
});

test("status reports capabilities and keeps its legacy fields", async () => {
  const app = freshApp({ AUTH_MODE: "monitor" });
  const res = await request(app).get("/api/ai/status");
  assert.strictEqual(res.body.success, true);
  assert.ok("currentProvider" in res.body);
  assert.ok("availableProviders" in res.body);
  assert.ok("fallbackEnabled" in res.body);
  assert.ok("fallbackOrder" in res.body);
  for (const flag of [
    "docIdTasks",
    "persistentDocs",
    "citationsV2",
    "streamChat",
    "streamChatDocument",
    "devilsAdvocate",
    "narrativeArc",
    "markdown",
  ]) {
    assert.strictEqual(
      typeof res.body.capabilities[flag],
      "boolean",
      `${flag} should be a boolean`,
    );
  }
});

// ── Modes ────────────────────────────────────────────────────────────────────

test("off mode checks nothing", async () => {
  const app = freshApp({ AUTH_MODE: "off", AI_APP_KEYS: "key-a" });
  const res = await request(app).post("/api/ai/summarize").send({ text: "Hello there." });
  assert.strictEqual(res.status, 200);
});

test("monitor mode lets a request with no new headers through", async () => {
  const app = freshApp({ AUTH_MODE: "monitor", AI_APP_KEYS: "key-a" });
  const res = await request(app).post("/api/ai/summarize").send({ text: "Hello there." });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
});

test("monitor mode echoes a request id back", async () => {
  const app = freshApp({ AUTH_MODE: "monitor" });
  const res = await request(app)
    .post("/api/ai/summarize")
    .set("X-Request-Id", "req-abc-123")
    .send({ text: "Hello there." });
  assert.strictEqual(res.headers["x-request-id"], "req-abc-123");
});

test("monitor mode generates a request id when the client sends none", async () => {
  const app = freshApp({ AUTH_MODE: "monitor" });
  const res = await request(app).post("/api/ai/summarize").send({ text: "Hello there." });
  assert.match(res.headers["x-request-id"], /^[0-9a-f-]{36}$/);
});

test("enforce mode rejects a missing app key with 401 UNAUTHORIZED", async () => {
  const app = freshApp({ AUTH_MODE: "enforce", AI_APP_KEYS: "key-a" });
  const res = await request(app).post("/api/ai/summarize").send({ text: "Hello." });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.code, "UNAUTHORIZED");
  assert.strictEqual(typeof res.body.error, "string");
  assert.strictEqual(res.body.success, false);
});

test("enforce mode rejects a wrong app key", async () => {
  const app = freshApp({ AUTH_MODE: "enforce", AI_APP_KEYS: "key-a" });
  const res = await request(app)
    .post("/api/ai/summarize")
    .set("X-App-Key", "key-wrong")
    .send({ text: "Hello." });
  assert.strictEqual(res.status, 401);
});

test("enforce mode accepts either key during rotation", async () => {
  const restore = stubFetch(async () => rcResponse({ premium: { expires_date: future } }));
  try {
    const app = freshApp({
      AUTH_MODE: "enforce",
      AI_APP_KEYS: "old-key, new-key",
      REVENUECAT_SECRET_API_KEY: "sk-test",
    });
    for (const key of ["old-key", "new-key"]) {
      const res = await request(app)
        .post("/api/ai/summarize")
        .set("X-App-Key", key)
        .set("X-User-Id", `user-${key}`)
        .send({ text: "Hello." });
      assert.strictEqual(res.status, 200, `key ${key} should be accepted`);
    }
  } finally {
    restore();
  }
});

test("enforce mode returns 403 PREMIUM_REQUIRED without a user id", async () => {
  const app = freshApp({
    AUTH_MODE: "enforce",
    AI_APP_KEYS: "key-a",
    REVENUECAT_SECRET_API_KEY: "sk-test",
  });
  const res = await request(app)
    .post("/api/ai/summarize")
    .set("X-App-Key", "key-a")
    .send({ text: "Hello." });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, "PREMIUM_REQUIRED");
});

// ── RevenueCat ───────────────────────────────────────────────────────────────

test("active entitlement passes enforce mode", async () => {
  const restore = stubFetch(async (url, opts) => {
    assert.match(url, /\/v1\/subscribers\/user-1$/);
    assert.strictEqual(opts.headers.Authorization, "Bearer sk-test");
    return rcResponse({ premium: { expires_date: future } });
  });
  try {
    const app = freshApp({
      AUTH_MODE: "enforce",
      AI_APP_KEYS: "key-a",
      REVENUECAT_SECRET_API_KEY: "sk-test",
    });
    const res = await request(app)
      .post("/api/ai/summarize")
      .set("X-App-Key", "key-a")
      .set("X-User-Id", "user-1")
      .send({ text: "Hello." });
    assert.strictEqual(res.status, 200);
  } finally {
    restore();
  }
});

test("a lifetime entitlement (null expiry) counts as active", async () => {
  const restore = stubFetch(async () => rcResponse({ premium: { expires_date: null } }));
  try {
    const app = freshApp({
      AUTH_MODE: "enforce",
      AI_APP_KEYS: "key-a",
      REVENUECAT_SECRET_API_KEY: "sk-test",
    });
    const res = await request(app)
      .post("/api/ai/summarize")
      .set("X-App-Key", "key-a")
      .set("X-User-Id", "user-lifetime")
      .send({ text: "Hello." });
    assert.strictEqual(res.status, 200);
  } finally {
    restore();
  }
});

test("an expired entitlement is blocked in enforce mode", async () => {
  const restore = stubFetch(async () => rcResponse({ premium: { expires_date: past } }));
  try {
    const app = freshApp({
      AUTH_MODE: "enforce",
      AI_APP_KEYS: "key-a",
      REVENUECAT_SECRET_API_KEY: "sk-test",
    });
    const res = await request(app)
      .post("/api/ai/summarize")
      .set("X-App-Key", "key-a")
      .set("X-User-Id", "user-expired")
      .send({ text: "Hello." });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, "PREMIUM_REQUIRED");
  } finally {
    restore();
  }
});

test("RevenueCat being unreachable never locks a user out", async () => {
  const restore = stubFetch(async () => {
    throw new Error("ECONNRESET");
  });
  try {
    const app = freshApp({
      AUTH_MODE: "enforce",
      AI_APP_KEYS: "key-a",
      REVENUECAT_SECRET_API_KEY: "sk-test",
    });
    const res = await request(app)
      .post("/api/ai/summarize")
      .set("X-App-Key", "key-a")
      .set("X-User-Id", "user-outage")
      .send({ text: "Hello." });
    assert.strictEqual(res.status, 200);
  } finally {
    restore();
  }
});

test("the allowlist skips the premium check but not the app key", async () => {
  const restore = stubFetch(async () => {
    throw new Error("RevenueCat should not be called for an allowlisted user");
  });
  try {
    const app = freshApp({
      AUTH_MODE: "enforce",
      AI_APP_KEYS: "key-a",
      AUTH_ALLOWLIST_USER_IDS: "tester-1,tester-2",
      REVENUECAT_SECRET_API_KEY: "sk-test",
    });

    const allowed = await request(app)
      .post("/api/ai/summarize")
      .set("X-App-Key", "key-a")
      .set("X-User-Id", "tester-1")
      .send({ text: "Hello." });
    assert.strictEqual(allowed.status, 200);

    const badKey = await request(app)
      .post("/api/ai/summarize")
      .set("X-App-Key", "nope")
      .set("X-User-Id", "tester-1")
      .send({ text: "Hello." });
    assert.strictEqual(badKey.status, 401);
  } finally {
    restore();
  }
});

// ── Rate limits ──────────────────────────────────────────────────────────────

test("exceeding the per-minute limit returns 429 with Retry-After", async () => {
  const app = freshApp({
    AUTH_MODE: "off",
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_AI_PER_MIN: "2",
  });

  const send = () =>
    request(app)
      .post("/api/ai/summarize")
      .set("X-User-Id", "heavy-user")
      .send({ text: "Hello." });

  assert.strictEqual((await send()).status, 200);
  assert.strictEqual((await send()).status, 200);

  const limited = await send();
  assert.strictEqual(limited.status, 429);
  assert.strictEqual(limited.body.code, "RATE_LIMITED");
  assert.strictEqual(typeof limited.body.retryAfterSec, "number");
  assert.ok(limited.body.retryAfterSec > 0);
  assert.ok(limited.headers["retry-after"], "Retry-After header should be set");
});

test("rate limits can be switched off", async () => {
  const app = freshApp({
    AUTH_MODE: "off",
    RATE_LIMIT_ENABLED: "false",
    RATE_LIMIT_AI_PER_MIN: "1",
  });
  for (let i = 0; i < 4; i++) {
    const res = await request(app)
      .post("/api/ai/summarize")
      .set("X-User-Id", "unlimited-user")
      .send({ text: "Hello." });
    assert.strictEqual(res.status, 200);
  }
});

test("limits are keyed per user, not shared across users", async () => {
  const app = freshApp({
    AUTH_MODE: "off",
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_AI_PER_MIN: "1",
    RATE_LIMIT_IP_PER_MIN: "100",
  });

  const first = await request(app)
    .post("/api/ai/summarize")
    .set("X-User-Id", "user-a")
    .send({ text: "Hello." });
  assert.strictEqual(first.status, 200);

  const other = await request(app)
    .post("/api/ai/summarize")
    .set("X-User-Id", "user-b")
    .send({ text: "Hello." });
  assert.strictEqual(other.status, 200);

  const repeat = await request(app)
    .post("/api/ai/summarize")
    .set("X-User-Id", "user-a")
    .send({ text: "Hello." });
  assert.strictEqual(repeat.status, 429);
});

test("the per-IP limit catches user-id rotation", async () => {
  const app = freshApp({
    AUTH_MODE: "off",
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_AI_PER_MIN: "100",
    RATE_LIMIT_IP_PER_MIN: "2",
  });

  const send = (user) =>
    request(app).post("/api/ai/summarize").set("X-User-Id", user).send({ text: "Hi." });

  assert.strictEqual((await send("rot-1")).status, 200);
  assert.strictEqual((await send("rot-2")).status, 200);
  assert.strictEqual((await send("rot-3")).status, 429);
});

// ── Admin routes ─────────────────────────────────────────────────────────────

test("switch-provider is 404 without an admin token", async () => {
  const app = freshApp({ AUTH_MODE: "off", ADMIN_TOKEN: undefined });
  const res = await request(app).post("/api/ai/switch-provider").send({ provider: "fake" });
  assert.strictEqual(res.status, 404);
});

test("switch-provider needs the admin bearer token", async () => {
  const app = freshApp({ AUTH_MODE: "off", ADMIN_TOKEN: "secret-admin" });

  const unauthorized = await request(app)
    .post("/api/ai/switch-provider")
    .send({ provider: "fake" });
  assert.strictEqual(unauthorized.status, 401);

  const authorized = await request(app)
    .post("/api/ai/switch-provider")
    .set("Authorization", "Bearer secret-admin")
    .send({ provider: "fake" });
  assert.strictEqual(authorized.status, 200);
});

test("auth-stats is admin-only and counts monitored requests", async () => {
  const app = freshApp({ AUTH_MODE: "monitor", ADMIN_TOKEN: "secret-admin" });

  await request(app)
    .post("/api/ai/summarize")
    .set("X-App-Key", "whatever")
    .set("X-Client-Version", "1.0.0")
    .send({ text: "Hello." });

  const denied = await request(app).get("/api/ai/admin/auth-stats");
  assert.strictEqual(denied.status, 401);

  const stats = await request(app)
    .get("/api/ai/admin/auth-stats")
    .set("Authorization", "Bearer secret-admin");
  assert.strictEqual(stats.status, 200);
  assert.ok(stats.body.stats.total >= 1);
  assert.ok(stats.body.stats.withAppKey >= 1);
  assert.strictEqual(stats.body.stats.clientVersions["1.0.0"], 1);
});

// ── Token budget ─────────────────────────────────────────────────────────────

test("a user over the daily token budget gets 429", async () => {
  const app = freshApp({
    AUTH_MODE: "off",
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_AI_PER_MIN: "100",
    DAILY_TOKEN_BUDGET_PER_USER: "20",
  });

  // The fake provider reports 30 tokens per call, so one call exhausts it.
  const first = await request(app)
    .post("/api/ai/summarize")
    .set("X-User-Id", "budget-user")
    .send({ text: "Hello." });
  assert.strictEqual(first.status, 200);

  const second = await request(app)
    .post("/api/ai/summarize")
    .set("X-User-Id", "budget-user")
    .send({ text: "Hello." });
  assert.strictEqual(second.status, 429);
  assert.strictEqual(second.body.code, "RATE_LIMITED");
});
