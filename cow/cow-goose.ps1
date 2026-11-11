# Builds Goose Desktop with the cow patches and installs it over C:\Goose (Windows).
#   .\cow\cow-goose.ps1 build     -> builds ui\desktop\out\Goose-win32-x64 (C:\Goose untouched)
#   .\cow\cow-goose.ps1 build -Backend  -> also compiles the backend (goose.exe) from this checkout
#   .\cow\cow-goose.ps1 install   -> backs up C:\Goose to C:\Goose.bak-<timestamp>, then installs the build
# Without -Backend the build reuses the backend binaries (resources\bin) of the installed Goose.
# The build needs Node 24. When the Node on PATH is another major, a portable Node 24 unpacked under
# -NodeDir (C:\tools by default) is put first on PATH for this build only; nothing installed changes.
# -Backend builds the x86_64-pc-windows-msvc target like upstream; needs rustup, the Visual Studio C++ build
# tools, LLVM (libclang) and CMake. The script checks all of them before building anything.
# Settings, providers and sessions live in %APPDATA%\Block\goose and are not touched.
param(
  [Parameter(Position = 0)][ValidateSet('build', 'install')][string]$Step = 'build',
  [string]$Src = (Split-Path $PSScriptRoot -Parent),
  [string]$Goose = 'C:\Goose',
  [string]$NodeDir = 'C:\tools',
  [switch]$Backend
)
$ErrorActionPreference = 'Stop'
$desktop = Join-Path $Src 'ui\desktop'
$out = Join-Path $desktop 'out\Goose-win32-x64'

if ($Step -eq 'build') {
  # The desktop build pins Node 24 (ui/desktop/package.json engines). Newer majors can hang
  # electron-packager while it unpacks Electron, with no error.
  function Get-NodeVersion { try { (node -v) } catch { '' } }
  function Get-NodeMajor { $v = Get-NodeVersion; if ($v) { [int]($v.TrimStart('v').Split('.')[0]) } else { 0 } }
  if ((Get-NodeMajor) -ne 24) {
    # A portable Node 24 unpacked under $NodeDir, newest first. PATH is changed for this process only.
    $portable = Get-ChildItem $NodeDir -Directory -Filter 'node-v24*-win-x64' -ErrorAction SilentlyContinue |
                Sort-Object Name | Select-Object -Last 1
    if ($portable) {
      $env:Path = "$($portable.FullName);$env:Path"
      "Using the portable Node at $($portable.FullName) for this build ($(Get-NodeVersion))"
    }
  }
  if ((Get-NodeMajor) -ne 24) {
    throw ("Node 24 is needed for this build (found '$(Get-NodeVersion)'), and no node-v24*-win-x64 folder is in $NodeDir. " +
           "Unpack one there, then run this again:`n" +
           "  curl.exe -L -o `"`$env:TEMP\node24.zip`" https://nodejs.org/dist/v24.22.2/node-v24.22.2-win-x64.zip`n" +
           "  Expand-Archive `"`$env:TEMP\node24.zip`" $NodeDir -Force")
  }
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { npm install -g pnpm@10 }
  if (-not (Test-Path "$Goose\resources\bin")) { throw "$Goose\resources\bin not found: the build reuses your installed backend" }

  $target = 'x86_64-pc-windows-msvc'
  if ($Backend) {
    # Same toolchain as upstream's Windows bundle (.github/workflows/bundle-windows.yml). Checked before the
    # UI build so a missing piece fails in seconds. llama-cpp-sys-2 needs libclang (bindgen) and CMake.
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'cargo not found. Install: winget install -e --id Rustlang.Rustup' }
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $vc = if (Test-Path $vswhere) { & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }
    if (-not $vc) { throw 'MSVC C++ build tools not found. Install: winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' }
    if (-not $env:LIBCLANG_PATH) {
      $llvm = Join-Path $env:ProgramFiles 'LLVM\bin'
      if (Test-Path (Join-Path $llvm 'libclang.dll')) { $env:LIBCLANG_PATH = $llvm } else { throw 'libclang not found. Install: winget install -e --id LLVM.LLVM' }
    }
    if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
      $cmakeBin = Join-Path $env:ProgramFiles 'CMake\bin'
      if (Test-Path (Join-Path $cmakeBin 'cmake.exe')) { $env:Path = "$cmakeBin;$env:Path" } else { throw 'cmake not found. Install: winget install -e --id Kitware.CMake' }
    }
    # Inside the repo so it applies to the toolchain rust-toolchain.toml pins.
    Push-Location $Src
    try { rustup target add $target; if ($LASTEXITCODE) { throw "rustup target add $target failed" } } finally { Pop-Location }
    "Backend prerequisites OK (MSVC, libclang at $env:LIBCLANG_PATH, cmake)"
  }

  Push-Location (Join-Path $Src 'ui')
  try { pnpm install --frozen-lockfile; if ($LASTEXITCODE) { throw 'pnpm install failed' } } finally { Pop-Location }
  Push-Location $desktop
  try { pnpm run package; if ($LASTEXITCODE) { throw 'pnpm run package failed' } } finally { Pop-Location }
  if (-not (Test-Path "$out\Goose.exe")) { throw "build finished but $out\Goose.exe is missing" }

  # Same backend as the installed Goose, laid over the build output (the source tree stays clean).
  Copy-Item "$Goose\resources\bin\*" "$out\resources\bin\" -Recurse -Force

  if ($Backend) {
    Push-Location $Src
    try { cargo build --release --target $target -p goose-cli --bin goose; if ($LASTEXITCODE) { throw 'cargo build failed' } } finally { Pop-Location }
    Copy-Item (Join-Path $Src "target\$target\release\goose.exe") "$out\resources\bin\goose.exe" -Force
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
