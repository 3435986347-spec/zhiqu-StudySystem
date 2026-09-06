"""`app/main.py` 的特征测试 —— 1B-2 动它之前的基线。

在此之前 main.py 是**零覆盖**的，而 1B-2 要改的 pydantic 契约（sourceId → unitId）、
错误映射、delete scope 白名单全在这个文件里。没有基线就没有「改动是否越界」的判据。

本文件声称钉住 7 条性质，每条各配一次扰动（见文件末尾的扰动记录）：

  P1 鉴权：缺失/错误 token 一律 401
  P2 两种 409 可被机器区分（INDEX_VERSION_MISMATCH / STALE_MUTATION），且都在 detail.code
  P3 ValueError → 400（不是 500）
  P4 delete 的 scope 白名单拒绝未知取值 → 400
  P5 payload 交给 store 时的序列化口径：delete 排除 None 字段，index/query 不排除
  P6 契约校验失败 → 422，且 detail 是逐字段的 list
  P7 超大请求 → 413，且**不进入路由**

P5 与 P6 是这批里最容易被忽略、却正是 pydantic 被钉版本的原因：
`vector_store._delete_locked` 用 `payload.get(field) is None` 判断必填字段是否缺失
（vector_store.py:137），而 main.py 传的是 `model_dump(exclude_none=True)`
（main.py:155）—— 若哪天 exclude_none 的语义或默认值变了，DeleteRequest 的可选字段
会带着 None 进去，`missing` 判断照旧正确，但 `_delete_fence_keys` 会拿 None 去做
`int(None)` 而炸。同理 P6：Java 侧的 RagClient 解析的是 detail 的**形状**，
422 的 detail 从 list 变成别的结构会让跨语言错误处理静默失配。
"""

import pytest

from app.vector_store import StaleMutationError


# ── Stage D 改了这三个载荷（1B-2 的语义变更，不是重构）────────────────────
# IndexRequest / QueryRequest：notebookId+sourceId → namespace+unitId(+scopeId)。
# DeleteRequest：**不动** —— LEGACY 方言要留到 runbook 第 11 步旧代次 PURGED，
# 期间旧 collection 里的向量只带 sourceId/notebookId，只有它定位得到。

INDEX_BODY = {
    "operationId": "op-1", "mutationToken": 7, "userId": 1,
    "namespace": "NOTEBOOK_SOURCE", "unitId": 31, "scopeId": 2,
    "contentHash": "hash-1", "indexVersion": "test-index-version-v1",
    "collectionName": "zhiqu_test", "batchNo": 0, "finalBatch": True,
    "chunks": [{"chunkId": 10, "chunkIndex": 0, "content": "正文"}],
}

QUERY_BODY = {
    "requestId": "req-1", "userId": 1, "namespaces": ["NOTEBOOK_SOURCE"], "unitIds": [31],
    "question": "问题", "indexVersion": "test-index-version-v1", "collectionName": "zhiqu_test",
}

DELETE_BODY = {
    "operationId": "op-2", "mutationToken": 8, "scope": "SOURCE",
    "userId": 1, "notebookId": 2, "sourceId": 3,
}

# 每个 scope 的最小合法载荷。用它替代此前「一个 DELETE_BODY 塞满所有字段」的写法 ——
# 那种写法下，某个 scope 少声明一个必填字段也测不出来，因为载荷里恰好什么都有。
DELETE_BODIES: dict[str, dict] = {
    "UNIT": {"userId": 1, "unitId": 31},
    "SCOPE": {"userId": 1, "namespace": "NOTEBOOK_SOURCE", "scopeId": 2},
    "NAMESPACE": {"userId": 1, "namespace": "WIKI_PAGE"},
    "SOURCE": {"userId": 1, "notebookId": 2, "sourceId": 3},
    "NOTEBOOK": {"userId": 1, "notebookId": 2},
    "USER": {"userId": 1},
    "INDEX_VERSION": {"indexVersion": "test-index-version-v1"},
    "COLLECTION": {"collectionName": "zhiqu_test"},
}


# ── P1 鉴权 ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("method,path,body", [
    ("get", "/health/live", None),
    ("get", "/health/ready", None),
    ("get", "/v1/meta", None),
    ("post", "/v1/index/sources", INDEX_BODY),
    ("post", "/v1/query", QUERY_BODY),
    ("post", "/v1/index/delete", DELETE_BODY),
])
def test_每个端点都要求正确的_bearer_token(client, store, method, path, body):
    """P1：六个端点无一例外。逐个列出而不是抽样 —— 漏掉一个就是一个无鉴权的洞，
    而这类洞恰恰不会在任何功能用例里冒出来。"""
    kwargs = {"json": body} if body is not None else {}

    assert getattr(client, method)(path, **kwargs).status_code == 401, "缺 Authorization 头必须 401"
    assert getattr(client, method)(
        path, headers={"Authorization": "Bearer wrong-token"}, **kwargs
    ).status_code == 401, "token 不匹配必须 401"


def test_鉴权发生在契约校验之前(client, store):
    """错误 token + 非法请求体 → 401 而不是 422。

    顺序是可观察的行为，而且方向重要：若先校验请求体，未鉴权的调用方就能靠
    422/200 的差异探测出哪些字段存在、哪些取值合法。
    """
    response = client.post("/v1/index/sources",
                           headers={"Authorization": "Bearer wrong-token"},
                           json={"garbage": True})
    assert response.status_code == 401


# ── P2 两种 409 ──────────────────────────────────────────────────────────

def test_索引版本错配是可被机器识别的_409(client, store, auth):
    """P2 上半：配置错配。Java 侧 RagStaleMutationTest 断言它**不是**陈旧写入，
    靠的就是这个 code —— 少了它只能去 match 人类可读文案。"""
    body = dict(INDEX_BODY, indexVersion="some-other-version")
    response = client.post("/v1/index/sources", headers=auth, json=body)

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "INDEX_VERSION_MISMATCH"
    assert "some-other-version" in detail["message"]


def test_陈旧写入是另一种_409(client, store, auth):
    """P2 下半：墓碑拒绝。同为 409，但调用方必须把作业转终态而非重试。"""
    store.raise_on_next = StaleMutationError("tombstone rejects mutationToken 7")
    response = client.post("/v1/index/sources", headers=auth, json=INDEX_BODY)

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "STALE_MUTATION"


def test_两种_409_的_code_互不相同(client, store, auth):
    """把 P2 的「可区分」这半单独钉住。

    上面两条各自断言了一个 code 的取值，但「两者不同」是它们**合起来**才有的性质——
    若有人把两处 code 改成同一个字面量，上面两条会各自变红，而这条说明为什么它重要：
    调用方只有这一个字段可依赖。
    """
    version_mismatch = client.post("/v1/index/sources", headers=auth,
                                   json=dict(INDEX_BODY, indexVersion="other")).json()["detail"]
    store.raise_on_next = StaleMutationError("stale")
    stale = client.post("/v1/index/sources", headers=auth, json=INDEX_BODY).json()["detail"]

    assert version_mismatch["code"] != stale["code"]


def test_删除路径也做同样的_409_分流(client, store, auth):
    """删除是双删方言的落点，分流错了会让 LEGACY/UNIT 两条里的一条静默进重试链。"""
    store.raise_on_next = StaleMutationError("stale delete")
    response = client.post("/v1/index/delete", headers=auth, json=DELETE_BODY)

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "STALE_MUTATION"


# ── P3 ValueError → 400 ──────────────────────────────────────────────────

@pytest.mark.parametrize("path,body", [
    ("/v1/index/sources", INDEX_BODY),
    ("/v1/index/delete", DELETE_BODY),
])
def test_store_抛_ValueError_映射成_400_而不是_500(client, store, auth, path, body):
    """P3：`ValueError` 是 VectorStore 对「请求本身不合法」的表达（批次过大、
    缺必填标识、集合名非法）。漏掉这层映射会让它变成 500，而 500 在 Java 侧
    走的是重试链 —— 一个永远不会成功的请求会被重试到 DEAD。"""
    store.raise_on_next = ValueError("Too many parent chunks in one batch")
    response = client.post(path, headers=auth, json=body)

    assert response.status_code == 400
    assert "Too many parent chunks" in response.json()["detail"]


def test_StaleMutationError_是_ValueError_的子类但必须先被匹配(client, store, auth):
    """这条不是多余的：`StaleMutationError(ValueError)`（vector_store.py:21），
    所以 except 的**顺序**是载荷性的。顺序反了 → 陈旧写入被当成 400 →
    Java 侧不再转 SUPERSEDED 而走失败重试 → RETRY → DEAD → 整个代次 FAILED。
    """
    assert issubclass(StaleMutationError, ValueError), "前提变了的话本条的理由也就没了"

    store.raise_on_next = StaleMutationError("tombstone")
    response = client.post("/v1/index/sources", headers=auth, json=INDEX_BODY)

    assert response.status_code == 409, "被 400 分支抢走就说明 except 顺序反了"


# ── P4 delete scope 白名单 ───────────────────────────────────────────────

def test_未知的_delete_scope_被拒(client, store, auth):
    """P4：白名单在 main.py:152 与 vector_store.py:128 各写了一份（字面量副本）。
    1B-2 会把它收敛成 vector_store 导出的单一定义，本条是收敛前后都必须成立的行为。"""
    response = client.post("/v1/index/delete", headers=auth,
                           json=dict(DELETE_BODY, scope="EVERYTHING"))

    assert response.status_code == 400
    assert response.json()["detail"] == "Unsupported delete scope"
    assert store.calls == [], "非法 scope 不得进入 VectorStore"


@pytest.mark.parametrize("scope", sorted(DELETE_BODIES))
def test_每个合法_scope_带最小载荷都放行(client, store, auth, scope):
    """反面：只测「拒绝未知」会被「全部拒绝」的实现骗过。

    Stage D 从 5 个 scope 扩到 8 个（新增 UNIT/SCOPE/NAMESPACE，LEGACY 的
    SOURCE/NOTEBOOK 保留）。载荷改成**每个 scope 的最小合法集合** —— 此前是
    一个塞满所有字段的 DELETE_BODY，那种写法下某个 scope 少声明一个必填字段
    也测不出来，因为载荷里恰好什么都有。
    """
    body = dict(DELETE_BODIES[scope], operationId=f"op-{scope}", mutationToken=8, scope=scope)
    response = client.post("/v1/index/delete", headers=auth, json=body)

    assert response.status_code == 200
    assert store.last_payload("delete")["scope"] == scope


def test_两种方言的_scope_同时存在(client, store, auth):
    """双删要求 UNIT 与 LEGACY 两族并存，直到 runbook 第 11 步旧代次 PURGED。

    单独钉住是因为「删掉 LEGACY」是一个看起来很自然的清理动作 ——
    而它的后果是双删的 LEGACY 那一半拿 400 → Java 走 handleFailure → 重试 → DEAD，
    且用户以为删掉的内容还留在旧代次的 collection 里。
    """
    from app import vector_store

    assert {"UNIT", "SCOPE", "NAMESPACE"} <= vector_store.DELETE_SCOPES, "UNIT 方言"
    assert {"SOURCE", "NOTEBOOK"} <= vector_store.DELETE_SCOPES, \
        "LEGACY 方言不能提前删 —— 关闭时机由 cutover runbook 第 11 步决定"


@pytest.mark.parametrize("bad", ["notebook_source", "WIKI", "", "NOTEBOOKSOURCE"])
def test_未知的_namespace_在边界就被拒(client, store, auth, bad):
    """拼错 namespace 的失效形态很静默：不报错，只在 fence key 与 metadata 里
    各开一个谁也匹配不到的分区 —— 删除删不到、检索也检索不到，每一层都显示成功。
    所以必须在唯一入口拦住，而不是等它写进向量库。"""
    response = client.post("/v1/index/sources", headers=auth,
                           json=dict(INDEX_BODY, namespace=bad))

    assert response.status_code == 422
    assert store.calls == []


def test_namespace_取值域只有一份定义(client, store, auth, monkeypatch):
    """与 DELETE_SCOPES 同形的「身份 + 行为」配对。

    B2/B4 的教训：只断言「main.py 里那个名字指向同一个对象」覆盖不了
    「做校验的地方用不用它」—— 一个没人用的 import 就能满足前者。
    所以这里收窄共享集合，再看边界是否跟着变严。
    """
    from app import main as main_module
    from app import vector_store

    assert main_module.NAMESPACES is vector_store.NAMESPACES

    monkeypatch.setattr(main_module, "NAMESPACES", frozenset({"WIKI_PAGE"}))
    response = client.post("/v1/index/sources", headers=auth,
                           json=dict(INDEX_BODY, namespace="NOTEBOOK_SOURCE"))

    assert response.status_code == 422, "校验没有读那份共享定义"


def test_scope_白名单只有一份定义():
    """收敛的结构断言：名字指向 vector_store 的那个对象，且派生方向正确。

    **这条单独不够，必须和下面那条一起读** —— 它只覆盖「main.py 里那个名字是什么」，
    覆盖不了「做判断的地方用不用它」。实测扰动证过：把调用点改成内联字面量、
    保留模块顶部的 import，本条照旧全绿。判据的定义域比要报的性质窄。

    派生方向也钉住：键集来自 required_fields，不是反过来。反过来的话，新增 scope 时
    漏改字段表的表现是「scope 合法但字段校验放行空值」，None 一路走到
    `_delete_fence_keys` 的 int(...) 才炸成 500 —— 而 500 在 Java 侧走重试链，
    一个永远不会成功的请求会被重试到 DEAD。
    """
    from app import main as main_module
    from app import vector_store

    assert main_module.DELETE_SCOPES is vector_store.DELETE_SCOPES, \
        "main.py 必须 import 同一个对象，而不是持有一份等价的副本"
    assert set(vector_store.DELETE_SCOPE_REQUIRED_FIELDS) == vector_store.DELETE_SCOPES
    assert all(fields for fields in vector_store.DELETE_SCOPE_REQUIRED_FIELDS.values()), \
        "每个 scope 都必须声明至少一个必填字段，否则字段校验对它是空操作"


def test_删除端点的判断真的读那份定义(client, store, auth, monkeypatch):
    """上一条的另一半：**行为**证明调用点用的就是那个名字。

    做法是把 `main.DELETE_SCOPES` 换成一个变窄的集合，再看端点是否跟着变严。
    - 调用点写 `not in DELETE_SCOPES`（读模块全局）→ 跟着变，NOTEBOOK 被 400；
    - 调用点内联了字面量 → 不跟着变，NOTEBOOK 仍 200 → 本条红。

    两条合起来才覆盖完整：上一条挡「另起一个同名副本」，本条挡「import 了但不用」。
    单写任何一条都会留下一个它看不见的抄法。
    """
    from app import main as main_module

    monkeypatch.setattr(main_module, "DELETE_SCOPES",
                        frozenset(main_module.DELETE_SCOPES - {"NOTEBOOK"}))
    response = client.post("/v1/index/delete", headers=auth,
                           json=dict(DELETE_BODY, scope="NOTEBOOK"))

    assert response.status_code == 400, "判断没有读那份定义 —— 多半是调用点内联了字面量"
    assert store.calls == []


# ── P5 序列化口径 ────────────────────────────────────────────────────────

def test_delete_排除_None_字段(client, store, auth):
    """P5 上半：`model_dump(exclude_none=True)`（main.py:155）。

    `_delete_locked` 靠 `payload.get(field) is None` 判缺失（vector_store.py:137），
    而 `_delete_fence_keys` 随后会对同一批字段做 `int(...)`（:211）——
    None 混进去时前者判断照旧「不缺」，后者 `int(None)` 抛 TypeError，
    表现为 500 而不是 400。这条口径是跨文件的隐式契约，必须钉死。
    """
    client.post("/v1/index/delete", headers=auth,
                json={"operationId": "op-3", "mutationToken": 9, "scope": "USER", "userId": 1})
    payload = store.last_payload("delete")

    assert payload["userId"] == 1
    for absent in ("notebookId", "sourceId", "indexVersion", "collectionName"):
        assert absent not in payload, f"{absent} 未提供时不得以 None 出现在 payload 里"


@pytest.mark.parametrize("path,body,name", [
    ("/v1/index/sources", INDEX_BODY, "index_source"),
    ("/v1/query", QUERY_BODY, "query"),
])
def test_index_与_query_原样透传全部字段(client, store, auth, path, body, name):
    """P5 下半：这两条走的是不带 exclude_none 的 `model_dump()`（main.py:133/147）。
    两种口径并存本身是风险点，先把「当前谁是谁」钉住。"""
    client.post(path, headers=auth, json=body)
    payload = store.last_payload(name)

    for key in body:
        assert key in payload, f"{key} 应当原样透传给 VectorStore"


def test_query_的_candidateK_有默认值且透传(client, store, auth):
    """`candidateK` 是 QueryRequest 里唯一带默认值的字段（main.py:38）。
    请求不带它时必须以 24 出现在 payload 里 —— 而不是缺席后由 VectorStore
    再兜一次底（vector_store.py:99 确实兜了，两处默认值一旦漂开就没人发现）。"""
    body = {k: v for k, v in QUERY_BODY.items()}
    client.post("/v1/query", headers=auth, json=body)

    assert store.last_payload("query")["candidateK"] == 24


# ── P6 契约校验失败 ──────────────────────────────────────────────────────

def test_缺字段返回_422_且_detail_是逐字段的列表(client, store, auth):
    """P6：pydantic 的校验失败形状。被钉版本的直接原因就是这个。

    断言的是**结构**不是文案：`detail` 是 list，每项含 `loc`/`type`。
    Java 侧靠它区分「请求写错了」与「服务端故障」，形状变了会静默失配。
    """
    response = client.post("/v1/index/sources", headers=auth,
                           json={k: v for k, v in INDEX_BODY.items() if k != "unitId"})

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert isinstance(detail, list) and detail, "detail 必须是非空的逐字段列表"
    assert any("unitId" in tuple(item["loc"]) for item in detail)
    assert all("type" in item for item in detail)


@pytest.mark.parametrize("field,bad,why", [
    ("mutationToken", 0, "gt=0"),
    ("batchNo", -1, "ge=0"),
])
def test_数值约束真的生效(client, store, auth, field, bad, why):
    """三个 Field 约束里有两个是数值边界（main.py:21/28）。
    `mutationToken` 尤其载荷性：它是栅栏的比较对象，0 会让 `highest_fence` 比较失去意义。"""
    response = client.post("/v1/index/sources", headers=auth, json=dict(INDEX_BODY, **{field: bad}))

    assert response.status_code == 422, f"{field} 的 {why} 约束应当拒绝 {bad}"
    assert store.calls == []


def test_空正文的父块被拒(client, store, auth):
    """第三个约束：`content: str = Field(min_length=1)`（main.py:16）。
    空正文会切出零个 segment，静默产生一个「索引成功但什么都没写」的批次。"""
    body = dict(INDEX_BODY, chunks=[{"chunkId": 10, "chunkIndex": 0, "content": ""}])
    response = client.post("/v1/index/sources", headers=auth, json=body)

    assert response.status_code == 422


# ── P7 请求体大小 ────────────────────────────────────────────────────────

def test_超大请求在进入路由之前就被拒(client, store, auth):
    """P7：中间件按 Content-Length 拦（main.py:74-78）。

    两半都要断言：状态码是 413，**且 store 没有被调用**。只断言 413 的话，
    一个「先解析完整个请求体再判大小」的实现也会绿 —— 而那正是这个中间件
    想避免的（大 body 已经被读进内存了，拦得再准也没省下什么）。
    """
    payload = dict(INDEX_BODY)
    payload["chunks"] = [{"chunkId": 1, "chunkIndex": 0, "content": "x" * 6 * 1024 * 1024}]
    response = client.post("/v1/index/sources", headers=auth, json=payload)

    assert response.status_code == 413
    assert response.json()["detail"] == "Request body is too large"
    assert store.calls == []


# ── 就绪状态 ─────────────────────────────────────────────────────────────

def test_未就绪时业务端点返回_503_并带上原因(client, auth):
    """没有 `store` fixture —— 保持 main.state 的初始值 ready=False。
    503 与 401/422 分处不同区间，Java 侧据此决定「重试」还是「上报配置错误」。"""
    from app import main as main_module
    main_module.state.update(ready=False, error="模型未加载", store=None)

    response = client.post("/v1/query", headers=auth, json=QUERY_BODY)

    assert response.status_code == 503
    assert response.json()["detail"] == "模型未加载"


def test_meta_暴露版本与就绪状态(client, store, auth):
    """cutover runbook 第 6 步的判据来源：`ready:true` 且 indexVersion 为新值。
    字段名是 runbook 直接引用的，改名会让那一步静默失去判据。"""
    body = client.get("/v1/meta", headers=auth).json()

    for key in ("ready", "error", "modelPath", "modelRevision", "dimension",
                "indexVersion", "metric", "collections"):
        assert key in body, f"/v1/meta 缺少 {key}"
    assert body["ready"] is True
    assert body["metric"] == "cosine"


# ── 扰动记录（2026-08-08 实测）─────────────────────────────────────────────
#
# 声称 7 条性质，施加 8 次扰动（P3 拆成「映射成 400」与「except 顺序」两条，
# 因为 StaleMutationError 是 ValueError 的子类，顺序是独立于映射的第二条性质）。
# 基线 31 passed；每次扰动只动 app/main.py 的一处；全部还原后复验仍 31 passed。
#
#   扰动                                    结果   变红的用例
#   ─────────────────────────────────────────────────────────────────────────
#   P1  authorize 恒真                       RED   bearer_token(6 参数化) + 鉴权顺序
#   P2  两处 409 用同一个 code                RED   索引版本错配 + code 互不相同
#   P3  ValueError 映射改成 500               RED   ValueError_映射成_400
#   P3b except 顺序对调                       RED   子类顺序 + 陈旧写入 + code 互不相同
#   P4  白名单里删掉 NOTEBOOK                  RED   五个合法_scope_都放行
#   P5  delete 去掉 exclude_none              RED   delete_排除_None_字段
#   P6  sourceId 改成可选带默认值               RED   缺字段返回_422
#   P7  max_request_bytes 放大 100 倍          RED   超大请求在进入路由之前就被拒
#
# 八次全部决定性变红，且失败集合与预期一致（无 GREEN、无 RED-WRONG、无 INFRA-FAIL）。
# P3b 连带打红「code 互不相同」是预期内的耦合：顺序反了之后陈旧写入返回 400，
# detail 退化成字符串，那条用例取 ["code"] 时抛 TypeError —— 记在这里免得下次
# 被当成扰动打偏。
#
# ── Stage B（scope 白名单收敛）的扰动 ─────────────────────────────────────
#
#   扰动                                        结果   变红的用例
#   ─────────────────────────────────────────────────────────────────────────
#   B1  vector_store 里删掉 NOTEBOOK 一行         RED   五个合法_scope_都放行
#   B2  main.py 调用点内联一份等价字面量            RED   删除端点的判断真的读那份定义
#   B3  加一个必填字段为空元组的 scope              RED   白名单只有一份定义 + 未知scope被拒
#   B4  把局部 dict 加回 _delete_locked           RED   字段校验真的读那份共享表
#                                                       （在 test_vector_store_contract.py）
#
# **B2 第一次跑是 GREEN 的，是这批里最值得记的一条。**
# 当时只有 `main.DELETE_SCOPES is vector_store.DELETE_SCOPES` 这一条身份断言。
# 扰动改的是**调用点**，而模块顶部的 import 原封不动 —— 于是 `is` 照旧成立，
# 真正做判断的却已经是一份副本。判据的定义域是「这个名字指向同一个对象」，
# 要报的性质是「做判断的地方用的是那个定义」，前者严格窄于后者：
# 一个没人用的 import 就能满足它。
# 修法不是加断言，是补一条**行为**判据（monkeypatch 收窄 main.DELETE_SCOPES，
# 看端点是否跟着变严）。两条合起来才闭合：身份那条挡「另起一个同名副本」，
# 行为那条挡「import 了但不用」，单写任何一条都留着一个它看不见的抄法。
#
# 顺带记一条方法上的结论：**这里不能用源码扫描去找字面量副本**
# （方案 §10 第 3b 条已经论证过：改个变量名就绕过任何特征匹配）。
# B2 的正确判据是行为，不是文本。
#
# B4 是 B2 的推论，补的时候差点漏掉：「身份 + 行为」这一对当时只配给了
# `DELETE_SCOPES`（名字集合），而**带信息、失效形态静默的是
# `DELETE_SCOPE_REQUIRED_FIELDS`**。B1/B2/B3 三条对「有人把局部 dict 加回
# `_delete_locked`」全部无感 —— 那正好是收敛前它待着的地方。
# 规律：一处消除若同时收敛了「名字」与「内容」两份知识，两份都要各配一对判据；
# 只给显眼的那份配，留下的洞恰好在失效更静默的那份上。
