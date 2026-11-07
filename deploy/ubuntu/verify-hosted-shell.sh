#!/usr/bin/env bash
# 服务器上跑命令的开关：在这台机器上真跑一遍隔离的判据（真 bubblewrap、真 AppArmor、和服务同样的账号和限制），全过了才打开。
#   sudo bash verify-hosted-shell.sh          跑判据，全过就打开并重启服务；没过什么都不改
#   sudo bash verify-hosted-shell.sh --check  只跑判据，不改
# 判据里有一颗 fork 炸弹（先确认进程数上限设上了才放），所以这里也和服务一样限着内存和进程数。
# 限着时间：漏掉的进程会攥着管道，判据就一直等下去（第一百一十九轮撞到过）。到点算没过，unit 一停，它的进程全都清掉。
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "要用 sudo 跑" >&2; exit 1; }
BASE=${BASE:-/home/ubuntu/zhiqu-StudySystem}
CONFIG=$BASE/config/application-prod.yml
CLI=$BASE/deploy/zhiqu-cli
[ -f "$CLI/test/sandbox-hosted.test.js" ] || { echo "找不到 $CLI：deploy-from-dev.sh 会把命令行的源码和判据传上来" >&2; exit 1; }
RESULT=$(mktemp)
chmod 644 "$RESULT"
set +e
systemd-run --wait --pipe --collect --quiet \
  -p User=zhiqu -p Group=zhiqu -p WorkingDirectory="$CLI" \
  -p MemoryMax=1300M -p MemorySwapMax=512M -p OOMPolicy=continue -p TasksMax=1024 -p RuntimeMaxSec=300 \
  -p NoNewPrivileges=true -p PrivateTmp=true -p ProtectSystem=strict -p ReadWritePaths="$BASE/data $BASE/logs" -p RestrictSUIDSGID=true -p LockPersonality=true \
  /usr/bin/node --test --test-reporter=tap --test-force-exit test/sandbox-hosted.test.js > "$RESULT" 2>&1
CODE=$?
set -e
grep -E '^(not ok|# (tests|pass|fail|cancelled|skipped) )' "$RESULT" || true
PASS=$(sed -n 's/^# pass //p' "$RESULT" | tail -n 1)
FAIL=$(sed -n 's/^# fail //p' "$RESULT" | tail -n 1)
SKIP=$(sed -n 's/^# skipped //p' "$RESULT" | tail -n 1)
if [ "$CODE" != 0 ] || [ "${FAIL:-1}" != 0 ] || [ "${SKIP:-1}" != 0 ] || [ "${PASS:-0}" -lt 15 ]; then
  echo "没有全过（跳过也不算过）：服务器上跑命令保持关着。完整输出：$RESULT" >&2
  exit 1
fi
rm -f "$RESULT"
echo "隔离的判据全过了（$PASS 条）"
[ "${1:-}" = "--check" ] && exit 0
sed -i 's/^\( *hosted-shell-enabled:\) false$/\1 true/' "$CONFIG"
grep -q '^ *hosted-shell-enabled: true$' "$CONFIG"
systemctl restart zhiqu-backend
echo "服务器上跑命令打开了"
