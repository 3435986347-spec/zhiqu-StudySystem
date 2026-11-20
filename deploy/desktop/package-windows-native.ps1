# 知趣象限 Windows 原生外壳：一个 exe，内嵌 WebView2 托管依赖、官方 Node 与 zhiqu-cli 源码。
# 用法：.\package-windows-native.ps1 1.6.0
# 离线 Node：-NodeZip C:\path\node-v22.23.2-win-x64.zip（仍校验固定 SHA-256）
param(
    [string]$Version = "1.0.0",
    [string]$NodeVersion = "22.23.2",
    [string]$NodeSha256 = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97",
    [string]$NodeZip = "",
    [switch]$SkipSmoke
)
$ErrorActionPreference = "Stop"
function Assert-Exit([string]$What) {
    if ($LASTEXITCODE -ne 0) { throw "$What 失败（退出码 $LASTEXITCODE）" }
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version 要是 x.y.z" }
if ($NodeVersion -notmatch '^\d+\.\d+\.\d+$' -or $NodeSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "Node 版本或 SHA-256 不对" }
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
$Project = Join-Path $PSScriptRoot "windows-shell\ZhiquShell.csproj"
$Out = Join-Path $Root "build\desktop-windows-native"
$Name = "知趣象限"
$Work = Join-Path $Out (".work-" + [guid]::NewGuid().ToString("N"))
$dotnet = if ($env:DOTNET_EXE) { $env:DOTNET_EXE } else { (Get-Command "dotnet.exe" -ErrorAction SilentlyContinue).Source }
if (-not $dotnet -or -not (Test-Path $dotnet)) { throw "找不到 dotnet.exe（设 DOTNET_EXE=绝对路径）—— 需要 .NET SDK 8" }
New-Item -ItemType Directory -Path $Work -Force | Out-Null
$probe = $null
$listener = $null
$oldServer = $env:ZHIQU_DESKTOP_SERVER
$oldProfile = $env:ZHIQU_DESKTOP_PROFILE
$oldInstance = $env:ZHIQU_DESKTOP_INSTANCE
try {
    Write-Host "dotnet: $(& $dotnet --version)  ($dotnet)"
    Write-Host "==> 1/5 准备官方 Windows x64 Node $NodeVersion"
    $download = if ($NodeZip) { (Resolve-Path $NodeZip).Path } else { Join-Path $Work "node.zip" }
    if (-not $NodeZip) {
        $url = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $download
    }
    $actual = (Get-FileHash -Algorithm SHA256 $download).Hash.ToLowerInvariant()
    if ($actual -ne $NodeSha256.ToLowerInvariant()) { throw "Node 发行包 SHA-256 不符：$actual" }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $extract = Join-Path $Work "node-extract"
    [System.IO.Compression.ZipFile]::ExtractToDirectory($download, $extract)
    $official = Join-Path $extract "node-v$NodeVersion-win-x64"
    $nodeExe = Join-Path $official "node.exe"
    if (-not (Test-Path $nodeExe) -or -not (Test-Path (Join-Path $official "LICENSE"))) { throw "Node 发行包不完整" }
    $arch = & $nodeExe -p "process.arch"
    Assert-Exit "Node 试跑"
    if ($arch -ne "x64") { throw "Node 不是 x64：$arch" }

    $payload = Join-Path $Work "payload"
    New-Item -ItemType Directory -Path (Join-Path $payload "zhiqu-cli") -Force | Out-Null
    Copy-Item $official (Join-Path $payload "node") -Recurse -Force
    Copy-Item (Join-Path $Root "zhiqu-cli\package.json") (Join-Path $payload "zhiqu-cli\package.json") -Force
    Copy-Item (Join-Path $Root "zhiqu-cli\src") (Join-Path $payload "zhiqu-cli\src") -Recurse -Force
    $hostPath = Join-Path $payload "zhiqu-cli\src\host\code-host.js"
    & $nodeExe --check $hostPath
    Assert-Exit "CLI 语法检查"
    $runtimeZip = Join-Path $Work "zhiqu-local.zip"
    [System.IO.Compression.ZipFile]::CreateFromDirectory($payload, $runtimeZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

    Write-Host "==> 2/5 编译单个 exe"
    $stage = Join-Path $Work "stage"
    & $dotnet publish $Project -c Release -o $stage "-p:Version=$Version" "-p:FileVersion=$Version.0" "-p:LocalRuntimeZip=$runtimeZip"
    Assert-Exit "dotnet publish"
    $built = Join-Path $stage "ZhiquShell.exe"
    if (-not (Test-Path $built)) { throw "找不到 ZhiquShell.exe" }
    $leftover = @(Get-ChildItem $stage -Filter "*.dll" -File)
    if ($leftover.Count -gt 0) { throw "这些 dll 没嵌进 exe：$($leftover.Name -join ', ')" }
    Get-ChildItem $stage -Filter "*.config" -File | Remove-Item -Force
    Get-ChildItem $stage -Filter "*.pdb" -File | Remove-Item -Force
    $artifact = Join-Path $Out "$Name-$Version-win-x64.exe"
    Move-Item $built $artifact -Force
    $assembly = [Reflection.Assembly]::ReflectionOnlyLoadFrom($artifact)
    if ($assembly.GetManifestResourceNames() -notcontains "Zhiqu.Desktop.zhiqu-local.zip") { throw "exe 里没有本机运行时资源" }

    Write-Host "==> 3/5 检查交付文件"
    $exe = Get-Item $artifact
    $hash = (Get-FileHash -Algorithm SHA256 $artifact).Hash.ToLowerInvariant()
    Write-Host "    $($exe.Name)  $([math]::Round($exe.Length / 1MB, 2)) MB"
    Write-Host "    sha256: $hash"

    if (-not $SkipSmoke) {
        Write-Host "==> 4/5 本机假站试跑（不连接真实网站）"
        $tcp = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
        $tcp.Start()
        $port = ([System.Net.IPEndPoint]$tcp.LocalEndpoint).Port
        $tcp.Stop()
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add("http://127.0.0.1:$port/")
        $listener.Start()
        $pending = $listener.GetContextAsync()
        $env:ZHIQU_DESKTOP_SERVER = "http://127.0.0.1:$port"
        $env:ZHIQU_DESKTOP_PROFILE = Join-Path $Work "smoke-profile"
        $env:ZHIQU_DESKTOP_INSTANCE = [guid]::NewGuid().ToString("N")
        $probe = Start-Process -FilePath $artifact -PassThru
        $seenPage = $false
        $until = [DateTime]::UtcNow.AddSeconds(10)
        while ([DateTime]::UtcNow -lt $until -and -not $probe.HasExited) {
            if ($pending.IsCompleted) {
                $context = $pending.Result
                $path = $context.Request.Url.AbsolutePath
                if ($path -eq "/dashboard.html") { $seenPage = $true }
                $body = if ($path -eq "/api/desktop/downloads") {
                    [Text.Encoding]::UTF8.GetBytes('{"code":200,"data":{}}')
                } else {
                    [Text.Encoding]::UTF8.GetBytes('<!doctype html><meta charset="utf-8"><title>知趣象限 smoke</title><p>ok</p>')
                }
                $context.Response.ContentType = if ($path -eq "/api/desktop/downloads") { "application/json; charset=utf-8" } else { "text/html; charset=utf-8" }
                $context.Response.Headers["Cache-Control"] = "no-store"
                $context.Response.ContentLength64 = $body.Length
                $context.Response.OutputStream.Write($body, 0, $body.Length)
                $context.Response.Close()
                $pending = $listener.GetContextAsync()
            }
            Start-Sleep -Milliseconds 100
        }
        if ($probe.HasExited) { throw "exe 起不来（退出码 $($probe.ExitCode)）" }
        if (-not $seenPage) { throw "窗口没有请求本机假站" }
        Write-Host "    本机假站窗口已启动"
    } else {
        Write-Host "==> 4/5 明确跳过窗口试跑"
    }
    Write-Host "==> 5/5 完成"
    Write-Host "产物：$artifact"
    Write-Host "用户不需要安装 Java、MySQL、Node 或 .NET 运行时。"
} finally {
    if ($probe -and -not $probe.HasExited) { Stop-Process -Id $probe.Id -Force -ErrorAction SilentlyContinue }
    if ($listener) { try { $listener.Close() } catch {} }
    $env:ZHIQU_DESKTOP_SERVER = $oldServer
    $env:ZHIQU_DESKTOP_PROFILE = $oldProfile
    $env:ZHIQU_DESKTOP_INSTANCE = $oldInstance
    if (Test-Path $Work) { Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue }
}
