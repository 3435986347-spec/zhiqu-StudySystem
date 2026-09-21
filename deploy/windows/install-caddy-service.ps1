$ErrorActionPreference = "Stop"

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$serviceExe = Join-Path $base "caddy-service.exe"
$caddyExe = Join-Path $base "caddy.exe"
$caddyfile = Join-Path $base "Caddyfile"
$serviceXml = Join-Path $base "caddy-service.xml"

New-Item -ItemType Directory -Force -Path (Join-Path $base "logs") | Out-Null

if (!(Test-Path $serviceExe)) {
    throw "Missing caddy-service.exe. Rename WinSW-x64.exe to caddy-service.exe and put it in this directory."
}
if (!(Test-Path $caddyExe)) {
    throw "Missing caddy.exe."
}
if (!(Test-Path $caddyfile)) {
    throw "Missing Caddyfile. Copy Caddyfile.example to Caddyfile and replace your-domain.com."
}
if (!(Test-Path $serviceXml)) {
    throw "Missing caddy-service.xml."
}

& $caddyExe validate --config $caddyfile --adapter caddyfile
& $serviceExe install
& $serviceExe start
Write-Host "Caddy service installed and started."
