const { GoogleGenerativeAI } = require("@google/generative-ai");

class GeminiProvider {
  constructor(config) {
    if (!config.apiKey) {
      throw new Error("Gemini API key is required");
    }
    this.genAI = new GoogleGenerativeAI(config.apiKey);
    this.modelName = config.model;
    this.name = "gemini";
  }

  /**
   * Send a chat request via Gemini.
   * Handles system instructions separately (Gemini-specific).
   * Uses generateContent for single-turn, startChat for multi-turn.
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} options  { temperature, maxTokens, model }
   * @returns {Promise<{content: string, usage?: object, provider: string}>}
   */
  async chat(messages, options = {}) {
    // Extract system message — Gemini uses systemInstruction param
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    if (nonSystemMessages.length === 0) {
      throw new Error("At least one non-system message is required");
    }

    const model = this.genAI.getGenerativeModel({
      model: options.model || this.modelName,
      systemInstruction: systemMsg ? systemMsg.content : undefined,
    });

    const generationConfig = {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens ?? 4000,
    };

    let result;

    if (nonSystemMessages.length === 1) {
      // Single-turn — use generateContent directly (faster)
      result = await model.generateContent({
        contents: [
          {
            role: "user",
            parts: [{ text: nonSystemMessages[0].content }],
          },
        ],
        generationConfig,
      });
    } else {
      // Multi-turn — use startChat with history
      const history = nonSystemMessages.slice(0, -1).map((msg) => ({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      }));

      const chat = model.startChat({ history, generationConfig });
      const lastMsg = nonSystemMessages[nonSystemMessages.length - 1];
      result = await chat.sendMessage(lastMsg.content);
    }

    const response = result.response;
    const text = response.text();

    return {
      content: text,
      usage: usageFrom(response.usageMetadata),
      stopReason: normalizeStopReason(response.candidates?.[0]?.finishReason),
      provider: this.name,
    };
  }

  /**
   * Stream a reply, forwarding text as it arrives.
   * @param {object} handlers { signal, onText }
   */
  async chatStream(messages, options = {}, { signal, onText } = {}) {
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    if (nonSystemMessages.length === 0) {
      throw new Error("At least one non-system message is required");
    }

    const model = this.genAI.getGenerativeModel({
      model: options.model || this.modelName,
      systemInstruction: systemMsg ? systemMsg.content : undefined,
    });

    const generationConfig = {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens ?? 4000,
    };

    const result = await model.generateContentStream({
      contents: nonSystemMessages.map((msg) => ({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      })),
      generationConfig,
    });

    let content = "";
    for await (const chunk of result.stream) {
      if (signal?.aborted) {
        const err = new Error("Request aborted");
        err.name = "AbortError";
        throw err;
      }
      const text = typeof chunk.text === "function" ? chunk.text() : "";
      if (text) {
        content += text;
        if (onText) onText(text);
      }
    }

    const response = await result.response;
    return {
      content,
      usage: usageFrom(response.usageMetadata),
      stopReason: normalizeStopReason(response.candidates?.[0]?.finishReason),
      provider: this.name,
    };
  }
}

function usageFrom(usageMetadata) {
  if (!usageMetadata) return undefined;
  return {
    promptTokens: usageMetadata.promptTokenCount,
    completionTokens: usageMetadata.candidatesTokenCount,
    totalTokens: usageMetadata.totalTokenCount,
  };
}

/** Gemini reports MAX_TOKENS in upper case. */
function normalizeStopReason(reason) {
  if (reason === "MAX_TOKENS") return "max_tokens";
  return reason ? String(reason).toLowerCase() : "end_turn";
}

module.exports = GeminiProvider;
