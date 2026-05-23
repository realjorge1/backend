/**
 * Document Chat Service
 * Handles multi-turn conversational RAG for documents.
 * Combines embedding-based retrieval with conversation history.
 */

const aiProvider = require("./aiProvider");
const aiConfig = require("../config/aiConfig");
const {
  generateEmbeddings,
  generateSingleEmbedding,
} = require("./embeddingService");
const { hybridSearch } = require("./vectorStore");
const logger = require("../utils/logger");

const MAX_CHUNKS_PER_QUERY = 6;
const MAX_CONTEXT_CHARS = 14000;
const MAX_HISTORY_MESSAGES = 10;

/**
 * Process a document's chunks by generating embeddings for them.
 * Returns chunks with their embeddings attached.
 *
 * @param {Array<{chunkId, text, pages}>} chunks
 * @returns {Promise<{chunkEmbeddings: Array, embeddingProvider: string}>}
 */
async function embedDocumentChunks(chunks) {
  if (!chunks || chunks.length === 0) {
    return { chunkEmbeddings: [], embeddingProvider: "none" };
  }

  const texts = chunks.map((c) => c.text);
  const { embeddings, provider } = await generateEmbeddings(texts);

  const chunkEmbeddings = chunks.map((chunk, idx) => ({
    ...chunk,
    embedding: embeddings[idx] || [],
  }));

  logger.info(
    `[docChat] Embedded ${chunkEmbeddings.length} chunks via ${provider}`,
  );

  return { chunkEmbeddings, embeddingProvider: provider };
}

/**
 * Answer a question about a document using RAG with conversation history.
 *
 * @param {string} question - Current user question
 * @param {Array<{chunkId, text, pages, embedding}>} chunkEmbeddings - Pre-embedded chunks
 * @param {Object} meta - Document metadata
 * @param {Array<{role, content}>} history - Previous conversation messages
 * @param {string} embeddingProvider - Which provider generated the embeddings
 * @returns {Promise<{answer: string, citations: Array, found: boolean}>}
 */
async function chatWithDocument(
  question,
  chunkEmbeddings,
  meta,
  history = [],
  embeddingProvider = "local",
) {
  // 1. Generate embedding for the question
  const { embedding: queryEmbedding } = await generateSingleEmbedding(question);

  // 2. Retrieve relevant chunks using hybrid search
  const relevantChunks = hybridSearch(
    question,
    queryEmbedding,
    chunkEmbeddings,
    MAX_CHUNKS_PER_QUERY,
  );

  // 3. Build context from retrieved chunks
  const context = buildContext(relevantChunks, MAX_CONTEXT_CHARS);

  // 4. Build conversation messages
  const systemPrompt = buildChatSystemPrompt(meta);
  const messages = [{ role: "system", content: systemPrompt }];

  // Add trimmed conversation history
  const trimmedHistory = (history || []).slice(-MAX_HISTORY_MESSAGES);
  for (const msg of trimmedHistory) {
    if (msg.role && msg.content) {
      messages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    }
  }

  // Add current question with context
  const userMessage = buildContextualQuestion(question, context);
  messages.push({ role: "user", content: userMessage });

  // 5. Call LLM
  try {
    const result = await aiProvider.chat(messages, {
      temperature: 0.3,
      maxTokens: 1500,
      model: aiConfig.claude.chatModel,
    });

    // 6. Parse and return the response
    const parsed = parseResponse(result.content);
    return {
      ...parsed,
      retrievedChunks: relevantChunks.map((c) => ({
        chunkId: c.chunkId,
        pages: c.pages,
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

function buildContext(chunks, maxChars) {
  let context = "";
  for (const chunk of chunks) {
    const snippet = chunk.text;
    if (context.length + snippet.length > maxChars) {
      // Add as much as we can
      const remaining = maxChars - context.length - 10;
      if (remaining > 200) {
        context += snippet.slice(0, remaining) + "...\n\n---\n\n";
      }
      break;
    }
    context += snippet + "\n\n---\n\n";
  }
  return context.trim();
}

function parseResponse(rawAnswer) {
  // Try to parse structured response if the LLM returns JSON
  try {
    let jsonStr = rawAnswer;
    const jsonMatch = rawAnswer.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    const parsed = JSON.parse(jsonStr);
    if (parsed.answer) {
      return {
        answer: parsed.answer,
        citations: parsed.citations || [],
        found: parsed.found !== false,
      };
    }
  } catch {
    // Not JSON — that's fine, use plain text
  }

  // Extract inline citations from plain text: "(Page N)" or "(Chapter N)"
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

module.exports = { embedDocumentChunks, chatWithDocument };
