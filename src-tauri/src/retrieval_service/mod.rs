//! `retrieval.v1` (1.1.0) — hybrid retrieval over the index.
//!
//! Implements the contract from
//! `docs/interfaces/Method Prototypes - Interface Contracts.md` §8 and the
//! topology rules from
//! `docs/Module Isolation and Interface Contract - Semantic Product Lifecycle.md`
//! §7.7:
//!
//!   - `retrieval-service` may read `index-service` and call `policy-engine`.
//!     It MUST NOT mutate canonical state.
//!   - Hybrid scoring: `finalScore = LEX_WEIGHT*lex + SEM_WEIGHT*sem +
//!     STRUCT_WEIGHT*struct`. Lex from bm25 (FTS5) normalised by the
//!     candidate-set max; sem from sqlite-vec cosine similarity over
//!     BGE-small embeddings; structural rerank is still 0 pending
//!     graph-aware reranker work (Spec §11.1 carry-over).
//!   - All public methods return `RetrievalError` so the bridge layer can
//!     map to typed error codes.

use crate::index_service::{IndexService, NeighborHit, SearchHit};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

pub const INTERFACE_ID: &str = "retrieval.v1";
// 1.0.0 → 1.1.0 — additive: `scoreSemantic` is now populated (was always
// 0). `finalScore` formula changes from `= scoreLexical` to a weighted
// sum; consumers ranking on `finalScore` get better results without
// any code change.
pub const INTERFACE_VERSION: &str = "1.1.0";

/// Fusion weights — Spec §11.1. Lexical and semantic are co-equal so
/// neither dominates; structural is reserved for the graph-aware
/// reranker (currently 0, summing only to 0.8 so adding it later is
/// just a constant bump in the structural component).
const LEX_WEIGHT: f64 = 0.4;
const SEM_WEIGHT: f64 = 0.4;
const _STRUCT_WEIGHT: f64 = 0.2; // wired when structural reranker lands

/// Over-fetch factor: pull this many times `limit` from each leg
/// before fusion, so the union has enough candidates for the top-K to
/// settle. 3× is the same factor B-020 §6.4 modelled.
const CANDIDATE_FACTOR: i64 = 3;

#[derive(Debug, thiserror::Error)]
pub enum RetrievalError {
    #[error("E_RETRIEVAL_QUERY_INVALID: {0}")]
    QueryInvalid(String),
    #[error("E_RETRIEVAL_INDEX: {0}")]
    Index(#[from] crate::index_service::IndexError),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultItem {
    pub node_id: String,
    pub r#type: String,
    pub title: Option<String>,
    pub snippet: String,
    pub score_lexical: f64,
    pub score_semantic: f64,
    pub score_structural: f64,
    pub final_score: f64,
    pub evidence_ids: Vec<String>,
    pub updated_at_utc: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub seeds: Vec<String>,
    pub results: Vec<SearchResultItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeighborItem {
    pub node_id: String,
    pub r#type: String,
    pub title: Option<String>,
    pub snippet: String,
    pub hop: u8,
    pub via_predicate: String,
    pub updated_at_utc: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeighborsResponse {
    pub seed_id: String,
    pub depth: u8,
    pub neighbors: Vec<NeighborItem>,
}

/// Read-only retrieval service. Holds an `Arc<IndexService>` so it can be
/// constructed both inside the desktop host (alongside the writer) and in
/// the read-only stdio binary (alongside a read-only opener).
pub struct RetrievalService {
    index: Arc<IndexService>,
}

impl RetrievalService {
    pub fn new(index: Arc<IndexService>) -> Self {
        Self { index }
    }

    /// `retrieval.search` — hybrid bm25 + vector pass over the index.
    /// Both legs over-fetch by `CANDIDATE_FACTOR`, the union is scored
    /// `LEX_WEIGHT*lex_norm + SEM_WEIGHT*sem`, and the top `limit` are
    /// returned. `lex_norm` is the FTS rank divided by the candidate
    /// set's max rank (clamped to [0, 1]); semantic score is the
    /// cosine similarity sqlite-vec returns. If the embedder isn't
    /// available, the semantic leg returns empty and the fusion
    /// collapses cleanly to pure-FTS behaviour.
    pub fn search(
        &self,
        query: &str,
        type_filter: Option<&str>,
        limit: i64,
    ) -> Result<SearchResponse, RetrievalError> {
        if query.trim().is_empty() {
            return Ok(SearchResponse {
                seeds: Vec::new(),
                results: Vec::new(),
            });
        }
        let candidate_limit = limit.saturating_mul(CANDIDATE_FACTOR).max(limit);

        let lex_hits = self.index.search_fts(query, type_filter, candidate_limit)?;
        let max_lex = lex_hits
            .iter()
            .map(|h| h.score)
            .fold(0.0_f64, f64::max)
            .max(1e-9);

        // Map node_id → (best lex score, normalised; hit row for the
        // result projection). We seed with FTS hits because they carry
        // title/snippet/type/timestamp — we re-use them rather than
        // round-tripping back to the DB for every candidate.
        let mut by_id: HashMap<String, FusionRow> = HashMap::new();
        for h in lex_hits {
            let lex_norm = (h.score / max_lex).clamp(0.0, 1.0);
            by_id.insert(
                h.node_id.clone(),
                FusionRow {
                    lex: lex_norm,
                    sem: 0.0,
                    hit: Some(h),
                },
            );
        }

        // Semantic leg. embed_text returns None if no model loaded;
        // search_semantic returns empty in that case. type_filter is
        // applied as a post-filter on the candidate set — vec0 has no
        // server-side filter, but we already know the types from the
        // lex hits and can fetch the rest with one bulk lookup below.
        if let Some(qvec) = self.index.embed_text(query) {
            let sem_hits = self.index.search_semantic(&qvec, candidate_limit as usize)?;
            // For sem-only candidates (not in the lex set), look up
            // the node row so we can render a title + type. One bulk
            // round-trip keeps this O(1) DB calls regardless of K.
            // Candidate counts are bounded by `candidate_limit`
            // (typically ~30), so per-id lookups are cheap and there's
            // no bulk getter on IndexService yet. If this ever shows
            // up in a profile, add `index.get_nodes_basic` and keep
            // it server-side.
            let mut unknown_lookup: HashMap<String, crate::index_service::GraphNode> =
                HashMap::new();
            for s in &sem_hits {
                if by_id.contains_key(&s.node_id) {
                    continue;
                }
                if let Some(node) = self.index.get_node_by_id(&s.node_id)? {
                    unknown_lookup.insert(s.node_id.clone(), node);
                }
            }

            for s in sem_hits {
                if let Some(row) = by_id.get_mut(&s.node_id) {
                    row.sem = s.score as f64;
                } else if let Some(node) = unknown_lookup.get(&s.node_id) {
                    // type_filter check — keep the fusion path
                    // consistent with the FTS leg.
                    if let Some(t) = type_filter {
                        if node.r#type != t {
                            continue;
                        }
                    }
                    by_id.insert(
                        s.node_id.clone(),
                        FusionRow {
                            lex: 0.0,
                            sem: s.score as f64,
                            hit: Some(SearchHit {
                                node_id: s.node_id.clone(),
                                r#type: node.r#type.clone(),
                                title: node.title.clone(),
                                // No FTS snippet for sem-only hits — use
                                // the title (or empty) so the chip
                                // tooltip still renders. Generating a
                                // snippet would require running FTS
                                // again with a different query.
                                snippet: node.title.clone().unwrap_or_default(),
                                score: 0.0,
                                updated_at_utc: node.updated_at_utc.clone(),
                            }),
                        },
                    );
                }
            }
        }

        // Fuse, sort, truncate.
        let mut fused: Vec<SearchResultItem> = by_id
            .into_iter()
            .filter_map(|(_id, row)| {
                let hit = row.hit?;
                let final_score = LEX_WEIGHT * row.lex + SEM_WEIGHT * row.sem;
                Some(SearchResultItem {
                    node_id: hit.node_id,
                    r#type: hit.r#type,
                    title: hit.title,
                    snippet: hit.snippet,
                    score_lexical: row.lex,
                    score_semantic: row.sem,
                    score_structural: 0.0,
                    final_score,
                    evidence_ids: Vec::new(),
                    updated_at_utc: hit.updated_at_utc,
                })
            })
            .collect();
        fused.sort_by(|a, b| {
            b.final_score
                .partial_cmp(&a.final_score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        fused.truncate(limit.max(0) as usize);

        Ok(SearchResponse {
            seeds: Vec::new(),
            results: fused,
        })
    }

    /// `retrieval.trace` — return the immediate neighbours of a target.
    pub fn trace(
        &self,
        target_id: &str,
        depth: u8,
        limit: usize,
    ) -> Result<NeighborsResponse, RetrievalError> {
        if target_id.trim().is_empty() {
            return Err(RetrievalError::QueryInvalid("missing targetId".into()));
        }
        let neighbors = self.index.expand_subgraph(target_id, depth, limit)?;
        Ok(NeighborsResponse {
            seed_id: target_id.to_string(),
            depth,
            neighbors: neighbors.into_iter().map(into_neighbor_item).collect(),
        })
    }
}

/// Internal staging row used while merging FTS and vector hits.
struct FusionRow {
    /// Normalised lexical score in [0, 1] (FTS bm25 / max-bm25).
    lex: f64,
    /// Cosine similarity in [0, 1] (sqlite-vec).
    sem: f64,
    /// Source hit row — carries the projection metadata so we don't
    /// have to round-trip the DB twice for already-seen nodes.
    hit: Option<SearchHit>,
}

fn into_neighbor_item(n: NeighborHit) -> NeighborItem {
    NeighborItem {
        node_id: n.node_id,
        r#type: n.r#type,
        title: n.title,
        snippet: n.snippet,
        hop: n.hop,
        via_predicate: n.via_predicate,
        updated_at_utc: n.updated_at_utc,
    }
}
