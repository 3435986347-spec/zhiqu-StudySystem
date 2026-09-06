from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="RAG_", extra="ignore")

    service_token: str = Field(min_length=24)
    data_dir: Path = Path("C:/zhiqu/rag-data")
    model_path: Path = Path("C:/zhiqu/models/bge-small-zh-v1.5")
    model_revision: str = Field(min_length=7)
    index_version: str = "bge-small-zh-v1.5@pinned-token448-overlap64-v1-cosine"
    device: str = "cpu"
    segment_tokens: int = 448
    segment_overlap: int = 64
    max_candidate_k: int = 32
    max_request_bytes: int = 5 * 1024 * 1024
    max_batch_parent_chunks: int = 16
    log_level: str = "INFO"

    def prepare(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        if not self.model_path.is_dir():
            raise RuntimeError(f"Local embedding model not found: {self.model_path}")
        revision_file = self.model_path / "ZHIQU_MODEL_REVISION"
        if not revision_file.is_file():
            raise RuntimeError(f"Pinned model revision marker is missing: {revision_file}")
        installed_revision = revision_file.read_text(encoding="utf-8").strip()
        if installed_revision != self.model_revision.strip():
            raise RuntimeError(
                f"Model revision mismatch: configured={self.model_revision}, installed={installed_revision}"
            )
        if self.segment_tokens <= self.segment_overlap:
            raise RuntimeError("segment_tokens must be greater than segment_overlap")
