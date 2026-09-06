import re
import threading
from typing import Any, TYPE_CHECKING

try:
    import chromadb
except ImportError:  # Allows lightweight contract tests before production dependencies are installed.
    chromadb = None

from .operation_store import OperationStore
from .segmenter import segment_text, vector_id
from .settings import Settings

if TYPE_CHECKING:
    from .embedding import EmbeddingService


COLLECTION_RE = re.compile(r"^[A-Za-z0-9_-]{3,120}$")


# 删除作用域的**唯一定义**。此前这组知识散在两处：
#   - main.py 有一份「哪些 scope 合法」的字面量集合；
#   - 这里的 `_delete_locked` 里有一份「每个 scope 需要哪些字段」的局部 dict。
# 两份关于同一组 scope 的知识，而带信息的是后者 —— 前者只是它的键集。
# 分开放的失效形态不对称：加了新 scope 却漏改 main.py，表现是「合法请求被 400 拒掉」，
# 响亮；漏改这里，表现是「scope 通过白名单、字段校验却放行了空值」，
# 于是 None 一路走到 `_delete_fence_keys` 的 `int(...)` 才炸成 500 —— 而 500 在
# Java 侧走的是重试链，一个永远不会成功的请求会被重试到 DEAD。
#
# 收敛的方向因此是「把键集派生自 required_fields」，而不是反过来：
# 新增 scope 只需在下面这张表里加一行，合法性与字段要求同时到位。
DELETE_SCOPE_REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    # ── UNIT 方言（1B-2 起的写入路径） ─────────────────────────────────────
    "UNIT": ("userId", "unitId"),
    "SCOPE": ("userId", "namespace", "scopeId"),
    "NAMESPACE": ("userId", "namespace"),
    # ── LEGACY 方言 ───────────────────────────────────────────────────────
    # **不能删。** cutover 会重建到一个新 collection，而旧代次的 collection 要留到
    # runbook 第 11 步（24h 后 PURGED）；里面的向量带的是 sourceId/notebookId 元数据，
    # 只有这两个 scope 删得掉。删掉它们的话，双删的 LEGACY 那一半会拿 400 ——
    # 而 400 在 Java 侧走 handleFailure → 重试 → DEAD，一条永远不会成功的删除
    # 会把整个代次拖成 FAILED，且用户以为删掉的内容还留在旧代次里。
    # 关闭时机由 runbook 第 11 步决定，不是由这次改动决定。
    "SOURCE": ("userId", "notebookId", "sourceId"),
    "NOTEBOOK": ("userId", "notebookId"),
    # ── 与方言无关 ────────────────────────────────────────────────────────
    "USER": ("userId",),
    "INDEX_VERSION": ("indexVersion",),
    "COLLECTION": ("collectionName",),
}

# 命名空间取值域的**唯一定义**。散成字面量的失效形态很静默：拼错一个 namespace
# 不会报错，只会在 fence key 与 metadata 里各开一个谁也匹配不到的分区 ——
# 删除删不到它、检索也检索不到它，而每一层都显示成功。
NAMESPACES: frozenset[str] = frozenset({"NOTEBOOK_SOURCE", "WIKI_PAGE", "CONVERSATION_TURN"})


# ── fence key 的构造器 ───────────────────────────────────────────────────────
#
# 每个 key 只有一处实现，索引侧与删除侧都调这里。**不是为了少写几行。**
#
# 此前两侧各自拼 f-string，格式相同但表达式不同（一边用局部变量、一边逐个
# int()/str()）。把 key 写到最小已经缩小了能错开的地方，但没有消除它 ——
# 而错开的表现是 fence **静默**失效：删除记下的键与索引查找的键对不上，
# 于是陈旧写入不再被拦住，覆盖掉刚写进去的数据，没有任何报错。
#
# 类型强制也放进构造器：调用方传 "1" 还是 1 都得到同一个键。此前这一步散在两侧，
# 是同一类分叉的另一个入口。
#
# LEGACY 的两个今天只有删除侧一个调用者（1B-2 之后不再有 LEGACY 索引请求）。
# 仍然写成构造器，是为了让「key 格式只存在于一处」成为这个模块的性质，
# 而不是逐个键去判断「它有没有第二个调用者」。

def unit_fence_key(user_id, unit_id) -> str:
    return f"UNIT:{int(user_id)}:{int(unit_id)}"


def namespace_fence_key(user_id, namespace) -> str:
    return f"NAMESPACE:{int(user_id)}:{str(namespace)}"


def scope_fence_key(user_id, namespace, scope_id) -> str:
    return f"SCOPE:{int(user_id)}:{str(namespace)}:{int(scope_id)}"


def user_fence_key(user_id) -> str:
    return f"USER:{int(user_id)}"


def index_version_fence_key(index_version) -> str:
    return f"INDEX_VERSION:{str(index_version)}"


def collection_fence_key(collection_name) -> str:
    return f"COLLECTION:{str(collection_name)}"


def source_fence_key(user_id, notebook_id, source_id) -> str:
    """LEGACY 方言。只有删除侧调用 —— 见上方注释。"""
    return f"SOURCE:{int(user_id)}:{int(notebook_id)}:{int(source_id)}"


def notebook_fence_key(user_id, notebook_id) -> str:
    """LEGACY 方言。只有删除侧调用。"""
    return f"NOTEBOOK:{int(user_id)}:{int(notebook_id)}"

# main.py import 的就是这一个对象（不是同名副本）—— `test_scope_白名单只有一份定义`
# 用 `is` 断言身份，把「有人又抄了一份字面量」挡在结构层面而不是靠人记得。
DELETE_SCOPES: frozenset[str] = frozenset(DELETE_SCOPE_REQUIRED_FIELDS)


class StaleMutationError(ValueError):
    pass


class VectorStore:
    def __init__(self, settings: Settings, embedding: "EmbeddingService"):
        if chromadb is None:
            raise RuntimeError("chromadb is not installed")
        self.settings = settings
        self.embedding = embedding
        self.client = chromadb.PersistentClient(path=str(settings.data_dir / "chroma"))
        self.operations = OperationStore(settings.data_dir / "operations.sqlite3")
        self._mutation_lock = threading.RLock()

    def index_source(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._mutation_lock:
            return self._index_source_locked(payload)

    def _index_source_locked(self, payload: dict[str, Any]) -> dict[str, Any]:
        mutation_token = self._mutation_token(payload)
        fence_keys = self._index_fence_keys(payload)
        highest_fence = self.operations.highest_fence(fence_keys)
        if highest_fence is not None and mutation_token <= highest_fence:
            raise StaleMutationError(
                f"Index mutation {mutation_token} is fenced by delete mutation {highest_fence}"
            )
        operation_id = str(payload["operationId"])
        batch_no = int(payload["batchNo"])
        completed, previous_count = self.operations.batch_result(operation_id, batch_no)
        if completed:
            if bool(payload.get("finalBatch")) and not self.operations.operation_finalized(operation_id):
                self._finalize_source(operation_id, payload, self._collection(str(payload["collectionName"])))
            return {"written": previous_count, "skipped": True, "contentHash": payload["contentHash"], "indexVersion": payload["indexVersion"]}
        chunks = payload.get("chunks") or []
        if len(chunks) > self.settings.max_batch_parent_chunks:
            raise ValueError("Too many parent chunks in one batch")
        collection = self._collection(str(payload["collectionName"]))
        ids: list[str] = []
        metadatas: list[dict[str, Any]] = []
        texts: list[str] = []
        for chunk in chunks:
            content = str(chunk.get("content") or "")
            for segment in segment_text(content, self.embedding.tokenizer, self.settings.segment_tokens, self.settings.segment_overlap):
                item_id = vector_id(str(payload["indexVersion"]), int(payload["unitId"]), int(chunk["chunkId"]), segment.index)
                ids.append(item_id)
                texts.append(segment.text)
                metadata = {
                    "userId": int(payload["userId"]), "namespace": str(payload["namespace"]),
                    "unitId": int(payload["unitId"]), "chunkId": int(chunk["chunkId"]),
                    "chunkIndex": int(chunk["chunkIndex"]), "segmentIndex": segment.index,
                    "charStart": segment.char_start, "charEnd": segment.char_end,
                    "contentHash": str(payload["contentHash"]), "indexVersion": str(payload["indexVersion"]),
                }
                # scopeId 可空（WIKI_TREE 每用户一棵，没有 id），而 **Chroma 的 metadata
                # 不接受 None** —— 只能是 str/int/float/bool。所以缺省时整个键不写。
                # 由此推出一条契约：SCOPE 删除必须带非空 scopeId（见
                # DELETE_SCOPE_REQUIRED_FIELDS）。这不是限制 —— 方案 §5 的删除矩阵里
                # 没有任何一条需要「scopeId 为空的 SCOPE 删除」：
                # 删 Notebook 用 SCOPE(u, NOTEBOOK_SOURCE, nbId)、删会话用
                # SCOPE(u, CONVERSATION_TURN, convId)，Wiki 全域走 NAMESPACE(u, WIKI_PAGE)。
                if payload.get("scopeId") is not None:
                    metadata["scopeId"] = int(payload["scopeId"])
                metadatas.append(metadata)
        if ids:
            collection.upsert(ids=ids, embeddings=self.embedding.encode_passages(texts), metadatas=metadatas)
        self.operations.complete_batch(operation_id, batch_no, ids)
        if bool(payload.get("finalBatch")):
            self._finalize_source(operation_id, payload, collection)
        return {"written": len(ids), "skipped": False, "contentHash": payload["contentHash"], "indexVersion": payload["indexVersion"]}

    def _finalize_source(self, operation_id: str, payload: dict[str, Any], collection) -> None:
        """扫掉本 unit 上一次索引留下、这一次不再产生的向量。

        **扫描条件必须跟着 metadata 改键一起改，忘了的后果是静默的向量泄漏。**
        Chroma 对不存在的 metadata 键不报错，只是匹配为空 —— 于是链条是：
        `where={"sourceId": …}` 匹配为空 → stale 为空 → 不删 → `finish_operation`
        照常执行 → 批次返回成功 → Java 侧看到成功。每一层都显示正常，而残留向量的
        userId/indexVersion 仍满足 query() 的全部条件，**继续参与检索命中**。

        条件写成四条而不是一条 `unitId`：`unitId` 全局唯一、collection 又按代次分，
        所以 userId / namespace / indexVersion 今天都是冗余的。保留它们的理由与
        V29 那条「回滚生命线」唯一索引相同 —— 冗余条件在某条不变量被改动时才承重，
        而写下来的成本是零。更重要的是它落实了一条结构规则：

            **删除路径的收窄条件不得比读取路径宽。**

        query() 是四条 $and，此前这里只有一条，且不对称的方向落在破坏性那一侧。

        **`namespace` 这一条是对方案的一处偏离，理由要记下来。** 方案 §7 写的是
        `$and[userId, unitId, indexVersion]`，但它同时点名要有
        `test_finalize_cannot_delete_other_namespace_vectors` —— 而不含 namespace 的
        条件在「资料 7 与 Wiki 页 7」那个场景下必然跨命名空间删，两者不能同时成立。
        按上面那条结构规则取舍：query 有 `namespace $in`，这里就不能没有。
        """
        keep = self.operations.vector_ids(operation_id)
        where = {"$and": [
            {"userId": {"$eq": int(payload["userId"])}},
            {"namespace": {"$eq": str(payload["namespace"])}},
            {"unitId": {"$eq": int(payload["unitId"])}},
            {"indexVersion": {"$eq": str(payload["indexVersion"])}},
        ]}
        current = collection.get(where=where, include=[])
        stale = [item for item in (current.get("ids") or []) if item not in keep]
        if stale:
            collection.delete(ids=stale)
        self.operations.finish_operation(operation_id)

    def query(self, payload: dict[str, Any]) -> dict[str, Any]:
        unit_ids = [int(item) for item in payload.get("unitIds") or []]
        if not unit_ids:
            return {"indexVersion": payload["indexVersion"], "metric": "cosine", "candidates": []}
        namespaces = [str(item) for item in payload.get("namespaces") or []]
        where = {"$and": [
            {"userId": {"$eq": int(payload["userId"])}},
            {"namespace": {"$in": namespaces or sorted(NAMESPACES)}},
            {"indexVersion": {"$eq": str(payload["indexVersion"])}},
            {"unitId": {"$in": unit_ids}},
        ]}
        k = max(1, min(self.settings.max_candidate_k, int(payload.get("candidateK") or 24)))
        collection = self._collection(str(payload["collectionName"]), create=False)
        result = collection.query(
            query_embeddings=[self.embedding.encode_query(str(payload.get("question") or ""))],
            n_results=k, where=where, include=["metadatas", "distances"]
        )
        candidates: list[dict[str, Any]] = []
        metadata_rows = (result.get("metadatas") or [[]])[0]
        distances = (result.get("distances") or [[]])[0]
        ids = (result.get("ids") or [[]])[0]
        for item_id, metadata, distance in zip(ids, metadata_rows, distances):
            candidates.append({
                "vectorId": item_id,
                "namespace": str(metadata["namespace"]),
                "unitId": int(metadata["unitId"]),
                "chunkId": int(metadata["chunkId"]),
                "chunkIndex": int(metadata["chunkIndex"]),
                "segmentIndex": int(metadata["segmentIndex"]),
                "charStart": int(metadata["charStart"]),
                "charEnd": int(metadata["charEnd"]),
                "distance": float(distance),
            })
        return {"indexVersion": payload["indexVersion"], "metric": "cosine", "candidates": candidates}

    def delete(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._mutation_lock:
            return self._delete_locked(payload)

    def _delete_locked(self, payload: dict[str, Any]) -> dict[str, Any]:
        scope = str(payload.get("scope") or "")
        if scope not in DELETE_SCOPE_REQUIRED_FIELDS:
            raise ValueError("Unsupported delete scope")
        missing = [field for field in DELETE_SCOPE_REQUIRED_FIELDS[scope]
                   if payload.get(field) is None or payload.get(field) == ""]
        if missing:
            raise ValueError(f"Delete scope {scope} is missing required fields: {', '.join(missing)}")
        mutation_token = self._mutation_token(payload)
        fence_keys = self._delete_fence_keys(payload, scope)
        highest_fence = self.operations.highest_fence(fence_keys)
        if highest_fence is not None and mutation_token < highest_fence:
            raise StaleMutationError(
                f"Delete mutation {mutation_token} is older than fence {highest_fence}"
            )
        # Persist the tombstone before touching Chroma. If deletion fails, retries with
        # the same token remain allowed while all older index requests stay blocked.
        self.operations.record_fences(fence_keys, mutation_token)
        if scope == "COLLECTION":
            name = str(payload.get("collectionName") or "")
            if not COLLECTION_RE.fullmatch(name):
                raise ValueError("Delete collection scope is missing a valid collection name")
            if name not in self.collection_names():
                return {"deleted": 0, "scope": scope, "collectionName": name}
            count = self._collection(name, create=False).count()
            self.client.delete_collection(name)
            return {"deleted": count, "scope": scope, "collectionName": name}
        # 每个 scope 的 where 条件必须与 DELETE_SCOPE_REQUIRED_FIELDS 里声明的必填字段
        # 一一对应：声明了却不用 → 删除比宣称的宽（删到别人的数据）；用了却没声明 →
        # 字段缺失时静默退化成更宽的删除。两个方向都由
        # test_每个_scope_的删除条件与它声明的必填字段一致 逐个 scope 断言。
        conditions: list[dict[str, Any]] = []
        if payload.get("userId") is not None:
            conditions.append({"userId": {"$eq": int(payload["userId"])}})
        if scope == "UNIT":
            conditions.append({"unitId": {"$eq": int(payload["unitId"])}})
        if scope in {"SCOPE", "NAMESPACE"}:
            conditions.append({"namespace": {"$eq": str(payload["namespace"])}})
        if scope == "SCOPE":
            conditions.append({"scopeId": {"$eq": int(payload["scopeId"])}})
        # LEGACY 方言：只在旧代次的 collection 里匹配得到（新写入不再带这两个键）。
        if scope in {"SOURCE", "NOTEBOOK"} and payload.get("notebookId") is not None:
            conditions.append({"notebookId": {"$eq": int(payload["notebookId"])}})
        if scope == "SOURCE" and payload.get("sourceId") is not None:
            conditions.append({"sourceId": {"$eq": int(payload["sourceId"])}})
        if scope == "INDEX_VERSION" and payload.get("indexVersion"):
            conditions.append({"indexVersion": {"$eq": str(payload["indexVersion"])}})
        if not conditions:
            raise ValueError("Delete scope is missing required identifiers")
        where = conditions[0] if len(conditions) == 1 else {"$and": conditions}
        deleted = 0
        for name in self.collection_names():
            collection = self._collection(name, create=False)
            rows = collection.get(where=where, include=[])
            ids = rows.get("ids") or []
            if ids:
                collection.delete(ids=ids)
                deleted += len(ids)
        return {"deleted": deleted, "scope": scope}

    def _mutation_token(self, payload: dict[str, Any]) -> int:
        try:
            token = int(payload["mutationToken"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("mutationToken must be a positive integer") from exc
        if token <= 0:
            raise ValueError("mutationToken must be a positive integer")
        return token

    # ── fence key 族 ─────────────────────────────────────────────────────────
    #
    # 不变量：**索引请求列出的 key 必须覆盖任何能删掉它的 delete 的 key。**
    # 少列一个 → 那种删除拦不住随后到达的迟到索引 → 用户以为删掉的向量复活。
    # 这里没有任何东西会报错，所以由 test_每种删除都能拦住迟到的索引 逐个 scope 断言。
    #
    # key 的组成刻意保持最小。这与 WHERE 子句的取舍**方向相反**，值得写下来：
    #   - WHERE 多一条冗余条件 → 只会更严，最坏是白写；
    #   - KEY 多一段 → 索引侧与删除侧只要有一处写法不同就整个错开，
    #     而错开的表现是 fence 静默失效，不是报错。
    # 所以 SCOPE key 不含 scopeKind（namespace 已经决定了它），也不含 collectionName
    # （删除可能跨 collection）。
    #
    # 但最小化只**缩小**了能错开的地方，没有消除它 —— 消除靠的是上面那组构造器，
    # 两侧都调同一个函数，格式分叉从「不太可能」变成「不可能」。
    # 下面两个方法因此只负责**选哪些键**，不负责键长什么样；
    # 「选哪些」才是 test_每种删除都能拦住迟到的索引 要逐族验的性质。
    #
    # LEGACY 方言（SOURCE/NOTEBOOK）的 key 保留在删除侧、**不出现在索引侧** ——
    # 1B-2 之后不再有 LEGACY 索引请求，没有需要被它拦住的对象。真正承重的是与它
    # 同时入队的 UNIT 半边（方案 §3.2 的双删），那一半的 key 在索引侧列着。

    def _index_fence_keys(self, payload: dict[str, Any]) -> list[str]:
        collection_name = str(payload.get("collectionName") or "")
        if not COLLECTION_RE.fullmatch(collection_name):
            raise ValueError("Invalid collection name")
        user_id = payload["userId"]
        namespace = payload["namespace"]
        keys = [
            collection_fence_key(collection_name),
            unit_fence_key(user_id, payload["unitId"]),
            namespace_fence_key(user_id, namespace),
            user_fence_key(user_id),
            index_version_fence_key(payload["indexVersion"]),
        ]
        # scopeId 为空的 unit 不属于任何可被 SCOPE 删除定位的作用域（见 metadata 处的
        # 论证），因此也没有对应的 SCOPE fence 需要它去防 —— 不写空占位，
        # 免得造出一个 delete 侧永远不会生成的 key。
        if payload.get("scopeId") is not None:
            keys.append(scope_fence_key(user_id, namespace, payload["scopeId"]))
        return keys

    def _delete_fence_keys(self, payload: dict[str, Any], scope: str) -> list[str]:
        if scope == "COLLECTION":
            return [collection_fence_key(payload["collectionName"])]
        if scope == "UNIT":
            return [unit_fence_key(payload["userId"], payload["unitId"])]
        if scope == "SCOPE":
            return [scope_fence_key(payload["userId"], payload["namespace"], payload["scopeId"])]
        if scope == "NAMESPACE":
            return [namespace_fence_key(payload["userId"], payload["namespace"])]
        if scope == "SOURCE":
            return [source_fence_key(payload["userId"], payload["notebookId"], payload["sourceId"])]
        if scope == "NOTEBOOK":
            return [notebook_fence_key(payload["userId"], payload["notebookId"])]
        if scope == "USER":
            return [user_fence_key(payload["userId"])]
        if scope == "INDEX_VERSION":
            return [index_version_fence_key(payload["indexVersion"])]
        raise ValueError("Unsupported delete scope")

    def collection_names(self) -> list[str]:
        result = []
        for item in self.client.list_collections():
            result.append(item if isinstance(item, str) else item.name)
        return result

    def _collection(self, name: str, create: bool = True):
        if not COLLECTION_RE.fullmatch(name):
            raise ValueError("Invalid collection name")
        if create:
            return self.client.get_or_create_collection(name=name, metadata={"hnsw:space": "cosine"})
        return self.client.get_collection(name=name)
