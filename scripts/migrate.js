#!/usr/bin/env node
/**
 * Idempotent schema migration for the AI document store.
 *
 * Run manually:      DATABASE_URL=... npm run migrate
 * Run at startup:    RUN_MIGRATIONS=true
 *
 * Safe to run repeatedly and from both services at once.
 */

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ai_documents (
     id                 char(24) PRIMARY KEY,
     content_hash       text,
     user_hash          text,
     filename           text,
     file_type          text,
     locator_type       text,
     total_units        int,
     meta               jsonb,
     embedding_provider text,
     embedding_model    text,
     embedding_dims     int,
     created_at         timestamptz NOT NULL DEFAULT now(),
     last_used_at       timestamptz NOT NULL DEFAULT now(),
     expires_at         timestamptz NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS ai_documents_content_hash_idx
     ON ai_documents (content_hash, user_hash)`,

  `CREATE INDEX IF NOT EXISTS ai_documents_expires_at_idx
     ON ai_documents (expires_at)`,

  `CREATE TABLE IF NOT EXISTS ai_document_units (
     doc_id     char(24) NOT NULL REFERENCES ai_documents(id) ON DELETE CASCADE,
     unit_index int      NOT NULL,
     label      text,
     text       text,
     PRIMARY KEY (doc_id, unit_index)
   )`,

  `CREATE TABLE IF NOT EXISTS ai_document_chunks (
     doc_id       char(24) NOT NULL REFERENCES ai_documents(id) ON DELETE CASCADE,
     chunk_id     int      NOT NULL,
     unit_indexes int[],
     text         text,
     embedding    real[],
     PRIMARY KEY (doc_id, chunk_id)
   )`,
];

/**
 * @param {string} databaseUrl
 * @returns {Promise<void>}
 */
async function migrate(databaseUrl) {
  const url = databaseUrl || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const { Pool } = require("pg");
  const { URL } = require("url");

  let ssl;
  try {
    const parsed = new URL(url);
    const sslmode = parsed.searchParams.get("sslmode");
    const isLocal = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    ssl = sslmode === "disable" || (isLocal && !sslmode) ? false : { rejectUnauthorized: false };
  } catch {
    ssl = undefined;
  }

  const pool = new Pool({ connectionString: url, max: 2, ssl });
  try {
    for (const statement of STATEMENTS) {
      await pool.query(statement);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  migrate()
    .then(() => {
      console.log("Migration complete: ai_documents, ai_document_units, ai_document_chunks");
      process.exit(0);
    })
    .catch((err) => {
      console.error(`Migration failed: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { migrate, STATEMENTS };
