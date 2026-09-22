# 把后端打成 Windows 桌面应用（.exe）。
#
# 只能在 Windows 上跑 —— jpackage 不做跨平台：Windows 安装包必须在 Windows 上、
# 用带 jpackage 的 JDK 17 构建（macOS 上打不出 .exe）。
#
# 产出两种，按有没有 WiX 决定：
#   - 有 WiX Toolset  →  知趣象限-1.0.0.exe  安装程序（双击安装到「程序」里）
#   - 没有 WiX        →  app-image 目录，里面是 知趣象限.exe，双击即运行（免安装）
#
# 和 macOS 原生外壳（Swift + WKWebView，无边框窗口）不同：这一版双击后在**默认浏览器**里
# 打开界面。Windows 上要做无边框原生窗口需要 WebView2 外壳（C# / .NET），单独做。
# 但固定端口（记住登录）、headless、图标这些修复都在。
#
# 用法（PowerShell）：
#   cd deploy\desktop
#   .\package-windows.ps1            # 版本默认 1.0.0
#   .\package-windows.ps1 1.2.0
param([string]$Version = "1.0.0")
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
$Backend = Join-Path $Root "zhiqu-backend"
$Out = Join-Path $Root "build\desktop-windows"
$Name = "知趣象限"
$Icon = Join-Path $PSScriptRoot "icon\zhiqu.ico"

# JDK 17：优先 JAVA_HOME，否则报错让用户装 Temurin 17。
if (-not $env:JAVA_HOME) { throw "请先设置 JAVA_HOME 指向 JDK 17（Temurin 17：https://adoptium.net）" }
$jpackage = Join-Path $env:JAVA_HOME "bin\jpackage.exe"
if (-not (Test-Path $jpackage)) { throw "找不到 jpackage：$jpackage。需要 JDK 17（不是 JRE）。" }
Write-Host "JDK: $env:JAVA_HOME"

Write-Host "==> 1/3 打 JAR"
Push-Location $Backend
& mvn -o clean package "-DskipTests" -q
Pop-Location
$jar = Get-ChildItem (Join-Path $Backend "target") -Filter "zhiqu-backend-*.jar" | Select-Object -First 1
if (-not $jar) { throw "打包失败：找不到 JAR" }
Write-Host "    $($jar.Name)  $([math]::Round($jar.Length/1MB,1)) MB"

Write-Host "==> 2/3 准备输入目录"
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Path "$Out\input" | Out-Null
Copy-Item $jar.FullName "$Out\input\"

# 有没有 WiX（--type exe 需要）。没有就退回 app-image。
$hasWix = ($null -ne (Get-Command "candle.exe" -ErrorAction SilentlyContinue)) -or
          ($null -ne (Get-Command "light.exe" -ErrorAction SilentlyContinue))
$type = if ($hasWix) { "exe" } else { "app-image" }
Write-Host "==> 3/3 jpackage（--type $type$(if(-not $hasWix){'，没检测到 WiX，出免安装目录'}))"

$common = @(
    "--type", $type,
    "--name", $Name,
    "--app-version", $Version,
    "--input", "$Out\input",
    "--main-jar", $jar.Name,
    "--main-class", "org.springframework.boot.loader.launch.JarLauncher",
    "--dest", $Out,
    "--vendor", "zhiqu",
    # 固定端口（记住登录的稳定 origin）、headless=false（否则任务栏图标不出、见 DockPresence 同理）
    "--java-options", "-Dspring.profiles.active=desktop",
    "--java-options", "-Dfile.encoding=UTF-8",
    "--java-options", "-Djava.awt.headless=false",
    "--java-options", "-Xmx1g"
)
if (Test-Path $Icon) { $common += @("--icon", $Icon) }
if ($type -eq "exe") {
    $common += @("--win-shortcut", "--win-menu", "--win-dir-chooser")
}

& $jpackage @common

Write-Host ""
if ($type -eq "exe") {
    $exe = Get-ChildItem $Out -Filter "*.exe" | Select-Object -First 1
    Write-Host "完成：$($exe.FullName)"
} else {
    Write-Host "完成（免安装）：$Out\$Name\$Name.exe"
    Write-Host "  整个 $Out\$Name 目录拷给用户，双击里面的 $Name.exe 即可运行。"
    Write-Host "  要出单文件安装程序，装 WiX Toolset v3（https://wixtoolset.org）后重跑本脚本。"
}
