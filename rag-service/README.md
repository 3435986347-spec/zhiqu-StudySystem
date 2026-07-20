# 知趣 RAG Sidecar

该服务只负责 Notebook 资料的 tokenizer 子分块、Embedding、Chroma 索引和候选召回。MySQL 与私有上传目录仍是权威数据源，Chroma 不保存权威正文。

## 本地运行

1. 安装 Python 3.11 x64，并创建 `.venv`。
2. 使用 `pip install -r requirements.lock` 安装锁定依赖。
3. 将 `BAAI/bge-small-zh-v1.5` 的固定 revision 预下载到本地模型目录。
4. 将 `.env.example` 复制为 `.env` 并填写同后端一致的 token、模型 revision 和 index version。
5. 运行 `python -m uvicorn app.main:app --host 127.0.0.1 --port 8001 --workers 1`。

生产环境禁止使用浮动的模型 `main` revision，也不要把 8001 端口开放到公网。

P0 Sidecar 一次只加载一个 `RAG_INDEX_VERSION`，蓝绿能力用于同一模型和分块版本下的 collection 重建与回滚。升级 Embedding 模型或分块版本时，需要启动匹配新版本的 Sidecar、重新构建索引；切换期间 Java 会自动降级为关键词检索。本版本不宣称跨模型版本无缝蓝绿。

在可联网的部署准备机上，可以用不可变 commit SHA 下载离线模型：

```powershell
python scripts/download_model.py --revision <40位commit SHA> --target C:\zhiqu\models\bge-small-zh-v1.5
```

将模型目录整体复制到生产机，并把同一个 SHA 写入 `.env` 的 `RAG_MODEL_REVISION`。生产服务只读取本地目录，不会在启动时下载模型。
