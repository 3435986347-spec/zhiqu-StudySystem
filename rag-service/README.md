# 知趣 RAG Sidecar

该服务只负责 Notebook 资料的 tokenizer 子分块、Embedding、Chroma 索引和候选召回。MySQL 与私有上传目录仍是权威数据源，Chroma 不保存权威正文。

后端默认 `app.rag.enabled=true`，连不上本服务时会自动降级为关键词检索——**所以 sidecar 没起来时系统照常可用，只是检索变弱**。

---

## 本地运行

三个平台的步骤相同，差别只在**路径写法**和**如何调用虚拟环境里的 Python**。

| | Windows (PowerShell) | macOS | Linux |
|---|---|---|---|
| 建虚拟环境 | `py -3.11 -m venv .venv` | `python3.11 -m venv .venv` | `python3.11 -m venv .venv` |
| 虚拟环境里的 Python | `.venv\Scripts\python.exe` | `.venv/bin/python` | `.venv/bin/python` |
| 路径分隔 | `C:/zhiqu/...`（`.env` 里用正斜杠） | `/Users/<你>/zhiqu/...` | `/home/<你>/zhiqu/...` |

> **不要写成裸 `python`。** macOS 自带的是 `python3`，`python` 常常根本不存在
> （报 `zsh: command not found: python`）；而在已 `activate` 的环境之外，裸 `python`
> 可能指向系统解释器，装的依赖不在那里。**下面一律用 `.venv` 里的解释器全路径**，
> 不依赖有没有 activate 过。

### 1. 建虚拟环境并装依赖

**Windows (PowerShell)**
```powershell
cd rag-service
py -3.11 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.lock
```

**macOS**
```bash
cd rag-service
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
```

**Linux**
```bash
cd rag-service
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
```

### 2. 准备模型

在**可联网**的机器上按不可变 commit SHA 下载（不要用浮动的 `main`）：

**Windows**
```powershell
.venv\Scripts\python.exe scripts\download_model.py --revision <40位commit SHA> --target C:\zhiqu\models\bge-small-zh-v1.5
```

**macOS / Linux**
```bash
.venv/bin/python scripts/download_model.py --revision <40位commit SHA> --target ~/zhiqu/models/bge-small-zh-v1.5
```

把整个模型目录复制到目标机，并把同一个 SHA 写进 `.env` 的 `RAG_MODEL_REVISION`。
**生产只读本地目录，启动时不会联网下载。**

### 3. 写 `.env`

`cp .env.example .env`（Windows: `copy .env.example .env`），然后改四项：

```ini
RAG_SERVICE_TOKEN=<与后端 app.rag.service-token 完全一致>
RAG_DATA_DIR=<Chroma 落盘目录>
RAG_MODEL_PATH=<上一步的模型目录>
RAG_MODEL_REVISION=<同一个 40 位 SHA>
```

各平台的目录写法：

| | `RAG_DATA_DIR` | `RAG_MODEL_PATH` |
|---|---|---|
| Windows | `C:/zhiqu/rag-data` | `C:/zhiqu/models/bge-small-zh-v1.5` |
| macOS | `/Users/<你>/zhiqu/rag-data` | `/Users/<你>/zhiqu/models/bge-small-zh-v1.5` |
| Linux | `/home/<你>/zhiqu/rag-data` | `/home/<你>/zhiqu/models/bge-small-zh-v1.5` |

> `RAG_INDEX_VERSION` **可以不设**：后端 `application.yml` 与 sidecar `app/settings.py`
> 的默认值是同一个字符串，不设就天然一致。上生产前应把两边一起钉成含真实 revision 的值。

### 4. 启动

**Windows (PowerShell)**
```powershell
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8001 --workers 1
```

**macOS / Linux**
```bash
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8001 --workers 1
```

后台运行（macOS / Linux）：
```bash
nohup .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8001 --workers 1 > /tmp/rag.log 2>&1 &
```

Windows 后台运行：
```powershell
Start-Process -WindowStyle Hidden .venv\Scripts\python.exe `
  -ArgumentList '-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8001','--workers','1'
```

### 5. 验活

**三个端点都需要 Bearer token**，不带一律 401——包括两个 health 端点。
（曾经有人按常见约定去试 `/healthz`、`/health`，全是 404，因为路径不是那两个。）

| 端点 | 用途 |
|---|---|
| `GET /health/live` | 进程活着 |
| `GET /health/ready` | 模型加载完、可以接请求 |
| `GET /v1/meta` | 模型路径、revision、维度、index version——**排查版本不一致时看这个** |

**macOS / Linux**
```bash
curl -s -H "Authorization: Bearer $(grep '^RAG_SERVICE_TOKEN=' .env | cut -d= -f2-)" \
  http://127.0.0.1:8001/v1/meta
```

**Windows (PowerShell)**
```powershell
$t = (Select-String -Path .env -Pattern '^RAG_SERVICE_TOKEN=(.*)$').Matches.Groups[1].Value
curl.exe -s -H "Authorization: Bearer $t" http://127.0.0.1:8001/v1/meta
```

正常返回里 `"ready": true`，且 `modelRevision` 与 `.env` 一致。

### 6. 停止

**macOS / Linux**
```bash
kill $(lsof -nP -iTCP:8001 -sTCP:LISTEN -t)
```

**Windows (PowerShell)**
```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 8001 -State Listen).OwningProcess
```

> 按端口找进程，不要按名字 `pkill -f python` ——那会连带杀掉别的 Python 进程。

---

## 版本与蓝绿

生产环境禁止使用浮动的模型 `main` revision，也不要把 8001 端口开放到公网。

P0 Sidecar 一次只加载一个 `RAG_INDEX_VERSION`，蓝绿能力用于同一模型和分块版本下的 collection 重建与回滚。升级 Embedding 模型或分块版本时，需要启动匹配新版本的 Sidecar、重新构建索引；切换期间 Java 会自动降级为关键词检索。本版本不宣称跨模型版本无缝蓝绿。

---

## 常见问题

| 症状 | 原因 |
|---|---|
| `command not found: python` | macOS 没有裸 `python`。用 `.venv/bin/python` 或 `python3` |
| `/healthz` 404 | 路径是 `/health/live` 与 `/health/ready` |
| health 端点返回 `{"detail":"Unauthorized"}` | 它们也要 Bearer token |
| `address already in use` | 8001 已被占用，先按上面的方式停掉旧进程 |
| 后端日志说降级为关键词检索 | sidecar 没起、token 不一致、或 `index version` 两边对不上（查 `/v1/meta`） |
