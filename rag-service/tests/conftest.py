"""导入 app.main 之前必须先立好环境。

`app/main.py` 在**模块层**就执行 `settings = Settings()`（main.py:55），所以任何
`import app.main` 都会立刻跑一遍 pydantic-settings 校验。缺 `service_token` 或
`model_revision` 就直接 ValidationError，测试连收集阶段都过不去。

三件在这里一次性钉死（都是实测得来，别再重新摸索）：

1. **env 前缀是 `RAG_`**（settings.py:8 的 `env_prefix`），不是裸名。
2. **`model_revision` 有 `min_length=7`**（settings.py:13），随便填个 "x" 也会红。
3. **`import app.main` 不加载 embedding 权重** —— `EmbeddingService` 只在 lifespan 里
   构造，且整段包在 try/except 中。所以这批测试**不需要下载 bge-small-zh-v1.5**，
   装完 lock 就能写。这一条把「给 main.py 补测试」从「先准备几百 MB 权重」降成
   「设四个环境变量」，是三条里最值钱的。

`.env` 文件的干扰也一并排除：pydantic-settings 里**环境变量优先于 env_file**，
所以凡是断言依赖的字段都在这里显式设定，开发机上存在 .env 也不会让结果漂。
"""

import os

os.environ.setdefault("RAG_SERVICE_TOKEN", "test-token-0123456789abcdef")
os.environ.setdefault("RAG_MODEL_REVISION", "test-revision-0000000")
os.environ.setdefault("RAG_INDEX_VERSION", "test-index-version-v1")
os.environ.setdefault("RAG_MAX_REQUEST_BYTES", str(5 * 1024 * 1024))

import pytest  # noqa: E402  —— 必须在 env 之后

from app import main as main_module  # noqa: E402


class RecordingStore:
    """记录调用参数的替身。

    这批测试验的是 `main.py` 这一层：鉴权、契约校验、异常→HTTP 状态码的映射，
    以及**交给 VectorStore 的 payload 长什么样**。真实 VectorStore 需要 chromadb
    与模型权重，把它换掉不是为了快，是为了让断言的对象只剩 main.py 一层 ——
    否则一条红下来分不清是谁的问题。
    """

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.raise_on_next: Exception | None = None

    def _record(self, name, payload):
        self.calls.append((name, payload))
        if self.raise_on_next is not None:
            error, self.raise_on_next = self.raise_on_next, None
            raise error
        return {"ok": True}

    def index_source(self, payload):
        return self._record("index_source", payload)

    def query(self, payload):
        return self._record("query", payload)

    def delete(self, payload):
        return self._record("delete", payload)

    def collection_names(self):
        return ["zhiqu_test"]

    def last_payload(self, name):
        for call_name, payload in reversed(self.calls):
            if call_name == name:
                return payload
        raise AssertionError(f"没有记录到对 {name} 的调用，实际调用：{[c[0] for c in self.calls]}")


@pytest.fixture
def store():
    """把 main.state 换成「就绪 + 替身 store」，用完还原。

    直接改 `main.state` 而不是走 lifespan：lifespan 会尝试构造 EmbeddingService，
    失败被 try/except 吞成 ready=False —— 那样每个用例都只能拿到 503。
    """
    fake = RecordingStore()
    saved = dict(main_module.state)
    main_module.state.update(ready=True, error=None, store=fake,
                             embedding=type("E", (), {"dimension": 512})())
    try:
        yield fake
    finally:
        main_module.state.clear()
        main_module.state.update(saved)


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    # 不进 `with`：那会触发 lifespan，而 lifespan 会去构造真的 EmbeddingService。
    # 本批测试要的是路由层，state 由 `store` fixture 直接设定。
    return TestClient(main_module.app)


@pytest.fixture
def auth():
    return {"Authorization": f"Bearer {main_module.settings.service_token}"}
