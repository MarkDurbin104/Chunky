//! Auto-register Chunky's MCP server with Anthropic's desktop / CLI clients.
//!
//! Runs once on every Chunky GUI launch (cheap — it's a file merge). If any
//! of the supported clients is installed, we open its config, ensure a
//! `mcpServers.chunky` entry exists with the correct command / args /
//! `SEMANTIC_DB_PATH`, and write back. All other fields are preserved.
//!
//! Supported layouts:
//!   1. Claude Desktop (stand-alone): `%APPDATA%\Claude\claude_desktop_config.json`
//!   2. Claude Desktop (MSIX sandbox): `%LOCALAPPDATA%\Packages\Claude_*\...`
//!   3. Claude Code CLI: `%USERPROFILE%\.claude.json` (only when it exists)
//!   4. Cross-platform: `~/.config/Claude/claude_desktop_config.json` (Linux/Mac)

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const CHUNKY_TOOL_NAMES: &[&str] = &[
    "list_assets_in_project",
    "list_nodes_by_type",
    "search_nodes",
    "get_node",
    "get_nodes",
    "list_node_images",
    "get_image",
    "get_neighbors",
];

struct ConfigTarget {
    path: PathBuf,
    label: &'static str,
    create_if_missing: bool,
}

fn find_targets() -> Vec<ConfigTarget> {
    let mut out: Vec<ConfigTarget> = Vec::new();

    // Windows: Claude Desktop stand-alone
    #[cfg(target_os = "windows")]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let dir = PathBuf::from(appdata).join("Claude");
        if dir.is_dir() {
            out.push(ConfigTarget {
                path: dir.join("claude_desktop_config.json"),
                label: "claude-desktop",
                create_if_missing: true,
            });
        }
    }

    // Windows: Claude Desktop MSIX sandbox
    #[cfg(target_os = "windows")]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let pkgs_root = PathBuf::from(&local).join("Packages");
        if let Ok(entries) = std::fs::read_dir(&pkgs_root) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("Claude_") {
                    continue;
                }
                let candidate = entry
                    .path()
                    .join("LocalCache")
                    .join("Roaming")
                    .join("Claude")
                    .join("claude_desktop_config.json");
                if candidate.parent().map(|p| p.is_dir()).unwrap_or(false) {
                    out.push(ConfigTarget {
                        path: candidate,
                        label: "claude-desktop-msix",
                        create_if_missing: true,
                    });
                }
            }
        }
    }

    // macOS / Linux: Claude Desktop config
    #[cfg(not(target_os = "windows"))]
    {
        // macOS: ~/Library/Application Support/Claude/
        #[cfg(target_os = "macos")]
        if let Some(home) = std::env::var_os("HOME") {
            let dir = PathBuf::from(&home)
                .join("Library")
                .join("Application Support")
                .join("Claude");
            if dir.is_dir() {
                out.push(ConfigTarget {
                    path: dir.join("claude_desktop_config.json"),
                    label: "claude-desktop-mac",
                    create_if_missing: true,
                });
            }
        }
        // Linux: ~/.config/Claude/
        #[cfg(target_os = "linux")]
        if let Some(home) = std::env::var_os("HOME") {
            let dir = PathBuf::from(&home).join(".config").join("Claude");
            if dir.is_dir() {
                out.push(ConfigTarget {
                    path: dir.join("claude_desktop_config.json"),
                    label: "claude-desktop-linux",
                    create_if_missing: true,
                });
            }
        }
    }

    // All platforms: Claude Code CLI config (only when it already exists)
    let home_key = if cfg!(target_os = "windows") { "USERPROFILE" } else { "HOME" };
    if let Some(home) = std::env::var_os(home_key) {
        let candidate = PathBuf::from(home).join(".claude.json");
        if candidate.is_file() {
            out.push(ConfigTarget {
                path: candidate,
                label: "claude-code",
                create_if_missing: false,
            });
        }
    }

    out
}

fn load_config(path: &Path) -> Value {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| Value::Object(Default::default())),
        Err(_) => Value::Object(Default::default()),
    }
}

fn merge_chunky_entry(root: &mut Value, command: &Path, db: &Path) -> bool {
    let obj = match root {
        Value::Object(o) => o,
        _ => {
            *root = Value::Object(Default::default());
            root.as_object_mut().unwrap()
        }
    };

    let servers = obj
        .entry("mcpServers".to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    let servers_obj = match servers {
        Value::Object(m) => m,
        _ => {
            *servers = Value::Object(Default::default());
            servers.as_object_mut().unwrap()
        }
    };

    let entry = servers_obj
        .entry("chunky".to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    let entry_obj = match entry {
        Value::Object(m) => m,
        _ => {
            *entry = Value::Object(Default::default());
            entry.as_object_mut().unwrap()
        }
    };

    let mut changed = false;

    let want_cmd = Value::String(command.to_string_lossy().to_string());
    if entry_obj.get("command") != Some(&want_cmd) {
        entry_obj.insert("command".to_string(), want_cmd);
        changed = true;
    }

    let want_args = json!(["--mcp-stdio"]);
    if entry_obj.get("args") != Some(&want_args) {
        entry_obj.insert("args".to_string(), want_args);
        changed = true;
    }

    let env = entry_obj
        .entry("env".to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    let env_obj = match env {
        Value::Object(m) => m,
        _ => {
            *env = Value::Object(Default::default());
            env.as_object_mut().unwrap()
        }
    };
    let want_db = Value::String(db.to_string_lossy().to_string());
    if env_obj.get("SEMANTIC_DB_PATH") != Some(&want_db) {
        env_obj.insert("SEMANTIC_DB_PATH".to_string(), want_db);
        changed = true;
    }

    let approve = entry_obj
        .entry("autoApprove".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !approve.is_array() {
        *approve = Value::Array(Vec::new());
    }
    let approve_arr = approve.as_array_mut().unwrap();
    let existing: std::collections::HashSet<String> = approve_arr
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    for tool in CHUNKY_TOOL_NAMES {
        if !existing.contains(*tool) {
            approve_arr.push(Value::String((*tool).to_string()));
            changed = true;
        }
    }

    changed
}

fn ensure_claude_code_permissions_allow() -> bool {
    let home_key = if cfg!(target_os = "windows") { "USERPROFILE" } else { "HOME" };
    let home = match std::env::var_os(home_key) {
        Some(p) => PathBuf::from(p),
        None => return false,
    };
    let dir = home.join(".claude");
    let path = dir.join("settings.json");

    let mut root = load_config(&path);
    if !root.is_object() {
        root = Value::Object(Default::default());
    }
    let root_obj = root.as_object_mut().unwrap();

    let perms = root_obj
        .entry("permissions".to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    if !perms.is_object() {
        *perms = Value::Object(Default::default());
    }
    let perms_obj = perms.as_object_mut().unwrap();

    let allow = perms_obj
        .entry("allow".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !allow.is_array() {
        *allow = Value::Array(Vec::new());
    }
    let allow_arr = allow.as_array_mut().unwrap();
    let existing: std::collections::HashSet<String> = allow_arr
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();

    let mut changed = false;
    for tool in CHUNKY_TOOL_NAMES {
        let rule = format!("mcp__chunky__{tool}");
        if !existing.contains(&rule) {
            allow_arr.push(Value::String(rule));
            changed = true;
        }
    }

    if !changed {
        return false;
    }

    if !dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("[claude-code-settings] create_dir_all {dir:?} failed: {e}");
            return false;
        }
    }

    let pretty = match serde_json::to_string_pretty(&root) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[claude-code-settings] serialise failed for {path:?}: {e}");
            return false;
        }
    };
    match std::fs::write(&path, pretty) {
        Ok(_) => {
            eprintln!("[claude-code-settings] allowed chunky MCP tools in {path:?}");
            true
        }
        Err(e) => {
            eprintln!("[claude-code-settings] write {path:?} failed: {e}");
            false
        }
    }
}

pub fn ensure_registered(command: &Path, db: &Path) {
    let targets = find_targets();
    ensure_claude_code_permissions_allow();
    if targets.is_empty() {
        return;
    }
    for target in targets {
        if !target.path.exists() && !target.create_if_missing {
            continue;
        }
        let mut root = load_config(&target.path);
        let changed = merge_chunky_entry(&mut root, command, db);
        if !changed {
            eprintln!(
                "[{label}] {path:?} already has the right chunky entry",
                label = target.label,
                path = target.path,
            );
            continue;
        }
        let pretty = match serde_json::to_string_pretty(&root) {
            Ok(s) => s,
            Err(e) => {
                eprintln!(
                    "[{label}] serialise failed for {path:?}: {e}",
                    label = target.label,
                    path = target.path,
                );
                continue;
            }
        };
        if target.create_if_missing {
            if let Some(parent) = target.path.parent() {
                if !parent.exists() {
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        eprintln!(
                            "[{label}] create_dir_all {parent:?} failed: {e}",
                            label = target.label,
                        );
                        continue;
                    }
                }
            }
        }
        match std::fs::write(&target.path, pretty) {
            Ok(_) => eprintln!(
                "[{label}] registered chunky in {path:?}",
                label = target.label,
                path = target.path,
            ),
            Err(e) => eprintln!(
                "[{label}] write {path:?} failed: {e} (read-only? sandbox?)",
                label = target.label,
                path = target.path,
            ),
        }
    }
}
