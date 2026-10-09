package com.zhiqu.rag;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.entity.AiSourceChunk;
import com.zhiqu.entity.RagIndexGeneration;
import com.zhiqu.entity.RagIndexJob;
import com.zhiqu.entity.RagIndexableUnit;
import com.zhiqu.entity.RagSourceIndexState;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import com.zhiqu.mapper.AiSourceChunkMapper;
import com.zhiqu.mapper.RagIndexGenerationMapper;
import com.zhiqu.mapper.RagIndexJobMapper;
import com.zhiqu.mapper.RagIndexableUnitMapper;
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

    /** 可写入的代次。READY 但尚未激活的窗口里也要照常索引，否则激活会被自己卡住。 */
    static final List<String> LIVE_GENERATION_STATUSES = List.of("ACTIVE", "BUILDING", "READY");

    private final RagIndexJobMapper jobMapper;
    private final RagIndexGenerationMapper generationMapper;
    private final RagSourceIndexStateMapper stateMapper;
    private final RagIndexableUnitMapper unitMapper;
    private final AiNotebookSourceMapper sourceMapper;
    private final AiSourceChunkMapper chunkMapper;
    private final RagContentHashService contentHashService;
    private final RagProperties properties;
    private final RuntimeFlagService runtimeFlags;

    public RagIndexJobService(RagIndexJobMapper jobMapper,
                              RagIndexGenerationMapper generationMapper,
                              RagSourceIndexStateMapper stateMapper,
                              RagIndexableUnitMapper unitMapper,
                              AiNotebookSourceMapper sourceMapper,
                              AiSourceChunkMapper chunkMapper,
                              RagContentHashService contentHashService,
                              RagProperties properties,
                              RuntimeFlagService runtimeFlags) {
        this.jobMapper = jobMapper;
        this.generationMapper = generationMapper;
        this.stateMapper = stateMapper;
        this.unitMapper = unitMapper;
        this.sourceMapper = sourceMapper;
        this.chunkMapper = chunkMapper;
        this.contentHashService = contentHashService;
        this.properties = properties;
        this.runtimeFlags = runtimeFlags;
    }

    /** READY 且有正文哈希的投影行 —— 代次展开、进度核算、启用门禁<b>共用这一条</b>（V29 的目的）。 */
    List<RagIndexableUnit> indexableUnits() {
        return unitMapper.selectList(new LambdaQueryWrapper<RagIndexableUnit>()
                .eq(RagIndexableUnit::getStatus, RagNamespace.STATUS_READY)
                .isNotNull(RagIndexableUnit::getCanonicalHash)
                .orderByAsc(RagIndexableUnit::getId));
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

    /**
     * Notebook 资料解析完成或内容变更 —— 入队一条增量索引作业。
     *
     * <p><b>1B-2 起走 unit 方言</b>，与 Wiki 页用同一条 {@link #enqueueUnit} 路径。
     * 换掉 {@code UPSERT_SOURCE} 不是整洁性改动：Stage D 之后 sidecar 的 {@code IndexRequest}
     * 要求 {@code namespace} 与 {@code unitId}，旧载荷会被 422 拒绝、重试到 DEAD。
     *
     * <p>随之丢掉的是「按代次逐个入队 + 逐个记 PENDING 状态行」那一套：unit 作业不带代次，
     * 由 {@code RagIndexWorker.indexUnit} 在执行时把当时所有在建/在用的代次都写一遍
     * （见那里的 {@code targetGenerations}）。这样重建窗口里的一次编辑不会只落进其中一个代次 ——
     * 而这正是把入队从「每代次一条」改成「每单元一条」时最容易丢掉的性质。
     *
     * <p>{@code source.index_status} 仍然写：它是回落列（投影行还没建时前端读它）。
     */
    @Transactional
    public void enqueueSource(AiNotebookSource source) {
        if (producerFrozen(RagOperation.UPSERT_UNIT.name())) return;
        ensureContentHash(source);
        boolean hasTarget = generationMapper.selectCount(new LambdaQueryWrapper<RagIndexGeneration>()
                .in(RagIndexGeneration::getStatus, LIVE_GENERATION_STATUSES)) > 0;
        if (hasTarget) {
            enqueueUnit(RagOperation.UPSERT_UNIT.name(), source.getUserId(),
                    RagNamespace.NOTEBOOK_SOURCE, source.getId());
        }
        source.setIndexStatus(hasTarget ? "PENDING" : "NOT_INDEXED");
        source.setIndexVersion(null);
        source.setIndexedAt(null);
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

    /**
     * 管理端的「重新索引这份资料」。
     *
     * <p>1B-2 起与 {@link #enqueueSource} 收敛成同一条作业 —— 两者的差别原本只在 dedupe key
     * （REINDEX 拼了 UUID，所以内容没变也会再排一次）。unit 路径的 dedupe key 由 V30 在终态
     * 释放，所以「没有在途作业时点重建按钮」照样入队，强制重建的语义保住了；
     * 「有在途作业时重复点」被去重，也正是想要的。
     */
    @Transactional
    public void enqueueReindexSource(AiNotebookSource source) {
        enqueueSource(source);
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

    /**
     * 记账：某个单元在某个代次里索引完成了。
     *
     * <p>代次由调用方传入而不是从 {@code job.getGenerationId()} 取 —— 增量作业不带代次，
     * worker 会把它写进当时所有在建/在用的代次，每个代次调一次本方法。
     *
     * <p><b>写 {@code rag_indexable_unit.index_status} 的第二个写入方就是这里</b>，
     * 另一个是 {@code RagUnitRegistry.applyContent}（内容变了写回 NOT_INDEXED）。
     * 两个写入方安全，靠的是下面那道哈希闸门：内容若在索引期间变过，
     * 投影行的 {@code canonical_hash} 已经不同，本方法直接返回，不会把过期的 INDEXED 盖上去。
     * 去掉那道闸门，两个写入方就会按到达顺序互相覆盖，且没有任何东西会报错。
     */
    @Transactional
    public void markUnitIndexedWithLease(RagIndexJob job, RagIndexableUnit unit,
                                         RagIndexGeneration generation, int vectorCount) {
        if (unit == null || generation == null) return;
        RagIndexGeneration locked = generationMapper.lockById(generation.getId());
        renewLeaseOrThrow(job);
        if (locked == null || !LIVE_GENERATION_STATUSES.contains(locked.getStatus())) return;
        RagIndexableUnit current = unitMapper.selectById(unit.getId());
        if (current == null
                || !RagNamespace.STATUS_READY.equals(current.getStatus())
                || current.getCanonicalHash() == null
                || !current.getCanonicalHash().equals(unit.getCanonicalHash())) {
            return;
        }
        upsertUnitState(current, locked, "INDEXED", null, vectorCount);
        if (!"ACTIVE".equals(locked.getStatus())) return;
        unitMapper.update(null, new LambdaUpdateWrapper<RagIndexableUnit>()
                .eq(RagIndexableUnit::getId, current.getId())
                .set(RagIndexableUnit::getIndexStatus, "INDEXED")
                .set(RagIndexableUnit::getIndexVersion, locked.getIndexVersion())
                .set(RagIndexableUnit::getIndexError, null)
                .set(RagIndexableUnit::getIndexedAt, LocalDateTime.now()));
    }

    /**
     * 展开一个 BUILDING 代次。<b>枚举投影表，不再枚举 {@code ai_notebook_source}。</b>
     *
     * <p>这是 V29 点名的三处之一（另两处是进度核算与启用门禁）。三处必须同时切换：
     * 只切门禁的话，展开出来的仍是只覆盖 Notebook 资料的 LEGACY 作业，
     * 而门禁按投影表的分母去数 —— Wiki 单元永远没有状态行，覆盖率永远够不到，
     * 代次永远启用不了。分子与分母来自两张表是这一族缺陷的通用形状。
     */
    @Transactional
    public void expandGenerationWithLease(RagIndexJob job) {
        RagIndexGeneration generation = lockJobGeneration(job);
        renewLeaseOrThrow(job);
        if (generation == null || !"BUILDING".equals(generation.getStatus())) return;
        enqueueGenerationUnitsLocked(generation, indexableUnits());
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
    public boolean handleFailure(RagIndexJob job, RagIndexableUnit unit,
                                 RagIndexGeneration generation, Exception error) {
        RagIndexGeneration lockedGeneration = generation == null ? null
                : generationMapper.lockById(generation.getId());
        FailureTransition transition = failLease(job, error);
        if (!transition.owned()) return false;
        markUnitIndexError(unit, lockedGeneration,
                error == null ? "Unknown RAG indexing error" : error.getMessage());
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

    /**
     * 展开一个 BUILDING 代次（不经作业队列的直接入口，测试与管理端补救用）。
     *
     * <p><b>不再收 {@code List<AiNotebookSource>}。</b>「要展开哪些目标」由投影表回答，
     * 不由调用方传 —— 传参版本让调用方各自决定枚举口径，而那正是 V29 要消灭的东西：
     * 展开一份口径、门禁另一份口径，两边都自洽，合起来就永远差一点。
     */
    @Transactional
    public void enqueueGenerationUnits(RagIndexGeneration generation) {
        if (generation == null) return;
        RagIndexGeneration lockedGeneration = generationMapper.lockById(generation.getId());
        if (lockedGeneration == null || !"BUILDING".equals(lockedGeneration.getStatus())) return;
        enqueueGenerationUnitsLocked(lockedGeneration, indexableUnits());
    }

    /**
     * 为一个代次的每个可索引单元排一条作业。
     *
     * <p>与旧的 source 版相比少了 try/catch —— 那里包的是 {@code ensureContentHash}，
     * 它要现算哈希所以会抛。投影行的 {@code canonical_hash} 是对账时算好的，
     * 且 {@link #indexableUnits()} 已经把它为空的行滤掉了，这里没有会抛的东西可包。
     * <b>不要「为了稳妥」把 catch 加回来</b>：那会让 mapper 报错、约束冲突这类真故障
     * 变成一行 ERROR 状态，而代次照常展开完成。
     */
    private void enqueueGenerationUnitsLocked(RagIndexGeneration generation, List<RagIndexableUnit> units) {
        generation.setExpectedSourceCount(units.size());
        generation.setIndexedSourceCount(0);
        generationMapper.updateById(generation);
        int indexedCount = 0;
        for (RagIndexableUnit unit : units) {
            if (currentIndexedUnitState(unit, generation) != null) {
                indexedCount++;
                continue;
            }
            upsertUnitState(unit, generation, "PENDING", null, 0);
            enqueueUnitForGeneration(generation, unit);
        }
        generation.setIndexedSourceCount(indexedCount);
        generationMapper.updateById(generation);
    }

    /**
     * 代次展开专用的入队：<b>带上代次</b>。
     *
     * <p>与业务钩子那条（{@link #enqueueUnit}，不带代次）刻意不同。带代次的作业让
     * {@code complete()} 能拿到它去刷新 BUILDING 进度；不带代次的增量作业则由 worker
     * 写进当时所有在建/在用的代次。dedupe key 因此也必须带代次，否则重建期间的一条
     * 增量作业会把整个代次的那一条顶掉。
     */
    private void enqueueUnitForGeneration(RagIndexGeneration generation, RagIndexableUnit unit) {
        RagIndexJob job = new RagIndexJob();
        job.setOperation(RagOperation.UPSERT_UNIT.name());
        job.setProtocolVersion(SUPPORTED_PROTOCOL_VERSION);
        job.setGenerationId(generation.getId());
        job.setTargetIndexVersion(generation.getIndexVersion());
        job.setUserId(unit.getUserId());
        job.setNamespace(unit.getNamespace());
        job.setUnitId(unit.getId());
        job.setSourceId(unit.getRefId());          // 与 enqueueUnit 一致：这一列承载 ref_id
        job.setScopeKind(unit.getScopeKind());
        job.setScopeId(unit.getScopeId());
        job.setContentHash(unit.getCanonicalHash());
        job.setDedupeKey(limit("upsert_unit:" + generation.getId() + ":-:"
                + unit.getNamespace() + "#" + unit.getRefId(), 255));
        job.setStatus("PENDING");
        job.setAttempts(0);
        try {
            jobMapper.insert(job);
        } catch (DuplicateKeyException duplicate) {
            log.debug("代次 {} 的单元作业已存在，跳过入队 dedupeKey={}", generation.getId(), job.getDedupeKey());
        }
    }

    /**
     * 记账：某个单元在某个代次里索引失败了。
     *
     * <p>{@code generation} 为空（删除类作业、代次生命周期作业）时只写投影行的
     * {@code index_error}：那些作业不属于任何一代，写一条代次状态行无处可挂。
     */
    @Transactional
    public void markUnitIndexError(RagIndexableUnit unit, RagIndexGeneration generation, String error) {
        if (unit == null) return;
        if (generation != null && unit.getCanonicalHash() != null) {
            upsertUnitState(unit, generation, "ERROR", limit(error, 1000), 0);
        }
        unitMapper.update(null, new LambdaUpdateWrapper<RagIndexableUnit>()
                .eq(RagIndexableUnit::getId, unit.getId())
                .set(RagIndexableUnit::getIndexStatus, "ERROR")
                .set(RagIndexableUnit::getIndexError, limit(error, 1000)));
    }

    @Transactional
    public void refreshGenerationProgress(Long generationId) {
        RagIndexGeneration generation = generationMapper.lockById(generationId);
        refreshGenerationProgressLocked(generation);
    }

    private void refreshGenerationProgressLocked(RagIndexGeneration generation) {
        if (generation == null || !"BUILDING".equals(generation.getStatus())) return;
        Long generationId = generation.getId();
        List<RagIndexableUnit> currentSources = indexableUnits();
        Map<Long, RagSourceIndexState> stateBySource = unitStates(generationId);
        long indexed = currentSources.stream().filter(unit -> isIndexedIn(stateBySource, unit)).count();
        long unfinished = jobMapper.selectCount(new LambdaQueryWrapper<RagIndexJob>()
                .eq(RagIndexJob::getGenerationId, generationId)
                .in(RagIndexJob::getStatus, "PENDING", "RUNNING", "RETRY"));
        long dead = jobMapper.selectCount(new LambdaQueryWrapper<RagIndexJob>()
                .eq(RagIndexJob::getGenerationId, generationId)
                .eq(RagIndexJob::getStatus, "DEAD"));
        long errors = currentSources.stream().filter(unit -> {
            RagSourceIndexState state = stateBySource.get(unit.getId());
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

    /**
     * 某个代次的全部 <b>UNIT</b> 状态行，按 {@code unitId} 索引。
     *
     * <p><b>{@code unitId} 为空的行必须滤掉，这一句是承重的。</b>同一张表里还躺着 LEGACY 行
     * （{@code unit_id} 恒为 NULL）。不滤的话 {@code map.put(null, state)} 会把它们全部塌成
     * 一个条目、后来的覆盖先来的，而 HashMap 允许 null 键，所以既不抛异常也不留痕迹 ——
     * 表现只是覆盖率莫名其妙地少一点。
     *
     * <p>进度核算与启用门禁共用本方法，不是为了省几行：两处分头写同一个过滤条件时，
     * 漏掉其中一处的后果是「代次转 READY 但启用被拒」，而两条信息各自看都成立。
     */
    Map<Long, RagSourceIndexState> unitStates(Long generationId) {
        Map<Long, RagSourceIndexState> byUnit = new HashMap<>();
        stateMapper.selectList(new LambdaQueryWrapper<RagSourceIndexState>()
                        .eq(RagSourceIndexState::getGenerationId, generationId)
                        .isNotNull(RagSourceIndexState::getUnitId))
                .forEach(state -> byUnit.put(state.getUnitId(), state));
        return byUnit;
    }

    /** 「这个单元在这一代已经索引到当前内容」的<b>唯一</b>判据。 */
    static boolean isIndexedIn(Map<Long, RagSourceIndexState> stateByUnit, RagIndexableUnit unit) {
        RagSourceIndexState state = stateByUnit.get(unit.getId());
        return state != null && "INDEXED".equals(state.getStatus())
                && unit.getCanonicalHash() != null
                && unit.getCanonicalHash().equals(state.getContentHash());
    }

    /**
     * UNIT 方言的状态行 upsert。与 {@link #upsertSourceState} 是两条不相交的路径，
     * 不是重载：锁行的 SQL 不同（{@code unit_id} vs {@code source_id}），
     * 写入的列不同，唯一键也不同。
     */
    private void upsertUnitState(RagIndexableUnit unit, RagIndexGeneration generation, String status,
                                 String error, int vectorCount) {
        RagSourceIndexState state = stateMapper.lockByUnitAndGeneration(unit.getId(), generation.getId());
        if (state == null) {
            state = new RagSourceIndexState();
            state.setUnitId(unit.getId());
            // sourceId 保持 NULL：LEGACY 唯一键 (source_id, generation_id) 允许多个 NULL。
            // 填上 refId 会让 Notebook 单元与它的 LEGACY 行撞键，且撞的是一条早就存在的行。
            state.setGenerationId(generation.getId());
            state.setIndexVersion(generation.getIndexVersion());
            state.setContentHash(unit.getCanonicalHash());
            state.setStatus(status);
            state.setVectorCount(vectorCount);
            state.setLastError(error);
            if ("INDEXED".equals(status)) state.setIndexedAt(LocalDateTime.now());
            stateMapper.insert(state);
            return;
        }
        boolean sameSnapshot = generation.getIndexVersion().equals(state.getIndexVersion())
                && unit.getCanonicalHash() != null && unit.getCanonicalHash().equals(state.getContentHash());
        if (sameSnapshot && "INDEXED".equals(state.getStatus()) && !"INDEXED".equals(status)) return;
        state.setIndexVersion(generation.getIndexVersion());
        state.setContentHash(unit.getCanonicalHash());
        state.setStatus(status);
        state.setVectorCount(vectorCount);
        state.setLastError(error);
        if ("INDEXED".equals(status)) state.setIndexedAt(LocalDateTime.now());
        stateMapper.updateById(state);
    }

    private RagSourceIndexState currentIndexedUnitState(RagIndexableUnit unit, RagIndexGeneration generation) {
        RagSourceIndexState state = stateMapper.lockByUnitAndGeneration(unit.getId(), generation.getId());
        boolean current = state != null && "INDEXED".equals(state.getStatus())
                && generation.getIndexVersion().equals(state.getIndexVersion())
                && unit.getCanonicalHash() != null && unit.getCanonicalHash().equals(state.getContentHash());
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
