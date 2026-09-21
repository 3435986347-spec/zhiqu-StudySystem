$ErrorActionPreference = "Stop"

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$serviceExe = Join-Path $base "zhiqu-backend.exe"
$jar = Join-Path $base "zhiqu-backend-0.0.1-SNAPSHOT.jar"
$config = Join-Path $base "application-prod.yml"
$serviceXml = Join-Path $base "zhiqu-backend.xml"

New-Item -ItemType Directory -Force -Path (Join-Path $base "logs") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $base "uploads") | Out-Null

if (!(Test-Path $serviceExe)) {
    throw "Missing zhiqu-backend.exe. Rename WinSW-x64.exe to zhiqu-backend.exe and put it in this directory."
}
if (!(Test-Path $jar)) {
    throw "Missing zhiqu-backend-0.0.1-SNAPSHOT.jar. Copy the packaged JAR into this directory."
}
if (!(Test-Path $config)) {
    throw "Missing application-prod.yml. Copy application-prod.example.yml to application-prod.yml and fill in secrets."
}
if (!(Test-Path $serviceXml)) {
    throw "Missing zhiqu-backend.xml."
}

& $serviceExe install
& $serviceExe start
Write-Host "Zhiqu backend service installed and started."
