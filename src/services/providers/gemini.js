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
      usage: response.usageMetadata
        ? {
            promptTokens: response.usageMetadata.promptTokenCount,
            completionTokens: response.usageMetadata.candidatesTokenCount,
            totalTokens: response.usageMetadata.totalTokenCount,
          }
        : undefined,
      provider: this.name,
    };
  }
}

module.exports = GeminiProvider;
