package com.zhiqu.rag;

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
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@code retrieve → hydrate → budget} 这条链的<b>特征化测试（golden master）</b>，
 * 也是全仓<b>唯一一个把 RAG 检索真正跑起来</b>的测试。
 *
 * <h2>为什么现在拍这张照</h2>
 *
 * <p>这个项目每一次改行为之前都先立了 golden master（{@code ContextBudgeter}、
 * 规范化正文、切分器、投影表）。检索链路本来会是<b>唯一一个没有「改动前照片」就被重写</b>的地方，
 * 而它恰好是完全没有端到端覆盖的那一段 —— 现有覆盖全在它的两端。
 *
 * <p>具体在风险上的是：<b>Notebook 资料的检索结果应当跨 1B-2 等价。</b>
 * 同样的问题、同样的向量，选出来的候选集、顺序、每源配额的效果都不该变 ——
 * 1B-2 改的是契约与命名空间，不是 Notebook 的检索语义。
 * {@code ContextBudgeterCharacterizationTest} 钉不到这件事：它孤立地调 {@code select()}，
 * 钉的是那一步，不是三步的组合效果。
 *
 * <p>这张照片只有在动手之前拍得到 —— 所以它排在三条新基准之前（step 0.6）。
 *
 * <h2>本类 {@code app.rag.enabled=true} 是刻意的、唯一的例外</h2>
 *
 * <p>全仓另有 <b>8 个</b>集成测试类设 {@code app.rag.enabled=false}
 * （{@code RagIndexIntegrationTest}、{@code KnowledgeRagHookTest}、
 * {@code RagIncrementalEnqueueTest}、{@code RagSupersedeIntegrationTest}、
 * {@code MemoryEpochSchemaIntegrationTest}、{@code RagUnitRegistryIntegrationTest}、
 * {@code ScopeSelectionCalibrationTest}、{@code SourceIndexStatusReadsProjectionTest}）。
 * 也就是说本类是 <b>8 比 1 的孤例</b>，看起来像疏忽。
 *
 * <p><b>不要把它「修正」成和其余八个一致。</b>那天什么都不会红，
 * 只是这条链重新失去唯一的覆盖 —— 与 {@code ContextBudgeterCharacterizationTest} 里
 * 7 处硬编码键名同一种处境：承重的「与众不同」必须被标注，否则它和疏忽长得一样。
 *
 * <h2>曾经有第三条断言，它已在 step 2 计划内地退休</h2>
 *
 * <p>{@code 当前发给sidecar的payload按sourceIds过滤} 钉的是 1B-1 的 payload 口径，
 * 而 step 2 正是把它换成 {@code unitIds} —— 它的替代品是
 * {@code RagRetrievalUnitDialectBaselineTest.payload按unitIds与namespaces过滤}。
 * 触发条件（「使它变红的那条性质，替代品已绿」）当场成立，所以<b>在同一个提交里删掉</b>。
 * 留着改期望值的话，「合法地跟随契约」和「调到绿为止」在 diff 里长得一模一样。
 *
 * <p><b>剩下两条一律按「坏了」读。</b>本类现在只承载一个角色：
 * Notebook 检索的结果跨 1B-2 等价。任何一条红都是回退信号，没有第二种解释 ——
 * 上面那种「同一个类里一条红是进展、另两条红是坏了」的歧义随第三条一起没了。
 *
 * <p>两条刻意<b>不</b>编进任何会变的东西：顺序那条断言的是正文顺序而非候选身份格式
 * （格式会变，且已由 {@code CandidateKeys} 与新基准第二条钉住）；
 * 越界那条断言的是「越界的没进来」，与身份格式无关。
 *
 * <p><b>夹具会跟着契约走，期望值不会。</b>step 2 已经改过一次
 * （状态行从「source_id + 资料哈希」换成 upsertUnitState 真会写的 UNIT 行），
 * step 3 还会改一次（桩返回的候选从 {@code sourceId} 换成 {@code namespace}+{@code unitId}，
 * 因为真 sidecar 返回的就是后者 —— vector_store.py:243-244）。
 * 判断标准只有一条：<b>改的是喂进去的东西，还是比对的东西</b>。
 *
 * <h2>两个机械陷阱（都实测过）</h2>
 *
 * <ol>
 *   <li><b>桩服务器必须绑 0 号端口、读回真实端口再交给 {@link DynamicPropertySource}。</b>
 *       {@code RagClient} 的 {@code validateBaseUrl} 在<b>构造器里</b>跑（上下文创建期间），
 *       它要求 http/https + host 解析为 loopback，但<b>不检查可达性</b>。
 *       于是把 {@code 0} 直接写进属性会校验通过、请求时才连接失败 ——
 *       而那个失败在检索路径深处冒出来，读起来像「sidecar 不可用」，诊断指向错误的地方。</li>
 *   <li><b>桩服务器要在 {@code static {}} 里启动。</b>{@code SpringExtension} 实现
 *       {@code BeforeAllCallback}，上下文加载发生在用户的 {@code @BeforeAll} <b>之前</b>，
 *       那时 {@code @DynamicPropertySource} 已经把端口读走了。
 *       同一个 idiom 仓里有现成的（{@code RagUnitRegistryIntegrationTest} 用 static 块设
 *       {@code api.version}）。</li>
 * </ol>
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false"
})
class RagRetrievalPipelineCharacterizationTest {

    private static final String INDEX_VERSION = "bge-small-zh-v1.5@characterization";
    private static final HttpServer SIDECAR;
    private static final int SIDECAR_PORT;

    /** 桩返回的候选列表；每个用例自己摆。 */
    private static final AtomicReference<List<Map<String, Object>>> CANDIDATES =
            new AtomicReference<>(List.of());
    /** 桩收到的最后一个 query 请求体（原始 JSON），供断言 payload 形状用。 */
    private static final AtomicReference<String> LAST_QUERY_BODY = new AtomicReference<>("");

    static {
        System.setProperty("api.version", System.getProperty("api.version", "1.40"));
        try {
            // 端口 0 = 让 OS 分配；下面读回真实端口。写死 0 会通过 validateBaseUrl，
            // 然后在请求时才失败，而那个失败读起来像「sidecar 不可用」。
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
            .withDatabaseName("zhiqu_rag_pipeline")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @DynamicPropertySource
    static void sidecarProperties(DynamicPropertyRegistry registry) {
        registry.add("app.rag.enabled", () -> true);
        registry.add("app.rag.service-token", () -> "characterization-token");
        registry.add("app.rag.base-url", () -> "http://127.0.0.1:" + SIDECAR_PORT);
        registry.add("app.rag.index-version", () -> INDEX_VERSION);
    }

    @Autowired private JdbcTemplate jdbc;
    @Autowired private AiWorkspaceService workspaceService;
    @Autowired private RagUnitRegistry registry;

    private Long userId;
    private Long notebookId;
    private Long sourceId;
    private Long generationId;
    private final List<Long> chunkIds = new ArrayList<>();

    @BeforeEach
    void prepareData() {
        jdbc.update("DELETE FROM rag_index_job");
        jdbc.update("DELETE FROM rag_source_index_state");
        jdbc.update("DELETE FROM rag_unit_chunk");
        jdbc.update("DELETE FROM rag_indexable_unit");
        jdbc.update("UPDATE rag_index_generation SET status='RETIRED' WHERE status='ACTIVE'");
        chunkIds.clear();

        String suffix = UUID.randomUUID().toString().replace("-", "");
        jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES(?,?,?,'USER',0)",
                "pipe_" + suffix, "test-password", "Pipeline Test");
        userId = jdbc.queryForObject("SELECT id FROM sys_user WHERE username=?", Long.class, "pipe_" + suffix);
        jdbc.update("INSERT INTO ai_notebook(user_id,title,status,deleted) VALUES(?,?,'ACTIVE',0)",
                userId, "Pipeline Notebook");
        notebookId = jdbc.queryForObject("SELECT id FROM ai_notebook WHERE user_id=? ORDER BY id DESC LIMIT 1",
                Long.class, userId);
        jdbc.update("INSERT INTO ai_notebook_source(user_id,notebook_id,source_type,title,status," +
                        "index_status,content_hash,deleted) VALUES(?,?,'TEXT','pipeline.txt','READY'," +
                        "'INDEXED',?,0)", userId, notebookId, "hash-pipeline");
        sourceId = jdbc.queryForObject("SELECT id FROM ai_notebook_source WHERE notebook_id=? " +
                "ORDER BY id DESC LIMIT 1", Long.class, notebookId);
        for (int index = 0; index < 3; index++) {
            jdbc.update("INSERT INTO ai_source_chunk(source_id,chunk_index,content) VALUES(?,?,?)",
                    sourceId, index, "第" + index + "段：象限法把任务按重要与紧急分成四类。");
            chunkIds.add(jdbc.queryForObject("SELECT id FROM ai_source_chunk WHERE source_id=? " +
                    "AND chunk_index=?", Long.class, sourceId, index));
        }
        jdbc.update("INSERT INTO rag_index_generation(index_version,collection_name,status) " +
                "VALUES(?,?,'ACTIVE')", INDEX_VERSION, "rag_pipe_" + suffix);
        generationId = jdbc.queryForObject("SELECT id FROM rag_index_generation ORDER BY id DESC LIMIT 1",
                Long.class);
        registry.refreshUnitIfLive(RagNamespace.NOTEBOOK_SOURCE, sourceId);
        RagIndexableUnitRow unit = unitRow();
        // step 2 改的是**夹具**，一个期望值都没动 —— 两者的区别正是这个类要守住的东西。
        // 从「source_id + 资料哈希」的混合行换成 upsertUnitState 真正会写的那种行：
        // source_id 恒为 NULL（RagIndexJobService.java:729），content_hash 存的是
        // 单元的 canonical_hash（同文件 :733/:745）。旧写法当初能过，是因为检索侧
        // 按 sourceId 查、拿资料哈希比 —— 那条路 1c 之后在生产里已经不存在了。
        jdbc.update("INSERT INTO rag_source_index_state(source_id,unit_id,generation_id,index_version," +
                        "content_hash,status,vector_count,indexed_at) VALUES(NULL,?,?,?,?,'INDEXED',3,NOW())",
                unit.id(), generationId, INDEX_VERSION,
                jdbc.queryForObject("SELECT canonical_hash FROM rag_indexable_unit WHERE id=?",
                        String.class, unit.id()));
        CANDIDATES.set(List.of());
        LAST_QUERY_BODY.set("");
    }

    private record RagIndexableUnitRow(Long id) {}

    private RagIndexableUnitRow unitRow() {
        return new RagIndexableUnitRow(jdbc.queryForObject(
                "SELECT id FROM rag_indexable_unit WHERE namespace='NOTEBOOK_SOURCE' AND ref_id=?",
                Long.class, sourceId));
    }

    /**
     * <b>Notebook-only 检索的当前行为</b>。这是「重写没有弄坏原本对的东西」的唯一证据。
     *
     * <p>断言形状是<b>逐位固定的有序三元组列表</b>，与
     * {@code ContextBudgeterCharacterizationTest} 一致 —— 只断言「有结果」的话，
     * 顺序变了、少了一条、内容错位都看不出来，而这三种正是重写最可能弄坏的。
     */
    @Test
    void notebook检索的候选集与顺序() {
        CANDIDATES.set(List.of(
                candidate(chunkIds.get(1), 0, 12, 0.11),
                candidate(chunkIds.get(0), 0, 12, 0.22),
                candidate(chunkIds.get(2), 0, 12, 0.33)));

        List<Map<String, Object>> rows = workspaceService.sourceContext(userId, notebookId,
                Map.of("query", "象限法怎么分类"));

        // 断言的是**正文的顺序**，不是候选身份的格式。
        // 身份格式（sourceType:sourceId 还是 namespace:unitId）在 1B-2 里会变，
        // 把它编进这条断言，就会在 step 2/3 逼出一次「合法地重写期望值」——
        // 而那和「调期望值直到它变绿」在 diff 里一模一样。正文顺序跨重写必须不变。
        assertEquals(List.of("第1段", "第0段", "第2段"),
                rows.stream().map(row -> String.valueOf(row.get(CandidateKeys.CONTENT)).substring(0, 3)).toList(),
                "顺序承重：它决定预算耗尽时谁被截掉，而 sidecar 的距离序必须原样传下来");
        assertTrue(rows.stream().allMatch(row -> "VECTOR".equals(row.get("retrievalMode"))),
                "三条都该走向量路径；混进关键词回落说明索引状态判定变了");
        assertEquals(INDEX_VERSION, rows.get(0).get("indexVersion"));
    }

    /**
     * 跨作用域候选必须被丢弃，且<b>记进掉候选计数</b>而不是悄悄消失。
     *
     * <p>桩返回一个不属于本 Notebook 的 chunkId —— 回填侧应当认出它并丢掉。
     * 这条同时是回填改写时的安全网：Wiki 接进来之后，回填要按 unitId 认领候选，
     * 认错的后果是<b>把别人的内容喂进模型上下文</b>。
     */
    @Test
    void 不属于本范围的候选被丢弃() {
        CANDIDATES.set(List.of(
                candidate(chunkIds.get(0), 0, 12, 0.11),
                candidate(chunkIds.get(0) + 999_000L, 0, 12, 0.12)));

        List<Map<String, Object>> rows = workspaceService.sourceContext(userId, notebookId,
                Map.of("query", "象限法"));

        assertEquals(1, rows.size(), "越界候选必须被丢掉，不能进上下文");
        assertEquals(chunkIds.get(0), ((Number) rows.get(0).get(CandidateKeys.CHUNK_ID)).longValue());
    }

    // ── 桩 ────────────────────────────────────────────────────────────────

    private static Map<String, Object> candidateOf(long chunkId, int charStart, int charEnd, double distance) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("chunkId", chunkId);
        row.put("charStart", charStart);
        row.put("charEnd", charEnd);
        row.put("distance", distance);
        return row;
    }

    private Map<String, Object> candidate(long chunkId, int charStart, int charEnd, double distance) {
        Map<String, Object> row = candidateOf(chunkId, charStart, charEnd, distance);
        row.put("sourceId", sourceId);
        row.put("chunkIndex", 0);
        row.put("segmentIndex", 0);
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

    private static void respond(com.sun.net.httpserver.HttpExchange exchange, String body) throws IOException {
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(200, payload.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(payload);
        }
    }
}
