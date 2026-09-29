param(
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cargoToml = Join-Path $root 'src-tauri\Cargo.toml'
$tauriConf = Join-Path $root 'src-tauri\tauri.conf.json'
$cargoLock = Join-Path $root 'src-tauri\Cargo.lock'
$installExe = 'S:\sub2api-account-usage\sub2api-account-usage.exe'

function Get-Version($path, $pattern) {
    $content = [System.IO.File]::ReadAllText($path)
    if ($content -match $pattern) { return $Matches[1] }
    throw "Cannot read version from $path"
}

function Set-FileUtf8NoBom($path, $content) {
    [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

$cargoVersion = Get-Version $cargoToml '(?m)^version\s*=\s*"([^"]+)"'
$tauriVersion = Get-Version $tauriConf '"version"\s*:\s*"([^"]+)"'
Write-Host "Current version: Cargo=$cargoVersion Tauri=$tauriVersion"

try {
    Set-FileUtf8NoBom $cargoToml (([System.IO.File]::ReadAllText($cargoToml)) -replace '(?m)^version\s*=\s*"[^"]+"', 'version = "0.0.0"')
    Set-FileUtf8NoBom $tauriConf (([System.IO.File]::ReadAllText($tauriConf)) -replace '"version"\s*:\s*"[^"]+"', '"version": "0.0.0"')

    Push-Location (Join-Path $root 'src-tauri')
    try { cargo tauri build --bundles nsis }
    finally { Pop-Location }
}
finally {
    Set-FileUtf8NoBom $cargoToml (([System.IO.File]::ReadAllText($cargoToml)) -replace '(?m)^version\s*=\s*"[^"]+"', "version = `"$cargoVersion`"")
    Set-FileUtf8NoBom $tauriConf (([System.IO.File]::ReadAllText($tauriConf)) -replace '"version"\s*:\s*"[^"]+"', "`"version`": `"$tauriVersion`"")
    # cargo build syncs the package version into Cargo.lock; restore it too.
    if (Test-Path -LiteralPath $cargoLock) {
        $lockText = [System.IO.File]::ReadAllText($cargoLock)
        $lockFixed = $lockText -replace '(?m)^name = "sub2api-account-usage"\r?\nversion = "0\.0\.0"', "name = `"sub2api-account-usage`"`nversion = `"$cargoVersion`""
        Set-FileUtf8NoBom $cargoLock $lockFixed
    }
}

Write-Host "Version restored: Cargo=$cargoVersion Tauri=$tauriVersion"

$setup = Get-ChildItem -LiteralPath (Join-Path $root 'src-tauri\target\release\bundle\nsis') -Filter '*_0.0.0_x64-setup.exe' -File |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'No 0.0.0 installer found' }
Write-Host "Installer: $($setup.FullName)"

if ($SkipInstall) { Write-Host 'Install skipped'; exit 0 }

Get-Process -Name 'sub2api-account-usage' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait
Start-Process -FilePath $installExe
Write-Host 'Installed and started'
