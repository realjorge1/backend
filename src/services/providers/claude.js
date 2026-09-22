const Anthropic = require("@anthropic-ai/sdk");

class ClaudeProvider {
  constructor(config) {
    if (!config.apiKey) {
      throw new Error("Anthropic/Claude API key is required");
    }
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model;
    this.name = "claude";
  }

  /**
   * Send a chat request via Anthropic Claude.
   * System messages are extracted and passed via the dedicated `system` param.
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} options  { temperature, maxTokens, model }
   * @returns {Promise<{content: string, usage?: object, provider: string}>}
   */
  async chat(messages, options = {}) {
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages
      .filter((m) => m.role !== "system")
      .map((msg) => ({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      }));

    if (nonSystemMessages.length === 0) {
      throw new Error("At least one non-system message is required");
    }

    const response = await this.client.messages.create(
      {
        model: options.model || this.model,
        max_tokens: options.maxTokens ?? 4000,
        temperature: options.temperature ?? 0.7,
        system: systemMsg ? systemMsg.content : undefined,
        messages: nonSystemMessages,
      },
      options.signal ? { signal: options.signal } : undefined,
    );

    // A reply can arrive as several text blocks (notably when citations are
    // enabled). Taking content[0] alone silently dropped the rest.
    const content = joinTextBlocks(response.content);
    if (!content) {
      throw new Error("Claude returned an empty response");
    }

    return {
      content,
      usage: usageFrom(response.usage),
      stopReason: normalizeStopReason(response.stop_reason),
      provider: this.name,
    };
  }

  /**
   * Stream a reply, forwarding text as it arrives.
   *
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} options  { temperature, maxTokens, model }
   * @param {object} handlers { signal, onText }
   * @returns {Promise<{content, usage, stopReason, provider}>}
   */
  async chatStream(messages, options = {}, { signal, onText } = {}) {
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages
      .filter((m) => m.role !== "system")
      .map((msg) => ({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      }));

    if (nonSystemMessages.length === 0) {
      throw new Error("At least one non-system message is required");
    }

    const stream = this.client.messages.stream(
      {
        model: options.model || this.model,
        max_tokens: options.maxTokens ?? 4000,
        temperature: options.temperature ?? 0.7,
        system: systemMsg ? systemMsg.content : undefined,
        messages: nonSystemMessages,
      },
      signal ? { signal } : undefined,
    );

    if (onText) stream.on("text", (text) => onText(text));

    const final = await stream.finalMessage();

    return {
      content: joinTextBlocks(final.content),
      usage: usageFrom(final.usage),
      stopReason: normalizeStopReason(final.stop_reason),
      provider: this.name,
    };
  }
}

function joinTextBlocks(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function usageFrom(usage) {
  if (!usage) return undefined;
  return {
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
  };
}

/** "max_tokens" means the reply was cut off and the caller must react. */
function normalizeStopReason(reason) {
  if (reason === "max_tokens") return "max_tokens";
  return reason || "end_turn";
}

module.exports = ClaudeProvider;
