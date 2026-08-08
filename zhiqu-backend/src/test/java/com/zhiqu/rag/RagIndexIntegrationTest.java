package com.zhiqu.rag;

import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.entity.RagIndexGeneration;
import com.zhiqu.entity.RagIndexJob;
import com.zhiqu.entity.RagIndexableUnit;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import com.zhiqu.mapper.RagIndexGenerationMapper;
import com.zhiqu.mapper.RagIndexJobMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class RagIndexIntegrationTest {
    static {
        System.setProperty("api.version", System.getProperty("api.version", "1.40"));
    }

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_rag_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;
    @Autowired private TransactionTemplate transactions;
    @Autowired private RagIndexJobService jobService;
    @Autowired private SourceScopeResolver scopeResolver;
    @Autowired private AiNotebookSourceMapper sourceMapper;
    @Autowired private RagIndexGenerationMapper generationMapper;
    @Autowired private RagIndexJobMapper jobMapper;
    @Autowired private RagAdminService adminService;
    @Autowired private RagUnitRegistry registry;
    @Autowired private RagIndexWorker worker;

    private Long userId;
    private Long notebookId;
    private Long sourceId;
    private Long generationId;

    @BeforeEach
    void prepareData() {
        // 用例隔离：这些集成用例共享同一测试库。prepareData 每次都新建一个 ACTIVE generation
        // 却不清理旧的，跑多个用例后 ACTIVE generation / PENDING job 会累积，导致 enqueueSource
        // 依 active generation 数多建 job，PENDING 计数从 1 变 2（legacyReadySourceGetsHashAndDurableJob 失败）。
        // 每个用例开始前先清空遗留状态：先删叶子表 job / state，再把旧 ACTIVE generation 退役。
        jdbc.update("DELETE FROM rag_index_job");
        jdbc.update("DELETE FROM rag_source_index_state");
        // 投影表同样要清：代次展开现在枚举它，残留的单元会被算进别的用例的分母。
        jdbc.update("DELETE FROM rag_unit_chunk");
        jdbc.update("DELETE FROM rag_indexable_unit");
        jdbc.update("UPDATE rag_index_generation SET status='RETIRED' WHERE status='ACTIVE'");
        String suffix = UUID.randomUUID().toString().replace("-", "");
        jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES(?,?,?,'USER',0)",
                "rag_" + suffix, "test-password", "RAG Test");
        userId = jdbc.queryForObject("SELECT id FROM sys_user WHERE username=?", Long.class, "rag_" + suffix);
        jdbc.update("INSERT INTO ai_notebook(user_id,title,status,deleted) VALUES(?,?,'ACTIVE',0)", userId, "RAG Notebook");
        notebookId = jdbc.queryForObject("SELECT id FROM ai_notebook WHERE user_id=? ORDER BY id DESC LIMIT 1", Long.class, userId);
        jdbc.update("INSERT INTO ai_notebook_source(user_id,notebook_id,source_type,title,status,index_status,deleted) " +
                        "VALUES(?,?,'TEXT','legacy.txt','READY','NOT_INDEXED',0)", userId, notebookId);
        sourceId = jdbc.queryForObject("SELECT id FROM ai_notebook_source WHERE notebook_id=? ORDER BY id DESC LIMIT 1", Long.class, notebookId);
        jdbc.update("INSERT INTO ai_source_chunk(source_id,chunk_index,content) VALUES(?,0,?)", sourceId, "第一段资料内容");
        jdbc.update("INSERT INTO rag_index_generation(index_version,collection_name,status) VALUES(?,?,'ACTIVE')",
                "bge-small-zh-v1.5@test", "rag_test_" + suffix);
        generationId = jdbc.queryForObject("SELECT id FROM rag_index_generation ORDER BY id DESC LIMIT 1", Long.class);
    }

    /**
     * 把一份资料登记进投影表并返回它的投影行。
     *
     * <p>1B-2 起代次展开枚举的是 {@code rag_indexable_unit} 而不是 {@code ai_notebook_source}，
     * 所以「库里有一份 READY 资料」不再等于「展开时会为它排一条作业」——
     * 中间多了一次登记。用例必须显式走这一步，否则展开出来是空的，
     * 而空展开在每一条断言上都表现得像「还没轮到它」。
     */
    private RagIndexableUnit registerUnit(Long refId) {
        assertTrue(registry.refreshUnitIfLive(RagNamespace.NOTEBOOK_SOURCE, refId),
                "源实体是 READY 的，补登记就该成功");
        return registry.findUnit(RagNamespace.NOTEBOOK_SOURCE, refId);
    }

    @Test
    void v24SchemaWasApplied() {
        Integer columns = jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.columns " +
                "WHERE table_schema=DATABASE() AND table_name='ai_notebook_source' " +
                "AND column_name IN ('content_hash','index_status','index_version','index_error','indexed_at')", Integer.class);
        assertEquals(5, columns);
        Integer tables = jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() " +
                "AND table_name IN ('rag_index_generation','rag_source_index_state','rag_index_job')", Integer.class);
        assertEquals(3, tables);
    }

    @Test
    void v26LeaseFencingSchemaWasApplied() {
        Integer columns = jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.columns " +
                "WHERE table_schema=DATABASE() AND table_name='rag_index_job' AND column_name='lease_version'",
                Integer.class);
        assertEquals(1, columns);
    }

    @Test
    void v28ProtocolAndDialectSchemaWasApplied() {
        Integer columns = jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.columns " +
                "WHERE table_schema=DATABASE() AND table_name='rag_index_job' " +
                "AND column_name IN ('protocol_version','unit_id','namespace','delete_dialect','scope_kind','scope_id')",
                Integer.class);
        assertEquals(6, columns);

        // protocol_version 必须 NOT NULL DEFAULT 1：存量作业要被当成旧协议，
        // 否则升级瞬间队列里的老作业会因为 protocol_version 为 NULL 而谁都领不走。
        assertEquals("NO", jdbc.queryForObject("SELECT is_nullable FROM information_schema.columns " +
                "WHERE table_schema=DATABASE() AND table_name='rag_index_job' AND column_name='protocol_version'",
                String.class));
        assertEquals("1", jdbc.queryForObject("SELECT column_default FROM information_schema.columns " +
                "WHERE table_schema=DATABASE() AND table_name='rag_index_job' AND column_name='protocol_version'",
                String.class));

        Integer index = jdbc.queryForObject("SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics " +
                "WHERE table_schema=DATABASE() AND table_name='rag_index_job' " +
                "AND index_name='idx_rag_job_protocol_claim'", Integer.class);
        assertEquals(1, index);
    }

    /**
     * 领取查询的两个过滤：协议版本（回滚后旧 worker 不误领新作业）与 REBUILD_ONLY
     * （cutover 第 8 步只放行代次重建，业务侧增量一律不领）。
     */
    @Test
    void claimFiltersByProtocolVersionAndRebuildOnlyMode() {
        jdbc.update("INSERT INTO rag_index_job (dedupe_key, operation, protocol_version, status) VALUES " +
                "(?,'UPSERT_SOURCE',1,'PENDING'),(?,'DELETE_SOURCE',1,'PENDING')," +
                "(?,'REBUILD_GENERATION',1,'PENDING'),(?,'UPSERT_UNIT',2,'PENDING')",
                "p-" + UUID.randomUUID(), "p-" + UUID.randomUUID(),
                "p-" + UUID.randomUUID(), "p-" + UUID.randomUUID());

        LocalDateTime now = LocalDateTime.now();
        List<String> normal = jobMapper.lockDueJobs(20, now, now.minusMinutes(5), 1, false, true)
                .stream().map(RagIndexJob::getOperation).toList();
        assertTrue(normal.contains("UPSERT_SOURCE"));
        assertTrue(normal.contains("DELETE_SOURCE"));
        assertFalse(normal.contains("UPSERT_UNIT"), "v2 作业不能被 v1 worker 领走");

        List<String> rebuildOnly = jobMapper.lockDueJobs(20, now, now.minusMinutes(5), 1, true, true)
                .stream().map(RagIndexJob::getOperation).toList();
        assertTrue(rebuildOnly.contains("REBUILD_GENERATION"));
        assertTrue(rebuildOnly.contains("UPSERT_SOURCE"));
        assertFalse(rebuildOnly.contains("DELETE_SOURCE"), "REBUILD_ONLY 下业务侧删除不得被领走");
    }

    @Test
    void v29ProjectionSchemaWasApplied() {
        Integer tables = jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.tables " +
                "WHERE table_schema=DATABASE() AND table_name IN ('rag_indexable_unit','rag_unit_chunk')",
                Integer.class);
        assertEquals(2, tables);

        // source_id 必须已改为可空：Wiki / 会话 unit 的 state 行没有 source_id。
        assertEquals("YES", jdbc.queryForObject("SELECT is_nullable FROM information_schema.columns " +
                "WHERE table_schema=DATABASE() AND table_name='rag_source_index_state' AND column_name='source_id'",
                String.class));

        // 两个唯一键必须并存：旧键是回滚生命线，回退到旧 JAR 时仍靠它保证 Notebook 行唯一。
        Integer uniqueKeys = jdbc.queryForObject("SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics " +
                "WHERE table_schema=DATABASE() AND table_name='rag_source_index_state' " +
                "AND index_name IN ('uk_rag_source_generation','uk_rag_source_state_unit')", Integer.class);
        assertEquals(2, uniqueKeys);
    }

    /**
     * Notebook 行与 Wiki 行必须能在同一张 state 表里共存。
     *
     * <p>靠的是 MySQL 唯一键允许多个 NULL：Wiki 行 source_id 为 NULL 不撞旧键，
     * Notebook 行 unit_id 为 NULL 不撞新键。这条性质一旦失效，投影表改造会在
     * 第一次给 Wiki 建索引时撞 1062，而不是等到检索阶段才暴露。
     */
    @Test
    void notebookAndWikiStateRowsCoexistUnderBothUniqueKeys() {
        jdbc.update("INSERT INTO rag_indexable_unit(user_id,namespace,ref_id,scope_kind,title,source_type) " +
                "VALUES(?,?,?,?,?,?)", userId, "WIKI_PAGE", 4242L, "WIKI_TREE", "共存用例", "WIKI_PAGE");
        Long unitId = jdbc.queryForObject(
                "SELECT id FROM rag_indexable_unit WHERE namespace='WIKI_PAGE' AND ref_id=4242", Long.class);

        jdbc.update("INSERT INTO rag_source_index_state(source_id,unit_id,generation_id,index_version,content_hash,status) " +
                "VALUES(?,NULL,?,?,?,'INDEXED')", sourceId, generationId, "v-coexist", "a".repeat(64));
        jdbc.update("INSERT INTO rag_source_index_state(source_id,unit_id,generation_id,index_version,content_hash,status) " +
                "VALUES(NULL,?,?,?,?,'INDEXED')", unitId, generationId, "v-coexist", "b".repeat(64));

        assertEquals(2, jdbc.queryForObject(
                "SELECT COUNT(*) FROM rag_source_index_state WHERE generation_id=?", Integer.class, generationId));
    }

    @Test
    void outboxWriteRollsBackWithSourceTransaction() {
        assertThrows(IllegalStateException.class, () -> transactions.executeWithoutResult(status -> {
            jobService.enqueueSource(sourceMapper.selectById(sourceId));
            throw new IllegalStateException("force rollback");
        }));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM rag_index_job WHERE source_id=?", Integer.class, sourceId));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM rag_source_index_state WHERE source_id=?", Integer.class, sourceId));
        assertEquals("NOT_INDEXED", jdbc.queryForObject("SELECT index_status FROM ai_notebook_source WHERE id=?", String.class, sourceId));
    }

    /**
     * 资料入队走 unit 方言，且<b>入队时不记账</b>。
     *
     * <p>1B-2 之前这里还断言「入队后立刻有一条 PENDING 状态行」。那条性质连同它的实现
     * 一起没了，不是被漏掉的：增量作业不带代次，<b>要写进哪些代次是执行时才知道的</b>
     * （见 {@code RagIndexWorker.targetGenerations}）。入队时凭空挑一个代次写 PENDING，
     * 就会在重建窗口里写错对象 —— 而错了不会有任何异常。
     *
     * <p>所以这里把「零状态行」<b>正面断言</b>出来，而不是删掉那一行。
     * 删掉的话，将来有人「顺手」在入队时补一条状态行，没有任何东西会红。
     */
    @Test
    void readySourceGetsHashAndDurableUnitJob() {
        AiNotebookSource source = sourceMapper.selectById(sourceId);
        jobService.enqueueSource(source);
        String hash = jdbc.queryForObject("SELECT content_hash FROM ai_notebook_source WHERE id=?", String.class, sourceId);
        assertNotNull(hash);
        assertEquals(64, hash.length());
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM rag_index_job WHERE source_id=? AND status='PENDING' " +
                "AND operation='UPSERT_UNIT' AND namespace='NOTEBOOK_SOURCE'", Integer.class, sourceId));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM rag_source_index_state WHERE generation_id=?",
                Integer.class, generationId),
                "记账发生在 worker 真的写完向量时，不在入队时 —— 入队侧还不知道会写进哪几个代次");
    }

    @Test
    void staleRunningJobCanBeReclaimed() {
        jdbc.update("INSERT INTO rag_index_job(dedupe_key,operation,generation_id,user_id,notebook_id,source_id,status,attempts,locked_at,locked_by) " +
                        "VALUES(?,?,?,?,?,?,'RUNNING',2,?,?)", "stale:" + UUID.randomUUID(), "UPSERT_UNIT",
                generationId, userId, notebookId, sourceId, LocalDateTime.now().minusMinutes(6), "dead-worker");
        // Earlier test cases intentionally leave durable pending jobs behind. Claim a full
        // worker-sized window so this assertion does not depend on JUnit execution order.
        List<RagIndexJob> claimed = jobService.claimDueJobs(20, "replacement-worker", true);
        RagIndexJob job = claimed.stream().filter(item -> sourceId.equals(item.getSourceId())).findFirst().orElseThrow();
        assertEquals(3, job.getAttempts());
        assertEquals("replacement-worker", job.getLockedBy());
        assertEquals(1L, job.getLeaseVersion());
    }

    @Test
    void staleWorkerCannotOverwriteReclaimedTerminalState() {
        String dedupe = "lease-race:" + UUID.randomUUID();
        jdbc.update("INSERT INTO rag_index_job(dedupe_key,operation,user_id,notebook_id,source_id,status,attempts) " +
                        "VALUES(?,?,?,?,?,'PENDING',0)", dedupe, "DELETE_SOURCE", userId, notebookId, sourceId);
        Long jobId = jdbc.queryForObject("SELECT id FROM rag_index_job WHERE dedupe_key=?", Long.class, dedupe);

        RagIndexJob firstLease = jobService.claimDueJobs(20, "worker-1", true).stream()
                .filter(item -> jobId.equals(item.getId())).findFirst().orElseThrow();
        jdbc.update("UPDATE rag_index_job SET locked_at=? WHERE id=?",
                LocalDateTime.now().minusMinutes(6), jobId);
        RagIndexJob secondLease = jobService.claimDueJobs(20, "worker-2", true).stream()
                .filter(item -> jobId.equals(item.getId())).findFirst().orElseThrow();

        assertNotEquals(firstLease.getLeaseVersion(), secondLease.getLeaseVersion());
        assertTrue(jobService.complete(secondLease));
        assertFalse(jobService.complete(firstLease));
        assertFalse(jobService.handleFailure(firstLease, null, null,
                new IllegalStateException("late failure from stale worker")));

        RagIndexJob stored = jobMapper.selectById(jobId);
        assertEquals("COMPLETED", stored.getStatus());
        assertEquals(secondLease.getLeaseVersion(), stored.getLeaseVersion());
        assertEquals(null, stored.getLastError());
    }

    @Test
    void leaseLostAfterRenewalCannotMarkSourceIndexed() {
        RagIndexGeneration generation = createBuildingGeneration();
        RagIndexableUnit unit = registerUnit(sourceId);
        jobService.enqueueGenerationUnits(generation);
        RagIndexJob firstLease = claimPendingJob(generation.getId(), "UPSERT_UNIT", "index-worker-1");

        RagIndexJob secondLease = renewExpireAndReclaim(firstLease, "index-worker-2");

        assertThrows(IllegalStateException.class,
                () -> jobService.markUnitIndexedWithLease(firstLease, unit, generation, 7));
        assertEquals("PENDING", jdbc.queryForObject("SELECT status FROM rag_source_index_state " +
                "WHERE unit_id=? AND generation_id=?", String.class, unit.getId(), generation.getId()));
        assertEquals("NOT_INDEXED", sourceMapper.selectById(sourceId).getIndexStatus());
        assertEquals("BUILDING", generationMapper.selectById(generation.getId()).getStatus());
        assertEquals("RUNNING", jobMapper.selectById(secondLease.getId()).getStatus());
    }

    @Test
    void leaseLostAfterRenewalCannotExpandGeneration() {
        RagIndexGeneration generation = createBuildingGeneration();
        insertGenerationJob(generation.getId(), "REBUILD_GENERATION");
        RagIndexJob firstLease = claimPendingJob(generation.getId(), "REBUILD_GENERATION", "expand-worker-1");

        renewExpireAndReclaim(firstLease, "expand-worker-2");

        assertThrows(IllegalStateException.class, () -> jobService.expandGenerationWithLease(firstLease));
        assertEquals(0, generationMapper.selectById(generation.getId()).getExpectedSourceCount());
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM rag_source_index_state WHERE generation_id=?",
                Integer.class, generation.getId()));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM rag_index_job " +
                "WHERE generation_id=? AND operation='UPSERT_UNIT'", Integer.class, generation.getId()));
    }

    @Test
    void leaseLostAfterRenewalCannotClaimGenerationForPurge() {
        RagIndexGeneration generation = createBuildingGeneration();
        jdbc.update("UPDATE rag_index_generation SET status='RETIRED', retired_at=NOW() WHERE id=?",
                generation.getId());
        insertGenerationJob(generation.getId(), "DELETE_GENERATION");
        RagIndexJob firstLease = claimPendingJob(generation.getId(), "DELETE_GENERATION", "purge-claim-worker-1");

        renewExpireAndReclaim(firstLease, "purge-claim-worker-2");

        assertThrows(IllegalStateException.class,
                () -> jobService.prepareGenerationPurgeWithLease(firstLease));
        assertEquals("RETIRED", generationMapper.selectById(generation.getId()).getStatus());
    }

    @Test
    void leaseLostAfterRenewalCannotMarkGenerationPurged() {
        RagIndexGeneration generation = createBuildingGeneration();
        jdbc.update("UPDATE rag_index_generation SET status='PURGING' WHERE id=?", generation.getId());
        insertGenerationJob(generation.getId(), "DELETE_GENERATION");
        RagIndexJob firstLease = claimPendingJob(generation.getId(), "DELETE_GENERATION", "purge-worker-1");

        renewExpireAndReclaim(firstLease, "purge-worker-2");

        assertThrows(IllegalStateException.class,
                () -> jobService.markGenerationPurgedWithLease(firstLease));
        assertEquals("PURGING", generationMapper.selectById(generation.getId()).getStatus());
    }

    @Test
    void deletedSourceImmediatelyLeavesRetrievalScope() {
        // resolve() 的返回类型由 List<AiNotebookSource> 变为 ScopeSelection，故 size() → notebookSourceCount()。
        // 这是纯机械的访问器改名：期望值 1 未变、断言语义未变。没有把 size() 保留成兼容别名，
        // 是因为「size 数的是什么」正是口径悄悄漂移的入口——它在调用点上看不出来。
        assertEquals(1, scopeResolver.resolve(userId, notebookId, List.of(sourceId)).notebookSourceCount());
        sourceMapper.deleteById(sourceId);
        BusinessException error = assertThrows(BusinessException.class,
                () -> scopeResolver.resolve(userId, notebookId, List.of(sourceId)));
        assertTrue(error.getMessage().contains("不存在") || error.getMessage().contains("不可用"));
        assertTrue(scopeResolver.resolve(userId, notebookId, List.of()).isEmpty());
    }

    @Test
    void deadJobMovesBuildingGenerationToFailed() {
        RagIndexGeneration generation = createBuildingGeneration();
        RagIndexableUnit unit = registerUnit(sourceId);
        jobService.enqueueGenerationUnits(generation);
        RagIndexJob job = jobMapper.selectOne(new com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<RagIndexJob>()
                .eq(RagIndexJob::getGenerationId, generation.getId())
                .eq(RagIndexJob::getUnitId, unit.getId())
                .last("LIMIT 1"));
        job = claimForFailure(job.getId(), 8, "dead-worker");

        assertTrue(jobService.handleFailure(job, unit, generation, new IllegalStateException("forced failure")));

        assertEquals("DEAD", jobMapper.selectById(job.getId()).getStatus());
        assertEquals("FAILED", generationMapper.selectById(generation.getId()).getStatus());
    }

    @Test
    void concurrentFinalDeadJobsConvergeGenerationToFailed() throws Exception {
        RagIndexGeneration generation = createBuildingGeneration();
        Long secondSourceId = createReadySource("second.txt", "second source content");
        registerUnit(sourceId);
        registerUnit(secondSourceId);
        jobService.enqueueGenerationUnits(generation);
        List<RagIndexJob> jobs = jobMapper.selectList(
                new com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<RagIndexJob>()
                        .eq(RagIndexJob::getGenerationId, generation.getId())
                        .in(RagIndexJob::getSourceId, sourceId, secondSourceId)
                        .orderByAsc(RagIndexJob::getId));
        assertEquals(2, jobs.size());
        jobs.replaceAll(job -> claimForFailure(job.getId(), 8, "dead-worker-" + job.getId()));

        ExecutorService executor = Executors.newFixedThreadPool(2);
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            List<Future<Boolean>> results = jobs.stream().map(job -> executor.submit(() -> {
                ready.countDown();
                assertTrue(start.await(10, TimeUnit.SECONDS));
                return jobService.handleFailure(jobMapper.selectById(job.getId()),
                        registry.findUnit(RagNamespace.NOTEBOOK_SOURCE, job.getSourceId()),
                        generationMapper.selectById(generation.getId()),
                        new IllegalStateException("concurrent forced failure"));
            })).toList();
            assertTrue(ready.await(10, TimeUnit.SECONDS));
            start.countDown();
            for (Future<Boolean> result : results) assertTrue(result.get(20, TimeUnit.SECONDS));
        } finally {
            executor.shutdownNow();
        }

        assertEquals(2, jdbc.queryForObject("SELECT COUNT(*) FROM rag_index_job " +
                "WHERE generation_id=? AND status='DEAD'", Integer.class, generation.getId()));
        assertEquals("FAILED", generationMapper.selectById(generation.getId()).getStatus());
    }

    @Test
    void retryRejectsDeadJobFromFailedGeneration() {
        RagIndexGeneration generation = createBuildingGeneration();
        RagIndexableUnit unit = registerUnit(sourceId);
        jobService.enqueueGenerationUnits(generation);
        RagIndexJob job = jobMapper.selectOne(
                new com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<RagIndexJob>()
                        .eq(RagIndexJob::getGenerationId, generation.getId())
                        .eq(RagIndexJob::getUnitId, unit.getId()).last("LIMIT 1"));
        job = claimForFailure(job.getId(), 8, "retry-dead-worker");
        assertTrue(jobService.handleFailure(job, unit, generation, new IllegalStateException("forced failure")));
        Long failedJobId = job.getId();

        BusinessException error = assertThrows(BusinessException.class, () -> adminService.retry(failedJobId));

        assertTrue(error.getMessage().contains("索引代次已失败"));
        assertEquals("DEAD", jobMapper.selectById(failedJobId).getStatus());
        assertEquals("FAILED", generationMapper.selectById(generation.getId()).getStatus());
    }

    @Test
    void generationExpansionPreservesCurrentIndexedState() {
        RagIndexGeneration generation = createBuildingGeneration();
        RagIndexableUnit unit = registerUnit(sourceId);
        jobService.enqueueGenerationUnits(generation);
        jdbc.update("UPDATE rag_source_index_state SET status='INDEXED', vector_count=3 " +
                "WHERE unit_id=? AND generation_id=?", unit.getId(), generation.getId());
        jdbc.update("UPDATE rag_index_job SET status='COMPLETED', completed_at=NOW() " +
                "WHERE unit_id=? AND generation_id=?", unit.getId(), generation.getId());

        jobService.enqueueGenerationUnits(generationMapper.selectById(generation.getId()));

        assertEquals("INDEXED", jdbc.queryForObject("SELECT status FROM rag_source_index_state " +
                "WHERE unit_id=? AND generation_id=?", String.class, unit.getId(), generation.getId()));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM rag_index_job WHERE source_id=? AND generation_id=?",
                Integer.class, sourceId, generation.getId()));
        assertEquals(1, generationMapper.selectById(generation.getId()).getIndexedSourceCount());
    }

    @Test
    void purgingGenerationCannotBeReactivated() {
        jdbc.update("UPDATE rag_index_generation SET status='RETIRED', retired_at=NOW() WHERE id=?", generationId);
        assertTrue(jobService.claimGenerationForPurge(generationId));
        assertEquals("PURGING", generationMapper.selectById(generationId).getStatus());

        BusinessException error = assertThrows(BusinessException.class, () -> adminService.activate(generationId));

        assertTrue(error.getMessage().contains("已构建完成"));
        assertEquals("PURGING", generationMapper.selectById(generationId).getStatus());
    }

    @Test
    void failedGenerationCanBeDiscardedAndPurged() {
        RagIndexGeneration generation = createBuildingGeneration();
        jdbc.update("UPDATE rag_index_generation SET status='FAILED', completed_at=NOW() WHERE id=?",
                generation.getId());

        Map<String, Object> discarded = adminService.discardFailedGeneration(generation.getId());

        assertEquals("PURGING", discarded.get("status"));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM rag_index_job " +
                "WHERE generation_id=? AND operation='DELETE_GENERATION' AND status='PENDING'",
                Integer.class, generation.getId()));
        jobService.markGenerationPurged(generation.getId());
        assertEquals("PURGED", generationMapper.selectById(generation.getId()).getStatus());
    }

    private RagIndexJob claimForFailure(Long jobId, int attempts, String workerId) {
        jdbc.update("UPDATE rag_index_job SET status='RUNNING', attempts=?, locked_at=NOW(), locked_by=?, " +
                "lease_version=lease_version+1 WHERE id=?", attempts, workerId, jobId);
        return jobMapper.selectById(jobId);
    }

    private void insertGenerationJob(Long targetGenerationId, String operation) {
        jdbc.update("INSERT INTO rag_index_job(dedupe_key,operation,generation_id,status,attempts) " +
                        "VALUES(?,?,?,'PENDING',0)",
                operation.toLowerCase() + ":" + UUID.randomUUID(), operation, targetGenerationId);
    }

    private RagIndexJob claimPendingJob(Long targetGenerationId, String operation, String workerId) {
        return jobService.claimDueJobs(20, workerId, true).stream()
                .filter(job -> targetGenerationId.equals(job.getGenerationId()) && operation.equals(job.getOperation()))
                .findFirst().orElseThrow();
    }

    private RagIndexJob renewExpireAndReclaim(RagIndexJob firstLease, String replacementWorker) {
        assertTrue(jobService.renewLease(firstLease));
        jdbc.update("UPDATE rag_index_job SET locked_at=? WHERE id=?",
                LocalDateTime.now().minusMinutes(6), firstLease.getId());
        RagIndexJob secondLease = jobService.claimDueJobs(20, replacementWorker, true).stream()
                .filter(job -> firstLease.getId().equals(job.getId())).findFirst().orElseThrow();
        assertNotEquals(firstLease.getLeaseVersion(), secondLease.getLeaseVersion());
        return secondLease;
    }

    // ── 跨命名空间 id 撞车（1B-2 / 1c）────────────────────────────────────

    /**
     * <b>作业失败时不得按 {@code source_id} 当资料主键去定位实体。</b>
     *
     * <p>增量作业复用 {@code source_id} 这一列承载 {@code ref_id}（见 {@code enqueueUnit}），
     * 所以一条 {@code WIKI_PAGE#7} 的作业失败时，按资料主键去查会查到<b>资料 7</b> ——
     * 一个毫不相干的实体，然后把它标成 ERROR。V29 引入代理主键正是为了消除这类撞车
     * （「资料 7 与 Wiki 页 7 在向量库里必须是两个东西」），这里是它漏掉的最后一处。
     *
     * <p>回归是<b>静默</b>的：被误标的资料只是 {@code index_status='ERROR'}，
     * 看起来和一次正常的索引失败没有区别。
     *
     * <p>撞车靠<b>显式指定自增主键</b>构造 —— MySQL 接受往 AUTO_INCREMENT 列写明确值，
     * 只会把计数器顶上去。（一度以为「id 是自增的所以构造不了」，那是错的。）
     */
    @Test
    void wiki单元的作业失败不会误标同号资料() {
        long collidingId = 900000L + (System.nanoTime() % 90000L);
        jdbc.update("INSERT INTO ai_notebook_source(id,user_id,notebook_id,source_type,title,status," +
                        "index_status,deleted) VALUES(?,?,?,'TEXT','同号资料','READY','NOT_INDEXED',0)",
                collidingId, userId, notebookId);
        jdbc.update("INSERT INTO ai_source_chunk(source_id,chunk_index,content) VALUES(?,0,?)",
                collidingId, "同号资料的正文");
        jdbc.update("INSERT INTO user_knowledge_page(id,user_id,page_type,title,encrypted_content," +
                        "encryption_version,version,sort_order,pinned,deleted) " +
                        "VALUES(?,?,'NOTE','同号Wiki页',?,'v0',0,0,0,0)",
                collidingId, userId, "同号 Wiki 页的正文");
        // 两个命名空间各登记一个单元，ref_id 相同 —— 这正是 V29 的代理主键要区分的两件东西。
        RagIndexableUnit sourceUnit = registerUnit(collidingId);
        assertTrue(registry.refreshUnitIfLive(RagNamespace.WIKI_PAGE, collidingId));
        RagIndexableUnit pageUnit = registry.findUnit(RagNamespace.WIKI_PAGE, collidingId);
        assertNotEquals(sourceUnit.getId(), pageUnit.getId(), "前提：两个单元必须是不同的行");

        jdbc.update("INSERT INTO rag_index_job(dedupe_key,operation,protocol_version,user_id,namespace," +
                        "source_id,status,attempts,locked_at,locked_by,lease_version) " +
                        "VALUES(?,'UPSERT_UNIT',1,?,'WIKI_PAGE',?,'RUNNING',8,NOW(),'collide-worker',1)",
                "collide:" + UUID.randomUUID(), userId, collidingId);
        RagIndexJob job = jobMapper.selectOne(new com.baomidou.mybatisplus.core.conditions.query
                .LambdaQueryWrapper<RagIndexJob>().eq(RagIndexJob::getLockedBy, "collide-worker"));

        jobService.handleFailure(job, worker.targetUnitOf(job), null,
                new IllegalStateException("forced failure"));

        assertEquals("ERROR", indexStatusOfUnit(pageUnit.getId()), "失败该记在这条作业指向的单元上");
        assertEquals("NOT_INDEXED", indexStatusOfUnit(sourceUnit.getId()),
                "同号资料与这条 WIKI_PAGE 作业毫无关系，不得被它的失败标成 ERROR");
    }

    private String indexStatusOfUnit(Long unitId) {
        return jdbc.queryForObject("SELECT index_status FROM rag_indexable_unit WHERE id=?", String.class, unitId);
    }

    // ── 启用门禁的三条性质（1B-2 / 1c）────────────────────────────────────

    /**
     * <b>{@code unit_id} 为空的遗留行不得进入 {@code byUnit}。</b>
     *
     * <p>这条用例是被扰动逼出来的：一开始我在别处的注释里判断这个过滤「是防御性的、不承重」，
     * 依据是当前实现按 {@code unitId} 逐条取值、空键取不到。那个判断在当时成立，
     * 而它会<b>因为别处的实现改变而失效</b>，不是因为有人改了它 ——
     * 分子一旦从「逐条匹配」换成「数状态行」，这句过滤立刻是唯一挡住遗留行的东西。
     *
     * <p>所以它需要一条属于自己的用例，而不是一句更准的注释：
     * 有了这条，下次谁把匹配换成计数、顺手删掉「看着多余」的过滤，第一级判定就会红。
     */
    @Test
    void 遗留的source状态行不进入按单元索引的映射() {
        RagIndexableUnit unit = registerUnit(sourceId);
        jdbc.update("INSERT INTO rag_source_index_state(source_id,unit_id,generation_id,index_version," +
                        "content_hash,status,vector_count) VALUES(?,NULL,?,?,?,'INDEXED',3)",
                sourceId, generationId, "bge-small-zh-v1.5@test", unit.getCanonicalHash());

        Map<Long, com.zhiqu.entity.RagSourceIndexState> byUnit = jobService.unitStates(generationId);

        assertTrue(byUnit.isEmpty(),
                "遗留行没有 unit_id，混进来只会落在一个 null 键上；等分子改成计数时它就成了假覆盖");
        assertFalse(byUnit.containsKey(null), "null 键是 HashMap 允许的，所以它不会以异常的形式暴露");
    }

    /**
     * <b>空分母不得放行。</b>
     *
     * <p>V29 只建表不填数据，投影行由 {@code RECONCILE_UNITS} 从原始表枚举。对账没跑过时
     * 投影表是空的，于是「未覆盖的单元数」为 0 —— 门禁按字面意思是满足的，然后启用一个
     * 一条向量都没有的代次，而每一层都显示成功。覆盖率判据在分母为 0 时无声放行，
     * 是这类判据的通用失效形态，方案 §7 已经点过一次。
     */
    @Test
    void 投影表为空而库里有内容时不得启用() {
        RagIndexGeneration generation = createBuildingGeneration();
        jdbc.update("UPDATE rag_index_generation SET status='READY' WHERE id=?", generation.getId());

        BusinessException error = assertThrows(BusinessException.class,
                () -> adminService.activate(generation.getId()));

        assertTrue(error.getMessage().contains("全量对账"), error.getMessage());
        assertEquals("READY", generationMapper.selectById(generation.getId()).getStatus(),
                "被拒绝的启用不能留下半截状态");
    }

    /**
     * <b>门禁的分子必须逐个单元匹配，不能数状态行的条数。</b>
     *
     * <p>同一张 {@code rag_source_index_state} 里躺着两套行（LEGACY 的 {@code unit_id} 为 NULL）。
     * 只要分子是「条数」而不是「匹配」，一条与本次覆盖无关的遗留行就能把缺口填平 ——
     * 代次带着没建完的向量转 ACTIVE，而每一层都显示成功。
     *
     * <p><b>{@code unitStates} 里那句 {@code isNotNull(unit_id)} 是否承重，取决于分子怎么算 ——
     * 这一点是被扰动纠正过来的，原本写反了。</b>
     * 只看当前实现（逐条 {@code get(unit.getId())}）确实得出「过滤是防御性的」：
     * 空键取不到，加不加都一样。但把分子换成「状态行条数」之后，遗留行会直接进分子，
     * 过滤就成了唯一挡住它的东西。
     *
     * <p>所以「这句代码有没有用」不能脱离它周围的实现单独判断，而这正是扰动实测能纠正、
     * 读代码纠正不了的一类判断：第一次的扰动只改了分子，实测 GREEN ——
     * 按两级判定那是 UNEXERCISED（过滤把扰动挡掉了、被测路径没走到），不是「测试不敏感」。
     * 第二次把两处一起改（这才是真实的重构形态：有人把匹配换成计数，
     * 顺手把「看着多余」的过滤删掉）才变红。
     */
    @Test
    void 遗留的source状态行不算进覆盖率() {
        RagIndexGeneration generation = createBuildingGeneration();
        registerUnit(sourceId);
        jdbc.update("INSERT INTO rag_source_index_state(source_id,unit_id,generation_id,index_version," +
                        "content_hash,status,vector_count) VALUES(?,NULL,?,?,?,'INDEXED',3)",
                sourceId, generation.getId(), generation.getIndexVersion(), "whatever-hash");
        jdbc.update("UPDATE rag_index_generation SET status='READY' WHERE id=?", generation.getId());

        BusinessException error = assertThrows(BusinessException.class,
                () -> adminService.activate(generation.getId()));

        assertTrue(error.getMessage().contains("未完成该代索引"), error.getMessage());
    }

    /**
     * <b>投影行不存在时，{@code UPSERT_UNIT} 要补登记，而不是让位。</b>
     *
     * <p>此前判据是 {@code findUnit(...) == null → 让位}，而 {@code null} 同时覆盖
     * 「行被删了（删除赢了竞态）」与「行从没被建过（还没登记）」两件事 ——
     * 判据的定义域比它声称报告的性质宽。第二种是常态：登记入口零生产调用方，
     * 投影行只由全量对账批量建出来。于是新内容要等下一次手动对账才进得了索引，
     * 而作业照常转 COMPLETED，没有任何报错。
     */
    @Test
    void 投影行缺失时会从源表补登记() {
        assertNull(registry.findUnit(RagNamespace.NOTEBOOK_SOURCE, sourceId));

        assertTrue(registry.refreshUnitIfLive(RagNamespace.NOTEBOOK_SOURCE, sourceId),
                "源实体还在，就不该让位 —— 让位是留给「已被删除」的");

        RagIndexableUnit unit = registry.findUnit(RagNamespace.NOTEBOOK_SOURCE, sourceId);
        assertNotNull(unit, "补登记之后投影行必须存在");
        assertNotNull(unit.getCanonicalHash(), "补登记之后必须已经算出正文哈希，否则代次展开会跳过它");

        // 反面：源实体真的没了才让位。
        sourceMapper.deleteById(sourceId);
        jdbc.update("DELETE FROM rag_unit_chunk WHERE unit_id=?", unit.getId());
        jdbc.update("DELETE FROM rag_indexable_unit WHERE id=?", unit.getId());
        assertFalse(registry.refreshUnitIfLive(RagNamespace.NOTEBOOK_SOURCE, sourceId));
        assertNull(registry.findUnit(RagNamespace.NOTEBOOK_SOURCE, sourceId));
    }

    private RagIndexGeneration createBuildingGeneration() {
        String suffix = UUID.randomUUID().toString().replace("-", "");
        jdbc.update("INSERT INTO rag_index_generation(index_version,collection_name,status) VALUES(?,?,'BUILDING')",
                "bge-small-zh-v1.5@test", "rag_build_" + suffix);
        Long id = jdbc.queryForObject("SELECT id FROM rag_index_generation WHERE collection_name=?", Long.class,
                "rag_build_" + suffix);
        return generationMapper.selectById(id);
    }

    private Long createReadySource(String title, String content) {
        jdbc.update("INSERT INTO ai_notebook_source(user_id,notebook_id,source_type,title,status,index_status,deleted) " +
                "VALUES(?,?,'TEXT',?,'READY','NOT_INDEXED',0)", userId, notebookId, title);
        Long id = jdbc.queryForObject("SELECT id FROM ai_notebook_source WHERE notebook_id=? " +
                "ORDER BY id DESC LIMIT 1", Long.class, notebookId);
        jdbc.update("INSERT INTO ai_source_chunk(source_id,chunk_index,content) VALUES(?,0,?)", id, content);
        return id;
    }
}

// ── 启用门禁三条性质的扰动记录（2026-08-08 实测）──────────────────────────
//
//   E1  去掉空分母闸门                                  RED
//   E2  分子改成「units.size() - byUnit.size()」        **GREEN ✗**
//   E2b 同上，并同时删掉 unitStates 的 isNotNull 过滤    RED
//   E3  refreshUnitIfLive 退回只 findUnit、不补登记      RED
//
// **E2 那次 GREEN 是本轮的收获，按两级判定它是 UNEXERCISED 而不是「测试不敏感」。**
// 原因：过滤把遗留行挡在 byUnit 之外，于是计数版分子照样等于 1，扰动没走到被测路径。
//
// 由此推翻了一条刚写下的判断。改分子之前我在用例注释里写着
// 「isNotNull 是防御性的、不承重」—— 那句只在当前实现下成立：
// 逐条 get(unitId) 时空键取不到，加不加过滤都一样。
// 换成计数分子之后，过滤立刻变成唯一挡住遗留行的东西。
//
//   **「这行代码有没有用」不能脱离它周围的实现单独判断。**
//
// 而这类判断读代码纠正不了 —— 读代码得到的恰好就是那个错结论；
// 是扰动把它翻过来的。E2b 把两处一起改（这才是真实的重构形态：
// 有人把匹配换成计数，顺手删掉「看着多余」的过滤）才变红。

// ── 追加扰动（2026-08-08 实测）────────────────────────────────────────────
//
//   H1  targetUnitOf 忽略 namespace，一律按 NOTEBOOK_SOURCE 查     RED
//   H2  unitStates 去掉 isNotNull(unit_id) 过滤                    RED
//
// H1 之前有过一版用例，它在测试里**复述**了一遍 worker 的定位判断
// （`job.getNamespace() == null ? null : registry.findUnit(...)`）而不是调用它。
// 那样即使把 RagIndexWorker 改坏，用例也不会红 —— 判据看着在测那条性质，
// 实际测的是自己那一行复制品。修法是把定位提成 `targetUnitOf` 让用例直接打到它。
//
// H2 是 E2 那次 GREEN 的收尾：过滤现在有了自己的用例，
// 而不再依赖「分子恰好是逐条匹配」这个会变的前提。
