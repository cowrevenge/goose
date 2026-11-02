# cow patches for Goose Desktop

Local changes on top of an upstream Goose release, built and installed on Windows.

## What's in here

- **Turn layout** (`ui/desktop/src`): one agent turn renders as a collapsible work section
  (thinking, tool calls, tool results, text written between tool calls) plus an always-visible
  final answer, the way claude.ai shows a turn. Live status line while running, a one-line summary
  when done (`Worked for 2m 14s · 6 tool calls · 1 failed`), opens by itself for a pending tool
  approval or a turn that ended without an answer.
- **`cow/cow-goose.ps1`**: build the desktop app from this checkout and install it over `C:\Goose`.

## Build and install (Windows)

Needs git, **Node 24** (what `ui/desktop/package.json` pins; Node 26 hangs the packager while it
unpacks Electron) and pnpm 10 (the script installs pnpm if missing).

Portable Node 24 for the build only, leaving the installed Node alone (run in the build window):

```powershell
$v=(irm https://nodejs.org/dist/index.json | ? version -like 'v24.*' | select -First 1).version; irm "https://nodejs.org/dist/$v/node-$v-win-x64.zip" -OutFile "$env:TEMP
ode24.zip"; Expand-Archive "$env:TEMP
ode24.zip" C:	ools -Force; $env:Path="C:	ools
ode-$v-win-x64;$env:Path"; node -v
```

1. `Unblock-File .\cow\cow-goose.ps1` (only needed if the script came from a download)
2. `.\cow\cow-goose.ps1 build` (UI only), or `.\cow\cow-goose.ps1 build -Backend` to also compile the
   backend (`goose.exe`) from this checkout; needs rustup and the Visual Studio C++ build tools
3. `.\cow\cow-goose.ps1 install` (backs up the current `C:\Goose` first)

Goose.exe checks the hash of `resources\app.asar` (Electron asar integrity fuse), so the whole
app folder is replaced, never just the asar. The installed backend binaries are reused.

## Notes for local models (Strata / OpenAI-compatible)

Set in `%APPDATA%\Block\goose\config\config.yaml`:

- `GOOSE_AUTO_COMPACT_TOKEN_LIMIT: 524288` and `GOOSE_AUTO_COMPACT_THRESHOLD: 0.9`
  (Goose otherwise caps auto-compaction at a hardcoded 225k tokens).
- `GOOSE_SHELL: pwsh` (PowerShell 7). `powershell` is Windows PowerShell 5.1, which has no `&&`/`||`;
  cmd truncates commands at the first newline.
- Per-model `context_limit` in `custom_providers/*.json`; `null` means Goose's 128k default.
