/**
 * AI Q&A Service for PDF Documents
 * Sends relevant PDF chunks to the LLM and returns an answer with page citations.
 *
 * Uses the existing aiProvider infrastructure for LLM calls,
 * so it works with whichever provider is configured (OpenAI, Gemini, Claude, etc.).
 */

const aiProvider = require("./aiProvider");
const logger = require("../utils/logger");

// How many chunks to send per question (context window budget)
const MAX_CHUNKS_PER_QUERY = 6;
const MAX_CONTEXT_CHARS = 12000;

/**
 * Answer a question using extracted PDF chunks.
 *
 * @param {string} question - User's question
 * @param {Array<{chunkId, text, pages}>} chunks - All chunks from the document
 * @param {Object} meta - Document metadata
 * @returns {Promise<{ answer: string, citations: Array<{page, quote}>, found: boolean }>}
 */
async function askPdf(question, chunks, meta) {
  // 1. Select the most relevant chunks (simple keyword relevance score)
  const relevantChunks = selectRelevantChunks(
    question,
    chunks,
    MAX_CHUNKS_PER_QUERY,
  );

  // 2. Build the context string
  const context = buildContext(relevantChunks, MAX_CONTEXT_CHARS);

  // 3. Build the messages
  const systemPrompt = buildSystemPrompt(meta);
  const userMessage = buildUserMessage(question, context);

  // 4. Call LLM through existing provider infrastructure
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  try {
    const result = await aiProvider.chat(messages, {
      temperature: 0.2, // Low temperature for factual accuracy
      maxTokens: 1000,
    });

    // 5. Parse out citations from the response
    return parseAnswer(result.content);
  } catch (err) {
    logger.error("[aiQa] LLM call failed:", { error: err.message });
    throw err;
  }
}

/**
 * Select chunks most relevant to the question using a simple TF-style keyword score.
 */
function selectRelevantChunks(question, chunks, maxChunks) {
  const questionWords = tokenize(question);

  const scored = chunks.map((chunk) => {
    const chunkWords = tokenize(chunk.text);
    const score = questionWords.reduce((acc, word) => {
      return acc + chunkWords.filter((w) => w === word).length;
    }, 0);
    return { ...chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Always include first chunk (document intro/context)
  const top = scored.slice(0, maxChunks);
  const hasFirstChunk = top.some((c) => c.chunkId === 0);
  if (!hasFirstChunk && chunks.length > 0) {
    top[top.length - 1] = { ...chunks[0], score: 0 };
  }

  // Re-sort by original document order for coherent reading
  top.sort((a, b) => a.chunkId - b.chunkId);
  return top;
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function buildContext(chunks, maxChars) {
  let context = "";
  for (const chunk of chunks) {
    if (context.length + chunk.text.length > maxChars) break;
    context += chunk.text + "\n\n---\n\n";
  }
  return context.trim();
}

function buildSystemPrompt(meta) {
  return `You are a helpful assistant that answers questions about a PDF document.

RULES:
1. Base your answer ONLY on the provided document content.
2. Always cite the page number(s) your answer comes from using the format: (Page N).
3. If the answer spans multiple pages, cite all of them.
4. If the document does not contain the answer, say exactly: "I couldn't find information about that in this document."
5. If you find partial information, say: "The document partially addresses this on page N..." and explain what it does contain.
6. Never make up information.
7. Quote relevant short passages when helpful, using "..." to indicate omissions.

Document info: ${meta.totalPages} pages total${meta.hasScannedContent ? ", some pages were OCR-processed" : ""}.

Return your response as a JSON object with this exact structure:
{
  "answer": "your answer text with (Page N) inline citations",
  "citations": [
    { "page": 5, "quote": "brief supporting quote from that page" }
  ],
  "found": true
}`;
}

function buildUserMessage(question, context) {
  return `Document content:
${context}

Question: ${question}`;
}

function parseAnswer(rawAnswer) {
  try {
    // Try to extract JSON from the response (may be wrapped in markdown code blocks)
    let jsonStr = rawAnswer;
    const jsonMatch = rawAnswer.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    const parsed = JSON.parse(jsonStr);
    return {
      answer: parsed.answer || rawAnswer,
      citations: parsed.citations || [],
      found: parsed.found !== false,
    };
  } catch {
    // If LLM didn't return valid JSON, return plain text
    return {
      answer: rawAnswer,
      citations: [],
      found: true,
    };
  }
}

module.exports = { askPdf };
