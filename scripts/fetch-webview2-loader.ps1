# Fetch WebView2Loader.dll (x64) from the official Microsoft NuGet package
# and place it at src-tauri/embedded/runtime/WebView2Loader.dll.
#
# Run from the repo root:
#   pwsh scripts/fetch-webview2-loader.ps1
#
# The DLL is covered by the Microsoft Software License Terms for the
# Microsoft Edge WebView2 SDK. It is NOT redistributed in this repository;
# this script downloads it at build time from the official NuGet feed.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$NugetUrl  = 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2'
$TempDir   = Join-Path ([System.IO.Path]::GetTempPath()) 'webview2-sdk'
$NupkgPath = Join-Path $TempDir 'webview2.nupkg'
$ExtractDir = Join-Path $TempDir 'extracted'
$DestDir   = Join-Path $PSScriptRoot '..\src-tauri\embedded\runtime'
$DestDll   = Join-Path $DestDir 'WebView2Loader.dll'

Write-Host "Downloading WebView2 SDK from NuGet..."
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
Invoke-WebRequest -Uri $NugetUrl -OutFile $NupkgPath -UseBasicParsing

Write-Host "Extracting..."
New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
Expand-Archive -Path $NupkgPath -DestinationPath $ExtractDir -Force

$DllSource = Join-Path $ExtractDir 'build\native\x64\WebView2Loader.dll'
if (-not (Test-Path $DllSource)) {
    # Newer SDK layout
    $DllSource = Get-ChildItem -Path $ExtractDir -Filter 'WebView2Loader.dll' -Recurse |
        Where-Object { $_.FullName -match 'x64' } |
        Select-Object -First 1 -ExpandProperty FullName
}

if (-not $DllSource -or -not (Test-Path $DllSource)) {
    Write-Error "Could not locate WebView2Loader.dll (x64) inside the NuGet package."
    exit 1
}

New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
Copy-Item -Path $DllSource -Destination $DestDll -Force

$size = (Get-Item $DestDll).Length
Write-Host "OK: $DestDll ($size bytes)"
