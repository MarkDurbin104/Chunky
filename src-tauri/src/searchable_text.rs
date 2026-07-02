//! Shared helper for deriving plain-text content from a stored body that
//! may be either JSON (a stringified BlockNote document) or already-plain
//! markdown.
//!
//! Lives at crate root rather than inside any service module because
//! `index_service` (the SQLite owner) and `workspace_service` (the
//! canonical-file owner) both need it. Putting it in either service would
//! force a downward dependency from the storage layer onto the
//! workspace layer, breaking the Module Isolation §3.2 layering. A shared
//! util module sits below both and has zero internal deps, only
//! `serde_json`.
//!
//! Resolves Remediation Backlog REM-022 (HITL B-019 #4 was satisfied by
//! both modules carrying identical copies; the dedup pulls them into one
//! place so a future tweak can't drift them).

/// Pull plain text out of a body that may be JSON (a stringified BlockNote
/// document) or already plain markdown. Tries to parse as JSON and walk
/// the structure for any string values; falls back to the raw input if
/// JSON parsing fails or yields no extractable strings.
///
/// Skips `data:` URLs (embedded image bytes are not useful for FTS and
/// bloat the index dramatically) and a small set of reserved keys
/// (`id`, `url`, `previewWidth`, `name`) that carry structural rather
/// than semantic content.
pub fn derive_searchable_text(raw: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
        let mut out = String::new();
        collect_text(&value, &mut out);
        if !out.is_empty() {
            return out;
        }
    }
    raw.to_string()
}

fn collect_text(value: &serde_json::Value, out: &mut String) {
    match value {
        serde_json::Value::String(s) => {
            // Skip data URLs — embedded image bytes are not useful for FTS
            // and bloat the index dramatically.
            if !s.starts_with("data:") && !s.is_empty() {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(s);
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                collect_text(v, out);
            }
        }
        serde_json::Value::Object(obj) => {
            for (key, v) in obj {
                if matches!(key.as_str(), "id" | "url" | "previewWidth" | "name") {
                    continue;
                }
                collect_text(v, out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_markdown_passes_through() {
        assert_eq!(derive_searchable_text("hello world"), "hello world");
    }

    #[test]
    fn empty_input_passes_through() {
        assert_eq!(derive_searchable_text(""), "");
    }

    #[test]
    fn json_blocks_are_walked_for_text() {
        let body = serde_json::json!([
            {
                "type": "paragraph",
                "content": [
                    { "type": "text", "text": "hello" },
                    { "type": "text", "text": " world" }
                ]
            },
            {
                "type": "heading",
                "content": [ { "type": "text", "text": "section" } ]
            }
        ])
        .to_string();
        let out = derive_searchable_text(&body);
        // Order preserved; data: skipped; types and props walked.
        assert!(out.contains("hello"));
        assert!(out.contains("world"));
        assert!(out.contains("section"));
    }

    #[test]
    fn data_urls_are_skipped() {
        let body = serde_json::json!([
            {
                "type": "image",
                "props": { "url": "data:image/png;base64,AAAA", "caption": "fig 1" }
            }
        ])
        .to_string();
        let out = derive_searchable_text(&body);
        assert!(!out.contains("data:"));
        assert!(!out.contains("AAAA"));
        assert!(out.contains("fig 1"));
    }

    #[test]
    fn reserved_keys_are_skipped() {
        let body = serde_json::json!({
            "id": "should-not-appear",
            "url": "should-not-appear",
            "previewWidth": "should-not-appear",
            "name": "should-not-appear",
            "title": "shows up"
        })
        .to_string();
        let out = derive_searchable_text(&body);
        assert!(!out.contains("should-not-appear"));
        assert!(out.contains("shows up"));
    }

    #[test]
    fn invalid_json_falls_back_to_raw() {
        let raw = "this is { not valid JSON";
        assert_eq!(derive_searchable_text(raw), raw);
    }

    #[test]
    fn empty_extraction_falls_back_to_raw() {
        // A JSON object whose only keys are reserved/ignored should yield
        // empty extraction; the raw input is returned instead so the FTS
        // index still has something to match against.
        let raw = serde_json::json!({ "id": "x", "url": "y" }).to_string();
        let out = derive_searchable_text(&raw);
        assert_eq!(out, raw);
    }
}
