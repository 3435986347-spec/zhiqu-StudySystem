#!/usr/bin/env bash
# 在开发机上跑（第一百二十二轮）：把 RAG 旁路的离线包打好、传到服务器、在服务器上装好并跟着后端起来。
#   ZHIQU_SSH="-i ~/.ssh/zhiqu_server" bash deploy/ubuntu/rag-from-dev.sh
# 离线包：Linux x86_64 的 Python 3.11（python-build-standalone，钉地址和 sha256）、只要 CPU 的 torch 和其余依赖的 wheel、
# 模型（默认 ~/zhiqu/models/bge-small-zh-v1.5，带 ZHIQU_MODEL_REVISION 标记）、旁路的代码。下好的留在 build/rag-bundle，
# 依赖没变就不重下。服务器在国内，PyPI / GitHub / HuggingFace 慢或断，所以一律在这边下好。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HOST=${ZHIQU_HOST:-ubuntu@134.175.110.207}
BASE=${BASE:-/home/ubuntu/zhiqu-StudySystem}
SSH="ssh ${ZHIQU_SSH:-} -o BatchMode=yes"
OUT=${RAG_BUNDLE:-$ROOT/build/rag-bundle}
MODEL=${RAG_MODEL_DIR:-$HOME/zhiqu/models/bge-small-zh-v1.5}
PY311=${PYTHON311:-python3.11}
PY_URL=https://releases.astral.sh/github/python-build-standalone/releases/download/20260901/cpython-3.11.16%2B20260901-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz
PY_SHA=64427febea27864d136db46c8efe968eb6fa5ca2813ce1dca4bb95aec31cb2e4
mkdir -p "$OUT/wheels"

echo "==> 1/5 Python 3.11（Linux x86_64）"
if ! (cd "$OUT" && [ -f python.tar.gz ] && echo "$PY_SHA  python.tar.gz" | shasum -a 256 -c --quiet - 2>/dev/null); then
  curl -fL --retry 3 --progress-bar -o "$OUT/python.tar.gz.part" "$PY_URL"
  (cd "$OUT" && echo "$PY_SHA  python.tar.gz.part" | shasum -a 256 -c --quiet -)
  mv "$OUT/python.tar.gz.part" "$OUT/python.tar.gz"
fi
echo "$PY_SHA" > "$OUT/python.sha256"

echo "==> 2/5 依赖的 wheel（torch 只要 CPU 的；第一次要下几百 MB）"
# 锁文件去掉测试用的 pytest，torch 换成 CPU 版：PyPI 上 Linux 的默认 torch 会把几 GB 的 CUDA 库一起拉下来
grep -vE '^(#|pytest==|[[:space:]]*$)' "$ROOT/rag-service/requirements.lock" | sed -E 's/^torch==([0-9.]+)$/torch==\1+cpu/' > "$OUT/requirements-server.txt.new"
if ! cmp -s "$OUT/requirements-server.txt.new" "$OUT/requirements-server.txt" || [ ! -f "$OUT/wheels/.complete" ]; then
  rm -rf "$OUT/wheels" && mkdir -p "$OUT/wheels"
  "$PY311" -m pip download --dest "$OUT/wheels" --only-binary=:all: --python-version 3.11 --implementation cp --abi cp311 \
    --platform manylinux_2_28_x86_64 --platform manylinux_2_17_x86_64 --platform manylinux2014_x86_64 --platform linux_x86_64 \
    --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple -r "$OUT/requirements-server.txt.new"
  touch "$OUT/wheels/.complete"
fi
mv "$OUT/requirements-server.txt.new" "$OUT/requirements-server.txt"
if ls "$OUT"/wheels/nvidia_* >/dev/null 2>&1; then echo "wheel 里有 CUDA 的库：torch 不是 CPU 版"; exit 1; fi

echo "==> 3/5 模型和代码"
[ -s "$MODEL/ZHIQU_MODEL_REVISION" ] || { echo "$MODEL 不是带 revision 标记的模型目录（见 rag-service/README.md 第 2 步）"; exit 1; }
rsync -a --delete --exclude .DS_Store "$MODEL/" "$OUT/model/"
rsync -a --delete --exclude __pycache__ --exclude .DS_Store "$ROOT/rag-service/app/" "$OUT/app/"
echo "    离线包 $(du -sh "$OUT" | cut -f1)"
# RAG_BUILD_ONLY=1：只在这边打好，不传、不装（先在容器里试装一遍时用）
if [ "${RAG_BUILD_ONLY:-}" = 1 ]; then echo "只打包（RAG_BUILD_ONLY=1）：$OUT"; exit 0; fi

echo "==> 4/5 传到服务器（第一次几百 MB，一两分钟；之后只传变了的）"
$SSH "$HOST" "mkdir -p $BASE/incoming"
rsync -az --progress -e "$SSH" "$ROOT/deploy/ubuntu/" "$HOST:$BASE/incoming/deploy-ubuntu/"
rsync -az --delete --progress -e "$SSH" "$OUT/" "$HOST:$BASE/incoming/rag-bundle/"

echo "==> 5/5 在服务器上装、跟着后端起来（会重启一次后端，网站断二三十秒）"
$SSH "$HOST" "sudo -n bash $BASE/incoming/deploy-ubuntu/install-rag.sh $BASE/incoming/rag-bundle"
