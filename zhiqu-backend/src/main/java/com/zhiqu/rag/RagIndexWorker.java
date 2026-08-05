package com.zhiqu.rag;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.entity.AiSourceChunk;
import com.zhiqu.entity.RagIndexGeneration;
import com.zhiqu.entity.RagIndexJob;
import com.zhiqu.entity.RuntimeIssue;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import com.zhiqu.mapper.AiSourceChunkMapper;
import com.zhiqu.mapper.RagIndexGenerationMapper;
import com.zhiqu.mapper.RuntimeIssueMapper;
import com.zhiqu.service.RuntimeFlagService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Component
public class RagIndexWorker {
    private static final Logger log = LoggerFactory.getLogger(RagIndexWorker.class);
    private static final int PARENT_CHUNKS_PER_BATCH = 8;
    private final String workerId = UUID.randomUUID().toString();
    private final RagProperties properties;
    private final RagIndexJobService jobService;
    private final RagClient client;
    private final RagIndexGenerationMapper generationMapper;
    private final AiNotebookSourceMapper sourceMapper;
    private final AiSourceChunkMapper chunkMapper;
    private final RuntimeIssueMapper runtimeIssueMapper;
    private final RuntimeFlagService runtimeFlags;

    public RagIndexWorker(RagProperties properties,
                          RagIndexJobService jobService,
                          RagClient client,
                          RagIndexGenerationMapper generationMapper,
                          AiNotebookSourceMapper sourceMapper,
                          AiSourceChunkMapper chunkMapper,
                          RuntimeIssueMapper runtimeIssueMapper,
                          RuntimeFlagService runtimeFlags) {
        this.properties = properties;
        this.jobService = jobService;
        this.client = client;
        this.generationMapper = generationMapper;
        this.sourceMapper = sourceMapper;
        this.chunkMapper = chunkMapper;
        this.runtimeIssueMapper = runtimeIssueMapper;
        this.runtimeFlags = runtimeFlags;
    }

    @Scheduled(fixedDelayString = "${app.rag.worker-delay-ms:1000}")
    public void run() {
        if (!client.configured()) return;
        // cutover 的 OFF 模式：一条作业都不领。REBUILD_ONLY 的过滤下推到 claimDueJobs 的 SQL，
        // 因为那条查询带 FOR UPDATE SKIP LOCKED，先领后筛会锁住不该锁的行。
        if (runtimeFlags.workerMode() == RuntimeFlagService.WorkerMode.OFF) return;
        List<RagIndexJob> jobs = jobService.claimDueJobs(properties.getWorkerBatchSize(), workerId);
        for (RagIndexJob job : jobs) {
            try {
                assertLease(job);
                process(job);
                jobService.complete(job);
            } catch (StaleMutationException e) {
                // 墓碑拒绝了这次陈旧写入：目标已被更新的删除/写入取代，属于预期结果而非故障。
                // 若走 handleFailure，会 RETRY 到 DEAD 并把 source 标成 ERROR，
                // 最终 refreshGenerationProgress 把整个索引代次判为 FAILED。
                jobService.supersede(job, e);
            } catch (Exception e) {
                AiNotebookSource source = job.getSourceId() == null ? null : sourceMapper.selectById(job.getSourceId());
                RagIndexGeneration generation = job.getGenerationId() == null ? null
                        : generationMapper.selectById(job.getGenerationId());
                boolean dead = jobService.handleFailure(job, source, generation, e);
                if (dead) reportDeadJob(job, e);
            }
        }
    }

    private void process(RagIndexJob job) {
        switch (job.getOperation()) {
            case "UPSERT_SOURCE", "REINDEX_SOURCE" -> indexSource(job);
            case "DELETE_SOURCE" -> delete(job, "SOURCE");
            case "DELETE_NOTEBOOK" -> delete(job, "NOTEBOOK");
            case "DELETE_INDEX_VERSION" -> delete(job, "INDEX_VERSION");
            case "DELETE_GENERATION" -> deleteGeneration(job);
            case "REBUILD_GENERATION" -> expandGeneration(job);
            default -> throw new IllegalArgumentException("Unsupported RAG job operation: " + job.getOperation());
        }
    }

    private void indexSource(RagIndexJob job) {
        AiNotebookSource source = sourceMapper.selectOne(new LambdaQueryWrapper<AiNotebookSource>()
                .eq(AiNotebookSource::getId, job.getSourceId())
                .eq(AiNotebookSource::getUserId, job.getUserId())
                .eq(AiNotebookSource::getNotebookId, job.getNotebookId())
                .eq(AiNotebookSource::getStatus, "READY"));
        if (source == null) return;
        if (source.getContentHash() == null || !source.getContentHash().equals(job.getContentHash())) {
            jobService.enqueueSource(source);
            return;
        }
        RagIndexGeneration generation = generationMapper.selectById(job.getGenerationId());
        // A generation may be READY but not activated yet. Sources parsed in that window
        // must still be indexed, otherwise activation would be permanently blocked.
        if (generation == null || !List.of("ACTIVE", "BUILDING", "READY").contains(generation.getStatus())) return;
        List<AiSourceChunk> chunks = chunkMapper.selectList(new LambdaQueryWrapper<AiSourceChunk>()
                .eq(AiSourceChunk::getSourceId, source.getId())
                .orderByAsc(AiSourceChunk::getChunkIndex));
        if (chunks.isEmpty()) throw new IllegalStateException("READY source has no parent chunks");
        int vectorCount = 0;
        int batchNo = 0;
        for (int start = 0; start < chunks.size(); start += PARENT_CHUNKS_PER_BATCH) {
            assertLease(job);
            int end = Math.min(chunks.size(), start + PARENT_CHUNKS_PER_BATCH);
            List<Map<String, Object>> payloadChunks = new ArrayList<>();
            for (AiSourceChunk chunk : chunks.subList(start, end)) {
                payloadChunks.add(Map.of(
                        "chunkId", chunk.getId(),
                        "chunkIndex", chunk.getChunkIndex(),
                        "content", chunk.getContent()
                ));
            }
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("operationId", "job-" + job.getId());
            payload.put("mutationToken", job.getId());
            payload.put("userId", source.getUserId());
            payload.put("notebookId", source.getNotebookId());
            payload.put("sourceId", source.getId());
            payload.put("contentHash", source.getContentHash());
            payload.put("indexVersion", generation.getIndexVersion());
            payload.put("collectionName", generation.getCollectionName());
            payload.put("batchNo", batchNo++);
            payload.put("finalBatch", end >= chunks.size());
            payload.put("chunks", payloadChunks);
            Map<String, Object> response = client.indexSource(payload);
            vectorCount += intValue(response.get("written"));
        }
        jobService.markIndexedWithLease(job, vectorCount);
    }

    /**
     * 删除向量。
     *
     * <p>双删窗口下同一次业务删除会产生两条作业，靠 {@code delete_dialect} 区分：
     * LEGACY 发旧作用域（SOURCE / NOTEBOOK），UNIT 发新作用域。Phase 1A 还没有 unit 格式的
     * 向量，UNIT 方言因此是显式 no-op —— 写成 no-op 而不是让它落到旧作用域上，是为了避免
     * 同一份向量被删两次（第二次会撞 sidecar 的墓碑 fence，白白转成 SUPERSEDED 掩盖真实状态）。
     */
    private void delete(RagIndexJob job, String scope) {
        if (RagIndexJobService.DIALECT_UNIT.equals(job.getDeleteDialect())) {
            log.debug("UNIT 方言删除在 Phase 1A 无对应向量，跳过 jobId={}", job.getId());
            return;
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("operationId", "job-" + job.getId());
        payload.put("mutationToken", job.getId());
        payload.put("scope", scope);
        if (job.getUserId() != null) payload.put("userId", job.getUserId());
        if (job.getNotebookId() != null) payload.put("notebookId", job.getNotebookId());
        if (job.getSourceId() != null) payload.put("sourceId", job.getSourceId());
        if (job.getTargetIndexVersion() != null) payload.put("indexVersion", job.getTargetIndexVersion());
        client.deleteIndex(payload);
    }

    private void deleteGeneration(RagIndexJob job) {
        RagIndexGeneration generation = jobService.prepareGenerationPurgeWithLease(job);
        if (generation == null) return;
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("operationId", "job-" + job.getId());
        payload.put("mutationToken", job.getId());
        payload.put("scope", "COLLECTION");
        payload.put("collectionName", generation.getCollectionName());
        client.deleteIndex(payload);
        jobService.markGenerationPurgedWithLease(job);
    }

    @Scheduled(fixedDelayString = "${app.rag.cleanup-delay-ms:3600000}",
            initialDelayString = "${app.rag.cleanup-initial-delay-ms:60000}")
    public void enqueueRetiredCleanup() {
        if (!client.configured()) return;
        List<RagIndexGeneration> expired = generationMapper.selectList(new LambdaQueryWrapper<RagIndexGeneration>()
                .eq(RagIndexGeneration::getStatus, "RETIRED")
                .le(RagIndexGeneration::getRetiredAt, LocalDateTime.now().minusHours(24)));
        expired.forEach(jobService::enqueueRetiredGenerationCleanup);
    }

    private void expandGeneration(RagIndexJob job) {
        jobService.expandGenerationWithLease(job);
    }

    private void assertLease(RagIndexJob job) {
        if (!jobService.renewLease(job)) {
            throw new IllegalStateException("RAG job lease was lost");
        }
    }

    private void reportDeadJob(RagIndexJob job, Exception error) {
        try {
            RuntimeIssue issue = new RuntimeIssue();
            issue.setUserId(job.getUserId());
            issue.setSource("SERVER");
            issue.setSeverity("ERROR");
            issue.setCategory("RAG_INDEX_DEAD");
            issue.setMessage("RAG indexing job " + job.getId() + " reached DEAD state");
            issue.setDetail(safeMessage(error));
            issue.setApiPath("RagIndexWorker/" + job.getOperation());
            issue.setStatus("OPEN");
            runtimeIssueMapper.insert(issue);
        } catch (Exception ignored) {
        }
    }

    private int intValue(Object value) {
        if (value instanceof Number number) return number.intValue();
        try { return Integer.parseInt(String.valueOf(value)); } catch (Exception ignored) { return 0; }
    }

    private String safeMessage(Exception e) {
        String message = e == null ? null : e.getMessage();
        if (message == null || message.isBlank()) return e == null ? "Unknown error" : e.getClass().getSimpleName();
        return message.length() <= 1000 ? message : message.substring(0, 1000);
    }
}
