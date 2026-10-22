$ErrorActionPreference = "Stop"

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$serviceExe = Join-Path $base "zhiqu-rag.exe"
$serviceXml = Join-Path $base "zhiqu-rag.xml"
$ragRoot = Join-Path $base "rag-service"
$python = Join-Path $ragRoot ".venv\Scripts\python.exe"
$config = Join-Path $ragRoot ".env"
$model = "C:\zhiqu\models\bge-small-zh-v1.5"
$data = "C:\zhiqu\rag-data"
$logs = Join-Path $base "logs"

foreach ($required in @($serviceExe, $serviceXml, $python, $config)) {
    if (!(Test-Path -LiteralPath $required)) {
        throw "Missing required RAG service file: $required"
    }
}
if (!(Test-Path -LiteralPath $model -PathType Container)) {
    throw "Local embedding model is missing: $model. Download it during deployment preparation; production startup must not download models."
}

New-Item -ItemType Directory -Force -Path $data | Out-Null
New-Item -ItemType Directory -Force -Path $logs | Out-Null

Push-Location $ragRoot
try {
    & $python -c "from app.settings import Settings; s=Settings(); s.prepare(); print('RAG configuration OK')"
    if ($LASTEXITCODE -ne 0) { throw "RAG configuration validation failed." }
} finally {
    Pop-Location
}

& $serviceExe install
if ($LASTEXITCODE -ne 0) { throw "Failed to install zhiqu-rag service." }
& $serviceExe start
if ($LASTEXITCODE -ne 0) { throw "Failed to start zhiqu-rag service." }

Write-Host "Zhiqu RAG sidecar installed and started on 127.0.0.1:8001."
