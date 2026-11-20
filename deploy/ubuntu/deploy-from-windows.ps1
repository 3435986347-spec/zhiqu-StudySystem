# Ubuntu 生产的 Windows 部署入口。使用 Windows OpenSSH；没有私钥时由系统 ssh 提示输入密码，不保存密码。
# powershell -ExecutionPolicy Bypass -File deploy\ubuntu\deploy-from-windows.ps1 -Version 1.6.0
# 可选：-KeyPath C:\Users\you\.ssh\id_ed25519 -SkipBuild -SkipNpmCheck
[CmdletBinding()]
param(
    [string]$Version = "1.6.0",
    [string]$Server = "ubuntu@134.175.110.207",
    [string]$Base = "/home/ubuntu/zhiqu-StudySystem",
    [string]$KeyPath = "",
    [switch]$SkipBuild,
    [switch]$SkipNpmCheck
)
$ErrorActionPreference = "Stop"
function Assert-Exit([string]$What) {
    if ($LASTEXITCODE -ne 0) { throw "$What（退出码 $LASTEXITCODE）" }
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version 要是 x.y.z" }
if ($Base -notmatch '^/[A-Za-z0-9._/-]+$' -or $Base.Contains("..")) { throw "Base 只能是服务器上的绝对路径，不能带空格或 .." }
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Mvn = if ($env:MVN_EXE) { $env:MVN_EXE } else { (Get-Command "mvn.cmd" -ErrorAction SilentlyContinue).Source }
$Node = (Get-Command "node.exe" -ErrorAction SilentlyContinue).Source
$Npm = (Get-Command "npm.cmd" -ErrorAction SilentlyContinue).Source
$Ssh = (Get-Command "ssh.exe" -ErrorAction SilentlyContinue).Source
$Scp = (Get-Command "scp.exe" -ErrorAction SilentlyContinue).Source
if (-not $Node -or -not $Npm -or -not $Ssh -or -not $Scp) { throw "需要 Windows OpenSSH（ssh.exe / scp.exe）、Node 和 npm" }
if (-not $SkipBuild -and (-not $Mvn -or -not (Test-Path $Mvn))) { throw "找不到 Maven；设 MVN_EXE 为 mvn.cmd 的绝对路径" }
$Jar = Join-Path $Root "zhiqu-backend\target\zhiqu-backend-0.0.1-SNAPSHOT.jar"
$Installer = Join-Path $Root "build\desktop-windows-native\知趣象限-$Version-win-x64.exe"
$CliVersion = & $Node -p "require(process.argv[1]).version" (Join-Path $Root "zhiqu-cli\package.json")
Assert-Exit "读取 CLI 版本"
if (-not $SkipNpmCheck) {
    $published = & $Npm view "zhiqu@$CliVersion" version 2>$null
    Assert-Exit "查询 npm"
    if ($published -ne $CliVersion) { throw "npm 上还没有 zhiqu@$CliVersion；先发布 CLI，或确认后使用 -SkipNpmCheck" }
}
$identity = @()
$deployError = $null
$stage = Join-Path $Root ("build\windows-deploy-" + [guid]::NewGuid().ToString("N"))
$remoteOptions = @("-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new")
try {
if ($KeyPath) {
    if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw "找不到私钥：$KeyPath" }
    $identity = @("-i", (Resolve-Path -LiteralPath $KeyPath).Path, "-o", "BatchMode=yes")
} else {
    $defaultKey = "$HOME\.ssh\zhiqu_server"
    $registered = $false
    if ((Test-Path -LiteralPath $defaultKey -PathType Leaf) -and (Test-Path -LiteralPath "$defaultKey.pub" -PathType Leaf)) {
        & $Ssh -i $defaultKey -o "BatchMode=yes" @remoteOptions $Server "true"
        $registered = $LASTEXITCODE -eq 0
    }
    if (-not $registered) {
        if (-not (Test-Path -LiteralPath "$defaultKey.pub" -PathType Leaf)) {
        $keygen = (Get-Command "ssh-keygen.exe" -ErrorAction SilentlyContinue).Source
        if (-not $keygen) { throw "找不到 ssh-keygen.exe" }
        New-Item -ItemType Directory -Path "$HOME\.ssh" -Force | Out-Null
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $keygen
        $psi.Arguments = '-q -t ed25519 -N "" -f "' + $defaultKey + '" -C "zhiqu-windows-deploy"'
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $keyProcess = [System.Diagnostics.Process]::Start($psi)
        $keyOut = $keyProcess.StandardOutput.ReadToEnd()
        $keyError = $keyProcess.StandardError.ReadToEnd()
        $keyProcess.WaitForExit()
        if ($keyProcess.ExitCode -ne 0) { throw "生成用户级 SSH key（退出码 $($keyProcess.ExitCode)）：$keyError$keyOut" }
        $keyProcess.Dispose()
    }
    Write-Host "首次部署：请在本窗口确认服务器 host key，并输入一次 SSH 密码以登记公钥。密码不会传给脚本变量。"
    $publicKey = [IO.File]::ReadAllText("$defaultKey.pub").Trim()
    if ($publicKey -notmatch '^ssh-ed25519\s+[A-Za-z0-9+/=]+\s+\S+$') { throw "公钥格式不对" }
    $installKey = "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF '$publicKey' ~/.ssh/authorized_keys || printf '%s\n' '$publicKey' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys"
    & $Ssh @remoteOptions -o "PubkeyAuthentication=no" -o "PreferredAuthentications=password,keyboard-interactive" $Server $installKey
    Assert-Exit "登记 SSH 公钥"
    }
    $identity = @("-i", $defaultKey, "-o", "BatchMode=yes")
}
    if (-not $SkipBuild) {
        Write-Host "==> 1/6 编译后端"
        & $Mvn -o -q -f (Join-Path $Root "zhiqu-backend\pom.xml") clean package "-DskipTests"
        Assert-Exit "Maven 打包"
    }
    foreach ($file in @($Jar, $Installer)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "缺少部署产物：$file" }
    }
    $localHash = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
    $localSize = (Get-Item -LiteralPath $Installer).Length

    Write-Host "==> 2/6 准备 LF 脚本与 CLI 源码"
    $deployStage = Join-Path $stage "deploy-ubuntu"
    $cliStage = Join-Path $stage "zhiqu-cli"
    Copy-Item (Join-Path $Root "deploy\ubuntu") $deployStage -Recurse -Force
    New-Item -ItemType Directory -Path $cliStage -Force | Out-Null
    Copy-Item (Join-Path $Root "zhiqu-cli\src") (Join-Path $cliStage "src") -Recurse -Force
    Copy-Item (Join-Path $Root "zhiqu-cli\test") (Join-Path $cliStage "test") -Recurse -Force
    Copy-Item (Join-Path $Root "zhiqu-cli\package.json") (Join-Path $cliStage "package.json") -Force
    foreach ($script in Get-ChildItem -LiteralPath $deployStage -Filter "*.sh" -Recurse -File) {
        $text = [IO.File]::ReadAllText($script.FullName)
        $text = $text.Replace("`r`n", "`n").Replace("`r", "`n").TrimStart([char]0xFEFF)
        [IO.File]::WriteAllText($script.FullName, $text, [Text.UTF8Encoding]::new($false))
    }

    Write-Host "==> 3/6 上传部署脚本、CLI 和 Windows exe"
    & $Ssh @identity @remoteOptions $Server "mkdir -p '$Base/incoming' && rm -rf '$Base/incoming/zhiqu-cli' '$Base/incoming/deploy-ubuntu'"
    Assert-Exit "连接服务器"
    & $Scp @identity @remoteOptions -r $deployStage "${Server}:$Base/incoming/"
    Assert-Exit "上传部署脚本"
    & $Scp @identity @remoteOptions -r $cliStage "${Server}:$Base/incoming/"
    Assert-Exit "上传 CLI"
    $exeName = Split-Path -Leaf $Installer
    & $Scp @identity @remoteOptions $Installer "${Server}:$Base/incoming/$exeName"
    Assert-Exit "上传 Windows exe"

    Write-Host "==> 4/6 上传后端"
    & $Scp @identity @remoteOptions $Jar "${Server}:$Base/incoming/zhiqu-backend.jar"
    Assert-Exit "上传后端 JAR"

    Write-Host "==> 5/6 原子替换并重启（网站会短暂断开）"
    $remote = @"
set -euo pipefail
install -m 644 '$Base/incoming/zhiqu-backend.jar' '$Base/app/.zhiqu-backend.jar.new'
mv '$Base/app/.zhiqu-backend.jar.new' '$Base/app/zhiqu-backend.jar'
rm -rf '$Base/deploy/zhiqu-cli'
cp -R '$Base/incoming/zhiqu-cli' '$Base/deploy/zhiqu-cli'
chmod -R a+rX '$Base/deploy/zhiqu-cli'
install -m 755 '$Base/incoming/deploy-ubuntu/backup-zhiqu.sh' '$Base/incoming/deploy-ubuntu/verify-hosted-shell.sh' '$Base/deploy/'
install -m 644 '$Base/incoming/$exeName' '$Base/data/downloads/.$exeName.part'
mv '$Base/data/downloads/.$exeName.part' '$Base/data/downloads/$exeName'
chown zhiqu:zhiqu '$Base/data/downloads/$exeName'
chmod 644 '$Base/data/downloads/$exeName'
systemctl restart zhiqu-backend
"@
    $remote = $remote.Replace("`r`n", "`n")
    $sshArguments = @($identity) + @($remoteOptions) + @($Server, "sudo -n bash -s")
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $Ssh
    $psi.Arguments = (($sshArguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $remoteProcess = [System.Diagnostics.Process]::Start($psi)
    $remoteStdout = $remoteProcess.StandardOutput.ReadToEndAsync()
    $remoteStderr = $remoteProcess.StandardError.ReadToEndAsync()
    $remoteBytes = [Text.UTF8Encoding]::new($false).GetBytes($remote.Replace("`r`n", "`n").Replace("`r", "`n").TrimEnd() + "`n")
    $remoteProcess.StandardInput.BaseStream.Write($remoteBytes, 0, $remoteBytes.Length)
    $remoteProcess.StandardInput.Close()
    $remoteProcess.WaitForExit()
    $remoteCode = $remoteProcess.ExitCode
    $remoteOutput = ($remoteStdout.Result + $remoteStderr.Result)
    $remoteProcess.Dispose()
    if ($remoteCode -ne 0) { throw "服务器替换与重启（退出码 $remoteCode）：$remoteOutput" }
    $remoteOutput | Write-Host

    Write-Host "==> 6/6 公网验证"
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    $ready = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "https://zhiqustudy.com/index.html" -TimeoutSec 10
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Seconds 2 }
    }
    if (-not $ready) { throw "重启后 90 秒内网站没有恢复" }
    $listing = Invoke-RestMethod -Uri "https://zhiqustudy.com/api/desktop/downloads" -TimeoutSec 15
    $windows = $listing.data.windows
    if ($windows.version -ne $Version -or [long]$windows.size -ne $localSize -or $windows.sha256 -ne $localHash) {
        throw "下载清单与本地 exe 不一致"
    }
    $downloaded = Join-Path $stage "downloaded.exe"
    Invoke-WebRequest -UseBasicParsing -Uri "https://zhiqustudy.com$($windows.url)" -OutFile $downloaded -TimeoutSec 600
    $downloadHash = (Get-FileHash -LiteralPath $downloaded -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($downloadHash -ne $localHash) { throw "公网下载的 exe 与本地原件不一致" }
    Write-Host "完成：zhiqustudy.com 已恢复；Windows $Version，SHA-256 $localHash"
} catch {
    $deployError = $_.Exception.Message
    throw
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    $statusFile = $env:ZHIQU_DEPLOY_STATUS_FILE
    if (-not [string]::IsNullOrWhiteSpace($statusFile)) {
        $payload = if ($deployError) { @{ state = "failed"; error = $deployError } } else { @{ state = "succeeded"; version = $Version; sha256 = $localHash } }
        [IO.File]::WriteAllText($statusFile, ($payload | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    }
}
