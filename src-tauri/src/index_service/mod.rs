//! `index.v1` (1.0.0) — SQLite-backed knowledge index service.
//!
//! Implements the contract from
//! `docs/interfaces/Method Prototypes - Interface Contracts.md` §5
//! and the storage-isolation rules from
//! `docs/Module Isolation and Interface Contract - Semantic Product Lifecycle.md`
//! §3.2 (Single Owner Rule) and §10 (Storage Isolation):
//!
//!   - SQLite is owned exclusively by this module. No other module may open
//!     a write connection. The MCP stdio binary opens this module's
//!     `open_readonly()` constructor instead of touching SQLite directly.
//!   - The on-disk path is `<appData>/index/semantic.db` for the desktop
//!     host; an explicit path is taken in `open()` so the read-only binary
//!     can be invoked from outside Tauri.
//!   - WAL journal mode + porter-tokenised FTS5; trigger-driven sync per
//!     `docs/Semantic Product Lifecycle - Detailed Technical Specification.md`
//!     §10.

use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, Once};

pub mod embeddings;
use embeddings::{Embedder, EMBEDDING_DIM};

pub const INTERFACE_ID: &str = "index.v1";
// 1.1.0 → 1.2.0 (additive minor): adds `upsert_embedding`,
// `search_semantic`, and the `node_vec` virtual table for hybrid
// FTS + cosine retrieval per Spec §11.1. Closes carry-in AS-5.
pub const INTERFACE_VERSION: &str = "1.2.0";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticHit {
    pub node_id: String,
    /// Cosine similarity in [0, 1] — sqlite-vec returns L2 distance
    /// for unit-normalised vectors, which we map to similarity by
    /// `sim = 1 - distance^2 / 2` (equivalent to dot-product on
    /// L2-normalised vectors).
    pub score: f32,
}

/// Register sqlite-vec's `vec0` virtual table with SQLite's
/// auto-extension mechanism. Called once per process; every
/// subsequent `Connection::open` (read-write or read-only) inherits
/// the registration. Idempotent via `Once`.
fn ensure_sqlite_vec_registered() {
    // Local alias for the SQLite C extension entry-point signature.
    // `sqlite3_auto_extension` wants `Option<EntryPoint>`; spelling the
    // type out lets us cast `sqlite3_vec_init` (defined with the same
    // ABI in the sqlite-vec crate) without a transmute that the
    // compiler can't type-infer through `Some(_)`.
    #[allow(unsafe_code)]
    type EntryPoint = unsafe extern "C" fn(
        *mut rusqlite::ffi::sqlite3,
        *mut *const std::os::raw::c_char,
        *const rusqlite::ffi::sqlite3_api_routines,
    ) -> std::os::raw::c_int;

    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| {
        // SAFETY: sqlite-vec's `sqlite3_vec_init` is the canonical
        // SQLite extension entry point with the C ABI shape encoded
        // in `EntryPoint`. We cast through a raw pointer because
        // function-pointer types from different crates can't be
        // assigned directly even when the ABI matches. Once
        // registered with sqlite3_auto_extension, every Connection
        // opened later in this process gets vec0 with no per-conn
        // load_extension call.
        #[allow(unsafe_code)]
        unsafe {
            let entry: EntryPoint =
                std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ());
            rusqlite::ffi::sqlite3_auto_extension(Some(entry));
        }
    });
}

/// Wrapper around a SQLite connection. The `Mutex` makes the connection
/// `Send + Sync` so it can be managed by Tauri's state container; in the
/// stdio binary it serialises the (single-threaded) request loop.
///
/// `embedder` is `None` when the model files aren't installed (e.g.
/// fresh checkout before downloading the bundle). In that mode the
/// service still works — FTS is unaffected — but `embed_text` returns
/// `E_EMBEDDING_UNAVAILABLE` and `search_semantic` returns an empty
/// vector. The hybrid `retrieval_service::search` path falls back to
/// pure FTS in that case.
pub struct IndexService {
    conn: Mutex<Connection>,
    embedder: Option<Embedder>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub node_id: String,
    pub r#type: String,
    pub title: Option<String>,
    pub snippet: String,
    pub score: f64,
    pub updated_at_utc: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub r#type: String,
    pub title: Option<String>,
    pub body_md: Option<String>,
    /// Raw BlockNote document JSON for the body — the original tree
    /// pre-flattening. Image / structural MCP tools read this; the
    /// chat tools read `body_md` (the FTS-friendly flattened form).
    /// `None` for nodes written by older builds that didn't capture
    /// the raw JSON; callers must handle that explicitly.
    pub body_md_raw: Option<String>,
    /// Raw JSON-LD blob attached to the node. Exposed so the MCP
    /// `search_nodes` augmentation can lift `summary` / `keyPoints`
    /// for chat grounding without doing a second round-trip per hit.
    pub jsonld: Option<String>,
    pub source_path: Option<String>,
    pub updated_at_utc: String,
}

/// Lighter-shape row used by `list_nodes_by_type` (E-022 list tools). Includes
/// `jsonld` so callers can filter on jsonld fields (e.g. piId) without a
/// second `get_node_by_id` per row.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeListItem {
    pub id: String,
    pub r#type: String,
    pub title: Option<String>,
    pub jsonld: String,
    pub updated_at_utc: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeighborHit {
    pub node_id: String,
    pub r#type: String,
    pub title: Option<String>,
    pub snippet: String,
    pub hop: u8,
    pub via_predicate: String,
    pub updated_at_utc: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexHealth {
    pub schema_version: String,
    pub node_count: u64,
    pub edge_count: u64,
    pub fts_ready: bool,
    pub vec_ready: bool,
    pub last_updated_utc: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("E_INDEX_OPEN: {0}")]
    Open(String),
    #[error("E_INDEX_SCHEMA: {0}")]
    Schema(String),
    #[error("E_INDEX_QUERY: {0}")]
    Query(String),
    #[error("E_INDEX_CONSTRAINT: {0}")]
    Constraint(String),
    #[error("E_INDEX_LOCK: {0}")]
    Lock(String),
    #[error("E_INDEX_VECTOR_DIM: {0}")]
    VectorDim(String),
}

/// Serialise a slice of f32s to little-endian bytes for sqlite-vec.
/// vec0 accepts BLOB columns of `len * 4` bytes representing the
/// vector's `len` float components in LE order.
fn vec_to_bytes(v: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(v.len() * 4);
    for &f in v {
        bytes.extend_from_slice(&f.to_le_bytes());
    }
    bytes
}

/// Concatenate `title` and `body_md` into a single embedding input.
/// Matches what FTS sees (the two columns in `node_fts`), so lexical
/// and semantic recall stay aligned. We bound the input at ~4 KB
/// because BGE-small caps at 512 tokens — the tokenizer truncates
/// anyway, but pre-trimming saves a few microseconds and avoids
/// re-allocating a multi-MB body just to throw most of it away.
fn build_embed_input(title: Option<&str>, body_md: Option<&str>) -> String {
    const MAX_BYTES: usize = 4096;
    let mut out = String::new();
    if let Some(t) = title.filter(|s| !s.trim().is_empty()) {
        out.push_str(t);
        out.push_str("\n\n");
    }
    if let Some(b) = body_md.filter(|s| !s.trim().is_empty()) {
        if out.len() + b.len() <= MAX_BYTES {
            out.push_str(b);
        } else {
            let take = MAX_BYTES.saturating_sub(out.len());
            // Find the nearest char boundary <= take to avoid splitting
            // a multi-byte UTF-8 codepoint.
            let mut end = take;
            while end > 0 && !b.is_char_boundary(end) {
                end -= 1;
            }
            out.push_str(&b[..end]);
        }
    }
    out
}

impl IndexService {
    /// Open a read-write connection. Used by the desktop host. Initialises
    /// the schema (idempotent) so callers can assume a ready DB.
    pub fn open(path: &Path) -> Result<Self, IndexError> {
        ensure_sqlite_vec_registered();
        let conn = Connection::open(path)
            .map_err(|e| IndexError::Open(format!("open {path:?}: {e}")))?;
        Self::init_schema(&conn)?;
        let embedder = Self::load_embedder();
        Ok(Self {
            conn: Mutex::new(conn),
            embedder,
        })
    }

    /// Open a read-only connection. Used by the MCP stdio binary so the
    /// sidecar process is structurally incapable of mutating canonical
    /// state (Module Isolation §4.2 enforcement). The embedder is still
    /// loaded so the chat agent can compute query embeddings from the
    /// sidecar.
    pub fn open_readonly(path: &Path) -> Result<Self, IndexError> {
        ensure_sqlite_vec_registered();
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_flags(path, flags)
            .map_err(|e| IndexError::Open(format!("open(ro) {path:?}: {e}")))?;
        // Don't init_schema; the writer (desktop host) owns that.
        let embedder = Self::load_embedder();
        Ok(Self {
            conn: Mutex::new(conn),
            embedder,
        })
    }

    /// Best-effort embedder load. Returns `None` if model files are
    /// missing or load fails — semantic features degrade gracefully,
    /// FTS keeps working unaffected.
    fn load_embedder() -> Option<Embedder> {
        let dir = Embedder::default_model_dir()?;
        match Embedder::load(&dir) {
            Ok(e) => {
                eprintln!("[index_service] embedder loaded from {:?}", dir);
                Some(e)
            }
            Err(e) => {
                eprintln!(
                    "[index_service] embedder load failed (semantic search disabled): {e}"
                );
                None
            }
        }
    }

    fn init_schema(conn: &Connection) -> Result<(), IndexError> {
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| IndexError::Schema(format!("pragma WAL: {e}")))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| IndexError::Schema(format!("pragma synchronous: {e}")))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| IndexError::Schema(format!("pragma foreign_keys: {e}")))?;

        conn.execute_batch(SCHEMA_SQL)
            .map_err(|e| IndexError::Schema(format!("schema init: {e}")))?;
        // Idempotent migration for DBs created before `body_md_raw`
        // existed. SQLite errors with "duplicate column name" when the
        // column already exists — caught and ignored.
        if let Err(e) = conn.execute("ALTER TABLE node ADD COLUMN body_md_raw TEXT", []) {
            let msg = e.to_string();
            if !msg.contains("duplicate column name") {
                return Err(IndexError::Schema(format!(
                    "add body_md_raw column: {e}"
                )));
            }
        }
        // node_vec virtual table is created in a separate batch so its
        // failure (e.g. sqlite-vec extension didn't register) doesn't
        // block the rest of the schema. If creation fails the writer
        // still works; semantic search just returns empty.
        if let Err(e) = conn.execute_batch(NODE_VEC_SQL) {
            eprintln!(
                "[index_service] node_vec creation failed (semantic search disabled): {e}"
            );
        }
        Ok(())
    }

    /// Embed `text` via the loaded model. Returns `None` if the
    /// embedder isn't available (model files missing).
    pub fn embed_text(&self, text: &str) -> Option<Vec<f32>> {
        let e = self.embedder.as_ref()?;
        match e.embed(text) {
            Ok(v) => Some(v),
            Err(err) => {
                eprintln!("[index_service] embed_text failed: {err}");
                None
            }
        }
    }

    /// Whether the embedder is loaded and semantic features are
    /// available. Exposed so callers can branch on a single flag
    /// without doing a dummy embed.
    pub fn has_embedder(&self) -> bool {
        self.embedder.is_some()
    }

    /// Upsert a 384-dim embedding for `node_id`. Dimension is
    /// validated; passing the wrong length returns
    /// `E_INDEX_VECTOR_DIM`.
    pub fn upsert_embedding(
        &self,
        node_id: &str,
        vector: &[f32],
    ) -> Result<(), IndexError> {
        if vector.len() != EMBEDDING_DIM {
            return Err(IndexError::VectorDim(format!(
                "expected {EMBEDDING_DIM} dims, got {}",
                vector.len()
            )));
        }
        let bytes = vec_to_bytes(vector);
        let conn = self.lock()?;
        // sqlite-vec's vec0 virtual table doesn't implement UPSERT
        // (the ON CONFLICT clause), so we DELETE + INSERT in a single
        // transaction. The DELETE is a no-op for new rows; the INSERT
        // is the canonical write path documented by sqlite-vec.
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| IndexError::Query(format!("upsert_embedding txn: {e}")))?;
        tx.execute("DELETE FROM node_vec WHERE node_id = ?1", params![node_id])
            .map_err(|e| IndexError::Query(format!("upsert_embedding delete: {e}")))?;
        tx.execute(
            "INSERT INTO node_vec(node_id, embedding) VALUES(?1, ?2)",
            params![node_id, bytes],
        )
        .map_err(|e| IndexError::Query(format!("upsert_embedding insert: {e}")))?;
        tx.commit()
            .map_err(|e| IndexError::Query(format!("upsert_embedding commit: {e}")))?;
        Ok(())
    }

    /// Delete the embedding row for `node_id`. No-op if absent.
    pub fn delete_embedding(&self, node_id: &str) -> Result<(), IndexError> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM node_vec WHERE node_id = ?1", params![node_id])
            .map_err(|e| IndexError::Query(format!("delete_embedding: {e}")))?;
        Ok(())
    }

    /// Top-K nearest neighbours by cosine similarity. Returns
    /// `(node_id, score)` pairs sorted descending; `score` is
    /// renormalised into [0, 1] from sqlite-vec's L2 distance over
    /// unit-normalised vectors (Spec §11.1).
    pub fn search_semantic(
        &self,
        query: &[f32],
        limit: usize,
    ) -> Result<Vec<SemanticHit>, IndexError> {
        if !self.has_embedder() {
            return Ok(Vec::new());
        }
        if query.len() != EMBEDDING_DIM {
            return Err(IndexError::VectorDim(format!(
                "query has {} dims, expected {EMBEDDING_DIM}",
                query.len()
            )));
        }
        let k = limit.clamp(1, 200);
        let bytes = vec_to_bytes(query);
        let conn = self.lock()?;
        // sqlite-vec KNN: bind the query vector and `k`, ORDER BY
        // distance ASC. For unit-normalised vectors the returned
        // L2 distance d satisfies cos_sim = 1 - d^2/2; we map back
        // into a [0, 1] similarity so the rerank fusion can mix
        // FTS bm25 and semantic scores on a common scale.
        let mut stmt = conn
            .prepare(
                "SELECT node_id, distance FROM node_vec \
                 WHERE embedding MATCH ?1 AND k = ?2 \
                 ORDER BY distance",
            )
            .map_err(|e| IndexError::Query(format!("prepare search_semantic: {e}")))?;
        let rows = stmt
            .query_map(params![bytes, k as i64], |row| {
                let node_id: String = row.get(0)?;
                let distance: f64 = row.get(1)?;
                Ok((node_id, distance as f32))
            })
            .map_err(|e| IndexError::Query(format!("query search_semantic: {e}")))?;
        let mut out = Vec::with_capacity(k);
        for r in rows {
            let (node_id, distance) = r
                .map_err(|e| IndexError::Query(format!("row search_semantic: {e}")))?;
            let sim = 1.0 - (distance * distance) / 2.0;
            out.push(SemanticHit {
                node_id,
                score: sim.clamp(0.0, 1.0),
            });
        }
        Ok(out)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, IndexError> {
        self.conn
            .lock()
            .map_err(|e| IndexError::Lock(format!("connection mutex poisoned: {e}")))
    }

    // === Read methods (called by retrieval-service and mcp-service) ===

    /// `index.searchFts` — bm25-ranked FTS5 search over title + body_md.
    pub fn search_fts(
        &self,
        query: &str,
        type_filter: Option<&str>,
        limit: i64,
    ) -> Result<Vec<SearchHit>, IndexError> {
        let prepared = prepare_fts_query(query);
        if prepared.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.lock()?;
        let sql = if type_filter.is_some() {
            FTS_QUERY_WITH_TYPE
        } else {
            FTS_QUERY
        };
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| IndexError::Query(format!("prepare: {e}")))?;
        let rows = if let Some(t) = type_filter {
            stmt.query_map(params![&prepared, t, limit], map_search_hit)
        } else {
            stmt.query_map(params![&prepared, limit], map_search_hit)
        }
        .map_err(|e| IndexError::Query(format!("query: {e}")))?;
        let mut hits = Vec::new();
        for r in rows {
            hits.push(r.map_err(|e| IndexError::Query(format!("row: {e}")))?);
        }
        Ok(hits)
    }

    /// `index.getNodeById` — read a single node by stable id. Returns
    /// `None` if no such node exists.
    pub fn get_node_by_id(&self, id: &str) -> Result<Option<GraphNode>, IndexError> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, type, title, body_md, body_md_raw, jsonld, source_path, updated_at \
                 FROM node WHERE id = ?1",
            )
            .map_err(|e| IndexError::Query(format!("prepare: {e}")))?;
        let result = stmt.query_row(params![id], |row| {
            Ok(GraphNode {
                id: row.get(0)?,
                r#type: row.get(1)?,
                title: row.get(2)?,
                body_md: row.get(3)?,
                body_md_raw: row.get(4)?,
                jsonld: row.get(5)?,
                source_path: row.get(6)?,
                updated_at_utc: row.get(7)?,
            })
        });
        match result {
            Ok(node) => Ok(Some(node)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(IndexError::Query(format!("get_node: {e}"))),
        }
    }

    /// `index.expandSubgraph` — walk the edge table around a seed node up to
    /// the requested depth. Returns the matched neighbour nodes annotated
    /// with hop distance and the predicate that connected them.
    pub fn expand_subgraph(
        &self,
        seed: &str,
        depth: u8,
        limit: usize,
    ) -> Result<Vec<NeighborHit>, IndexError> {
        let depth = depth.clamp(1, 2);
        let limit = limit.max(1).min(50);
        let conn = self.lock()?;
        let mut collected: std::collections::HashMap<String, (u8, String)> =
            std::collections::HashMap::new();
        let mut seen: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        seen.insert(seed.to_string());
        let mut frontier: Vec<String> = vec![seed.to_string()];

        for hop in 1..=depth {
            if collected.len() >= limit {
                break;
            }
            let mut next: Vec<String> = Vec::new();
            for node in &frontier {
                if collected.len() >= limit {
                    break;
                }
                let mut stmt = conn
                    .prepare(
                        "SELECT src_id, predicate, dst_id FROM edge \
                         WHERE src_id = ?1 OR dst_id = ?1 LIMIT ?2",
                    )
                    .map_err(|e| IndexError::Query(format!("prepare neighbors: {e}")))?;
                let rows = stmt
                    .query_map(params![node, limit as i64], |row| {
                        let src: String = row.get(0)?;
                        let pred: String = row.get(1)?;
                        let dst: String = row.get(2)?;
                        Ok((src, pred, dst))
                    })
                    .map_err(|e| IndexError::Query(format!("neighbors: {e}")))?;
                for r in rows {
                    let (src, predicate, dst) =
                        r.map_err(|e| IndexError::Query(format!("neighbor row: {e}")))?;
                    let other = if src == *node { dst } else { src };
                    if !seen.contains(&other) {
                        collected.insert(other.clone(), (hop, predicate));
                        seen.insert(other.clone());
                        next.push(other);
                        if collected.len() >= limit {
                            break;
                        }
                    }
                }
            }
            frontier = next;
        }

        if collected.is_empty() {
            return Ok(Vec::new());
        }

        let ids: Vec<String> = collected.keys().cloned().collect();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT id, type, title, body_md, updated_at FROM node \
             WHERE id IN ({placeholders})"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| IndexError::Query(format!("prepare nodes: {e}")))?;
        let id_refs: Vec<&dyn rusqlite::ToSql> =
            ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let rows = stmt
            .query_map(id_refs.as_slice(), |row| {
                let id: String = row.get(0)?;
                let r#type: String = row.get(1)?;
                let title: Option<String> = row.get(2)?;
                let body_md: Option<String> = row.get(3)?;
                let updated: String = row.get(4)?;
                Ok((id, r#type, title, body_md, updated))
            })
            .map_err(|e| IndexError::Query(format!("nodes: {e}")))?;
        let mut out = Vec::new();
        for r in rows {
            let (id, r#type, title, body_md, updated) =
                r.map_err(|e| IndexError::Query(format!("node row: {e}")))?;
            let (hop, predicate) = collected
                .get(&id)
                .cloned()
                .unwrap_or((1u8, "unknown".to_string()));
            let snippet = body_md.as_deref().unwrap_or("").chars().take(200).collect();
            out.push(NeighborHit {
                node_id: id,
                r#type,
                title,
                snippet,
                hop,
                via_predicate: predicate,
                updated_at_utc: updated,
            });
        }
        Ok(out)
    }

    /// `index.getHealth` — counts + last-updated timestamp.
    pub fn get_health(&self) -> Result<IndexHealth, IndexError> {
        let conn = self.lock()?;
        let node_count: u64 = conn
            .query_row("SELECT COUNT(*) FROM node", [], |r| r.get::<_, i64>(0))
            .map_err(|e| IndexError::Query(format!("node count: {e}")))?
            as u64;
        let edge_count: u64 = conn
            .query_row("SELECT COUNT(*) FROM edge", [], |r| r.get::<_, i64>(0))
            .map_err(|e| IndexError::Query(format!("edge count: {e}")))?
            as u64;
        let last_updated: Option<String> = conn
            .query_row("SELECT MAX(updated_at) FROM node", [], |r| {
                r.get::<_, Option<String>>(0)
            })
            .unwrap_or(None);
        Ok(IndexHealth {
            schema_version: "1.0.0".to_string(),
            node_count,
            edge_count,
            fts_ready: true,
            vec_ready: false, // vector path not wired in v1
            last_updated_utc: last_updated,
        })
    }

    // === Write methods (read-write connections only) ===

    /// `index.upsertNodes` (single-row form). Caller must hold a writer
    /// connection; calls on a read-only connection will fail at the SQL
    /// layer with `SQLITE_READONLY`.
    pub fn upsert_node(
        &self,
        id: &str,
        node_type: &str,
        title: Option<&str>,
        body_md: Option<&str>,
        body_md_raw: Option<&str>,
        jsonld: &str,
        source_path: Option<&str>,
        updated_at_utc: &str,
    ) -> Result<i64, IndexError> {
        // Compute the embedding *before* taking the connection lock so
        // the BERT forward pass doesn't block other readers. The
        // embedding source mirrors what FTS sees (title + body_md) so
        // lexical and semantic recall agree on what "this node is
        // about". Empty bodies skip embedding entirely — embedding
        // whitespace produces noise and would dirty the rerank scores.
        let embed_input = build_embed_input(title, body_md);
        let embedding = if embed_input.trim().is_empty() {
            None
        } else {
            self.embed_text(&embed_input)
        };

        let rowid: i64 = {
            let conn = self.lock()?;
            conn.execute(
                "INSERT INTO node (id, type, title, body_md, body_md_raw, jsonld, source_path, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                 ON CONFLICT(id) DO UPDATE SET \
                   type = excluded.type, title = excluded.title, body_md = excluded.body_md, \
                   body_md_raw = excluded.body_md_raw, \
                   jsonld = excluded.jsonld, source_path = excluded.source_path, \
                   updated_at = excluded.updated_at",
                params![id, node_type, title, body_md, body_md_raw, jsonld, source_path, updated_at_utc],
            )
            .map_err(|e| IndexError::Constraint(format!("upsert_node: {e}")))?;
            conn.query_row("SELECT rowid FROM node WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .map_err(|e| IndexError::Query(format!("rowid: {e}")))?
        };

        // Write the embedding after the node row commits so the
        // node_vec row never references a non-existent node. If
        // embedding is None (no model loaded, or empty body) we leave
        // the prior vector in place — this preserves recall during
        // pure-title edits and avoids dropping a node out of semantic
        // search just because the user emptied body_md briefly.
        if let Some(v) = embedding {
            if let Err(e) = self.upsert_embedding(id, &v) {
                eprintln!("[index_service] upsert_embedding failed for {id}: {e}");
            }
        }
        Ok(rowid)
    }

    /// `index.deleteBySource` (id form). Removes a single node by stable id;
    /// FTS triggers cascade automatically.
    pub fn delete_node(&self, id: &str) -> Result<bool, IndexError> {
        let n = {
            let conn = self.lock()?;
            conn.execute("DELETE FROM node WHERE id = ?1", params![id])
                .map_err(|e| IndexError::Constraint(format!("delete: {e}")))?
        };
        // Embedding row is in a virtual table — DELETE on `node` does
        // NOT cascade to `node_vec` automatically. Always best-effort:
        // a stale vec row is harmless (it'll dangle until the next
        // re-index sweep), but we clean up while we have the id.
        let _ = self.delete_embedding(id);
        Ok(n > 0)
    }

    /// Compute and write embeddings for every `node` row that doesn't
    /// already have one in `node_vec`. Returns the number of rows
    /// embedded. Idempotent: re-running after a clean backfill is a
    /// no-op. Skip-out conditions:
    ///   - embedder isn't loaded → returns 0 with a warning log,
    ///   - node has empty title and body_md → skipped (would embed
    ///     whitespace), counted in the skipped tally only.
    ///
    /// Designed to run on a background thread at startup; the per-row
    /// write is a single auto-commit transaction so an interrupted
    /// backfill leaves the DB consistent and the next launch just
    /// picks up from where it left off.
    pub fn backfill_embeddings(&self) -> Result<u64, IndexError> {
        if !self.has_embedder() {
            eprintln!("[backfill_embeddings] embedder not loaded, skipping");
            return Ok(0);
        }
        let ids_to_embed: Vec<(String, Option<String>, Option<String>)> = {
            let conn = self.lock()?;
            let mut stmt = conn
                .prepare(
                    "SELECT n.id, n.title, n.body_md \
                     FROM node n \
                     WHERE NOT EXISTS ( \
                       SELECT 1 FROM node_vec v WHERE v.node_id = n.id \
                     )",
                )
                .map_err(|e| IndexError::Query(format!("prepare backfill: {e}")))?;
            let rows = stmt
                .query_map([], |row| {
                    let id: String = row.get(0)?;
                    let title: Option<String> = row.get(1)?;
                    let body: Option<String> = row.get(2)?;
                    Ok((id, title, body))
                })
                .map_err(|e| IndexError::Query(format!("query backfill: {e}")))?;
            let mut out = Vec::new();
            for r in rows {
                out.push(
                    r.map_err(|e| IndexError::Query(format!("row backfill: {e}")))?,
                );
            }
            out
        };

        let mut embedded: u64 = 0;
        for (id, title, body) in ids_to_embed {
            let text = build_embed_input(title.as_deref(), body.as_deref());
            if text.trim().is_empty() {
                continue;
            }
            let Some(vec) = self.embed_text(&text) else {
                continue;
            };
            match self.upsert_embedding(&id, &vec) {
                Ok(()) => embedded += 1,
                Err(e) => eprintln!("[backfill_embeddings] {id} failed: {e}"),
            }
        }
        Ok(embedded)
    }

    /// One-shot reindex of any pre-existing draft JSON files. Idempotent —
    /// safe to run on every launch. Lives here because it is a `node`-table
    /// write path.
    pub fn reindex_drafts(&self, drafts_dir: &Path) -> Result<u64, IndexError> {
        let entries = match std::fs::read_dir(drafts_dir) {
            Ok(e) => e,
            Err(_) => return Ok(0),
        };
        let mut indexed: u64 = 0;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let record: serde_json::Value = match serde_json::from_slice(&bytes) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let id = record
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if id.is_empty() {
                continue;
            }
            let draft = record
                .get("draft")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let draft_type = draft
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("draft");
            let title = draft.get("title").and_then(|v| v.as_str());
            let body_md_raw = draft
                .get("bodyMd")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let searchable = derive_searchable_text(body_md_raw);
            let jsonld = match draft.get("jsonld").and_then(|v| v.as_str()) {
                Some(s) if !s.is_empty() => s.to_string(),
                _ => serde_json::to_string(&draft).unwrap_or_else(|_| "{}".to_string()),
            };
            let updated_at = record
                .get("updatedAtUtc")
                .and_then(|v| v.as_str())
                .unwrap_or("1970-01-01T00:00:00Z");
            if self
                .upsert_node(
                    id,
                    draft_type,
                    title,
                    Some(&searchable),
                    Some(body_md_raw),
                    &jsonld,
                    Some(&path.to_string_lossy()),
                    updated_at,
                )
                .is_ok()
            {
                indexed += 1;
            }
        }
        Ok(indexed)
    }

    /// One-shot reindex of every canonical JSON file under
    /// `kb_dir`. Walks `kb_dir/<type-plural>/*.json` and re-upserts
    /// each record — same shape as the `drafts/` files (both carry
    /// `{ id, draft: { type, title, bodyMd, jsonld, ... } }`). Used
    /// at startup to repopulate columns that older builds didn't
    /// write (e.g. `body_md_raw` introduced when the image MCP
    /// tools needed the raw BlockNote JSON).
    pub fn reindex_canonical(&self, kb_dir: &Path) -> Result<u64, IndexError> {
        let type_dirs = match std::fs::read_dir(kb_dir) {
            Ok(e) => e,
            Err(_) => return Ok(0),
        };
        let mut indexed: u64 = 0;
        for type_entry in type_dirs.flatten() {
            let type_path = type_entry.path();
            if !type_path.is_dir() {
                continue;
            }
            let entries = match std::fs::read_dir(&type_path) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let bytes = match std::fs::read(&path) {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                let record: serde_json::Value = match serde_json::from_slice(&bytes) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let id = record.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if id.is_empty() {
                    continue;
                }
                let draft = record
                    .get("draft")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                let draft_type = draft
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if draft_type.is_empty() {
                    continue;
                }
                let title = draft.get("title").and_then(|v| v.as_str());
                let body_md_raw = draft
                    .get("bodyMd")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let searchable = crate::searchable_text::derive_searchable_text(body_md_raw);
                let jsonld = match draft.get("jsonld").and_then(|v| v.as_str()) {
                    Some(s) if !s.is_empty() => s.to_string(),
                    _ => serde_json::to_string(&draft).unwrap_or_else(|_| "{}".to_string()),
                };
                let updated_at = record
                    .get("updatedAtUtc")
                    .and_then(|v| v.as_str())
                    .unwrap_or("1970-01-01T00:00:00Z");
                if self
                    .upsert_node(
                        id,
                        draft_type,
                        title,
                        Some(&searchable),
                        Some(body_md_raw),
                        &jsonld,
                        Some(&path.to_string_lossy()),
                        updated_at,
                    )
                    .is_ok()
                {
                    indexed += 1;
                }
            }
        }
        Ok(indexed)
    }

    // === Edge writers (B-018, additive on `index.v1` 1.1.0) ===
    // Edge predicates and the orchestration that decides WHICH edges to write
    // live in workspace_service. This module owns only the SQL.

    /// Replace the set of edges originating at `src_id` for the given
    /// predicate. Atomic — the DELETE and the INSERTs run in a single
    /// transaction. `INSERT OR IGNORE` makes duplicate `dst_ids` in the
    /// input list a no-op rather than an error.
    pub fn replace_edges(
        &self,
        src_id: &str,
        predicate: &str,
        dst_ids: &[&str],
    ) -> Result<usize, IndexError> {
        let mut conn = self.lock()?;
        let tx = conn
            .transaction()
            .map_err(|e| IndexError::Query(format!("replace_edges: tx: {e}")))?;
        tx.execute(
            "DELETE FROM edge WHERE src_id = ?1 AND predicate = ?2",
            params![src_id, predicate],
        )
        .map_err(|e| IndexError::Constraint(format!("replace_edges: delete: {e}")))?;
        let mut inserted: usize = 0;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT OR IGNORE INTO edge (src_id, predicate, dst_id) VALUES (?1, ?2, ?3)",
                )
                .map_err(|e| IndexError::Query(format!("replace_edges: prepare: {e}")))?;
            for dst in dst_ids {
                let n = stmt
                    .execute(params![src_id, predicate, dst])
                    .map_err(|e| IndexError::Constraint(format!("replace_edges: insert: {e}")))?;
                inserted += n;
            }
        }
        tx.commit()
            .map_err(|e| IndexError::Query(format!("replace_edges: commit: {e}")))?;
        Ok(inserted)
    }

    /// Remove every edge whose `src_id` is the given id. Used by
    /// `WorkspaceService::delete_node` since the SQL schema has no FK and
    /// edge cleanup is not cascade-driven.
    pub fn delete_edges_by_src(&self, src_id: &str) -> Result<usize, IndexError> {
        let conn = self.lock()?;
        let n = conn
            .execute("DELETE FROM edge WHERE src_id = ?1", params![src_id])
            .map_err(|e| IndexError::Constraint(format!("delete_edges_by_src: {e}")))?;
        Ok(n)
    }

    /// List `dst_id` values for every edge `(src_id, predicate, *)`. Used
    /// by D-019's transitive `references` derivation (walks `cites` from
    /// each Epic-assembled doc).
    pub fn list_edges_by_src_and_predicate(
        &self,
        src_id: &str,
        predicate: &str,
    ) -> Result<Vec<String>, IndexError> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(
                "SELECT dst_id FROM edge WHERE src_id = ?1 AND predicate = ?2 ORDER BY dst_id",
            )
            .map_err(|e| IndexError::Query(format!("list_edges_by_src: prepare: {e}")))?;
        let rows = stmt
            .query_map(params![src_id, predicate], |row| row.get::<_, String>(0))
            .map_err(|e| IndexError::Query(format!("list_edges_by_src: query: {e}")))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| IndexError::Query(format!("list_edges_by_src: row: {e}")))?);
        }
        Ok(out)
    }

    /// List `src_id` values for every edge `(*, predicate, dst_id)`. Used
    /// by the `style-guides` un-pin scenario (find every reference currently
    /// pointing at this consumer so the workspace_service can diff against
    /// the consumer's latest `referenceIds`).
    pub fn list_edges_by_dst_and_predicate(
        &self,
        dst_id: &str,
        predicate: &str,
    ) -> Result<Vec<String>, IndexError> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(
                "SELECT src_id FROM edge WHERE dst_id = ?1 AND predicate = ?2 ORDER BY src_id",
            )
            .map_err(|e| IndexError::Query(format!("list_edges_by_dst: prepare: {e}")))?;
        let rows = stmt
            .query_map(params![dst_id, predicate], |row| row.get::<_, String>(0))
            .map_err(|e| IndexError::Query(format!("list_edges_by_dst: query: {e}")))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| IndexError::Query(format!("list_edges_by_dst: row: {e}")))?);
        }
        Ok(out)
    }

    /// E-022: list every node row of a given type, newest-first. Returns
    /// the `jsonld` blob alongside id/title so the caller can filter on
    /// jsonld fields (piId, etc.) without a follow-up read per row.
    pub fn list_nodes_by_type(
        &self,
        node_type: &str,
        limit: i64,
    ) -> Result<Vec<NodeListItem>, IndexError> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, type, title, COALESCE(jsonld, '{}'), updated_at \
                 FROM node WHERE type = ?1 \
                 ORDER BY updated_at DESC LIMIT ?2",
            )
            .map_err(|e| IndexError::Query(format!("list_nodes_by_type: prepare: {e}")))?;
        let rows = stmt
            .query_map(params![node_type, limit], |row| {
                Ok(NodeListItem {
                    id: row.get(0)?,
                    r#type: row.get(1)?,
                    title: row.get(2)?,
                    jsonld: row.get(3)?,
                    updated_at_utc: row.get(4)?,
                })
            })
            .map_err(|e| IndexError::Query(format!("list_nodes_by_type: query: {e}")))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| IndexError::Query(format!("list_nodes_by_type: row: {e}")))?);
        }
        Ok(out)
    }

    /// Delete a single edge. Used by the `style-guides` un-pin path.
    pub fn delete_edge(
        &self,
        src_id: &str,
        predicate: &str,
        dst_id: &str,
    ) -> Result<bool, IndexError> {
        let conn = self.lock()?;
        let n = conn
            .execute(
                "DELETE FROM edge WHERE src_id = ?1 AND predicate = ?2 AND dst_id = ?3",
                params![src_id, predicate, dst_id],
            )
            .map_err(|e| IndexError::Constraint(format!("delete_edge: {e}")))?;
        Ok(n > 0)
    }
}

// === Helpers ===

/// Compute the on-disk DB path from the Tauri app handle. Lives in the
/// service module (rather than shell-bridge) because the path is part of
/// `index.v1`'s storage contract.
pub fn db_path_for_app(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    let dir = base.join("index");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {dir:?}: {e}"))?;
    Ok(dir.join("semantic.db"))
}

// `derive_searchable_text` was previously a byte-identical local copy of
// the helper in `workspace_service`. REM-022 deduped both copies into the
// shared `crate::searchable_text` module; re-exported here so the existing
// call site in `reindex_drafts` (line 430) continues to resolve as
// `derive_searchable_text` without a `crate::` prefix.
pub use crate::searchable_text::derive_searchable_text;

fn map_search_hit(row: &rusqlite::Row<'_>) -> rusqlite::Result<SearchHit> {
    Ok(SearchHit {
        node_id: row.get(0)?,
        r#type: row.get(1)?,
        title: row.get(2)?,
        snippet: row.get(3)?,
        score: row.get(4)?,
        updated_at_utc: row.get(5)?,
    })
}

fn prepare_fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .filter_map(|tok| {
            let cleaned = tok.replace('"', "");
            if cleaned.is_empty() {
                None
            } else {
                Some(format!("\"{cleaned}\"*"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

const FTS_QUERY_WITH_TYPE: &str = r#"
SELECT n.id, n.type, n.title,
       snippet(node_fts, 1, '<mark>', '</mark>', ' … ', 200) AS snip,
       -bm25(node_fts) AS rank,
       n.updated_at
FROM node_fts
JOIN node n ON n.rowid = node_fts.rowid
WHERE node_fts MATCH ?1 AND n.type = ?2
ORDER BY rank DESC
LIMIT ?3
"#;

const FTS_QUERY: &str = r#"
SELECT n.id, n.type, n.title,
       snippet(node_fts, 1, '<mark>', '</mark>', ' … ', 200) AS snip,
       -bm25(node_fts) AS rank,
       n.updated_at
FROM node_fts
JOIN node n ON n.rowid = node_fts.rowid
WHERE node_fts MATCH ?1
ORDER BY rank DESC
LIMIT ?2
"#;

/// `node_vec` is a sqlite-vec `vec0` virtual table holding one 384-dim
/// L2-normalised embedding per indexed node. We keep it separate from
/// SCHEMA_SQL so that if the sqlite-vec extension failed to load (e.g.
/// fresh checkout without the model bundle, dev mode without
/// auto_extension), the rest of the schema still applies cleanly.
///
/// Spec §11.1: cosine similarity over BGE-small embeddings. vec0
/// stores raw f32 LE bytes; the column type is `FLOAT[384]`.
const NODE_VEC_SQL: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS node_vec USING vec0(
  node_id TEXT PRIMARY KEY,
  embedding FLOAT[384]
);
"#;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS node (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  title TEXT,
  body_md TEXT,
  -- Raw BlockNote document JSON for the body. `body_md` itself is
  -- the flattened plain text used by FTS5 (so JSON syntax doesn't
  -- pollute search), but the image / structural MCP tools need the
  -- original tree — that's what this column holds. Nullable so old
  -- callers / migrations don't break; image lookups gracefully
  -- return zero results when absent.
  body_md_raw TEXT,
  jsonld TEXT NOT NULL,
  source_path TEXT,
  updated_at TEXT NOT NULL
);
-- One-shot migration: old DBs created before body_md_raw landed
-- still need the column. `ALTER TABLE ... ADD COLUMN` is idempotent
-- because we wrap it in OR IGNORE via the schema_migrations check
-- inside `ensure_body_md_raw_column` (Rust side) — at this layer we
-- just ensure the CREATE TABLE statement matches the live shape.
CREATE INDEX IF NOT EXISTS idx_node_id ON node(id);
CREATE INDEX IF NOT EXISTS idx_node_type ON node(type);

CREATE TABLE IF NOT EXISTS edge (
  src_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  evidence_id TEXT,
  PRIMARY KEY (src_id, predicate, dst_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
  title, body_md,
  content='node',
  content_rowid='rowid',
  tokenize='porter'
);

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
"#;
