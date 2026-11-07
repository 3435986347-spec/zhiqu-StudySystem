#!/usr/bin/env bash
# 在开发机上跑：打包、把 JAR 和部署脚本传到服务器、重启服务。第一次之前先按 README 跑一遍 install.sh。
#   ZHIQU_SSH="-i ~/.ssh/zhiqu_server" bash deploy/ubuntu/deploy-from-dev.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HOST=${ZHIQU_HOST:-ubuntu@134.175.110.207}
BASE=${BASE:-/home/ubuntu/zhiqu-StudySystem}
SSH="ssh ${ZHIQU_SSH:-} -o BatchMode=yes"
if [ "${SKIP_BUILD:-}" != 1 ]; then (cd "$ROOT/zhiqu-backend" && mvn -o -q clean package -DskipTests); fi
$SSH "$HOST" "mkdir -p $BASE/incoming"
rsync -az -e "$SSH" "$ROOT/deploy/ubuntu/" "$HOST:$BASE/incoming/deploy-ubuntu/"
rsync -az --delete --exclude node_modules --exclude .zhiqu -e "$SSH" "$ROOT/zhiqu-cli/src" "$ROOT/zhiqu-cli/test" "$ROOT/zhiqu-cli/package.json" "$HOST:$BASE/incoming/zhiqu-cli/"
rsync -az -e "$SSH" "$ROOT/zhiqu-backend/target/zhiqu-backend-0.0.1-SNAPSHOT.jar" "$HOST:$BASE/incoming/zhiqu-backend.jar"
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
