/**
 * AI Q&A over a stored document — the /ask-pdf path.
 *
 * Shares one retrieval function with /chat-document and quiz generation, so
 * all three see the same chunks for the same question.
 */

const aiProvider = require("./aiProvider");
const { retrieveForQuestion, buildContext } = require("./retrieval");
const logger = require("../utils/logger");

/**
 * @param {string} question
 * @param {object} doc  stored document (chunks, meta, embedding)
 * @returns {Promise<{answer, citations, found, retrieval, retrievedChunks}>}
 */
async function askPdf(question, doc) {
  const retrieved = await retrieveForQuestion(doc, question);
  const context = buildContext(retrieved.chunks);

  const messages = [
    { role: "system", content: buildSystemPrompt(doc.meta || {}) },
    { role: "user", content: buildUserMessage(question, context) },
  ];

  try {
    const result = await aiProvider.chat(messages, {
      temperature: 0.2, // factual, not creative
      maxTokens: 1000,
    });

    return {
      ...parseAnswer(result.content),
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
    logger.error("[aiQa] LLM call failed:", { error: err.message });
    throw err;
  }
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
    let jsonStr = rawAnswer;
    const jsonMatch = rawAnswer.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) jsonStr = jsonMatch[1];

    const parsed = JSON.parse(jsonStr);
    return {
      answer: parsed.answer || rawAnswer,
      citations: parsed.citations || [],
      found: parsed.found !== false,
    };
  } catch {
    return { answer: rawAnswer, citations: [], found: true };
  }
}

module.exports = { askPdf };
