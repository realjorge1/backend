/**
 * Document Chat Service
 * Multi-turn conversational RAG over a stored document.
 */

const aiProvider = require("./aiProvider");
const aiConfig = require("../config/aiConfig");
const { retrieveForQuestion, buildContext } = require("./retrieval");
const logger = require("../utils/logger");

const MAX_HISTORY_MESSAGES = 10;

/**
 * Chat models are configured per provider. CLAUDE_CHAT_MODEL is a Claude
 * model id, so passing it to OpenAI or Gemini would be a guaranteed error —
 * only send it when Claude is actually the active provider.
 */
function chatModelFor(provider) {
  return provider === "claude" ? aiConfig.claude.chatModel : undefined;
}

/**
 * Answer a question about a stored document.
 *
 * @param {string} question
 * @param {object} doc      stored document (units, chunks, meta, embedding)
 * @param {Array<{role, content}>} history
 * @returns {Promise<{answer, citations, found, retrievedChunks, retrieval}>}
 */
async function chatWithDocument(question, doc, history = []) {
  const retrieved = await retrieveForQuestion(doc, question);
  const context = buildContext(retrieved.chunks);

  const messages = [{ role: "system", content: buildChatSystemPrompt(doc.meta || {}) }];

  for (const msg of (history || []).slice(-MAX_HISTORY_MESSAGES)) {
    if (msg.role && msg.content) {
      messages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    }
  }

  messages.push({ role: "user", content: buildContextualQuestion(question, context) });

  try {
    const result = await aiProvider.chat(messages, {
      temperature: 0.3,
      maxTokens: 1500,
      model: chatModelFor(aiProvider.currentProvider),
    });

    const parsed = parseResponse(result.content);
    return {
      ...parsed,
      usage: result.usage,
      provider: result.provider,
      retrieval: {
        mode: retrieved.mode,
        embeddingProvider: retrieved.embeddingProvider,
      },
      retrievedChunks: retrieved.chunks.map((c) => ({
        chunkId: c.chunkId,
        pages: c.unitIndexes || c.pages || [],
        score: c.score,
        preview: c.text.slice(0, 150),
      })),
    };
  } catch (err) {
    logger.error("[docChat] LLM call failed:", { error: err.message });
    throw err;
  }
}

// ─── Prompt Construction ────────────────────────────────────────────────────

function buildChatSystemPrompt(meta) {
  const docType = meta.fileType || "document";
  const pageLabel = docType === "epub" ? "chapter" : "page";

  return `You are a knowledgeable document assistant having a conversation about a ${docType}.

RULES:
1. Answer questions ONLY using the document content provided in each message.
2. Cite specific ${pageLabel}(s) using the format: (${pageLabel === "chapter" ? "Chapter" : "Page"} N).
3. If the document doesn't contain the answer, say: "I couldn't find information about that in this document."
4. If you find partial information, explain what the document does contain.
5. Never invent or hallucinate information not in the document.
6. You can reference previous parts of the conversation naturally.
7. Quote relevant passages when helpful using "..." for omissions.
8. Be concise but thorough. Use bullet points for lists.

Document: "${meta.filename || "Untitled"}" — ${meta.totalPages || "?"} ${pageLabel}s${meta.hasScannedContent ? " (some pages were OCR-processed)" : ""}.`;
}

function buildContextualQuestion(question, context) {
  return `Relevant document sections:
---
${context}
---

Question: ${question}`;
}

function parseResponse(rawAnswer) {
  try {
    let jsonStr = rawAnswer;
    const jsonMatch = rawAnswer.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) jsonStr = jsonMatch[1];

    const parsed = JSON.parse(jsonStr);
    if (parsed.answer) {
      return {
        answer: parsed.answer,
        citations: parsed.citations || [],
        found: parsed.found !== false,
      };
    }
  } catch {
    // Not JSON — plain text is fine.
  }

  const citations = [];
  const citationRegex = /\((?:Page|Chapter)\s+(\d+)\)/gi;
  let match;
  while ((match = citationRegex.exec(rawAnswer)) !== null) {
    const pageNum = parseInt(match[1], 10);
    if (!citations.some((c) => c.page === pageNum)) {
      citations.push({ page: pageNum, quote: "" });
    }
  }

  return {
    answer: rawAnswer,
    citations,
    found: !rawAnswer.toLowerCase().includes("couldn't find information"),
  };
}

module.exports = { chatWithDocument, chatModelFor };
