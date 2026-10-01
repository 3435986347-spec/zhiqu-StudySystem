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
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app" "$APP/Contents/Resources/bin"
# 解压成「瘦 JAR + lib/」，不放胖 JAR（第十轮）：应用类的 CDS 归档只收内置类加载器加载的类，
# 胖 JAR 里的类走 Spring Boot 自己的加载器，一个都归档不了。解压后的瘦 JAR 用 Class-Path 指向 lib/，
# java -jar 照样能跑。归档本身在用户第一次运行时生成（见 macos-shell/CdsCache.swift）。
"$JAVA_HOME/bin/java" -Djarmode=tools -jar "$JAR" extract --destination "$APP/Contents/Resources/app" > /dev/null
[ -f "$APP/Contents/Resources/app/$(basename "$JAR")" ] || { echo "解压失败：找不到瘦 JAR"; exit 1; }
# 命令行入口 zhiqu：用应用自带的 JRE 跑同一个 JAR 里的 com.zhiqu.cli.ZhiquCli。
# 放在 Resources/bin 而不是 MacOS/：MacOS/ 里的可执行文件会被当成应用的主程序候选。
cp "$ROOT/deploy/desktop/bin/zhiqu" "$APP/Contents/Resources/bin/zhiqu"
chmod +x "$APP/Contents/Resources/bin/zhiqu"

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
  --generate-cds-archive \
  --output "$APP/Contents/Resources/runtime/Contents/Home"
# --generate-cds-archive：给 JDK 自己的类生成基础归档。单看它几乎不提速，但应用类的归档（-XX:ArchiveClassesAtExit）
# 必须叠在它上面 —— 没有它，第一次运行生成归档那一步直接报错跳过。
# classes_nocoops.jsa 只在关掉压缩指针（堆 > 32GB）时用，应用固定 -Xmx1g，删掉省 11MB。
rm -f "$APP/Contents/Resources/runtime/Contents/Home/lib/server/classes_nocoops.jsa"
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
# 两个源文件一起编译时，只有叫 main.swift 的那个能有顶层代码（外壳最后那几行 NSApplication.run 就是）——
# 原样一起编译报「expressions are not allowed at the top level」。所以拷一份改名成 main.swift 再编。
SWIFT_BUILD="$OUT/swift-src"
mkdir -p "$SWIFT_BUILD"
cp "$SHELL_SRC" "$SWIFT_BUILD/main.swift"
swiftc -O -target arm64-apple-macos13.0 \
  -framework AppKit -framework WebKit \
  -o "$APP/Contents/MacOS/$NAME" "$SWIFT_BUILD/main.swift" \
  "$ROOT/deploy/desktop/macos-shell/CdsCache.swift" "$ROOT/deploy/desktop/macos-shell/PageView.swift"
rm -rf "$SWIFT_BUILD"
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

echo "==> 6/7 签名（ad-hoc）"
# ad-hoc 签名够本机和「右键→打开」用。要给别人分发得用 Developer ID 并公证，
# 否则对方会看到「已损坏，无法打开」—— 那句话和损坏没关系，是 Gatekeeper 的措辞。
codesign --force --deep --sign - "$APP" 2>&1 | grep -v "replacing existing signature" || true

echo "==> 7/7 打包成 .dmg（拖拽安装）"
# 标准的拖拽安装 dmg：一个 .app + 一个指向 /Applications 的软链，用户拖过去即安装。
DMG="$OUT/$NAME-$VERSION.dmg"
STAGE="$OUT/dmg-stage"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "$NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
echo "    $(basename "$DMG")  $(du -h "$DMG" | cut -f1)"

echo
echo "完成："
echo "  应用：$APP  （$(du -sh "$APP" | cut -f1)）"
echo "  安装包：$DMG"
echo
echo "试跑：  open '$APP'"
