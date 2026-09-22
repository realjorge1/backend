/**
 * Document Store
 *
 * Two implementations behind one async interface:
 *   MemoryDocStore    — used when DATABASE_URL is unset. Per-instance, expires
 *                       after 2 hours, lost on restart: today's behaviour.
 *   PostgresDocStore  — used when DATABASE_URL is set. Shared by both Render
 *                       services and survives restarts.
 *
 * Documents hold extracted text only: units, chunks and embeddings. Original
 * files are never stored.
 */

const crypto = require("crypto");
const apiConfig = require("../config/apiConfig");
const logger = require("../utils/logger");
const { locatorTypeFor, labelFor } = require("./locators");

const MEMORY_TTL_MS = 2 * 60 * 60 * 1000; // today's behaviour
const DOC_ID_PATTERN = /^[a-f0-9]{24}$/;

/** Thrown when the backing database can't be reached — a real outage. */
class StoreUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "StoreUnavailableError";
    this.code = "STORE_UNAVAILABLE";
    this.cause = cause;
  }
}

function generateDocId() {
  return crypto.randomBytes(12).toString("hex");
}

function isValidDocId(docId) {
  return typeof docId === "string" && DOC_ID_PATTERN.test(docId);
}

// ─── Normalization ───────────────────────────────────────────────────────────

/**
 * Accepts either the v2 shape ({ units, chunks, ... }) or the legacy shape
 * ({ pages, chunks, chunkEmbeddings, embeddingProvider, meta }) and produces
 * the canonical record both stores persist.
 */
function normalizeForSave(docData) {
  const meta = docData.meta || {};
  const fileType = docData.fileType || meta.fileType || "pdf";
  const locatorType = docData.locatorType || locatorTypeFor(fileType);

  let units = Array.isArray(docData.units) ? docData.units : null;
  if (!units) {
    const pages = Array.isArray(docData.pages) ? docData.pages : [];
    units = pages.map((p, i) => ({
      index: typeof p.page === "number" ? p.page : i + 1,
      label: labelFor(locatorType, typeof p.page === "number" ? p.page : i + 1, p.chapterTitle),
      text: p.text || "",
      wasOcr: Boolean(p.wasOcr),
    }));
  }
  units = units.map((u, i) => ({
    index: typeof u.index === "number" ? u.index : i + 1,
    label: u.label || labelFor(locatorType, typeof u.index === "number" ? u.index : i + 1, u.name),
    text: u.text || "",
    wasOcr: Boolean(u.wasOcr),
  }));

  // Embeddings may arrive alongside the chunks (legacy chunkEmbeddings) or
  // already attached to them.
  const embeddingByChunkId = new Map();
  if (Array.isArray(docData.chunkEmbeddings)) {
    for (const ce of docData.chunkEmbeddings) {
      if (ce && Array.isArray(ce.embedding) && ce.embedding.length > 0) {
        embeddingByChunkId.set(ce.chunkId, ce.embedding);
      }
    }
  }

  const chunks = (Array.isArray(docData.chunks) ? docData.chunks : []).map((c, i) => {
    const chunkId = typeof c.chunkId === "number" ? c.chunkId : i;
    const embedding =
      Array.isArray(c.embedding) && c.embedding.length > 0
        ? c.embedding
        : embeddingByChunkId.get(chunkId) || null;
    return {
      chunkId,
      text: c.text || "",
      unitIndexes: Array.isArray(c.unitIndexes)
        ? c.unitIndexes
        : Array.isArray(c.pages)
          ? c.pages
          : [],
      embedding,
    };
  });

  let embedding = docData.embedding || null;
  if (!embedding && docData.embeddingProvider && docData.embeddingProvider !== "none") {
    const dims = chunks.find((c) => c.embedding)?.embedding?.length || 0;
    embedding = dims
      ? { provider: docData.embeddingProvider, model: docData.embeddingModel || "", dims }
      : null;
  }
  // An embedding record is only meaningful if vectors actually landed.
  if (embedding && !chunks.some((c) => Array.isArray(c.embedding) && c.embedding.length > 0)) {
    embedding = null;
  }

  return {
    filename: docData.filename || meta.filename || "document",
    fileType,
    locatorType,
    totalUnits: units.length,
    units,
    chunks,
    meta: { ...meta, filename: docData.filename || meta.filename, fileType },
    embedding,
    contentHash: docData.contentHash || null,
    userHash: docData.userHash || null,
  };
}

/** Adds the legacy views the existing routes and services still read. */
function withLegacyViews(doc) {
  if (!doc) return null;
  const pages = doc.units.map((u) => ({
    page: u.index,
    text: u.text,
    wasOcr: Boolean(u.wasOcr),
    charCount: (u.text || "").length,
  }));
  const chunks = doc.chunks.map((c) => ({
    chunkId: c.chunkId,
    text: c.text,
    pages: c.unitIndexes,
    unitIndexes: c.unitIndexes,
    embedding: c.embedding,
  }));
  return {
    ...doc,
    pages,
    chunks,
    chunkEmbeddings: chunks,
    embeddingProvider: doc.embedding?.provider || "none",
  };
}

// ─── Memory store ────────────────────────────────────────────────────────────

class MemoryDocStore {
  constructor() {
    this.store = new Map();
    this.kind = "memory";
  }

  isPersistent() {
    return false;
  }

  async saveDocument(docData) {
    const docId = generateDocId();
    const now = Date.now();
    const record = {
      ...normalizeForSave(docData),
      docId,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + MEMORY_TTL_MS,
    };
    this.store.set(docId, record);
    return docId;
  }

  async getDocument(docId, { userHash } = {}) {
    if (!isValidDocId(docId)) return null;
    const doc = this.store.get(docId);
    if (!doc) return null;
    if (Date.now() > doc.expiresAt) {
      this.store.delete(docId);
      return null;
    }
    if (!canRead(doc, userHash)) return null;
    doc.lastUsedAt = Date.now();
    doc.expiresAt = Date.now() + MEMORY_TTL_MS;
    return withLegacyViews(doc);
  }

  async deleteDocument(docId) {
    if (!isValidDocId(docId)) return false;
    return this.store.delete(docId);
  }

  async findByContentHash(contentHash, userHash) {
    if (!contentHash) return null;
    const now = Date.now();
    for (const [docId, doc] of this.store.entries()) {
      if (doc.contentHash !== contentHash) continue;
      if ((doc.userHash || null) !== (userHash || null)) continue;
      if (now > doc.expiresAt) continue;
      return docId;
    }
    return null;
  }

  async touch(docId) {
    const doc = this.store.get(docId);
    if (!doc) return false;
    doc.lastUsedAt = Date.now();
    doc.expiresAt = Date.now() + MEMORY_TTL_MS;
    return true;
  }

  async purgeExpired() {
    const now = Date.now();
    let removed = 0;
    for (const [docId, doc] of this.store.entries()) {
      if (now > doc.expiresAt) {
        this.store.delete(docId);
        removed++;
      }
    }
    return removed;
  }

  async close() {
    this.store.clear();
  }
}

/**
 * In enforce mode a document that was saved with an owner is readable only by
 * that owner. Documents saved without a user stay readable by anyone holding
 * the docId, exactly as before.
 */
function canRead(doc, userHash) {
  if (apiConfig.authMode !== "enforce") return true;
  if (!doc.userHash) return true;
  return doc.userHash === userHash;
}

// ─── Store selection ─────────────────────────────────────────────────────────

let activeStore = null;

function getStore() {
  if (activeStore) return activeStore;

  if (apiConfig.documents.databaseUrl) {
    const PostgresDocStore = require("./postgresDocStore");
    activeStore = new PostgresDocStore(apiConfig.documents.databaseUrl);
    logger.info("Document store: postgres (shared across instances)");
  } else {
    activeStore = new MemoryDocStore();
    logger.warn(
      "Document store: in-memory. DATABASE_URL is not set, so a document " +
        "uploaded to one server will be missing on the other, and every " +
        "document is lost on restart.",
    );
  }
  return activeStore;
}

/** Test seam: swap in a specific store. */
function _setStore(store) {
  activeStore = store;
}

const purgeTimer = setInterval(() => {
  getStore()
    .purgeExpired()
    .catch((err) => logger.warn(`Document purge failed: ${err.message}`));
}, apiConfig.documents.purgeIntervalMs);
purgeTimer.unref();

module.exports = {
  saveDocument: (docData) => getStore().saveDocument(docData),
  getDocument: (docId, opts) => getStore().getDocument(docId, opts),
  deleteDocument: (docId) => getStore().deleteDocument(docId),
  findByContentHash: (hash, userHash) => getStore().findByContentHash(hash, userHash),
  touch: (docId) => getStore().touch(docId),
  purgeExpired: () => getStore().purgeExpired(),
  isPersistent: () => getStore().isPersistent(),
  close: () => (activeStore ? activeStore.close() : Promise.resolve()),

  MemoryDocStore,
  StoreUnavailableError,
  normalizeForSave,
  withLegacyViews,
  isValidDocId,
  generateDocId,
  canRead,
  _setStore,
};
