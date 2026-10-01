import sqlite3
from contextlib import contextmanager
from pathlib import Path


class OperationStore:
    def __init__(self, path: Path):
        self.path = path
        self._init()

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.path)
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            yield connection
            connection.commit()
        finally:
            connection.close()

    def _init(self) -> None:
        with self._connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS operation_batch (operation_id TEXT, batch_no INTEGER, completed INTEGER NOT NULL DEFAULT 0, vector_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(operation_id,batch_no))")
            db.execute("CREATE TABLE IF NOT EXISTS operation_vector (operation_id TEXT, vector_id TEXT, PRIMARY KEY(operation_id,vector_id))")
            db.execute("CREATE TABLE IF NOT EXISTS operation_status (operation_id TEXT PRIMARY KEY, finalized INTEGER NOT NULL DEFAULT 0)")
            db.execute("CREATE TABLE IF NOT EXISTS mutation_fence (scope_key TEXT PRIMARY KEY, token INTEGER NOT NULL)")
            columns = {row[1] for row in db.execute("PRAGMA table_info(operation_batch)")}
            if "vector_count" not in columns:
                db.execute("ALTER TABLE operation_batch ADD COLUMN vector_count INTEGER NOT NULL DEFAULT 0")

    def batch_completed(self, operation_id: str, batch_no: int) -> bool:
        with self._connect() as db:
            row = db.execute("SELECT completed FROM operation_batch WHERE operation_id=? AND batch_no=?", (operation_id, batch_no)).fetchone()
            return bool(row and row[0])

    def batch_result(self, operation_id: str, batch_no: int) -> tuple[bool, int]:
        with self._connect() as db:
            row = db.execute("SELECT completed,vector_count FROM operation_batch WHERE operation_id=? AND batch_no=?", (operation_id, batch_no)).fetchone()
            return (bool(row and row[0]), int(row[1]) if row else 0)

    def complete_batch(self, operation_id: str, batch_no: int, vector_ids: list[str]) -> None:
        with self._connect() as db:
            db.executemany("INSERT OR IGNORE INTO operation_vector(operation_id,vector_id) VALUES(?,?)", [(operation_id, item) for item in vector_ids])
            db.execute("INSERT INTO operation_batch(operation_id,batch_no,completed,vector_count) VALUES(?,?,1,?) ON CONFLICT(operation_id,batch_no) DO UPDATE SET completed=1,vector_count=excluded.vector_count", (operation_id, batch_no, len(set(vector_ids))))

    def vector_ids(self, operation_id: str) -> set[str]:
        with self._connect() as db:
            return {row[0] for row in db.execute("SELECT vector_id FROM operation_vector WHERE operation_id=?", (operation_id,))}

    def finish_operation(self, operation_id: str) -> None:
        with self._connect() as db:
            db.execute("INSERT INTO operation_status(operation_id,finalized) VALUES(?,1) ON CONFLICT(operation_id) DO UPDATE SET finalized=1", (operation_id,))

    def operation_finalized(self, operation_id: str) -> bool:
        with self._connect() as db:
            row = db.execute("SELECT finalized FROM operation_status WHERE operation_id=?", (operation_id,)).fetchone()
            return bool(row and row[0])

    def highest_fence(self, scope_keys: list[str]) -> int | None:
        if not scope_keys:
            return None
        placeholders = ",".join("?" for _ in scope_keys)
        with self._connect() as db:
            row = db.execute(
                f"SELECT MAX(token) FROM mutation_fence WHERE scope_key IN ({placeholders})",
                tuple(scope_keys),
            ).fetchone()
            return int(row[0]) if row and row[0] is not None else None

    def record_fences(self, scope_keys: list[str], token: int) -> None:
        if not scope_keys:
            return
        with self._connect() as db:
            db.executemany(
                "INSERT INTO mutation_fence(scope_key,token) VALUES(?,?) "
                "ON CONFLICT(scope_key) DO UPDATE SET token=MAX(token,excluded.token)",
                [(scope_key, token) for scope_key in scope_keys],
            )
