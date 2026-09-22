/**
 * Postgres-backed document store.
 *
 * Both Render services point at the same database, so a document uploaded to
 * one is readable on the other and survives a restart. Only extracted text,
 * units, chunks and embeddings are stored — never the original file.
 *
 * Embeddings live in a real[] column and are scored in Node: one document has
 * a few hundred chunks at most, which doesn't justify requiring pgvector.
 */

const { Pool } = require("pg");
const apiConfig = require("../config/apiConfig");
const logger = require("../utils/logger");

const {
  normalizeForSave,
  withLegacyViews,
  isValidDocId,
  generateDocId,
  canRead,
  StoreUnavailableError,
} = require("./docStore");

const INSERT_BATCH = 50;

function sslFor(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    return undefined;
  }
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode === "disable") return false;
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (isLocal && !sslmode) return false;
  // Managed Postgres (Render, Neon, Supabase) presents a certificate chain the
  // Node default trust store doesn't carry.
  return { rejectUnauthorized: false };
}

class PostgresDocStore {
  constructor(connectionString) {
    this.kind = "postgres";
    this.pool = new Pool({
      connectionString,
      max: apiConfig.documents.poolMax,
      ssl: sslFor(connectionString),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    this.pool.on("error", (err) => {
      logger.error("Postgres pool error", { error: err.message });
    });
  }

  isPersistent() {
    return true;
  }

  async _query(text, params) {
    try {
      return await this.pool.query(text, params);
    } catch (err) {
      throw new StoreUnavailableError(`Document store unavailable: ${err.message}`, err);
    }
  }

  /** ttl window, sliding but never past createdAt + DOC_MAX_TTL_DAYS. */
  _expiryExpression(createdAtParam) {
    const { ttlDays, maxTtlDays } = apiConfig.documents;
    return `LEAST(now() + interval '${ttlDays} days', ${createdAtParam} + interval '${maxTtlDays} days')`;
  }

  async saveDocument(docData) {
    const doc = normalizeForSave(docData);
    const docId = generateDocId();
    const { ttlDays } = apiConfig.documents;

    let client;
    try {
      client = await this.pool.connect();
    } catch (err) {
      throw new StoreUnavailableError(`Document store unavailable: ${err.message}`, err);
    }

    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO ai_documents
           (id, content_hash, user_hash, filename, file_type, locator_type,
            total_units, meta, embedding_provider, embedding_model, embedding_dims,
            created_at, last_used_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), now(),
                 now() + interval '${ttlDays} days')`,
        [
          docId,
          doc.contentHash,
          doc.userHash,
          doc.filename,
          doc.fileType,
          doc.locatorType,
          doc.totalUnits,
          JSON.stringify(doc.meta || {}),
          doc.embedding?.provider || null,
          doc.embedding?.model || null,
          doc.embedding?.dims || null,
        ],
      );

      for (let i = 0; i < doc.units.length; i += INSERT_BATCH) {
        const batch = doc.units.slice(i, i + INSERT_BATCH);
        const values = [];
        const params = [];
        batch.forEach((unit, n) => {
          const base = n * 4;
          values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4})`);
          params.push(docId, unit.index, unit.label, unit.text);
        });
        await client.query(
          `INSERT INTO ai_document_units (doc_id, unit_index, label, text)
           VALUES ${values.join(",")}`,
          params,
        );
      }

      for (let i = 0; i < doc.chunks.length; i += INSERT_BATCH) {
        const batch = doc.chunks.slice(i, i + INSERT_BATCH);
        const values = [];
        const params = [];
        batch.forEach((chunk, n) => {
          const base = n * 5;
          values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`);
          params.push(
            docId,
            chunk.chunkId,
            chunk.unitIndexes,
            chunk.text,
            chunk.embedding && chunk.embedding.length > 0 ? chunk.embedding : null,
          );
        });
        await client.query(
          `INSERT INTO ai_document_chunks (doc_id, chunk_id, unit_indexes, text, embedding)
           VALUES ${values.join(",")}`,
          params,
        );
      }

      await client.query("COMMIT");
      return docId;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* the connection is already broken */
      }
      throw new StoreUnavailableError(`Failed to save document: ${err.message}`, err);
    } finally {
      client.release();
    }
  }

  async getDocument(docId, { userHash } = {}) {
    if (!isValidDocId(docId)) return null;

    const docRes = await this._query(
      `SELECT id, content_hash, user_hash, filename, file_type, locator_type,
              total_units, meta, embedding_provider, embedding_model, embedding_dims,
              created_at, last_used_at, expires_at
         FROM ai_documents
        WHERE id = $1 AND expires_at > now()`,
      [docId],
    );
    if (docRes.rowCount === 0) return null;
    const row = docRes.rows[0];

    if (!canRead({ userHash: row.user_hash }, userHash)) return null;

    const [unitsRes, chunksRes] = await Promise.all([
      this._query(
        `SELECT unit_index, label, text FROM ai_document_units
          WHERE doc_id = $1 ORDER BY unit_index`,
        [docId],
      ),
      this._query(
        `SELECT chunk_id, unit_indexes, text, embedding FROM ai_document_chunks
          WHERE doc_id = $1 ORDER BY chunk_id`,
        [docId],
      ),
    ]);

    // Sliding expiry: using a document keeps it alive.
    this.touch(docId).catch((err) =>
      logger.warn(`Document touch failed: ${err.message}`),
    );

    return withLegacyViews({
      docId,
      filename: row.filename,
      fileType: row.file_type,
      locatorType: row.locator_type,
      totalUnits: row.total_units,
      units: unitsRes.rows.map((u) => ({
        index: u.unit_index,
        label: u.label,
        text: u.text || "",
      })),
      chunks: chunksRes.rows.map((c) => ({
        chunkId: c.chunk_id,
        text: c.text || "",
        unitIndexes: c.unit_indexes || [],
        embedding: c.embedding || null,
      })),
      meta: row.meta || {},
      embedding: row.embedding_provider
        ? {
            provider: row.embedding_provider,
            model: row.embedding_model,
            dims: row.embedding_dims,
          }
        : null,
      contentHash: row.content_hash,
      userHash: row.user_hash,
      createdAt: row.created_at?.getTime?.() ?? null,
      lastUsedAt: row.last_used_at?.getTime?.() ?? null,
      expiresAt: row.expires_at?.getTime?.() ?? null,
    });
  }

  async deleteDocument(docId) {
    if (!isValidDocId(docId)) return false;
    const res = await this._query(`DELETE FROM ai_documents WHERE id = $1`, [docId]);
    return res.rowCount > 0;
  }

  async findByContentHash(contentHash, userHash) {
    if (!contentHash) return null;
    const res = await this._query(
      `SELECT id FROM ai_documents
        WHERE content_hash = $1
          AND user_hash IS NOT DISTINCT FROM $2
          AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1`,
      [contentHash, userHash || null],
    );
    return res.rowCount > 0 ? res.rows[0].id : null;
  }

  async touch(docId) {
    if (!isValidDocId(docId)) return false;
    const res = await this._query(
      `UPDATE ai_documents
          SET last_used_at = now(),
              expires_at = ${this._expiryExpression("created_at")}
        WHERE id = $1`,
      [docId],
    );
    return res.rowCount > 0;
  }

  async purgeExpired() {
    const res = await this._query(`DELETE FROM ai_documents WHERE expires_at < now()`);
    if (res.rowCount > 0) {
      logger.info(`Purged ${res.rowCount} expired document(s)`);
    }
    return res.rowCount;
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = PostgresDocStore;
