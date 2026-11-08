#!/bin/bash
# stdout 只返回 Node 的绝对路径，诊断写到 stderr；在清理旧包之前运行。
set -euo pipefail

fail() { echo "Node 准备失败：$*" >&2; exit 1; }

validate_node() {
  local binary="$1" dependencies library minimum version
  [ -x "$binary" ] || fail "找不到可执行文件：${binary}（NODE_BIN 需指向官方 macOS ARM64 发行包的 bin/node）"
  # lipo 的用法是 `lipo <文件> -verify_arch <架构>`；写成架构在前时，文件路径会被当成架构名，
  # lipo 对任何文件都失败，看起来就像「官方 Node 不是 ARM64」（2026-11-03）。
  lipo "$binary" -verify_arch arm64 >/dev/null 2>&1 || fail "不是 macOS ARM64 可执行文件：$binary"
  dependencies="$(otool -arch arm64 -L "$binary")" || fail "读不出动态库依赖：$binary"
  dependencies="$(printf '%s\n' "$dependencies" | awk 'NR > 1 {sub(/^[ \t]+/, ""); sub(/ \(compatibility version.*$/, ""); print}')"
  [ -n "$dependencies" ] || fail "没有读到动态库依赖：$binary"
  while IFS= read -r library; do
    case "$library" in
      /usr/lib/*|/System/Library/*) ;;
      *) fail "这个 Node 依赖外部动态库 ${library}，不能单独放进安装包：${binary}。取消 NODE_BIN 使用默认官方版本，或指定官方发行包的 bin/node。" ;;
    esac
  done <<< "$dependencies"
  minimum="$(otool -arch arm64 -l "$binary" | awk '
    $1 == "cmd" {legacy = ($2 == "LC_VERSION_MIN_MACOSX")}
    !minimum && ($1 == "minos" || (legacy && $1 == "version")) {minimum = $2}
    END {print minimum}')"
  [[ "$minimum" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || fail "读不出最低 macOS 版本：$binary"
  printf '%s\n' "$minimum" | awk -F. '{exit !($1 < 13 || ($1 == 13 && $2+0 == 0 && $3+0 == 0))}' \
    || fail "这个 Node 要求 macOS ${minimum}，应用需要兼容 macOS 13.0：$binary"
  version="$(env -i PATH=/usr/bin:/bin "$binary" --version)" || fail "Node 无法启动：$binary"
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+].*)?$ ]] || fail "不是可识别的 Node 版本：$version"
  printf '%s\n' "${version#v}" | awk -F. '{exit !($1 > 18 || ($1 == 18 && $2 >= 17))}' \
    || fail "需要 Node 18.17 或以上，当前为 $version"
}

if [ -n "${NODE_BIN:-}" ]; then
  [ -f "$NODE_BIN" ] || fail "找不到 NODE_BIN 指定的文件：$NODE_BIN"
  NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"
  validate_node "$NODE_BIN"
  printf '%s\n' "$NODE_BIN"
  exit 0
fi

# 固定版本与官方 SHA256，不能随 PATH 上的 Homebrew Node 或远端 latest 漂移。
NODE_VERSION="22.23.2"
DIST="node-v$NODE_VERSION-darwin-arm64"
SHA256="61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6"
CACHE="${1:-$(cd "$(dirname "$0")/../.." && pwd)/build/node-runtime}"
mkdir -p "$CACHE"
CACHE="$(cd "$CACHE" && pwd)"
ARCHIVE="$CACHE/$DIST.tar.gz"
WORK="$(mktemp -d "$CACHE/.prepare.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

valid_archive() {
  [ -f "$1" ] && [ "$(shasum -a 256 < "$1" | awk '{print $1}')" = "$SHA256" ]
}

if ! valid_archive "$ARCHIVE"; then
  echo "==> 准备官方 Node v${NODE_VERSION}（首次下载，之后复用校验通过的缓存）" >&2
  curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 300 --retry 2 \
    "https://nodejs.org/dist/v$NODE_VERSION/$DIST.tar.gz" -o "$WORK/node.tar.gz" \
    || fail "官方 Node 下载失败；检查网络后重试，或用 NODE_BIN 指定已解压的官方 macOS ARM64 bin/node"
  valid_archive "$WORK/node.tar.gz" || fail "下载的 Node SHA256 校验失败，不会使用这个文件"
  mv -f "$WORK/node.tar.gz" "$ARCHIVE"
fi

# 每次从验证过的归档解出二进制，不信任上一次解出的缓存。只取运行时与许可证，不带 npm。
tar -xzf "$ARCHIVE" -C "$WORK" "$DIST/bin/node" "$DIST/LICENSE"
validate_node "$WORK/$DIST/bin/node"
mkdir -p "$CACHE/$DIST/bin"
mv -f "$WORK/$DIST/bin/node" "$CACHE/$DIST/bin/node"
mv -f "$WORK/$DIST/LICENSE" "$CACHE/$DIST/LICENSE"
printf '%s\n' "$CACHE/$DIST/bin/node"
