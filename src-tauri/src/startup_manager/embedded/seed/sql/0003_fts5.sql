-- B-001: Create FTS5 full-text search index
-- Version: 3
-- Purpose: Enable efficient full-text search on symbol names and content
-- Mirror: src/index-service/internal/migrations/0003_fts5.sql
-- Per Spec §10 and TRP §4 Functional Requirements

-- Create FTS5 virtual table for full-text search
-- Uses external content table pattern: fts5(columns, content='node', content_rowid='rowid')
-- This allows FTS5 to search node table content without duplicating it
CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
  -- Indexed columns from node table
  title,                            -- Symbol name/title (primary search field)
  body_md,                          -- Content in markdown (searchable body)
  
  -- FTS5 configuration for external content
  content='node',                   -- Points to source table
  content_rowid='rowid',            -- Maps to internal rowid of node table
  
  -- FTS5 tokenizer: porter stemmer for better fuzzy matching
  tokenize = 'porter'
);

-- External-content FTS5 maintenance triggers.
-- For content='node', regular UPDATE/DELETE against the FTS table corrupts
-- the index. Use the special-keyword INSERT shadow pattern instead.

CREATE TRIGGER IF NOT EXISTS node_fts_insert AFTER INSERT ON node BEGIN
  INSERT INTO node_fts(rowid, title, body_md)
  VALUES (NEW.rowid, NEW.title, NEW.body_md);
END;

CREATE TRIGGER IF NOT EXISTS node_fts_update AFTER UPDATE ON node BEGIN
  INSERT INTO node_fts(node_fts, rowid, title, body_md)
  VALUES('delete', OLD.rowid, OLD.title, OLD.body_md);
  INSERT INTO node_fts(rowid, title, body_md)
  VALUES (NEW.rowid, NEW.title, NEW.body_md);
END;

CREATE TRIGGER IF NOT EXISTS node_fts_delete AFTER DELETE ON node BEGIN
  INSERT INTO node_fts(node_fts, rowid, title, body_md)
  VALUES('delete', OLD.rowid, OLD.title, OLD.body_md);
END;

-- Record migration
INSERT OR IGNORE INTO schema_migrations (version, description, checksum)
VALUES ('0003', 'Create FTS5 full-text search index on nodes', 'fts5-v1');
