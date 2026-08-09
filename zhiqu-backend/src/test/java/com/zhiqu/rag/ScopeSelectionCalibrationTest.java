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
    @Autowired private RagUnitRegistry registry;
    @Autowired private com.zhiqu.service.RuntimeFlagService runtimeFlags;

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
        // 本用例的用户没有 Wiki 页，所以放宽后的计数仍是 3 —— 这一条现在多说明一件事：
        // 计数确实按范围里真实存在的单元来，而不是无条件加上一个命名空间的常数。
        assertEquals(3, scope.scopedUnitCount());
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
     * {@code scopedUnitCount()} 数的是范围里的<b>全部单元</b>（step 4 放宽后）。
     *
     * <p><b>本条在 step 4 被反转，不是新写的。</b>它此前叫 {@code 计数口径只含notebook资料}，
     * 钉的是 1B-1 刻意的口径等价（Wiki 不进计数）。放宽落地的那一刻，
     * 那条期望的替代品就是它自己的反面 —— 这属于「使它变红的那条性质，替代品已绿」，
     * 所以在同一个提交里改，而不是留着两条互相矛盾的期望。
     *
     * <h3>夹具必须<b>注册投影单元</b>，只插一行 Wiki 页是不够的</h3>
     *
     * <p>旧夹具直接 {@code INSERT user_knowledge_page}，而范围读的是<b>投影表</b>
     * {@code rag_indexable_unit}。放宽之后若照抄旧夹具，那个页根本进不了
     * {@code projectedUnits}，计数仍是 3，本条会<b>空绿</b> ——
     * 通过的原因是「Wiki 压根没进来」，而它声称验证的是「Wiki 进来了并被数上」。
     *
     * <p>所以最后一条断言是内建的阳性对照：计数必须<b>严格大于</b> id 列表长度。
     * Wiki 单元没进范围时它立刻红，而不是安静地通过。
     */
    @Test
    void 计数口径含全部命名空间的单元() {
        jdbc.update("INSERT INTO user_knowledge_page(user_id,page_type,title,encrypted_content," +
                "encryption_version,version,sort_order,pinned,deleted) VALUES(?,'NOTE','一个Wiki页',?,'v0',0,0,0,0)",
                userId, "象限法把任务分成四类。");
        Long pageId = jdbc.queryForObject("SELECT id FROM user_knowledge_page WHERE user_id=? "
                + "ORDER BY id DESC LIMIT 1", Long.class, userId);
        registry.refreshUnitIfLive(RagNamespace.WIKI_PAGE, pageId);

        ScopeSelection scope = resolver.resolve(userId, notebookId, List.of());

        assertEquals(4, scope.scopedUnitCount(),
                "step 4 的放宽：3 份资料 + 1 个 Wiki 单元。它是每源配额的触发点");
        assertEquals(3, scope.notebookSourceIds().size(),
                "放宽只该改计数，不该把 Wiki 单元混进资料 id 列表");
        assertTrue(scope.scopedUnitCount() > scope.notebookSourceIds().size(),
                "阳性对照：Wiki 单元没真的进范围时，上面两条会因为「计数=3」而一起绿，"
                        + "那种绿的含义是放宽没生效");
    }

    /** 范围是不可变的：调用方拿到后改不动它，顺序不会在下游被就地重排。 */
    @Test
    void 范围列表不可变() {
        ScopeSelection scope = resolver.resolve(userId, notebookId, List.of());
        assertTrue(assertThrowsUnsupported(() -> scope.notebookSources().clear()),
                "必须是不可变列表——可变的话下游一次 sort() 就能改掉承重的顺序，且不留痕迹");
    }

    /**
     * {@code projectedUnits} 里混进 NOTEBOOK_SOURCE 必须<b>当场</b>被拒。
     *
     * <p><b>这条用例是补上来的，不是新写的。</b>那条约束在 1B-1 加宽 {@code ScopeSelection}
     * 时就写进了紧凑构造器，但当时 {@code projectedUnits} 恒为空 —— <b>没有任何东西能触发它</b>，
     * 于是按既有规矩只留了注释说明为什么走不到，并把「等它可达时补用例」记进交接单。
     * step 3 让范围里真的装进 Wiki 单元，这一刻就是它可达的时刻。
     *
     * <p>为什么值得一条用例：违反它<b>不抛异常也不报错</b> —— 同一个单元被
     * {@code notebookSources} 与 {@code projectedUnits} 各数一遍，
     * {@code effectiveSourceCount} 的分母虚高，表现只是「上下文里的行变少了」。
     * 而分母正是 step 4 要放宽的那个量，届时两种原因会叠在一起，分不开。
     */
    @Test
    void 投影单元里混进NOTEBOOK_SOURCE当场被拒() {
        com.zhiqu.entity.RagIndexableUnit notebookUnit = new com.zhiqu.entity.RagIndexableUnit();
        notebookUnit.setId(4321L);
        notebookUnit.setNamespace(RagNamespace.NOTEBOOK_SOURCE);
        notebookUnit.setRefId(7L);

        IllegalArgumentException error = org.junit.jupiter.api.Assertions.assertThrows(
                IllegalArgumentException.class,
                () -> new ScopeSelection(userId, notebookId, List.of(), List.of(notebookUnit)),
                "NOTEBOOK_SOURCE 单元属于 notebookSources，放进 projectedUnits 会被数两遍");
        assertTrue(error.getMessage().contains("4321"),
                "报错要带上单元 id，否则拿到这个异常的人还得自己去找是哪一条：" + error.getMessage());
    }

    /**
     * Wiki 范围有<b>页数</b>上界，且截断取的是<b>最近更新</b>的那些。
     *
     * <p>上界限的是 <b>id 基数</b>（{@code payload.unitIds} / Chroma {@code $in} /
     * 状态查询的 {@code IN}），不是 token 成本 —— 后者已被 sidecar 的
     * {@code min(max_candidate_k, candidateK)} 与 {@code finalK/maxContextChars/maxPerSource}
     * 夹死，且与范围大小无关。所以按<b>页数</b>而不是 chunk 数：
     * 一个 500 chunk 的巨页在 id 基数上只值 1，按 chunk 预算反而会被它独占。
     *
     * <p>断言取<b>具体是哪几页</b>而不只是数量：只比数量的话，
     * 「取了最近 2 页」与「取了最早 2 页」都是 2，而后者意味着截断稳定地砍掉用户在用的页。
     */
    @org.junit.jupiter.api.AfterEach
    void 还原运行时上界() {
        // 上界是**进程级**状态，不随每个用例的新用户重置 —— 不还原的话它会泄漏到
        // 同类里其它用例（比如「计数口径含全部命名空间」那条），表现为与本条无关的红。
        runtimeFlags.set(com.zhiqu.service.RuntimeFlagService.RAG_WIKI_SCOPE_MAX, "200", "test-reset");
    }

    @Test
    void wiki范围按页数截断且保留最近更新的() {
        Long oldest = createWikiPage("最旧", "2026-01-01 10:00:00");
        Long middle = createWikiPage("居中", "2026-01-02 10:00:00");
        Long newest = createWikiPage("最新", "2026-01-03 10:00:00");
        // 必须走 set(...) 而不是直接改表：RuntimeFlagService 有 5 秒 TTL 缓存，
        // 直接写库会被同一次运行里更早的一次读取盖住，本条会因为读到旧上界而随机绿。
        // set(...) 写完立刻失效缓存（RuntimeFlagService.java:130）。
        runtimeFlags.set(com.zhiqu.service.RuntimeFlagService.RAG_WIKI_SCOPE_MAX, "2", "test");

        ScopeSelection scope = resolver.resolve(userId, notebookId, List.of());

        List<Long> refIds = scope.projectedUnits().stream()
                .map(com.zhiqu.entity.RagIndexableUnit::getRefId).toList();
        assertEquals(List.of(newest, middle), refIds,
                "上界 2 时留下的必须是最近更新的两页；拿到 [" + oldest + " …] 说明排序反了，"
                        + "截断会稳定地砍掉用户正在用的页");
    }

    private Long createWikiPage(String title, String updatedAt) {
        jdbc.update("INSERT INTO user_knowledge_page(user_id,page_type,title,encrypted_content," +
                        "encryption_version,version,sort_order,pinned,updated_at,deleted) " +
                        "VALUES(?,'NOTE',?,?,'v0',0,0,0,?,0)",
                userId, title, "象限法把任务分成四类。" + title, updatedAt);
        Long pageId = jdbc.queryForObject("SELECT id FROM user_knowledge_page WHERE user_id=? "
                + "AND title=?", Long.class, userId, title);
        registry.refreshUnitIfLive(RagNamespace.WIKI_PAGE, pageId);
        // 投影行的 updated_at 由 MetaObjectHandler 填当前时间，与页面的 updated_at 无关；
        // 范围排序读的是投影行，所以要把它对齐到夹具想表达的时间。
        jdbc.update("UPDATE rag_indexable_unit SET updated_at=? WHERE namespace=? AND ref_id=?",
                updatedAt, RagNamespace.WIKI_PAGE, pageId);
        return pageId;
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
