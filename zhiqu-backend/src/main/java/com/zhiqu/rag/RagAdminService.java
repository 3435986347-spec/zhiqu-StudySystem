package com.zhiqu.rag;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.entity.RagIndexGeneration;
import com.zhiqu.entity.RagIndexJob;
import com.zhiqu.entity.RagIndexableUnit;
import com.zhiqu.entity.RagSourceIndexState;
import com.zhiqu.entity.UserKnowledgePage;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import com.zhiqu.mapper.UserKnowledgePageMapper;
import com.zhiqu.mapper.RagIndexGenerationMapper;
import com.zhiqu.mapper.RagIndexJobMapper;
import com.zhiqu.mapper.RagSourceIndexStateMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Service
public class RagAdminService {
    private final RagProperties properties;
    private final RagClient client;
    private final RagMetricsService metrics;
    private final RagIndexJobService jobService;
    private final RagIndexGenerationMapper generationMapper;
    private final RagIndexJobMapper jobMapper;
    private final RagSourceIndexStateMapper stateMapper;
    private final AiNotebookSourceMapper sourceMapper;
    private final UserKnowledgePageMapper pageMapper;

    /** 探测「有没有原料」的取样上限，见 {@link #hasIndexableOrigin()}。 */
    private static final int ORIGIN_PROBE_LIMIT = 200;

    public RagAdminService(RagProperties properties,
                           RagClient client,
                           RagMetricsService metrics,
                           RagIndexJobService jobService,
                           RagIndexGenerationMapper generationMapper,
                           RagIndexJobMapper jobMapper,
                           RagSourceIndexStateMapper stateMapper,
                           AiNotebookSourceMapper sourceMapper,
                           UserKnowledgePageMapper pageMapper) {
        this.properties = properties;
        this.client = client;
        this.metrics = metrics;
        this.jobService = jobService;
        this.generationMapper = generationMapper;
        this.jobMapper = jobMapper;
        this.stateMapper = stateMapper;
        this.sourceMapper = sourceMapper;
        this.pageMapper = pageMapper;
    }

    public Map<String, Object> status() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("enabled", properties.isEnabled());
        result.put("sidecar", client.meta());
        result.put("activeGeneration", generationRow(generationMapper.selectOne(
                new LambdaQueryWrapper<RagIndexGeneration>().eq(RagIndexGeneration::getStatus, "ACTIVE").last("LIMIT 1"))));
        result.put("generations", generationMapper.selectList(new LambdaQueryWrapper<RagIndexGeneration>()
                .orderByDesc(RagIndexGeneration::getId)).stream().map(this::generationRow).toList());
        Map<String, Long> jobs = new LinkedHashMap<>();
        for (String state : List.of("PENDING", "RUNNING", "RETRY", "COMPLETED", "DEAD")) {
            jobs.put(state, jobMapper.selectCount(new LambdaQueryWrapper<RagIndexJob>().eq(RagIndexJob::getStatus, state)));
        }
        result.put("jobs", jobs);
        RagIndexJob oldest = jobMapper.selectOne(new LambdaQueryWrapper<RagIndexJob>()
                .in(RagIndexJob::getStatus, "PENDING", "RETRY")
                .orderByAsc(RagIndexJob::getCreatedAt).last("LIMIT 1"));
        result.put("jobLagSeconds", oldest == null || oldest.getCreatedAt() == null ? 0
                : Math.max(0, Duration.between(oldest.getCreatedAt(), LocalDateTime.now()).toSeconds()));
        result.put("metrics", metrics.snapshot());
        return result;
    }

    public List<Map<String, Object>> jobs(String status) {
        LambdaQueryWrapper<RagIndexJob> query = new LambdaQueryWrapper<RagIndexJob>().orderByDesc(RagIndexJob::getId);
        if (status != null && !status.isBlank()) query.eq(RagIndexJob::getStatus, status.trim().toUpperCase());
        query.last("LIMIT 100");
        return jobMapper.selectList(query).stream().map(this::jobRow).toList();
    }

    @Transactional
    public Map<String, Object> retry(Long id) {
        RagIndexJob snapshot = jobMapper.selectById(id);
        if (snapshot == null) throw new BusinessException("RAG 索引任务不存在");
        RagIndexGeneration generation = snapshot.getGenerationId() == null ? null
                : generationMapper.lockById(snapshot.getGenerationId());
        RagIndexJob job = jobMapper.lockById(id);
        if (job == null) throw new BusinessException("RAG 索引任务不存在");
        if ("COMPLETED".equals(job.getStatus())) return jobRow(job);
        if ("RUNNING".equals(job.getStatus())) {
            throw new BusinessException("索引任务仍在执行，超时后系统会自动重新领取");
        }
        if ("PENDING".equals(job.getStatus())) return jobRow(job);
        if (!List.of("RETRY", "DEAD").contains(job.getStatus())) {
            throw new BusinessException("当前索引任务状态不可重试");
        }
        if (generation != null && "FAILED".equals(generation.getStatus())) {
            throw new BusinessException("该任务所属的索引代次已失败，请创建新的重建任务");
        }
        job.setStatus("PENDING");
        job.setAttempts(0);
        job.setNextRetryAt(null);
        job.setLockedAt(null);
        job.setLockedBy(null);
        job.setLastError(null);
        jobMapper.updateById(job);
        return jobRow(jobMapper.selectById(id));
    }

    @Transactional
    public Map<String, Object> reindexSource(Long sourceId) {
        AiNotebookSource source = sourceMapper.selectOne(new LambdaQueryWrapper<AiNotebookSource>()
                .eq(AiNotebookSource::getId, sourceId)
                .eq(AiNotebookSource::getStatus, "READY"));
        if (source == null) throw new BusinessException("资料不存在、未解析完成或已删除");
        jobService.enqueueReindexSource(source);
        return Map.of("sourceId", sourceId, "indexStatus", "PENDING");
    }

    @Transactional
    public Map<String, Object> rebuild() {
        RagIndexGeneration generation = jobService.createGeneration(properties.getIndexVersion());
        return generationRow(generationMapper.selectById(generation.getId()));
    }

    @Transactional
    public Map<String, Object> activate(Long generationId) {
        List<RagIndexGeneration> lockedGenerations = generationMapper.lockAll();
        RagIndexGeneration target = lockedGenerations.stream()
                .filter(item -> generationId.equals(item.getId())).findFirst().orElse(null);
        if (target == null) throw new BusinessException("RAG 索引代次不存在");
        if ("ACTIVE".equals(target.getStatus())) return generationRow(target);
        if (!List.of("READY", "RETIRED").contains(target.getStatus())) {
            throw new BusinessException("只有已构建完成的索引才能启用");
        }
        if ("READY".equals(target.getStatus())) validateCurrentReadyCoverage(target);
        List<RagIndexGeneration> active = lockedGenerations.stream()
                .filter(item -> "ACTIVE".equals(item.getStatus())).toList();
        LocalDateTime now = LocalDateTime.now();
        for (RagIndexGeneration previous : active) {
            previous.setStatus("RETIRED");
            previous.setRetiredAt(now);
            generationMapper.updateById(previous);
        }
        target.setStatus("ACTIVE");
        target.setActivatedAt(now);
        target.setRetiredAt(null);
        generationMapper.updateById(target);
        publishActiveSourceState(target);
        return generationRow(target);
    }

    @Transactional
    public Map<String, Object> discardFailedGeneration(Long generationId) {
        RagIndexGeneration generation = generationMapper.lockById(generationId);
        if (generation == null) throw new BusinessException("RAG 索引代次不存在");
        if ("PURGED".equals(generation.getStatus()) || "PURGING".equals(generation.getStatus())) {
            return generationRow(generation);
        }
        if (!"FAILED".equals(generation.getStatus())) {
            throw new BusinessException("只有失败的索引代次可以丢弃");
        }
        jobService.enqueueFailedGenerationCleanup(generation);
        return generationRow(generationMapper.selectById(generationId));
    }

    /**
     * 启用门禁。<b>分母来自投影表</b>（V29 点名的三处之一，与代次展开、进度核算同批切换）。
     *
     * <p>{@code missing > 0} 之外还有一道<b>空分母闸门</b>，它不是防御性编程：
     * V29 只建表不填数据，投影行由 {@code RECONCILE_UNITS} 从原始表枚举。
     * 对账没跑过时投影表是空的，于是 {@code units} 为空 → {@code missing == 0} →
     * 门禁放行一个一条向量都没有的代次，而每一层都显示成功。
     * 「分母为 0 时无声放行」是这类覆盖率判据的通用失效形态，方案 §7 已经点过一次。
     *
     * <p>闸门刻意<b>只在空分母这条路上</b>回查原始表 —— 那是 V29 要收敛掉的重复查询，
     * 但放在这里不会重新引入漂移：它不参与覆盖率计算，只回答「投影是真的空，
     * 还是根本没建过」。主路径仍然只读投影表一张。
     */
    private void validateCurrentReadyCoverage(RagIndexGeneration generation) {
        List<RagIndexableUnit> units = jobService.indexableUnits();
        if (units.isEmpty() && hasIndexableOrigin()) {
            throw new BusinessException("语料投影表为空但库里存在可索引内容 —— "
                    + "请先在管理端触发一次「全量对账」，否则启用的会是一个空索引");
        }
        Map<Long, RagSourceIndexState> byUnit = jobService.unitStates(generation.getId());
        long missing = units.stream()
                .filter(unit -> !RagIndexJobService.isIndexedIn(byUnit, unit)).count();
        if (missing > 0) {
            throw new BusinessException("当前仍有 " + missing + " 个语料单元未完成该代索引，不能启用");
        }
        generation.setExpectedSourceCount(units.size());
        generation.setIndexedSourceCount(units.size());
        generationMapper.updateById(generation);
    }

    /** 空分母闸门的另一半：库里到底有没有该被索引的东西。 */
    /**
     * 库里有没有<b>任何</b>可索引原料 —— 用来区分「投影表是真的空」与「根本没对账过」。
     *
     * <p><b>必须把 Wiki 也算上。</b>1B-2 step 3 之后 Wiki 页是可索引原料，
     * 而这里此前只数 {@code ai_notebook_source} —— 于是一个只有 Wiki 页、没有资料的库，
     * 投影表没对账过时 {@code units.isEmpty()} 且本方法为 false，守卫不响，
     * <b>启用的是一个空索引</b>，而覆盖检查以 0/0 空绿通过。分子与分母来自两张表，
     * 正是 V29 要根除的那一族，这次长在守卫上。
     *
     * <p><b>排除规则不在这里抄第二份：</b>类型过滤直接把
     * {@link RagNamespace#EXCLUDED_PAGE_TYPES} 这个共享集合当参数传给 SQL，
     * 标题规则（trim + 大小写）只有 {@link RagNamespace#isExcludedWikiPage} 一处实现，
     * 在 Java 侧对取样结果调用。把它们译成 SQL 会立刻变成一份会漂移的副本。
     *
     * <p><b>取样而非全表：</b>类型过滤之后还带保留标题的页极少（保留标题只有三个），
     * 所以头 {@value #ORIGIN_PROBE_LIMIT} 行里必然出现一个真原料。残余的假阴性需要
     * 连续 {@value #ORIGIN_PROBE_LIMIT} 页都用保留标题 —— 真发生时退化成本方法的<b>旧行为</b>
     * （守卫不响），不会引入新的失效形态。
     *
     * <p>方向上刻意宁可漏报不可误报：误报会让守卫抛出「请先对账」，而对账之后投影表
     * 仍然是空的，操作者就<b>卡死</b>了 —— 一个响亮但无解的状态比一次静默更难处理。
     */
    private boolean hasIndexableOrigin() {
        if (sourceMapper.selectCount(new LambdaQueryWrapper<AiNotebookSource>()
                .eq(AiNotebookSource::getStatus, "READY")) > 0) {
            return true;
        }
        List<UserKnowledgePage> pages = pageMapper.selectList(new LambdaQueryWrapper<UserKnowledgePage>()
                .select(UserKnowledgePage::getPageType, UserKnowledgePage::getTitle)
                .notIn(UserKnowledgePage::getPageType, RagNamespace.EXCLUDED_PAGE_TYPES)
                .last("LIMIT " + ORIGIN_PROBE_LIMIT));
        return pages.stream()
                .anyMatch(page -> !RagNamespace.isExcludedWikiPage(page.getPageType(), page.getTitle()));
    }

    /**
     * 启用后把索引状态发布到展示列。
     *
     * <p>只处理 {@code NOTEBOOK_SOURCE} 单元：{@code ai_notebook_source.index_status}
     * 是资料列表那个圆点的回落数据源，Wiki 页没有对应的展示列
     * （它读投影行的 {@code index_status}，由 worker 记账时写）。
     */
    private void publishActiveSourceState(RagIndexGeneration generation) {
        Map<Long, RagSourceIndexState> byUnit = jobService.unitStates(generation.getId());
        Map<Long, RagSourceIndexState> byRefId = new HashMap<>();
        for (RagIndexableUnit unit : jobService.indexableUnits()) {
            if (!RagNamespace.NOTEBOOK_SOURCE.equals(unit.getNamespace())) continue;
            if (RagIndexJobService.isIndexedIn(byUnit, unit)) byRefId.put(unit.getRefId(), byUnit.get(unit.getId()));
        }
        List<AiNotebookSource> sources = sourceMapper.selectList(new LambdaQueryWrapper<AiNotebookSource>()
                .eq(AiNotebookSource::getStatus, "READY"));
        for (AiNotebookSource source : sources) {
            RagSourceIndexState state = byRefId.get(source.getId());
            source.setIndexStatus(state != null ? "INDEXED" : "NOT_INDEXED");
            source.setIndexVersion(state != null ? generation.getIndexVersion() : null);
            source.setIndexError(null);
            source.setIndexedAt(state != null ? state.getIndexedAt() : null);
            sourceMapper.updateById(source);
        }
    }

    private Map<String, Object> generationRow(RagIndexGeneration generation) {
        if (generation == null) return Map.of();
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", generation.getId());
        row.put("indexVersion", generation.getIndexVersion());
        row.put("collectionName", generation.getCollectionName());
        row.put("status", generation.getStatus());
        row.put("expectedSourceCount", generation.getExpectedSourceCount());
        row.put("indexedSourceCount", generation.getIndexedSourceCount());
        row.put("errorMessage", generation.getErrorMessage());
        row.put("createdAt", generation.getCreatedAt());
        row.put("completedAt", generation.getCompletedAt());
        row.put("activatedAt", generation.getActivatedAt());
        row.put("retiredAt", generation.getRetiredAt());
        return row;
    }

    private Map<String, Object> jobRow(RagIndexJob job) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", job.getId());
        row.put("operation", job.getOperation());
        row.put("generationId", job.getGenerationId());
        row.put("userId", job.getUserId());
        row.put("notebookId", job.getNotebookId());
        row.put("sourceId", job.getSourceId());
        row.put("status", job.getStatus());
        row.put("attempts", job.getAttempts());
        row.put("leaseVersion", job.getLeaseVersion());
        row.put("lockedBy", job.getLockedBy());
        row.put("lockedAt", job.getLockedAt());
        row.put("lastError", job.getLastError());
        row.put("nextRetryAt", job.getNextRetryAt());
        row.put("createdAt", job.getCreatedAt());
        row.put("completedAt", job.getCompletedAt());
        return row;
    }
}
