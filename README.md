# Chunky

A local knowledge-graph desktop app for organising files into projects and
collections, extracting text from PDFs / Office documents / images, and
exposing the whole graph to Claude Code / Claude Desktop via an embedded
MCP server. All data stays on your machine.

- **Ingest**: drop `.pdf`, `.docx` / `.doc`, `.pptx` / `.ppt`, `.xlsx` / `.xls`,
  `.csv`, `.msg` (Outlook), `.md`, `.txt`, images (PNG / JPG / GIF / WEBP /
  BMP / SVG), or source code onto a project. Text is extracted and indexed;
  images pass through an LLM OCR pass so their contents are searchable.
- **Organise**: assets auto-bucket by type (Documents / Slides / PDFs /
  Spreadsheets / Emails / Images / Code / Links / Paragraphs). You can also
  create named collections and drag assets between them.
- **Search**: hybrid retrieval — FTS5 lexical + sqlite-vec cosine similarity
  over BGE-small embeddings, fused into a single ranked result.
- **Claude access**: Chunky registers itself as an MCP server with Claude
  Code and Claude Desktop on launch; nine read-only tools (`search_nodes`,
  `get_node`, `list_assets_in_project`, `get_image`, …) expose the graph.

---

## Install (pre-built releases)

The fastest path is to grab an installer from
[Releases](https://github.com/markdurbin104/chunky/releases). Skip to
**[Build from source](#build-from-source)** if you want to compile it
yourself.

### Windows — pre-built

1. Download **`Chunky_<version>_x64-setup.exe`** (NSIS installer).
2. Double-click to install. Per-user install, no admin rights needed; lands
   in `%LOCALAPPDATA%\Programs\chunky`.
3. On Windows 10 21H1 or older the installer will silently download and
   install the WebView2 Runtime first. Windows 11 and fully-updated
   Windows 10 22H2+ already have it.
4. First launch:
   - Extracts the BGE embedding model to
     `%APPDATA%\com.chunky.desktop\models\bge-small-en-v1.5\` (~130 MB,
     one-time).
   - Registers the `chunky` MCP server with any Claude Desktop / Claude
     Code installations it finds.

**Uninstall**: *Settings → Apps → Chunky → Uninstall*, or run the
`Uninstall Chunky.exe` in the install folder. Data lives in
`%APPDATA%\com.chunky.desktop\`; the uninstaller leaves it in place so
re-installing keeps your projects.

### macOS — pre-built

1. Download the DMG that matches your Mac:
   - **Apple silicon (M1 / M2 / M3 / M4)**: `Chunky_<version>_aarch64.dmg`
   - **Intel**: `Chunky_<version>_x64.dmg`
   - **Universal** (both, larger): `Chunky_<version>_universal.dmg`
2. Open the DMG and drag **Chunky.app** into `/Applications`.
3. First launch will show *"Chunky cannot be opened because the developer
   cannot be verified"* (the project isn't notarized yet):
   - Right-click **Chunky.app** → *Open* → *Open* in the security dialog.
   - Or *System Settings → Privacy & Security → Open Anyway* after the
     first blocked launch.
4. First launch extracts the model to
   `~/Library/Application Support/com.chunky.desktop/models/`.

Requires macOS 10.15 Catalina or newer.

**Uninstall**: drag Chunky.app to Trash. Data lives in
`~/Library/Application Support/com.chunky.desktop/`.

### Linux — pre-built

Pick one of the bundles:

```bash
# AppImage (portable, no install)
chmod +x Chunky_<version>_amd64.AppImage
./Chunky_<version>_amd64.AppImage

# Debian / Ubuntu (pulls system deps automatically)
sudo apt install ./Chunky_<version>_amd64.deb

# Fedora / RHEL
sudo dnf install Chunky-<version>-1.x86_64.rpm
```

Runtime system libraries the `.deb` / `.rpm` pull in:
`libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1` (Fedora
names: `webkit2gtk4.1`, `gtk3`, `libappindicator-gtk3`). AppImage has no
external dependency requirement.

Data lives in `~/.local/share/com.chunky.desktop/`.

---

## Build from source

The instructions below are **complete recipes** starting from a fresh
machine — clone the repo, install the toolchain, run the dev app, then
produce a redistributable installer. Follow the section for your OS
top to bottom.

Common to all OSes: the repo layout is a **pnpm workspace** with a single
React app under `src/ui-app/` and a Tauri 2 Rust crate under
`src-tauri/`. `pnpm install` handles Node deps; Rust crates fetch
themselves on the first `cargo` invocation.

### Windows

Tested on Windows 10 22H2 and Windows 11 23H2.

#### 1. Toolchain

Install these once. Order matters — install Rust *after* Visual Studio
Build Tools so it picks the MSVC linker.

```powershell
# 1a. Visual Studio Build Tools 2022 — provides `link.exe` and the MSVC
#     C runtime that Rust and rusqlite/sqlite-vec need.
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# 1b. Node.js 20 LTS
winget install OpenJS.NodeJS.LTS

# 1c. pnpm 9 (via npm; corepack also works)
npm install -g pnpm@9

# 1d. Rust stable (MSVC toolchain, x64)
winget install Rustlang.Rustup
rustup default stable-x86_64-pc-windows-msvc

# 1e. (Optional) Claude Code CLI — enables chat features
npm install -g @anthropic-ai/claude-code
```

Verify:

```powershell
node --version    # v20.x
pnpm --version    # 9.x
rustc --version   # 1.77+
cl.exe            # should be found on PATH (via VS Developer Prompt or after opening a fresh PowerShell)
```

#### 2. Clone and install

```powershell
git clone https://github.com/markdurbin104/chunky.git
cd chunky
pnpm install
```

If `pnpm install` complains about UNC paths or workspace resolution,
run from inside `src/ui-app` with `pnpm install --ignore-workspace`.

#### 3. Fetch build-time assets

Two large files aren't checked in — the Windows WebView2 loader DLL (~120 KB)
and the BGE embedding model (~133 MB, exceeds GitHub's 100 MB per-file
limit). Both fetch from public sources:

```powershell
pwsh scripts/fetch-webview2-loader.ps1
pwsh scripts/fetch-bge-model.ps1
```

Skip either and `build.rs` fails with a boxed error message telling you
exactly which is missing.

#### 4. Run in dev mode

```powershell
pnpm tauri dev
```

Vite serves the UI at `http://localhost:5173`; Tauri opens a native
window pointed at that URL. Rust changes trigger a rebuild + relaunch
(via `tauri dev`'s file watcher); frontend changes hot-reload without
restarting the window.

If Vite starts but the window shows a blank page, the frontend build
may have errored — check `pnpm --filter @chunky/ui-app dev` output.

#### 5. Build the release installer

```powershell
pnpm tauri build
```

The full flow (Rust release compile + candle LTO + Vite production
bundle + NSIS packaging) takes 10–15 minutes on a warm cache, ~25
minutes cold. Artifacts land in `src-tauri/target/release/bundle/`:

- `nsis/Chunky_<version>_x64-setup.exe` — the NSIS installer to
  distribute
- `msi/Chunky_<version>_x64_en-US.msi` — MSI installer (produced only
  if WiX Toolset is installed; optional)

#### 6. Install and verify

Double-click the NSIS `.exe` from step 5, then follow the pre-built
[Install → Windows](#windows--pre-built) section from step 3 onwards.

---

### macOS

Tested on macOS 14 Sonoma (Apple silicon) and macOS 12 Monterey
(Intel).

#### 1. Toolchain

```bash
# 1a. Xcode Command Line Tools — provides clang, ld, macOS SDK
xcode-select --install

# 1b. Homebrew if not present
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 1c. Node 20 LTS + pnpm 9
brew install node@20 pnpm

# 1d. Rust stable
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustup default stable

# 1e. (Optional) Claude Code CLI
npm install -g @anthropic-ai/claude-code
```

Verify:

```bash
node --version   # v20.x
pnpm --version   # 9.x
rustc --version  # 1.77+
clang --version  # from Xcode CLT
```

#### 2. Clone and install

```bash
git clone https://github.com/markdurbin104/chunky.git
cd chunky
pnpm install
```

#### 3. Fetch the BGE embedding model

The 133 MB model file isn't in the repo (exceeds GitHub's 100 MB
per-file limit). Pull it from HuggingFace:

```bash
bash scripts/fetch-bge-model.sh
```

Skip and `build.rs` fails with a clear "MISSING" error.

#### 4. Run in dev mode

```bash
pnpm tauri dev
```

Same behaviour as Windows — Vite on `http://localhost:5173`, Tauri
window opens against it. First cold build takes 10–15 min for the Rust
side.

#### 5. Build the release bundle

**Single-architecture build** (native to your Mac):

```bash
pnpm tauri build
```

**Universal build** (arm64 + x86_64 fat binary):

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm tauri build --target universal-apple-darwin
```

Artifacts land in `src-tauri/target/release/bundle/`:

- `macos/Chunky.app` — the app bundle
- `dmg/Chunky_<version>_<arch>.dmg` — the distributable DMG

#### 6. Sign and notarize (optional, for distribution)

Without signing, users get a "cannot be opened" security warning on
first launch and have to right-click → Open. To ship a smooth-install
DMG you need a paid Apple Developer account:

```bash
export APPLE_CERTIFICATE="<base64 of the .p12 export>"
export APPLE_CERTIFICATE_PASSWORD="<p12 password>"
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="<your apple id email>"
export APPLE_ID_PASSWORD="<app-specific password>"
export APPLE_TEAM_ID="<10-char team id>"
pnpm tauri build
```

Tauri signs the bundle with the identity above. Notarization submission
isn't wired into the build yet — you'll need to run
`xcrun notarytool submit …` manually against the DMG until we wire
[the follow-up](#installer-follow-ups). CI does the same env-var flow
via GitHub Secrets.

#### 7. Install and verify

Open the DMG and follow the pre-built
[Install → macOS](#macos--pre-built) section from step 2 onwards.

---

### Linux

Tested on Ubuntu 22.04 LTS and Fedora 40. The same steps work on their
derivatives (Debian 12, Pop!_OS, RHEL 9, Alma / Rocky Linux).

#### 1. Toolchain and system libs

**Debian / Ubuntu:**

```bash
sudo apt update
sudo apt install -y \
  build-essential curl file git pkg-config \
  libgtk-3-dev libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev \
  patchelf

# Node 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# pnpm via npm
sudo npm install -g pnpm@9

# Rust stable
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# (Optional) Claude Code CLI
sudo npm install -g @anthropic-ai/claude-code
```

**Fedora / RHEL:**

```bash
sudo dnf install -y \
  gcc-c++ make git pkg-config \
  gtk3-devel webkit2gtk4.1-devel \
  libappindicator-gtk3-devel librsvg2-devel \
  patchelf nodejs npm

sudo npm install -g pnpm@9

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

sudo npm install -g @anthropic-ai/claude-code   # optional
```

Verify (same as other OSes):

```bash
node --version && pnpm --version && rustc --version && pkg-config --modversion webkit2gtk-4.1
```

#### 2. Clone and install

```bash
git clone https://github.com/markdurbin104/chunky.git
cd chunky
pnpm install
```

#### 3. Fetch the BGE embedding model

```bash
bash scripts/fetch-bge-model.sh
```

The 133 MB model isn't in the repo; the script pulls it from HuggingFace
(idempotent — skips if already present at the expected size). Skip and
`build.rs` fails with a clear "MISSING" error.

#### 4. Run in dev mode

```bash
pnpm tauri dev
```

If the window opens but shows a WebKit / GTK error, double-check
`webkit2gtk-4.1` (note the 4.1 — Tauri 2 no longer supports 4.0).

#### 5. Build the release bundles

```bash
pnpm tauri build
```

Artifacts land in `src-tauri/target/release/bundle/`:

- `appimage/Chunky_<version>_amd64.AppImage`
- `deb/Chunky_<version>_amd64.deb`
- `rpm/Chunky-<version>-1.x86_64.rpm`

Tauri produces all three on Linux by default (`bundle.targets: "all"`
in `tauri.conf.json`).

#### 6. Install and verify

Follow the pre-built [Install → Linux](#linux--pre-built) section.

---

## Continuous integration

`.github/workflows/build.yml` runs a matrix build on every tagged
release (`v*`):

- `windows-latest` → NSIS + MSI
- `macos-latest` (aarch64-apple-darwin)
- `macos-latest` (x86_64-apple-darwin)
- `ubuntu-22.04` → AppImage + .deb + .rpm
- `macos-latest` (universal) — combines the two macOS builds

Each job produces the same artifacts as the local build steps above,
plus attaches them to a draft GitHub Release. Apple signing pulls
credentials from repository secrets.

---

## Configuring Claude to use Chunky

Chunky auto-registers itself as an MCP server on every launch. Auto-config
is fully cross-platform — the same logic runs on Windows, macOS, and Linux
against each OS's canonical Claude config location. No manual JSON editing.

**Config files Chunky writes to (per OS):**

| Client                | Windows                                                                       | macOS                                                                          | Linux                                          |
|-----------------------|-------------------------------------------------------------------------------|--------------------------------------------------------------------------------|-------------------------------------------------|
| Claude Desktop        | `%APPDATA%\Claude\claude_desktop_config.json`                                 | `~/Library/Application Support/Claude/claude_desktop_config.json`              | `~/.config/Claude/claude_desktop_config.json`   |
| Claude Desktop (MSIX) | `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json` | —                                                                              | —                                               |
| Claude Code CLI       | `%USERPROFILE%\.claude.json`                                                  | `~/.claude.json`                                                               | `~/.claude.json`                                |
| Claude Code perms     | `%USERPROFILE%\.claude\settings.json`                                         | `~/.claude/settings.json`                                                      | `~/.claude/settings.json`                       |

On each launch Chunky enumerates the locations that apply to its OS, and:

- **Adds** a `mcpServers.chunky` entry pointing at itself if one isn't
  already there (creating the config file if this is the first MCP
  server registered).
- **Updates** the entry if the path or `SEMANTIC_DB_PATH` changed since
  last launch (e.g. you moved the installed exe).
- **Pre-authorises** Chunky's read-only tools in Claude Code's
  `permissions.allow` list so it doesn't prompt on every call.
- **Leaves other fields alone** — this is a merge, not an overwrite.

Caveats:

- **Claude Desktop must have been launched at least once** before its
  config directory exists on disk. If you install Chunky before Claude
  Desktop, run Claude Desktop once, then relaunch Chunky.
- **Claude Desktop from the Mac App Store** writes into an Apple
  sandbox that Chunky can't reach. Use the direct-download version if
  you want auto-config to work on macOS.
- **The Claude Code CLI config** (`~/.claude.json`) is only touched if
  it already exists — Chunky doesn't create it. Run `claude` at least
  once to generate it.

Once registered, ask Claude something like *"list the assets in my
Chunky project"* — the client auto-discovers Chunky's tools from the
registration. The MCP server is read-only; nothing Claude does can
modify your local data.

---

## Data location

| OS      | Data root                                                                 |
|---------|---------------------------------------------------------------------------|
| Windows | `%APPDATA%\com.chunky.desktop\`                                           |
| macOS   | `~/Library/Application Support/com.chunky.desktop/`                       |
| Linux   | `~/.local/share/com.chunky.desktop/`                                      |

Layout inside that root:

```
├── drafts/            # unpromoted node JSON blobs
├── kb/                # canonical node JSON blobs (source of truth)
│   ├── projects/
│   ├── collections/
│   ├── images/
│   ├── pdfs/
│   └── …
├── index/             # SQLite + sqlite-vec index (semantic.db)
├── models/            # extracted BGE-small-en-v1.5 (~130 MB)
├── cache/             # LLM OCR cache keyed by image sha256
├── logs/              # audit + startup logs
└── settings.json      # per-machine settings
```

The `kb/` tree is the authoritative store — the SQLite index is
rebuildable from it on next launch, so `index/` can be deleted safely to
force a reindex.

---

## Installer follow-ups

The following aren't wired up yet — happy to enable any of them on
request:

- **Auto-update via Tauri updater** — set `createUpdaterArtifacts: true`,
  generate an update-signing key, publish `latest.json` alongside
  releases.
- **File associations** — right-click / drag-to-dock / Files app default
  handler for `.pdf`, `.docx`, `.msg`, image types.
- **Windows code-signing** — buy a code-signing cert; SmartScreen stops
  flagging the installer.
- **macOS notarization submission** — the CI already has `APPLE_*` env
  vars scaffolded but the notarization step isn't in the workflow.
- **Download-on-first-launch model** — drop installer size from ~140 MB
  to ~10 MB by fetching the BGE model on first launch instead of
  bundling it.
