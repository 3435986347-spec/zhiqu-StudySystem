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
    private final RagUnitRegistry registry;

    public RagIndexWorker(RagProperties properties,
                          RagIndexJobService jobService,
                          RagClient client,
                          RagIndexGenerationMapper generationMapper,
                          AiNotebookSourceMapper sourceMapper,
                          AiSourceChunkMapper chunkMapper,
                          RuntimeIssueMapper runtimeIssueMapper,
                          RuntimeFlagService runtimeFlags,
                          RagUnitRegistry registry) {
        this.properties = properties;
        this.jobService = jobService;
        this.client = client;
        this.generationMapper = generationMapper;
        this.sourceMapper = sourceMapper;
        this.chunkMapper = chunkMapper;
        this.runtimeIssueMapper = runtimeIssueMapper;
        this.runtimeFlags = runtimeFlags;
        this.registry = registry;
    }

    @Scheduled(fixedDelayString = "${app.rag.worker-delay-ms:1000}")
    public void run() {
        // cutover 的 OFF 模式：一条作业都不领。REBUILD_ONLY 与「sidecar 是否可用」的过滤
        // 都下推到 claimDueJobs 的 SQL，因为那条查询带 FOR UPDATE SKIP LOCKED，
        // 先领后筛会锁住不该锁的行。
        if (runtimeFlags.workerMode() == RuntimeFlagService.WorkerMode.OFF) return;

        // 这里刻意**没有** `if (!client.configured()) return;`。那行早返回同时做两件事：
        // ① 正确性闸门（需要 sidecar 的操作不该在它缺席时跑）——已下推到 SQL；
        // ② 空转成本规避 —— 现在没了：app.rag.enabled=false 是仓库默认，于是每个从不启用
        //    RAG 的部署都会每秒发一条 SELECT ... FOR UPDATE SKIP LOCKED，永远。
        // 这是明知的取舍，不是副作用：idx_rag_job_protocol_claim（V28）在、表小、走索引，
        // 而 RAG 启用时本来就是这个频率。也没有更便宜的办法 —— 要知道有没有待办的
        // RECONCILE_UNITS，那条查询本身就是检查。
        // **不要把早返回加回来**：那会把全量对账重新挡在一个它根本不需要的依赖后面，
        // 后果是 RAG 未启用时投影永远无法对账、回滚后的滚回流程走不通（回滚演练实测发现）。
        List<RagIndexJob> jobs = jobService.claimDueJobs(
                properties.getWorkerBatchSize(), workerId, client.configured());
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
            case "UPSERT_UNIT" -> upsertUnit(job);
            case "DELETE_UNIT" -> retireUnit(job);
            case "RECONCILE_UNITS" -> reconcileUnits(job);
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

    /**
     * 增量索引一个单元。
     *
     * <p>投影表的写入放在 worker 而不是 Wiki 的写路径里：{@code RagUnitRegistry} 的
     * {@code TransactionTemplate} 是默认 {@code REQUIRED}，在钩子里调用会加入用户事务 ——
     * 一次投影写失败就把用户的 Wiki 保存整个回滚，RAG 的记账故障变成核心功能故障。
     *
     * <p>让位于删除靠 {@code refreshUnitIfLive} 重读投影行，不靠作业排序：
     * 作业里带的是发起时的快照，投影行才是当前真相。
     */
    private void upsertUnit(RagIndexJob job) {
        registry.refreshUnitIfLive(job.getNamespace(), job.getSourceId());
    }

    /**
     * 全量对账 + <b>跳过率门禁</b>。
     *
     * <p>门禁此前只活在注释里：{@code ReconcileReport.skippedRatio()} 有定义、零消费方，
     * 于是「每 20 个单元最多藏 1 个静默失败」这条论证的前提根本不成立 —— 实际是藏多少个都行。
     * 这里是它唯一的落地点。
     *
     * <p><b>超阈值必须让作业失败，不能记完日志就 COMPLETED。</b>否则第三方观察到的现象
     * （作业转 COMPLETED、投影里有了行）在「对账成功」与「跳过了语料大半」两种情况下
     * 完全一样 —— 演练第 3 步就成了一个不可证伪的步骤：声称验「投影追上了」，
     * 实际只验了「作业跑完了」。
     *
     * <p>{@code skippedReasons} 一并抛出，否则超了阈值也不知道超在哪。
     */
    private void reconcileUnits(RagIndexJob job) {
        RagUnitRegistry.ReconcileReport report = registry.reconcileAll(() -> assertLease(job));
        double ratio = report.skippedRatio();
        if (ratio > properties.getMaxSkippedRatio()) {
            String reasons = String.join("；", report.skippedReasons.stream().limit(10).toList());
            throw new IllegalStateException("全量对账跳过比例 " + String.format("%.3f", ratio)
                    + " 超过上限 " + properties.getMaxSkippedRatio()
                    + "（" + report + "）。前若干条原因：" + reasons);
        }
        log.info("全量对账完成 {}", report);
    }

    private void retireUnit(RagIndexJob job) {
        registry.retireUnit(job.getNamespace(), job.getSourceId());
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
