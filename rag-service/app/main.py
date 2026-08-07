from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import AfterValidator, BaseModel, Field

from .embedding import EmbeddingService
from .settings import Settings
from .vector_store import DELETE_SCOPES, NAMESPACES, StaleMutationError, VectorStore


def _validate_namespace(value: str) -> str:
    """取值域来自 vector_store 的单一定义，这里不抄一份 Literal。

    拼错一个 namespace 的失效形态很静默：它不会报错，只会在 fence key 与 metadata 里
    各开一个谁也匹配不到的分区 —— 删除删不到它、检索也检索不到它，而每一层都显示成功。
    所以校验放在**边界**（唯一入口），而不是等它走到 VectorStore 里去。
    """
    if value not in NAMESPACES:
        raise ValueError(f"Unknown namespace: {value}")
    return value


Namespace = Annotated[str, AfterValidator(_validate_namespace)]


class ParentChunk(BaseModel):
    chunkId: int
    chunkIndex: int
    content: str = Field(min_length=1)


class IndexRequest(BaseModel):
    operationId: str
    mutationToken: int = Field(gt=0)
    userId: int
    namespace: Namespace
    unitId: int
    # 可空：WIKI_TREE 每用户一棵，没有 id。为空时 metadata 与 fence key 都不写这一段
    # （理由见 vector_store 的两处注释），SCOPE 删除因此要求它非空。
    scopeId: int | None = None
    contentHash: str
    indexVersion: str
    collectionName: str
    batchNo: int = Field(ge=0)
    finalBatch: bool
    chunks: list[ParentChunk]


class QueryRequest(BaseModel):
    requestId: str
    userId: int
    namespaces: list[Namespace]
    unitIds: list[int]
    question: str
    candidateK: int = 24
    indexVersion: str
    collectionName: str


class DeleteRequest(BaseModel):
    operationId: str
    mutationToken: int = Field(gt=0)
    scope: str
    userId: int | None = None
    # UNIT 方言
    unitId: int | None = None
    namespace: Namespace | None = None
    scopeId: int | None = None
    # LEGACY 方言 —— 保留到 runbook 第 11 步旧代次 PURGED 为止，不能提前删
    # （旧代次 collection 里的向量只带 sourceId/notebookId，只有这两个字段定位得到）。
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
        # 与 STALE_MUTATION 同为 409，但语义完全不同：这是配置错配，调用方必须按普通错误上报，
        # 不能当成「已被更新操作取代」而把作业静默转终态。故给出机器可读的 code。
        raise HTTPException(
            status_code=409,
            detail={
                "code": "INDEX_VERSION_MISMATCH",
                "message": f"Index version mismatch: requested={index_version}, sidecar={settings.index_version}",
            },
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
    try:
        return store().index_source(request.model_dump())
    except StaleMutationError as exc:
        # 墓碑拒绝陈旧写入：调用方应把该作业转终态，而不是重试（重试只会再拿到 409）。
        raise HTTPException(
            status_code=409,
            detail={"code": "STALE_MUTATION", "message": str(exc)},
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/v1/query")
def query(request: QueryRequest, _: None = Depends(authorize)):
    require_index_version(request.indexVersion)
    return store().query(request.model_dump())


@app.post("/v1/index/delete")
def delete(request: DeleteRequest, _: None = Depends(authorize)):
    # 取值域来自 vector_store 的单一定义，不再在这里抄一份字面量。
    # 这一层的存在意义是把非法 scope 映射成 400 而不是让它走到 VectorStore 再抛
    # ValueError —— 两条路径的状态码相同，但这里能在进入互斥锁之前就返回。
    if request.scope not in DELETE_SCOPES:
        raise HTTPException(status_code=400, detail="Unsupported delete scope")
    try:
        return store().delete(request.model_dump(exclude_none=True))
    except StaleMutationError as exc:
        # 墓碑拒绝陈旧写入：调用方应把该作业转终态，而不是重试（重试只会再拿到 409）。
        raise HTTPException(
            status_code=409,
            detail={"code": "STALE_MUTATION", "message": str(exc)},
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
