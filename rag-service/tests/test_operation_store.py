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
