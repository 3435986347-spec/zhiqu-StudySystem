param(
    [string]$Root = "C:\zhiqu",
    [string]$ScriptPath = "C:\zhiqu\scripts\backup-zhiqu.ps1",
    [string]$TaskName = "ZhiquBackup",
    [string]$At = "02:30"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ScriptPath)) {
    throw "Backup script not found: $ScriptPath"
}

if ([string]::IsNullOrWhiteSpace($env:ZHIQU_DB_PASSWORD)) {
    Write-Warning "ZHIQU_DB_PASSWORD is not set for the current session."
    Write-Warning "Set a machine environment variable before relying on this task:"
    Write-Warning '[Environment]::SetEnvironmentVariable("ZHIQU_DB_PASSWORD", "your_mysql_password", "Machine")'
}

$actionArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" -Root `"$Root`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgs
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Daily backup for Zhiqu database, uploads, and production config." `
    -RunLevel Highest `
    -Force | Out-Null

Write-Host "Scheduled task installed: $TaskName at $At"
Write-Host "Test once with:"
Write-Host "  powershell.exe -ExecutionPolicy Bypass -File `"$ScriptPath`" -Root `"$Root`""
