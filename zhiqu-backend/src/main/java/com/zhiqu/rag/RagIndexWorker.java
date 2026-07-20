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
    private static final int PARENT_CHUNKS_PER_BATCH = 8;
    private final String workerId = UUID.randomUUID().toString();
    private final RagProperties properties;
    private final RagIndexJobService jobService;
    private final RagClient client;
    private final RagIndexGenerationMapper generationMapper;
    private final AiNotebookSourceMapper sourceMapper;
    private final AiSourceChunkMapper chunkMapper;
    private final RuntimeIssueMapper runtimeIssueMapper;

    public RagIndexWorker(RagProperties properties,
                          RagIndexJobService jobService,
                          RagClient client,
                          RagIndexGenerationMapper generationMapper,
                          AiNotebookSourceMapper sourceMapper,
                          AiSourceChunkMapper chunkMapper,
                          RuntimeIssueMapper runtimeIssueMapper) {
        this.properties = properties;
        this.jobService = jobService;
        this.client = client;
        this.generationMapper = generationMapper;
        this.sourceMapper = sourceMapper;
        this.chunkMapper = chunkMapper;
        this.runtimeIssueMapper = runtimeIssueMapper;
    }

    @Scheduled(fixedDelayString = "${app.rag.worker-delay-ms:1000}")
    public void run() {
        if (!client.configured()) return;
        List<RagIndexJob> jobs = jobService.claimDueJobs(properties.getWorkerBatchSize(), workerId);
        for (RagIndexJob job : jobs) {
            try {
                assertLease(job);
                process(job);
                jobService.complete(job);
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

    private void delete(RagIndexJob job, String scope) {
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
