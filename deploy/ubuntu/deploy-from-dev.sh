#!/usr/bin/env bash
# 在开发机上跑：打包、把 JAR 和部署脚本传到服务器、重启服务。第一次之前先按 README 跑一遍 install.sh。
#   ZHIQU_SSH="-i ~/.ssh/zhiqu_server" bash deploy/ubuntu/deploy-from-dev.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HOST=${ZHIQU_HOST:-ubuntu@134.175.110.207}
BASE=${BASE:-/home/ubuntu/zhiqu-StudySystem}
SSH="ssh ${ZHIQU_SSH:-} -o BatchMode=yes"
# 每一步都说一句：原来整个过程一声不响（编译 -q、rsync 不打进度），用户看着像卡死了（第一百二十一轮）

# 服务器告诉命令行的「最新版本」就是这里打进去的 zhiqu-cli/package.json（第一百二十六轮，CliRelease.java）：
# npm 上还没有这个版本就部署，所有旧版每次启动都会被提示去装一个装不到的版本。先发 npm、再部署。
CLI_VERSION=$(node -p "require('$ROOT/zhiqu-cli/package.json').version")
if [ "${SKIP_NPM_CHECK:-}" != 1 ]; then
  echo "==> 0/4 看 npm 上有没有命令行 ${CLI_VERSION}"
  if ! PUBLISHED=$(npm view "zhiqu@$CLI_VERSION" version 2>/dev/null) || [ "$PUBLISHED" != "$CLI_VERSION" ]; then
    echo "npm 上还没有 zhiqu@${CLI_VERSION}：先在 zhiqu-cli 里 npm publish，再部署（不然旧版会被提示去装一个 npm 上没有的版本）。"
    echo "确实要先部署（比如查不了 npm）：SKIP_NPM_CHECK=1"
    exit 1
  fi
fi
if [ "${SKIP_BUILD:-}" != 1 ]; then
  echo "==> 1/4 编译后端（一分钟左右，不出声是正常的）"
  (cd "$ROOT/zhiqu-backend" && mvn -o -q clean package -DskipTests)
fi
echo "==> 2/4 传部署脚本和命令行源码"
$SSH "$HOST" "mkdir -p $BASE/incoming"
rsync -az -e "$SSH" "$ROOT/deploy/ubuntu/" "$HOST:$BASE/incoming/deploy-ubuntu/"
rsync -az --delete --exclude node_modules --exclude .zhiqu -e "$SSH" "$ROOT/zhiqu-cli/src" "$ROOT/zhiqu-cli/test" "$ROOT/zhiqu-cli/package.json" "$HOST:$BASE/incoming/zhiqu-cli/"
echo "==> 3/4 传后端（$(du -h "$ROOT/zhiqu-backend/target/zhiqu-backend-0.0.1-SNAPSHOT.jar" | cut -f1)，几十秒）"
rsync -az --progress -e "$SSH" "$ROOT/zhiqu-backend/target/zhiqu-backend-0.0.1-SNAPSHOT.jar" "$HOST:$BASE/incoming/zhiqu-backend.jar"
echo "==> 4/4 换上新的、重启（网站会断二三十秒）"
# 先传到旁边再改名：传到一半断了，服务还是用旧的
$SSH "$HOST" "sudo -n bash -s" <<REMOTE
set -euo pipefail
install -m 644 $BASE/incoming/zhiqu-backend.jar $BASE/app/.zhiqu-backend.jar.new
mv $BASE/app/.zhiqu-backend.jar.new $BASE/app/zhiqu-backend.jar
rm -rf $BASE/deploy/zhiqu-cli
cp -R $BASE/incoming/zhiqu-cli $BASE/deploy/zhiqu-cli
chmod -R a+rX $BASE/deploy/zhiqu-cli
install -m 755 $BASE/incoming/deploy-ubuntu/backup-zhiqu.sh $BASE/incoming/deploy-ubuntu/verify-hosted-shell.sh $BASE/deploy/
systemctl restart zhiqu-backend
REMOTE
echo "传好了，服务重启了。看日志：ssh $HOST sudo journalctl -u zhiqu-backend -n 50"
