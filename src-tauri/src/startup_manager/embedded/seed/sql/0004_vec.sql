-- B-001: Create sqlite-vec tables for vector embeddings
-- Version: 4
-- Purpose: Enable semantic search on code via vector embeddings (384-dim, locked to Xenova/bge-small-en-v1.5)
-- Mirror: src/index-service/internal/migrations/0004_vec.sql
-- Per Spec §10, TRP §4, and TRP §6.6 (embedding dimension locked at 384)

-- Load sqlite-vec extension (must be loaded before using vec0 tables)
-- Note: Extension loading happens at runtime in the application; this SQL assumes it's already loaded

-- Create node vector embedding table using vec0 virtual table
-- Locked to 384 dimensions per Spec §6.6 (matches Xenova/bge-small-en-v1.5)
CREATE VIRTUAL TABLE IF NOT EXISTS node_vec USING vec0(
  node_id TEXT PRIMARY KEY,         -- Foreign key to node.id
  embedding FLOAT[384]              -- 384-dimensional vector embedding (locked dimension)
);

-- vec0 already maintains an internal index on the PRIMARY KEY column.
-- SQLite forbids CREATE INDEX on virtual tables.

-- Create edge vector embedding table (optional, for relationship semantic search)
CREATE VIRTUAL TABLE IF NOT EXISTS edge_vec USING vec0(
  edge_id TEXT PRIMARY KEY,         -- Foreign key to edge (src_id || '|' || predicate || '|' || dst_id)
  embedding FLOAT[384]              -- 384-dimensional vector embedding
);

-- Create embedding metadata table to track embedding model versions
CREATE TABLE IF NOT EXISTS embedding_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  embedding_model TEXT NOT NULL UNIQUE,  -- Model name (e.g., Xenova/bge-small-en-v1.5)
  embedding_dim INTEGER NOT NULL DEFAULT 384,  -- Dimension (locked at 384)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert embedding model metadata (idempotent)
INSERT OR IGNORE INTO embedding_metadata (embedding_model, embedding_dim)
VALUES ('Xenova/bge-small-en-v1.5', 384);

-- Record migration
INSERT OR IGNORE INTO schema_migrations (version, description, checksum)
VALUES ('0004', 'Create sqlite-vec tables for semantic embeddings (384-dim)', 'vec-v1');
