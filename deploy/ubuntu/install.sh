#!/usr/bin/env bash
# 在服务器上跑一次：sudo bash install.sh。再跑也没事（已有的配置和密钥不动）。
# 密钥都在这台机器上现生成，不打印、不进仓库：主密钥一换，库里的密文就解不开了，所以配置文件存在就绝不重写。
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "要用 sudo 跑" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
BASE=${BASE:-/home/ubuntu/zhiqu-StudySystem}
SPACE_SIZE=${SPACE_SIZE:-4G}
export DEBIAN_FRONTEND=noninteractive

echo "== 装依赖"
apt-get update -qq
apt-get install -y -qq openjdk-17-jre-headless mysql-server redis-server bubblewrap caddy nodejs acl rsync e2fsprogs python3 git >/dev/null

echo "== 账号和目录"
id zhiqu >/dev/null 2>&1 || useradd --system --home-dir /var/lib/zhiqu --create-home --shell /usr/sbin/nologin zhiqu
# 家目录是 750：只让 zhiqu 能穿过去，读不了 ubuntu 家里的别的东西
setfacl -m u:zhiqu:--x "$(dirname "$BASE")"
install -d -o ubuntu -g ubuntu -m 755 "$BASE" "$BASE/app" "$BASE/deploy"
install -d -o root -g zhiqu -m 750 "$BASE/config"
install -d -o root -g root -m 700 "$BASE/backups"
install -d -o zhiqu -g zhiqu -m 750 "$BASE/logs" "$BASE/data" "$BASE/data/uploads" "$BASE/data/downloads" "$BASE/data/workspace-state"
install -m 755 "$HERE/backup-zhiqu.sh" "$BASE/deploy/backup-zhiqu.sh"
install -m 755 "$HERE/verify-hosted-shell.sh" "$BASE/deploy/verify-hosted-shell.sh"

echo "== 产物的临时空间：单独一块小文件系统（命令写满了也只满这一块）"
IMG=$BASE/data/artifact-spaces.img
MNT=$BASE/data/artifact-spaces
install -d -o zhiqu -g zhiqu -m 750 "$MNT"
if [ ! -f "$IMG" ]; then
  truncate -s "$SPACE_SIZE" "$IMG"
  mkfs.ext4 -q -F -m 0 "$IMG"
  chmod 600 "$IMG"
fi
grep -qF "$IMG" /etc/fstab || echo "$IMG $MNT ext4 loop,nodev,nosuid,noatime 0 2" >> /etc/fstab
mountpoint -q "$MNT" || mount "$MNT"
install -d -o zhiqu -g zhiqu -m 700 "$MNT/spaces"
chown zhiqu:zhiqu "$MNT"

echo "== AppArmor：用系统自带的 bwrap-userns-restrict（放进去的命令没有任何能力）"
# 不要再加一份绑在 /usr/bin/bwrap 上的配置：两份绑同一个程序内核算冲突，哪份都不生效，bwrap 就起不来了（第一百一十九轮撞到）
if [ -f /etc/apparmor.d/zhiqu-bwrap ]; then apparmor_parser -R /etc/apparmor.d/zhiqu-bwrap || true; rm -f /etc/apparmor.d/zhiqu-bwrap; fi
[ -f /etc/apparmor.d/bwrap-userns-restrict ] || echo "注意：这台机器没有 /etc/apparmor.d/bwrap-userns-restrict，bubblewrap 可能起不来；verify-hosted-shell.sh 会说"

echo "== MySQL"
install -m 644 "$HERE/mysql-zhiqu.cnf" /etc/mysql/mysql.conf.d/zz-zhiqu.cnf
mkdir -p /etc/systemd/system/mysql.service.d
printf '[Service]\nOOMScoreAdjust=-800\n' > /etc/systemd/system/mysql.service.d/zhiqu.conf

echo "== Redis"
install -m 640 -o redis -g redis "$HERE/redis-zhiqu.conf" /etc/redis/zhiqu.conf
grep -qF 'include /etc/redis/zhiqu.conf' /etc/redis/redis.conf || echo 'include /etc/redis/zhiqu.conf' >> /etc/redis/redis.conf
mkdir -p /etc/systemd/system/redis-server.service.d
printf '[Service]\nOOMScoreAdjust=-500\n' > /etc/systemd/system/redis-server.service.d/zhiqu.conf
systemctl daemon-reload

echo "== 配置和密钥"
CONFIG=$BASE/config/application-prod.yml
if [ -f "$CONFIG" ]; then
  echo "配置已经有了，不动（主密钥一换，库里的密文就解不开了）"
else
  # 密钥走环境变量给 python，不进命令行参数
  ZQ_DB=$(openssl rand -hex 24) ZQ_REDIS=$(openssl rand -hex 24) ZQ_JWT=$(openssl rand -hex 48) ZQ_MASTER=$(openssl rand -hex 48) ZQ_RAG=$(openssl rand -hex 24) \
  ZQ_TEMPLATE=$HERE/application-prod.example.yml ZQ_CONFIG=$CONFIG ZQ_SQL=$HERE/create-database.sql python3 - <<'PY'
import os, stat
env = os.environ
text = open(env['ZQ_TEMPLATE'], encoding='utf8').read()
pairs = {'CHANGE_ME_DB_PASSWORD': 'ZQ_DB', 'CHANGE_ME_REDIS_PASSWORD': 'ZQ_REDIS', 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET_AT_LEAST_32_CHARS': 'ZQ_JWT',
         'CHANGE_ME_TO_A_LONG_RANDOM_CRYPTO_MASTER_KEY': 'ZQ_MASTER', 'CHANGE_ME_RAG_SERVICE_TOKEN': 'ZQ_RAG'}
for mark, name in pairs.items():
    assert mark in text, mark
    text = text.replace(mark, env[name])
assert 'CHANGE_ME' not in text
fd = os.open(env['ZQ_CONFIG'] + '.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
with os.fdopen(fd, 'w', encoding='utf8') as f:
    f.write(text)
sql = open(env['ZQ_SQL'], encoding='utf8').read().replace('CHANGE_ME_DB_PASSWORD', env['ZQ_DB'])
fd = os.open('/run/zhiqu-create-database.sql', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w', encoding='utf8') as f:
    f.write(sql)
fd = os.open('/etc/redis/zhiqu-auth.conf', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
with os.fdopen(fd, 'w', encoding='utf8') as f:
    f.write('requirepass ' + env['ZQ_REDIS'] + '\n')
PY
  chown redis:redis /etc/redis/zhiqu-auth.conf
  grep -qF 'include /etc/redis/zhiqu-auth.conf' /etc/redis/redis.conf || echo 'include /etc/redis/zhiqu-auth.conf' >> /etc/redis/redis.conf
  systemctl restart mysql
  mysql < /run/zhiqu-create-database.sql
  rm -f /run/zhiqu-create-database.sql
  chown root:zhiqu "$CONFIG.tmp"
  mv "$CONFIG.tmp" "$CONFIG"
fi
systemctl restart mysql redis-server

echo "== 服务"
install -m 644 "$HERE/zhiqu-backend.service" /etc/systemd/system/zhiqu-backend.service
install -m 644 "$HERE/zhiqu-backup.service" /etc/systemd/system/zhiqu-backup.service
install -m 644 "$HERE/zhiqu-backup.timer" /etc/systemd/system/zhiqu-backup.timer
systemctl daemon-reload
systemctl enable --now zhiqu-backup.timer >/dev/null
systemctl enable zhiqu-backend >/dev/null
if [ -f "$BASE/app/zhiqu-backend.jar" ]; then systemctl restart zhiqu-backend; else echo "还没有 JAR：传上来之后 sudo systemctl restart zhiqu-backend"; fi

echo "== Caddy"
install -m 644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
systemctl enable caddy >/dev/null
systemctl restart caddy
echo "好了。服务器上跑命令默认还关着：sudo bash $BASE/deploy/verify-hosted-shell.sh 全过了才会打开。"
