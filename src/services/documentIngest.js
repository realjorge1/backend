/**
 * Document Ingestion
 *
 * The single pipeline behind POST /extract-pdf and POST /extract-document:
 *
 *   bytes → units (pages / slides / sheets / chapters / sections)
 *         → chunks (with unit anchors)
 *         → embeddings (when an embeddings provider is configured)
 *         → document store
 *
 * Per-format parsing lives in documentExtractors.js.
 */

const logger = require("../utils/logger");
const { chunkUnits } = require("./textCleaner");
const { saveDocument, getDocument, isPersistent } = require("./docStore");
const { extractUnits } = require("./documentExtractors");
const { embedChunks } = require("./embeddingService");

/**
 * @param {object} input
 *   buffer      — raw uploaded bytes
 *   filename    — original file name
 *   ext         — lower-case extension including the dot
 *   mimeType    — lower-case mime type
 *   contentHash — sha256 of the bytes
 *   userHash    — hashed owner, or null
 * @returns {Promise<object>} the stored document, with `persisted`
 */
async function ingestDocument({ buffer, filename, ext, mimeType, contentHash, userHash }) {
  const { units, meta, fileType, locatorType } = await extractUnits({
    buffer,
    filename,
    ext,
    mimeType,
  });

  const chunks = chunkUnits(units);

  let embedded = chunks;
  let embedding = null;
  try {
    const result = await embedChunks(chunks);
    embedded = result.chunks;
    embedding = result.embedding;
  } catch (err) {
    // A document that can't be embedded is still perfectly usable through
    // keyword retrieval — never fail ingestion over it.
    logger.warn("[ingest] Embedding failed; storing in keyword mode", {
      error: err.message,
    });
  }

  const docId = await saveDocument({
    filename,
    fileType,
    locatorType,
    units,
    chunks: embedded,
    meta,
    embedding,
    contentHash,
    userHash,
  });

  const stored = await getDocument(docId, { userHash });
  return { ...stored, persisted: isPersistent() };
}

module.exports = { ingestDocument };
