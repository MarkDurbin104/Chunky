#!/usr/bin/env bash
# Download the BGE-small-en-v1.5 model.safetensors file.
#
# The file is ~133 MB — too large for GitHub's 100 MB per-file limit,
# so we don't commit it. Instead we fetch it at build time from
# HuggingFace's public release of BAAI/bge-small-en-v1.5.
#
# Idempotent: skips the download if the file is already present with a
# plausible size.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-$SCRIPT_DIR/../src-tauri/embedded/models/bge-small-en-v1.5/model.safetensors}"
URL='https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/model.safetensors'
EXPECTED_SIZE=133466304

mkdir -p "$(dirname "$DEST")"

if [[ -f "$DEST" ]]; then
    if command -v stat >/dev/null 2>&1; then
        actual_size=$(stat -c%s "$DEST" 2>/dev/null || stat -f%z "$DEST" 2>/dev/null || echo 0)
    else
        actual_size=$(wc -c < "$DEST")
    fi
    if [[ "$actual_size" -eq "$EXPECTED_SIZE" ]]; then
        echo "[fetch-bge-model] already present at $DEST (matches expected size)"
        exit 0
    fi
    echo "[fetch-bge-model] existing file wrong size ($actual_size bytes, expected $EXPECTED_SIZE); re-fetching"
fi

echo "[fetch-bge-model] downloading $URL"
echo "[fetch-bge-model] to $DEST"

if command -v curl >/dev/null 2>&1; then
    curl -fL --progress-bar -o "$DEST" "$URL"
elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress -O "$DEST" "$URL"
else
    echo "[fetch-bge-model] neither curl nor wget available; please install one and retry." >&2
    exit 1
fi

if command -v stat >/dev/null 2>&1; then
    actual_size=$(stat -c%s "$DEST" 2>/dev/null || stat -f%z "$DEST" 2>/dev/null || echo 0)
else
    actual_size=$(wc -c < "$DEST")
fi

if [[ "$actual_size" -ne "$EXPECTED_SIZE" ]]; then
    echo "[fetch-bge-model] WARNING: downloaded size $actual_size != expected $EXPECTED_SIZE; the model may have been updated upstream." >&2
fi

echo "[fetch-bge-model] done ($actual_size bytes)"
