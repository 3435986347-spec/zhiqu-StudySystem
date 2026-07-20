package com.zhiqu.rag;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.entity.RagIndexGeneration;
import com.zhiqu.entity.RagIndexJob;
import com.zhiqu.entity.RagSourceIndexState;
import com.zhiqu.mapper.AiNotebookSourceMapper;
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

    public RagAdminService(RagProperties properties,
                           RagClient client,
                           RagMetricsService metrics,
                           RagIndexJobService jobService,
                           RagIndexGenerationMapper generationMapper,
                           RagIndexJobMapper jobMapper,
                           RagSourceIndexStateMapper stateMapper,
                           AiNotebookSourceMapper sourceMapper) {
        this.properties = properties;
        this.client = client;
        this.metrics = metrics;
        this.jobService = jobService;
        this.generationMapper = generationMapper;
        this.jobMapper = jobMapper;
        this.stateMapper = stateMapper;
        this.sourceMapper = sourceMapper;
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

    private void validateCurrentReadyCoverage(RagIndexGeneration generation) {
        List<AiNotebookSource> sources = sourceMapper.selectList(new LambdaQueryWrapper<AiNotebookSource>()
                .eq(AiNotebookSource::getStatus, "READY")
                .isNotNull(AiNotebookSource::getContentHash));
        List<RagSourceIndexState> states = stateMapper.selectList(new LambdaQueryWrapper<RagSourceIndexState>()
                .eq(RagSourceIndexState::getGenerationId, generation.getId()));
        Map<Long, RagSourceIndexState> bySource = new HashMap<>();
        states.forEach(state -> bySource.put(state.getSourceId(), state));
        long missing = sources.stream().filter(source -> {
            RagSourceIndexState state = bySource.get(source.getId());
            return state == null || !"INDEXED".equals(state.getStatus())
                    || !source.getContentHash().equals(state.getContentHash());
        }).count();
        if (missing > 0) {
            throw new BusinessException("当前仍有 " + missing + " 份 READY 资料未完成该代索引，不能启用");
        }
        generation.setExpectedSourceCount(sources.size());
        generation.setIndexedSourceCount(sources.size());
        generationMapper.updateById(generation);
    }

    private void publishActiveSourceState(RagIndexGeneration generation) {
        List<RagSourceIndexState> states = stateMapper.selectList(new LambdaQueryWrapper<RagSourceIndexState>()
                .eq(RagSourceIndexState::getGenerationId, generation.getId())
                .eq(RagSourceIndexState::getStatus, "INDEXED"));
        Map<Long, RagSourceIndexState> bySource = new HashMap<>();
        states.forEach(state -> bySource.put(state.getSourceId(), state));
        List<AiNotebookSource> sources = sourceMapper.selectList(new LambdaQueryWrapper<AiNotebookSource>()
                .eq(AiNotebookSource::getStatus, "READY"));
        for (AiNotebookSource source : sources) {
            RagSourceIndexState state = bySource.get(source.getId());
            boolean current = state != null && source.getContentHash() != null
                    && source.getContentHash().equals(state.getContentHash());
            source.setIndexStatus(current ? "INDEXED" : "NOT_INDEXED");
            source.setIndexVersion(current ? generation.getIndexVersion() : null);
            source.setIndexError(null);
            source.setIndexedAt(current ? state.getIndexedAt() : null);
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
