package com.zhiqu.rag;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.entity.AiSourceChunk;
import com.zhiqu.entity.RagIndexGeneration;
import com.zhiqu.entity.RagIndexJob;
import com.zhiqu.entity.RagSourceIndexState;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import com.zhiqu.mapper.AiSourceChunkMapper;
import com.zhiqu.mapper.RagIndexGenerationMapper;
import com.zhiqu.mapper.RagIndexJobMapper;
import com.zhiqu.mapper.RagSourceIndexStateMapper;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

@Service
public class RagIndexJobService {
    private final RagIndexJobMapper jobMapper;
    private final RagIndexGenerationMapper generationMapper;
    private final RagSourceIndexStateMapper stateMapper;
    private final AiNotebookSourceMapper sourceMapper;
    private final AiSourceChunkMapper chunkMapper;
    private final RagContentHashService contentHashService;
    private final RagProperties properties;

    public RagIndexJobService(RagIndexJobMapper jobMapper,
                              RagIndexGenerationMapper generationMapper,
                              RagSourceIndexStateMapper stateMapper,
                              AiNotebookSourceMapper sourceMapper,
                              AiSourceChunkMapper chunkMapper,
                              RagContentHashService contentHashService,
                              RagProperties properties) {
        this.jobMapper = jobMapper;
        this.generationMapper = generationMapper;
        this.stateMapper = stateMapper;
        this.sourceMapper = sourceMapper;
        this.chunkMapper = chunkMapper;
        this.contentHashService = contentHashService;
        this.properties = properties;
    }

    @Transactional
    public void enqueueSource(AiNotebookSource source) {
        ensureContentHash(source);
        List<RagIndexGeneration> generations = generationMapper.selectList(
                new LambdaQueryWrapper<RagIndexGeneration>()
                        .in(RagIndexGeneration::getStatus, "ACTIVE", "BUILDING", "READY"));
        if (generations.isEmpty()) {
            source.setIndexStatus("NOT_INDEXED");
            source.setIndexError(null);
            sourceMapper.updateById(source);
            return;
        }
        RagSourceIndexState activeCurrentState = null;
        boolean enqueued = false;
        for (RagIndexGeneration generation : generations) {
            RagSourceIndexState current = currentIndexedState(source, generation);
            if (current != null) {
                if ("ACTIVE".equals(generation.getStatus())) activeCurrentState = current;
                continue;
            }
            upsertSourceState(source, generation, "PENDING", null, 0);
            enqueue("UPSERT_SOURCE", generation, source.getUserId(), source.getNotebookId(), source.getId(),
                    source.getContentHash(), source.getContentHash());
            enqueued = true;
        }
        if (activeCurrentState != null) {
            RagIndexGeneration active = generations.stream()
                    .filter(generation -> "ACTIVE".equals(generation.getStatus())).findFirst().orElse(null);
            source.setIndexStatus("INDEXED");
            source.setIndexVersion(active == null ? null : active.getIndexVersion());
            source.setIndexedAt(activeCurrentState.getIndexedAt());
        } else {
            source.setIndexStatus(enqueued ? "PENDING" : "NOT_INDEXED");
            source.setIndexVersion(null);
            source.setIndexedAt(null);
        }
        source.setIndexError(null);
        sourceMapper.updateById(source);
    }

    @Transactional
    public void enqueueDeleteSource(Long userId, Long notebookId, Long sourceId) {
        enqueue("DELETE_SOURCE", null, userId, notebookId, sourceId, null,
                "delete-source:" + userId + ":" + notebookId + ":" + sourceId + ":" + UUID.randomUUID());
    }

    @Transactional
    public void enqueueDeleteNotebook(Long userId, Long notebookId) {
        enqueue("DELETE_NOTEBOOK", null, userId, notebookId, null, null,
                "delete-notebook:" + userId + ":" + notebookId + ":" + UUID.randomUUID());
    }

    @Transactional
    public void enqueueReindexSource(AiNotebookSource source) {
        ensureContentHash(source);
        List<RagIndexGeneration> generations = generationMapper.selectList(
                new LambdaQueryWrapper<RagIndexGeneration>()
                        .in(RagIndexGeneration::getStatus, "ACTIVE", "BUILDING", "READY"));
        if (generations.isEmpty()) {
            source.setIndexStatus("NOT_INDEXED");
            sourceMapper.updateById(source);
            return;
        }
        source.setIndexStatus("PENDING");
        source.setIndexError(null);
        sourceMapper.updateById(source);
        for (RagIndexGeneration generation : generations) {
            upsertSourceState(source, generation, "PENDING", null, 0);
            enqueue("REINDEX_SOURCE", generation, source.getUserId(), source.getNotebookId(), source.getId(),
                    source.getContentHash(), source.getContentHash() + ":" + UUID.randomUUID());
        }
    }

    @Transactional
    public void enqueueRetiredGenerationCleanup(RagIndexGeneration generation) {
        if (generation == null || !"RETIRED".equals(generation.getStatus())) return;
        enqueue("DELETE_GENERATION", generation, null, null, null, null,
                "delete-generation:" + generation.getId());
    }

    @Transactional
    public void enqueueFailedGenerationCleanup(RagIndexGeneration generation) {
        if (generation == null || !"FAILED".equals(generation.getStatus())) return;
        if (generationMapper.claimForPurge(generation.getId()) != 1) {
            throw new IllegalStateException("Failed RAG generation could not be claimed for purge");
        }
        generation.setStatus("PURGING");
        enqueue("DELETE_GENERATION", generation, null, null, null, null,
                "delete-generation:" + generation.getId());
    }

    @Transactional
    public List<RagIndexJob> claimDueJobs(int limit, String workerId) {
        LocalDateTime now = LocalDateTime.now();
        List<RagIndexJob> jobs = jobMapper.lockDueJobs(
                Math.max(1, Math.min(20, limit)), now, now.minusMinutes(5));
        for (RagIndexJob job : jobs) {
            job.setStatus("RUNNING");
            job.setAttempts((job.getAttempts() == null ? 0 : job.getAttempts()) + 1);
            job.setLeaseVersion((job.getLeaseVersion() == null ? 0L : job.getLeaseVersion()) + 1L);
            job.setLockedAt(now);
            job.setLockedBy(workerId);
            job.setNextRetryAt(null);
            jobMapper.updateById(job);
        }
        return jobs;
    }

    @Transactional
    public boolean complete(RagIndexJob job) {
        RagIndexGeneration generation = job.getGenerationId() == null ? null
                : generationMapper.lockById(job.getGenerationId());
        int updated = jobMapper.completeLease(job.getId(), job.getLockedBy(), job.getLeaseVersion(),
                LocalDateTime.now());
        if (updated != 1) return false;
        refreshGenerationProgressLocked(generation);
        return true;
    }

    @Transactional
    public boolean renewLease(RagIndexJob job) {
        LocalDateTime now = LocalDateTime.now();
        int updated = jobMapper.renewLease(job.getId(), job.getLockedBy(), job.getLeaseVersion(), now);
        if (updated == 1) job.setLockedAt(now);
        return updated == 1;
    }

    @Transactional
    public void markIndexedWithLease(RagIndexJob job, int vectorCount) {
        RagIndexGeneration generation = lockJobGeneration(job);
        renewLeaseOrThrow(job);
        if (generation == null || !List.of("ACTIVE", "BUILDING", "READY").contains(generation.getStatus())) {
            return;
        }
        AiNotebookSource source = sourceMapper.selectOne(new LambdaQueryWrapper<AiNotebookSource>()
                .eq(AiNotebookSource::getId, job.getSourceId())
                .eq(AiNotebookSource::getUserId, job.getUserId())
                .eq(AiNotebookSource::getNotebookId, job.getNotebookId())
                .eq(AiNotebookSource::getStatus, "READY")
                .last("FOR UPDATE"));
        if (source == null || source.getContentHash() == null
                || !source.getContentHash().equals(job.getContentHash())) {
            return;
        }
        markIndexedLocked(source, generation, vectorCount);
    }

    @Transactional
    public void expandGenerationWithLease(RagIndexJob job) {
        RagIndexGeneration generation = lockJobGeneration(job);
        renewLeaseOrThrow(job);
        if (generation == null || !"BUILDING".equals(generation.getStatus())) return;
        List<AiNotebookSource> sources = sourceMapper.selectList(new LambdaQueryWrapper<AiNotebookSource>()
                .eq(AiNotebookSource::getStatus, "READY")
                .orderByAsc(AiNotebookSource::getId));
        enqueueGenerationSourcesLocked(generation, sources);
    }

    @Transactional
    public RagIndexGeneration prepareGenerationPurgeWithLease(RagIndexJob job) {
        RagIndexGeneration generation = lockJobGeneration(job);
        renewLeaseOrThrow(job);
        if (generation == null || "PURGED".equals(generation.getStatus())) return null;
        if (List.of("RETIRED", "FAILED").contains(generation.getStatus())) {
            if (generationMapper.claimForPurge(generation.getId()) != 1) return null;
            generation.setStatus("PURGING");
        }
        return "PURGING".equals(generation.getStatus()) ? generation : null;
    }

    @Transactional
    public void markGenerationPurgedWithLease(RagIndexJob job) {
        RagIndexGeneration generation = lockJobGeneration(job);
        renewLeaseOrThrow(job);
        if (generation == null || "PURGED".equals(generation.getStatus())) return;
        if (!"PURGING".equals(generation.getStatus())) {
            throw new IllegalStateException("Only claimed RAG generations can be purged");
        }
        generation.setStatus("PURGED");
        generationMapper.updateById(generation);
    }

    private FailureTransition failLease(RagIndexJob job, Exception error) {
        int attempts = job.getAttempts() == null ? 1 : job.getAttempts();
        boolean dead = attempts >= Math.max(1, properties.getMaxAttempts());
        LocalDateTime nextRetryAt = null;
        if (!dead) {
            long seconds = Math.min(900, 5L * (1L << Math.min(8, Math.max(0, attempts - 1))));
            nextRetryAt = LocalDateTime.now().plusSeconds(seconds);
        }
        String lastError = limit(error == null ? "Unknown RAG indexing error" : error.getMessage(), 1000);
        int updated = jobMapper.failLease(job.getId(), job.getLockedBy(), job.getLeaseVersion(),
                dead ? "DEAD" : "RETRY", lastError, nextRetryAt);
        return new FailureTransition(updated == 1, dead);
    }

    /**
     * 处理「陈旧写入被墓碑拒绝」（sidecar 409 STALE_MUTATION）。
     *
     * <p>该作业已被更新的删除/写入取代，重试只会再拿到 409，因此直接转终态 SUPERSEDED：
     * 不写 source 的 ERROR 状态、不计入 DEAD，避免一次正常覆盖被放大成整代次 FAILED。
     * 仍然刷新代次进度，保证计数准确。
     */
    @Transactional
    public boolean supersede(RagIndexJob job, Exception error) {
        RagIndexGeneration generation = job.getGenerationId() == null ? null
                : generationMapper.lockById(job.getGenerationId());
        String reason = limit(error == null || error.getMessage() == null
                ? "Superseded by a newer RAG mutation" : error.getMessage(), 1000);
        int updated = jobMapper.supersedeLease(job.getId(), job.getLockedBy(), job.getLeaseVersion(),
                LocalDateTime.now(), reason);
        if (updated != 1) return false;
        refreshGenerationProgressLocked(generation);
        return true;
    }

    @Transactional
    public boolean handleFailure(RagIndexJob job, AiNotebookSource source,
                                 RagIndexGeneration generation, Exception error) {
        RagIndexGeneration lockedGeneration = generation == null ? null
                : generationMapper.lockById(generation.getId());
        FailureTransition transition = failLease(job, error);
        if (!transition.owned()) return false;
        markIndexError(source, lockedGeneration, error == null ? "Unknown RAG indexing error" : error.getMessage());
        refreshGenerationProgressLocked(lockedGeneration);
        return transition.dead();
    }

    @Transactional
    public RagIndexGeneration createGeneration(String indexVersion) {
        RagIndexGeneration generation = new RagIndexGeneration();
        generation.setIndexVersion(normalizeVersion(indexVersion));
        generation.setStatus("BUILDING");
        generation.setExpectedSourceCount(0);
        generation.setIndexedSourceCount(0);
        generationMapper.insert(generation);
        generation.setCollectionName("zhiqu_rag_g_" + generation.getId());
        generationMapper.updateById(generation);
        enqueue("REBUILD_GENERATION", generation, null, null, null, null,
                "rebuild-generation:" + generation.getId());
        return generation;
    }

    @Transactional
    public void enqueueGenerationSources(RagIndexGeneration generation, List<AiNotebookSource> sources) {
        if (generation == null) return;
        RagIndexGeneration lockedGeneration = generationMapper.lockById(generation.getId());
        if (lockedGeneration == null || !"BUILDING".equals(lockedGeneration.getStatus())) return;
        enqueueGenerationSourcesLocked(lockedGeneration, sources);
    }

    private void enqueueGenerationSourcesLocked(RagIndexGeneration generation, List<AiNotebookSource> sources) {
        generation.setExpectedSourceCount(sources.size());
        generation.setIndexedSourceCount(0);
        generationMapper.updateById(generation);
        int indexedCount = 0;
        for (AiNotebookSource source : sources) {
            try {
                ensureContentHash(source);
                if (currentIndexedState(source, generation) != null) {
                    indexedCount++;
                    continue;
                }
                upsertSourceState(source, generation, "PENDING", null, 0);
                enqueue("UPSERT_SOURCE", generation, source.getUserId(), source.getNotebookId(), source.getId(),
                        source.getContentHash(), source.getContentHash());
            } catch (RuntimeException error) {
                source.setIndexStatus("ERROR");
                source.setIndexError(limit(error.getMessage(), 1000));
                sourceMapper.updateById(source);
                if (source.getContentHash() != null) {
                    upsertSourceState(source, generation, "ERROR", limit(error.getMessage(), 1000), 0);
                }
            }
        }
        generation.setIndexedSourceCount(indexedCount);
        generationMapper.updateById(generation);
    }

    @Transactional
    public void markIndexed(AiNotebookSource source, RagIndexGeneration generation, int vectorCount) {
        if (generation == null || source == null) return;
        RagIndexGeneration lockedGeneration = generationMapper.lockById(generation.getId());
        if (lockedGeneration == null
                || !List.of("ACTIVE", "BUILDING", "READY").contains(lockedGeneration.getStatus())) return;
        markIndexedLocked(source, lockedGeneration, vectorCount);
    }

    private void markIndexedLocked(AiNotebookSource source, RagIndexGeneration generation, int vectorCount) {
        upsertSourceState(source, generation, "INDEXED", null, vectorCount);
        if (!"ACTIVE".equals(generation.getStatus())) return;
        source.setIndexStatus("INDEXED");
        source.setIndexVersion(generation.getIndexVersion());
        source.setIndexError(null);
        source.setIndexedAt(LocalDateTime.now());
        sourceMapper.updateById(source);
    }

    @Transactional
    public void markIndexError(AiNotebookSource source, RagIndexGeneration generation, String error) {
        if (source != null && generation != null) {
            upsertSourceState(source, generation, "ERROR", limit(error, 1000), 0);
        }
        boolean activeSnapshotStillIndexed = source != null && generation != null
                && "ACTIVE".equals(generation.getStatus())
                && currentIndexedState(source, generation) != null;
        if (source != null && !activeSnapshotStillIndexed
                && (generation == null || "ACTIVE".equals(generation.getStatus()) || !hasActiveGeneration())) {
            source.setIndexStatus("ERROR");
            source.setIndexError(limit(error, 1000));
            sourceMapper.updateById(source);
        }
    }

    @Transactional
    public void refreshGenerationProgress(Long generationId) {
        RagIndexGeneration generation = generationMapper.lockById(generationId);
        refreshGenerationProgressLocked(generation);
    }

    private void refreshGenerationProgressLocked(RagIndexGeneration generation) {
        if (generation == null || !"BUILDING".equals(generation.getStatus())) return;
        Long generationId = generation.getId();
        List<AiNotebookSource> currentSources = sourceMapper.selectList(new LambdaQueryWrapper<AiNotebookSource>()
                .eq(AiNotebookSource::getStatus, "READY"));
        List<RagSourceIndexState> sourceStates = stateMapper.selectList(new LambdaQueryWrapper<RagSourceIndexState>()
                .eq(RagSourceIndexState::getGenerationId, generationId));
        Map<Long, RagSourceIndexState> stateBySource = new HashMap<>();
        sourceStates.forEach(state -> stateBySource.put(state.getSourceId(), state));
        long indexed = currentSources.stream().filter(source -> {
            RagSourceIndexState state = stateBySource.get(source.getId());
            return state != null && "INDEXED".equals(state.getStatus())
                    && source.getContentHash() != null && source.getContentHash().equals(state.getContentHash());
        }).count();
        long unfinished = jobMapper.selectCount(new LambdaQueryWrapper<RagIndexJob>()
                .eq(RagIndexJob::getGenerationId, generationId)
                .in(RagIndexJob::getStatus, "PENDING", "RUNNING", "RETRY"));
        long dead = jobMapper.selectCount(new LambdaQueryWrapper<RagIndexJob>()
                .eq(RagIndexJob::getGenerationId, generationId)
                .eq(RagIndexJob::getStatus, "DEAD"));
        long errors = currentSources.stream().filter(source -> {
            RagSourceIndexState state = stateBySource.get(source.getId());
            return state != null && "ERROR".equals(state.getStatus());
        }).count();
        generation.setExpectedSourceCount(currentSources.size());
        generation.setIndexedSourceCount((int) indexed);
        if (unfinished == 0 && dead == 0 && indexed >= generation.getExpectedSourceCount()) {
            generation.setStatus("READY");
            generation.setCompletedAt(LocalDateTime.now());
            generation.setErrorMessage(null);
        } else if (unfinished == 0 && (dead > 0 || errors > 0 || indexed < generation.getExpectedSourceCount())) {
            generation.setStatus("FAILED");
            generation.setCompletedAt(LocalDateTime.now());
            generation.setErrorMessage(dead + " DEAD job(s), " + errors + " source error(s)");
        }
        generationMapper.updateById(generation);
    }

    @Transactional
    public void markGenerationPurged(Long generationId) {
        RagIndexGeneration generation = generationMapper.selectById(generationId);
        if (generation == null || "PURGED".equals(generation.getStatus())) return;
        if (!"PURGING".equals(generation.getStatus())) {
            throw new IllegalStateException("Only claimed RAG generations can be purged");
        }
        generation.setStatus("PURGED");
        generationMapper.updateById(generation);
    }

    @Transactional
    public boolean claimGenerationForPurge(Long generationId) {
        return generationMapper.claimForPurge(generationId) == 1;
    }

    private RagIndexGeneration lockJobGeneration(RagIndexJob job) {
        if (job == null || job.getGenerationId() == null) return null;
        return generationMapper.lockById(job.getGenerationId());
    }

    private void renewLeaseOrThrow(RagIndexJob job) {
        LocalDateTime now = LocalDateTime.now();
        int updated = jobMapper.renewLease(job.getId(), job.getLockedBy(), job.getLeaseVersion(), now);
        if (updated != 1) throw new IllegalStateException("RAG job lease was lost");
        job.setLockedAt(now);
    }

    private void enqueue(String operation, RagIndexGeneration generation, Long userId, Long notebookId,
                         Long sourceId, String contentHash, String uniquePart) {
        RagIndexJob job = new RagIndexJob();
        job.setOperation(operation);
        job.setGenerationId(generation == null ? null : generation.getId());
        job.setUserId(userId);
        job.setNotebookId(notebookId);
        job.setSourceId(sourceId);
        job.setContentHash(contentHash);
        job.setTargetIndexVersion(generation == null ? null : generation.getIndexVersion());
        String generationPart = generation == null ? "all" : String.valueOf(generation.getId());
        job.setDedupeKey(limit(operation.toLowerCase(Locale.ROOT) + ":" + generationPart + ":" + uniquePart, 255));
        job.setStatus("PENDING");
        job.setAttempts(0);
        try {
            jobMapper.insert(job);
        } catch (DuplicateKeyException ignored) {
            // The same source content and generation already has a durable job.
        }
    }

    private void upsertSourceState(AiNotebookSource source, RagIndexGeneration generation, String status,
                                   String error, int vectorCount) {
        RagSourceIndexState state = stateMapper.lockBySourceAndGeneration(source.getId(), generation.getId());
        if (state == null) {
            state = new RagSourceIndexState();
            state.setSourceId(source.getId());
            state.setGenerationId(generation.getId());
            state.setIndexVersion(generation.getIndexVersion());
            state.setContentHash(source.getContentHash());
            state.setStatus(status);
            state.setVectorCount(vectorCount);
            state.setLastError(error);
            if ("INDEXED".equals(status)) state.setIndexedAt(LocalDateTime.now());
            stateMapper.insert(state);
        } else {
            boolean sameSnapshot = generation.getIndexVersion().equals(state.getIndexVersion())
                    && source.getContentHash() != null && source.getContentHash().equals(state.getContentHash());
            if (sameSnapshot && "INDEXED".equals(state.getStatus()) && !"INDEXED".equals(status)) return;
            state.setIndexVersion(generation.getIndexVersion());
            state.setContentHash(source.getContentHash());
            state.setStatus(status);
            state.setVectorCount(vectorCount);
            state.setLastError(error);
            if ("INDEXED".equals(status)) state.setIndexedAt(LocalDateTime.now());
            stateMapper.updateById(state);
        }
    }

    private RagSourceIndexState currentIndexedState(AiNotebookSource source, RagIndexGeneration generation) {
        RagSourceIndexState state = stateMapper.lockBySourceAndGeneration(source.getId(), generation.getId());
        boolean current = state != null && "INDEXED".equals(state.getStatus())
                && generation.getIndexVersion().equals(state.getIndexVersion())
                && source.getContentHash() != null && source.getContentHash().equals(state.getContentHash());
        return current ? state : null;
    }

    private void ensureContentHash(AiNotebookSource source) {
        if (source.getContentHash() != null && !source.getContentHash().isBlank()) return;
        List<AiSourceChunk> chunks = chunkMapper.selectList(new LambdaQueryWrapper<AiSourceChunk>()
                .eq(AiSourceChunk::getSourceId, source.getId())
                .orderByAsc(AiSourceChunk::getChunkIndex));
        source.setContentHash(contentHashService.hashParentChunks(chunks));
        sourceMapper.updateById(source);
    }

    private boolean hasActiveGeneration() {
        return generationMapper.selectCount(new LambdaQueryWrapper<RagIndexGeneration>()
                .eq(RagIndexGeneration::getStatus, "ACTIVE")) > 0;
    }

    private String normalizeVersion(String value) {
        String version = value == null || value.isBlank() ? properties.getIndexVersion() : value.trim();
        if (!version.matches("[A-Za-z0-9._@-]{8,120}")) {
            throw new IllegalArgumentException("Invalid RAG index version");
        }
        return version;
    }

    private String limit(String value, int max) {
        String text = value == null ? "" : value;
        return text.length() <= max ? text : text.substring(0, max);
    }

    private record FailureTransition(boolean owned, boolean dead) {
    }
}
