#!/bin/bash
# 打一个**原生 macOS 应用**：Swift 外壳 + WKWebView，窗口里打开这个应用的网站（默认 https://zhiqustudy.com）。
#
# 第一百二十五轮之前包里还有一个完整的后端（瘦 JAR + jlink 裁的 JRE），连用户自己装的 MySQL —— 没装 MySQL 的人打不开。
# 用户定了桌面版给所有下载的人用、数据走网站（docs/desktop-remote-plan.md），所以外壳只打开网站，
# 包里不再带 Java、JRE、JAR，也不再需要 MySQL。WebKit.framework 是系统自带的，外壳本身只有一两百 KB。
#
# 包里的 node 给本机代码助手（方案第 2 步，第一百二十九轮）：外壳按需起它跑命令行那一份宿主（Resources/zhiqu-cli/src/host/code-host.js），
# 在你的磁盘上读写、在系统沙箱里跑命令，模型走网站的网关。命令行没有 npm 依赖，package.json + src 就是全部（和后端 JAR 里带的同一份）。
#
# 用法：  ./package-macos-native.sh [版本号]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SHELL_DIR="$ROOT/deploy/desktop/macos-shell"
OUT="$ROOT/build/desktop-native"
NAME="知趣象限"
VERSION="${1:-1.0.0}"
BUNDLE_ID="com.zhiqu.quadrant"

# 不直接搬 PATH 上的 Homebrew node：它可能依赖 libnode / OpenSSL / ICU，离开本机就缺库。
# 提前准备，失败时保留原有安装包。
NODE_BIN="$(bash "$ROOT/deploy/desktop/prepare-macos-node.sh" "$ROOT/build/node-runtime")"
NODE_LICENSE="$(dirname "$NODE_BIN")/../LICENSE"
[ -f "$NODE_LICENSE" ] || { echo "缺少 Node LICENSE：请让 NODE_BIN 指向完整官方发行包的 bin/node"; exit 1; }

echo "Swift: $(swiftc --version 2>/dev/null | head -1)"

APP="$OUT/$NAME.app"
echo "==> 1/5 搭 bundle 骨架、放 node"
rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# 本机代码助手要的是命令行源码，不是 npm 上的 zhiqu 命令：没有依赖，package.json（type: module）+ src 就是全部。
mkdir -p "$APP/Contents/Resources/node/bin"
cp "$NODE_BIN" "$APP/Contents/Resources/node/bin/node"
cp "$NODE_LICENSE" "$APP/Contents/Resources/node/LICENSE"
"$APP/Contents/Resources/node/bin/node" --version > /dev/null || { echo "打进去的 node 跑不起来：$NODE_BIN"; exit 1; }
echo "    node     $(du -sh "$APP/Contents/Resources/node" | cut -f1)（$("$APP/Contents/Resources/node/bin/node" --version)）"
mkdir -p "$APP/Contents/Resources/zhiqu-cli"
cp "$ROOT/zhiqu-cli/package.json" "$APP/Contents/Resources/zhiqu-cli/package.json"
cp -R "$ROOT/zhiqu-cli/src" "$APP/Contents/Resources/zhiqu-cli/src"
"$APP/Contents/Resources/node/bin/node" --check "$APP/Contents/Resources/zhiqu-cli/src/host/code-host.js" || { echo "包里的宿主语法不对"; exit 1; }
echo "    宿主     $(du -sh "$APP/Contents/Resources/zhiqu-cli" | cut -f1)（zhiqu-cli/src，本机代码助手）"

echo "==> 2/5 生成应用图标"
# 图标是设计稿（第七十二轮：知字图标设计方案），这里按 macOS 图标的版式四周留白做成 iconset。
# 母版是设计稿的 icon-1024.png（第七十六轮）：原来拿网页用的 icon-512.png，最大那一档（1024 像素）只能放大。
# 第七十二轮之前是从「知」字现画的蓝底图标，第四十轮换了中性配色之后一直没跟上。
ICON_TOOL="$OUT/MakeIcon"
swiftc -O -target arm64-apple-macos13.0 -framework AppKit \
  -o "$ICON_TOOL" "$ROOT/deploy/desktop/icon/MakeIcon.swift"
"$ICON_TOOL" "$ROOT/deploy/desktop/icon/icon-1024.png" \
  "$ROOT/deploy/desktop/icon/favicon-16.png" "$ROOT/deploy/desktop/icon/favicon-32.png" "$OUT/icons" > /dev/null
iconutil -c icns "$OUT/icons/zhiqu.iconset" -o "$APP/Contents/Resources/$NAME.icns"
rm -f "$ICON_TOOL"
echo "    $NAME.icns  $(du -h "$APP/Contents/Resources/$NAME.icns" | cut -f1)"

echo "==> 3/5 编译 Swift 外壳"
# 几个源文件一起编译时，只有叫 main.swift 的那个能有顶层代码（外壳最后那几行 NSApplication.run 就是）——
# 原样一起编译报「expressions are not allowed at the top level」。所以拷一份改名成 main.swift 再编。
SWIFT_BUILD="$OUT/swift-src"
mkdir -p "$SWIFT_BUILD"
cp "$SHELL_DIR/ZhiquShell.swift" "$SWIFT_BUILD/main.swift"
swiftc -O -target arm64-apple-macos13.0 \
  -framework AppKit -framework WebKit -framework UserNotifications \
  -o "$APP/Contents/MacOS/$NAME" "$SWIFT_BUILD/main.swift" \
  "$ROOT/deploy/desktop/macos-shell/Server.swift" "$ROOT/deploy/desktop/macos-shell/PageView.swift" \
  "$ROOT/deploy/desktop/macos-shell/MiniPanel.swift" "$ROOT/deploy/desktop/macos-shell/LocalAgent.swift" \
  "$ROOT/deploy/desktop/macos-shell/Updater.swift" "$ROOT/deploy/desktop/macos-shell/UpdateBadge.swift"
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
  <!-- 网站是 HTTPS。开发时指到本机的 http 后端（ZHIQU_DESKTOP_SERVER）：只放行回环，不是全局关掉 ATS。 -->
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

echo "==> 4/5 签名（ad-hoc）"
# ad-hoc 签名够本机和「右键→打开」用。要给别人分发得用 Developer ID 并公证，
# 否则对方会看到「已损坏，无法打开」—— 那句话和损坏没关系，是 Gatekeeper 的措辞。
codesign --force --sign - "$APP/Contents/Resources/node/bin/node"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
"$APP/Contents/Resources/node/bin/node" --version > /dev/null

echo "==> 5/5 打包成 .dmg（拖拽安装）"
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
# 网页版的「下载桌面版」从后端的下载目录（app.desktop-downloads-dir）拿最新的 dmg：设了 ZHIQU_DOWNLOADS_DIR 就顺手拷进去。
# 服务器上那份要自己拷过去（dmg 不进 git，也不进 JAR）。
if [ -n "${ZHIQU_DOWNLOADS_DIR:-}" ]; then
  mkdir -p "$ZHIQU_DOWNLOADS_DIR"
  # 先拷成点开头的名字再改名：拷到一半时后端不认它（DesktopDownloads 跳过点开头的），不会把半个包发出去
  cp "$DMG" "$ZHIQU_DOWNLOADS_DIR/.$(basename "$DMG").part"
  mv -f "$ZHIQU_DOWNLOADS_DIR/.$(basename "$DMG").part" "$ZHIQU_DOWNLOADS_DIR/$(basename "$DMG")"
  echo "    已拷到下载目录：$ZHIQU_DOWNLOADS_DIR/$(basename "$DMG")"
fi

echo
echo "完成："
echo "  应用：$APP  （$(du -sh "$APP" | cut -f1)）"
echo "  安装包：$DMG"
echo
echo "试跑：  open '$APP'"
