/**
 * AI Q&A over a stored document — the /ask-pdf path.
 *
 * Shares retrieval, prompting and citation verification with /chat-document,
 * so both return the same, checked citation shape. The only difference is
 * that this route is single-turn.
 */

const { chatWithDocument } = require("./documentChatService");

/**
 * @param {string} question
 * @param {object} doc  stored document (units, chunks, meta, embedding)
 * @returns {Promise<{answer, citations, found, retrieval, format, retrievedChunks}>}
 */
async function askPdf(question, doc) {
  return chatWithDocument(question, doc, []);
}

module.exports = { askPdf };
