$ErrorActionPreference = "Stop"

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$serviceExe = Join-Path $base "caddy-service.exe"

if (!(Test-Path $serviceExe)) {
    throw "Missing caddy-service.exe."
}

& $serviceExe stop
& $serviceExe uninstall
Write-Host "Caddy service stopped and uninstalled."
