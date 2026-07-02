fn main() {
    // On Windows, main.rs embeds WebView2Loader.dll via include_bytes!.
    // Emit a clear error at build time if the file is missing so the
    // developer sees a useful message rather than a cryptic "no such file".
    #[cfg(target_os = "windows")]
    {
        let dll = std::path::Path::new("embedded/runtime/WebView2Loader.dll");
        if !dll.exists() {
            eprintln!(
                "\n\
                 ╔══════════════════════════════════════════════════════════╗\n\
                 ║  MISSING: src-tauri/embedded/runtime/WebView2Loader.dll  ║\n\
                 ║  Copy it from the WebView2 SDK (x64 folder) or run:      ║\n\
                 ║    scripts/fetch-webview2-loader.ps1                     ║\n\
                 ╚══════════════════════════════════════════════════════════╝\n"
            );
            std::process::exit(1);
        }
    }

    // BGE embedding model file (~133 MB). Excluded from git; downloaded
    // by scripts/fetch-bge-model.{ps1,sh} on first build. Print a clear
    // message + rerun-if-changed so a fresh clone gets a useful error.
    let model = std::path::Path::new("embedded/models/bge-small-en-v1.5/model.safetensors");
    if !model.exists() {
        eprintln!(
            "\n\
             ╔════════════════════════════════════════════════════════════════════╗\n\
             ║  MISSING: src-tauri/embedded/models/bge-small-en-v1.5/             ║\n\
             ║           model.safetensors                                        ║\n\
             ║                                                                    ║\n\
             ║  Run one of the fetch scripts from the repo root:                  ║\n\
             ║    Windows: pwsh scripts/fetch-bge-model.ps1                       ║\n\
             ║    macOS / Linux: bash scripts/fetch-bge-model.sh                  ║\n\
             ╚════════════════════════════════════════════════════════════════════╝\n"
        );
        std::process::exit(1);
    }
    println!("cargo:rerun-if-changed=embedded/models/bge-small-en-v1.5/model.safetensors");

    tauri_build::build()
}
