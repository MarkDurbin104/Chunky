-- B-001: Create core node and edge tables
-- Version: 2
-- Purpose: Define the semantic graph structure for code symbols and relationships
-- Mirror: src/index-service/internal/migrations/0002_node_edge.sql

-- Create node table to represent code symbols (functions, classes, variables, etc.)
-- Per Spec §10 and TRP §4 Functional Requirements
CREATE TABLE IF NOT EXISTS node (
  -- Core identification
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,  -- Internal SQLite rowid for FTS5 external content
  id TEXT NOT NULL UNIQUE,          -- Content-addressable ID (hash of file:name:kind)
  type TEXT NOT NULL,               -- Symbol type: function, class, variable, interface, enum, etc.
  
  -- Content
  title TEXT,                       -- Symbol name/title
  body_md TEXT,                     -- Symbol content in markdown format
  jsonld TEXT NOT NULL,             -- JSON-LD representation for semantic data
  
  -- Source location
  source_path TEXT,                 -- Relative path to source file
  
  -- Timestamps
  updated_at TEXT NOT NULL          -- Last update timestamp (ISO 8601)
);

-- Create indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_node_id ON node(id);
CREATE INDEX IF NOT EXISTS idx_node_type ON node(type);
CREATE INDEX IF NOT EXISTS idx_node_source_path ON node(source_path);
CREATE INDEX IF NOT EXISTS idx_node_updated_at ON node(updated_at);

-- Create edge table to represent relationships between nodes
-- Per Spec §10 and TRP §4 Functional Requirements
CREATE TABLE IF NOT EXISTS edge (
  -- Relationship endpoints
  src_id TEXT NOT NULL,             -- Source node ID
  predicate TEXT NOT NULL,          -- Relationship type: call, import, extends, implements, etc.
  dst_id TEXT NOT NULL,             -- Target node ID
  
  -- Relationship metadata
  weight REAL DEFAULT 1.0,          -- Confidence or strength of relationship (0.0-1.0)
  evidence_id TEXT,                 -- Reference to evidence or source of relationship
  
  -- Timestamps
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  -- Primary key: composite on source, predicate, target (prevents duplicate edges)
  PRIMARY KEY (src_id, predicate, dst_id),
  
  -- Foreign keys to node table (using node.id field)
  FOREIGN KEY (src_id) REFERENCES node(id) ON DELETE CASCADE,
  FOREIGN KEY (dst_id) REFERENCES node(id) ON DELETE CASCADE
);

-- Create indexes for edge traversal
CREATE INDEX IF NOT EXISTS idx_edge_predicate ON edge(predicate);
CREATE INDEX IF NOT EXISTS idx_edge_src_id ON edge(src_id);
CREATE INDEX IF NOT EXISTS idx_edge_dst_id ON edge(dst_id);

-- Record migration
INSERT OR IGNORE INTO schema_migrations (version, description, checksum)
VALUES ('0002', 'Create node and edge tables for code graph', 'nodes-edges-v1');
