#!/usr/bin/env bash
# 每晚一份：数据库、上传的文件、配置（配置里有主密钥：没有它，库里的密文解不开）。留 7 天，只有 root 读得了。
# 这份备份和数据在同一台机器上，机器没了它也没了：要真的安全，再把 backups/ 同步到别处。
set -euo pipefail
BASE=${BASE:-/home/ubuntu/zhiqu-StudySystem}
DEST=$BASE/backups
STAMP=$(date +%F)
umask 077
mkdir -p "$DEST"
mysqldump --single-transaction --routines --no-tablespaces zhiqu_db | gzip > "$DEST/.db-$STAMP.tmp"
mv "$DEST/.db-$STAMP.tmp" "$DEST/zhiqu_db-$STAMP.sql.gz"
tar -czf "$DEST/.files-$STAMP.tmp" -C "$BASE" data/uploads config
mv "$DEST/.files-$STAMP.tmp" "$DEST/files-$STAMP.tar.gz"
find "$DEST" -maxdepth 1 -type f -mtime +7 -delete
echo "backup ok: $STAMP"
