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

    const response = await this.client.messages.create({
      model: options.model || this.model,
      max_tokens: options.maxTokens ?? 4000,
      temperature: options.temperature ?? 0.7,
      system: systemMsg ? systemMsg.content : undefined,
      messages: nonSystemMessages,
    });

    const content = response.content?.[0]?.text;
    if (!content) {
      throw new Error("Claude returned an empty response");
    }

    return {
      content,
      usage: response.usage
        ? {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
            totalTokens:
              (response.usage.input_tokens || 0) +
              (response.usage.output_tokens || 0),
          }
        : undefined,
      provider: this.name,
    };
  }
}

module.exports = ClaudeProvider;
