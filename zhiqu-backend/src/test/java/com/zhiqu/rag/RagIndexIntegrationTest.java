package com.zhiqu.rag;

import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.entity.RagIndexGeneration;
import com.zhiqu.entity.RagIndexJob;
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

    @Test
    void legacyReadySourceGetsHashAndDurableJob() {
        AiNotebookSource source = sourceMapper.selectById(sourceId);
        jobService.enqueueSource(source);
        String hash = jdbc.queryForObject("SELECT content_hash FROM ai_notebook_source WHERE id=?", String.class, sourceId);
        assertNotNull(hash);
        assertEquals(64, hash.length());
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM rag_index_job WHERE source_id=? AND status='PENDING'", Integer.class, sourceId));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM rag_source_index_state WHERE source_id=? AND generation_id=?", Integer.class, sourceId, generationId));
    }

    @Test
    void staleRunningJobCanBeReclaimed() {
        jdbc.update("INSERT INTO rag_index_job(dedupe_key,operation,generation_id,user_id,notebook_id,source_id,status,attempts,locked_at,locked_by) " +
                        "VALUES(?,?,?,?,?,?,'RUNNING',2,?,?)", "stale:" + UUID.randomUUID(), "UPSERT_SOURCE",
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
        AiNotebookSource source = sourceMapper.selectById(sourceId);
        jobService.enqueueGenerationSources(generation, List.of(source));
        RagIndexJob firstLease = claimPendingJob(generation.getId(), "UPSERT_SOURCE", "index-worker-1");

        RagIndexJob secondLease = renewExpireAndReclaim(firstLease, "index-worker-2");

        assertThrows(IllegalStateException.class, () -> jobService.markIndexedWithLease(firstLease, 7));
        assertEquals("PENDING", jdbc.queryForObject("SELECT status FROM rag_source_index_state " +
                "WHERE source_id=? AND generation_id=?", String.class, sourceId, generation.getId()));
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
                "WHERE generation_id=? AND operation='UPSERT_SOURCE'", Integer.class, generation.getId()));
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
        AiNotebookSource source = sourceMapper.selectById(sourceId);
        jobService.enqueueGenerationSources(generation, List.of(source));
        RagIndexJob job = jobMapper.selectOne(new com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<RagIndexJob>()
                .eq(RagIndexJob::getGenerationId, generation.getId())
                .eq(RagIndexJob::getSourceId, sourceId)
                .last("LIMIT 1"));
        job = claimForFailure(job.getId(), 8, "dead-worker");

        assertTrue(jobService.handleFailure(job, source, generation, new IllegalStateException("forced failure")));

        assertEquals("DEAD", jobMapper.selectById(job.getId()).getStatus());
        assertEquals("FAILED", generationMapper.selectById(generation.getId()).getStatus());
    }

    @Test
    void concurrentFinalDeadJobsConvergeGenerationToFailed() throws Exception {
        RagIndexGeneration generation = createBuildingGeneration();
        Long secondSourceId = createReadySource("second.txt", "second source content");
        jobService.enqueueGenerationSources(generation,
                List.of(sourceMapper.selectById(sourceId), sourceMapper.selectById(secondSourceId)));
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
                        sourceMapper.selectById(job.getSourceId()),
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
        AiNotebookSource source = sourceMapper.selectById(sourceId);
        jobService.enqueueGenerationSources(generation, List.of(source));
        RagIndexJob job = jobMapper.selectOne(
                new com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<RagIndexJob>()
                        .eq(RagIndexJob::getGenerationId, generation.getId())
                        .eq(RagIndexJob::getSourceId, sourceId).last("LIMIT 1"));
        job = claimForFailure(job.getId(), 8, "retry-dead-worker");
        assertTrue(jobService.handleFailure(job, source, generation, new IllegalStateException("forced failure")));
        Long failedJobId = job.getId();

        BusinessException error = assertThrows(BusinessException.class, () -> adminService.retry(failedJobId));

        assertTrue(error.getMessage().contains("索引代次已失败"));
        assertEquals("DEAD", jobMapper.selectById(failedJobId).getStatus());
        assertEquals("FAILED", generationMapper.selectById(generation.getId()).getStatus());
    }

    @Test
    void generationExpansionPreservesCurrentIndexedState() {
        RagIndexGeneration generation = createBuildingGeneration();
        AiNotebookSource source = sourceMapper.selectById(sourceId);
        jobService.enqueueGenerationSources(generation, List.of(source));
        jdbc.update("UPDATE rag_source_index_state SET status='INDEXED', vector_count=3 " +
                "WHERE source_id=? AND generation_id=?", sourceId, generation.getId());
        jdbc.update("UPDATE rag_index_job SET status='COMPLETED', completed_at=NOW() " +
                "WHERE source_id=? AND generation_id=?", sourceId, generation.getId());

        jobService.enqueueGenerationSources(generationMapper.selectById(generation.getId()), List.of(sourceMapper.selectById(sourceId)));

        assertEquals("INDEXED", jdbc.queryForObject("SELECT status FROM rag_source_index_state " +
                "WHERE source_id=? AND generation_id=?", String.class, sourceId, generation.getId()));
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
