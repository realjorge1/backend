// ============================================
// FILE: services/aiProvider.js
// AI Provider Manager — handles provider selection,
// fallback, and timeout for all AI requests.
// ============================================
const aiConfig = require("../config/aiConfig");
const logger = require("../utils/logger");

class AIProviderManager {
  constructor() {
    this.providers = new Map();
    this.currentProvider = aiConfig.provider;
    this.enableFallback = aiConfig.enableFallback;
    this.fallbackOrder = aiConfig.fallbackProviders;
    this._initialized = false;
  }

  /**
   * Initialize all providers that have API keys configured.
   * Safe to call multiple times — only runs once.
   */
  initialize() {
    if (this._initialized) return;

    const providerConfigs = {
      openai: { module: "./providers/openai", config: aiConfig.openai },
      gemini: { module: "./providers/gemini", config: aiConfig.gemini },
      claude: { module: "./providers/claude", config: aiConfig.claude },
    };

    for (const [name, { module: mod, config }] of Object.entries(
      providerConfigs,
    )) {
      if (config.apiKey) {
        try {
          const Provider = require(mod);
          this.providers.set(name, new Provider(config));
          logger.info(`AI provider initialized: ${name}`);
        } catch (err) {
          logger.warn(
            `AI provider "${name}" failed to initialize: ${err.message}`,
          );
        }
      }
    }

    if (this.providers.size === 0) {
      logger.warn(
        "No AI providers configured — AI features will be unavailable. " +
          "Set at least one of: OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY",
      );
    } else {
      // If selected provider is unavailable, fall back to the first available
      if (!this.providers.has(this.currentProvider)) {
        const firstAvailable = [...this.providers.keys()][0];
        logger.warn(
          `Selected provider "${this.currentProvider}" not available — ` +
            `falling back to "${firstAvailable}"`,
        );
        this.currentProvider = firstAvailable;
      }
      logger.info(`Active AI provider: ${this.currentProvider}`);
      logger.info(
        `Available AI providers: ${[...this.providers.keys()].join(", ")}`,
      );
    }

    this._initialized = true;
  }

  /**
   * Get a specific provider instance.
   */
  getProvider(name) {
    if (!this._initialized) this.initialize();
    const provider = this.providers.get(name || this.currentProvider);
    if (!provider) {
      const err = new Error(
        `AI provider "${name || this.currentProvider}" is not configured. ` +
          `Available: ${[...this.providers.keys()].join(", ") || "none"}`,
      );
      err.code = "NO_PROVIDER";
      throw err;
    }
    return provider;
  }

  /**
   * Send a chat request through the active provider (with optional fallback).
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} options  { temperature, maxTokens, timeoutMs, model }
   * @returns {Promise<{content: string, usage?: object, provider: string}>}
   */
  async chat(messages, options = {}) {
    if (!this._initialized) this.initialize();

    const providersToTry = this.enableFallback
      ? this.fallbackOrder.filter((p) => this.providers.has(p))
      : [this.currentProvider];

    if (providersToTry.length === 0) {
      const err = new Error("No AI providers available");
      err.code = "NO_PROVIDER";
      throw err;
    }

    let lastError = null;
    const retries = aiConfig.maxRetries || 1;

    for (const providerName of providersToTry) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          logger.debug(`AI request → ${providerName} (attempt ${attempt})`);

          const timeoutMs = options.timeoutMs || aiConfig.requestTimeoutMs;
          const result = await this._withTimeout(
            provider.chat(messages, options),
            timeoutMs,
            providerName,
          );

          logger.debug(`AI response ← ${providerName}`, {
            contentLength: result.content?.length,
          });

          return result;
        } catch (err) {
          lastError = err;
          const isRetryable =
            err.code === "TIMEOUT" || err.status === 429 || err.status >= 500;
          logger.warn(
            `AI provider "${providerName}" failed (attempt ${attempt}/${retries})`,
            { error: err.message },
          );
          if (!isRetryable || attempt >= retries) break;
          // Brief back-off before retry
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }

      if (!this.enableFallback) break;
    }

    const error = new Error(lastError?.message || "All AI providers failed");
    error.code = lastError?.code || "AI_PROVIDER_ERROR";
    error.originalError = lastError;
    throw error;
  }

  /**
   * Race a promise against a timeout.
   */
  async _withTimeout(promise, ms, providerName) {
    if (!ms || ms <= 0) return promise;

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(
          `AI provider "${providerName}" timed out after ${ms}ms`,
        );
        err.code = "TIMEOUT";
        reject(err);
      }, ms);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Switch the active provider at runtime.
   */
  switchProvider(name) {
    if (!this._initialized) this.initialize();
    const normalized = name.toLowerCase().trim();
    if (!this.providers.has(normalized)) {
      throw new Error(
        `Provider "${name}" is not available. ` +
          `Available: ${[...this.providers.keys()].join(", ")}`,
      );
    }
    const previous = this.currentProvider;
    this.currentProvider = normalized;
    logger.info(`AI provider switched: ${previous} → ${normalized}`);
  }

  /**
   * Return current provider status for diagnostics.
   */
  getStatus() {
    if (!this._initialized) this.initialize();
    return {
      currentProvider: this.currentProvider,
      availableProviders: [...this.providers.keys()],
      fallbackEnabled: this.enableFallback,
      fallbackOrder: this.fallbackOrder,
    };
  }
}

// Export singleton
module.exports = new AIProviderManager();
