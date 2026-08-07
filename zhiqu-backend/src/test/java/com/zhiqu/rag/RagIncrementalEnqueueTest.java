package com.zhiqu.rag;

import com.zhiqu.entity.RagIndexJob;
import com.zhiqu.mapper.RagIndexJobMapper;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 增量钩子接上之前必须成立的两条不变量。两条都属于「静默吃掉用户数据」那一类。
 *
 * <ol>
 *   <li><b>终态释放 dedupe_key</b> —— 否则同一目标一辈子只能入队一次，用户的第二次编辑
 *       撞唯一键、被 {@code enqueue} 当幂等成功吞掉，<b>永不入索引</b>，只留一行 debug 日志。</li>
 *   <li><b>UPSERT 以投影行为准</b> —— 作业里带的是发起时的快照，投影行才是当前真相。</li>
 * </ol>
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class RagIncrementalEnqueueTest {
    static {
        System.setProperty("api.version", System.getProperty("api.version", "1.40"));
    }

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_incr_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;
    @Autowired private RagIndexJobService jobService;
    @Autowired private RagIndexJobMapper jobMapper;
    @Autowired private RagUnitRegistry registry;
    @Autowired private SensitiveCryptoService crypto;

    private Long userId;

    @BeforeEach
    void prepare() {
        jdbc.update("DELETE FROM rag_index_job");
        jdbc.update("DELETE FROM rag_unit_chunk");
        jdbc.update("DELETE FROM rag_indexable_unit");
        jdbc.update("UPDATE user_knowledge_page SET deleted=1");
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES(?,?,?,'USER',0)",
                "incr_" + suffix, "test-password", "Incr");
        userId = jdbc.queryForObject("SELECT id FROM sys_user WHERE username=?", Long.class, "incr_" + suffix);
    }

    // ── 不变量 1：终态释放 dedupe_key ─────────────────────────────────────

    /**
     * 同一目标在<b>在途期间</b>去重，在<b>终态之后</b>可以再次入队。
     *
     * <p>这两半必须一起断言。只测「能再次入队」的话，把唯一键整个删掉也能绿，
     * 而那会让同一目标被重复排队、并发跑两遍。
     */
    @Test
    void 同一目标在途去重而终态后可再次入队() {
        Long pageId = createWikiPage("复习计划", "第一版");

        jobService.enqueueWikiPageChanged(userId, pageId);
        assertEquals(1, pendingCount(), "第一次入队");

        jobService.enqueueWikiPageChanged(userId, pageId);
        assertEquals(1, pendingCount(),
                "在途期间必须去重——同一页排两次队只会让 worker 白跑一遍");

        // 跑完它
        List<RagIndexJob> claimed = jobService.claimDueJobs(10, "test-worker");
        assertEquals(1, claimed.size());
        assertTrue(jobService.complete(claimed.get(0)));

        assertNull(dedupeKeyOf(claimed.get(0).getId()),
                "终态必须释放 dedupe_key。不释放的话，用户的第二次编辑会撞唯一键、"
                        + "被 enqueue 当幂等成功吞掉，那一版永不入索引且没有任何报错");

        // 用户第二次编辑同一页
        jobService.enqueueWikiPageChanged(userId, pageId);
        assertEquals(1, pendingCount(), "第二次编辑必须能重新排队");
        assertEquals(2, totalJobCount(), "历史那条仍在（终态），新的一条是第二行");
    }

    /**
     * A→B→A 也必须能重新入队。
     *
     * <p>这条排除掉「把 canonical_hash 拼进 uniquePart」那种修法：它能挡住连续编辑，
     * 挡不住内容回退——改成 B 跑完、再改回 A 时，A 的那个 key 在第一次就用掉了。
     */
    @Test
    void 内容回退到旧版本仍可重新入队() {
        Long pageId = createWikiPage("复习计划", "版本A");

        for (int round = 1; round <= 3; round++) {
            jobService.enqueueWikiPageChanged(userId, pageId);
            List<RagIndexJob> claimed = jobService.claimDueJobs(10, "test-worker");
            assertEquals(1, claimed.size(), "第 " + round + " 轮应当恰好有一条待办");
            assertTrue(jobService.complete(claimed.get(0)));
        }
        assertEquals(3, totalJobCount(), "三轮编辑应当留下三条作业记录");
    }

    /** RETRY 不是终态，键必须继续占着，否则同一目标会被重复入队、并发跑两遍。 */
    @Test
    void 重试中的作业仍占用去重键() {
        Long pageId = createWikiPage("复习计划", "第一版");
        jobService.enqueueWikiPageChanged(userId, pageId);

        RagIndexJob claimed = jobService.claimDueJobs(10, "test-worker").get(0);
        boolean dead = jobService.handleFailure(claimed, null, null, new IllegalStateException("模拟一次失败"));
        assertFalse(dead, "第一次失败应当转 RETRY 而非 DEAD");
        assertEquals("RETRY", statusOf(claimed.getId()));
        assertNotNull(dedupeKeyOf(claimed.getId()), "RETRY 仍在途，必须继续占键");

        jobService.enqueueWikiPageChanged(userId, pageId);
        assertEquals(1, totalJobCount(), "重试期间重复入队必须被去重");
    }

    // ── 不变量 2：UPSERT 以投影行为准 ─────────────────────────────────────

    /**
     * 已退役的单元不得被在途的 UPSERT 写回 READY。
     *
     * <p>竞态形态：编辑后立刻删除会排出 UPSERT 与 DELETE 两条作业，而领取走的是
     * {@code FOR UPDATE SKIP LOCKED} —— 两条可以被不同 worker 线程同时拿到，
     * DELETE 先落、UPSERT 后落。
     *
     * <p><b>诚实说明本条在 1B-1 的实际覆盖面</b>：如果退役的原因是「页被软删」，
     * 那么 provider 回读也会返回 GONE，单元照样停在 RETIRED —— 也就是说 provider 的
     * GONE 分支已经盖住了那一种。本条钉的是<b>不依赖 provider 行为的那一层</b>：
     * 投影行是当前真相，作业里的是发起时快照。它在 1B-2 才真正承重（那时 worker 会向
     * sidecar 发写请求，让位与否决定向量回不回来），现在先把契约钉死。
     */
    @Test
    void 已退役单元不会被在途的upsert写回() {
        Long pageId = createWikiPage("临时草稿", "写完就删");
        registry.reconcileAll();
        assertEquals(RagNamespace.STATUS_READY, unitStatusOf(pageId));

        // 删除先落：投影转 RETIRED（页本身仍在，以此隔离出「投影是真相」这一层）
        registry.retireUnit(RagNamespace.WIKI_PAGE, pageId);
        assertEquals(RagNamespace.STATUS_RETIRED, unitStatusOf(pageId));

        // 迟到的 UPSERT
        boolean refreshed = registry.refreshUnitIfLive(RagNamespace.WIKI_PAGE, pageId);

        assertFalse(refreshed, "已退役的单元必须让位，而不是被写回 READY");
        assertEquals(RagNamespace.STATUS_RETIRED, unitStatusOf(pageId),
                "写回 READY 等于「用户以为删掉的内容又能被检索到」");
        assertEquals(0, chunkRowsOf(pageId), "切分边界也不得被重建");
    }

    /** 反面：还活着的单元必须真的被刷新，否则上一条可能被某种「永远让位」的实现骗过。 */
    @Test
    void 存活单元的upsert照常执行() {
        Long pageId = createWikiPage("复习计划", "第一版");
        registry.reconcileAll();
        String before = canonicalHashOf(pageId);

        jdbc.update("UPDATE user_knowledge_page SET encrypted_content=? WHERE id=?",
                crypto.encrypt("第二版内容完全不同"), pageId);
        boolean refreshed = registry.refreshUnitIfLive(RagNamespace.WIKI_PAGE, pageId);

        assertTrue(refreshed);
        assertEquals(RagNamespace.STATUS_READY, unitStatusOf(pageId));
        assertFalse(before.equals(canonicalHashOf(pageId)), "正文变了，canonical_hash 必须跟着变");
    }

    // ── 工具 ────────────────────────────────────────────────────────────

    private Long createWikiPage(String title, String body) {
        jdbc.update("INSERT INTO user_knowledge_page(user_id,page_type,title,encrypted_content," +
                        "encryption_version,version,sort_order,pinned,deleted) VALUES(?,'NOTE',?,?,'v1',0,0,0,0)",
                userId, title, crypto.encrypt(body));
        return jdbc.queryForObject("SELECT id FROM user_knowledge_page WHERE user_id=? ORDER BY id DESC LIMIT 1",
                Long.class, userId);
    }

    private int pendingCount() {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM rag_index_job WHERE status IN ('PENDING','RUNNING','RETRY')", Integer.class);
        return count == null ? 0 : count;
    }

    private int totalJobCount() {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM rag_index_job", Integer.class);
        return count == null ? 0 : count;
    }

    private String dedupeKeyOf(Long jobId) {
        return jdbc.queryForObject("SELECT dedupe_key FROM rag_index_job WHERE id=?", String.class, jobId);
    }

    private String statusOf(Long jobId) {
        return jdbc.queryForObject("SELECT status FROM rag_index_job WHERE id=?", String.class, jobId);
    }

    private String unitStatusOf(Long pageId) {
        return jdbc.queryForObject("SELECT status FROM rag_indexable_unit WHERE namespace=? AND ref_id=?",
                String.class, RagNamespace.WIKI_PAGE, pageId);
    }

    private String canonicalHashOf(Long pageId) {
        return jdbc.queryForObject("SELECT canonical_hash FROM rag_indexable_unit WHERE namespace=? AND ref_id=?",
                String.class, RagNamespace.WIKI_PAGE, pageId);
    }

    private int chunkRowsOf(Long pageId) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM rag_unit_chunk c JOIN rag_indexable_unit u ON u.id=c.unit_id " +
                        "WHERE u.namespace=? AND u.ref_id=?", Integer.class, RagNamespace.WIKI_PAGE, pageId);
        return count == null ? 0 : count;
    }
}
