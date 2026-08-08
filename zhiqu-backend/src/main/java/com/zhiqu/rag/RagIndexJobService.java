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
import com.zhiqu.service.RuntimeFlagService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
    private static final Logger log = LoggerFactory.getLogger(RagIndexJobService.class);

    /**
     * 本版本 worker 支持的作业协议版本。
     *
     * <p>Phase 1A 仍是 1（unit 投影表尚不存在，所有作业都是 source 形态）。Phase 1B 引入
     * rag_indexable_unit 时改为 2。列与过滤条件先落地，是为了让那次切换只改这一个常量，
     * 也为了回滚到旧 JAR 时它不会误领新格式作业。
     */
    public static final int SUPPORTED_PROTOCOL_VERSION = 1;

    /** 双删方言：清理旧格式向量。 */
    public static final String DIALECT_LEGACY = "LEGACY";
    /** 双删方言：清理 unit 格式向量。 */
    public static final String DIALECT_UNIT = "UNIT";

    private final RagIndexJobMapper jobMapper;
    private final RagIndexGenerationMapper generationMapper;
    private final RagSourceIndexStateMapper stateMapper;
    private final AiNotebookSourceMapper sourceMapper;
    private final AiSourceChunkMapper chunkMapper;
    private final RagContentHashService contentHashService;
    private final RagProperties properties;
    private final RuntimeFlagService runtimeFlags;

    public RagIndexJobService(RagIndexJobMapper jobMapper,
                              RagIndexGenerationMapper generationMapper,
                              RagSourceIndexStateMapper stateMapper,
                              AiNotebookSourceMapper sourceMapper,
                              AiSourceChunkMapper chunkMapper,
                              RagContentHashService contentHashService,
                              RagProperties properties,
                              RuntimeFlagService runtimeFlags) {
        this.jobMapper = jobMapper;
        this.generationMapper = generationMapper;
        this.stateMapper = stateMapper;
        this.sourceMapper = sourceMapper;
        this.chunkMapper = chunkMapper;
        this.contentHashService = contentHashService;
        this.properties = properties;
        this.runtimeFlags = runtimeFlags;
    }

    /**
     * cutover 第 1 步的闸门：冻结**业务侧**生产者，已入队的作业照常被消费直到队列排空。
     *
     * <p>只拦业务触发的入队（资料增删、Notebook 删除、手动重索引），**不拦代次生命周期**
     * （REBUILD_GENERATION / UPSERT_SOURCE-of-rebuild / DELETE_GENERATION）——否则 runbook
     * 第 8 步在 producer-frozen 仍为 true 时就跑不了 rebuild，整个切换流程会自锁。
     */
    private boolean producerFrozen(String operation) {
        if (!runtimeFlags.producerFrozen()) {
            return false;
        }
        log.info("producer-frozen 生效，跳过业务侧入队 operation={}", operation);
        return true;
    }

    @Transactional
    public void enqueueSource(AiNotebookSource source) {
        if (producerFrozen(RagOperation.UPSERT_SOURCE.name())) return;
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
            enqueue(RagOperation.UPSERT_SOURCE.name(), generation, source.getUserId(), source.getNotebookId(), source.getId(),
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

    /**
     * 删除资料的向量。
     *
     * <p>{@code dual-delete-window} 打开时会入队**两条**：LEGACY 方言清理旧格式向量、
     * UNIT 方言清理 unit 格式向量。两条都是 protocol v2，都幂等，dedupe key 因方言不同而不同——
     * 若 key 相同，第二条会被 DuplicateKeyException 静默吞掉。
     */
    @Transactional
    public void enqueueDeleteSource(Long userId, Long notebookId, Long sourceId) {
        if (producerFrozen(RagOperation.DELETE_SOURCE.name())) return;
        String unique = "delete-source:" + userId + ":" + notebookId + ":" + sourceId + ":" + UUID.randomUUID();
        for (String dialect : deleteDialects()) {
            enqueue(RagOperation.DELETE_SOURCE.name(), null, userId, notebookId, sourceId, null, unique, dialect);
        }
    }

    @Transactional
    public void enqueueDeleteNotebook(Long userId, Long notebookId) {
        if (producerFrozen(RagOperation.DELETE_NOTEBOOK.name())) return;
        String unique = "delete-notebook:" + userId + ":" + notebookId + ":" + UUID.randomUUID();
        for (String dialect : deleteDialects()) {
            enqueue(RagOperation.DELETE_NOTEBOOK.name(), null, userId, notebookId, null, null, unique, dialect);
        }
    }

    /**
     * 升级期同时清理两种格式的向量。窗口关闭后只发 LEGACY——因为那时全部向量都是该格式。
     * Phase 1B 起 UNIT 方言才真正有对应的向量可清。
     */
    private List<String> deleteDialects() {
        return properties.isDualDeleteWindow()
                ? List.of(DIALECT_LEGACY, DIALECT_UNIT)
                : List.of(DIALECT_LEGACY);
    }

    @Transactional
    public void enqueueReindexSource(AiNotebookSource source) {
        if (producerFrozen(RagOperation.REINDEX_SOURCE.name())) return;
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
            enqueue(RagOperation.REINDEX_SOURCE.name(), generation, source.getUserId(), source.getNotebookId(), source.getId(),
                    source.getContentHash(), source.getContentHash() + ":" + UUID.randomUUID());
        }
    }

    @Transactional
    public void enqueueRetiredGenerationCleanup(RagIndexGeneration generation) {
        if (generation == null || !"RETIRED".equals(generation.getStatus())) return;
        enqueue(RagOperation.DELETE_GENERATION.name(), generation, null, null, null, null,
                "delete-generation:" + generation.getId());
    }

    @Transactional
    public void enqueueFailedGenerationCleanup(RagIndexGeneration generation) {
        if (generation == null || !"FAILED".equals(generation.getStatus())) return;
        if (generationMapper.claimForPurge(generation.getId()) != 1) {
            throw new IllegalStateException("Failed RAG generation could not be claimed for purge");
        }
        generation.setStatus("PURGING");
        enqueue(RagOperation.DELETE_GENERATION.name(), generation, null, null, null, null,
                "delete-generation:" + generation.getId());
    }

    /**
     * 领取到期作业。OFF 模式在 worker 侧就已提前返回，这里只需处理 NORMAL / REBUILD_ONLY。
     * 模式过滤下推到 SQL：本查询带 FOR UPDATE SKIP LOCKED，先领后筛会锁住不该锁的行。
     */
    @Transactional
    public List<RagIndexJob> claimDueJobs(int limit, String workerId, boolean sidecarAvailable) {
        LocalDateTime now = LocalDateTime.now();
        boolean rebuildOnly = runtimeFlags.workerMode() == RuntimeFlagService.WorkerMode.REBUILD_ONLY;
        List<RagIndexJob> jobs = jobMapper.lockDueJobs(
                Math.max(1, Math.min(20, limit)), now, now.minusMinutes(5),
                SUPPORTED_PROTOCOL_VERSION, rebuildOnly, sidecarAvailable);
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
        enqueue(RagOperation.REBUILD_GENERATION.name(), generation, null, null, null, null,
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
                enqueue(RagOperation.UPSERT_SOURCE.name(), generation, source.getUserId(), source.getNotebookId(), source.getId(),
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

    /**
     * Wiki 页内容或标题发生变化 —— 入队一条增量索引作业。
     *
     * <p><b>本方法只写一行 job，不解密、不分块、不碰投影表。</b>它由 Wiki 的写路径在
     * <b>同一个事务里</b>调用，这是事务性 outbox：作业行必须与业务变更原子提交，
     * 否则会出现「页保存了但永远没被索引」。反过来说，事务里能做的也就只有这一条 INSERT ——
     * 投影表的写入交给 worker，因为 {@code RagUnitRegistry} 的 {@code TransactionTemplate}
     * 是默认 {@code REQUIRED}，会加入调用方事务：一次投影写失败会把用户的 Wiki 保存整个回滚，
     * 而且用户看到的是一个与知识页无关的报错。
     *
     * <p><b>uniquePart 刻意不含内容哈希。</b>去重语义应当是「同一目标不重复排队」，
     * 由作业的<b>在途状态</b>决定（终态释放 dedupe_key，见 V30），而不是由内容决定。
     * 把哈希拼进来能挡住连续编辑，却挡不住 A→B→A：改回 A 时那个 key 在第一次就用掉了，
     * 回退被去重掉、索引永远停在 B。
     */
    @Transactional
    public void enqueueWikiPageChanged(Long userId, Long pageId) {
        if (producerFrozen(RagOperation.UPSERT_UNIT.name())) return;
        enqueueUnit(RagOperation.UPSERT_UNIT.name(), userId, RagNamespace.WIKI_PAGE, pageId);
    }

    /** Wiki 页被删除（或变成不入索引的系统页）—— 入队退役作业。同样只写一行 job。 */
    @Transactional
    public void enqueueWikiPageRemoved(Long userId, Long pageId) {
        if (producerFrozen(RagOperation.DELETE_UNIT.name())) return;
        enqueueUnit(RagOperation.DELETE_UNIT.name(), userId, RagNamespace.WIKI_PAGE, pageId);
    }

    /**
     * 删除一个作用域下的全部单元向量 —— UNIT 方言专用（方案 §5 删除矩阵）。
     *
     * <p>三个调用场景：删 Notebook → {@code SCOPE(u, NOTEBOOK_SOURCE, nbId)} 与
     * {@code SCOPE(u, CONVERSATION_TURN, convId)}；删会话 → 后者；
     * 清空记忆走的是 NAMESPACE 而不是本方法（那是整个命名空间，没有 scopeId）。
     *
     * <p><b>scopeId 必须非空。</b>sidecar 的 SCOPE 删除要求它（Chroma 的 metadata 不接受
     * None，所以 scopeId 为空的单元根本没写这个键），空值传过去会被 400 拒绝、
     * 走重试链到 DEAD。在这里就地拒绝，比让它跑到 sidecar 再回来早得多。
     *
     * <p>只发 UNIT 方言：LEGACY 没有与「作用域」对应的词，旧代次的向量由
     * {@code DELETE_NOTEBOOK} 的 LEGACY 半边清理。
     */
    @Transactional
    public void enqueueDeleteScope(Long userId, String namespace, String scopeKind, Long scopeId) {
        if (producerFrozen(RagOperation.DELETE_SCOPE.name())) return;
        if (userId == null || namespace == null || scopeId == null) {
            throw new IllegalArgumentException(
                    "DELETE_SCOPE 需要 userId/namespace/scopeId 三者齐全，实际为 "
                            + userId + "/" + namespace + "/" + scopeId);
        }
        RagIndexJob job = new RagIndexJob();
        job.setOperation(RagOperation.DELETE_SCOPE.name());
        job.setProtocolVersion(SUPPORTED_PROTOCOL_VERSION);
        job.setUserId(userId);
        job.setNamespace(namespace);
        job.setScopeKind(scopeKind);
        job.setScopeId(scopeId);
        job.setDeleteDialect(DIALECT_UNIT);
        job.setDedupeKey(limit("delete_scope:all:" + DIALECT_UNIT + ":"
                + userId + ":" + namespace + ":" + scopeId + ":" + UUID.randomUUID(), 255));
        job.setStatus("PENDING");
        job.setAttempts(0);
        try {
            jobMapper.insert(job);
        } catch (DuplicateKeyException duplicate) {
            log.debug("DELETE_SCOPE 作业已存在，跳过入队 dedupeKey={}", job.getDedupeKey());
        }
    }

    /**
     * 入队一次全量对账。
     *
     * <p>不内联执行：reconcile 会解密全部用户的全部 Wiki 页，放在 HTTP 请求里会占着连接
     * 跑几分钟，且失败后没有重试语义。走作业队列才拿得到租约、重试与 DEAD 告警。
     *
     * <p>{@code dedupe_key} 让同一时刻只有一次对账在途（终态释放，见 V30），
     * 所以重复点管理端按钮是幂等的。
     */
    @Transactional
    public void enqueueReconcileUnits() {
        if (producerFrozen(RagOperation.RECONCILE_UNITS.name())) return;
        RagIndexJob job = new RagIndexJob();
        job.setOperation(RagOperation.RECONCILE_UNITS.name());
        job.setProtocolVersion(SUPPORTED_PROTOCOL_VERSION);
        job.setDedupeKey("reconcile_units:all:-:global");
        job.setStatus("PENDING");
        job.setAttempts(0);
        try {
            jobMapper.insert(job);
        } catch (DuplicateKeyException duplicate) {
            log.debug("已有在途的全量对账作业，跳过入队");
        }
    }

    private void enqueueUnit(String operation, Long userId, String namespace, Long refId) {
        RagIndexJob job = new RagIndexJob();
        job.setOperation(operation);
        job.setProtocolVersion(SUPPORTED_PROTOCOL_VERSION);
        job.setUserId(userId);
        job.setNamespace(namespace);
        job.setUnitId(null);          // 投影行可能还不存在；worker 按 namespace + ref_id 定位
        job.setSourceId(refId);       // 复用既有列承载 ref_id，避免为增量再加一列
        job.setDedupeKey(limit(operation.toLowerCase(Locale.ROOT) + ":all:-:" + namespace + "#" + refId, 255));
        job.setStatus("PENDING");
        job.setAttempts(0);
        try {
            jobMapper.insert(job);
        } catch (DuplicateKeyException duplicate) {
            // 同一目标已在途（PENDING/RUNNING/RETRY）。终态的行已释放 dedupe_key（V30），
            // 所以这里被去重掉的一定是「还没跑的那次」，用户的这次编辑不会丢。
            log.debug("同一目标已有在途作业，跳过入队 dedupeKey={}", job.getDedupeKey());
        }
    }

    private void enqueue(String operation, RagIndexGeneration generation, Long userId, Long notebookId,
                         Long sourceId, String contentHash, String uniquePart) {
        enqueue(operation, generation, userId, notebookId, sourceId, contentHash, uniquePart, null);
    }

    /**
     * 入队一条作业。
     *
     * <p><b>dedupeKey 必须包含 deleteDialect</b>：唯一键冲突在下面是被吞掉的（这是刻意的幂等设计），
     * 若双删的两条方言共用同一个 key，第二条会**无声消失**——而升级期恰好少掉的就是清理旧格式
     * 向量的那条 LEGACY 删除。没有日志、没有报错，只有几天后发现旧向量还在。
     */
    private void enqueue(String operation, RagIndexGeneration generation, Long userId, Long notebookId,
                         Long sourceId, String contentHash, String uniquePart, String deleteDialect) {
        RagIndexJob job = new RagIndexJob();
        job.setOperation(operation);
        job.setProtocolVersion(SUPPORTED_PROTOCOL_VERSION);
        job.setGenerationId(generation == null ? null : generation.getId());
        job.setUserId(userId);
        job.setNotebookId(notebookId);
        job.setSourceId(sourceId);
        job.setDeleteDialect(deleteDialect);
        job.setContentHash(contentHash);
        job.setTargetIndexVersion(generation == null ? null : generation.getIndexVersion());
        String generationPart = generation == null ? "all" : String.valueOf(generation.getId());
        String dialectPart = deleteDialect == null ? "-" : deleteDialect;
        job.setDedupeKey(limit(operation.toLowerCase(Locale.ROOT)
                + ":" + generationPart + ":" + dialectPart + ":" + uniquePart, 255));
        job.setStatus("PENDING");
        job.setAttempts(0);
        try {
            jobMapper.insert(job);
        } catch (DuplicateKeyException duplicate) {
            // 幂等：同一份内容在同一代次已有持久化作业。此前这里是完全静默的，
            // 于是「被去重」和「压根没入队」在排查时无法区分——降级为 debug 日志，至少可观测。
            log.debug("RAG 作业已存在，跳过入队 dedupeKey={}", job.getDedupeKey());
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
