-- B-001: Initialize SQLite database with WAL mode and system tables
-- Version: 1
-- Purpose: Set up foundational database configuration and metadata
-- Mirror: src/index-service/internal/migrations/0001_init.sql

-- Enable WAL mode for better concurrency (readers don't block writers)
PRAGMA journal_mode = WAL;

-- Set synchronous level for durability without compromising performance
PRAGMA synchronous = NORMAL;

-- Increase cache size for better performance (negative = KB, positive = pages)
PRAGMA cache_size = -64000;

-- Enable foreign key constraints
PRAGMA foreign_keys = ON;

-- Create metadata table to track schema version and migrations
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE,
  description TEXT,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  checksum TEXT
);

-- Insert initial migration record (idempotent with INSERT OR IGNORE)
INSERT OR IGNORE INTO schema_migrations (version, description, checksum)
VALUES ('0001', 'Initialize WAL mode and schema migrations table', 'init-v1');
