//! Model asset extraction.
//!
//! The BGE embedding model ships as loose files alongside the
//! executable (or in `src-tauri/embedded/models/bge-small-en-v1.5/`
//! during dev). We no longer bake them into the binary via
//! `include_bytes!` — a 133 MB `.rodata` segment adds ~10 s to every
//! Windows process spawn (loader + AV scan) which killed MCP stdio
//! cold-start.
//!
//! `extract_to(dest)` copies from the source directory to the app-data
//! destination so the existing `Embedder::default_model_dir()` resolver
//! finds them. It's idempotent — files already present at the expected
//! size are skipped, so steady-state launches don't touch disk beyond
//! `metadata()`.

use std::fs;
use std::path::{Path, PathBuf};

/// Names of the three files the embedding model needs.
const ASSET_NAMES: &[&str] = &["config.json", "tokenizer.json", "model.safetensors"];

/// Compute the canonical extract destination for the embedded
/// model. Lives under `<appData>/models/bge-small-en-v1.5/` so the
/// existing `Embedder::default_model_dir()` resolver (which checks
/// app-data alongside other locations) finds it without further
/// wiring.
pub fn default_destination(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(base.join("models").join("bge-small-en-v1.5"))
}

/// Tauri-free path resolution for `--mcp-stdio` mode (no AppHandle available).
pub fn default_destination_no_tauri() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| "APPDATA env var unset".to_string())?;
        return Ok(base
            .join("com.chunky.desktop")
            .join("models")
            .join("bge-small-en-v1.5"));
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "HOME env var unset".to_string())?;
        return Ok(home
            .join("Library")
            .join("Application Support")
            .join("com.chunky.desktop")
            .join("models")
            .join("bge-small-en-v1.5"));
    }
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "HOME env var unset".to_string())?;
        return Ok(home
            .join(".local")
            .join("share")
            .join("com.chunky.desktop")
            .join("models")
            .join("bge-small-en-v1.5"));
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".to_string())
}

/// Find the source directory that holds the shipped model files.
///
/// Checks (in order):
///   1. `<exe-dir>/models/bge-small-en-v1.5/`  — release install layout
///   2. `<exe-dir>/../embedded/models/bge-small-en-v1.5/`  — dev (target/debug)
///   3. `<exe-dir>/../../embedded/models/bge-small-en-v1.5/`  — dev (target/debug/build)
///   4. `CHUNKY_EMBEDDING_MODEL_SOURCE_DIR` env var (dev override / tests)
fn source_dir() -> Option<PathBuf> {
    if let Ok(env_dir) = std::env::var("CHUNKY_EMBEDDING_MODEL_SOURCE_DIR") {
        let p = PathBuf::from(env_dir);
        if p.exists() {
            return Some(p);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?.to_path_buf();
    let candidates = [
        exe_dir.join("models").join("bge-small-en-v1.5"),
        exe_dir
            .join("..")
            .join("embedded")
            .join("models")
            .join("bge-small-en-v1.5"),
        exe_dir
            .join("..")
            .join("..")
            .join("embedded")
            .join("models")
            .join("bge-small-en-v1.5"),
    ];
    for c in candidates {
        if c.exists() && c.join("model.safetensors").is_file() {
            return Some(c);
        }
    }
    None
}

/// Copy every model asset to `dest`, skipping any file that already
/// exists at the expected byte length. Returns the number of files
/// written this call (0 on a steady-state launch). Errors are logged
/// and the call continues to the next file so a partial extract still
/// makes forward progress on the next attempt.
///
/// If the source directory isn't found (unusual — dev + release both
/// ship one), returns `Ok(0)` with a stderr note so semantic search
/// degrades gracefully rather than crashing the binary.
pub fn extract_to(dest: &Path) -> std::io::Result<usize> {
    fs::create_dir_all(dest)?;
    let Some(src) = source_dir() else {
        eprintln!(
            "[embedded_assets] model source directory not found; \
             semantic search will fall back to FTS only. \
             Set CHUNKY_EMBEDDING_MODEL_SOURCE_DIR to override."
        );
        return Ok(0);
    };
    let mut written = 0usize;
    for name in ASSET_NAMES {
        let source = src.join(name);
        let target = dest.join(name);
        let source_len = match fs::metadata(&source) {
            Ok(m) if m.is_file() => m.len(),
            _ => {
                eprintln!("[embedded_assets] source missing: {source:?}");
                continue;
            }
        };
        if asset_present(&target, source_len) {
            continue;
        }
        // Write to a temp file then rename to make the extract
        // atomic — a half-written model.safetensors that survives
        // a crash would silently produce garbage embeddings.
        let tmp = target.with_extension("tmp");
        if let Err(e) = fs::copy(&source, &tmp) {
            eprintln!("[embedded_assets] copy {source:?} -> {tmp:?}: {e}");
            continue;
        }
        if let Err(e) = fs::rename(&tmp, &target) {
            eprintln!("[embedded_assets] rename {tmp:?} -> {target:?}: {e}");
            let _ = fs::remove_file(&tmp);
            continue;
        }
        written += 1;
    }
    Ok(written)
}

fn asset_present(path: &Path, expected_len: u64) -> bool {
    match fs::metadata(path) {
        Ok(m) => m.is_file() && m.len() == expected_len,
        Err(_) => false,
    }
}
