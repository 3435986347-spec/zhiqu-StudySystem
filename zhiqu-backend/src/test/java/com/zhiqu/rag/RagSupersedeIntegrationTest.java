package com.zhiqu.rag;

import com.zhiqu.entity.RagIndexJob;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 真库验证「陈旧写入被墓碑拒绝」后的落库状态。
 *
 * <p>{@link RagStaleMutationTest} 用 mock 证明了分流逻辑（409 走 supersede、不走 handleFailure），
 * 但那条路径不会真正执行 supersedeLease 的 SQL —— 语句写错也照样通过。
 * 本用例连真实 MySQL 跑一遍，逐条断言评审要求的三件事：
 * 作业不进 RETRY/DEAD、source 状态不报错、代次不被判 FAILED。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class RagSupersedeIntegrationTest {
    static {
        System.setProperty("api.version", System.getProperty("api.version", "1.40"));
    }

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_supersede_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;
    @Autowired private RagIndexJobService jobService;

    /** 造一个 BUILDING 代次 + 一个 RUNNING 且持有租约的作业，返回作业实体。 */
    private RagIndexJob runningJob(String workerId) {
        String suffix = UUID.randomUUID().toString().replace("-", "");
        jdbc.update("INSERT INTO rag_index_generation(index_version,collection_name,status,expected_source_count,indexed_source_count) "
                + "VALUES(?,?,'BUILDING',0,0)", "bge-small-zh-v1.5@test", "rag_sup_" + suffix);
        Long generationId = jdbc.queryForObject(
                "SELECT id FROM rag_index_generation ORDER BY id DESC LIMIT 1", Long.class);
        jdbc.update("INSERT INTO rag_index_job(dedupe_key,operation,generation_id,status,attempts,locked_by,lease_version,locked_at) "
                + "VALUES(?,'DELETE_SOURCE',?,'RUNNING',1,?,7,NOW())", "dedupe_" + suffix, generationId, workerId);
        Long jobId = jdbc.queryForObject("SELECT id FROM rag_index_job ORDER BY id DESC LIMIT 1", Long.class);

        RagIndexJob job = new RagIndexJob();
        job.setId(jobId);
        job.setGenerationId(generationId);
        job.setOperation("DELETE_SOURCE");
        job.setStatus("RUNNING");
        job.setLockedBy(workerId);
        job.setLeaseVersion(7L);
        return job;
    }

    @Test
    void supersedeMovesJobToTerminalStateWithoutFailingGeneration() {
        RagIndexJob job = runningJob("worker-supersede");

        boolean applied = jobService.supersede(job, new StaleMutationException(
                "{\"code\":\"STALE_MUTATION\",\"message\":\"tombstone rejects mutationToken 7\"}"));

        assertTrue(applied, "持有租约时 supersede 应当生效");

        String status = jdbc.queryForObject(
                "SELECT status FROM rag_index_job WHERE id=?", String.class, job.getId());
        assertEquals("SUPERSEDED", status);
        assertNotEquals("RETRY", status);
        assertNotEquals("DEAD", status);

        // 终态应释放租约并记录完成时间，避免被 lockDueJobs 当作 stale RUNNING 重新捞起
        assertNotNull(jdbc.queryForObject(
                "SELECT completed_at FROM rag_index_job WHERE id=?", java.sql.Timestamp.class, job.getId()));
        assertEquals(0, (int) jdbc.queryForObject(
                "SELECT COUNT(*) FROM rag_index_job WHERE id=? AND locked_by IS NOT NULL",
                Integer.class, job.getId()));

        // source 状态不得被标成 ERROR（supersede 不走 markIndexError）
        assertEquals(0, (int) jdbc.queryForObject(
                "SELECT COUNT(*) FROM rag_source_index_state WHERE generation_id=? AND status='ERROR'",
                Integer.class, job.getGenerationId()));

        // 代次不得因这次「被取代」而判定失败
        String generationStatus = jdbc.queryForObject(
                "SELECT status FROM rag_index_generation WHERE id=?", String.class, job.getGenerationId());
        assertNotEquals("FAILED", generationStatus);
    }

    /** 租约已被别的 worker 抢走时，supersede 不得改动他人作业。 */
    @Test
    void supersedeIsRejectedWhenLeaseIsNotHeld() {
        RagIndexJob job = runningJob("worker-owner");
        job.setLockedBy("worker-impostor");

        boolean applied = jobService.supersede(job, new StaleMutationException("stale"));

        assertTrue(!applied, "租约不匹配时不应改动作业");
        assertEquals("RUNNING", jdbc.queryForObject(
                "SELECT status FROM rag_index_job WHERE id=?", String.class, job.getId()));
    }
}
