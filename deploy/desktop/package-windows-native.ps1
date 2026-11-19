# 打一个**原生 Windows 桌面应用**：C# 外壳 + WebView2，窗口里打开这个应用的网站（默认 https://zhiqustudy.com）。
#
# 和 package-windows.ps1 的区别：那一份是老的「jpackage + 包里的 Java 后端 + 用户自己装的 MySQL」，
# 界面其实开在默认浏览器里。这一份照 macOS 原生外壳（../macos-shell）的形状做：包里不带 Java、JRE、JAR，
# 也不需要 MySQL —— 数据只在服务器上（docs/desktop-remote-plan.md，2026-11-08 用户定的 A 方案，
# Windows 原生外壳是那一份的第 5 步）。
#
# 产物是**一个 exe**：build\desktop-windows-native\知趣象限-<版本>-win-x64.exe（双击即运行）。
# 用户机器上需要的只有两样，Windows 10 / 11 都自带：.NET Framework 4.8、WebView2 运行时（随 Edge 装）。
# 单文件靠 Costura.Fody（windows-shell/FodyWeavers.xml）：托管程序集和 WebView2Loader.dll 都嵌在 exe 里。
#
# 只能在 Windows 上跑（WinForms 目标、exe 的图标资源都是 Windows 的）。
#
# 用法（PowerShell）：
#   cd deploy\desktop
#   .\package-windows-native.ps1            # 版本默认 1.0.0
#   .\package-windows-native.ps1 1.5.5
param([string]$Version = "1.0.0")
$ErrorActionPreference = "Stop"

# 原生命令（dotnet）失败时 Windows PowerShell 5.1 不会因为 $ErrorActionPreference 停下 ——
# 它只管 cmdlet。不查 $LASTEXITCODE 的话，编译失败了照样往下走，最后打印「完成」。
function Assert-Exit([string]$What) {
    if ($LASTEXITCODE -ne 0) { throw "$What 失败（退出码 $LASTEXITCODE）" }
}

$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
$Project = Join-Path $PSScriptRoot "windows-shell\ZhiquShell.csproj"
$Out = Join-Path $Root "build\desktop-windows-native"
$Name = "知趣象限"
$Stage = Join-Path $Out "stage"

# dotnet：DOTNET_EXE 优先，其次 PATH。.NET 8 SDK 就能编 net48，不需要装 Visual Studio。
# 没有装的话：https://dot.net/v1/dotnet-install.ps1 -Channel 8.0 -InstallDir <目录>，再把 DOTNET_EXE 指过去。
$dotnet = if ($env:DOTNET_EXE) { $env:DOTNET_EXE } else { (Get-Command "dotnet.exe" -ErrorAction SilentlyContinue).Source }
if (-not $dotnet -or -not (Test-Path $dotnet)) {
    throw "找不到 dotnet.exe（设 DOTNET_EXE=绝对路径）—— 需要 .NET SDK 8"
}
Write-Host "dotnet: $(& $dotnet --version)  ($dotnet)"

Write-Host "==> 1/3 编译外壳"
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Path $Stage | Out-Null
# 第一次会联网取 NuGet（Microsoft.Web.WebView2、Costura.Fody），之后走本机缓存
& $dotnet publish $Project -c Release -o $Stage "-p:Version=$Version" "-p:FileVersion=$Version.0"
Assert-Exit "dotnet publish"

Write-Host "==> 2/3 检查是不是真的只有一个 exe"
$built = Join-Path $Stage "ZhiquShell.exe"
if (-not (Test-Path $built)) { throw "打包失败：找不到 ZhiquShell.exe" }
# Costura 没生效的话这里会剩一堆 dll —— 那就不叫单文件了，别悄悄把半个包当成品发出去
$leftover = @(Get-ChildItem $Stage -Filter "*.dll" -File)
if ($leftover.Count -gt 0) {
    throw "打包失败：这些 dll 没被嵌进 exe（Costura 没跑？看 windows-shell\FodyWeavers.xml）：$($leftover.Name -join ', ')"
}
# 空 .config（MSBuild 自动生成）和调试符号都不要：单文件就是要一个文件
Get-ChildItem $Stage -Filter "*.config" -File | Remove-Item -Force
Get-ChildItem $Stage -Filter "*.pdb" -File | Remove-Item -Force

$artifact = Join-Path $Out "$Name-$Version-win-x64.exe"
Move-Item $built $artifact -Force
Remove-Item $Stage -Recurse -Force
$exe = Get-Item $artifact
Write-Host "    $($exe.Name)  $([math]::Round($exe.Length / 1MB, 2)) MB"

Write-Host "==> 3/3 试跑 3 秒（能起窗口、且不立刻退出才算数）"
$probe = Start-Process -FilePath $artifact -PassThru
Start-Sleep -Seconds 3
if ($probe.HasExited) { throw "打出来的 exe 起不来（退出码 $($probe.ExitCode)）" }
Stop-Process -Id $probe.Id -Force
Write-Host "    起来了，进程已经停掉"

Write-Host ""
Write-Host "完成：$artifact"
Write-Host "  拷给用户双击即可；用户机器上不需要装 Java、MySQL、.NET 运行时。"
Write-Host "  放到服务器 data/downloads（网页版「下载桌面版」从这里拿），文件名里的版本号会显示在页面上。"
