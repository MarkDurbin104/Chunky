# Download the BGE-small-en-v1.5 model.safetensors file.
#
# The file is ~133 MB — too large for GitHub's 100 MB per-file limit,
# so we don't commit it. Instead we fetch it at build time from
# HuggingFace's public release of BAAI/bge-small-en-v1.5.
#
# Idempotent: skips the download if the file is already present with
# a plausible size.

param(
    [string]$Destination = "$PSScriptRoot\..\src-tauri\embedded\models\bge-small-en-v1.5\model.safetensors"
)

$ErrorActionPreference = 'Stop'
$Url = 'https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/model.safetensors'
$ExpectedSize = 133466304  # 127 MiB

$destParent = Split-Path -Parent $Destination
if (-not (Test-Path $destParent)) {
    New-Item -ItemType Directory -Force -Path $destParent | Out-Null
}

if (Test-Path $Destination) {
    $existing = (Get-Item $Destination).Length
    if ($existing -eq $ExpectedSize) {
        Write-Host "[fetch-bge-model] already present at $Destination (matches expected size)"
        exit 0
    }
    Write-Host "[fetch-bge-model] existing file wrong size ($existing bytes, expected $ExpectedSize); re-fetching"
}

Write-Host "[fetch-bge-model] downloading $Url"
Write-Host "[fetch-bge-model] to $Destination"
Invoke-WebRequest -Uri $Url -OutFile $Destination

$actual = (Get-Item $Destination).Length
if ($actual -ne $ExpectedSize) {
    Write-Warning "[fetch-bge-model] downloaded size $actual != expected $ExpectedSize; the model may have been updated upstream."
}

Write-Host "[fetch-bge-model] done ($actual bytes)"
