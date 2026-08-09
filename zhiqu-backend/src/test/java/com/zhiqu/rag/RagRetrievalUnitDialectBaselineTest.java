package com.zhiqu.rag;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.zhiqu.service.AiWorkspaceService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * <b>1B-2 检索侧的三条新基准。写在改动之前，此刻全部应当是红的。</b>
 *
 * <p>与 {@code RagRetrievalPipelineCharacterizationTest}（改动前的照片）刻意<b>分成两个类</b>：
 * 照片里有一条会在 step 2 计划内死掉，而这三条要活到 step 4 之后 ——
 * <b>寿命不同的东西不放在一起</b>，否则「这个类该怎么处置」就没有单一答案。
 * （这条规矩本身是从旧 golden master 那次学到的：一个类同时承载一次性角色与长期角色时，
 * 删和留都错。）
 *
 * <h2>三条各自的转绿步骤</h2>
 *
 * <table border="1">
 *   <caption>转绿序列</caption>
 *   <tr><th>断言</th><th>转绿时机</th></tr>
 *   <tr><td>{@code wiki单元经向量路径进入候选集}</td><td>step 3 回填打通</td></tr>
 *   <tr><td>{@code payload按unitIds与namespaces过滤}</td><td>step 2 payload 换 unitIds</td></tr>
 *   <tr><td>{@code 每源配额按所有命名空间计数}</td><td>step 4 sourceCount 放宽</td></tr>
 * </table>
 *
 * <p><b>三条一起绿 → 先查夹具里有没有零候选单元</b>（判读表见
 * {@code docs/rag-1b2-stage-e-handoff.md}）：`ContextBudgeter` 的
 * {@code max(sourceCount, distinct)} 兜底会让第三条在放宽之前就绿，
 * 而那个绿的含义是「放宽是空操作」。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false"
})
class RagRetrievalUnitDialectBaselineTest {

    private static final String INDEX_VERSION = "bge-small-zh-v1.5@baseline";
    private static final HttpServer SIDECAR;
    private static final int SIDECAR_PORT;
    private static final AtomicReference<List<Map<String, Object>>> CANDIDATES =
            new AtomicReference<>(List.of());
    private static final AtomicReference<String> LAST_QUERY_BODY = new AtomicReference<>("");

    static {
        System.setProperty("api.version", System.getProperty("api.version", "1.40"));
        try {
            // 绑 0 号端口再读回真实端口；写死 0 会通过 validateBaseUrl、请求时才失败，
            // 而那个失败读起来像「sidecar 不可用」。理由详见照片那个类的注释。
            SIDECAR = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            SIDECAR_PORT = SIDECAR.getAddress().getPort();
            SIDECAR.createContext("/v1/query", exchange -> {
                LAST_QUERY_BODY.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                respond(exchange, queryResponse());
            });
            SIDECAR.createContext("/v1/meta", exchange ->
                    respond(exchange, "{\"ready\":true,\"indexVersion\":\"" + INDEX_VERSION + "\"}"));
            SIDECAR.start();
        } catch (IOException e) {
            throw new IllegalStateException("桩 sidecar 启动失败", e);
        }
    }

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_rag_baseline")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @DynamicPropertySource
    static void sidecarProperties(DynamicPropertyRegistry registry) {
        registry.add("app.rag.enabled", () -> true);
        registry.add("app.rag.service-token", () -> "baseline-token");
        registry.add("app.rag.base-url", () -> "http://127.0.0.1:" + SIDECAR_PORT);
        registry.add("app.rag.index-version", () -> INDEX_VERSION);
    }

    @Autowired private JdbcTemplate jdbc;
    @Autowired private AiWorkspaceService workspaceService;
    @Autowired private RagUnitRegistry registry;

    private Long userId;
    private Long notebookId;
    private Long sourceId;
    private Long sourceUnitId;
    private Long pageId;
    private Long pageUnitId;
    private final List<Long> chunkIds = new ArrayList<>();
    private final List<Long> pageChunkIds = new ArrayList<>();

    @BeforeEach
    void prepareData() {
        jdbc.update("DELETE FROM rag_index_job");
        jdbc.update("DELETE FROM rag_source_index_state");
        jdbc.update("DELETE FROM rag_unit_chunk");
        jdbc.update("DELETE FROM rag_indexable_unit");
        jdbc.update("UPDATE rag_index_generation SET status='RETIRED' WHERE status='ACTIVE'");
        chunkIds.clear();
        pageChunkIds.clear();

        String suffix = UUID.randomUUID().toString().replace("-", "");
        jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES(?,?,?,'USER',0)",
                "base_" + suffix, "test-password", "Baseline Test");
        userId = jdbc.queryForObject("SELECT id FROM sys_user WHERE username=?", Long.class, "base_" + suffix);
        jdbc.update("INSERT INTO ai_notebook(user_id,title,status,deleted) VALUES(?,?,'ACTIVE',0)",
                userId, "Baseline Notebook");
        notebookId = jdbc.queryForObject("SELECT id FROM ai_notebook WHERE user_id=? ORDER BY id DESC LIMIT 1",
                Long.class, userId);
        jdbc.update("INSERT INTO ai_notebook_source(user_id,notebook_id,source_type,title,status," +
                        "index_status,content_hash,deleted) VALUES(?,?,'TEXT','baseline.txt','READY'," +
                        "'INDEXED',?,0)", userId, notebookId, "hash-baseline");
        sourceId = jdbc.queryForObject("SELECT id FROM ai_notebook_source WHERE notebook_id=? " +
                "ORDER BY id DESC LIMIT 1", Long.class, notebookId);
        // 5 条父块：N=5 落在 [4, 8]，与 maxPerSource=3 区分得开，又不触 finalK=8。
        // 期望 5 → 3，两个数字都不等于任何配置项，读起来不会和 finalK / maxPerSource 混。
        for (int index = 0; index < 5; index++) {
            jdbc.update("INSERT INTO ai_source_chunk(source_id,chunk_index,content) VALUES(?,?,?)",
                    sourceId, index, "资料第" + index + "段");
            chunkIds.add(jdbc.queryForObject("SELECT id FROM ai_source_chunk WHERE source_id=? " +
                    "AND chunk_index=?", Long.class, sourceId, index));
        }
        // B：一个 Wiki 页单元。第三条基准要求它**零候选**（sidecar 不为它返回任何候选行），
        // 因为 sourceCount 唯一能压过 distinct 的场景就是「数到了没有候选行的单元」。
        jdbc.update("INSERT INTO user_knowledge_page(user_id,page_type,title,encrypted_content," +
                        "encryption_version,version,sort_order,pinned,deleted) " +
                        "VALUES(?,'NOTE','象限法笔记',?,'v0',0,0,0,0)", userId, "象限法把任务分成四类。");
        pageId = jdbc.queryForObject("SELECT id FROM user_knowledge_page WHERE user_id=? " +
                "ORDER BY id DESC LIMIT 1", Long.class, userId);

        jdbc.update("INSERT INTO rag_index_generation(index_version,collection_name,status) " +
                "VALUES(?,?,'ACTIVE')", INDEX_VERSION, "rag_base_" + suffix);
        Long generationId = jdbc.queryForObject("SELECT id FROM rag_index_generation " +
                "ORDER BY id DESC LIMIT 1", Long.class);

        registry.refreshUnitIfLive(RagNamespace.NOTEBOOK_SOURCE, sourceId);
        registry.refreshUnitIfLive(RagNamespace.WIKI_PAGE, pageId);
        sourceUnitId = unitIdOf(RagNamespace.NOTEBOOK_SOURCE, sourceId);
        pageUnitId = unitIdOf(RagNamespace.WIKI_PAGE, pageId);
        pageChunkIds.addAll(jdbc.queryForList("SELECT id FROM rag_unit_chunk WHERE unit_id=? " +
                "ORDER BY chunk_index", Long.class, pageUnitId));

        for (Long unitId : List.of(sourceUnitId, pageUnitId)) {
            jdbc.update("INSERT INTO rag_source_index_state(source_id,unit_id,generation_id,index_version," +
                            "content_hash,status,vector_count,indexed_at) VALUES(?,?,?,?,?,'INDEXED',5,NOW())",
                    unitId.equals(sourceUnitId) ? sourceId : null, unitId, generationId, INDEX_VERSION,
                    jdbc.queryForObject("SELECT canonical_hash FROM rag_indexable_unit WHERE id=?",
                            String.class, unitId));
        }
        CANDIDATES.set(List.of());
        LAST_QUERY_BODY.set("");
    }

    private Long unitIdOf(String namespace, Long refId) {
        return jdbc.queryForObject("SELECT id FROM rag_indexable_unit WHERE namespace=? AND ref_id=?",
                Long.class, namespace, refId);
    }

    /**
     * 新基准 ①：<b>Wiki 单元经向量路径进入候选集</b>。转绿于 step 3（回填打通）。
     *
     * <p><b>{@code retrievalMode == VECTOR} 这半句是承重的，不是补充。</b>
     * 今天的 {@code sourceContext} 在 {@code includeWiki=true} 时会经
     * {@code wikiContext(...)} 塞进关键词补充行，那些行的 {@code sourceType} 也是
     * {@code WIKI_PAGE} —— 只断言「有一条 WIKI_PAGE 行」的话，这条基准会因为
     * <b>关键词路径</b>而绿，而它声称钉的是<b>向量路径</b>。
     * 判据的定义域比它声称报告的性质宽，正是这一族。
     */
    @Test
    void wiki单元经向量路径进入候选集() {
        CANDIDATES.set(List.of(unitCandidate(pageUnitId, RagNamespace.WIKI_PAGE,
                pageChunkIds.isEmpty() ? 1L : pageChunkIds.get(0), 0.10)));

        List<Map<String, Object>> rows = workspaceService.sourceContext(userId, notebookId,
                Map.of("query", "象限法"));

        assertTrue(rows.stream().anyMatch(row ->
                        RagNamespace.WIKI_PAGE.equals(row.get(CandidateKeys.SOURCE_TYPE))
                                && "VECTOR".equals(row.get("retrievalMode"))),
                "Wiki 单元必须经向量路径进上下文；只有关键词补充行的话，"
                        + "这条基准会因为错误的理由变绿。实际收到：" + rows);
    }

    /**
     * 新基准 ②：<b>payload 按 {@code unitIds} + {@code namespaces} 过滤</b>。转绿于 step 2。
     *
     * <p>与照片里 {@code 当前发给sidecar的payload按sourceIds过滤} 是同一件事的两面：
     * 那条钉「现在发的是什么」，这条钉「将来发的是什么」。step 2 的提交里一绿一红，
     * 正好说明改动落在该落的地方 —— 而那条在同一个提交里被删除（它的角色已被本条接替）。
     */
    @Test
    void payload按unitIds与namespaces过滤() {
        CANDIDATES.set(List.of(unitCandidate(sourceUnitId, RagNamespace.NOTEBOOK_SOURCE,
                chunkIds.get(0), 0.10)));

        workspaceService.sourceContext(userId, notebookId, Map.of("query", "象限法"));

        String body = LAST_QUERY_BODY.get();
        assertTrue(body.contains("\"unitIds\""), "sidecar 的 QueryRequest 要 unitIds。实际：" + body);
        assertTrue(body.contains("\"namespaces\""), "sidecar 的 QueryRequest 要 namespaces。实际：" + body);
        assertFalse(body.contains("\"sourceIds\""),
                "LEGACY 字段不得残留 —— 留着它 sidecar 会以 422 拒绝整个请求。实际：" + body);
    }

    /**
     * 新基准 ③：<b>每源配额按所有命名空间计数</b>。转绿于 step 4（`sourceCount` 放宽）。
     *
     * <p>夹具形状是被 `ContextBudgeter` 的结构逼出来的：{@code effectiveSourceCount}
     * 只进一个 {@code > 1} 的比较，所以只要 Wiki 单元<b>真的出现在候选里</b>，
     * {@code distinct} 就已经把闸门撑开了 —— {@code sourceCount} 唯一能压过它的场景，
     * 是它数到了<b>没有候选行的单元</b>。因此 B 必须零候选。
     *
     * <p>数字：A 产 5 条候选（{@code N ∈ [4, 8]}，与 {@code maxPerSource=3} 区分得开，
     * 又不触 {@code finalK=8}），期望 <b>5 → 3</b>。
     * 两个数字都不等于任何配置项，读起来不会和 {@code finalK} / {@code maxPerSource} 混。
     *
     * <p><b>B 必须是 Wiki 单元，不能是零候选的资料</b> —— 区分的整个来源就是
     * 「B 在窄口径里数不到」。换成资料的话窄口径本来就 = 2，闸门在放宽前已开，
     * 这条用例退化成恒绿而看不出来。
     */
    @Test
    void 每源配额按所有命名空间计数() {
        List<Map<String, Object>> candidates = new ArrayList<>();
        for (int index = 0; index < 5; index++) {
            candidates.add(unitCandidate(sourceUnitId, RagNamespace.NOTEBOOK_SOURCE,
                    chunkIds.get(index), 0.10 + index * 0.01));
        }
        CANDIDATES.set(candidates);

        List<Map<String, Object>> rows = workspaceService.sourceContext(userId, notebookId,
                Map.of("query", "象限法"));

        assertEquals(3, rows.size(),
                "范围里有 2 个单元（资料 A + 零候选的 Wiki 单元 B），每源配额 maxPerSource=3 应当生效。"
                        + "拿到 5 条说明口径仍只数 NOTEBOOK_SOURCE，闸门没开");
    }

    // ── 桩 ────────────────────────────────────────────────────────────────

    private Map<String, Object> unitCandidate(Long unitId, String namespace, Long chunkId, double distance) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("unitId", unitId);
        row.put("namespace", "\"" + namespace + "\"");
        row.put("chunkId", chunkId);
        row.put("chunkIndex", 0);
        row.put("segmentIndex", 0);
        row.put("charStart", 0);
        row.put("charEnd", 6);
        row.put("distance", distance);
        return row;
    }

    private static String queryResponse() {
        StringBuilder json = new StringBuilder("{\"indexVersion\":\"").append(INDEX_VERSION)
                .append("\",\"metric\":\"cosine\",\"candidates\":[");
        List<Map<String, Object>> rows = CANDIDATES.get();
        for (int index = 0; index < rows.size(); index++) {
            if (index > 0) json.append(',');
            json.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> entry : rows.get(index).entrySet()) {
                if (!first) json.append(',');
                first = false;
                json.append('"').append(entry.getKey()).append("\":").append(entry.getValue());
            }
            json.append('}');
        }
        return json.append("]}").toString();
    }

    private static void respond(HttpExchange exchange, String body) throws IOException {
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(200, payload.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(payload);
        }
    }
}
