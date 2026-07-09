$ErrorActionPreference = "Stop"

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$serviceExe = Join-Path $base "zhiqu-backend.exe"

if (!(Test-Path $serviceExe)) {
    throw "Missing zhiqu-backend.exe."
}

& $serviceExe stop
& $serviceExe uninstall
Write-Host "Zhiqu backend service stopped and uninstalled."
