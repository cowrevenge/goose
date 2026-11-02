# Builds Goose Desktop with the cow patches and installs it over C:\Goose (Windows).
#   .\cow\cow-goose.ps1 build     -> builds ui\desktop\out\Goose-win32-x64 (C:\Goose untouched)
#   .\cow\cow-goose.ps1 build -Backend  -> also compiles the backend (goose.exe) from this checkout
#   .\cow\cow-goose.ps1 install   -> backs up C:\Goose to C:\Goose.bak-<timestamp>, then installs the build
# Without -Backend the build reuses the backend binaries (resources\bin) of the installed Goose.
# -Backend needs rustup (the repo's rust-toolchain.toml picks the version) and the Visual Studio C++ build tools.
# Settings, providers and sessions live in %APPDATA%\Block\goose and are not touched.
param(
  [Parameter(Position = 0)][ValidateSet('build', 'install')][string]$Step = 'build',
  [string]$Src = (Split-Path $PSScriptRoot -Parent),
  [string]$Goose = 'C:\Goose',
  [switch]$Backend
)
$ErrorActionPreference = 'Stop'
$desktop = Join-Path $Src 'ui\desktop'
$out = Join-Path $desktop 'out\Goose-win32-x64'

if ($Step -eq 'build') {
  # The desktop build pins Node 24 (ui/desktop/package.json engines). Newer majors can hang
  # electron-packager while it unpacks Electron, with no error.
  $major = [int]((node -v).TrimStart('v').Split('.')[0])
  if ($major -ne 24) { throw "Node 24 is needed for this build (found $(node -v)). See cow/README.md for a portable Node 24 that leaves your installed Node alone." }
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { npm install -g pnpm@10 }
  if (-not (Test-Path "$Goose\resources\bin")) { throw "$Goose\resources\bin not found: the build reuses your installed backend" }

  Push-Location (Join-Path $Src 'ui')
  try { pnpm install --frozen-lockfile; if ($LASTEXITCODE) { throw 'pnpm install failed' } } finally { Pop-Location }
  Push-Location $desktop
  try { pnpm run package; if ($LASTEXITCODE) { throw 'pnpm run package failed' } } finally { Pop-Location }
  if (-not (Test-Path "$out\Goose.exe")) { throw "build finished but $out\Goose.exe is missing" }

  # Same backend as the installed Goose, laid over the build output (the source tree stays clean).
  Copy-Item "$Goose\resources\bin\*" "$out\resources\bin\" -Recurse -Force

  if ($Backend) {
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'cargo not found: install rustup (winget install -e --id Rustlang.Rustup) and the VS C++ build tools' }
    Push-Location $Src
    try { cargo build --release -p goose-cli --bin goose; if ($LASTEXITCODE) { throw 'cargo build failed' } } finally { Pop-Location }
    Copy-Item (Join-Path $Src 'target\release\goose.exe') "$out\resources\bin\goose.exe" -Force
    "Backend: goose.exe built from this checkout"
  }

  "BUILD OK: $out"
  "Next: .\cow\cow-goose.ps1 install"
}

if ($Step -eq 'install') {
  if (-not (Test-Path "$out\Goose.exe")) { throw "No build at $out. Run .\cow\cow-goose.ps1 build first." }
  Get-Process goose*, Goose* -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep 2
  $bak = "$Goose.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  if (Test-Path $Goose) { Move-Item $Goose $bak; "Backup: $bak" }
  Copy-Item $out $Goose -Recurse
  "INSTALLED: $Goose  (version $((Get-Item "$Goose\Goose.exe").VersionInfo.ProductVersion))"
  "Undo: Remove-Item $Goose -Recurse -Force; Move-Item $bak $Goose"
}
