/**
 * Document Store
 * Keeps extracted PDF data in memory with auto-expiry.
 * Documents expire after EXPIRY_MS to avoid memory leaks.
 *
 * For production at scale: replace with Redis or a database.
 */

const crypto = require("crypto");

const EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours

// In-memory store: docId → { pages, chunks, meta, expiresAt }
const store = new Map();

/** Generate a unique document ID */
function generateDocId() {
  return crypto.randomBytes(12).toString("hex");
}

/**
 * Save a processed document.
 * @param {{ pages, chunks, meta, filename }} docData
 * @returns {string} docId
 */
function saveDocument(docData) {
  const docId = generateDocId();
  const entry = {
    ...docData,
    createdAt: Date.now(),
    expiresAt: Date.now() + EXPIRY_MS,
  };

  store.set(docId, entry);
  return docId;
}

/**
 * Retrieve a document by ID.
 * Returns null if expired or not found.
 * @returns {Object|null}
 */
function getDocument(docId) {
  // Validate docId format to prevent abuse
  if (!/^[a-f0-9]{24}$/.test(docId)) return null;

  if (store.has(docId)) {
    const doc = store.get(docId);
    if (Date.now() > doc.expiresAt) {
      store.delete(docId);
      return null;
    }
    return doc;
  }

  return null;
}

/** Remove a document from store */
function deleteDocument(docId) {
  store.delete(docId);
}

/** Periodically purge expired in-memory entries */
setInterval(
  () => {
    const now = Date.now();
    for (const [id, doc] of store.entries()) {
      if (now > doc.expiresAt) store.delete(id);
    }
  },
  15 * 60 * 1000,
); // every 15 minutes

module.exports = { saveDocument, getDocument, deleteDocument };
