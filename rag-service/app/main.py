from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .embedding import EmbeddingService
from .settings import Settings
from .vector_store import VectorStore


class ParentChunk(BaseModel):
    chunkId: int
    chunkIndex: int
    content: str = Field(min_length=1)


class IndexRequest(BaseModel):
    operationId: str
    userId: int
    notebookId: int
    sourceId: int
    contentHash: str
    indexVersion: str
    collectionName: str
    batchNo: int = Field(ge=0)
    finalBatch: bool
    chunks: list[ParentChunk]


class QueryRequest(BaseModel):
    requestId: str
    userId: int
    notebookId: int
    question: str
    candidateK: int = 24
    sourceIds: list[int]
    indexVersion: str
    collectionName: str


class DeleteRequest(BaseModel):
    operationId: str
    scope: str
    userId: int | None = None
    notebookId: int | None = None
    sourceId: int | None = None
    indexVersion: str | None = None
    collectionName: str | None = None


settings = Settings()
state: dict[str, Any] = {"ready": False, "error": None, "embedding": None, "store": None}


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        settings.prepare()
        embedding = EmbeddingService(settings)
        state.update(embedding=embedding, store=VectorStore(settings, embedding), ready=True, error=None)
    except Exception as exc:
        state.update(ready=False, error=str(exc))
    yield


app = FastAPI(title="Zhiqu RAG Sidecar", version="1.0.0", lifespan=lifespan)


@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    length = request.headers.get("content-length")
    if length and int(length) > settings.max_request_bytes:
        return JSONResponse(status_code=413, content={"detail": "Request body is too large"})
    return await call_next(request)


def authorize(authorization: str | None = Header(default=None)):
    if authorization != f"Bearer {settings.service_token}":
        raise HTTPException(status_code=401, detail="Unauthorized")


def store() -> VectorStore:
    if not state["ready"] or state["store"] is None:
        raise HTTPException(status_code=503, detail=state["error"] or "RAG service is not ready")
    return state["store"]


def require_index_version(index_version: str) -> None:
    if index_version != settings.index_version:
        raise HTTPException(
            status_code=409,
            detail=f"Index version mismatch: requested={index_version}, sidecar={settings.index_version}",
        )


@app.get("/health/live")
def live(_: None = Depends(authorize)):
    return {"live": True}


@app.get("/health/ready")
def ready(_: None = Depends(authorize)):
    if not state["ready"]:
        raise HTTPException(status_code=503, detail=state["error"] or "Not ready")
    return {"ready": True}


@app.get("/v1/meta")
def meta(_: None = Depends(authorize)):
    embedding = state.get("embedding")
    return {
        "ready": bool(state["ready"]), "error": state["error"],
        "modelPath": str(settings.model_path), "modelRevision": settings.model_revision,
        "dimension": embedding.dimension if embedding else None,
        "indexVersion": settings.index_version, "metric": "cosine",
        "collections": state["store"].collection_names() if state.get("store") else [],
    }


@app.post("/v1/index/sources")
def index_sources(request: IndexRequest, _: None = Depends(authorize)):
    require_index_version(request.indexVersion)
    return store().index_source(request.model_dump())


@app.post("/v1/query")
def query(request: QueryRequest, _: None = Depends(authorize)):
    require_index_version(request.indexVersion)
    return store().query(request.model_dump())


@app.post("/v1/index/delete")
def delete(request: DeleteRequest, _: None = Depends(authorize)):
    if request.scope not in {"SOURCE", "NOTEBOOK", "USER", "INDEX_VERSION", "COLLECTION"}:
        raise HTTPException(status_code=400, detail="Unsupported delete scope")
    try:
        return store().delete(request.model_dump(exclude_none=True))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
