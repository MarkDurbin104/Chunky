//! `workspace.v1` 1.0.0 — canonical workspace I/O.
//!
//! Owns:
//!   - `<appData>/drafts/<id>.json`
//!   - `<appData>/kb/<type>s/<id>.{json,md}`
//!
//! Per Module Isolation §3.2 / §7.4, this is the SOLE module that writes to
//! those paths. Other modules read via `read_node` / `list`; nobody writes
//! through the back door. (Closes Implementation Status & Shortfalls §2 #2.)
//!
//! ## B-019 deviation note
//!
//! TRP B-019 §4.3 specifies a typed `WorkspaceService` struct with method-shape
//! signatures (`list(filters: ListFilters) -> Result<ListResponse, _>` etc.).
//! This implementation pass instead exposes module-level functions that take
//! `(app: AppHandle, payload: RequestEnvelope<Value>)` and return
//! `ResponseEnvelope<Value>` — the same shape the Tauri handlers had inline.
//! The architectural goal ("single owner of workspace I/O") is met: a grep for
//! `fs::write|fs::rename|fs::remove_file` inside `shell_bridge.rs::workspace_*`
//! returns nothing. The structural-purity refinement (typed I/O, Service
//! struct + Arc state) is a follow-up that doesn't block any downstream TRP.

use crate::index_service::IndexService;
use crate::shell_bridge::{append_audit, write_atomic, RequestEnvelope, ResponseEnvelope};
use chrono::Utc;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;
use uuid::Uuid;

pub const INTERFACE_ID: &str = "workspace.v1";
pub const INTERFACE_VERSION: &str = "1.0.0";

// === Edge predicate constants (B-018) ===
// Closed set. Renaming any of these requires a migration over every saved
// document / Epic — see TRP B-018 §1.2 / §8 freeze.
//
// Source-of-truth schema: `schemas/contracts/edge.predicates.v1.json`. The
// TS-side contract test at `src/ui-app/src/__tests__/edge-predicates.contract.test.ts`
// pins the schema enum against a hand-listed copy of these strings. Any
// addition / rename here MUST update the schema and the test list together
// (lessons-learned §1 closed-set discipline).
pub const PRED_CITES: &str = "cites";
pub const PRED_ASSEMBLES: &str = "assembles";
pub const PRED_REFERENCES: &str = "references";
pub const PRED_STYLE_GUIDES: &str = "style-guides";
pub const PRED_BELONGS_TO_PI: &str = "belongs-to-pi";
pub const PRED_CONTAINS: &str = "contains";

// =============================================================================
// Path helpers
// =============================================================================

/// Resolve the writable drafts directory under the app's data dir, creating it
/// if missing.
pub fn drafts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    let drafts = base.join("drafts");
    fs::create_dir_all(&drafts)
        .map_err(|e| format!("failed to create drafts dir {drafts:?}: {e}"))?;
    Ok(drafts)
}

/// Map a node type to its canonical `kb/<type>s/` folder, creating it if
/// missing. Per Spec §8, every entity type gets its own pluralised folder.
pub fn kb_dir_for_type(app: &tauri::AppHandle, node_type: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    let folder = format!("{node_type}s");
    let dir = base.join("kb").join(&folder);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {dir:?}: {e}"))?;
    Ok(dir)
}

// =============================================================================
// Searchable-text derivation (used by upsert + promote + future reindex)
// =============================================================================

// Re-export from the shared util so existing call sites in this module
// keep working without an explicit `crate::` qualifier on every use.
// The actual implementation (and tests) live in `crate::searchable_text`.
// REM-022 deduped a previous byte-identical copy in `index_service`.
pub use crate::searchable_text::derive_searchable_text;

// =============================================================================
// Directory scan with filter logic (factored from workspace_list per A-017 §6.2)
// =============================================================================

/// Walk a directory of draft/canonical JSON files and return list-shape
/// items, applying optional `type_filter` and `pi_filter`. Items without
/// a `piId` resolvable from disk are excluded from a piId-filtered
/// listing.
///
/// `piId` lives **inside** `draft.jsonld` — which is itself stored as a
/// stringified JSON blob — because the writer (`upsert_draft`) accepts
/// the JSON-LD body as an opaque string and the closed-set fields like
/// `piId` are part of that body. To filter, we parse the jsonld string
/// per record and look up `piId` there. (Falls back to `draft.piId` for
/// the rare case where a caller chose to mirror the field at the draft
/// level — the synthesized v1 fixtures do this.)
pub fn list_walk(
    path: &Path,
    type_filter: Option<&str>,
    pi_filter: Option<&str>,
    kind_label: &str,
) -> Vec<serde_json::Value> {
    let mut items: Vec<serde_json::Value> = Vec::new();
    let Ok(entries) = fs::read_dir(path) else {
        return items;
    };
    for entry in entries.flatten() {
        let entry_path = entry.path();
        if entry_path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = fs::read(&entry_path) else {
            continue;
        };
        let Ok(record): Result<serde_json::Value, _> = serde_json::from_slice(&bytes) else {
            continue;
        };
        let draft = record.get("draft");
        let node_type = draft
            .and_then(|d| d.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if let Some(t) = type_filter {
            if node_type != t {
                continue;
            }
        }
        // Resolve piId from the jsonld string first; fall back to a
        // top-level draft.piId mirror when present.
        let pi_from_jsonld: Option<String> = draft
            .and_then(|d| d.get("jsonld"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .and_then(|v| {
                v.get("piId")
                    .and_then(|p| p.as_str())
                    .map(|s| s.to_string())
            });
        let pi_from_draft: Option<String> = draft
            .and_then(|d| d.get("piId"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let node_pi_id = pi_from_jsonld.or(pi_from_draft);
        if let Some(p) = pi_filter {
            if node_pi_id.as_deref() != Some(p) {
                continue;
            }
        }
        let mut item = json!({
            "id": record.get("id"),
            "type": node_type,
            "title": draft.and_then(|d| d.get("title")),
            "updatedAtUtc": record.get("updatedAtUtc"),
            "kind": kind_label,
            "path": entry_path.to_string_lossy(),
        });
        if let Some(p) = node_pi_id {
            if let Some(obj) = item.as_object_mut() {
                obj.insert("piId".to_string(), serde_json::Value::String(p));
            }
        }
        if let Some(js) = draft.and_then(|d| d.get("jsonld")).and_then(|v| v.as_str()) {
            if let Some(obj) = item.as_object_mut() {
                obj.insert("jsonld".to_string(), serde_json::Value::String(js.to_string()));
            }
        }
        items.push(item);
    }
    items
}

// =============================================================================
// Markdown mirror
// =============================================================================

/// Render a draft as a Markdown mirror with YAML frontmatter so canonical
/// content can be inspected and Git-diffed without parsing JSON.
pub fn build_markdown_mirror(
    node_type: &str,
    title: &str,
    id: &str,
    draft: &serde_json::Value,
    promoted_at: &str,
    decision_id: &str,
) -> String {
    let body_text =
        derive_searchable_text(draft.get("bodyMd").and_then(|v| v.as_str()).unwrap_or(""));
    format!(
        "---\nid: {id}\ntype: {ntype}\ntitle: {title}\nupdatedAtUtc: {ts}\npolicyDecisionId: {dec}\n---\n\n# {title}\n\n{body}\n",
        id = id,
        ntype = node_type,
        title = title.replace('\n', " "),
        ts = promoted_at,
        dec = decision_id,
        body = body_text.trim(),
    )
}

// =============================================================================
// Edge derivation (B-018)
// =============================================================================

/// Parse `[<uuid-v4>]` citation chips out of an arbitrary string (markdown
/// or stringified BlockNote JSON). Returns lowercased uuids, deduplicated,
/// in first-seen order.
pub fn parse_uuid_citations(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'[' {
            i += 1;
            continue;
        }
        let start = i + 1;
        let end = start + 36;
        if end >= bytes.len() || bytes[end] != b']' {
            i += 1;
            continue;
        }
        let candidate = &bytes[start..end];
        if is_uuid_like(candidate) {
            let id = std::str::from_utf8(candidate)
                .unwrap_or("")
                .to_ascii_lowercase();
            if !id.is_empty() && seen.insert(id.clone()) {
                out.push(id);
            }
            i = end + 1;
        } else {
            i += 1;
        }
    }
    out
}

fn is_uuid_like(b: &[u8]) -> bool {
    if b.len() != 36 {
        return false;
    }
    for (idx, &c) in b.iter().enumerate() {
        match idx {
            8 | 13 | 18 | 23 => {
                if c != b'-' {
                    return false;
                }
            }
            _ => {
                let is_hex = (b'0'..=b'9').contains(&c)
                    || (b'a'..=b'f').contains(&c)
                    || (b'A'..=b'F').contains(&c);
                if !is_hex {
                    return false;
                }
            }
        }
    }
    true
}

/// Pull a string array out of a JSON value at the given key. Returns empty
/// if the field is missing or not an array of strings.
fn json_string_array(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Re-derive the edges originating from (and pointing at, for `style-guides`)
/// the saved node and write them to the index. Called after every
/// `upsert_draft` / `promote_draft` so the edge table is the live mirror of
/// the JSON-LD bodies. Errors are logged and swallowed: the on-disk JSON is
/// the source of truth, so a partial edge state is recoverable on the next
/// save.
pub fn write_edges_for_node(
    index: &Arc<IndexService>,
    id: &str,
    node_type: &str,
    body_md: &str,
    jsonld: &serde_json::Value,
) {
    // style-guides — asymmetric. The consumer's body lists `referenceIds`
    // but the EDGE points reference → consumer. So we read every
    // style-guides edge currently pointing at this consumer, diff against
    // the consumer's latest `referenceIds`, and apply the diff.
    let pinned: Vec<String> = json_string_array(jsonld, "referenceIds");
    let pinned_set: std::collections::HashSet<&str> =
        pinned.iter().map(|s| s.as_str()).collect();
    match index.list_edges_by_dst_and_predicate(id, PRED_STYLE_GUIDES) {
        Ok(existing) => {
            let existing_set: std::collections::HashSet<&str> =
                existing.iter().map(|s| s.as_str()).collect();
            // Drop edges from references no longer pinned.
            for src in &existing {
                if !pinned_set.contains(src.as_str()) {
                    let _ = index.delete_edge(src, PRED_STYLE_GUIDES, id);
                }
            }
            // Add edges for newly pinned references.
            for r in &pinned {
                if !existing_set.contains(r.as_str()) {
                    if let Err(e) = index.replace_edges(r, PRED_STYLE_GUIDES, &[id]) {
                        eprintln!("replace_edges style-guides {r}: {e}");
                    }
                }
            }
        }
        Err(e) => eprintln!("list_edges_by_dst style-guides for {id}: {e}"),
    }

    // 5. belongs-to-pi — for any node with jsonld.piId.
    let pi_id = jsonld.get("piId").and_then(|v| v.as_str());
    if let Some(p) = pi_id {
        if let Err(e) = index.replace_edges(id, PRED_BELONGS_TO_PI, &[p]) {
            eprintln!("replace_edges belongs-to-pi for {id}: {e}");
        }
    } else {
        // No piId set — clear any prior edge.
        if let Err(e) = index.replace_edges(id, PRED_BELONGS_TO_PI, &[]) {
            eprintln!("clear belongs-to-pi for {id}: {e}");
        }
    }

    // (see `rebuild_edges_from_kb` for the startup catch-up path.)

    // 6. contains — project/collection membership. For any asset with
    //    jsonld.projectId or jsonld.collectionId, we write outbound edges
    //    from the parent(s) to the asset so `expand_subgraph(project) ∋ asset`
    //    and the MCP `list_assets_in_project` tool can find them. The edge
    //    lives on the *asset* row so replace_edges keyed by asset id can
    //    idempotently rewrite when the asset moves collections. This means
    //    we write it as `src=assetId, predicate=contains, dst=parentId`
    //    (inverse of the human-reading direction), because
    //    `expand_subgraph` walks edges bi-directionally and NeighborHit.node_id
    //    reports "the other endpoint" — so direction doesn't matter for
    //    retrieval, only for the ability to `replace_edges(asset, contains, ...)`.
    let mut parents: Vec<String> = Vec::new();
    if let Some(p) = jsonld.get("projectId").and_then(|v| v.as_str()) {
        if !p.is_empty() { parents.push(p.to_string()); }
    }
    if let Some(c) = jsonld.get("collectionId").and_then(|v| v.as_str()) {
        if !c.is_empty() { parents.push(c.to_string()); }
    }
    // Never point an edge at yourself (e.g. a project's own jsonld has no
    // projectId, but be defensive).
    parents.retain(|p| p != id);
    let parent_refs: Vec<&str> = parents.iter().map(|s| s.as_str()).collect();
    if let Err(e) = index.replace_edges(id, PRED_CONTAINS, &parent_refs) {
        eprintln!("replace_edges contains for {id}: {e}");
    }
}

/// Walk `<appData>/kb/<type>s/*.json` on startup and re-run edge writers
/// for each canonical node so previously-ingested content picks up any
/// predicates added since the last run (e.g. `contains` after B-020).
/// Idempotent — `replace_edges` writes are transactional deletes+inserts.
pub fn rebuild_edges_from_kb(index: &Arc<IndexService>, kb_dir: &std::path::Path) -> u64 {
    let type_dirs = match std::fs::read_dir(kb_dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut n: u64 = 0;
    for type_entry in type_dirs.flatten() {
        let type_path = type_entry.path();
        if !type_path.is_dir() { continue }
        let entries = match std::fs::read_dir(&type_path) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") { continue }
            let bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let record: serde_json::Value = match serde_json::from_slice(&bytes) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let id = match record.get("id").and_then(|v| v.as_str()) {
                Some(s) if !s.is_empty() => s.to_string(),
                _ => continue,
            };
            let draft = record.get("draft").cloned().unwrap_or_else(|| serde_json::json!({}));
            let draft_type = draft.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if draft_type.is_empty() { continue }
            let body_md_raw = draft.get("bodyMd").and_then(|v| v.as_str()).unwrap_or("");
            let jsonld_str = draft.get("jsonld").and_then(|v| v.as_str()).unwrap_or("{}");
            let jsonld_value: serde_json::Value =
                serde_json::from_str(jsonld_str).unwrap_or(serde_json::Value::Null);
            write_edges_for_node(index, &id, draft_type, body_md_raw, &jsonld_value);
            n += 1;
        }
    }
    n
}

// =============================================================================
// Workspace handlers — the five canonical entry points.
// Bodies moved verbatim from shell_bridge.rs::workspace_* (B-019).
// =============================================================================

pub fn list(
    app: tauri::AppHandle,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    let start = std::time::Instant::now();

    let dir = match drafts_dir(&app) {
        Ok(d) => d,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_WORKSPACE_PATH",
                &e,
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };

    let type_filter = payload
        .payload
        .get("type")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let kind_filter = payload
        .payload
        .get("kind")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let pi_filter = payload
        .payload
        .get("piId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut items: Vec<serde_json::Value> = Vec::new();

    // Drafts directory — include only when kind_filter is unset or "draft".
    if kind_filter.as_deref().map_or(true, |k| k == "draft") {
        items.extend(list_walk(
            &dir,
            type_filter.as_deref(),
            pi_filter.as_deref(),
            "draft",
        ));
    }

    // Canonical kb/<type>s/ subdirectories. Walk one level deep.
    if kind_filter.as_deref().map_or(true, |k| k == "canonical") {
        if let Ok(base) = app.path().app_data_dir() {
            let kb_root = base.join("kb");
            if let Ok(type_dirs) = fs::read_dir(&kb_root) {
                for type_dir_entry in type_dirs.flatten() {
                    let type_dir = type_dir_entry.path();
                    if type_dir.is_dir() {
                        items.extend(list_walk(
                            &type_dir,
                            type_filter.as_deref(),
                            pi_filter.as_deref(),
                            "canonical",
                        ));
                    }
                }
            }
        }
    }

    // Sort newest-first by updatedAtUtc string compare (ISO-8601 sorts lexically).
    items.sort_by(|a, b| {
        b.get("updatedAtUtc")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(a.get("updatedAtUtc").and_then(|v| v.as_str()).unwrap_or(""))
    });

    let response = json!({
        "items": items,
        "nextCursor": null,
    });
    let duration_ms = start.elapsed().as_millis() as u64;
    ResponseEnvelope::ok(
        response,
        payload.meta.request_id,
        payload.meta.trace_id,
        duration_ms,
    )
}

pub fn read_node(
    app: tauri::AppHandle,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    let start = std::time::Instant::now();

    let id = payload
        .payload
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if id.is_empty() {
        let duration_ms = start.elapsed().as_millis() as u64;
        return ResponseEnvelope::err(
            "E_WORKSPACE_BAD_INPUT",
            "Missing required field: id",
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    }

    let dir = match drafts_dir(&app) {
        Ok(d) => d,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_WORKSPACE_PATH",
                &e,
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };

    let draft_path = dir.join(format!("{id}.json"));
    let path: PathBuf = if draft_path.exists() {
        draft_path
    } else {
        let mut found: Option<PathBuf> = None;
        if let Ok(base) = app.path().app_data_dir() {
            let kb_root = base.join("kb");
            if let Ok(type_dirs) = fs::read_dir(&kb_root) {
                for entry in type_dirs.flatten() {
                    let candidate = entry.path().join(format!("{id}.json"));
                    if candidate.exists() {
                        found = Some(candidate);
                        break;
                    }
                }
            }
        }
        match found {
            Some(p) => p,
            None => {
                let duration_ms = start.elapsed().as_millis() as u64;
                return ResponseEnvelope::err(
                    "E_WORKSPACE_NOT_FOUND",
                    &format!("No node with id {id}"),
                    payload.meta.request_id,
                    payload.meta.trace_id,
                    duration_ms,
                );
            }
        }
    };
    let Ok(bytes) = fs::read(&path) else {
        let duration_ms = start.elapsed().as_millis() as u64;
        return ResponseEnvelope::err(
            "E_WORKSPACE_NOT_FOUND",
            &format!("No node with id {id}"),
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    };
    let record: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_WORKSPACE_PARSE",
                &format!("parse {path:?}: {e}"),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };

    let duration_ms = start.elapsed().as_millis() as u64;
    ResponseEnvelope::ok(
        record,
        payload.meta.request_id,
        payload.meta.trace_id,
        duration_ms,
    )
}

pub fn upsert_draft(
    app: tauri::AppHandle,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    let start = std::time::Instant::now();
    let index = app.state::<Arc<IndexService>>();

    let dir = match drafts_dir(&app) {
        Ok(d) => d,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_WORKSPACE_PATH",
                &e,
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };

    let draft = payload
        .payload
        .get("draft")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let draft_id = draft
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let updated_at = Utc::now().to_rfc3339();

    let mut path = dir.join(format!("{draft_id}.json"));
    let mut is_canonical = false;
    let mut canonical_md: Option<PathBuf> = None;
    if let Ok(base) = app.path().app_data_dir() {
        let kb_root = base.join("kb");
        if let Ok(type_dirs) = fs::read_dir(&kb_root) {
            for entry in type_dirs.flatten() {
                let candidate = entry.path().join(format!("{draft_id}.json"));
                if candidate.exists() {
                    path = candidate;
                    canonical_md = Some(entry.path().join(format!("{draft_id}.md")));
                    is_canonical = true;
                    break;
                }
            }
        }
    }

    // Build the on-disk record. When the file already exists in `kb/`
    // (i.e. previously promoted), preserve every top-level field that
    // promotion added (`kind`, `policyDecisionId`) so a re-edit doesn't
    // silently strip them. The `draft` and `updatedAtUtc` fields are
    // always overwritten.
    let mut record = if is_canonical {
        match fs::read(&path).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) {
            Some(existing) => existing,
            None => json!({}),
        }
    } else {
        json!({})
    };
    if let Some(obj) = record.as_object_mut() {
        obj.insert("id".to_string(), json!(draft_id));
        obj.insert("draft".to_string(), draft.clone());
        obj.insert("updatedAtUtc".to_string(), json!(updated_at));
        obj.insert("actor".to_string(), json!(payload.meta.caller));
    } else {
        record = json!({
            "id": draft_id,
            "draft": draft,
            "updatedAtUtc": updated_at,
            "actor": payload.meta.caller,
        });
    }

    let bytes = match serde_json::to_vec(&record) {
        Ok(b) => b,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_WORKSPACE_SERIALIZE",
                &format!("serde_json: {e}"),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };
    if let Err(e) = write_atomic(&path, &bytes) {
        let duration_ms = start.elapsed().as_millis() as u64;
        return ResponseEnvelope::err(
            "E_WORKSPACE_WRITE",
            &format!("write {path:?}: {e}"),
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    }

    if is_canonical {
        if let Some(md_path) = &canonical_md {
            let node_type = draft
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("draft");
            let title = draft
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("(untitled)");
            let md = build_markdown_mirror(node_type, title, &draft_id, &draft, &updated_at, "");
            let _ = fs::write(md_path, md.as_bytes());
        }
    }

    let draft_type = draft
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("draft")
        .to_string();
    let title = draft
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let body_md_raw = draft
        .get("bodyMd")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let searchable_body = derive_searchable_text(body_md_raw);
    let jsonld_str = match draft.get("jsonld").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => serde_json::to_string(&draft).unwrap_or_else(|_| "{}".to_string()),
    };

    if let Err(e) = index.upsert_node(
        &draft_id,
        &draft_type,
        title.as_deref(),
        Some(&searchable_body),
        Some(body_md_raw),
        &jsonld_str,
        Some(&path.to_string_lossy()),
        &updated_at,
    ) {
        eprintln!("index upsert for {draft_id} failed: {e}");
    }

    // B-018: re-derive edges from the freshly-saved body.
    let jsonld_value: serde_json::Value =
        serde_json::from_str(&jsonld_str).unwrap_or(serde_json::Value::Null);
    write_edges_for_node(&index, &draft_id, &draft_type, body_md_raw, &jsonld_value);

    let response = json!({
        "draftId": draft_id,
        "updatedAtUtc": updated_at,
        "path": path.to_string_lossy(),
    });
    let duration_ms = start.elapsed().as_millis() as u64;
    ResponseEnvelope::ok(
        response,
        payload.meta.request_id,
        payload.meta.trace_id,
        duration_ms,
    )
}

pub fn promote_draft(
    app: tauri::AppHandle,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    let start = std::time::Instant::now();
    let index = app.state::<Arc<IndexService>>();

    let draft_id = payload
        .payload
        .get("draftId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if draft_id.is_empty() {
        let duration_ms = start.elapsed().as_millis() as u64;
        return ResponseEnvelope::err(
            "E_WORKSPACE_BAD_INPUT",
            "Missing required field: draftId",
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    }

    let drafts = match drafts_dir(&app) {
        Ok(d) => d,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_WORKSPACE_PATH",
                &e,
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };
    let draft_path = drafts.join(format!("{draft_id}.json"));
    let bytes = match fs::read(&draft_path) {
        Ok(b) => b,
        Err(_) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_WORKSPACE_NOT_FOUND",
                &format!("No draft with id {draft_id}"),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };
    let record: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_WORKSPACE_PARSE",
                &format!("parse {draft_path:?}: {e}"),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };

    let draft = record
        .get("draft")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let node_type = draft
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("draft")
        .to_string();
    let title = draft
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("(untitled)")
        .to_string();

    let canonical_dir = match kb_dir_for_type(&app, &node_type) {
        Ok(d) => d,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_WORKSPACE_PATH",
                &e,
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };
    let canonical_json = canonical_dir.join(format!("{draft_id}.json"));
    let canonical_md = canonical_dir.join(format!("{draft_id}.md"));

    let decision_id = Uuid::new_v4().to_string();
    let promoted_at = Utc::now().to_rfc3339();
    append_audit(
        &app,
        "workspace.promoteDraft",
        json!({
            "actor": payload.meta.caller,
            "decisionId": decision_id,
            "draftId": draft_id,
            "nodeType": node_type,
            "canonicalPath": canonical_json.to_string_lossy(),
            "promotedAtUtc": promoted_at,
        }),
    );

    let mut canonical_record = record.clone();
    if let Some(obj) = canonical_record.as_object_mut() {
        obj.insert("kind".to_string(), json!("canonical"));
        obj.insert("updatedAtUtc".to_string(), json!(promoted_at));
        obj.insert("policyDecisionId".to_string(), json!(decision_id));
    }
    let json_bytes = match serde_json::to_vec(&canonical_record) {
        Ok(b) => b,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_WORKSPACE_SERIALIZE",
                &format!("serde_json: {e}"),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };
    if let Err(e) = write_atomic(&canonical_json, &json_bytes) {
        let duration_ms = start.elapsed().as_millis() as u64;
        return ResponseEnvelope::err(
            "E_WORKSPACE_WRITE",
            &format!("write {canonical_json:?}: {e}"),
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    }

    let md_body =
        build_markdown_mirror(&node_type, &title, &draft_id, &draft, &promoted_at, &decision_id);
    let _ = fs::write(&canonical_md, md_body.as_bytes());

    let _ = fs::remove_file(&draft_path);

    let body_md_raw = draft.get("bodyMd").and_then(|v| v.as_str()).unwrap_or("");
    let searchable = derive_searchable_text(body_md_raw);
    let jsonld_str = match draft.get("jsonld").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => serde_json::to_string(&draft).unwrap_or_else(|_| "{}".to_string()),
    };
    let _ = index.upsert_node(
        &draft_id,
        &node_type,
        Some(&title),
        Some(&searchable),
        Some(body_md_raw),
        &jsonld_str,
        Some(&canonical_json.to_string_lossy()),
        &promoted_at,
    );

    // B-018: re-derive edges after the canonical write.
    let jsonld_value: serde_json::Value =
        serde_json::from_str(&jsonld_str).unwrap_or(serde_json::Value::Null);
    write_edges_for_node(&index, &draft_id, &node_type, body_md_raw, &jsonld_value);

    let duration_ms = start.elapsed().as_millis() as u64;
    ResponseEnvelope::ok(
        json!({
            "nodeId": draft_id,
            "canonicalPath": canonical_json.to_string_lossy(),
            "markdownPath": canonical_md.to_string_lossy(),
            "policyDecisionId": decision_id,
            "promotedAtUtc": promoted_at,
        }),
        payload.meta.request_id,
        payload.meta.trace_id,
        duration_ms,
    )
}

pub fn delete_node(
    app: tauri::AppHandle,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    let start = std::time::Instant::now();
    let index = app.state::<Arc<IndexService>>();

    let id = payload
        .payload
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        let duration_ms = start.elapsed().as_millis() as u64;
        return ResponseEnvelope::err(
            "E_WORKSPACE_BAD_INPUT",
            "Missing required field: id",
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    }

    let mut deleted_paths: Vec<PathBuf> = Vec::new();
    if let Ok(drafts) = drafts_dir(&app) {
        let p = drafts.join(format!("{id}.json"));
        if p.exists() && fs::remove_file(&p).is_ok() {
            deleted_paths.push(p);
        }
    }
    if let Ok(base) = app.path().app_data_dir() {
        let kb_root = base.join("kb");
        if let Ok(type_dirs) = fs::read_dir(&kb_root) {
            for entry in type_dirs.flatten() {
                for ext in ["json", "md"] {
                    let candidate = entry.path().join(format!("{id}.{ext}"));
                    if candidate.exists() && fs::remove_file(&candidate).is_ok() {
                        deleted_paths.push(candidate);
                    }
                }
            }
        }
    }

    // B-018: clear edges sourced from this node before deleting the row.
    // The schema has no FK; cascade is explicit.
    let _ = index.delete_edges_by_src(&id);
    let _ = index.delete_node(&id);

    append_audit(
        &app,
        "workspace.deleteNode",
        json!({
            "actor": payload.meta.caller,
            "id": id,
            "deletedPaths": deleted_paths.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
            "deletedAtUtc": Utc::now().to_rfc3339(),
        }),
    );

    let duration_ms = start.elapsed().as_millis() as u64;
    ResponseEnvelope::ok(
        json!({
            "id": id,
            "deletedPaths": deleted_paths.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
        }),
        payload.meta.request_id,
        payload.meta.trace_id,
        duration_ms,
    )
}
