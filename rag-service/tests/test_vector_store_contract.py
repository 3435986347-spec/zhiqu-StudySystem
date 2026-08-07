import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from app import vector_store as vector_store_module
from app.operation_store import OperationStore
from app.segmenter import segment_text
from app.vector_store import StaleMutationError, VectorStore


class CharacterTokenizer:
    def __call__(self, text, **_):
        return {"offset_mapping": [(index, index + 1) for index in range(len(text))]}


class FakeEmbedding:
    tokenizer = CharacterTokenizer()

    def encode_passages(self, texts):
        return [[float(len(text)), 1.0] for text in texts]

    def encode_query(self, _question):
        return [1.0, 1.0]


class FakeCollection:
    def __init__(self):
        self.rows = {}
        self.last_where = None

    def upsert(self, ids, embeddings, metadatas):
        for item_id, embedding, metadata in zip(ids, embeddings, metadatas):
            self.rows[item_id] = (embedding, metadata)

    def get(self, where=None, include=None):
        ids = [item_id for item_id, (_, meta) in self.rows.items()
               if where is None or self._matches(meta, where)]
        return {"ids": ids}

    def _matches(self, metadata, where):
        if "$and" in where:
            return all(self._matches(metadata, condition) for condition in where["$and"])
        for field, expression in where.items():
            if not isinstance(expression, dict):
                if metadata.get(field) != expression:
                    return False
                continue
            if "$eq" in expression and metadata.get(field) != expression["$eq"]:
                return False
            if "$in" in expression and metadata.get(field) not in expression["$in"]:
                return False
        return True

    def delete(self, ids):
        for item_id in ids:
            self.rows.pop(item_id, None)

    def query(self, query_embeddings, n_results, where, include):
        self.last_where = where
        ids = list(self.rows)[:n_results]
        metadata = [self.rows[item][1] for item in ids]
        return {"ids": [ids], "metadatas": [metadata], "distances": [[0.1] * len(ids)]}

    def count(self):
        return len(self.rows)


class FakeClient:
    def __init__(self, collection):
        self.collection = collection
        self.deleted = False

    def delete_collection(self, _name):
        self.collection.rows.clear()
        self.deleted = True


def make_store(tmp_path):
    store = object.__new__(VectorStore)
    store.settings = SimpleNamespace(max_batch_parent_chunks=16, segment_tokens=8, segment_overlap=2, max_candidate_k=32)
    store.embedding = FakeEmbedding()
    store.operations = OperationStore(tmp_path / "operations.sqlite3")
    store._mutation_lock = threading.RLock()
    store.collection = FakeCollection()
    store.client = FakeClient(store.collection)
    store._collection = lambda _name, create=True: store.collection
    store.collection_names = lambda: [] if store.client.deleted else ["test_collection"]
    return store


def index_payload(**overrides):
    """UNIT 方言的索引载荷。Stage D 之后的写入路径只有这一种形状。

    抽成一处的理由和 DELETE_SCOPE_REQUIRED_FIELDS 一样：契约再改一次时，
    要改的地方是一个，而不是散在七个用例里等人一个个找。
    """
    payload = {
        "operationId": "op", "mutationToken": 10, "batchNo": 0, "finalBatch": True,
        "userId": 1, "namespace": "NOTEBOOK_SOURCE", "unitId": 31, "scopeId": 2,
        "contentHash": "abc", "indexVersion": "version-1", "collectionName": "test_collection",
        "chunks": [{"chunkId": 4, "chunkIndex": 0, "content": "一二三四五六七八九十"}],
    }
    payload.update(overrides)
    return payload


def seed_legacy_rows(store, *, user_id, notebook_id, source_id, count=2):
    """直接塞入 LEGACY 形状的向量行，绕过 index_source。

    这不是为了图省事 —— Stage D 之后 `index_source` **再也产不出**带
    sourceId/notebookId 的元数据，而旧代次 collection 里的行正是那个形状（它们是
    旧 JAR 写的）。要验 LEGACY 删除仍然有效，只能照实构造那批行。
    """
    for index in range(count):
        store.collection.rows[f"legacy:{source_id}:{index}"] = ([0.0, 0.0], {
            "userId": user_id, "notebookId": notebook_id, "sourceId": source_id,
            "chunkId": index, "chunkIndex": index, "segmentIndex": 0,
            "charStart": 0, "charEnd": 1,
            "contentHash": "legacy", "indexVersion": "version-0",
        })


def test_ingest_is_idempotent_and_keeps_no_document_text(tmp_path):
    store = make_store(tmp_path)
    payload = index_payload(operationId="op-1")
    first = store.index_source(payload)
    second = store.index_source(payload)
    assert first["written"] == len(segment_text(payload["chunks"][0]["content"], store.embedding.tokenizer, 8, 2))
    assert second == {"written": first["written"], "skipped": True, "contentHash": "abc", "indexVersion": "version-1"}
    assert all("document" not in metadata and "content" not in metadata for _, metadata in store.collection.rows.values())


def test_query_contract_forces_user_namespace_version_and_unit_scope(tmp_path):
    """Stage D 的语义变更：检索的收窄口径从 notebook+source 换成 namespace+unit。

    四条 $and 一条不少 —— 少任何一条都会让检索越过它的作用域，而越界的表现是
    「查到了别人的/别的 Notebook 的内容」，不是报错。
    """
    store = make_store(tmp_path)
    store.index_source(index_payload(
        operationId="op-2", mutationToken=20, userId=7, unitId=9, scopeId=8,
        indexVersion="version-2",
        chunks=[{"chunkId": 10, "chunkIndex": 0, "content": "测试资料"}]))

    result = store.query({
        "requestId": "request", "userId": 7, "namespaces": ["NOTEBOOK_SOURCE"],
        "unitIds": [9], "question": "测试", "candidateK": 24,
        "indexVersion": "version-2", "collectionName": "test_collection",
    })

    conditions = store.collection.last_where["$and"]
    assert {"userId": {"$eq": 7}} in conditions
    assert {"namespace": {"$in": ["NOTEBOOK_SOURCE"]}} in conditions
    assert {"indexVersion": {"$eq": "version-2"}} in conditions
    assert {"unitId": {"$in": [9]}} in conditions
    assert result["candidates"][0]["unitId"] == 9
    assert result["candidates"][0]["namespace"] == "NOTEBOOK_SOURCE"


def test_final_empty_batch_removes_stale_vectors(tmp_path):
    """`_finalize_source` 的扫删条件必须跟着 metadata 改键一起改。

    **这条是 Stage D 里最容易被漏掉的耦合**：Chroma 对不存在的 metadata 键不报错，
    只是匹配为空 —— 于是 stale 为空 → 不删 → finish_operation 照常 → 批次成功 →
    Java 侧看到成功。每一层都正常，而过期向量继续参与检索命中。
    扫描条件若还写 sourceId，本条会红；这是它存在的主要理由。
    """
    store = make_store(tmp_path)
    store.index_source(index_payload(
        operationId="op-old", mutationToken=30, contentHash="old",
        chunks=[{"chunkId": 4, "chunkIndex": 0, "content": "old content"}]))
    assert store.collection.rows

    store.index_source(index_payload(
        operationId="op-empty", mutationToken=31, contentHash="empty", chunks=[]))

    assert not store.collection.rows


def test_finalize_cannot_delete_other_namespace_vectors(tmp_path):
    """扫删不得越过命名空间 —— 计划里点名的那条。

    构造的正是 V29 注释写下的那个场景：**资料 7 与 Wiki 页 7 在向量库里必须是
    两个东西**。1B-2 把它们放进同一个 collection，所以这条从「不可达」变成
    「可达且必须被挡住」。

    注意反面也要断言：只验「别的命名空间没被删」会被一个「什么都不删」的实现骗过 ——
    而那恰好就是扫描条件写错时的行为。所以同时断言本命名空间的过期向量**确实被删了**。
    """
    store = make_store(tmp_path)
    # 同一个 unitId 在两个命名空间下 —— 代理主键全局唯一的前提若被破坏就是这个形状
    store.collection.rows["wiki:7:0"] = ([0.0, 0.0], {
        "userId": 1, "namespace": "WIKI_PAGE", "unitId": 77, "chunkId": 0,
        "chunkIndex": 0, "segmentIndex": 0, "charStart": 0, "charEnd": 1,
        "contentHash": "wiki", "indexVersion": "version-1",
    })
    store.index_source(index_payload(
        operationId="ns-old", mutationToken=40, unitId=77, namespace="NOTEBOOK_SOURCE",
        chunks=[{"chunkId": 4, "chunkIndex": 0, "content": "notebook content"}]))
    assert len(store.collection.rows) > 1

    # 同一 unit 的空批次：本命名空间的向量应当被清空
    store.index_source(index_payload(
        operationId="ns-empty", mutationToken=41, unitId=77, namespace="NOTEBOOK_SOURCE",
        contentHash="empty", chunks=[]))

    remaining = {meta["namespace"] for _, meta in store.collection.rows.values()}
    assert remaining == {"WIKI_PAGE"}, "扫删跨了命名空间 —— 别人的向量被删掉了"
    assert "wiki:7:0" in store.collection.rows


def test_delete_scope_requires_its_full_identifier_set(tmp_path):
    store = make_store(tmp_path)
    invalid_requests = [
        {"operationId": "d1", "mutationToken": 40, "scope": "SOURCE", "userId": 1, "notebookId": 2},
        {"operationId": "d2", "mutationToken": 41, "scope": "NOTEBOOK", "userId": 1},
        {"operationId": "d3", "mutationToken": 42, "scope": "USER"},
        {"operationId": "d4", "mutationToken": 43, "scope": "INDEX_VERSION"},
        {"operationId": "d5", "mutationToken": 44, "scope": "COLLECTION"},
    ]
    for request in invalid_requests:
        try:
            store.delete(request)
        except ValueError:
            continue
        raise AssertionError(f"Delete request unexpectedly widened its scope: {request}")


def test_字段校验真的读那份共享表(tmp_path, monkeypatch):
    """`DELETE_SCOPE_REQUIRED_FIELDS` 的行为判据 —— 与 main.py 那对判据同形。

    `DELETE_SCOPES`（名字集合）已经配了「身份 + 行为」两条：身份那条挡「另起一个
    同名副本」，行为那条挡「import 了但不用」。**带信息的那份表当时只有身份侧**，
    也就是 `test_scope_白名单只有一份定义` 里的派生断言，以及「空必填字段表会被
    发现」——两条都覆盖不了「字段校验读的是不是这张表」。

    缺口是具体的：若有人把局部 dict 加回 `_delete_locked`（收敛前它就在那里），
    上面所有断言全绿，而这张共享表对字段校验不再有任何影响。

    两种失效形态不对称，正是本条必须存在的理由：
    - 漏改名字集合 → 合法请求被 400 拒掉，响亮。
    - 漏改字段表   → scope 过白名单、空值放行 → `_delete_fence_keys` 的 int(None)
                     → 500 → Java 侧走重试链 → 一个永不成功的请求被重试到 DEAD。

    做法：给 USER 加一个它本来不需要的必填字段，此前能过的载荷必须开始被拒。
    """
    store = make_store(tmp_path)
    baseline = {"operationId": "d6", "mutationToken": 45, "scope": "USER", "userId": 1}
    store.delete(dict(baseline))  # 基线：当前 USER 只要求 userId

    monkeypatch.setitem(vector_store_module.DELETE_SCOPE_REQUIRED_FIELDS,
                        "USER", ("userId", "notebookId"))

    try:
        store.delete({"operationId": "d7", "mutationToken": 46, "scope": "USER", "userId": 1})
    except ValueError as error:
        assert "notebookId" in str(error)
    else:
        raise AssertionError("字段校验没有读那份共享表 —— 多半是局部 dict 又被加回来了")


def test_unit_delete_cannot_remove_sibling_unit(tmp_path):
    """UNIT 方言：删一个 unit 不得波及同 scope 的兄弟 unit。"""
    store = make_store(tmp_path)
    for unit_id in (31, 32):
        store.index_source(index_payload(
            operationId=f"unit-{unit_id}", mutationToken=50 + unit_id, unitId=unit_id,
            contentHash=f"hash-{unit_id}",
            chunks=[{"chunkId": unit_id, "chunkIndex": 0, "content": f"unit {unit_id}"}]))

    store.delete({"operationId": "delete-unit-31", "mutationToken": 60,
                  "scope": "UNIT", "userId": 1, "unitId": 31})

    assert {meta["unitId"] for _, meta in store.collection.rows.values()} == {32}


def test_scope_delete_only_removes_its_own_scope(tmp_path):
    """SCOPE 方言：删 Notebook 5 不得波及 Notebook 6。

    这条覆盖的是方案 §5 里「删除 Notebook → SCOPE(u, NOTEBOOK_SOURCE, nbId)」那一行。
    """
    store = make_store(tmp_path)
    for unit_id, scope_id in ((31, 5), (32, 6)):
        store.index_source(index_payload(
            operationId=f"scope-{unit_id}", mutationToken=70 + unit_id,
            unitId=unit_id, scopeId=scope_id, contentHash=f"h{unit_id}",
            chunks=[{"chunkId": unit_id, "chunkIndex": 0, "content": f"unit {unit_id}"}]))

    store.delete({"operationId": "delete-scope-5", "mutationToken": 90, "scope": "SCOPE",
                  "userId": 1, "namespace": "NOTEBOOK_SOURCE", "scopeId": 5})

    assert {meta["scopeId"] for _, meta in store.collection.rows.values()} == {6}


def test_namespace_delete_only_removes_its_own_namespace(tmp_path):
    """NAMESPACE 方言：清空记忆 → NAMESPACE(u, CONVERSATION_TURN)，Wiki 与资料不受影响。"""
    store = make_store(tmp_path)
    for unit_id, namespace in ((31, "CONVERSATION_TURN"), (32, "WIKI_PAGE")):
        store.index_source(index_payload(
            operationId=f"ns-{unit_id}", mutationToken=100 + unit_id,
            unitId=unit_id, namespace=namespace, contentHash=f"h{unit_id}",
            chunks=[{"chunkId": unit_id, "chunkIndex": 0, "content": f"unit {unit_id}"}]))

    store.delete({"operationId": "delete-ns", "mutationToken": 120, "scope": "NAMESPACE",
                  "userId": 1, "namespace": "CONVERSATION_TURN"})

    assert {meta["namespace"] for _, meta in store.collection.rows.values()} == {"WIKI_PAGE"}


def test_legacy_dialect_still_deletes_old_generation_rows(tmp_path):
    """LEGACY 方言必须继续有效，直到 runbook 第 11 步旧代次 PURGED。

    行是直接塞的，因为 Stage D 之后 `index_source` **再也产不出**这个形状 ——
    旧代次里的行是旧 JAR 写的。这正是双删存在的理由：新写入靠 UNIT 半边删，
    旧代次靠 LEGACY 半边删，两半都得能工作。
    """
    store = make_store(tmp_path)
    seed_legacy_rows(store, user_id=1, notebook_id=2, source_id=3)
    seed_legacy_rows(store, user_id=1, notebook_id=2, source_id=4)

    store.delete({"operationId": "legacy-del", "mutationToken": 130, "scope": "SOURCE",
                  "userId": 1, "notebookId": 2, "sourceId": 3})

    assert {meta["sourceId"] for _, meta in store.collection.rows.values()} == {4}


@pytest.mark.parametrize("scope,extra", [
    ("UNIT", {"userId": 1, "unitId": 31}),
    ("SCOPE", {"userId": 1, "namespace": "NOTEBOOK_SOURCE", "scopeId": 2}),
    ("NAMESPACE", {"userId": 1, "namespace": "NOTEBOOK_SOURCE"}),
    ("USER", {"userId": 1}),
    ("INDEX_VERSION", {"indexVersion": "version-1"}),
    ("COLLECTION", {"collectionName": "test_collection"}),
])
def test_每种删除都能拦住迟到的索引(tmp_path, scope, extra):
    """fence key 族的核心不变量，逐个 scope 断言。

        **索引请求列出的 key 必须覆盖任何能删掉它的 delete 的 key。**

    少列一个 → 那种删除拦不住随后到达的迟到索引 → 用户以为删掉的向量复活，
    而这里没有任何东西会报错。这是「删除动作没发生」那一族的第五条形态，
    也是唯一一条靠代码结构看不出来的（key 是字符串拼的，两侧写法差一点就错开）。

    LEGACY 的 SOURCE/NOTEBOOK 不在参数表里，因为 Stage D 之后不存在 LEGACY 索引
    请求 —— 没有需要被它们拦住的对象。承重的是与之同时入队的 UNIT 半边。
    """
    store = make_store(tmp_path)
    late = index_payload(operationId="late", mutationToken=200, unitId=31, scopeId=2,
                         namespace="NOTEBOOK_SOURCE")

    store.delete(dict(extra, operationId=f"del-{scope}", mutationToken=300, scope=scope))

    with pytest.raises(StaleMutationError):
        store.index_source(late)
    assert not store.collection.rows, "迟到的索引不得写入任何向量"


def test_late_index_cannot_recreate_deleted_collection(tmp_path):
    store = make_store(tmp_path)
    old_payload = index_payload(operationId="old-collection-index", mutationToken=90,
                                contentHash="old",
                                chunks=[{"chunkId": 4, "chunkIndex": 0,
                                         "content": "late private content"}])

    store.delete({
        "operationId": "delete-collection", "mutationToken": 100,
        "scope": "COLLECTION", "collectionName": "test_collection",
    })

    with pytest.raises(StaleMutationError):
        store.index_source(old_payload)
    assert store.client.deleted
    assert not store.collection.rows


def test_scopeId_为空时不写进_metadata(tmp_path):
    """Chroma 的 metadata 不接受 None，所以缺省时整个键不写。

    反面一并断言：非空时必须写进去 —— 否则一个「永远不写 scopeId」的实现也能绿，
    而那会让 SCOPE 删除一条也匹配不到（又一次「删除动作没发生」）。
    """
    store = make_store(tmp_path)
    store.index_source(index_payload(operationId="no-scope", mutationToken=400,
                                     namespace="WIKI_PAGE", unitId=41, scopeId=None))
    assert all("scopeId" not in meta for _, meta in store.collection.rows.values())

    store.index_source(index_payload(operationId="with-scope", mutationToken=401,
                                     namespace="WIKI_PAGE", unitId=42, scopeId=9))
    written = [meta for _, meta in store.collection.rows.values() if meta["unitId"] == 42]
    assert written and all(meta["scopeId"] == 9 for meta in written)
