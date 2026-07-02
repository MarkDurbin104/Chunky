//! Legacy Office (`.doc` / `.xls` / `.ppt`) → modern OOXML conversion via
//! Word / Excel / PowerPoint COM automation, driven from PowerShell.
//!
//! Why PowerShell rather than embedding COM in Rust? The `windows` crate's
//! IDispatch story is verbose (~200 LOC for the same flow) and adds a
//! native-deps dependency. Spawning `powershell.exe -Command <script>`
//! handles all three Office apps with the same shape, no extra crates,
//! and the Tauri app already shells out for the Claude CLI so the
//! pattern is familiar.
//!
//! The webview detects OLE2 magic bytes in `extract.ts` and routes the
//! file through `bridge.officeConvertLegacy`; on success it feeds the
//! returned OOXML bytes back through the existing OOXML pipeline.

use crate::shell_bridge::{RequestEnvelope, ResponseEnvelope};

// The Windows-only implementation body needs these imports; scoping them
// under cfg keeps non-Windows targets from warning "unused import".
#[cfg(target_os = "windows")]
use crate::shell_bridge::append_audit;
#[cfg(target_os = "windows")]
use base64::Engine;
#[cfg(target_os = "windows")]
use serde_json::json;
#[cfg(target_os = "windows")]
use std::fs;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use tauri::Manager;
#[cfg(target_os = "windows")]
use uuid::Uuid;

/// Tauri command. See module-level docs.
///
/// Error codes:
///   E_OFFICE_NOT_INSTALLED — the corresponding Office app isn't on the
///       machine (PowerShell `New-Object -ComObject` failed).
///   E_OFFICE_CONVERT       — Office launched but the conversion failed.
///   E_OFFICE_TIMEOUT       — exceeded 60s wall clock.
///   E_OFFICE_PARSE         — input wasn't decodable / no temp dir / etc.
#[tauri::command]
pub async fn office_convert_legacy(
    app: tauri::AppHandle,
    payload: RequestEnvelope<serde_json::Value>,
) -> ResponseEnvelope<serde_json::Value> {
    let start = std::time::Instant::now();

    // Legacy Office conversion drives Word / Excel / PowerPoint via
    // COM automation from PowerShell — Windows-only. On macOS / Linux
    // return a clean error envelope so the frontend can surface a
    // "not supported on this platform" hint instead of hanging or
    // crashing on a missing `powershell.exe`.
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        let duration_ms = start.elapsed().as_millis() as u64;
        return ResponseEnvelope::err(
            "E_OFFICE_UNSUPPORTED_PLATFORM",
            "Legacy .doc/.xls/.ppt conversion requires Windows + Microsoft Office. \
             Re-save the file as .docx / .xlsx / .pptx and re-import.",
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    }
    #[cfg(target_os = "windows")]
    {

    let data_url = payload
        .payload
        .get("dataUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let original_filename = payload
        .payload
        .get("filename")
        .and_then(|v| v.as_str())
        .unwrap_or("input")
        .to_string();
    let format = payload
        .payload
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if !matches!(format.as_str(), "doc" | "xls" | "ppt") {
        let duration_ms = start.elapsed().as_millis() as u64;
        return ResponseEnvelope::err(
            "E_OFFICE_PARSE",
            &format!("unsupported legacy format: {format}"),
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    }

    if !data_url.starts_with("data:") {
        let duration_ms = start.elapsed().as_millis() as u64;
        return ResponseEnvelope::err(
            "E_OFFICE_PARSE",
            "dataUrl must be a data:application/...;base64,... URL",
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    }
    let comma_idx = data_url.find(',').unwrap_or(0);
    let b64_data: &str = if comma_idx > 0 {
        &data_url[comma_idx + 1..]
    } else {
        data_url.as_str()
    };
    let bytes = match base64::engine::general_purpose::STANDARD.decode(b64_data) {
        Ok(b) => b,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_OFFICE_PARSE",
                &format!("base64 decode: {e}"),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };

    let base = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_OFFICE_PARSE",
                &format!("app_data_dir: {e}"),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };
    let cache_dir = base.join("cache").join("office");
    if let Err(e) = fs::create_dir_all(&cache_dir) {
        let duration_ms = start.elapsed().as_millis() as u64;
        return ResponseEnvelope::err(
            "E_OFFICE_PARSE",
            &format!("mkdir {cache_dir:?}: {e}"),
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    }
    let token = Uuid::new_v4().to_string();
    let in_path = cache_dir.join(format!("{token}.{format}"));
    let (out_ext, fmt_code, com_class, save_method) = match format.as_str() {
        "doc" => ("docx", 12, "Word.Application", "SaveAs2"),
        "xls" => ("xlsx", 51, "Excel.Application", "SaveAs"),
        "ppt" => ("pptx", 24, "PowerPoint.Application", "SaveAs"),
        _ => unreachable!(),
    };
    let out_path = cache_dir.join(format!("{token}.{out_ext}"));

    if let Err(e) = fs::write(&in_path, &bytes) {
        let duration_ms = start.elapsed().as_millis() as u64;
        return ResponseEnvelope::err(
            "E_OFFICE_PARSE",
            &format!("write input: {e}"),
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    }

    // RAII cleanup — even if PowerShell hangs or panics, drop removes
    // the temp files when this scope exits.
    struct TempPair(PathBuf, PathBuf);
    impl Drop for TempPair {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
            let _ = fs::remove_file(&self.1);
        }
    }
    let _temps = TempPair(in_path.clone(), out_path.clone());

    // Single PowerShell script that handles all three Office apps. Exit 2
    // means the COM class isn't registered (Office app missing); exit 3
    // means the conversion itself failed.
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
try {{
    $app = New-Object -ComObject '{com_class}' -ErrorAction Stop
}} catch {{
    [Console]::Error.WriteLine('OFFICE_NOT_INSTALLED: ' + $_.Exception.Message)
    exit 2
}}
$app.Visible = $false
try {{ $app.DisplayAlerts = 0 }} catch {{}}
try {{
    if ('{com_class}' -eq 'Word.Application') {{
        $doc = $app.Documents.Open([string]'{in_path_ps}', $false, $true)
        $doc.{save_method}([string]'{out_path_ps}', {fmt_code})
        $doc.Close($false)
    }} elseif ('{com_class}' -eq 'Excel.Application') {{
        $doc = $app.Workbooks.Open([string]'{in_path_ps}', 0, $true)
        $doc.{save_method}([string]'{out_path_ps}', {fmt_code})
        $doc.Close($false)
    }} else {{
        $doc = $app.Presentations.Open([string]'{in_path_ps}', $true, $false, $false)
        $doc.{save_method}([string]'{out_path_ps}', {fmt_code})
        $doc.Close()
    }}
}} catch {{
    [Console]::Error.WriteLine('OFFICE_CONVERT: ' + $_.Exception.Message)
    try {{ $app.Quit() }} catch {{}}
    exit 3
}}
try {{ $app.Quit() }} catch {{}}
exit 0
"#,
        com_class = com_class,
        save_method = save_method,
        fmt_code = fmt_code,
        in_path_ps = in_path.to_string_lossy().replace('\'', "''"),
        out_path_ps = out_path.to_string_lossy().replace('\'', "''"),
    );

    use tokio::process::Command;
    let mut cmd = Command::new("powershell.exe");
    cmd.arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(&script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Suppress the PowerShell console window — Tauri host is a GUI
    // binary, so Windows would otherwise allocate a fresh console per
    // conversion. tokio's Command has a Windows-only `creation_flags`
    // shim; no std trait import needed.
    cmd.creation_flags(0x0800_0000);

    let timeout = tokio::time::Duration::from_secs(60);
    let output = match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_OFFICE_CONVERT",
                &format!("powershell spawn: {e}"),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
        Err(_) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_OFFICE_TIMEOUT",
                &format!("conversion did not finish within {}s", timeout.as_secs()),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };

    let exit_code = output.status.code().unwrap_or(-1);
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if exit_code == 2 {
        let duration_ms = start.elapsed().as_millis() as u64;
        return ResponseEnvelope::err(
            "E_OFFICE_NOT_INSTALLED",
            &format!(
                "{com_class} is not installed on this machine. Open the file in Office and save it in the modern format. ({})",
                stderr.lines().next().unwrap_or("").trim()
            ),
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    }
    if exit_code != 0 {
        let duration_ms = start.elapsed().as_millis() as u64;
        return ResponseEnvelope::err(
            "E_OFFICE_CONVERT",
            &format!(
                "Office reported an error converting {original_filename}: {}",
                stderr.lines().next().unwrap_or("(no detail)").trim()
            ),
            payload.meta.request_id,
            payload.meta.trace_id,
            duration_ms,
        );
    }

    let converted = match fs::read(&out_path) {
        Ok(b) => b,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            return ResponseEnvelope::err(
                "E_OFFICE_CONVERT",
                &format!("output file unreadable: {e}"),
                payload.meta.request_id,
                payload.meta.trace_id,
                duration_ms,
            );
        }
    };
    let mime = match out_ext {
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(&converted);
    let stem = original_filename
        .rsplit_once('.')
        .map(|(s, _)| s.to_string())
        .unwrap_or_else(|| original_filename.clone());
    let new_filename = if stem.is_empty() {
        format!("converted.{out_ext}")
    } else {
        format!("{stem}.{out_ext}")
    };

    append_audit(
        &app,
        "office.legacyConverted",
        json!({
            "actor": payload.meta.caller,
            "originalFilename": original_filename,
            "format": format,
            "outFormat": out_ext,
            "originalBytes": bytes.len(),
            "convertedBytes": converted.len(),
            "durationMs": start.elapsed().as_millis() as u64,
        }),
    );

    let duration_ms = start.elapsed().as_millis() as u64;
    ResponseEnvelope::ok(
        json!({
            "dataUrl": format!("data:{mime};base64,{encoded}"),
            "filename": new_filename,
            "mimeType": mime,
            "originalBytes": bytes.len(),
            "convertedBytes": converted.len(),
            "durationMs": duration_ms,
        }),
        payload.meta.request_id,
        payload.meta.trace_id,
        duration_ms,
    )
    }
}
