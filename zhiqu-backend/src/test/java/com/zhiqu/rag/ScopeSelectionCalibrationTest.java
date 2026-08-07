package com.zhiqu.rag;

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
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 检索范围的<b>口径</b>探针 —— 补 {@code ContextBudgeterCharacterizationTest} 结构上盖不到的洞。
 *
 * <p>那个 golden master 是直接调 {@code contextBudgeter.select(preferred, supplements, sourceCount)}
 * 的，所以它钉住的是<b>选取行为</b>，钉不到调用方喂进来的<b>口径</b>。唯一的生产调用点是
 * {@code AiWorkspaceServiceImpl} 里的 {@code select(vectorRows, supplements, scope.notebookSourceCount())}
 * —— 范围的类型一变，「数的是什么」就可能悄悄改，而 golden master 照绿。
 *
 * <p><b>断言的是有序 id 列表，不是基数。</b>只比基数会被两种改动骗过：
 * <ol>
 *   <li><b>换而不增</b> —— 少收一份资料、多收一个 Wiki 单元，基数不变；</li>
 *   <li><b>顺序</b> —— {@code List} 换成 {@code Set}，基数与成员都不变，但
 *       {@code ContextBudgeter.roundRobinExplicit} 用 {@code LinkedHashMap} 按 sourceKey
 *       首次出现顺序建桶，桶序决定每源配额卡住时哪几条 explicit 行活下来。行为变了，
 *       而且没有任何异常提示。</li>
 * </ol>
 * 断言有序列表一条盖住基数、成员、顺序三件事，零额外成本。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class ScopeSelectionCalibrationTest {
    static {
        System.setProperty("api.version", System.getProperty("api.version", "1.40"));
    }

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_scope_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;
    @Autowired private SourceScopeResolver resolver;

    private Long userId;
    private Long notebookId;
    private Long first;
    private Long second;
    private Long third;

    @BeforeEach
    void prepare() {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES(?,?,?,'USER',0)",
                "scope_" + suffix, "test-password", "Scope");
        userId = jdbc.queryForObject("SELECT id FROM sys_user WHERE username=?", Long.class, "scope_" + suffix);
        jdbc.update("INSERT INTO ai_notebook(user_id,title,status,deleted) VALUES(?,?,'ACTIVE',0)", userId, "范围口径");
        notebookId = jdbc.queryForObject(
                "SELECT id FROM ai_notebook WHERE user_id=? ORDER BY id DESC LIMIT 1", Long.class, userId);

        // updated_at 拉开，才能让排序（updated_at DESC, id DESC）产生一个确定且非平凡的顺序。
        // 三条时间相同的话，顺序退化成按 id，List→Set 的扰动可能碰巧仍然一致——那样这条就白写了。
        first = createSource("甲.txt", "2026-01-03 10:00:00");
        second = createSource("乙.txt", "2026-01-02 10:00:00");
        third = createSource("丙.txt", "2026-01-01 10:00:00");
    }

    /**
     * 全量范围的 id 列表必须是「按 updated_at 降序」的那一个确定序列。
     *
     * <p>期望值不是 {@code List.of(first, second, third)} 碰巧等于插入顺序 —— 是刻意让
     * updated_at 与插入顺序<b>相反</b>地排布（甲最新），使「按时间排序」与「按 id 排序」
     * 给出不同答案。若哪天排序被去掉或换成 Set，本条必红。
     */
    @Test
    void 全量范围的资料id按既定顺序返回() {
        ScopeSelection scope = resolver.resolve(userId, notebookId, List.of());

        assertEquals(List.of(first, second, third), scope.notebookSourceIds(),
                "范围的顺序承重：它决定 legacyContextRows 的建行顺序，"
                        + "进而决定 ContextBudgeter.roundRobinExplicit 的桶序，"
                        + "最终决定每源配额卡住时哪几条 explicit 行活下来");
        assertEquals(3, scope.notebookSourceCount());
    }

    /**
     * 显式选中时，返回的仍是<b>按同一规则排序</b>的子集，而不是请求里的给定顺序。
     *
     * <p>这条把「顺序由服务端的排序规则决定」与「顺序由客户端传入决定」区分开 ——
     * 两者在只比集合时无法区分。
     */
    @Test
    void 显式选中时顺序仍由服务端排序规则决定() {
        ScopeSelection scope = resolver.resolve(userId, notebookId, List.of(third, first));

        assertEquals(List.of(first, third), scope.notebookSourceIds(),
                "请求里给的是 [丙, 甲]，返回必须是按 updated_at 降序的 [甲, 丙]");
    }

    /**
     * {@code notebookSourceCount()} 在 1B-1 只数 NOTEBOOK_SOURCE。
     *
     * <p>它是 {@code ContextBudgeter} 每源配额的触发点。放宽到「范围里的全部单元」会立刻
     * 改变选取结果，而 golden master 看不见 —— 这正是本类存在的理由。
     */
    @Test
    void 计数口径只含notebook资料() {
        jdbc.update("INSERT INTO user_knowledge_page(user_id,page_type,title,encrypted_content," +
                "encryption_version,version,sort_order,pinned,deleted) VALUES(?,'NOTE','一个Wiki页',NULL,'v1',0,0,0,0)",
                userId);

        ScopeSelection scope = resolver.resolve(userId, notebookId, List.of());

        assertEquals(3, scope.notebookSourceCount(),
                "1B-1 的口径等价：Wiki 页不进这个计数。放宽属于 1B-2");
        assertEquals(scope.notebookSourceIds().size(), scope.notebookSourceCount(),
                "计数必须与 id 列表同源，不能是两个独立维护的数");
    }

    /** 范围是不可变的：调用方拿到后改不动它，顺序不会在下游被就地重排。 */
    @Test
    void 范围列表不可变() {
        ScopeSelection scope = resolver.resolve(userId, notebookId, List.of());
        assertTrue(assertThrowsUnsupported(() -> scope.notebookSources().clear()),
                "必须是不可变列表——可变的话下游一次 sort() 就能改掉承重的顺序，且不留痕迹");
    }

    private boolean assertThrowsUnsupported(Runnable action) {
        try {
            action.run();
            return false;
        } catch (UnsupportedOperationException expected) {
            return true;
        }
    }

    private Long createSource(String title, String updatedAt) {
        jdbc.update("INSERT INTO ai_notebook_source(user_id,notebook_id,source_type,title,status," +
                        "index_status,content_hash,updated_at,deleted) VALUES(?,?,'TEXT',?,'READY','NOT_INDEXED',?,?,0)",
                userId, notebookId, title, "hash-" + title, updatedAt);
        return jdbc.queryForObject("SELECT id FROM ai_notebook_source WHERE notebook_id=? AND title=?",
                Long.class, notebookId, title);
    }
}
