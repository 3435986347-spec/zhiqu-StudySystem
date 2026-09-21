#!/bin/bash
# 把后端打成一个 macOS 应用（.dmg）。
#
# 产出的应用里包含：一份 JRE + Spring Boot 胖 JAR。双击启动后端（绑 127.0.0.1，
# 端口由系统分配），然后打开默认浏览器。
#
# -Djava.awt.headless=false 不是可选项，删了 Dock 图标会无限弹跳：
# jpackage 产出的是 ApplicationType=Foreground 的应用，macOS 会一直弹跳图标直到进程
# 连上 CoreGraphics 窗口服务器，而 headless 的 JVM 永远不会连（lsappinfo 报 !cgsConnection）。
# 这个开关只能走 JVM 参数 —— Spring 的 spring.main.headless 绑定得太晚，来不及。
# 详见 DockPresence 的类注释。
#
# 它<b>不</b>包含数据库。数据库地址写在 ~/.zhiqu/application.yml 里 ——
# 指向远程 MySQL 就能多地点登录看同一份数据。
# 不要把 MySQL 直接开到公网：让它只监听内网，桌面端走 SSH 隧道或 WireGuard。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BACKEND="$ROOT/zhiqu-backend"
OUT="$ROOT/build/desktop"
NAME="知趣象限"
VERSION="${1:-1.0.0}"

export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17)}"
echo "JDK: $JAVA_HOME"

echo "==> 1/3 打 JAR"
cd "$BACKEND"
mvn -o clean package -DskipTests -q
JAR="$(ls target/zhiqu-backend-*.jar | head -1)"
[ -f "$JAR" ] || { echo "打包失败：找不到 JAR"; exit 1; }
echo "    $(basename "$JAR")  $(du -h "$JAR" | cut -f1)"

echo "==> 2/3 准备输入目录"
rm -rf "$OUT"; mkdir -p "$OUT/input"
cp "$JAR" "$OUT/input/"

echo "==> 3/3 jpackage"
"$JAVA_HOME/bin/jpackage" \
  --type dmg \
  --name "$NAME" \
  --app-version "$VERSION" \
  --input "$OUT/input" \
  --main-jar "$(basename "$JAR")" \
  --dest "$OUT" \
  --vendor "zhiqu" \
  --mac-package-identifier "com.zhiqu.quadrant" \
  --java-options "-Dspring.profiles.active=desktop" \
  --java-options "-Dfile.encoding=UTF-8" \
  --java-options "-Djava.awt.headless=false" \
  --java-options "-Xmx1g"

echo
echo "完成：$(ls "$OUT"/*.dmg 2>/dev/null || echo '（没有产出 dmg）')"
