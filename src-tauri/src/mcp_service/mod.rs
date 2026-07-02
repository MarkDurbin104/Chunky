//! `mcp.v1` (1.0.1) — read-only subset of the MCP tool surface.
//!
//! Implements the contract from
//! `docs/interfaces/Method Prototypes - Interface Contracts.md` §9 and the
//! topology rules from
//! `docs/Module Isolation and Interface Contract - Semantic Product Lifecycle.md`
//! §7.8:
//!
//!   - `mcp-service` may call `retrieval-service`, `index-service` (read-only),
//!     and `policy-engine`. It MUST NOT bypass `policy-engine` for write
//!     tools — write tools are deliberately NOT exposed by this round 1
//!     implementation.
//!   - Every tool response MUST include a `provenance` reference (§7.8
//!     Constraint). The version bump from `1.0.0` → `1.0.1` is a **patch**
//!     because the contract always required this; round 1 of the chat
//!     sidecar shipped without it, this module brings the implementation
//!     in line.
//!
//! ## Tool surface (round 1 — read-only subset)
//!
//! | Tool                | Maps to                              |
//! |---------------------|---------------------------------------|
//! | `search_nodes`      | `retrieval.search`                    |
//! | `get_node`          | `index.getNodeById`                   |
//! | `get_neighbors`     | `index.expandSubgraph` via `retrieval.trace` |
//!
//! Write tools (`upsert_draft_node`, `synthesize_epic`) and the structural
//! tools (`impact_analysis`, `traceability_report`, `detect_content_gaps`)
//! are intentionally absent from this build — they require either the
//! policy-engine gate (writes) or compositions that are out of scope for
//! the initial chat tool-use round. Adding any of them requires a paired
//! update to E-010 / E-021 plus a minor version bump (1.0.x → 1.1.0).

use crate::index_service::{IndexService, IndexError};
use crate::retrieval_service::{RetrievalError, RetrievalService};
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub const INTERFACE_ID: &str = "mcp.v1";
pub const INTERFACE_VERSION: &str = "1.1.0";

#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("E_MCP_TOOL_NOT_FOUND: {0}")]
    ToolNotFound(String),
    #[error("E_MCP_SCHEMA_INVALID: {0}")]
    SchemaInvalid(String),
    #[error("E_MCP_TOOL_EXECUTION: {0}")]
    Execution(String),
}

impl From<RetrievalError> for McpError {
    fn from(value: RetrievalError) -> Self {
        match value {
            RetrievalError::QueryInvalid(m) => McpError::SchemaInvalid(m),
            RetrievalError::Index(e) => McpError::Execution(format!("index: {e}")),
        }
    }
}

impl From<IndexError> for McpError {
    fn from(value: IndexError) -> Self {
        McpError::Execution(format!("index: {value}"))
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub source: String,            // e.g. "mcp.search_nodes"
    pub timestamp_utc: String,
    pub interface_id: String,      // "mcp.v1"
    pub interface_version: String, // "1.0.1"
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub node_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolResult {
    pub tool_name: String,
    pub output: Value,
    pub provenance: Provenance,
    /// Optional MCP `content` blocks to emit verbatim instead of
    /// the default text-wrapping of `output`. Image tools populate
    /// this with one or more `{ type: "image", data, mimeType }`
    /// entries so Claude Desktop's vision-enabled tools can see
    /// the bytes. When `None`, mcp_stdio falls back to
    /// `[{type:'text', text: <pretty JSON of the result>}]`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_blocks: Option<Vec<Value>>,
}

pub struct McpService {
    retrieval: Arc<RetrievalService>,
    index: Arc<IndexService>,
}

impl McpService {
    pub fn new(retrieval: Arc<RetrievalService>, index: Arc<IndexService>) -> Self {
        Self { retrieval, index }
    }

    pub fn list_tools(&self) -> Vec<ToolDescriptor> {
        canonical_tools()
    }

    /// `mcp.invokeTool` — dispatch to the read-only tool implementations.
    /// All responses are wrapped in `McpToolResult` with a populated
    /// `provenance` block per §7.8.
    pub fn invoke_tool(
        &self,
        tool_name: &str,
        input: &Value,
    ) -> Result<McpToolResult, McpError> {
        match tool_name {
            "search_nodes" => self.tool_search_nodes(input),
            "get_node" => self.tool_get_node(input),
            "get_nodes" => self.tool_get_nodes(input),
            "get_neighbors" => self.tool_get_neighbors(input),
            "list_assets_in_project" => self.tool_list_assets_in_project(input),
            "list_nodes_by_type" => self.tool_list_nodes_by_type(input),
            "list_node_images" => self.tool_list_node_images(input),
            "get_image" => self.tool_get_image(input),
            other => Err(McpError::ToolNotFound(other.to_string())),
        }
    }

    fn tool_list_assets_in_project(&self, input: &Value) -> Result<McpToolResult, McpError> {
        let project_id = require_str(input, "projectId")?;
        let limit = input
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(200)
            .clamp(1, 500);
        // Fetch all nodes that have a `contains` edge from this project.
        let neighbours = self.index.expand_subgraph(project_id, 1, limit as usize)?;
        let asset_ids: Vec<String> = neighbours
            .iter()
            .filter(|n| n.via_predicate == "contains")
            .map(|n| n.node_id.clone())
            .collect();
        let mut node_ids: Vec<String> = Vec::new();
        let mut output_items: Vec<Value> = Vec::new();
        for id in asset_ids {
            let Ok(Some(node)) = self.index.get_node_by_id(&id) else { continue };
            let parsed: serde_json::Value = node
                .jsonld
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(serde_json::Value::Null);
            let summary = parsed.get("summary").and_then(|v| v.as_str()).map(String::from);
            let key_points = parsed.get("keyPoints").cloned();
            let mut item = json!({
                "id": node.id,
                "type": node.r#type,
                "title": node.title,
                "updatedAtUtc": node.updated_at_utc,
                "summary": summary,
            });
            if let Some(kp) = key_points {
                if let Some(obj) = item.as_object_mut() {
                    obj.insert("keyPoints".to_string(), kp);
                }
            }
            output_items.push(item);
            node_ids.push(node.id);
        }
        let output = json!({
            "projectId": project_id,
            "assets": output_items,
        });
        Ok(McpToolResult {
            tool_name: "list_assets_in_project".into(),
            output,
            provenance: provenance_for("list_assets_in_project", node_ids),
            content_blocks: None,
        })
    }

    fn tool_list_nodes_by_type(&self, input: &Value) -> Result<McpToolResult, McpError> {
        let type_filter: Option<String> = input
            .get("type")
            .and_then(|v| v.as_str())
            .map(String::from);
        let project_id: Option<String> = input
            .get("projectId")
            .and_then(|v| v.as_str())
            .map(String::from);
        let limit = input
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(100)
            .clamp(1, 500);
        let node_type = type_filter.as_deref().unwrap_or("note");
        let rows = self.index.list_nodes_by_type(node_type, limit)?;
        let mut node_ids: Vec<String> = Vec::new();
        let mut output_items: Vec<Value> = Vec::new();
        for row in rows {
            let parsed: serde_json::Value =
                serde_json::from_str(&row.jsonld).unwrap_or(serde_json::Value::Null);
            // If projectId filter is set, only return nodes whose jsonld.projectId matches.
            if let Some(ref pid) = project_id {
                let row_pid = parsed.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
                if row_pid != pid {
                    continue;
                }
            }
            let summary = parsed.get("summary").and_then(|v| v.as_str()).map(String::from);
            let key_points = parsed.get("keyPoints").cloned();
            let mut item = json!({
                "id": row.id,
                "type": row.r#type,
                "title": row.title,
                "updatedAtUtc": row.updated_at_utc,
                "summary": summary,
            });
            if let Some(kp) = key_points {
                if let Some(obj) = item.as_object_mut() {
                    obj.insert("keyPoints".to_string(), kp);
                }
            }
            output_items.push(item);
            node_ids.push(row.id);
        }
        let output = json!({ "nodes": output_items });
        Ok(McpToolResult {
            tool_name: "list_nodes_by_type".into(),
            output,
            provenance: provenance_for("list_nodes_by_type", node_ids),
            content_blocks: None,
        })
    }

    fn tool_search_nodes(&self, input: &Value) -> Result<McpToolResult, McpError> {
        let query = require_str(input, "query")?;
        let limit = input
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(25)
            .clamp(1, 50);
        let type_filter: Option<String> = input
            .get("types")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.iter().find_map(|x| x.as_str().map(String::from)));

        let response =
            self.retrieval
                .search(query, type_filter.as_deref(), limit)?;
        let node_ids: Vec<String> = response
            .results
            .iter()
            .map(|r| r.node_id.clone())
            .collect();
        // Per-hit augmentation: enrich the bare search response with
        // `summary` + `keyPoints` from each node's jsonld so the
        // chat agent can often answer directly from the search
        // payload without a follow-up `get_node` round-trip.
        // Cheap: one read_node per hit (bounded by `limit`), the
        // jsonld is small (~few KB), and the index lookup is by
        // primary key.
        let mut output_value = serde_json::to_value(&response)
            .map_err(|e| McpError::Execution(format!("serialise: {e}")))?;
        if let Some(results) = output_value
            .get_mut("results")
            .and_then(|v| v.as_array_mut())
        {
            for result in results.iter_mut() {
                let nid = result
                    .get("nodeId")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let Some(nid) = nid else { continue };
                let Ok(Some(node)) = self.index.get_node_by_id(&nid) else {
                    continue;
                };
                let Some(j_raw) = node.jsonld else { continue };
                let Ok(j) = serde_json::from_str::<serde_json::Value>(&j_raw) else {
                    continue;
                };
                if let Some(obj) = result.as_object_mut() {
                    if let Some(summary) = j.get("summary") {
                        obj.insert("summary".into(), summary.clone());
                    }
                    if let Some(key_points) = j.get("keyPoints") {
                        obj.insert("keyPoints".into(), key_points.clone());
                    }
                }
            }
        }

        Ok(McpToolResult {
            tool_name: "search_nodes".into(),
            output: output_value,
            provenance: provenance_for("search_nodes", node_ids),
            content_blocks: None,
        })
    }

    fn tool_get_node(&self, input: &Value) -> Result<McpToolResult, McpError> {
        let id = require_str(input, "id")?;
        // The chat agent's body-budget for tool output is the
        // single biggest contributor to chat-turn latency on long
        // references (the Captivate TechRef is 1.8 MB of body
        // text). Cap the returned `bodyMd` to 8 KB by default and
        // tell the model the truncation happened plus the full
        // length, so it can ask for a different window via `offset`
        // / `length` if it really needs to see more.
        const DEFAULT_BODY_LIMIT: usize = 8 * 1024;
        let want_full = input
            .get("full")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let offset = input
            .get("offset")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;
        let length = input
            .get("length")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize);

        let node = self
            .index
            .get_node_by_id(id)?
            .ok_or_else(|| McpError::Execution(format!("no node with id {id}")))?;
        let node_id = node.id.clone();

        let mut output = serde_json::to_value(&node)
            .map_err(|e| McpError::Execution(format!("serialise: {e}")))?;
        if let (Some(obj), Some(body)) = (output.as_object_mut(), node.body_md.as_deref())
        {
            let total = body.len();
            let limit = length.unwrap_or(DEFAULT_BODY_LIMIT);
            if !want_full && (offset > 0 || total > limit) {
                // Find a char-boundary so we don't slice a multi-
                // byte UTF-8 codepoint.
                let start = offset.min(total);
                let mut end = (start.saturating_add(limit)).min(total);
                while end > start && !body.is_char_boundary(end) {
                    end -= 1;
                }
                let mut s = start;
                while s < end && !body.is_char_boundary(s) {
                    s += 1;
                }
                obj.insert("bodyMd".into(), Value::String(body[s..end].to_string()));
                obj.insert("bodyMdTruncated".into(), Value::Bool(true));
                obj.insert(
                    "bodyMdOffset".into(),
                    Value::Number(serde_json::Number::from(s as u64)),
                );
                obj.insert(
                    "bodyMdLength".into(),
                    Value::Number(serde_json::Number::from((end - s) as u64)),
                );
                obj.insert(
                    "bodyMdTotalLength".into(),
                    Value::Number(serde_json::Number::from(total as u64)),
                );
            }
        }
        Ok(McpToolResult {
            tool_name: "get_node".into(),
            output,
            provenance: provenance_for("get_node", vec![node_id]),
            content_blocks: None,
        })
    }

    /// Bulk variant of `get_node`. Reads up to 50 nodes by id in a single
    /// call so the chat agent doesn't have to chain N round-trips when
    /// the user asks "list and detail all X". Missing ids come back with
    /// `{ id, found: false }` rather than failing the whole call.
    fn tool_get_nodes(&self, input: &Value) -> Result<McpToolResult, McpError> {
        let ids_value = input
            .get("ids")
            .ok_or_else(|| McpError::SchemaInvalid("missing required field: ids".into()))?;
        let ids_array = ids_value
            .as_array()
            .ok_or_else(|| McpError::SchemaInvalid("ids must be an array of strings".into()))?;
        if ids_array.is_empty() {
            return Err(McpError::SchemaInvalid(
                "ids must contain at least one id".into(),
            ));
        }
        if ids_array.len() > 50 {
            return Err(McpError::SchemaInvalid(format!(
                "ids may contain at most 50 entries (got {})",
                ids_array.len()
            )));
        }
        let mut nodes_out: Vec<Value> = Vec::with_capacity(ids_array.len());
        let mut found_ids: Vec<String> = Vec::new();
        for (idx, id_value) in ids_array.iter().enumerate() {
            let id = id_value.as_str().ok_or_else(|| {
                McpError::SchemaInvalid(format!(
                    "ids[{idx}] must be a string"
                ))
            })?;
            if id.is_empty() {
                return Err(McpError::SchemaInvalid(format!(
                    "ids[{idx}] must be a non-empty string"
                )));
            }
            match self.index.get_node_by_id(id)? {
                Some(node) => {
                    found_ids.push(node.id.clone());
                    let node_value = serde_json::to_value(&node)
                        .map_err(|e| McpError::Execution(format!("serialise: {e}")))?;
                    nodes_out.push(node_value);
                }
                None => {
                    nodes_out.push(json!({
                        "id": id,
                        "found": false,
                    }));
                }
            }
        }
        let output = json!({ "nodes": nodes_out });
        Ok(McpToolResult {
            tool_name: "get_nodes".into(),
            output,
            provenance: provenance_for("get_nodes", found_ids),
            content_blocks: None,
        })
    }

    /// `list_node_images` — walk a node's `bodyMd` JSON tree, return
    /// the metadata for every embedded image plus the OCR-extracted
    /// text paragraphs that sit immediately after it. Image bytes
    /// themselves are NOT returned (they're large; clients fetch one
    /// at a time via `get_image`).
    fn tool_list_node_images(&self, input: &Value) -> Result<McpToolResult, McpError> {
        let id = require_str(input, "id")?;
        let node = self
            .index
            .get_node_by_id(id)?
            .ok_or_else(|| McpError::Execution(format!("no node with id {id}")))?;
        let node_id = node.id.clone();
        // Image data lives in the raw BlockNote JSON, not the
        // FTS-friendly flattened `body_md`. Fall through to the
        // flattened text only as a defensive last-resort (won't
        // match — kept so the failure mode is the same "empty list"
        // rather than a panic on older rows).
        let body_for_images = node
            .body_md_raw
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| node.body_md.as_deref().unwrap_or(""));
        let images = scan_images_in_body(body_for_images);
        // Strip the data URLs so the agent doesn't try to decode a
        // multi-megabyte base64 string just to learn the mime type.
        let mut summary: Vec<Value> = Vec::with_capacity(images.len());
        for img in &images {
            summary.push(json!({
                "imageId": img.image_id,
                "caption": img.caption,
                "mimeType": img.mime_type,
                "dataLength": img.base64_data.len(),
                "associatedText": img.associated_text,
            }));
        }
        Ok(McpToolResult {
            tool_name: "list_node_images".into(),
            output: json!({
                "nodeId": node_id,
                "imageCount": images.len(),
                "images": summary,
            }),
            provenance: provenance_for("list_node_images", vec![node_id]),
            content_blocks: None,
        })
    }

    /// `get_image` — return the actual bytes of one image embedded in
    /// a node, packaged as an MCP `image` content block so vision-
    /// capable clients (Claude Desktop) can see it. Identified by
    /// `nodeId` + either an `imageId` (BlockNote block id) or a
    /// zero-based `index` into the node's image list. The associated
    /// OCR text (paragraphs immediately following the image in the
    /// doc) is included as a separate `text` content block so the
    /// model sees both modalities in the same tool reply.
    fn tool_get_image(&self, input: &Value) -> Result<McpToolResult, McpError> {
        let node_id = require_str(input, "nodeId")?;
        let want_id = input.get("imageId").and_then(|v| v.as_str()).map(String::from);
        let want_index = input.get("index").and_then(|v| v.as_u64()).map(|n| n as usize);
        // `bytes` flag: include the base64 data in the JSON output so
        // non-vision MCP clients (or arbitrary tool callers) can pull
        // the bytes out of the structured result. Defaults to TRUE
        // because that's why this tool exists. Set false when the
        // caller only wants the image *content block* for a vision
        // model and doesn't want the multi-megabyte string echoed
        // into the JSON-result envelope as well.
        let include_bytes = input
            .get("bytes")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if want_id.is_none() && want_index.is_none() {
            return Err(McpError::SchemaInvalid(
                "either imageId or index is required".into(),
            ));
        }
        let node = self
            .index
            .get_node_by_id(node_id)?
            .ok_or_else(|| McpError::Execution(format!("no node with id {node_id}")))?;
        let resolved_node_id = node.id.clone();
        let body_for_images = node
            .body_md_raw
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| node.body_md.as_deref().unwrap_or(""));
        let images = scan_images_in_body(body_for_images);
        let chosen = match (&want_id, want_index) {
            (Some(id), _) => images
                .iter()
                .find(|i| i.image_id.as_deref() == Some(id.as_str())),
            (None, Some(idx)) => images.get(idx),
            _ => None,
        };
        let img = chosen.ok_or_else(|| {
            McpError::Execution(format!(
                "no matching image in node {resolved_node_id} (have {} images)",
                images.len()
            ))
        })?;

        // Build the MCP content blocks: the image first so vision-
        // enabled clients show it inline, then the OCR text so the
        // model has the textual layer too.
        let mut blocks: Vec<Value> = vec![json!({
            "type": "image",
            "data": img.base64_data,
            "mimeType": img.mime_type,
        })];
        if !img.associated_text.trim().is_empty() {
            blocks.push(json!({
                "type": "text",
                "text": format!(
                    "Associated OCR / extracted text near this image:\n\n{}",
                    img.associated_text
                ),
            }));
        }

        // Build the JSON-result mirror. Vision-aware clients
        // (Claude Desktop, Claude Code) pick up the image from
        // `content_blocks`; everyone else reads `data` out of the
        // structured `output` field. `data` is a plain base64
        // string (no `data:` URL prefix) plus `mimeType` separately
        // so consumers can rebuild a data URL trivially.
        let mut output = json!({
            "nodeId": resolved_node_id,
            "imageId": img.image_id,
            "caption": img.caption,
            "mimeType": img.mime_type,
            "encoding": "base64",
            "dataLength": img.base64_data.len(),
            "associatedText": img.associated_text,
        });
        if include_bytes {
            if let Some(obj) = output.as_object_mut() {
                obj.insert(
                    "data".to_string(),
                    Value::String(img.base64_data.clone()),
                );
            }
        }

        Ok(McpToolResult {
            tool_name: "get_image".into(),
            output,
            provenance: provenance_for("get_image", vec![resolved_node_id]),
            content_blocks: Some(blocks),
        })
    }

    fn tool_get_neighbors(&self, input: &Value) -> Result<McpToolResult, McpError> {
        let id = require_str(input, "id")?;
        let depth = input
            .get("depth")
            .and_then(|v| v.as_u64())
            .unwrap_or(1)
            .min(2) as u8;
        let limit = input
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(20)
            .clamp(1, 50) as usize;
        let response = self.retrieval.trace(id, depth, limit)?;
        let node_ids: Vec<String> = response
            .neighbors
            .iter()
            .map(|n| n.node_id.clone())
            .collect();
        let output = serde_json::to_value(&response)
            .map_err(|e| McpError::Execution(format!("serialise: {e}")))?;
        Ok(McpToolResult {
            tool_name: "get_neighbors".into(),
            output,
            provenance: provenance_for("get_neighbors", node_ids),
            content_blocks: None,
        })
    }
}

fn require_str<'a>(input: &'a Value, field: &str) -> Result<&'a str, McpError> {
    input
        .get(field)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| McpError::SchemaInvalid(format!("missing required field: {field}")))
}

fn provenance_for(tool: &str, node_ids: Vec<String>) -> Provenance {
    Provenance {
        source: format!("mcp.{tool}"),
        timestamp_utc: Utc::now().to_rfc3339(),
        interface_id: INTERFACE_ID.to_string(),
        interface_version: INTERFACE_VERSION.to_string(),
        node_ids,
        evidence_ids: Vec::new(),
    }
}

fn canonical_tools() -> Vec<ToolDescriptor> {
    vec![
        ToolDescriptor {
            name: "search_nodes".into(),
            description:
                "Hybrid search over the local knowledge graph — combines FTS5 lexical bm25 with sqlite-vec cosine similarity over BGE-small embeddings. Returns ranked candidate nodes with id, type, title, a highlighted snippet, per-leg scores (scoreLexical, scoreSemantic, scoreStructural) and the fused finalScore, AND any cached `summary` + `keyPoints` extracted from the node's body. Phrasing the query as a natural-language question generally improves semantic recall. Often you can answer the user directly from the summary / snippet without a follow-up get_node — only fetch the full body when the question requires details the summary doesn't cover."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Free-text query." },
                    "types": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional filter on node type."
                    },
                    "limit": { "type": "number", "description": "Max results (default 25, max 50)." }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "get_node".into(),
            description:
                "Read a single node by id. Returns up to 8 KB of the node's body by default (look for `bodyMdTruncated: true` and `bodyMdTotalLength` to see if more is available). Use the optional `offset` + `length` arguments to page through a long body, or `full: true` to fetch everything in one go. Prefer paging — most questions can be answered from the first window plus the `summary` you already got from search_nodes."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Node id (UUID)." },
                    "full": { "type": "boolean", "description": "Return the entire bodyMd in one call. Defaults to false; use only when you've already determined paging won't suffice." },
                    "offset": { "type": "number", "description": "Byte offset into bodyMd to start reading from. Defaults to 0." },
                    "length": { "type": "number", "description": "Max bytes of bodyMd to return. Defaults to 8192." }
                },
                "required": ["id"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "get_nodes".into(),
            description:
                "Bulk variant of get_node. Read up to 50 nodes by id in a single call. Use this after a list_* or search_nodes call when the user wants details on every (or many) hits — much faster than chaining get_node N times. Missing ids come back as `{id, found: false}` so you can detect partial matches without retrying."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "ids": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Up to 50 node ids (UUIDs)."
                    }
                },
                "required": ["ids"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "get_neighbors".into(),
            description:
                "Expand the subgraph around a seed node. Returns nodes connected by edges. Note: edge data is sparse in v1; this tool may return an empty array."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Seed node id." },
                    "depth": { "type": "number", "enum": [1, 2], "description": "Expansion depth (default 1)." },
                    "limit": { "type": "number", "description": "Max neighbors (default 20)." }
                },
                "required": ["id"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "list_assets_in_project".into(),
            description:
                "List every asset node that belongs to a given project. Returns each asset's id, type, title, summary (when present), and last-updated timestamp. Uses the graph `contains` edges from the project node."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "projectId": { "type": "string", "description": "Project node id." },
                    "limit": { "type": "number", "description": "Max assets to return (default 200, max 500)." }
                },
                "required": ["projectId"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "list_nodes_by_type".into(),
            description:
                "List nodes filtered by type (e.g. `note`, `url`, `pdf`, `image`, `docx`, `code`, `project`). Optionally further restrict to a single project via `projectId`. Returns id, type, title, summary, and last-updated timestamp."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "type": {
                        "type": "string",
                        "description": "Node type to list (default: `note`)."
                    },
                    "projectId": {
                        "type": "string",
                        "description": "Optional project id to restrict results to a single project."
                    },
                    "limit": { "type": "number", "description": "Max nodes (default 100, max 500)." }
                },
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "summarise_artifacts".into(),
            description:
                "Summarise a set of artifact node bodies into a single paragraph. Reads the named node ids via the index, concatenates their titles + bodies, and routes the result through the configured LLM. Useful for collapsing a Collection's contents into a one-paragraph PI dashboard caption. Provenance carries the summarised node ids. Implemented in the host (Tauri) build only — the read-only stdio sidecar returns E_MCP_TOOL_NOT_FOUND for this tool."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "nodeIds": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Artifact / collection / document node ids to summarise."
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Optional custom user prompt. Defaults to a generic 'summarise these' instruction."
                    },
                    "maxTokens": {
                        "type": "number",
                        "description": "Max completion tokens (default 400)."
                    }
                },
                "required": ["nodeIds"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "list_node_images".into(),
            description:
                "List every image embedded in a node, with associated OCR / extracted text. Returns metadata only — the per-image bytes are NOT included (they're large). Use this first to discover what images a node has, then call `get_image` for any you want to see. `associatedText` is the text extracted from the image (via the OCR pass or the source file's embedded text) plus any paragraphs that immediately follow it in the doc body."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Node id (UUID) — typically a collection or epic." }
                },
                "required": ["id"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "get_image".into(),
            description:
                "Return the bytes of one image embedded in a node, packaged TWO ways in the same reply so it works for every kind of client:\n\n1. As an MCP `image` content block so vision-capable clients (Claude Desktop, Claude Code) see the picture inline.\n2. As a base64 string in the structured JSON result under `output.data` (with `output.mimeType` and `output.encoding=\"base64\"`) so non-vision clients / scripts can decode the bytes directly.\n\nThe image's associated OCR / extracted text comes back as a third content block (and as `output.associatedText`). Identify the image by `imageId` (the BlockNote block id reported by `list_node_images`) OR by zero-based `index` into the node's image list."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "nodeId": { "type": "string", "description": "Node id (UUID) the image lives inside." },
                    "imageId": { "type": "string", "description": "Optional BlockNote block id of the image (preferred — stable across re-orders)." },
                    "index": { "type": "number", "description": "Optional zero-based index into the node's image list (fallback when imageId isn't known)." },
                    "bytes": { "type": "boolean", "description": "Whether to include the full base64 image bytes in `output.data`. Defaults to true. Set false to omit (useful if the caller only wants the inline content block and not a multi-megabyte echo in the JSON result)." }
                },
                "required": ["nodeId"],
                "additionalProperties": false
            }),
        },
    ]
}

/// Plain-text-only record of an image found inside a node's body.
struct ImageEntry {
    image_id: Option<String>,
    caption: Option<String>,
    mime_type: String,
    /// The base64 payload extracted from the data URL — pass-through
    /// for an MCP image content block.
    base64_data: String,
    /// OCR / extracted text PMScratch attached near this image. We
    /// concatenate every paragraph block that follows the image until
    /// the next image / heading / different content type, so the LLM
    /// sees the full caption layer.
    associated_text: String,
}

/// Walk the BlockNote JSON tree stored in a node's `bodyMd` and pull
/// out every image block, pairing each with the text paragraphs that
/// follow it (those are the OCR / extracted-text spliced in by
/// `runImageOcrForCollection` and friends). Tolerant of malformed
/// JSON — returns an empty list rather than failing the tool.
fn scan_images_in_body(body_md: &str) -> Vec<ImageEntry> {
    if body_md.is_empty() {
        return Vec::new();
    }
    let parsed: Value = match serde_json::from_str(body_md) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    // Body can be a bare Block[] (older shape) OR an object wrapping
    // `{ blocks: [...] , name, etc }` (current writer). Find the
    // blocks array under either shape.
    let blocks: &Vec<Value> = match &parsed {
        Value::Array(arr) => arr,
        Value::Object(obj) => match obj.get("blocks").and_then(|v| v.as_array()) {
            Some(arr) => arr,
            None => return Vec::new(),
        },
        _ => return Vec::new(),
    };
    let mut out: Vec<ImageEntry> = Vec::new();
    walk_blocks(blocks, &mut out);
    out
}

fn walk_blocks(blocks: &[Value], out: &mut Vec<ImageEntry>) {
    let mut i = 0;
    while i < blocks.len() {
        let b = &blocks[i];
        let block_type = b.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if block_type == "image" {
            if let Some(mut entry) = read_image_block(b) {
                // Preferred path: the image block carries linked text on
                // its own `props.contextText` / `extractedText` (stamped
                // by `linkTextToImage`). When that's present we trust it
                // verbatim. Fallback: legacy collections that haven't
                // been re-OCR'd since the stamping logic landed — for
                // those we scrape following paragraphs the way the old
                // code did, so existing nodes don't regress.
                if entry.associated_text.is_empty() {
                    let mut text = String::new();
                    let mut j = i + 1;
                    while j < blocks.len() {
                        let nb = &blocks[j];
                        let nt = nb.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if nt != "paragraph" {
                            break;
                        }
                        let p = flatten_inline_text(nb.get("content"));
                        if !p.is_empty() {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(&p);
                        }
                        j += 1;
                    }
                    entry.associated_text = text;
                }
                out.push(entry);
            }
        }
        // Recurse into children — attachment toggles hold their image
        // payloads under `children`.
        if let Some(children) = b.get("children").and_then(|v| v.as_array()) {
            walk_blocks(children, out);
        }
        i += 1;
    }
}

fn read_image_block(b: &Value) -> Option<ImageEntry> {
    let props = b.get("props")?;
    let url = props.get("url").and_then(|v| v.as_str())?;
    if !url.starts_with("data:") {
        // Remote URL or unsupported. Skip — the MCP image block
        // requires inline bytes.
        return None;
    }
    // Format: `data:<mime>;base64,<payload>`. Tolerate alternative
    // separators just in case.
    let after_colon = &url[5..];
    let (mime_and_meta, payload) = match after_colon.find(',') {
        Some(idx) => (&after_colon[..idx], &after_colon[idx + 1..]),
        None => return None,
    };
    let mime_type = match mime_and_meta.find(';') {
        Some(idx) => &mime_and_meta[..idx],
        None => mime_and_meta,
    };
    if mime_type.is_empty() {
        return None;
    }
    let image_id = b
        .get("id")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| {
            b.get("props")
                .and_then(|p| p.get("id"))
                .and_then(|v| v.as_str())
                .map(String::from)
        });
    let caption = props
        .get("caption")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    // If the upstream OCR pipeline stamped explicit `contextText` /
    // `extractedText` fields on this image's props (see
    // `linkTextToImage` in CollectionPicker.tsx), seed
    // `associated_text` with those values. The caller (`walk_blocks`)
    // still tacks on any *following* paragraphs as a fallback for
    // legacy blocks that haven't been re-OCR'd since the stamping
    // logic landed.
    let context = props
        .get("contextText")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let extracted = props
        .get("extractedText")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let mut seeded = String::new();
    if let Some(ctx) = context {
        seeded.push_str("Context (text immediately before the image):\n");
        seeded.push_str(&ctx);
    }
    if let Some(ex) = extracted {
        if !seeded.is_empty() {
            seeded.push_str("\n\n");
        }
        seeded.push_str("Extracted text from the image (OCR):\n");
        seeded.push_str(&ex);
    }
    Some(ImageEntry {
        image_id,
        caption,
        mime_type: mime_type.to_string(),
        base64_data: payload.to_string(),
        associated_text: seeded,
    })
}

fn flatten_inline_text(content: Option<&Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    let Some(arr) = content.as_array() else {
        return String::new();
    };
    let mut out = String::new();
    for item in arr {
        if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
            out.push_str(t);
        }
    }
    out
}
