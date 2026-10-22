# Put a desktop installer where the web "download desktop app" dialog finds it (round 82).
#
#   powershell -ExecutionPolicy Bypass -File C:\zhiqu\install-desktop-download.ps1 -Installer "C:\Users\Administrator\Desktop\<installer>.dmg"
#
# - Copies the installer into C:\zhiqu\downloads under a name starting with a dot, then renames it:
#   the backend ignores dot-files, so nobody is handed a half-copied file while the copy runs.
# - Adds app.desktop-downloads-dir to application-prod.yml if it is not there yet (a backup is kept next to it).
# - Does not restart the service. The dialog only exists in builds from round 82 on: deploy that JAR (which restarts
#   the service anyway); after that, new installers dropped here show up without a restart.
#
# Keep this file ASCII: Windows PowerShell 5.1 reads scripts without a BOM as the ANSI code page.
param(
    [Parameter(Mandatory = $true)][string]$Installer
)
$ErrorActionPreference = "Stop"

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$downloads = Join-Path $base "downloads"
$config = Join-Path $base "application-prod.yml"
$utf8 = New-Object System.Text.UTF8Encoding($false)

if (!(Test-Path -LiteralPath $Installer -PathType Leaf)) {
    throw "Installer not found: $Installer"
}
$name = Split-Path -Leaf $Installer
if ($name -notmatch '\.(dmg|exe|msi|zip)$') {
    throw "Not an installer the backend offers (.dmg / .exe / .msi / .zip): $name"
}
if ($name.StartsWith(".")) {
    throw "Installer name starts with a dot; the backend would ignore it: $name"
}
if (!(Test-Path -LiteralPath $config)) {
    throw "Missing application-prod.yml next to this script ($base)."
}

New-Item -ItemType Directory -Force -Path $downloads | Out-Null
$partial = Join-Path $downloads ("." + $name + ".part")
$final = Join-Path $downloads $name
Copy-Item -LiteralPath $Installer -Destination $partial -Force
Move-Item -LiteralPath $partial -Destination $final -Force
Write-Host "Installer ready: $final ($((Get-Item -LiteralPath $final).Length) bytes)"
Write-Host "SHA-256: $((Get-FileHash -LiteralPath $final -Algorithm SHA256).Hash.ToLower())"

# application-prod.yml: read and write as UTF-8 without BOM (Get-Content / Set-Content in 5.1 would use ANSI and mangle non-ASCII comments).
$text = [System.IO.File]::ReadAllText($config, $utf8)
if ($text -match '(?m)^\s+desktop-downloads-dir\s*:') {
    Write-Host "application-prod.yml already sets desktop-downloads-dir; left as is."
} else {
    $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lines = [System.Collections.Generic.List[string]]($text -split "\r?\n")
    $at = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^app:\s*(#.*)?$') { $at = $i; break }
    }
    if ($at -lt 0) {
        throw "No top-level 'app:' section in application-prod.yml; add 'app:' / '  desktop-downloads-dir: C:/zhiqu/downloads' by hand."
    }
    $indent = "  "
    if ($at + 1 -lt $lines.Count -and $lines[$at + 1] -match '^(\s+)\S') { $indent = $Matches[1] }
    $downloadsYaml = $downloads.Replace("\", "/")
    $lines.Insert($at + 1, $indent + "desktop-downloads-dir: " + $downloadsYaml)
    $backup = $config + ".bak-" + (Get-Date -Format "yyyyMMdd-HHmmss")
    Copy-Item -LiteralPath $config -Destination $backup
    [System.IO.File]::WriteAllText($config, ($lines -join $newline), $utf8)
    Write-Host "Added app.desktop-downloads-dir: $downloadsYaml to application-prod.yml (backup: $backup)."
    Write-Host "It takes effect when the backend restarts (deploying the new JAR restarts it)."
}
