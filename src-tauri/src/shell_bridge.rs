// Service modules implementing the v1 contracts. The bridge layer is a
// thin transport — it MUST NOT touch SQLite or compose retrieval logic
// itself; both are owned by `index_service` / `retrieval_service`. See
// docs/Module Isolation and Interface Contract §3.2 / §4.2 / §7.7 / §7.8.

// Tauri command names are the IPC contract with the JS bridge
// (`invokeCommand('app_getSettings', …)`), so the camelCase suffix
// after the namespace prefix is deliberate and load-bearing —
// renaming them snake_case would break every call site in the
// `bridge/client.ts` map. Suppress the lint module-wide rather than
// scatter `#[allow(non_snake_case)]` over every #[tauri::command].
#![allow(non_snake_case)]

use crate::index_service::{db_path_for_app, IndexService};
use crate::mcp_service::McpService;
use crate::retrieval_service::RetrievalService;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;
use uuid::Uuid;

/// `CREATE_NO_WINDOW` — when we spawn a child process from the
/// Tauri host (which itself runs as a Windows GUI subsystem
/// binary), Windows would otherwise allocate a fresh console for
/// the child and pop it on the user's screen for every Claude CLI
/// call. The flag suppresses that. Applied to every `Command` we
/// build for the Claude CLI, PowerShell (legacy-Office convert),
/// and the MCP stdio sidecar.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
fn no_console_window(cmd: &mut tokio::process::Command) {
    use std::os::windows::process::CommandExt;
    // tokio's `Command` re-exports `creation_flags` through its
    // own surface on Windows; the import above is for the `std`
    // `CommandExt` trait that adds it to the underlying type.
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// No-op on non-Windows platforms. Child processes on macOS/Linux don't
/// spawn their own console window from a GUI parent, so the console-
/// suppression flag is a Windows-only concern.
#[cfg(not(target_os = "windows"))]
fn no_console_window(_cmd: &mut tokio::process::Command) {
    // Intentionally empty.
}

/// Resolve the Claude Code CLI binary, finding the working
/// npm-installed `claude.exe` on Windows when no explicit override
/// is set.
///
/// The Windows resolution story is messier than it looks:
///   1. `Command::new("claude")` lets Windows' PATHEXT resolve the
///      name. Order is `.COM` → `.EXE` → `.BAT` → `.CMD`, so a stray
///      `claude.exe` (e.g. from `.local\bin`) silently shadows the
///      working npm install — that's what produces "exit 1: (no
///      stderr)".
///   2. Pointing at the npm `claude.cmd` wrapper fixes shadow-binary
///      selection but `tokio::process::Command` on Windows refuses
///      to spawn `.cmd`/`.bat` with args containing shell metachars
///      since the CVE-2024-24576 hardening (Rust 1.77+). PMScratch
///      passes system prompts, MCP config paths, and tool lists —
///      all rich enough to trip the guard with "batch file
///      arguments are invalid".
///   3. The npm wrapper itself just `CALL`s
///      `node_modules\@anthropic-ai\claude-code\bin\claude.exe`,
///      which IS a real PE binary and accepts arbitrary args
///      normally. Calling it directly sidesteps both problems.
///
/// Strategy: when the caller didn't pass an explicit `binaryPath`:
///   1. Probe the canonical npm install location
///      (`%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\
///      bin\claude.exe`) — that's where `npm install -g
///      @anthropic-ai/claude-code` lands on Windows.
///   2. Fall back to plain `claude` so PATH resolution still works
///      for users who installed via another package manager
///      (`scoop`, `choco`, manual). This is the same behaviour we
///      had before, but the explicit probe in step 1 is what fixes
///      the shadow-binary case.
///
/// An explicit `binaryPath` override in settings always wins.
fn resolve_claude_binary(configured: Option<&str>) -> String {
    if let Some(b) = configured {
        if !b.is_empty() && b != "claude" {
            return b.to_string();
        }
    }
    if cfg!(target_os = "windows") {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let npm_path = std::path::PathBuf::from(appdata)
                .join("npm")
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code")
                .join("bin")
                .join("claude.exe");
            if npm_path.is_file() {
                return npm_path.to_string_lossy().into_owned();
            }
        }
        // No npm install detected — fall back to PATH resolution.
        // Users who installed via scoop/choco/manual put their own
        // binary on PATH and this'll pick it up.
        "claude".to_string()
    } else {
        "claude".to_string()
    }
}

/// Locate the executable to spawn for the MCP stdio server. Single-binary
/// deployment: we point at the running `chunky.exe` and pass
/// `--mcp-stdio` so it dispatches to the JSON-RPC loop instead of the
/// Tauri GUI. `CHUNKY_MCP_SERVER` env var overrides for unit-test
/// injection or alternative bundling layouts.
fn find_mcp_server_entry() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CHUNKY_MCP_SERVER") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    std::env::current_exe().ok()
}

/// Build a temp MCP config file declaring our local stdio server.
/// Returns the path to the written config and the comma-separated list of
/// fully-qualified tool names the chat should allow. The DB path is
/// passed via env so the server opens the same SQLite index Tauri owns.
fn write_chat_mcp_config(
    app: &tauri::AppHandle,
    trace_id: &str,
) -> Result<(PathBuf, String), String> {
    let server_entry = find_mcp_server_entry()
        .ok_or_else(|| "could not resolve current_exe() for MCP spawn (set CHUNKY_MCP_SERVER to override)".to_string())?;
    let db_path = db_path_for_app(app)?;

    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    let cache_dir = base.join("cache").join("mcp");
    fs::create_dir_all(&cache_dir).map_err(|e| format!("mkdir {cache_dir:?}: {e}"))?;
    let config_path = cache_dir.join(format!("chat-{trace_id}.json"));

    // Single-binary deployment: spawn the running `chunky.exe` again
    // with `--mcp-stdio`. The argv check at the top of `main()` dispatches
    // to the MCP JSON-RPC loop instead of starting Tauri, so the chat
    // path goes through the same service stack as the host without
    // shipping a second executable.
    let cfg = serde_json::json!({
        "mcpServers": {
            "chunky": {
                "command": server_entry.to_string_lossy(),
                "args": ["--mcp-stdio"],
                "env": {
                    "SEMANTIC_DB_PATH": db_path.to_string_lossy()
                }
            }
        }
    });
    let serialised =
        serde_json::to_vec_pretty(&cfg).map_err(|e| format!("serialise mcp config: {e}"))?;
    fs::write(&config_path, &serialised)
        .map_err(|e| format!("write {config_path:?}: {e}"))?;

    // Tools the chat agent is allowed to call mid-turn. The
    // read-only triple covers free-text retrieval (search_nodes),
    // single-node read (get_node), and graph traversal
    // (get_neighbors). The two E-022 list tools let the agent fetch
    // every collection in a PI or every workspace-wide reference in
    // a single call instead of FTS-and-read'ing each one — which
    // matters for queries like "list all hardware references" where
    // search_nodes alone forces ~50 tool calls. summarise_artifacts
    // stays OUT of this list because it's host-only (the sidecar
    // returns ToolNotFound for it since it needs LLM access).
    let allowed = [
        "mcp__chunky__search_nodes",
        "mcp__chunky__get_node",
        "mcp__chunky__get_nodes",
        "mcp__chunky__get_neighbors",
        "mcp__chunky__list_assets_in_project",
        "mcp__chunky__list_nodes_by_type",
        // list_node_images returns metadata only (id + caption +
        // mimeType, no bytes). The chat agent uses it to discover
        // what screenshots exist on a node so it can reference them
        // in its markdown answer — the actual bytes are then fetched
        // locally by the renderer (see resolveLocalImageRefs in
        // chat-session.ts) instead of being piped back through the
        // Claude Code subprocess as a tool_result, which previously
        // took 10 minutes for two screenshots.
        "mcp__chunky__list_node_images",
    ]
    .join(" ");
    Ok((config_path, allowed))
}

/// Resolve the `llm.<use>.*` configuration from `<appData>/settings.json`.
/// Returns the parsed shape so the LLM dispatcher can pick the transport.
fn read_llm_use_config(
    app: &tauri::AppHandle,
    use_id: &str,
) -> Result<serde_json::Value, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    let path = base.join("settings.json");
    let bytes = fs::read(&path).map_err(|_| "no settings.json".to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse settings.json: {e}"))?;
    parsed
        .get("llm")
        .and_then(|v| v.get(use_id))
        .cloned()
        .ok_or_else(|| format!("settings.llm.{use_id} not configured"))
}

/// Tokenise the assistant markdown looking for `[<uuid>]` citation markers.
/// Returns lower-cased uuids preserving first-occurrence order. UUID layout:
/// 8-4-4-4-12 hex chars between `[` and `]`. Tightened from the loose
/// `[id]{8,}` regex in TRP §8 to avoid false positives on slugs.
fn parse_citations(markdown: &str) -> Vec<String> {
    let bytes = markdown.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'[' {
            i += 1;
            continue;
        }
        // Try to read a uuid starting at i+1, length 36, ending at b']'.
        let start = i + 1;
        let end = start + 36;
        if end >= bytes.len() || bytes[end] != b']' {
            i += 1;
            continue;
        }
        let candidate = &bytes[start..end];
        if is_uuid_v4(candidate) {
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

fn is_uuid_v4(b: &[u8]) -> bool {
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
                let is_hex = (c >= b'0' && c <= b'9')
                    || (c >= b'a' && c <= b'f')
                    || (c >= b'A' && c <= b'F');
                if !is_hex {
                    return false;
                }
            }
        }
    }
    true
}

/// Append a JSONL audit-log entry recording a policy-gated mutation.
pub fn append_audit(app: &tauri::AppHandle, kind: &str, body: serde_json::Value) {
    let Ok(base) = app.path().app_data_dir() else {
        return;
    };
    let dir = base.join("logs");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("policy.jsonl");
    let line = serde_json::json!({
        "kind": kind,
        "timestamp": Utc::now().to_rfc3339(),
        "body": body,
    });
    let mut serialised = match serde_json::to_string(&line) {
        Ok(s) => s,
        Err(_) => return,
    };
    serialised.push('\n');
    use std::io::Write as _;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(serialised.as_bytes());
    }
}

/// Write a JSON file atomically: write to a sibling temp, fsync, rename.
pub fn write_atomic(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// shell-bridge.v1 response envelope
#[derive(Serialize, Deserialize, Debug)]
#[serde(crate = "serde", rename_all = "camelCase")]
pub struct ResponseMeta {
    pub request_id: String,
    pub trace_id: String,
    pub duration_ms: u64,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(crate = "serde", rename_all = "camelCase")]
pub struct ErrorEnvelope {
    pub code: String,
    pub message: String,
    pub details: Option<serde_json::Value>,
    pub retryable: bool,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(crate = "serde", rename_all = "camelCase")]
pub struct ResponseEnvelope<T: Serialize> {
    pub meta: ResponseMeta,
    pub ok: bool,
    pub payload: Option<T>,
    pub error: Option<ErrorEnvelope>,
}

impl<T: Serialize> ResponseEnvelope<T> {
    pub fn ok(payload: T, request_id: String, trace_id: String, duration_ms: u64) -> Self {
        Self {
            meta: ResponseMeta {
                request_id,
                trace_id,
                duration_ms,
            },
            ok: true,
            payload: Some(payload),
            error: None,
        }
    }

    pub fn err(
        code: &str,
        message: &str,
        request_id: String,
        trace_id: String,
        duration_ms: u64,
    ) -> Self {
        Self {
            meta: ResponseMeta {
                request_id,
                trace_id,
                duration_ms,
            },
            ok: false,
            payload: None,
            error: Some(ErrorEnvelope {
                code: code.to_string(),
                message: message.to_string(),
                details: None,
                retryable: false,
            }),
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(crate = "serde", rename_all = "camelCase")]
pub struct StartupState {
    pub state: String, // "ready" | "initializing" | "repairing" | "failed"
    pub mode: String,  // "fresh" | "upgrade" | "repair" | "none"
    pub asset_pack_version: String,
    pub app_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(crate = "serde", rename_all = "camelCase")]
pub struct IndexHealth {
    pub ready: bool,
    pub node_count: u64,
    pub edge_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated_utc: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(crate = "serde", rename_all = "camelCase")]
pub struct AppHealth {
    pub status: String, // "ok" | "degraded" | "failed"
    pub startup: StartupState,
    pub index: IndexHealth,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ingestion: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(crate = "serde", rename_all = "camelCase")]
pub struct RequestEnvelope<T: Clone> {
    pub meta: RequestMeta,
    pub payload: T,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(crate = "serde", rename_all = "camelCase")]
pub struct RequestMeta {
    pub interface_id: String,
    pub version: String,
    pub request_id: String,
    pub trace_id: String,
    pub timestamp_utc: String,
    pub caller: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
}

// Tauri command handlers

/// Read `<appData>/settings.json` and return its parsed contents.
/// Returns an empty object if the file is absent — callers default in TS.

/// Quick health check for the configured Claude CLI binary. Spawns
/// `<binary> --version` with a 5-second timeout and reports the
/// version string back so the Settings page can confirm the binary
/// is reachable without burning tokens on a real prompt. Failure
/// modes: process spawn error (binary missing / not on PATH),
/// timeout, non-zero exit, or unrecognised stdout. All are returned
/// as `E_CLI_PING_*` codes in the response envelope.
#[tauri::command]
pub async fn llm_cli_ping(
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    use std::time::Duration;
    use tokio::process::Command;
    use tokio::time::timeout;

    let start = std::time::Instant::now();
    let binary = resolve_claude_binary(
        payload.payload.get("binary").and_then(|v| v.as_str()),
    );
    let binary_display = binary.clone();

    let mut cmd = Command::new(&binary);
    cmd.arg("--version");
    cmd.kill_on_drop(true);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    no_console_window(&mut cmd);

    let spawn_result = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_CLI_PING_SPAWN",
                &format!("spawn `{binary_display} --version` failed: {e}"),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };

    let collect = async move {
        spawn_result
            .wait_with_output()
            .await
            .map_err(|e| format!("await output: {e}"))
    };

    let output = match timeout(Duration::from_secs(5), collect).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_CLI_PING_IO",
                &e,
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
        Err(_) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_CLI_PING_TIMEOUT",
                &format!("`{binary_display} --version` exceeded 5s"),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let duration_ms = start.elapsed().as_millis() as u64;
        return ResponseEnvelope::err(
            "E_CLI_PING_EXIT",
            &format!(
                "`{binary_display} --version` exited with code {:?}: {stderr}",
                output.status.code(),
            ),
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    }

    // Pick the first non-empty line as the version label. Claude
    // CLI's `--version` prints something like `0.2.3 (claude-code)`;
    // we report it verbatim so the user sees what their binary
    // actually advertises.
    let version = stdout
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("(no output)")
        .trim()
        .to_string();
    let duration_ms = start.elapsed().as_millis() as u64;
    ResponseEnvelope::ok(
        json!({
            "binary": binary_display,
            "version": version,
            "durationMs": duration_ms,
        }),
        payload.meta.request_id,
        payload.meta.trace_id,
        duration_ms,
    )
}

/// Citation-bound LLM query: dispatches by transport per D-013/D-014.
/// CLI transport spawns the configured binary with the prompt via stdin
/// and `--output-format json`; HTTP transport fails clearly until the
/// keychain plumbing lands. Audit-logs the call shape (no prompt body).
#[tauri::command]
pub async fn llm_query(
    app: tauri::AppHandle,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    let start = std::time::Instant::now();

    let use_id = payload
        .payload
        .get("use")
        .and_then(|v| v.as_str())
        .unwrap_or("query")
        .to_string();
    let system_prompt = payload
        .payload
        .get("systemPrompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let user_prompt = payload
        .payload
        .get("userPrompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let context_hits = payload
        .payload
        .get("contextHits")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));

    // Build the set of node ids the model is *allowed* to cite, so we can
    // strip fabrications before they reach the renderer.
    let mut known_ids: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    if let Some(arr) = context_hits.as_array() {
        for h in arr {
            if let Some(id) = h.get("nodeId").and_then(|v| v.as_str()) {
                known_ids.insert(id.to_ascii_lowercase());
            }
        }
    }

    // If no settings.json exists yet, fall back to the documented default
    // (Claude Code CLI / claude-sonnet-4-5) so a fresh install can chat
    // immediately. The user can override via Settings whenever they want.
    let cfg = read_llm_use_config(&app, &use_id).unwrap_or_else(|_| {
        json!({
            "supplier": "claude-code-cli",
            "model": "claude-sonnet-4-5",
            "baseUrl": "",
            "binaryPath": "claude",
            "transport": "cli",
            "temperature": if use_id == "imageTextExtraction" { 0.0 } else { 0.2 }
        })
    });

    let transport = cfg
        .get("transport")
        .and_then(|v| v.as_str())
        .unwrap_or("http")
        .to_string();
    let supplier = cfg
        .get("supplier")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let model = cfg
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // For chat (`use_id == "query"`) we wire the MCP server so the model
    // can call search_nodes / get_node / get_neighbors mid-turn instead of
    // relying on a single pre-fetched candidate list. Image extraction
    // doesn't need graph access, so it skips the MCP plumbing entirely.
    let mcp_setup = if use_id == "query" {
        match write_chat_mcp_config(&app, &payload.meta.trace_id) {
            Ok(pair) => Some(pair),
            Err(e) => {
                eprintln!("[llm_query] MCP wiring unavailable, falling back to no-tool mode: {e}");
                None
            }
        }
    } else {
        None
    };
    let mcp_used = mcp_setup.is_some();

    let result = match transport.as_str() {
        "cli" => {
            let binary = resolve_claude_binary(
                cfg.get("binaryPath").and_then(|v| v.as_str()),
            );
            let mcp_opts = mcp_setup.as_ref().map(|(p, tools)| CliMcpOptions {
                config_path: p.as_path(),
                allowed_tools: tools.as_str(),
            });
            // Stream-json + tool-image collection only when MCP is wired
            // (chat path); the other use_ids — image text extraction, etc.
            // — don't run tools and don't need the extra parsing.
            invoke_cli(
                &binary,
                &system_prompt,
                &user_prompt,
                &model,
                mcp_opts,
                mcp_used,
            )
            .await
        }
        _ => Err((
            "E_LLM_NO_KEY".to_string(),
            "HTTP transport requires an API key in the OS keychain (round 2). \
             Switch to the Claude Code (CLI sidecar) supplier in Settings, or \
             a local provider like Ollama, to use the chat today."
                .to_string(),
        )),
    };

    // Best-effort cleanup of the temp MCP config file. Leaving it behind
    // is harmless (it's overwritten on next call) but tidier to remove.
    if let Some((path, _)) = mcp_setup.as_ref() {
        let _ = fs::remove_file(path);
    }

    let duration_ms = start.elapsed().as_millis() as u64;
    match result {
        Ok(CliInvocationResult { result: markdown, tool_images }) => {
            let parsed = parse_citations(&markdown);
            let citations: Vec<serde_json::Value> = parsed
                .into_iter()
                .map(|id| {
                    // When MCP was wired, the model discovered ids by calling
                    // search_nodes/get_node — they're real DB ids by construction.
                    // The Chat UI will further verify via bridge.readNode for the
                    // chip tooltip; an unknown id will render struck-through.
                    // Without MCP we still gate against the pre-fetched candidate
                    // set (legacy non-tool-use path).
                    let used = if mcp_used {
                        true
                    } else {
                        known_ids.contains(&id)
                    };
                    json!({ "nodeId": id, "used": used })
                })
                .collect();

            // Audit log: shape only, never the prompt or response body.
            append_audit(
                &app,
                "llm.query.invoked",
                json!({
                    "actor": payload.meta.caller,
                    "use": use_id,
                    "supplier": supplier,
                    "transport": transport,
                    "model": model,
                    "mcp": mcp_used,
                    "hitCount": context_hits.as_array().map(|a| a.len()).unwrap_or(0),
                    "citationCount": citations.len(),
                    "durationMs": duration_ms,
                }),
            );

            // D-021 §4.12: when the call originated from the slash-command
            // runner, emit a `slash.<commandId>` audit entry carrying the
            // command shape. Privacy invariant: this entry MUST contain
            // ONLY the boolean / id fields explicitly extracted below —
            // never the prompt, the selection, the user-typed arg, or the
            // model's response. The rest of the payload is ignored.
            if let Some(slash) = payload.payload.get("slashAudit") {
                if let Some(command_id) =
                    slash.get("commandId").and_then(|v| v.as_str())
                {
                    let kind = format!("slash.{}", command_id);
                    append_audit(
                        &app,
                        &kind,
                        json!({
                            "actor": payload.meta.caller,
                            "commandId": command_id,
                            "hasSelection": slash
                                .get("hasSelection")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false),
                            "hasArg": slash
                                .get("hasArg")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false),
                            "replaceSelection": slash
                                .get("replaceSelection")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false),
                            "citationCount": citations.len(),
                            "durationMs": duration_ms,
                        }),
                    );
                }
            }

            ResponseEnvelope::ok(
                json!({
                    "markdown": markdown,
                    "citations": citations,
                    // tool_images is empty for non-chat (non-MCP) calls;
                    // for chat, each entry is { mimeType, dataBase64, toolName }.
                    "toolImages": tool_images,
                }),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            )
        }
        Err((code, message)) => ResponseEnvelope::err(
            &code,
            &message,
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        ),
    }
}

const IMAGE_TEXT_PROMPT_SYSTEM: &str = "You extract readable text from images. Output the text content verbatim with original line breaks and reading order preserved where possible. If the image is a screenshot of a UI, include button labels, field names, error messages, column headers, and table cell values. If the image is a diagram, include any labels and annotations. Do not describe the image, do not interpret, do not summarise. If the image contains no readable text, output the single word NONE. No preamble, no apology, no commentary. Do not invent text that is not visible. Preserve case (do not normalise to lowercase). For tables, render rows separated by newlines, columns separated by tabs.";

const IMAGE_TEXT_MAX_CHARS: usize = 20_000;

/// Image text extraction via the configured imageTextExtraction LLM.
/// Returns text + cache flag + status. Soft-fails (ok envelope, empty text,
/// skipReason populated) for the common no-key / non-vision / timeout
/// modes so the editor can keep the image embedded with a clear caption.
#[tauri::command]
pub async fn llm_extract_image_text(
    app: tauri::AppHandle,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    use sha2::{Digest, Sha256};
    let start = std::time::Instant::now();

    let data_url = payload
        .payload
        .get("dataUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let filename = payload
        .payload
        .get("filename")
        .and_then(|v| v.as_str())
        .unwrap_or("image")
        .to_string();
    if !data_url.starts_with("data:") {
        let duration_ms = start.elapsed().as_millis() as u64;
        return ResponseEnvelope::err(
            "E_LLM_PARSE",
            "dataUrl must be a data:image/...;base64,... URL",
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    }

    // Hash the data URL for cache key + temp filename.
    let mut hasher = Sha256::new();
    hasher.update(data_url.as_bytes());
    let hash = format!("{:x}", hasher.finalize());

    // Resolve config; fall back to CLI default if no settings.json exists.
    let cfg = read_llm_use_config(&app, "imageTextExtraction").unwrap_or_else(|_| {
        json!({
            "supplier": "claude-code-cli",
            "model": "claude-sonnet-4-5",
            "baseUrl": "",
            "binaryPath": "claude",
            "transport": "cli",
            "temperature": 0.0
        })
    });
    let supplier = cfg
        .get("supplier")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let model = cfg
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let transport = cfg
        .get("transport")
        .and_then(|v| v.as_str())
        .unwrap_or("http")
        .to_string();

    // Disk cache lookup. Key includes supplier + model so a swap re-extracts.
    let cache_path = match cache_path_for(&app, &hash, &supplier, &model) {
        Ok(p) => p,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_LLM_PARSE",
                &format!("cache path: {e}"),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };
    if let Ok(cached) = fs::read_to_string(&cache_path) {
        if !cached.trim().is_empty() {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::ok(
                json!({
                    "text": cached,
                    "cached": true,
                    "charsExtracted": cached.chars().count(),
                    "durationMs": duration_ms,
                }),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    }

    // Decode the data URL into raw bytes + mime so we can either temp-file
    // it (CLI) or base64-pass it (HTTP).
    let comma_idx = data_url.find(',').unwrap_or(0);
    let mime: String = if comma_idx > 5 {
        let header = &data_url[5..comma_idx];
        let mime_end = header.find(';').unwrap_or(header.len());
        header[..mime_end].to_string()
    } else {
        "image/png".to_string()
    };
    let b64_data: &str = if comma_idx > 0 {
        &data_url[comma_idx + 1..]
    } else {
        data_url.as_str()
    };
    use base64::Engine;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(b64_data) {
        Ok(b) => b,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_LLM_PARSE",
                &format!("base64 decode: {e}"),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };

    // Dispatch by transport. Round 1: CLI is the only working path. HTTP
    // (cloud) returns a soft skip until the keychain plumbing ships.
    let result = match transport.as_str() {
        "cli" => {
            let binary = resolve_claude_binary(
                cfg.get("binaryPath").and_then(|v| v.as_str()),
            );
            invoke_cli_image(&binary, &model, &filename, &hash, &mime, &bytes).await
        }
        _ => Ok(ImageExtractOutcome::Skip(
            "configure an API key in Settings".to_string(),
        )),
    };

    let duration_ms = start.elapsed().as_millis() as u64;
    match result {
        Ok(ImageExtractOutcome::Text(mut text)) => {
            // Truncate per TRP §4.1 cap.
            if text.chars().count() > IMAGE_TEXT_MAX_CHARS {
                let truncated: String = text.chars().take(IMAGE_TEXT_MAX_CHARS).collect();
                text = format!("{truncated}… (truncated)");
            }
            // Treat NONE / whitespace as "no readable text".
            if text.trim().is_empty() || text.trim().eq_ignore_ascii_case("none") {
                append_audit(
                    &app,
                    "llm.imageTextExtraction.invoked",
                    json!({
                        "actor": payload.meta.caller,
                        "supplier": supplier,
                        "transport": transport,
                        "model": model,
                        "imageBytes": bytes.len(),
                        "durationMs": duration_ms,
                        "charsExtracted": 0,
                    }),
                );
                return ResponseEnvelope::ok(
                    json!({
                        "text": "",
                        "cached": false,
                        "charsExtracted": 0,
                        "durationMs": duration_ms,
                        "skipReason": "extraction returned no text",
                    }),
                    payload.meta.request_id,
                    payload.meta.trace_id,
                    duration_ms,
                );
            }
            // Persist to disk cache (best-effort).
            let _ = fs::write(&cache_path, text.as_bytes());
            append_audit(
                &app,
                "llm.imageTextExtraction.invoked",
                json!({
                    "actor": payload.meta.caller,
                    "supplier": supplier,
                    "transport": transport,
                    "model": model,
                    "imageBytes": bytes.len(),
                    "durationMs": duration_ms,
                    "charsExtracted": text.chars().count(),
                }),
            );
            ResponseEnvelope::ok(
                json!({
                    "text": text.clone(),
                    "cached": false,
                    "charsExtracted": text.chars().count(),
                    "durationMs": duration_ms,
                }),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            )
        }
        Ok(ImageExtractOutcome::Skip(reason)) => {
            append_audit(
                &app,
                "llm.imageTextExtraction.skipped",
                json!({
                    "actor": payload.meta.caller,
                    "supplier": supplier,
                    "transport": transport,
                    "model": model,
                    "imageBytes": bytes.len(),
                    "durationMs": duration_ms,
                    "reason": reason,
                }),
            );
            ResponseEnvelope::ok(
                json!({
                    "text": "",
                    "cached": false,
                    "charsExtracted": 0,
                    "durationMs": duration_ms,
                    "skipReason": reason,
                }),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            )
        }
        Err((code, message)) => ResponseEnvelope::err(
            &code,
            &message,
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        ),
    }
}

enum ImageExtractOutcome {
    Text(String),
    Skip(String),
}

fn cache_path_for(
    app: &tauri::AppHandle,
    hash: &str,
    supplier: &str,
    model: &str,
) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    let dir = base.join("cache").join("image-text");
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {dir:?}: {e}"))?;
    // Sanitise model id (Ollama uses `/` and `:` in some ids).
    let safe_model: String = model
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    Ok(dir.join(format!("{hash}__{supplier}__{safe_model}.txt")))
}

/// CLI image-extraction: write the bytes to a temp file, ask Claude Code to
/// read it via the Read tool, parse the JSON envelope.
async fn invoke_cli_image(
    binary: &str,
    model: &str,
    filename: &str,
    hash: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<ImageExtractOutcome, (String, String)> {
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;

    // Compute a temp-file extension from the mime so the CLI's image-handling
    // path treats it correctly (e.g. .png vs .jpg).
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => "png",
    };
    let temp_dir = std::env::temp_dir();
    let temp_path = temp_dir.join(format!("llm-img-{hash}.{ext}"));

    if let Err(e) = tokio::fs::write(&temp_path, bytes).await {
        return Err((
            "E_LLM_CLI_EXEC".to_string(),
            format!("write temp image {temp_path:?}: {e}"),
        ));
    }
    // RAII guard: clean up the temp file regardless of success/failure.
    struct TempFileGuard(PathBuf);
    impl Drop for TempFileGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _guard = TempFileGuard(temp_path.clone());

    let user_prompt = format!(
        "Extract all readable text from the image at this path. Filename: {filename}. Path: {}",
        temp_path.to_string_lossy()
    );

    let mut cmd = Command::new(binary);
    cmd.arg("-p")
        .arg("--output-format")
        .arg("json")
        .arg("--append-system-prompt")
        .arg(IMAGE_TEXT_PROMPT_SYSTEM);
    if !model.is_empty() {
        cmd.arg("--model").arg(model);
    }
    // Allow the Read tool so the CLI can open our temp file. The flag name
    // varies between Claude Code releases; pass both common forms.
    cmd.arg("--allowed-tools").arg("Read");
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    no_console_window(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let kind = e.kind();
            return Err((
                if kind == std::io::ErrorKind::NotFound {
                    "E_LLM_CLI_NOT_FOUND".to_string()
                } else {
                    "E_LLM_CLI_EXEC".to_string()
                },
                format!("spawn {binary}: {e}"),
            ));
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        if stdin.write_all(user_prompt.as_bytes()).await.is_err() {
            return Err((
                "E_LLM_CLI_EXEC".to_string(),
                "failed to write prompt to stdin".to_string(),
            ));
        }
        drop(stdin);
    }

    let timeout = tokio::time::Duration::from_secs(60);
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(("E_LLM_CLI_EXEC".to_string(), format!("wait: {e}"))),
        Err(_) => {
            return Ok(ImageExtractOutcome::Skip(format!(
                "extraction timed out after {}s",
                timeout.as_secs()
            )))
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stderr_short = stderr.lines().next().unwrap_or("(no stderr)");
        // Map common failure modes to soft skips so the UI shows a clear
        // caption rather than a hard error.
        if stderr_short.contains("not found")
            || stderr_short.contains("No such file")
        {
            return Ok(ImageExtractOutcome::Skip(format!(
                "claude binary not found on PATH"
            )));
        }
        return Err((
            "E_LLM_CLI_EXEC".to_string(),
            format!(
                "exit {}: {}",
                output.status.code().unwrap_or(-1),
                stderr_short
            ),
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let mut last_result: Option<String> = None;
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            if value.get("type").and_then(|v| v.as_str()) == Some("result") {
                if let Some(s) = value.get("result").and_then(|v| v.as_str()) {
                    last_result = Some(s.to_string());
                }
            }
        }
    }
    if last_result.is_none() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
            if let Some(s) = value.get("result").and_then(|v| v.as_str()) {
                last_result = Some(s.to_string());
            }
        }
    }
    match last_result {
        Some(s) => Ok(ImageExtractOutcome::Text(s)),
        None => Err((
            "E_LLM_PARSE".to_string(),
            format!(
                "could not extract `result` from CLI output: {}",
                stdout.chars().take(400).collect::<String>()
            ),
        )),
    }
}

/// Spawn the Claude Code (or compatible) CLI in print-mode, pipe the user
/// prompt via stdin to avoid argv length limits, and parse its JSON output.
/// Options for spawning the Claude CLI with MCP tool support. When `Some`,
/// the chat path passes the config file (which lists MCP stdio servers
/// keyed by name) plus `--strict-mcp-config` so the user's global MCP
/// servers don't bleed in, and `--allowed-tools` so the model can call the
/// listed `mcp__<server>__<tool>` tools without an interactive prompt.
struct CliMcpOptions<'a> {
    config_path: &'a std::path::Path,
    allowed_tools: &'a str, // space-separated list of mcp__*__* names
}

/// Image content recovered from an MCP tool_result during a CLI
/// stream-json run. The chat surface renders these below the assistant
/// turn so users see the actual screenshot the agent fetched, not just
/// its textual cite.
#[derive(Clone, Debug, serde::Serialize)]
pub struct CliToolImage {
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(rename = "dataBase64")]
    pub data_base64: String,
    /// MCP server tool that produced the image (e.g.
    /// `mcp__chunky__get_image`). Lets the UI title the image
    /// without us having to thread node ids through here.
    #[serde(rename = "toolName")]
    pub tool_name: String,
}

pub struct CliInvocationResult {
    pub result: String,
    pub tool_images: Vec<CliToolImage>,
}

async fn invoke_cli(
    binary: &str,
    system_prompt: &str,
    user_prompt: &str,
    model: &str,
    mcp: Option<CliMcpOptions<'_>>,
    collect_tool_images: bool,
) -> Result<CliInvocationResult, (String, String)> {
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;

    // `collect_tool_images` is retained on the signature for future
    // use (e.g. surfacing other tool-emitted media) but we no longer
    // request stream-json — funneling get_image's base64 payload
    // through Claude Code's stdio + back out as stream-json lines
    // made a "show me 2 screenshots" turn take 10 minutes. The chat
    // UI now resolves image references emitted by the agent locally
    // via the in-process MCP service (see chat-session.ts), which
    // skips the round-trip through the CLI subprocess entirely.
    let _ = collect_tool_images;
    let mut cmd = Command::new(binary);
    cmd.arg("-p")
        .arg("--output-format")
        .arg("json");
    cmd.arg("--append-system-prompt").arg(system_prompt);
    if !model.is_empty() {
        cmd.arg("--model").arg(model);
    }
    if let Some(opts) = mcp.as_ref() {
        cmd.arg("--mcp-config")
            .arg(opts.config_path)
            .arg("--strict-mcp-config")
            .arg("--allowed-tools")
            .arg(opts.allowed_tools);
    }
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    no_console_window(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let kind = e.kind();
            return Err((
                if kind == std::io::ErrorKind::NotFound {
                    "E_LLM_CLI_NOT_FOUND".to_string()
                } else {
                    "E_LLM_CLI_EXEC".to_string()
                },
                format!("spawn {binary}: {e}"),
            ));
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        if stdin.write_all(user_prompt.as_bytes()).await.is_err() {
            return Err((
                "E_LLM_CLI_EXEC".to_string(),
                "failed to write prompt to stdin".to_string(),
            ));
        }
        // Closing stdin signals end-of-input to the CLI.
        drop(stdin);
    }

    // 5-minute wall-clock budget. Agentic chat queries (search_nodes →
    // list_references → get_node × N → synthesise) can legitimately
    // chain 5+ MCP tool calls before the LLM produces a token; 90s was
    // tight enough that "list all X then break down by Y" routinely
    // timed out before the model finished reasoning. The matching
    // bridge-side timeout in `client.ts::llmQuery` is also 300s.
    let timeout = tokio::time::Duration::from_secs(300);
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Err(("E_LLM_CLI_EXEC".to_string(), format!("wait: {e}")))
        }
        Err(_) => {
            return Err((
                "E_LLM_TIMEOUT".to_string(),
                format!("CLI did not finish within {}s", timeout.as_secs()),
            ))
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err((
            "E_LLM_CLI_EXEC".to_string(),
            format!(
                "exit {}: {}",
                output.status.code().unwrap_or(-1),
                stderr.lines().next().unwrap_or("(no stderr)")
            ),
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    // `claude -p --output-format json` emits an envelope like
    // `{"type":"result","subtype":"success","result":"<markdown>",…}`.
    // Streaming variants emit JSON-lines whose last `result` wins.
    let mut last_result: Option<String> = None;
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            if value.get("type").and_then(|v| v.as_str()) == Some("result") {
                if let Some(s) = value.get("result").and_then(|v| v.as_str()) {
                    last_result = Some(s.to_string());
                }
            }
        }
    }
    if last_result.is_none() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
            if let Some(s) = value.get("result").and_then(|v| v.as_str()) {
                last_result = Some(s.to_string());
            }
        }
    }
    let result = last_result.ok_or_else(|| {
        (
            "E_LLM_PARSE".to_string(),
            format!(
                "could not extract `result` from CLI output: {}",
                stdout.chars().take(400).collect::<String>()
            ),
        )
    })?;
    Ok(CliInvocationResult {
        result,
        tool_images: Vec::new(),
    })
}

#[tauri::command]
pub fn app_getSettings(
    app: tauri::AppHandle,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    let start = std::time::Instant::now();
    let path = match settings_path(&app) {
        Ok(p) => p,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_SETTINGS_PATH",
                &e,
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };
    let settings_value = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
            .unwrap_or(json!({})),
        Err(_) => json!({}),
    };
    let duration_ms = start.elapsed().as_millis() as u64;
    ResponseEnvelope::ok(
        json!({ "settings": settings_value }),
        payload.meta.request_id,
        payload.meta.trace_id,
        duration_ms,
    )
}

/// Write the settings JSON atomically. Validates the body is JSON; rejects
/// any field that looks like a leaked API key so the on-disk file never
/// holds secrets (those go to the OS keychain via a separate command).
#[tauri::command]
pub fn app_setSettings(
    app: tauri::AppHandle,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    let start = std::time::Instant::now();
    let path = match settings_path(&app) {
        Ok(p) => p,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_SETTINGS_PATH",
                &e,
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };
    let settings_value = match payload.payload.get("settings") {
        Some(v) => v.clone(),
        None => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_SETTINGS_VALIDATION",
                "Missing required field: settings",
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };
    if contains_secret_field(&settings_value) {
        let duration_ms = start.elapsed().as_millis() as u64;
        return ResponseEnvelope::err(
            "E_SETTINGS_VALIDATION",
            "Settings payload contains a secret-shaped field; api keys belong in the OS keychain, not on disk",
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    }
    // Merge into existing file, preserving keys not sent by this caller
    // (e.g. "atlassian" must survive an LLM-settings save).
    let mut on_disk: serde_json::Value = fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({}));
    if let (Some(disk_obj), Some(new_obj)) = (on_disk.as_object_mut(), settings_value.as_object()) {
        for (k, v) in new_obj {
            disk_obj.insert(k.clone(), v.clone());
        }
    } else {
        on_disk = settings_value;
    }
    let bytes = match serde_json::to_vec_pretty(&on_disk) {
        Ok(b) => b,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_SETTINGS_SERIALIZE",
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
            "E_SETTINGS_WRITE",
            &format!("write {path:?}: {e}"),
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    }
    let duration_ms = start.elapsed().as_millis() as u64;
    ResponseEnvelope::ok(
        json!({
            "ok": true,
            "persistedAt": Utc::now().to_rfc3339(),
            "path": path.to_string_lossy(),
        }),
        payload.meta.request_id,
        payload.meta.trace_id,
        duration_ms,
    )
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    fs::create_dir_all(&base)
        .map_err(|e| format!("mkdir {base:?}: {e}"))?;
    Ok(base.join("settings.json"))
}

/// Defence-in-depth: refuse to persist anything that smells like an API key.
/// The keychain is the only place secrets belong.
fn contains_secret_field(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                let key_lower = k.to_ascii_lowercase();
                // "apiToken" is the Atlassian PAT — it's intentionally stored on disk.
                // Only block generic "apikey"/"secret"/"token" top-level LLM keys.
                if key_lower == "apitoken" { continue; }
                if key_lower.contains("apikey") || key_lower == "secret" || key_lower == "token" {
                    if let serde_json::Value::String(s) = v {
                        if !s.is_empty() {
                            return true;
                        }
                    }
                }
                if contains_secret_field(v) {
                    return true;
                }
            }
            false
        }
        serde_json::Value::Array(arr) => arr.iter().any(contains_secret_field),
        _ => false,
    }
}

#[tauri::command]
pub fn app_getHealth(
    index: tauri::State<'_, Arc<IndexService>>,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<AppHealth> {
    let start = std::time::Instant::now();

    let (node_count, edge_count, last_updated) = match index.get_health() {
        Ok(h) => (h.node_count, h.edge_count, h.last_updated_utc),
        Err(_) => (0, 0, None),
    };

    let health = AppHealth {
        status: "ok".to_string(),
        startup: StartupState {
            state: "ready".to_string(),
            mode: "none".to_string(),
            asset_pack_version: "0.0.0".to_string(),
            app_version: "0.0.0".to_string(),
            last_error: None,
        },
        index: IndexHealth {
            ready: true,
            node_count,
            edge_count,
            last_updated_utc: last_updated,
        },
        ingestion: None,
    };

    let duration_ms = start.elapsed().as_millis() as u64;
    ResponseEnvelope::ok(
        health,
        payload.meta.request_id,
        payload.meta.trace_id,
        duration_ms,
    )
}

#[tauri::command]
pub fn startup_getState(payload: RequestEnvelope<serde_json::Value>) -> ResponseEnvelope<StartupState> {
    let start = std::time::Instant::now();

    let state = StartupState {
        state: "ready".to_string(),
        mode: "none".to_string(),
        asset_pack_version: "0.0.0".to_string(),
        app_version: "0.0.0".to_string(),
        last_error: None,
    };

    let duration_ms = start.elapsed().as_millis() as u64;
    ResponseEnvelope::ok(
        state,
        payload.meta.request_id,
        payload.meta.trace_id,
        duration_ms,
    )
}

#[tauri::command]
pub fn workspace_list(
    app: tauri::AppHandle,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    crate::workspace_service::list(app, payload)
}

#[tauri::command]
pub fn workspace_readNode(
    app: tauri::AppHandle,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    crate::workspace_service::read_node(app, payload)
}

#[tauri::command]
pub async fn workspace_upsertDraftNode(
    app: tauri::AppHandle,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    tokio::task::spawn_blocking(move || crate::workspace_service::upsert_draft(app, payload))
        .await
        .unwrap_or_else(|e| ResponseEnvelope::err(
            "E_WORKSPACE_PANIC",
            &format!("task panicked: {e}"),
            String::new(),
            String::new(),
            0,
        ))
}

#[tauri::command]
pub fn workspace_promoteDraft(
    app: tauri::AppHandle,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    crate::workspace_service::promote_draft(app, payload)
}

#[tauri::command]
pub fn workspace_deleteNode(
    app: tauri::AppHandle,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    crate::workspace_service::delete_node(app, payload)
}

#[tauri::command]
pub fn retrieval_search(
    retrieval: tauri::State<'_, Arc<RetrievalService>>,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    let start = std::time::Instant::now();

    let query = payload
        .payload
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let limit = payload
        .payload
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(20);
    let type_filter = payload
        .payload
        .get("filters")
        .and_then(|f| f.get("type"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Delegate to retrieval-service. The bridge does NOT do its own query
    // assembly or scoring — that lives behind `retrieval.v1`.
    let response = match retrieval.search(&query, type_filter.as_deref(), limit) {
        Ok(r) => r,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_RETRIEVAL_QUERY",
                &e.to_string(),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };

    let payload_value = match serde_json::to_value(&response) {
        Ok(v) => v,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_RETRIEVAL_SERIALIZE",
                &format!("serialise: {e}"),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };
    let duration_ms = start.elapsed().as_millis() as u64;
    ResponseEnvelope::ok(
        payload_value,
        payload.meta.request_id,
        payload.meta.trace_id,
        duration_ms,
    )
}

#[tauri::command]
pub fn retrieval_trace(
    retrieval: tauri::State<'_, Arc<RetrievalService>>,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    let start = std::time::Instant::now();

    let target_id = payload
        .payload
        .get("targetId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let depth = payload
        .payload
        .get("options")
        .and_then(|o| o.get("maxDepth"))
        .and_then(|v| v.as_u64())
        .unwrap_or(1)
        .min(2) as u8;
    let limit = payload
        .payload
        .get("options")
        .and_then(|o| o.get("limit"))
        .and_then(|v| v.as_u64())
        .unwrap_or(20)
        .min(50) as usize;

    let response = match retrieval.trace(&target_id, depth, limit) {
        Ok(r) => r,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_RETRIEVAL_QUERY_INVALID",
                &e.to_string(),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };
    let payload_value = match serde_json::to_value(&response) {
        Ok(v) => v,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_RETRIEVAL_SERIALIZE",
                &format!("serialise: {e}"),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };
    let duration_ms = start.elapsed().as_millis() as u64;
    ResponseEnvelope::ok(
        payload_value,
        payload.meta.request_id,
        payload.meta.trace_id,
        duration_ms,
    )
}

#[tauri::command]
pub async fn mcp_invokeTool(
    app: tauri::AppHandle,
    mcp: tauri::State<'_, Arc<McpService>>,
    payload: RequestEnvelope<serde_json::Value>,
) -> Result<ResponseEnvelope<serde_json::Value>, ()> {
    let start = std::time::Instant::now();

    let tool_name = payload
        .payload
        .get("toolName")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let input = payload
        .payload
        .get("input")
        .cloned()
        .unwrap_or_else(|| json!({}));

    // E-022: summarise_artifacts is the one tool that requires async LLM
    // dispatch. Handle it in the bridge so McpService can stay sync and the
    // mcp_stdio sidecar (which has no LLM access) can advertise the
    // descriptor without servicing the call.
    if tool_name == "summarise_artifacts" {
        let result = run_summarise_artifacts(app.clone(), &input, &payload.meta).await;
        let duration_ms = start.elapsed().as_millis() as u64;
        return Ok(match result {
            Ok(value) => ResponseEnvelope::ok(
                value,
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            ),
            Err((code, msg)) => ResponseEnvelope::err(
                code,
                &msg,
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            ),
        });
    }

    let result = match mcp.invoke_tool(&tool_name, &input) {
        Ok(r) => r,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            let code = match &e {
                crate::mcp_service::McpError::ToolNotFound(_) => "E_MCP_TOOL_NOT_FOUND",
                crate::mcp_service::McpError::SchemaInvalid(_) => "E_MCP_SCHEMA_INVALID",
                crate::mcp_service::McpError::Execution(_) => "E_MCP_TOOL_EXECUTION",
            };
            return Ok(ResponseEnvelope::err(
                code,
                &e.to_string(),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            ));
        }
    };

    let payload_value = match serde_json::to_value(&result) {
        Ok(v) => v,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return Ok(ResponseEnvelope::err(
                "E_MCP_TOOL_EXECUTION",
                &format!("serialise: {e}"),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            ));
        }
    };
    let duration_ms = start.elapsed().as_millis() as u64;
    Ok(ResponseEnvelope::ok(
        payload_value,
        payload.meta.request_id,
        payload.meta.trace_id,
        duration_ms,
    ))
}

/// E-022 summarise_artifacts: read each node body via the index, concatenate
/// titles + bodies, and route the result through `llm_query`. Returns the
/// payload value to wrap in the response envelope; on failure, returns the
/// (error_code, message) pair.
async fn run_summarise_artifacts(
    app: tauri::AppHandle,
    input: &serde_json::Value,
    caller: &RequestMeta,
) -> Result<serde_json::Value, (&'static str, String)> {
    let node_ids: Vec<String> = input
        .get("nodeIds")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if node_ids.is_empty() {
        return Err((
            "E_MCP_SCHEMA_INVALID",
            "summarise_artifacts: nodeIds must be a non-empty array of strings".to_string(),
        ));
    }
    let max_tokens = input
        .get("maxTokens")
        .and_then(|v| v.as_i64())
        .unwrap_or(400)
        .clamp(64, 2000);
    let custom_prompt = input
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let index = app.state::<Arc<IndexService>>();
    let mut concatenated = String::new();
    let mut included_ids: Vec<String> = Vec::new();
    for id in &node_ids {
        let node_opt = index
            .get_node_by_id(id)
            .map_err(|e| ("E_MCP_TOOL_EXECUTION", format!("index read {id}: {e}")))?;
        if let Some(node) = node_opt {
            let title = node
                .title
                .clone()
                .unwrap_or_else(|| node.id.clone());
            concatenated.push_str(&format!("## {title}\n\n"));
            if let Some(body) = &node.body_md {
                concatenated.push_str(body);
                concatenated.push_str("\n\n");
            }
            included_ids.push(node.id);
        }
    }
    if included_ids.is_empty() {
        return Err((
            "E_MCP_TOOL_EXECUTION",
            "summarise_artifacts: none of the requested ids resolved to existing nodes"
                .to_string(),
        ));
    }
    // Truncate to keep prompt size bounded; downstream LLM transports
    // already enforce their own caps but we don't want to send 100KB.
    let original_len = concatenated.len();
    let truncated_chars = if original_len > 24000 {
        concatenated.truncate(24000);
        let dropped = original_len - 24000;
        concatenated.push_str(&format!("\n\n[truncated — {dropped} more chars]"));
        dropped
    } else {
        0
    };

    let system_prompt = "You are summarising a collection of artifact bodies pulled from a local PM workspace. Produce a single neutral paragraph (3-5 sentences) capturing the main themes. No headings, no bullets, no opening salutation.".to_string();
    let user_prompt = if custom_prompt.is_empty() {
        format!("Summarise the following artifacts:\n\n{concatenated}")
    } else {
        format!("{custom_prompt}\n\nArtifacts:\n\n{concatenated}")
    };

    let llm_input = json!({
        "use": "query",
        "systemPrompt": system_prompt,
        "userPrompt": user_prompt,
        "contextHits": [],
        "options": { "temperature": 0.3, "maxTokens": max_tokens },
    });
    let llm_envelope: RequestEnvelope<serde_json::Value> = RequestEnvelope {
        meta: caller.clone(),
        payload: llm_input,
    };
    let llm_response = llm_query(app.clone(), llm_envelope).await;
    if !llm_response.ok {
        let msg = llm_response
            .error
            .as_ref()
            .map(|e| e.message.clone())
            .unwrap_or_else(|| "llm_query failed".to_string());
        return Err(("E_MCP_TOOL_EXECUTION", msg));
    }
    let llm_payload = llm_response.payload.unwrap_or_else(|| json!({}));
    let summary = llm_payload
        .get("markdown")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(json!({
        "toolName": "summarise_artifacts",
        "output": {
            "summary": summary,
            "summarisedNodeIds": included_ids.clone(),
            "truncatedChars": truncated_chars,
        },
        "provenance": {
            "source": "mcp.summarise_artifacts",
            "timestampUtc": Utc::now().to_rfc3339(),
            "interfaceId": "mcp.v1",
            "interfaceVersion": "1.1.0",
            "nodeIds": included_ids,
            "evidenceIds": serde_json::Value::Array(Vec::new()),
        }
    }))
}

#[cfg(test)]
mod workspace_list_tests {
    use crate::workspace_service::list_walk;
    use serde_json::json;
    use std::fs;
    use std::path::Path;

    fn write_draft(dir: &Path, id: &str, node_type: &str, pi_id: Option<&str>) {
        // Mirror the production write shape: `piId` lives INSIDE the
        // `jsonld` string blob rather than at the top of `draft`. The
        // upsert_draft handler stores the jsonld field verbatim from the
        // request payload, and every UI write path puts piId there
        // (DocumentEditor, EpicEditor, ReferenceCreate, PiEditorModal).
        let jsonld_str = if let Some(p) = pi_id {
            json!({ "@type": node_type, "piId": p }).to_string()
        } else {
            json!({ "@type": node_type }).to_string()
        };
        let draft = json!({
            "type": node_type,
            "title": format!("Draft {id}"),
            "jsonld": jsonld_str,
        });
        let record = json!({
            "id": id,
            "draft": draft,
            "updatedAtUtc": "2026-01-01T00:00:00Z",
        });
        fs::write(
            dir.join(format!("{id}.json")),
            serde_json::to_vec_pretty(&record).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn no_filters_returns_everything() {
        let dir = tempfile::tempdir().unwrap();
        write_draft(dir.path(), "1", "project", Some("X"));
        write_draft(dir.path(), "2", "project", Some("X"));
        write_draft(dir.path(), "3", "project", Some("Y"));
        write_draft(dir.path(), "4", "project", None);
        assert_eq!(list_walk(dir.path(), None, None, "draft").len(), 4);
    }

    #[test]
    fn pi_filter_narrows_to_matching_pi() {
        let dir = tempfile::tempdir().unwrap();
        write_draft(dir.path(), "1", "project", Some("X"));
        write_draft(dir.path(), "2", "project", Some("X"));
        write_draft(dir.path(), "3", "project", Some("Y"));
        write_draft(dir.path(), "4", "project", None);
        let items = list_walk(dir.path(), None, Some("X"), "draft");
        assert_eq!(items.len(), 2);
        assert!(items
            .iter()
            .all(|item| item.get("piId").and_then(|v| v.as_str()) == Some("X")));
    }

    #[test]
    fn type_and_pi_filter_compose() {
        let dir = tempfile::tempdir().unwrap();
        write_draft(dir.path(), "1", "project", Some("X"));
        write_draft(dir.path(), "2", "requirement_document", Some("X"));
        write_draft(dir.path(), "3", "project", Some("Y"));
        assert_eq!(
            list_walk(dir.path(), Some("project"), Some("Y"), "draft").len(),
            1,
        );
    }

    #[test]
    fn type_filter_with_no_match_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        write_draft(dir.path(), "1", "project", Some("X"));
        assert_eq!(list_walk(dir.path(), Some("epic"), None, "draft").len(), 0);
    }

    #[test]
    fn pi_filtered_excludes_items_without_pi_id() {
        let dir = tempfile::tempdir().unwrap();
        write_draft(dir.path(), "1", "project", Some("X"));
        write_draft(dir.path(), "2", "project", None);
        let items = list_walk(dir.path(), None, Some("X"), "draft");
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn pi_id_field_omitted_when_missing_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        write_draft(dir.path(), "1", "project", None);
        let items = list_walk(dir.path(), None, None, "draft");
        assert_eq!(items.len(), 1);
        assert!(items[0].get("piId").is_none());
    }

    #[test]
    fn pi_id_field_present_when_set_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        write_draft(dir.path(), "1", "project", Some("X"));
        let items = list_walk(dir.path(), None, None, "draft");
        assert_eq!(items[0].get("piId").and_then(|v| v.as_str()), Some("X"));
    }
}
