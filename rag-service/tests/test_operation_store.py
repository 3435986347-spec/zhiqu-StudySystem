from app.operation_store import OperationStore


def test_operation_batches_are_idempotent(tmp_path):
    store = OperationStore(tmp_path / "operations.sqlite3")
    assert not store.batch_completed("op-1", 0)
    store.complete_batch("op-1", 0, ["v1", "v2", "v2"])
    assert store.batch_completed("op-1", 0)
    assert store.vector_ids("op-1") == {"v1", "v2"}
    store.complete_batch("op-1", 0, ["v1", "v2"])
    assert store.vector_ids("op-1") == {"v1", "v2"}
    store.finish_operation("op-1")
    assert store.batch_completed("op-1", 0)
    assert store.operation_finalized("op-1")
    assert store.vector_ids("op-1") == {"v1", "v2"}


def test_mutation_fences_are_monotonic_and_persistent(tmp_path):
    path = tmp_path / "operations.sqlite3"
    store = OperationStore(path)
    store.record_fences(["SOURCE:1:2:3", "COLLECTION:test"], 20)
    store.record_fences(["SOURCE:1:2:3"], 10)

    assert store.highest_fence(["SOURCE:1:2:3"]) == 20
    assert store.highest_fence(["COLLECTION:test", "SOURCE:1:2:3"]) == 20
    assert OperationStore(path).highest_fence(["SOURCE:1:2:3"]) == 20
