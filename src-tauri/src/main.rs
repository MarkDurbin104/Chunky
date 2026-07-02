#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chunky::index_service::{db_path_for_app, IndexService};
use chunky::mcp_service::McpService;
use chunky::retrieval_service::RetrievalService;
use chunky::shell_bridge::*;
use std::sync::Arc;
use tauri::Manager;


#[cfg(target_os = "windows")]
const WEBVIEW2_LOADER_DLL: &[u8] =
    include_bytes!("../embedded/runtime/WebView2Loader.dll");

#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
fn ensure_webview2_loader() {
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;

    // Persist alongside the rest of the runtime extract so antivirus
    // doesn't keep re-scanning the file on every launch. `%APPDATA%`
    // is set by Windows for every interactive user; if it isn't (rare
    // edge case), fall back to the system temp directory.
    let base: PathBuf = match std::env::var_os("APPDATA") {
        Some(p) => PathBuf::from(p),
        None => std::env::temp_dir(),
    };
    let dir = base.join("com.chunky.desktop").join("runtime");
    let dll_path = dir.join("WebView2Loader.dll");

    // Size check is sufficient — we control the bytes at compile
    // time, so any matching length means the on-disk copy is good.
    let needs_write = match std::fs::metadata(&dll_path) {
        Ok(m) => !m.is_file() || m.len() != WEBVIEW2_LOADER_DLL.len() as u64,
        Err(_) => true,
    };
    if needs_write {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("[startup] webview2-loader: mkdir {dir:?}: {e}");
            return;
        }
        // Atomic write — half-written DLLs would crash LoadLibrary.
        let tmp = dll_path.with_extension("tmp");
        if let Err(e) = std::fs::write(&tmp, WEBVIEW2_LOADER_DLL) {
            eprintln!("[startup] webview2-loader: write {tmp:?}: {e}");
            return;
        }
        if let Err(e) = std::fs::rename(&tmp, &dll_path) {
            eprintln!(
                "[startup] webview2-loader: rename {tmp:?} -> {dll_path:?}: {e}"
            );
            let _ = std::fs::remove_file(&tmp);
            return;
        }
        eprintln!("[startup] extracted WebView2Loader.dll to {dll_path:?}");
    }

    // Add the extract directory to Windows's DLL search path so
    // subsequent `LoadLibrary("WebView2Loader.dll")` calls (from
    // inside Tauri's webview backend) find our copy. Must happen
    // before the first webview is created.
    extern "system" {
        fn SetDllDirectoryW(lp_path_name: *const u16) -> i32;
    }
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` outlives the call; Windows treats it as a
    // null-terminated wide string and copies it internally.
    unsafe {
        let rc = SetDllDirectoryW(wide.as_ptr());
        if rc == 0 {
            eprintln!(
                "[startup] webview2-loader: SetDllDirectoryW failed; the webview \
                 may fail to load. Workaround: place WebView2Loader.dll next \
                 to chunky."
            );
        }
    }
}

/// Register a `NavigationStarting` handler on the main webview that
/// cancels navigation to any URL outside our own app shell and forwards
/// the URL to the frontend as a `external-url-dropped` event. The
/// handler runs on the WebView2 thread — we clone the `AppHandle` so
/// the event emit is safe from there.
#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
fn install_external_url_hook(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    use webview2_com::take_pwstr;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::NavigationStartingEventHandler;
    use windows::core::PWSTR;

    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[nav-hook] main webview not found; URL drop hook not installed");
        return;
    };
    let emitter = app.clone();

    let result = window.with_webview(move |pv| {
        let controller: ICoreWebView2Controller = pv.controller();
        let webview = unsafe {
            match controller.CoreWebView2() {
                Ok(wv) => wv,
                Err(e) => {
                    eprintln!("[nav-hook] CoreWebView2() failed: {e}");
                    return;
                }
            }
        };

        // The EventRegistrationToken returned by add_NavigationStarting
        // is just an i64 in the new windows-rs ABI. We don't need to
        // hold onto it (handler lives for the life of the app), so a
        // stack `0i64` is fine.
        let mut token: i64 = 0;
        let handler = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let uri = unsafe {
                let mut p = PWSTR::null();
                args.Uri(&mut p)?;
                take_pwstr(p)
            };

            // Allow our own bundled content. Tauri 2 serves the SPA from
            // either `tauri://localhost` (default) or `https://tauri.localhost`
            // (custom protocol mode). Also allow `about:blank`, data: URLs,
            // and javascript: URLs the page itself initiates.
            // In dev mode (`tauri dev`), the SPA is served from Vite at
            // `http://localhost:5173` — allow that too or the webview
            // never loads and renders black.
            let allow = uri.starts_with("tauri://")
                || uri.starts_with("https://tauri.localhost")
                || uri.starts_with("http://tauri.localhost")
                || uri.starts_with("http://localhost:5173")
                || uri.starts_with("about:")
                || uri.starts_with("data:")
                || uri.starts_with("javascript:")
                || uri.starts_with("blob:");

            if !allow {
                eprintln!("[nav-hook] blocking external navigation to {uri}");
                unsafe {
                    let _ = args.SetCancel(true);
                }
                // Forward to the React side so it can decide whether to
                // import this URL (e.g. Confluence pages) or ignore it.
                if let Err(e) = emitter.emit("external-url-dropped", uri) {
                    eprintln!("[nav-hook] emit failed: {e}");
                }
            }
            Ok(())
        }));

        if let Err(e) = unsafe { webview.add_NavigationStarting(&handler, &mut token) } {
            eprintln!("[nav-hook] add_NavigationStarting failed: {e}");
        } else {
            eprintln!("[nav-hook] installed NavigationStarting handler on main webview");
        }
    });

    if let Err(e) = result {
        eprintln!("[nav-hook] with_webview failed: {e}");
    }
}

fn main() {
    // Single-binary deployment: the same `chunky` ships both the
    // Tauri GUI and the read-only MCP stdio server. Claude Code's
    // `--mcp-config` spawns us with `--mcp-stdio`; in that mode we never
    // touch Tauri at all — just open the index read-only and serve the
    // JSON-RPC loop on stdin/stdout. End users see one runnable artifact.
    if std::env::args().any(|a| a == "--mcp-stdio") {
        // Copy the model to local appdata the first time we boot.
        // The source may live on a network share (SMB / dev Samba
        // mount) where mmap'ing 130 MB over the wire adds ~13 s to
        // every MCP spawn. Local copy is idempotent — subsequent
        // launches see the files and skip.
        match chunky::embedded_assets::default_destination_no_tauri() {
            Ok(dest) => {
                if let Err(e) = chunky::embedded_assets::extract_to(&dest) {
                    eprintln!("[mcp-stdio] model extract failed: {e}");
                }
                if dest.join("model.safetensors").is_file() {
                    std::env::set_var("CHUNKY_EMBEDDING_MODEL_DIR", dest.as_os_str());
                }
            }
            Err(e) => eprintln!("[mcp-stdio] model destination unresolved: {e}"),
        }
        chunky::mcp_stdio::run();
        return;
    }

    #[cfg(target_os = "windows")]
    ensure_webview2_loader();

    tauri::Builder::default()
        .setup(|app| {
            // Ensure model files live on local disk (see the stdio
            // branch above for the SMB-over-network rationale).
            match chunky::embedded_assets::default_destination(app.handle()) {
                Ok(dest) => {
                    match chunky::embedded_assets::extract_to(&dest) {
                        Ok(n) if n > 0 => eprintln!(
                            "[startup] extracted {n} model file(s) to {dest:?}"
                        ),
                        Ok(_) => {}
                        Err(e) => eprintln!("[startup] model extract failed: {e}"),
                    }
                    if dest.join("model.safetensors").is_file() {
                        std::env::set_var(
                            "CHUNKY_EMBEDDING_MODEL_DIR",
                            dest.as_os_str(),
                        );
                    }
                }
                Err(e) => eprintln!("[startup] model destination unresolved: {e}"),
            }

            // Open the index (read-write) via index.v1, then layer
            // retrieval.v1 and mcp.v1 on top. Every Tauri command flows
            // through these services — no command touches SQLite directly.
            let db_path = db_path_for_app(app.handle()).map_err(|e| {
                eprintln!("FATAL: db path resolution failed: {e}");
                std::io::Error::new(std::io::ErrorKind::Other, e)
            })?;

            if let Ok(exe) = std::env::current_exe() {
                chunky::claude_install::ensure_registered(&exe, &db_path);
            }

            let index = IndexService::open(&db_path).map_err(|e| {
                eprintln!("FATAL: index open failed: {e}");
                std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
            })?;

            if let Ok(base) = app.path().app_data_dir() {
                let drafts_path = base.join("drafts");
                match index.reindex_drafts(&drafts_path) {
                    Ok(n) if n > 0 => eprintln!("[startup] reindexed {n} drafts"),
                    _ => {}
                }
                let kb_path = base.join("kb");
                match index.reindex_canonical(&kb_path) {
                    Ok(n) if n > 0 => eprintln!("[startup] reindexed {n} canonical nodes"),
                    _ => {}
                }
            }

            let index = Arc::new(index);

            // Rebuild edges from jsonld on disk. `reindex_canonical` only
            // refreshes the node table; edges (contains, belongs-to-pi, …)
            // are written by `workspace_service::write_edges_for_node`, so
            // after a schema/predicate change the edge table would otherwise
            // stay stale until every node was manually re-upserted.
            if let Ok(base) = app.path().app_data_dir() {
                let kb_path = base.join("kb");
                let n = chunky::workspace_service::rebuild_edges_from_kb(&index, &kb_path);
                if n > 0 {
                    eprintln!("[startup] rebuilt edges for {n} canonical nodes");
                }
            }

            {
                let bg = index.clone();
                std::thread::spawn(move || match bg.backfill_embeddings() {
                    Ok(n) if n > 0 => {
                        eprintln!("[startup] backfilled embeddings for {n} nodes")
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("[startup] embedding backfill failed: {e}"),
                });
            }

            let retrieval = Arc::new(RetrievalService::new(index.clone()));
            let mcp = Arc::new(McpService::new(retrieval.clone(), index.clone()));
            app.manage(index);
            app.manage(retrieval);
            app.manage(mcp);

            #[cfg(target_os = "windows")]
            install_external_url_hook(app.handle());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_getHealth,
            app_getSettings,
            app_setSettings,
            startup_getState,
            workspace_list,
            workspace_readNode,
            workspace_upsertDraftNode,
            workspace_promoteDraft,
            workspace_deleteNode,
            llm_query,
            llm_cli_ping,
            llm_extract_image_text,
            chunky::office_convert::office_convert_legacy,
            retrieval_search,
            retrieval_trace,
            mcp_invokeTool,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app_handle, event| match event {
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::CloseRequested { .. },
                ..
            } => {}
            _ => {}
        })
}
