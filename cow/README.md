# cow patches for Goose Desktop

Local changes on top of an upstream Goose release, built and installed on Windows.

## What's in here

- **Turn layout** (`ui/desktop/src`): one agent turn renders as a collapsible work section
  (thinking, tool calls, tool results, text written between tool calls) plus an always-visible
  final answer, the way claude.ai shows a turn. Live status line while running, a one-line summary
  when done (`Worked for 2m 14s · 6 tool calls · 1 failed`), opens by itself for a pending tool
  approval or a turn that ended without an answer. Thinking steps follow the Show Thinking setting
  (Settings > Chat): Collapsed lists each as a closed line, Always lists it open, Never leaves it out.
- **`cow/cow-goose.ps1`**: build the desktop app from this checkout and install it over `C:\Goose`.

## Build and install (Windows)

Needs git, **Node 24** (what `ui/desktop/package.json` pins; Node 26 hangs the packager while it
unpacks Electron) and pnpm 10 (the script installs pnpm if missing).

The build finds Node 24 by itself: unpack a portable one under `C:\tools` (or pass `-NodeDir`) and
`cow-goose.ps1 build` puts it first on PATH for that build only, leaving the installed Node alone.
To fetch it once (nodejs.org rejects `irm`, so use `curl.exe`):

```powershell
curl.exe -L -o "$env:TEMP\node24.zip" https://nodejs.org/dist/v24.22.2/node-v24.22.2-win-x64.zip; Expand-Archive "$env:TEMP\node24.zip" C:\tools -Force
```

1. `Unblock-File .\cow\cow-goose.ps1` (only needed if the script came from a download)
2. `.\cow\cow-goose.ps1 build` (UI only), or `.\cow\cow-goose.ps1 build -Backend` to also compile the
   backend (`goose.exe`) from this checkout. Same toolchain as upstream's Windows bundle
   (`x86_64-pc-windows-msvc`): rustup, the Visual Studio C++ build tools, LLVM (libclang, for the
   bundled llama.cpp bindings) and CMake. The script checks these first and prints the `winget`
   command for anything missing.
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

## Switching the model from the picker (`model_switch_url`)

Strata serves one model per server process: it ignores the `model` name in a request and answers
with whatever config it was started on. So picking another model in Goose would change the label
and the context limit while the weights stayed put, and nothing would say so.

Setting `model_switch_url` on a custom provider fixes that. Before each request Goose POSTs
`{"model": "<name>"}` there and waits for a success, then sends the completion:

```json
"model_switch_url": "http://127.0.0.1:8081/model"
```

That address is StrataTray v13 or later, which listens on loopback and restarts Strata on the
config whose `model_name` matches. Strata starts lazily, so the switcher only has to get the right
server listening; the weights then load inside Goose's own first request, as they always did.

It is a separate request, so a restart cannot eat the completion's timeout. A switcher that is not
running is ignored, since that leaves the behaviour this had before. A switcher that *refuses*,
because no config has that model, fails the request instead, which is the point: the alternative is
an answer from a different model with nothing to show for it.
