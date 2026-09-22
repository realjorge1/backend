// ============================================
// FILE: config/apiConfig.js
// Configuration for the v2 AI API surface: auth, rate limits, document
// storage, retrieval and streaming. Every value comes from an environment
// variable and every default is permissive, so a deploy that sets nothing
// behaves like the pre-v2 server.
// ============================================

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const AUTH_MODES = ["off", "monitor", "enforce"];
const rawAuthMode = String(process.env.AUTH_MODE || "monitor").toLowerCase().trim();

const apiConfig = {
  apiVersion: 2,

  // ── Auth ──────────────────────────────────────────────────────────────────
  authMode: AUTH_MODES.includes(rawAuthMode) ? rawAuthMode : "monitor",
  appKeys: list(process.env.AI_APP_KEYS),
  allowlistUserIds: new Set(list(process.env.AUTH_ALLOWLIST_USER_IDS)),
  adminToken: process.env.ADMIN_TOKEN || "",
  userHashSalt: process.env.USER_HASH_SALT || "",

  revenueCat: {
    secretKey: process.env.REVENUECAT_SECRET_API_KEY || "",
    entitlementId: process.env.REVENUECAT_ENTITLEMENT_ID || "premium",
    apiBase: process.env.REVENUECAT_API_BASE || "https://api.revenuecat.com",
    timeoutMs: int(process.env.REVENUECAT_TIMEOUT_MS, 4000),
    activeCacheMs: int(process.env.REVENUECAT_ACTIVE_CACHE_MS, 10 * 60 * 1000),
    inactiveCacheMs: int(process.env.REVENUECAT_INACTIVE_CACHE_MS, 2 * 60 * 1000),
  },

  // ── Rate limits ───────────────────────────────────────────────────────────
  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED !== "false",
    aiPerMin: int(process.env.RATE_LIMIT_AI_PER_MIN, 60),
    aiPerDay: int(process.env.RATE_LIMIT_AI_PER_DAY, 1000),
    ipPerMin: int(process.env.RATE_LIMIT_IP_PER_MIN, 180),
    extractPerHour: int(process.env.RATE_LIMIT_EXTRACT_PER_HOUR, 30),
  },

  // Unset means no budget enforcement.
  dailyTokenBudgetPerUser: process.env.DAILY_TOKEN_BUDGET_PER_USER
    ? int(process.env.DAILY_TOKEN_BUDGET_PER_USER, 0)
    : null,

  // ── Document store ────────────────────────────────────────────────────────
  documents: {
    databaseUrl: process.env.DATABASE_URL || "",
    runMigrations: process.env.RUN_MIGRATIONS === "true",
    ttlDays: int(process.env.DOC_TTL_DAYS, 7),
    maxTtlDays: int(process.env.DOC_MAX_TTL_DAYS, 30),
    purgeIntervalMs: int(process.env.DOC_PURGE_INTERVAL_MS, 60 * 60 * 1000),
    poolMax: int(process.env.DATABASE_POOL_MAX, 5),
  },

  // ── Retrieval ─────────────────────────────────────────────────────────────
  retrieval: {
    topK: int(process.env.RAG_TOP_K, 8),
    contextChars: int(process.env.RAG_CONTEXT_CHARS, 16000),
    embeddingsProvider: String(process.env.EMBEDDINGS_PROVIDER || "").toLowerCase().trim(),
    openaiModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
    geminiModel: process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001",
    voyageModel: process.env.VOYAGE_EMBEDDING_MODEL || "voyage-3.5",
    voyageApiKey: process.env.VOYAGE_API_KEY || "",
    batchSize: int(process.env.EMBEDDING_BATCH_SIZE, 64),
    maxRetries: int(process.env.EMBEDDING_MAX_RETRIES, 3),
  },

  // ── Tasks over whole documents ────────────────────────────────────────────
  tasks: {
    maxInstructionChars: int(process.env.AI_MAX_INSTRUCTION_CHARS, 2000),
    translateChunkChars: int(process.env.TRANSLATE_CHUNK_CHARS, 12000),
    translateMaxOutputChars: int(process.env.TRANSLATE_MAX_OUTPUT_CHARS, 200000),
  },

  // ── Proofread ─────────────────────────────────────────────────────────────
  // The app calls POST /api/ai/proofread on a typing debounce, so this is by
  // far the highest-frequency AI route. It gets its own tighter limits, its
  // own concurrency cap and its own cache rather than sharing the general AI
  // budget, so a burst of typing can't starve the document tasks.
  proofread: {
    // Empty means "use whatever model the active provider is configured with",
    // which is already the fast/cheap tier for all three providers.
    model: process.env.PROOFREAD_MODEL || "",
    maxTokens: int(process.env.PROOFREAD_MAX_TOKENS, 3000),

    // Whole-request budget (P5.1: answer within 15s; the app allows 20s).
    budgetMs: int(process.env.PROOFREAD_BUDGET_MS, 15000),
    modelTimeoutMs: int(process.env.PROOFREAD_MODEL_TIMEOUT_MS, 11000),
    // Don't start a model attempt that can't plausibly finish in what's left.
    minAttemptMs: int(process.env.PROOFREAD_MIN_ATTEMPT_MS, 2500),

    // In-process only: the free tier has no disk and no Redis.
    cacheMaxBlocks: int(process.env.PROOFREAD_CACHE_MAX_BLOCKS, 500),
    cacheTtlMs: int(process.env.PROOFREAD_CACHE_TTL_MS, 24 * 60 * 60 * 1000),

    perMin: int(process.env.PROOFREAD_PER_MIN, 30),
    perHour: int(process.env.PROOFREAD_PER_HOUR, 400),
    charsPerMin: int(process.env.PROOFREAD_CHARS_PER_MIN, 120000),
    maxConcurrent: int(process.env.PROOFREAD_MAX_CONCURRENT, 4),
    // How long a request may wait for a concurrency slot before we tell the
    // app to back off instead of burning its 20-second client budget.
    queueWaitMs: int(process.env.PROOFREAD_QUEUE_WAIT_MS, 2000),
  },

  // ── Streaming ─────────────────────────────────────────────────────────────
  streaming: {
    enabled: process.env.STREAMING_ENABLED !== "false",
    pingIntervalMs: int(process.env.SSE_PING_INTERVAL_MS, 15000),
  },

  // ── Extraction limits ─────────────────────────────────────────────────────
  extraction: {
    xlsxMaxCells: int(process.env.XLSX_MAX_CELLS, 50000),
    sectionChars: int(process.env.SECTION_CHARS, 4000),
  },
};

module.exports = apiConfig;
