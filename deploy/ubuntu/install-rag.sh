#!/usr/bin/env bash
# 在服务器上装 RAG 旁路（第一百二十二轮），root 跑：sudo bash install-rag.sh <离线包目录>
# 离线包由开发机上的 rag-from-dev.sh 打好、传过来：Linux x86_64 的 Python 3.11、只要 CPU 的 torch 和其余依赖的 wheel、
# 模型（带 revision 标记）、旁路的代码。这里一个字节都不从外网下（服务器在国内，PyPI / GitHub / HuggingFace 慢或断）。
# 再跑一遍也没事：换代码、换依赖、换模型都是整份替换；令牌、配置只读不改（只把 rag.enabled 翻成 true）。
# ZQ_SKIP_SYSTEMD=1：只装到 venv、写 rag.env，不碰 systemd 和后端（在容器里先装一遍时用）。
set -euo pipefail
BUNDLE=$(cd "${1:?用法：sudo bash install-rag.sh <离线包目录>}" && pwd)
BASE=${BASE:-/home/ubuntu/zhiqu-StudySystem}
HERE=$(cd "$(dirname "$0")" && pwd)
CONFIG=$BASE/config/application-prod.yml
RAG=$BASE/rag
[ "$(id -u)" = 0 ] || { echo "要 root：sudo bash $0 $BUNDLE"; exit 1; }
[ -f "$CONFIG" ] || { echo "没有 ${CONFIG}：先跑 install.sh"; exit 1; }
id zhiqu >/dev/null 2>&1 || { echo "没有 zhiqu 账号：先跑 install.sh"; exit 1; }
for f in python.tar.gz python.sha256 requirements-server.txt; do [ -f "$BUNDLE/$f" ] || { echo "离线包里缺 $f"; exit 1; }; done
[ -d "$BUNDLE/wheels" ] && [ -d "$BUNDLE/app" ] && [ -d "$BUNDLE/model" ] || { echo "离线包里缺 wheels / app / model"; exit 1; }

echo "==> 1/6 Python 3.11（校验过才解开）"
(cd "$BUNDLE" && echo "$(cat python.sha256)  python.tar.gz" | sha256sum -c --quiet -)
rm -rf "$RAG/python.new" && mkdir -p "$RAG/python.new"
tar -xzf "$BUNDLE/python.tar.gz" -C "$RAG/python.new" --strip-components=1
"$RAG/python.new/bin/python3" -c 'import sys; assert sys.version_info[:2] == (3, 11), sys.version'
rm -rf "$RAG/python" && mv "$RAG/python.new" "$RAG/python"

echo "==> 2/6 依赖（离线：--no-index，只认离线包里的 wheel）"
rm -rf "$RAG/venv.new"
"$RAG/python/bin/python3" -m venv "$RAG/venv.new"
"$RAG/venv.new/bin/python" -m pip install -q --no-index --find-links "$BUNDLE/wheels" -r "$BUNDLE/requirements-server.txt"
"$RAG/venv.new/bin/python" -c 'import torch, chromadb, sentence_transformers, fastapi; assert not torch.cuda.is_available(); print("    torch", torch.__version__, "chromadb", chromadb.__version__)'
rm -rf "$RAG/venv" && mv "$RAG/venv.new" "$RAG/venv"
# venv 里记着自己的路径：换名之后重写 bin 下脚本的解释器行（只用 python -m 跑，pip 等不用，写对也无妨）
sed -i "s#$RAG/venv.new#$RAG/venv#g" "$RAG/venv/pyvenv.cfg" "$RAG/venv/bin/activate" 2>/dev/null || true

echo "==> 3/6 代码和模型"
rm -rf "$RAG/app.new" "$RAG/models.new" && mkdir -p "$RAG/models.new"
cp -R "$BUNDLE/app" "$RAG/app.new"
cp -R "$BUNDLE/model" "$RAG/models.new/bge-small-zh-v1.5"
[ -s "$RAG/models.new/bge-small-zh-v1.5/ZHIQU_MODEL_REVISION" ] || { echo "模型缺 revision 标记"; exit 1; }
rm -rf "$RAG/app" "$RAG/models" && mv "$RAG/app.new" "$RAG/app" && mv "$RAG/models.new" "$RAG/models"
chown -R root:root "$RAG" && chmod -R a+rX "$RAG"
install -d -o zhiqu -g zhiqu -m 750 "$BASE/data/rag"

echo "==> 4/6 旁路的配置（令牌、索引版本照后端的配置抄，不打印）"
cp -p "$CONFIG" "$CONFIG.bak-rag-$(date +%Y%m%d%H%M%S)"
ZQ_CONFIG=$CONFIG ZQ_ENV=$BASE/config/rag.env ZQ_DATA=$BASE/data/rag ZQ_MODEL=$RAG/models/bge-small-zh-v1.5 python3 - <<'PY'
import os, re
env = os.environ
lines = open(env['ZQ_CONFIG'], encoding='utf8').read().split('\n')
# 只在 app.rag 那一段里找；这段的键是四个空格缩进，碰到缩进更浅的就出了这一段
start = next(i for i, l in enumerate(lines) if l == '  rag:')
end = next((i for i in range(start + 1, len(lines)) if lines[i].strip() and not lines[i].startswith('    ')), len(lines))
block = {}
for i in range(start + 1, end):
    m = re.match(r'^    ([a-z-]+):\s*(.*?)\s*$', lines[i])
    if m: block[m.group(1)] = (i, m.group(2))
token = block['service-token'][1]
if not token or token.startswith('CHANGE_ME'):
    raise SystemExit('配置里的 app.rag.service-token 还是占位符：先跑 install.sh')
version = block['index-version'][1]
revision = open(os.path.join(env['ZQ_MODEL'], 'ZHIQU_MODEL_REVISION'), encoding='utf8').read().strip()
text = (f"RAG_SERVICE_TOKEN={token}\nRAG_DATA_DIR={env['ZQ_DATA']}\nRAG_MODEL_PATH={env['ZQ_MODEL']}\n"
        f"RAG_MODEL_REVISION={revision}\nRAG_INDEX_VERSION={version}\nRAG_DEVICE=cpu\n")
fd = os.open(env['ZQ_ENV'] + '.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
os.write(fd, text.encode('utf8')); os.close(fd)
os.replace(env['ZQ_ENV'] + '.tmp', env['ZQ_ENV'])
# 默认开（用户要的）：只翻这一个值，别的一个字都不动（主密钥一换，库里的密文就解不开）
i, value = block['enabled']
if value != 'true':
    lines[i] = '    enabled: true'
    tmp = env['ZQ_CONFIG'] + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
    os.write(fd, '\n'.join(lines).encode('utf8')); os.close(fd)
    os.replace(tmp, env['ZQ_CONFIG'])
    print('    app.rag.enabled：false → true')
PY
chown root:zhiqu "$CONFIG" "$BASE/config/rag.env" && chmod 640 "$CONFIG" "$BASE/config/rag.env"

if [ "${ZQ_SKIP_SYSTEMD:-}" = 1 ]; then echo "（ZQ_SKIP_SYSTEMD=1：不碰 systemd）"; exit 0; fi

echo "==> 5/6 跟着后端起"
install -m 644 "$HERE/zhiqu-rag.service" /etc/systemd/system/zhiqu-rag.service
install -m 644 "$HERE/zhiqu-backend.service" /etc/systemd/system/zhiqu-backend.service
systemctl daemon-reload
systemctl enable zhiqu-rag >/dev/null
systemctl restart zhiqu-rag

echo "==> 6/6 等旁路准备好（模型加载要十秒左右），再重启后端"
TOKEN=$(sed -n 's/^RAG_SERVICE_TOKEN=//p' "$BASE/config/rag.env")
ready=0
for _ in $(seq 1 90); do
  if curl -fsS -m 3 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8001/health/ready 2>/dev/null | grep -q '"ready":true'; then ready=1; break; fi
  sleep 2
done
unset TOKEN
[ "$ready" = 1 ] || { echo "旁路三分钟都没准备好：journalctl -u zhiqu-rag -n 80"; exit 1; }
systemctl restart zhiqu-backend
for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/index.html)" = 200 ] && break; sleep 2; done
mem=$(systemctl show zhiqu-rag -p MemoryCurrent --value); case "$mem" in ''|*[!0-9]*) mem='?' ;; *) mem=$((mem / 1048576)) ;; esac
echo "旁路：$(systemctl is-active zhiqu-rag)，内存 ${mem}MB；后端：$(systemctl is-active zhiqu-backend)"
echo "装好了。卡着的重建代次会被后台领走接着做；后台的「RAG」那一栏看进度。"
