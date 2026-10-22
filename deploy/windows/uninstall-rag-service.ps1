$ErrorActionPreference = "Stop"
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$serviceExe = Join-Path $base "zhiqu-rag.exe"
if (!(Test-Path -LiteralPath $serviceExe)) { throw "Missing zhiqu-rag.exe" }
& $serviceExe stop
& $serviceExe uninstall
Write-Host "Zhiqu RAG sidecar service removed."
