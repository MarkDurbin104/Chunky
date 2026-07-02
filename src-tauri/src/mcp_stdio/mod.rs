//! MCP stdio JSON-RPC server entrypoint, invoked via `chunky --mcp-stdio`.
//!
//! Single-binary deployment: the same `chunky` that hosts the Tauri
//! GUI also serves the MCP protocol over stdin/stdout when launched with
//! `--mcp-stdio`. The Claude Code CLI's `--mcp-config` spawns it that way
//! during chat tool-use; the user only sees one runnable artifact.
//!
//! The function does NOT touch SQLite directly. It opens
//! [`crate::index_service::IndexService::open_readonly`] and dispatches
//! every tool call through [`crate::mcp_service::McpService`]. That keeps
//! the entire desktop runtime — Tauri host AND stdio path — funnelling
//! reads through one `index.v1` implementation, one `retrieval.v1`
//! implementation, one `mcp.v1` registry. Single source of SQL access,
//! single source of provenance.
//!
//! Wire protocol: newline-delimited JSON-RPC 2.0 per MCP stdio transport.
//! Logs go to stderr only — anything written to stdout that isn't a valid
//! JSON-RPC message will break the CLI's parser.

use crate::index_service::IndexService;
use crate::mcp_service::McpService;
use crate::retrieval_service::RetrievalService;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "chunky";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Run the MCP stdio JSON-RPC loop on this thread until stdin closes or
/// a `shutdown` request arrives. Exits the process via `std::process::exit`
/// on fatal startup errors so the parent (Claude Code CLI) sees a clear
/// non-zero exit code.
pub fn run() {
    let db_path = match std::env::var("SEMANTIC_DB_PATH") {
        Ok(p) => PathBuf::from(p),
        Err(_) => {
            eprintln!("[mcp-stdio] FATAL: SEMANTIC_DB_PATH env var not set");
            std::process::exit(2);
        }
    };
    if !db_path.is_file() {
        eprintln!(
            "[mcp-stdio] FATAL: SEMANTIC_DB_PATH does not exist or is not a file: {db_path:?}"
        );
        std::process::exit(2);
    }

    let index = match IndexService::open_readonly(&db_path) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("[mcp-stdio] FATAL: cannot open index read-only: {e}");
            std::process::exit(2);
        }
    };
    eprintln!("[mcp-stdio] opened {db_path:?} read-only");

    let retrieval = Arc::new(RetrievalService::new(index.clone()));
    let mcp = McpService::new(retrieval, index);

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdout_lock = stdout.lock();

    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            eprintln!("[mcp-stdio] stdin read error, exiting");
            return;
        };
        // Strip a leading UTF-8 BOM if a client (or shell pipeline)
        // accidentally produces one. The MCP protocol doesn't allow it
        // but the cost of tolerance is one byte-comparison.
        let line = line.strip_prefix('\u{feff}').unwrap_or(&line);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                eprintln!(
                    "[mcp-stdio] parse error on line ({}): {}",
                    trimmed.chars().take(120).collect::<String>(),
                    e
                );
                continue;
            }
        };
        if msg.get("jsonrpc").and_then(|v| v.as_str()) != Some("2.0") {
            eprintln!("[mcp-stdio] non-jsonrpc-2.0 message dropped");
            continue;
        }
        let method = match msg.get("method").and_then(|v| v.as_str()) {
            Some(m) => m.to_string(),
            None => continue,
        };
        let id = msg.get("id").cloned();

        let response = handle(&mcp, &method, &msg, id.as_ref());
        if let Some(resp) = response {
            let serialised = match serde_json::to_string(&resp) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[mcp-stdio] serialise reply: {e}");
                    continue;
                }
            };
            if writeln!(stdout_lock, "{serialised}").is_err() {
                eprintln!("[mcp-stdio] stdout closed, exiting");
                return;
            }
            let _ = stdout_lock.flush();
        }
        if method == "shutdown" {
            return;
        }
    }
    eprintln!("[mcp-stdio] stdin closed, exiting");
}

fn handle(mcp: &McpService, method: &str, msg: &Value, id: Option<&Value>) -> Option<Value> {
    match method {
        "initialize" => Some(jsonrpc_ok(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION }
            }),
        )),
        "notifications/initialized" | "initialized" => None,
        "tools/list" => {
            let tools: Vec<Value> = mcp
                .list_tools()
                .into_iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "inputSchema": t.input_schema
                    })
                })
                .collect();
            Some(jsonrpc_ok(id, json!({ "tools": tools })))
        }
        "tools/call" => {
            let id = id?; // tools/call without id is malformed; drop silently
            let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
            let name = params
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match mcp.invoke_tool(&name, &arguments) {
                Ok(result) => {
                    // Build the response content. Always include the
                    // structured JSON result as a text block so
                    // non-vision clients (and any programmatic
                    // caller) can read `output.data` / `output.mimeType`
                    // etc. If the tool ALSO supplied explicit
                    // `content_blocks` (image tools emitting an
                    // `image` content block for vision clients),
                    // prepend those so the picture is rendered
                    // inline first.
                    let payload = match serde_json::to_string_pretty(&result) {
                        Ok(s) => s,
                        Err(e) => {
                            return Some(jsonrpc_tool_error(
                                Some(id),
                                &format!("serialise tool result: {e}"),
                            ));
                        }
                    };
                    let json_block = json!({ "type": "text", "text": payload });
                    let content = if let Some(blocks) = &result.content_blocks {
                        let mut out: Vec<Value> = blocks.clone();
                        out.push(json_block);
                        Value::Array(out)
                    } else {
                        json!([json_block])
                    };
                    Some(jsonrpc_ok(Some(id), json!({ "content": content })))
                }
                Err(e) => Some(jsonrpc_tool_error(Some(id), &e.to_string())),
            }
        }
        "ping" => Some(jsonrpc_ok(id, json!({}))),
        "shutdown" => Some(jsonrpc_ok(id, json!({}))),
        other => {
            if let Some(id) = id {
                Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32601,
                        "message": format!("method not found: {other}")
                    }
                }))
            } else {
                None
            }
        }
    }
}

fn jsonrpc_ok(id: Option<&Value>, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.cloned().unwrap_or(json!(0)),
        "result": result
    })
}

/// MCP convention: tool-level errors are returned as a `result` with
/// `isError: true`, NOT as a JSON-RPC error envelope. (JSON-RPC errors
/// are reserved for protocol-level failures like unknown methods.)
fn jsonrpc_tool_error(id: Option<&Value>, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.cloned().unwrap_or(json!(0)),
        "result": {
            "isError": true,
            "content": [
                { "type": "text", "text": message }
            ]
        }
    })
}
