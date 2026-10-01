param(
    [string]$Root = "C:\zhiqu",
    [string]$DatabaseName = "zhiqu_db",
    [string]$DatabaseUser = "zhiqu_app",
    [string]$DatabaseHost = "127.0.0.1",
    [string]$MySqlDumpPath = "mysqldump",
    [string]$RclonePath = "C:\rclone\rclone.exe",
    [string]$RcloneRemotePath = "zhiqu-backup:zhiqu-backup",
    [int]$LocalRetentionDays = 3,
    [int]$RemoteRetentionDays = 30,
    [switch]$SkipRemotePrune
)

$ErrorActionPreference = "Stop"

$backupRoot = Join-Path $Root "backup"
$logsRoot = Join-Path $Root "logs"
$uploadsRoot = Join-Path $Root "uploads"
$configFile = Join-Path $Root "application-prod.yml"
$logFile = Join-Path $logsRoot "backup-zhiqu.log"
$rcloneLogFile = Join-Path $logsRoot "rclone-backup.log"

function Write-BackupLog {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
    Write-Host $line
    Add-Content -Path $logFile -Value $line -Encoding UTF8
}

function Assert-Available {
    param(
        [string]$Command,
        [string]$Name
    )
    if ($Command -match "^[A-Za-z]:\\") {
        if (-not (Test-Path $Command)) {
            throw "$Name not found: $Command"
        }
        return
    }
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "$Name not found in PATH: $Command"
    }
}

New-Item -ItemType Directory -Force -Path $backupRoot, $logsRoot | Out-Null

$dbPassword = $env:ZHIQU_DB_PASSWORD
if ([string]::IsNullOrWhiteSpace($dbPassword)) {
    throw "Missing env var ZHIQU_DB_PASSWORD. Set it before running scheduled backups."
}

Assert-Available -Command $MySqlDumpPath -Name "mysqldump"
Assert-Available -Command $RclonePath -Name "rclone"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$tempDir = Join-Path $backupRoot "temp-$stamp"
$dumpFile = Join-Path $tempDir "$DatabaseName.sql"
$zipFile = Join-Path $backupRoot "zhiqu-$stamp.zip"

try {
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
    Write-BackupLog "Backup started: $stamp"

    $oldMysqlPwd = $env:MYSQL_PWD
    $env:MYSQL_PWD = $dbPassword
    try {
        $dumpArgs = @(
            "--host=$DatabaseHost",
            "--user=$DatabaseUser",
            "--single-transaction",
            "--routines",
            "--events",
            "--triggers",
            "--default-character-set=utf8mb4",
            "--result-file=$dumpFile",
            $DatabaseName
        )
        & $MySqlDumpPath @dumpArgs
        if ($LASTEXITCODE -ne 0) {
            throw "mysqldump failed with exit code $LASTEXITCODE"
        }
    } finally {
        $env:MYSQL_PWD = $oldMysqlPwd
    }

    if (Test-Path $configFile) {
        Copy-Item -LiteralPath $configFile -Destination (Join-Path $tempDir "application-prod.yml") -Force
    }

    $itemsToZip = @((Join-Path $tempDir "*"))
    if (Test-Path $uploadsRoot) {
        $itemsToZip += $uploadsRoot
    }

    Compress-Archive -Path $itemsToZip -DestinationPath $zipFile -Force
    $zip = Get-Item $zipFile
    if ($zip.Length -le 0) {
        throw "Backup zip is empty: $zipFile"
    }
    Write-BackupLog "Local backup created: $zipFile ($($zip.Length) bytes)"

    & $RclonePath copy $zipFile $RcloneRemotePath `
        --log-file $rcloneLogFile `
        --log-level INFO `
        --retries 3 `
        --low-level-retries 10
    if ($LASTEXITCODE -ne 0) {
        throw "rclone upload failed with exit code $LASTEXITCODE"
    }
    Write-BackupLog "Remote upload completed: $RcloneRemotePath"

    Get-ChildItem -Path $backupRoot -Filter "zhiqu-*.zip" -File |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$LocalRetentionDays) } |
        Remove-Item -Force
    Write-BackupLog "Local retention applied: $LocalRetentionDays days"

    if (-not $SkipRemotePrune) {
        & $RclonePath delete $RcloneRemotePath `
            --include "zhiqu-*.zip" `
            --min-age "$($RemoteRetentionDays)d" `
            --log-file $rcloneLogFile `
            --log-level INFO
        if ($LASTEXITCODE -ne 0) {
            throw "rclone remote prune failed with exit code $LASTEXITCODE"
        }
        Write-BackupLog "Remote retention applied: $RemoteRetentionDays days"
    }

    Write-BackupLog "Backup finished successfully."
} catch {
    Write-BackupLog "Backup failed: $($_.Exception.Message)"
    throw
} finally {
    if (Test-Path $tempDir) {
        Remove-Item -Recurse -Force -LiteralPath $tempDir
    }
}
