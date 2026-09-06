package com.zhiqu.rag;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.entity.RagIndexGeneration;
import com.zhiqu.entity.RagIndexJob;
import com.zhiqu.entity.RagIndexableUnit;
import com.zhiqu.entity.RagUnitChunk;
import com.zhiqu.entity.RuntimeIssue;
import com.zhiqu.mapper.AiNotebookSourceMapper;
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
    private final RuntimeIssueMapper runtimeIssueMapper;
    private final RuntimeFlagService runtimeFlags;
    private final RagUnitRegistry registry;

    public RagIndexWorker(RagProperties properties,
                          RagIndexJobService jobService,
                          RagClient client,
                          RagIndexGenerationMapper generationMapper,
                          AiNotebookSourceMapper sourceMapper,
                          RuntimeIssueMapper runtimeIssueMapper,
                          RuntimeFlagService runtimeFlags,
                          RagUnitRegistry registry) {
        this.properties = properties;
        this.jobService = jobService;
        this.client = client;
        this.generationMapper = generationMapper;
        this.sourceMapper = sourceMapper;
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
                RagIndexGeneration generation = job.getGenerationId() == null ? null
                        : generationMapper.selectById(job.getGenerationId());
                boolean dead = jobService.handleFailure(job, targetUnitOf(job), generation, e);
                if (dead) reportDeadJob(job, e);
            }
        }
    }

    /**
     * 这条作业指向哪个语料单元 —— 失败记账要往哪一行写。
     *
     * <p><b>必须带上 namespace，不能只拿 {@code job.getSourceId()} 去查。</b>
     * 增量作业复用 {@code source_id} 这一列承载 {@code ref_id}（见
     * {@code RagIndexJobService.enqueueUnit}），所以一条 {@code WIKI_PAGE#7} 的作业失败时，
     * 按资料主键去查会查到<b>资料 7</b> —— 一个毫不相干的实体，然后把它标成 ERROR。
     * 跨命名空间的 id 撞车正是 V29 引入代理主键要消除的东西，这里是它漏掉的最后一处。
     *
     * <p>回归是静默的：被误标的行只是 {@code index_status='ERROR'}，
     * 看起来和一次正常的索引失败没有区别。所以它有自己的用例
     * （{@code RagIndexIntegrationTest.wiki单元的作业失败不会误标同号资料}），
     * 而定位这一步单独成方法，就是为了让那条用例能直接打到它、不必复述一遍判断。
     *
     * <p>没有 namespace 的作业（删除类、代次生命周期）不指向任何单元，返回 null。
     */
    RagIndexableUnit targetUnitOf(RagIndexJob job) {
        return job.getNamespace() == null ? null
                : registry.findUnit(job.getNamespace(), job.getSourceId());
    }

    /**
     * 分发。<b>刻意对 {@link RagOperation} 做增强 switch 且不写 default</b> ——
     * 加一个新的作业类型而忘了在这里处理它，编译当场失败。
     *
     * <p>此前这里是对字符串 switch + default 抛异常，于是「消费端没实现」这件事
     * 只能在**运行时**、且只在那条作业真的被入队时才暴露。实际发生过三次，
     * 三次都是靠人发现的（见 {@link RagOperation} 的类注释）。
     *
     * <p>未知字符串（可能来自更新版本写入的作业）单独处理：不能让它炸掉整个批次循环，
     * 所以照常走 handleFailure 上报，由 protocol_version 的领取谓词负责不领它。
     */
    private void process(RagIndexJob job) {
        RagOperation operation = RagOperation.from(job.getOperation());
        if (operation == null) {
            throw new IllegalArgumentException("Unsupported RAG job operation: " + job.getOperation());
        }
        // **必须是 switch 表达式，不能是 switch 语句。**
        // 实测：Java 只对表达式做穷尽性检查；枚举常量的 switch **语句**漏掉一个常量
        // 照常编译通过。第一版写成语句并在注释里声称「加常量会编译失败」——
        // 扰动（只加枚举常量、不加分支）实测 COMPILE-OK，那句话是假的。
        // 表达式形式下同一个扰动会当场编译错误，这才是把消费端交给了编译器。
        Runnable action = switch (operation) {
            case DELETE_SOURCE -> () -> delete(job, "SOURCE");
            case DELETE_NOTEBOOK -> () -> delete(job, "NOTEBOOK");
            case DELETE_SCOPE -> () -> delete(job, "SCOPE");
            case DELETE_GENERATION -> () -> deleteGeneration(job);
            case REBUILD_GENERATION -> () -> expandGeneration(job);
            case UPSERT_UNIT -> () -> upsertUnit(job);
            case DELETE_UNIT -> () -> retireUnit(job);
            case RECONCILE_UNITS -> () -> reconcileUnits(job);
        };
        action.run();
    }

    /**
     * 删除向量。
     *
     * <p>双删窗口下同一次业务删除会产生两条作业，靠 {@code delete_dialect} 区分：
     * LEGACY 发旧作用域（SOURCE / NOTEBOOK），UNIT 发新作用域（UNIT / SCOPE / NAMESPACE）。
     *
     * <p><b>1B-2 起 UNIT 方言不再是 no-op。</b>Phase 1A 时它是显式跳过的 —— 那时没有
     * unit 格式的向量，让它落到旧作用域上会导致同一份向量被删两次（第二次撞 sidecar 的
     * 墓碑 fence，白白转成 SUPERSEDED 掩盖真实状态）。现在两种格式的向量并存：
     * 新代次的带 {@code namespace/unitId}，旧代次的带 {@code notebookId/sourceId}，
     * 各由对应方言清理，缺哪一半都会留下删不掉的残留。
     *
     * <p>两种方言的 scope 词表不重叠，所以「方言」与「作用域」不是两个自由变量 ——
     * 由 {@code job.operation} 决定作用域、由 {@code delete_dialect} 决定用哪套字段，
     * 不一致时宁可让它响亮地失败（sidecar 会因必填字段缺失回 400），也不静默降级成
     * 更宽的删除。
     */
    private void delete(RagIndexJob job, String scope) {
        boolean unitDialect = RagIndexJobService.DIALECT_UNIT.equals(job.getDeleteDialect());
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("operationId", "job-" + job.getId());
        payload.put("mutationToken", job.getId());
        payload.put("scope", unitDialect ? unitScopeFor(job, scope) : scope);
        if (job.getUserId() != null) payload.put("userId", job.getUserId());
        if (unitDialect) {
            if (job.getUnitId() != null) payload.put("unitId", job.getUnitId());
            if (job.getNamespace() != null) payload.put("namespace", job.getNamespace());
            if (job.getScopeId() != null) payload.put("scopeId", job.getScopeId());
        } else {
            if (job.getNotebookId() != null) payload.put("notebookId", job.getNotebookId());
            if (job.getSourceId() != null) payload.put("sourceId", job.getSourceId());
        }
        if (job.getTargetIndexVersion() != null) payload.put("indexVersion", job.getTargetIndexVersion());
        client.deleteIndex(payload);
    }

    /**
     * LEGACY 的作用域名 → UNIT 方言的作用域名。
     *
     * <p>存在的理由是双删两条作业共享同一个 {@code operation}：一次「删除资料」入队的是
     * 两条 {@code DELETE_SOURCE}，只有 dialect 不同。所以 UNIT 那条要在这里把
     * SOURCE/NOTEBOOK 翻译成 UNIT/SCOPE，而不是在入队时造出第二套 operation ——
     * 后者会让 {@code process()} 的分支表和作业类型词表各翻一倍。
     *
     * <p>不认识的作用域**抛异常而不是原样透传**：透传的话 sidecar 会因为 scope 合法
     * （比如 USER）但字段是另一套而删出一个比预期宽的范围，且没有任何一层会报错。
     */
    private String unitScopeFor(RagIndexJob job, String legacyScope) {
        return switch (legacyScope) {
            case "SOURCE" -> "UNIT";
            case "NOTEBOOK", "SCOPE" -> "SCOPE";
            // 这三个的字段集合与方言无关（只用 userId / indexVersion / collectionName），
            // 所以双删两条发出的 scope 相同、只有 dialect 不同。对 COLLECTION 而言那是把
            // 同一个 collection 删两次 —— 幂等但多余，第二次会撞墓碑转 SUPERSEDED。
            // 今天走不到：这三种作用域只由 DELETE_GENERATION 使用，而它不参与双删。
            case "NAMESPACE", "USER", "COLLECTION" -> legacyScope;
            default -> throw new IllegalArgumentException(
                    "UNIT 方言无法表达的删除作用域: " + legacyScope + "（jobId=" + job.getId() + "）");
        };
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
        if (!registry.refreshUnitIfLive(job.getNamespace(), job.getSourceId())) return;
        indexUnit(job);
    }

    /**
     * 把一个单元的向量写进 sidecar（unit 方言）。
     *
     * <p>切片用 {@link RagUnitChunker#sliceByCodePoints} —— {@code rag_unit_chunk} 的
     * 偏移单位是 <b>Unicode code point</b>，直接 {@code substring} 会在 emoji 与代理对上
     * 错位，而错位的表现是切出半个字符、哈希对不上、单元被无限重建。
     *
     * <p>三个字段的来源是硬约束，不是惯例（见 {@code docs/rag-1b2-stage-e-handoff.md}）：
     * <ul>
     *   <li>{@code mutationToken} = {@code job.getId()} —— 必须与删除侧同一个单调序列。
     *       <b>不要把理由记成「job id 的序等于提交序」</b>：InnoDB 在 INSERT 执行时就分配
     *       自增值，事务可以在之后乱序提交。真正成立的是「两条路径共用同一序列，且两个序
     *       分歧时两种乱序都倒向删除获胜」。时间戳满足前半、不满足后半（时钟回拨会倒向索引），
     *       所以不能换。sidecar 只校验 {@code > 0}，不会替我们发现换源。</li>
     *   <li>{@code contentHash} = 投影行的 {@code canonical_hash} —— 换别的算法就又多一处
     *       「同一份内容两个哈希」。</li>
     *   <li>{@code scopeId} 为空时<b>整个键不写</b> —— Chroma 的 metadata 不接受 None。</li>
     * </ul>
     *
     * <p><b>{@code finalBatch} 只有最后一批为 true。</b>每批都传 false 是合法载荷、
     * sidecar 照收，而它的 {@code _finalize_source} 只在为真时跑 —— 于是上一次索引留下的
     * 过期向量永不清理、继续参与检索命中，且 operation 一直挂着不终结。
     * 这条只有 chunk 数超过 {@link #PARENT_CHUNKS_PER_BATCH} 的多批次夹具验得到，
     * 单批次用例恒绿。
     */
    private void indexUnit(RagIndexJob job) {
        RagUnitRegistry.IndexableUnitSnapshot snapshot =
                registry.loadForIndexing(job.getNamespace(), job.getSourceId());
        if (snapshot == null) return;

        for (RagIndexGeneration generation : targetGenerations(job)) {
            int written = pushUnitVectors(job, snapshot, generation);
            // **记账必须发生。**1b 只发向量不记账，后果不在这里，而在 cutover runbook 第 9 步：
            // 门禁按投影表数分母、按状态行数分子，分子恒为 0 → 覆盖率永远够不到 → activate 抛异常。
            jobService.markUnitIndexedWithLease(job, snapshot.unit(), generation, written);
        }
    }

    /**
     * 本次要写进哪些代次。
     *
     * <p>两种作业形态，刻意不同：
     * <ul>
     *   <li><b>代次展开产生的作业带 {@code generationId}</b> —— 只写那一个，
     *       否则一次重建会顺手把向量灌进正在服役的旧代次。</li>
     *   <li><b>业务钩子产生的增量作业不带代次</b> —— 写进当时<b>所有</b>在建/在用的代次。
     *       只挑一个（比如「id 最大的那个」）会在重建窗口里出错：新代次还在 BUILDING，
     *       用户这次编辑就只进了新代次，而当前服役的 ACTIVE 代次检索不到它 ——
     *       表现是「刚改完的内容搜不到」，且要等新代次启用后才自愈。</li>
     * </ul>
     */
    private List<RagIndexGeneration> targetGenerations(RagIndexJob job) {
        if (job.getGenerationId() != null) {
            RagIndexGeneration generation = generationMapper.selectById(job.getGenerationId());
            return generation != null
                    && RagIndexJobService.LIVE_GENERATION_STATUSES.contains(generation.getStatus())
                    ? List.of(generation) : List.of();
        }
        return generationMapper.selectList(new LambdaQueryWrapper<RagIndexGeneration>()
                .in(RagIndexGeneration::getStatus, RagIndexJobService.LIVE_GENERATION_STATUSES)
                .orderByAsc(RagIndexGeneration::getId));
    }

    /** 把一个单元的全部父块分批推给 sidecar，返回写入的向量数。 */
    private int pushUnitVectors(RagIndexJob job, RagUnitRegistry.IndexableUnitSnapshot snapshot,
                                RagIndexGeneration generation) {
        List<RagUnitChunk> chunks = snapshot.chunks();
        String text = snapshot.canonicalText();
        int written = 0;
        int batchNo = 0;
        for (int start = 0; start < chunks.size(); start += PARENT_CHUNKS_PER_BATCH) {
            assertLease(job);
            int end = Math.min(chunks.size(), start + PARENT_CHUNKS_PER_BATCH);
            List<Map<String, Object>> payloadChunks = new ArrayList<>();
            for (RagUnitChunk chunk : chunks.subList(start, end)) {
                payloadChunks.add(Map.of(
                        "chunkId", chunk.getId(),
                        "chunkIndex", chunk.getChunkIndex(),
                        "content", RagUnitChunker.sliceByCodePoints(
                                text, chunk.getCharStart(), chunk.getCharEnd())
                ));
            }
            Map<String, Object> payload = new LinkedHashMap<>();
            // **operationId 必须带代次。**sidecar 按 (operationId, batchNo) 做幂等键，
            // 同一条作业写两个代次时批号会从 0 重来一遍 —— 不带代次的话第二个代次的每一批
            // 都会被当成「这批已经收过了」而跳过，且它返回成功。
            payload.put("operationId", "job-" + job.getId() + "-g" + generation.getId());
            payload.put("mutationToken", job.getId());
            payload.put("userId", snapshot.unit().getUserId());
            payload.put("namespace", snapshot.unit().getNamespace());
            payload.put("unitId", snapshot.unit().getId());
            if (snapshot.unit().getScopeId() != null) {
                payload.put("scopeId", snapshot.unit().getScopeId());
            }
            payload.put("contentHash", snapshot.unit().getCanonicalHash());
            payload.put("indexVersion", generation.getIndexVersion());
            payload.put("collectionName", generation.getCollectionName());
            payload.put("batchNo", batchNo++);
            payload.put("finalBatch", end >= chunks.size());
            payload.put("chunks", payloadChunks);
            Map<String, Object> response = client.indexSource(payload);
            written += intValue(response.get("written"));
        }
        return written;
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
