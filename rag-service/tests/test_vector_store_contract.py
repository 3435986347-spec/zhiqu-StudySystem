import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

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


def test_ingest_is_idempotent_and_keeps_no_document_text(tmp_path):
    store = make_store(tmp_path)
    payload = {
        "operationId": "op-1", "mutationToken": 10, "batchNo": 0, "finalBatch": True,
        "userId": 1, "notebookId": 2, "sourceId": 3,
        "contentHash": "abc", "indexVersion": "version-1", "collectionName": "test_collection",
        "chunks": [{"chunkId": 4, "chunkIndex": 0, "content": "一二三四五六七八九十"}],
    }
    first = store.index_source(payload)
    second = store.index_source(payload)
    assert first["written"] == len(segment_text(payload["chunks"][0]["content"], store.embedding.tokenizer, 8, 2))
    assert second == {"written": first["written"], "skipped": True, "contentHash": "abc", "indexVersion": "version-1"}
    assert all("document" not in metadata and "content" not in metadata for _, metadata in store.collection.rows.values())


def test_query_contract_forces_user_notebook_version_and_source_scope(tmp_path):
    store = make_store(tmp_path)
    store.index_source({
        "operationId": "op-2", "mutationToken": 20, "batchNo": 0, "finalBatch": True,
        "userId": 7, "notebookId": 8, "sourceId": 9,
        "contentHash": "def", "indexVersion": "version-2", "collectionName": "test_collection",
        "chunks": [{"chunkId": 10, "chunkIndex": 0, "content": "测试资料"}],
    })
    result = store.query({
        "requestId": "request", "userId": 7, "notebookId": 8, "question": "测试",
        "candidateK": 24, "sourceIds": [9], "indexVersion": "version-2", "collectionName": "test_collection",
    })
    conditions = store.collection.last_where["$and"]
    assert {"userId": {"$eq": 7}} in conditions
    assert {"notebookId": {"$eq": 8}} in conditions
    assert {"indexVersion": {"$eq": "version-2"}} in conditions
    assert {"sourceId": {"$in": [9]}} in conditions
    assert result["candidates"][0]["sourceId"] == 9


def test_final_empty_batch_removes_stale_vectors(tmp_path):
    store = make_store(tmp_path)
    store.index_source({
        "operationId": "op-old", "mutationToken": 30, "batchNo": 0, "finalBatch": True,
        "userId": 1, "notebookId": 2, "sourceId": 3,
        "contentHash": "old", "indexVersion": "version-1", "collectionName": "test_collection",
        "chunks": [{"chunkId": 4, "chunkIndex": 0, "content": "old content"}],
    })
    assert store.collection.rows

    store.index_source({
        "operationId": "op-empty", "mutationToken": 31, "batchNo": 0, "finalBatch": True,
        "userId": 1, "notebookId": 2, "sourceId": 3,
        "contentHash": "empty", "indexVersion": "version-1", "collectionName": "test_collection",
        "chunks": [],
    })

    assert not store.collection.rows


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


def test_source_delete_cannot_remove_sibling_source(tmp_path):
    store = make_store(tmp_path)
    for source_id in (3, 4):
        store.index_source({
            "operationId": f"source-{source_id}", "mutationToken": 50 + source_id,
            "batchNo": 0, "finalBatch": True,
            "userId": 1, "notebookId": 2, "sourceId": source_id,
            "contentHash": f"hash-{source_id}", "indexVersion": "version-1",
            "collectionName": "test_collection",
            "chunks": [{"chunkId": source_id, "chunkIndex": 0, "content": f"source {source_id}"}],
        })

    store.delete({
        "operationId": "delete-source-3", "mutationToken": 60, "scope": "SOURCE",
        "userId": 1, "notebookId": 2, "sourceId": 3,
    })

    remaining_sources = {metadata["sourceId"] for _, metadata in store.collection.rows.values()}
    assert remaining_sources == {4}


def test_late_source_index_is_rejected_after_delete_completes(tmp_path):
    store = make_store(tmp_path)
    release = threading.Event()
    started = threading.Event()
    old_payload = {
        "operationId": "old-source-index", "mutationToken": 70,
        "batchNo": 0, "finalBatch": True,
        "userId": 1, "notebookId": 2, "sourceId": 3,
        "contentHash": "old", "indexVersion": "version-1", "collectionName": "test_collection",
        "chunks": [{"chunkId": 4, "chunkIndex": 0, "content": "late private content"}],
    }

    def delayed_index():
        started.set()
        assert release.wait(5)
        return store.index_source(old_payload)

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(delayed_index)
        assert started.wait(5)
        store.delete({
            "operationId": "delete-source", "mutationToken": 80, "scope": "SOURCE",
            "userId": 1, "notebookId": 2, "sourceId": 3,
        })
        release.set()
        with pytest.raises(StaleMutationError):
            future.result(timeout=5)

    assert not store.collection.rows


def test_late_index_cannot_recreate_deleted_collection(tmp_path):
    store = make_store(tmp_path)
    old_payload = {
        "operationId": "old-collection-index", "mutationToken": 90,
        "batchNo": 0, "finalBatch": True,
        "userId": 1, "notebookId": 2, "sourceId": 3,
        "contentHash": "old", "indexVersion": "version-1", "collectionName": "test_collection",
        "chunks": [{"chunkId": 4, "chunkIndex": 0, "content": "late private content"}],
    }

    store.delete({
        "operationId": "delete-collection", "mutationToken": 100,
        "scope": "COLLECTION", "collectionName": "test_collection",
    })

    with pytest.raises(StaleMutationError):
        store.index_source(old_payload)
    assert store.client.deleted
    assert not store.collection.rows
