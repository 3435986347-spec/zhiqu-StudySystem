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
    "SOURCE": ("userId", "notebookId", "sourceId"),
    "NOTEBOOK": ("userId", "notebookId"),
    "USER": ("userId",),
    "INDEX_VERSION": ("indexVersion",),
    "COLLECTION": ("collectionName",),
}

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
                item_id = vector_id(str(payload["indexVersion"]), int(payload["sourceId"]), int(chunk["chunkId"]), segment.index)
                ids.append(item_id)
                texts.append(segment.text)
                metadatas.append({
                    "userId": int(payload["userId"]), "notebookId": int(payload["notebookId"]),
                    "sourceId": int(payload["sourceId"]), "chunkId": int(chunk["chunkId"]),
                    "chunkIndex": int(chunk["chunkIndex"]), "segmentIndex": segment.index,
                    "charStart": segment.char_start, "charEnd": segment.char_end,
                    "contentHash": str(payload["contentHash"]), "indexVersion": str(payload["indexVersion"]),
                })
        if ids:
            collection.upsert(ids=ids, embeddings=self.embedding.encode_passages(texts), metadatas=metadatas)
        self.operations.complete_batch(operation_id, batch_no, ids)
        if bool(payload.get("finalBatch")):
            self._finalize_source(operation_id, payload, collection)
        return {"written": len(ids), "skipped": False, "contentHash": payload["contentHash"], "indexVersion": payload["indexVersion"]}

    def _finalize_source(self, operation_id: str, payload: dict[str, Any], collection) -> None:
        keep = self.operations.vector_ids(operation_id)
        current = collection.get(where={"sourceId": int(payload["sourceId"])}, include=[])
        stale = [item for item in (current.get("ids") or []) if item not in keep]
        if stale:
            collection.delete(ids=stale)
        self.operations.finish_operation(operation_id)

    def query(self, payload: dict[str, Any]) -> dict[str, Any]:
        source_ids = [int(item) for item in payload.get("sourceIds") or []]
        if not source_ids:
            return {"indexVersion": payload["indexVersion"], "metric": "cosine", "candidates": []}
        where = {"$and": [
            {"userId": {"$eq": int(payload["userId"])}},
            {"notebookId": {"$eq": int(payload["notebookId"])}},
            {"indexVersion": {"$eq": str(payload["indexVersion"])}},
            {"sourceId": {"$in": source_ids}},
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
                "sourceId": int(metadata["sourceId"]),
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
        conditions: list[dict[str, Any]] = []
        if payload.get("userId") is not None:
            conditions.append({"userId": {"$eq": int(payload["userId"])}})
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

    def _index_fence_keys(self, payload: dict[str, Any]) -> list[str]:
        collection_name = str(payload.get("collectionName") or "")
        if not COLLECTION_RE.fullmatch(collection_name):
            raise ValueError("Invalid collection name")
        user_id = int(payload["userId"])
        notebook_id = int(payload["notebookId"])
        source_id = int(payload["sourceId"])
        index_version = str(payload["indexVersion"])
        return [
            f"COLLECTION:{collection_name}",
            f"SOURCE:{user_id}:{notebook_id}:{source_id}",
            f"NOTEBOOK:{user_id}:{notebook_id}",
            f"USER:{user_id}",
            f"INDEX_VERSION:{index_version}",
        ]

    def _delete_fence_keys(self, payload: dict[str, Any], scope: str) -> list[str]:
        if scope == "COLLECTION":
            return [f"COLLECTION:{payload['collectionName']}"]
        if scope == "SOURCE":
            return [f"SOURCE:{int(payload['userId'])}:{int(payload['notebookId'])}:{int(payload['sourceId'])}"]
        if scope == "NOTEBOOK":
            return [f"NOTEBOOK:{int(payload['userId'])}:{int(payload['notebookId'])}"]
        if scope == "USER":
            return [f"USER:{int(payload['userId'])}"]
        if scope == "INDEX_VERSION":
            return [f"INDEX_VERSION:{payload['indexVersion']}"]
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
