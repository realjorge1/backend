const OpenAI = require("openai");

class OpenAIProvider {
  constructor(config) {
    if (!config.apiKey) {
      throw new Error("OpenAI API key is required");
    }
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model;
    this.name = "openai";
  }

  /**
   * Send a chat completion request.
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} options  { temperature, maxTokens, model }
   * @returns {Promise<{content: string, usage?: object, provider: string}>}
   */
  async chat(messages, options = {}) {
    const response = await this.client.chat.completions.create(
      {
        model: options.model || this.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4000,
      },
      options.signal ? { signal: options.signal } : undefined,
    );

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI returned an empty response");
    }

    return {
      content,
      usage: usageFrom(response.usage),
      stopReason: normalizeStopReason(response.choices?.[0]?.finish_reason),
      provider: this.name,
    };
  }

  /**
   * Stream a reply, forwarding text as it arrives.
   * @param {object} handlers { signal, onText }
   */
  async chatStream(messages, options = {}, { signal, onText } = {}) {
    const stream = await this.client.chat.completions.create(
      {
        model: options.model || this.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4000,
        stream: true,
        stream_options: { include_usage: true },
      },
      signal ? { signal } : undefined,
    );

    let content = "";
    let usage;
    let finishReason;

    for await (const part of stream) {
      const delta = part.choices?.[0]?.delta?.content;
      if (delta) {
        content += delta;
        if (onText) onText(delta);
      }
      if (part.choices?.[0]?.finish_reason) finishReason = part.choices[0].finish_reason;
      if (part.usage) usage = part.usage;
    }

    return {
      content,
      usage: usageFrom(usage),
      stopReason: normalizeStopReason(finishReason),
      provider: this.name,
    };
  }
}

function usageFrom(usage) {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

/** OpenAI calls a truncated reply "length". */
function normalizeStopReason(reason) {
  if (reason === "length") return "max_tokens";
  return reason || "end_turn";
}

module.exports = OpenAIProvider;
