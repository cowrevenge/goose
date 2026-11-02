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

Needs git, Node 24 or newer and pnpm 10 (the script installs pnpm if missing).

1. `Unblock-File .\cow\cow-goose.ps1` (only needed if the script came from a download)
2. `.\cow\cow-goose.ps1 build`
3. `.\cow\cow-goose.ps1 install` (backs up the current `C:\Goose` first)

Goose.exe checks the hash of `resources\app.asar` (Electron asar integrity fuse), so the whole
app folder is replaced, never just the asar. The installed backend binaries are reused.

## Notes for local models (Strata / OpenAI-compatible)

Set in `%APPDATA%\Block\goose\config\config.yaml`:

- `GOOSE_AUTO_COMPACT_TOKEN_LIMIT: 524288` and `GOOSE_AUTO_COMPACT_THRESHOLD: 0.9`
  (Goose otherwise caps auto-compaction at a hardcoded 225k tokens).
- `GOOSE_SHELL: powershell` (cmd truncates commands at the first newline).
- Per-model `context_limit` in `custom_providers/*.json`; `null` means Goose's 128k default.
