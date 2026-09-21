#!/bin/bash
# 把后端打成一个**原生 macOS 应用**：Swift 外壳 + WKWebView + 内嵌 JRE + 胖 JAR。
#
# 和 package-macos.sh（jpackage 版）的区别，以及为什么有这一份：
#
#   jpackage 版产出的应用会**弹系统浏览器**。它能用，但用户要的是一个应用窗口，
#   不是一个会打开浏览器标签页的东西。而且 jpackage 的启动器是纯 JVM 进程，
#   不连 CoreGraphics 窗口服务器，macOS 会无限弹跳 Dock 图标（见 DockPresence）。
#
#   这一份用 Swift 写一个真正的 Cocoa 应用做外壳：它自己就是 GUI 进程（不弹跳），
#   页面显示在 WKWebView 里（无边框、铺满窗口），JVM 作为子进程在后台跑。
#   WebKit.framework 是系统自带的，所以外壳本身只有几十 KB。
#
# 体积对照：JavaFX 的 WebView 要自带一份 WebKit，单 mac-aarch64 就 37MB。
#
# 用法：  ./package-macos-native.sh [版本号]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BACKEND="$ROOT/zhiqu-backend"
SHELL_SRC="$ROOT/deploy/desktop/macos-shell/ZhiquShell.swift"
OUT="$ROOT/build/desktop-native"
NAME="知趣象限"
VERSION="${1:-1.0.0}"
BUNDLE_ID="com.zhiqu.quadrant"

export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17)}"
echo "JDK:   $JAVA_HOME"
echo "Swift: $(swiftc --version 2>/dev/null | head -1)"

echo "==> 1/6 打 JAR"
cd "$BACKEND"
mvn -o clean package -DskipTests -q
JAR="$(ls target/zhiqu-backend-*.jar | head -1)"
[ -f "$JAR" ] || { echo "打包失败：找不到 JAR"; exit 1; }
echo "    $(basename "$JAR")  $(du -h "$JAR" | cut -f1)"

APP="$OUT/$NAME.app"
echo "==> 2/6 搭 bundle 骨架"
rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
cp "$JAR" "$APP/Contents/Resources/app/"

echo "==> 3/6 裁一份 JRE（jlink）"
# 只带用得到的模块。全量 JDK 约 300MB，裁完约 50MB。
#
# 两个模块看起来可有可无，删了都会在运行时炸，而且报错都不指向真正的原因：
#
#   jdk.crypto.ec  —— HTTPS 必需（连远程数据库、连 AI 服务商）。缺了报
#                     「找不到合适的 TLS 套件」，读起来像对端配置问题。
#
#   jdk.charsets   —— 2026-09-21 实测：缺了它，MySQL 驱动把连接字符集协商成
#                     **eucjpms**（一个日文字符集），于是所有中文明文写入报
#                     `Incorrect string value`。表和列都是 utf8mb4、JDBC URL 里
#                     也写着 characterEncoding=utf-8，所以查起来完全指不到这里。
#                     发现过程：知识 Wiki 建页 500，同一份代码在开发机上正常 ——
#                     差别只有「跑的是裁过的 runtime」。用同一个探针分别在完整 JDK
#                     和裁过的 runtime 上跑，一个 utf8mb4、一个 eucjpms。
#                     任务标题是加密存储的（明文进 encrypted_title），所以它不受
#                     影响 —— 这让故障看起来只在 Wiki 里，更难联想到字符集。
"$JAVA_HOME/bin/jlink" \
  --add-modules java.base,java.logging,java.xml,java.sql,java.naming,java.management,java.instrument,java.desktop,java.security.jgss,java.security.sasl,jdk.crypto.ec,jdk.charsets,jdk.unsupported,jdk.jfr,java.net.http,java.compiler,java.rmi,java.scripting,java.transaction.xa,jdk.management \
  --strip-debug --no-header-files --no-man-pages --compress=2 \
  --output "$APP/Contents/Resources/runtime/Contents/Home"
echo "    runtime  $(du -sh "$APP/Contents/Resources/runtime" | cut -f1)"

echo "==> 4/6 生成应用图标"
# 图标从「知」字现画，不是一张存在仓库里的设计稿 —— 界面里那个标识本来就是 CSS
# 画的（.zq-mark），改品牌色时这样才不会出现「界面新色、图标旧色」。
ICON_TOOL="$OUT/MakeIcon"
swiftc -O -target arm64-apple-macos13.0 -framework AppKit \
  -o "$ICON_TOOL" "$ROOT/deploy/desktop/icon/MakeIcon.swift"
"$ICON_TOOL" "$OUT/icons" > /dev/null
iconutil -c icns "$OUT/icons/zhiqu.iconset" -o "$APP/Contents/Resources/$NAME.icns"
rm -f "$ICON_TOOL"
echo "    $NAME.icns  $(du -h "$APP/Contents/Resources/$NAME.icns" | cut -f1)"

echo "==> 5/6 编译 Swift 外壳"
swiftc -O -target arm64-apple-macos13.0 \
  -framework AppKit -framework WebKit \
  -o "$APP/Contents/MacOS/$NAME" "$SHELL_SRC"
echo "    外壳  $(du -h "$APP/Contents/MacOS/$NAME" | cut -f1)"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleExecutable</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>$NAME</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- 本机 HTTP：后端跑在 127.0.0.1，不是 HTTPS。只放行回环，不是全局关掉 ATS。 -->
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

echo "==> 6/6 签名（ad-hoc）"
# ad-hoc 签名够本机和「右键→打开」用。要给别人分发得用 Developer ID 并公证，
# 否则对方会看到「已损坏，无法打开」—— 那句话和损坏没关系，是 Gatekeeper 的措辞。
codesign --force --deep --sign - "$APP" 2>&1 | grep -v "replacing existing signature" || true

echo
echo "完成：$APP"
echo "体积：$(du -sh "$APP" | cut -f1)"
echo
echo "试跑：  open '$APP'"
