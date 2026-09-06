package com.zhiqu.service.impl;

import com.sun.net.httpserver.HttpServer;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiConversation;
import com.zhiqu.service.AiService;
import com.zhiqu.service.AiWorkspaceService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
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

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Notebook 会话生命周期回归（全部经 AiService 完整入口，模型指向内嵌假端点）：
 * 1) 慢模型请求进行中清空记忆：旧请求不得把消息写回软删会话后随复活重现（并发穿透）；
 * 2) 慢模型请求进行中删除 Notebook：迟到写入必须被归属校验拒绝（非流式抛错；流式 run 取消、零副作用）；
 * 3) 清空记忆后同 Notebook 可正常再聊（软删行占用唯一键，需复活而非撞键）；
 * 4) 他人 / 不存在 / 已删除 Notebook 的聊天读取被拒绝；
 * 5) 新 Notebook 首次并发发送不撞唯一键；
 * 6) 流式竞态重建：消息对带回完整执行链路元数据，run 外键与检索工件来源重绑到存活新行；
 * 7) 第二阶段慢计算窗口（记忆整理 / 计划提取的追加模型调用）期间的删除同样不得穿透：
 *    Revision / 草稿工件零残留，非流式接口整体失败，流式 run 标记 CANCELED。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.ai.allow-private-provider-url=true"
})
class AiConversationLifecycleIntegrationTest {

    static {
        // Docker 29 rejects the 1.32 API used by older docker-java defaults.
        System.setProperty("api.version", System.getProperty("api.version", "1.40"));
    }

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    /**
     * 内嵌假模型端点：请求体带 "stream":true 时返回 SSE 增量，否则返回普通 JSON。
     * blockGate 装载后，第 blockAtRequest 个请求会挂起直到放行，用于制造“模型响应中”的窗口
     * （流式/首次调用设 1；记忆整理等第二次调用设 2）。
     */
    private static HttpServer fakeModelServer;
    private static volatile CountDownLatch blockGate;
    private static volatile CountDownLatch enteredGate;
    private static volatile int blockAtRequest;
    private static final java.util.concurrent.atomic.AtomicInteger requestCounter =
            new java.util.concurrent.atomic.AtomicInteger();
    /**
     * 最后一次<b>流式</b>请求的请求体。摘要判脏与否，唯一诚实的观察点就是「这一轮到底发给模型什么」——
     * 查库只能看到摘要还在，看不到它有没有被用上。只认流式：摘要器/记忆抽取自己也调模型，那些是非流式。
     */
    private static volatile String lastStreamingRequestBody;

    @BeforeAll
    static void startFakeModelServer() throws Exception {
        fakeModelServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        fakeModelServer.createContext("/v1/chat/completions", exchange -> {
            String requestBody = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            int seq = requestCounter.incrementAndGet();
            if (blockAtRequest > 0 && seq == blockAtRequest) {
                CountDownLatch entered = enteredGate;
                if (entered != null) {
                    entered.countDown();
                }
                CountDownLatch gate = blockGate;
                if (gate != null) {
                    try {
                        gate.await(20, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }
            }
            boolean streaming = requestBody.contains("\"stream\":true") || requestBody.contains("\"stream\": true");
            if (streaming) {
                lastStreamingRequestBody = requestBody;
            }
            byte[] body = (streaming
                    ? "data: {\"choices\":[{\"delta\":{\"content\":\"流式测试回复\"}}]}\n\ndata: [DONE]\n\n"
                    : "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"测试回复\"}}]}")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", streaming ? "text/event-stream" : "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        fakeModelServer.setExecutor(Executors.newCachedThreadPool());
        fakeModelServer.start();
    }

    @AfterAll
    static void stopFakeModelServer() {
        if (fakeModelServer != null) {
            fakeModelServer.stop(0);
        }
    }

    @Autowired
    private AiService aiService;

    @Autowired
    private AiWorkspaceService aiWorkspaceService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private Long userId;
    private Long modelId;

    @BeforeEach
    void createUserAndModel() {
        blockGate = null;
        enteredGate = null;
        blockAtRequest = 0;
        requestCounter.set(0);
        lastStreamingRequestBody = null;
        userId = seedUser();
        modelId = createModel(userId);
    }

    private Long seedUser() {
        String username = "ai_conv_" + UUID.randomUUID().toString().replace("-", "");
        jdbcTemplate.update(
                "INSERT INTO sys_user(username, password, nickname, role, deleted) VALUES (?, ?, ?, 'USER', 0)",
                username, "test-password", "Ai Conv Test");
        Long id = jdbcTemplate.queryForObject("SELECT id FROM sys_user WHERE username = ?", Long.class, username);
        assertNotNull(id);
        return id;
    }

    private Long createModel(Long ownerId) {
        String apiUrl = "http://127.0.0.1:" + fakeModelServer.getAddress().getPort() + "/v1/chat/completions";
        Map<String, Object> model = aiService.saveModel(ownerId, null, Map.of(
                "providerType", "OPENAI_COMPATIBLE",
                "displayName", "fake-endpoint",
                "apiUrl", apiUrl,
                "apiKey", "sk-test",
                "modelName", "fake-model"));
        return ((Number) model.get("id")).longValue();
    }

    private Long createNotebook(Long ownerId, String title) {
        Map<String, Object> notebook = aiWorkspaceService.createNotebook(ownerId, Map.of("title", title));
        return ((Number) notebook.get("id")).longValue();
    }

    /** 中性消息：避开 wiki 写入 / 任务创建 / 记忆整理的意图词，聊天路径只调一次模型 */
    private Map<String, Object> chat(Long ownerId, Long notebookId, String text) {
        return aiService.chat(ownerId, text, modelId, false, "OFF", notebookId);
    }

    private Map<String, Object> conversationRow(Long ownerId, Long notebookId) {
        return jdbcTemplate.queryForMap(
                "SELECT id, deleted FROM ai_conversation WHERE user_id = ? AND conversation_key = ?",
                ownerId, AiConversation.notebookKey(notebookId));
    }

    @Test
    void deletingLastNotebookKeepsARealEmptyWorkspace() {
        assertTrue(aiWorkspaceService.listNotebooks(userId).isEmpty(),
                "读取 Notebook 列表不应隐式创建默认 Notebook");
        Long notebookId = createNotebook(userId, "可删除的唯一 Notebook");
        assertEquals(1, aiWorkspaceService.listNotebooks(userId).size());

        aiWorkspaceService.deleteNotebook(userId, notebookId);

        assertTrue(aiWorkspaceService.listNotebooks(userId).isEmpty(),
                "删除最后一个 Notebook 后刷新仍应为空");
    }

    @Test
    void notebooksKeepIndependentChatHistories() {
        Long first = createNotebook(userId, "Notebook A");
        Long second = createNotebook(userId, "Notebook B");

        chat(userId, first, "A 的问题");
        chat(userId, second, "B 的问题");

        List<Map<String, Object>> firstHistory = aiService.getRecentChatMessages(userId, first, 50);
        List<Map<String, Object>> secondHistory = aiService.getRecentChatMessages(userId, second, 50);
        assertEquals(2, firstHistory.size());
        assertEquals(2, secondHistory.size());
        assertEquals("A 的问题", firstHistory.get(0).get("content"));
        assertEquals("B 的问题", secondHistory.get(0).get("content"));
    }

    @Test
    void deletingNotebookClearsOnlyItsChatHistory() {
        Long removed = createNotebook(userId, "待删除 Notebook");
        Long retained = createNotebook(userId, "保留 Notebook");
        chat(userId, removed, "应删除的问题");
        chat(userId, retained, "应保留的问题");

        aiWorkspaceService.deleteNotebook(userId, removed);

        Integer removedLiveMessages = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM ai_message m JOIN ai_conversation c ON c.id = m.conversation_id "
                        + "WHERE c.user_id = ? AND c.conversation_key = ? AND m.deleted = 0",
                Integer.class, userId, AiConversation.notebookKey(removed));
        assertEquals(0, removedLiveMessages);
        assertThrows(BusinessException.class, () -> aiService.getRecentChatMessages(userId, removed, 50));
        assertThrows(BusinessException.class, () -> aiWorkspaceService.listRuns(userId, removed));

        List<Map<String, Object>> retainedHistory = aiService.getRecentChatMessages(userId, retained, 50);
        assertEquals(2, retainedHistory.size());
        assertEquals("应保留的问题", retainedHistory.get(0).get("content"));
    }

    @Test
    void clearMemoryDuringInFlightChatDoesNotResurrectStaleHistory() throws Exception {
        Long notebookId = createNotebook(userId, "清空竞态");
        chat(userId, notebookId, "你好");
        assertEquals(2, aiService.getRecentChatMessages(userId, notebookId, 50).size());

        requestCounter.set(0);
        blockAtRequest = 1;
        enteredGate = new CountDownLatch(1);
        blockGate = new CountDownLatch(1);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<Map<String, Object>> inFlight = pool.submit(() -> chat(userId, notebookId, "第二个问题"));
            assertTrue(enteredGate.await(10, TimeUnit.SECONDS), "假模型端点应已收到请求");
            // 模型响应中(不持锁)清空记忆:必须立即完成,不被慢请求阻塞
            aiService.clearMemory(userId);
            blockGate.countDown();
            inFlight.get(30, TimeUnit.SECONDS);
        } finally {
            pool.shutdownNow();
        }
        // 迟到写入在锁内重解析会话:复活后只包含清空之后的新问答对,清空前的历史不得重现
        List<Map<String, Object>> visible = aiService.getRecentChatMessages(userId, notebookId, 50);
        assertEquals(2, visible.size());
        assertEquals("第二个问题", visible.get(0).get("content"));
        assertEquals(0, ((Number) conversationRow(userId, notebookId).get("deleted")).intValue());
    }

    @Test
    void deleteNotebookDuringInFlightChatRejectsLateWrite() throws Exception {
        Long notebookId = createNotebook(userId, "删除竞态");
        chat(userId, notebookId, "你好");

        requestCounter.set(0);
        blockAtRequest = 1;
        enteredGate = new CountDownLatch(1);
        blockGate = new CountDownLatch(1);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<Map<String, Object>> inFlight = pool.submit(() -> chat(userId, notebookId, "迟到的写入"));
            assertTrue(enteredGate.await(10, TimeUnit.SECONDS));
            aiWorkspaceService.deleteNotebook(userId, notebookId);
            blockGate.countDown();
            ExecutionException error = assertThrows(ExecutionException.class,
                    () -> inFlight.get(30, TimeUnit.SECONDS));
            assertInstanceOf(BusinessException.class, error.getCause());
        } finally {
            pool.shutdownNow();
        }
        // 会话已随 notebook 级联软删,且没有任何迟到消息以活动状态漏进去
        assertEquals(1, ((Number) conversationRow(userId, notebookId).get("deleted")).intValue());
        Integer liveMessages = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM ai_message m JOIN ai_conversation c ON c.id = m.conversation_id "
                        + "WHERE c.user_id = ? AND c.conversation_key = ? AND m.deleted = 0",
                Integer.class, userId, AiConversation.notebookKey(notebookId));
        assertEquals(0, liveMessages);
        assertThrows(BusinessException.class, () -> aiService.getRecentChatMessages(userId, notebookId, 50));
    }

    @Test
    void clearMemoryThenSameNotebookCanChatAgain() {
        Long notebookId = createNotebook(userId, "清空后复聊");
        chat(userId, notebookId, "你好");
        aiService.clearMemory(userId);
        assertEquals(1, ((Number) conversationRow(userId, notebookId).get("deleted")).intValue());

        // 关键回归:软删行仍占用 (user_id, conversation_key) 唯一键,再次聊天必须复活同一行而不是撞键
        chat(userId, notebookId, "清空后再见");
        Map<String, Object> revived = conversationRow(userId, notebookId);
        assertEquals(0, ((Number) revived.get("deleted")).intValue());
        List<Map<String, Object>> visible = aiService.getRecentChatMessages(userId, notebookId, 50);
        assertEquals(2, visible.size());
        assertEquals("清空后再见", visible.get(0).get("content"));
        Integer rows = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM ai_conversation WHERE user_id = ? AND conversation_key = ?",
                Integer.class, userId, AiConversation.notebookKey(notebookId));
        assertEquals(1, rows);
    }

    @Test
    void chatReadIsRejectedForForeignMissingOrDeletedNotebook() {
        assertThrows(BusinessException.class, () -> aiService.getRecentChatMessages(userId, 999_999L, 50));

        Long otherUserId = seedUser();
        Long foreignNotebookId = createNotebook(otherUserId, "他人 Notebook");
        assertThrows(BusinessException.class, () -> aiService.getRecentChatMessages(userId, foreignNotebookId, 50));

        Long notebookId = createNotebook(userId, "待删 Notebook");
        chat(userId, notebookId, "你好");
        aiWorkspaceService.deleteNotebook(userId, notebookId);
        assertThrows(BusinessException.class, () -> aiService.getRecentChatMessages(userId, notebookId, 50));
    }

    /** 等待最近一次流式 AgentRun 落到终态（MOCK 环境拿不到 SseEmitter 完成回调，轮询 DB 状态） */
    private Long latestRunId(Long ownerId, Long notebookId) {
        List<Map<String, Object>> rows = jdbcTemplate.queryForList(
                "SELECT id FROM ai_agent_run WHERE user_id = ? AND notebook_id = ? ORDER BY id DESC LIMIT 1",
                ownerId, notebookId);
        return rows.isEmpty() ? null : ((Number) rows.get(0).get("id")).longValue();
    }

    /**
     * 等<b>比 previousRunId 更新的</b>那个 run 结束。
     *
     * <p>同一个 notebook 连发多轮时不能用 awaitLatestRunFinished：streamChat 是异步的，
     * 新 run 的行还没插进去时，"最新一条已不是 RUNNING" 会被<b>上一轮的 DONE</b> 满足，
     * 于是立刻返回，后面断言看到的是上一轮的残留。
     */
    private void awaitRunAfter(Long ownerId, Long notebookId, Long previousRunId) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 30_000;
        while (System.currentTimeMillis() < deadline) {
            List<Map<String, Object>> rows = jdbcTemplate.queryForList(
                    "SELECT id, status FROM ai_agent_run WHERE user_id = ? AND notebook_id = ? ORDER BY id DESC LIMIT 1",
                    ownerId, notebookId);
            if (!rows.isEmpty()) {
                long id = ((Number) rows.get(0).get("id")).longValue();
                boolean isNew = previousRunId == null || id > previousRunId;
                if (isNew && !"RUNNING".equals(String.valueOf(rows.get(0).get("status")))) {
                    return;
                }
            }
            Thread.sleep(200);
        }
        throw new AssertionError("新的流式 run 未在 30s 内结束");
    }

    private void awaitLatestRunFinished(Long ownerId, Long notebookId) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 30_000;
        while (System.currentTimeMillis() < deadline) {
            List<Map<String, Object>> rows = jdbcTemplate.queryForList(
                    "SELECT status FROM ai_agent_run WHERE user_id = ? AND notebook_id = ? ORDER BY id DESC LIMIT 1",
                    ownerId, notebookId);
            if (!rows.isEmpty() && !"RUNNING".equals(String.valueOf(rows.get(0).get("status")))) {
                return;
            }
            Thread.sleep(200);
        }
        throw new AssertionError("流式 run 未在 30s 内结束");
    }

    @Test
    void streamClearMemoryDuringModelRebuildsPairInRevivedConversation() throws Exception {
        Long notebookId = createNotebook(userId, "流式清空竞态");
        chat(userId, notebookId, "你好");
        assertEquals(2, aiService.getRecentChatMessages(userId, notebookId, 50).size());

        requestCounter.set(0);
        blockAtRequest = 1;
        enteredGate = new CountDownLatch(1);
        blockGate = new CountDownLatch(1);
        aiService.streamChat(userId, "流式竞态问题", modelId, false, "OFF", notebookId, "CHAT_ONLY", Map.of());
        assertTrue(enteredGate.await(10, TimeUnit.SECONDS), "假模型端点应已收到流式请求");
        // 占位对已入库、模型响应中(不持锁):清空软删它们
        aiService.clearMemory(userId);
        blockGate.countDown();
        awaitLatestRunFinished(userId, notebookId);

        // 收尾发现占位对被软删且 notebook 仍在 → 迟到问答成对重建;清空前历史不得重现
        List<Map<String, Object>> visible = aiService.getRecentChatMessages(userId, notebookId, 50);
        assertEquals(2, visible.size());
        assertEquals("流式竞态问题", visible.get(0).get("content"));
        assertEquals("流式测试回复", visible.get(1).get("content"));
        assertEquals(0, ((Number) conversationRow(userId, notebookId).get("deleted")).intValue());

        // 重建不只是内容:执行链路元数据必须一并带回,run 的两个消息外键必须重绑到存活的新行,
        // 否则执行轨迹/artifact/done 事件全都悬挂在已软删的旧消息 ID 上
        List<Map<String, Object>> liveRows = jdbcTemplate.queryForList(
                "SELECT m.id, m.role, m.request_id, m.provider_type, m.model_name, m.agent_run_id "
                        + "FROM ai_message m JOIN ai_conversation c ON c.id = m.conversation_id "
                        + "WHERE c.user_id = ? AND c.conversation_key = ? AND m.deleted = 0 ORDER BY m.id",
                userId, AiConversation.notebookKey(notebookId));
        assertEquals(2, liveRows.size());
        Map<String, Object> liveUser = liveRows.get(0);
        Map<String, Object> liveAssistant = liveRows.get(1);
        assertEquals("user", liveUser.get("role"));
        assertEquals("assistant", liveAssistant.get("role"));
        assertNotNull(liveAssistant.get("request_id"), "重建的助手消息应带回 requestId");
        assertEquals("OPENAI_COMPATIBLE", liveAssistant.get("provider_type"));
        assertEquals("fake-model", liveAssistant.get("model_name"));
        assertNotNull(liveUser.get("agent_run_id"), "重建的用户消息应挂回 agentRun");
        assertNotNull(liveAssistant.get("agent_run_id"), "重建的助手消息应挂回 agentRun");
        Map<String, Object> run = jdbcTemplate.queryForMap(
                "SELECT status, user_message_id, assistant_message_id FROM ai_agent_run "
                        + "WHERE user_id = ? AND notebook_id = ? ORDER BY id DESC LIMIT 1",
                userId, notebookId);
        assertEquals("DONE", run.get("status"));
        assertEquals(((Number) liveUser.get("id")).longValue(), ((Number) run.get("user_message_id")).longValue());
        assertEquals(((Number) liveAssistant.get("id")).longValue(), ((Number) run.get("assistant_message_id")).longValue());
    }

    @Test
    void streamDeleteNotebookDuringModelDropsLateAnswer() throws Exception {
        Long notebookId = createNotebook(userId, "流式删除竞态");
        chat(userId, notebookId, "你好");

        requestCounter.set(0);
        blockAtRequest = 1;
        enteredGate = new CountDownLatch(1);
        blockGate = new CountDownLatch(1);
        // “记住…”让消息带上记忆整理意图:若丢弃后流水线未终止,会发起第二次模型调用并留下记忆 Revision
        aiService.streamChat(userId, "记住迟到的流式问题", modelId, false, "OFF", notebookId, "CHAT_ONLY", Map.of());
        assertTrue(enteredGate.await(10, TimeUnit.SECONDS));
        aiWorkspaceService.deleteNotebook(userId, notebookId);
        blockGate.countDown();
        awaitLatestRunFinished(userId, notebookId);

        // notebook 已删 → 清空胜出:迟到回答不得重建,会话保持软删、无存活消息
        assertEquals(1, ((Number) conversationRow(userId, notebookId).get("deleted")).intValue());
        Integer liveMessages = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM ai_message m JOIN ai_conversation c ON c.id = m.conversation_id "
                        + "WHERE c.user_id = ? AND c.conversation_key = ? AND m.deleted = 0",
                Integer.class, userId, AiConversation.notebookKey(notebookId));
        assertEquals(0, liveMessages);

        // 丢弃必须终止整条流水线:run 标记取消(而非成功 DONE),不再提炼记忆、不再产出草稿工件
        Map<String, Object> run = jdbcTemplate.queryForMap(
                "SELECT id, status FROM ai_agent_run WHERE user_id = ? AND notebook_id = ? ORDER BY id DESC LIMIT 1",
                userId, notebookId);
        assertEquals("CANCELED", run.get("status"));
        Integer memoryRevisions = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM user_knowledge_revision WHERE user_id = ? AND title = '对话提炼记忆'",
                Integer.class, userId);
        assertEquals(0, memoryRevisions, "丢弃后不得再提炼长期记忆");
        Integer draftArtifacts = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM ai_agent_artifact WHERE run_id = ? "
                        + "AND artifact_type IN ('PLAN_DRAFT','TASK_DRAFT','ROUTINE_DRAFT','WIKI_DRAFT')",
                Integer.class, ((Number) run.get("id")).longValue());
        assertEquals(0, draftArtifacts, "丢弃后不得再产出计划/Wiki 草稿工件");
    }

    @Test
    void memoryChatDeleteNotebookDuringSecondModelCallLeavesNoRevision() throws Exception {
        Long notebookId = createNotebook(userId, "记忆穿透删除");
        // 非流式:第一次调用产出回答,第二次调用整理记忆;在第二次调用期间删除 notebook。
        // 最终锁内事务的归属校验会拒绝整对消息——记忆 Revision 必须同事务回滚,不得留下已提交的副作用
        requestCounter.set(0);
        blockAtRequest = 2;
        enteredGate = new CountDownLatch(1);
        blockGate = new CountDownLatch(1);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<Map<String, Object>> inFlight = pool.submit(
                    () -> chat(userId, notebookId, "记住我不喜欢在早上学习"));
            assertTrue(enteredGate.await(10, TimeUnit.SECONDS), "记忆整理调用应已到达假端点");
            aiWorkspaceService.deleteNotebook(userId, notebookId);
            blockGate.countDown();
            ExecutionException error = assertThrows(ExecutionException.class,
                    () -> inFlight.get(30, TimeUnit.SECONDS));
            assertInstanceOf(BusinessException.class, error.getCause());
        } finally {
            pool.shutdownNow();
        }
        Integer memoryRevisions = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM user_knowledge_revision WHERE user_id = ? AND title = '对话提炼记忆'",
                Integer.class, userId);
        assertEquals(0, memoryRevisions, "接口失败时不得留下已提交的记忆 Revision");
        Integer liveMessages = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM ai_message m JOIN ai_conversation c ON c.id = m.conversation_id "
                        + "WHERE c.user_id = ? AND c.conversation_key = ? AND m.deleted = 0",
                Integer.class, userId, AiConversation.notebookKey(notebookId));
        assertEquals(0, liveMessages);
    }

    @Test
    void streamMemoryChatDeleteNotebookDuringSecondModelCallDropsEverything() throws Exception {
        Long notebookId = createNotebook(userId, "流式二段删除");
        // 流式主回答(第 1 个请求)正常返回;记忆整理(第 2 个请求)期间删除 notebook。
        // 归属校验必须发生在全部慢计算之后:迟到回答/记忆 Revision 都不得落库,run 取消而非 DONE
        requestCounter.set(0);
        blockAtRequest = 2;
        enteredGate = new CountDownLatch(1);
        blockGate = new CountDownLatch(1);
        aiService.streamChat(userId, "记住流式二段删除验证", modelId, false, "OFF", notebookId, "CHAT_ONLY", Map.of());
        assertTrue(enteredGate.await(10, TimeUnit.SECONDS), "记忆整理调用应已到达假端点");
        aiWorkspaceService.deleteNotebook(userId, notebookId);
        blockGate.countDown();
        awaitLatestRunFinished(userId, notebookId);

        Map<String, Object> run = jdbcTemplate.queryForMap(
                "SELECT id, status FROM ai_agent_run WHERE user_id = ? AND notebook_id = ? ORDER BY id DESC LIMIT 1",
                userId, notebookId);
        assertEquals("CANCELED", run.get("status"), "第二阶段模型调用期间的删除同样必须取消 run");
        Integer memoryRevisions = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM user_knowledge_revision WHERE user_id = ? AND title = '对话提炼记忆'",
                Integer.class, userId);
        assertEquals(0, memoryRevisions, "丢弃后不得提交记忆 Revision");
        Integer liveMessages = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM ai_message m JOIN ai_conversation c ON c.id = m.conversation_id "
                        + "WHERE c.user_id = ? AND c.conversation_key = ? AND m.deleted = 0",
                Integer.class, userId, AiConversation.notebookKey(notebookId));
        assertEquals(0, liveMessages);
    }

    @Test
    void planChatDeleteNotebookDuringPlanModelCallRejectsWhole() throws Exception {
        Long notebookId = createNotebook(userId, "计划提取删除");
        // “生成…计划”触发计划提取(第 2 个请求,tool-call 尝试);在计划提取期间删除 notebook。
        // 计划提取已前置到最终事务之前:接口必须整体失败,不得"成功"返回已删除的消息 ID 与计划建议
        requestCounter.set(0);
        blockAtRequest = 2;
        enteredGate = new CountDownLatch(1);
        blockGate = new CountDownLatch(1);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<Map<String, Object>> inFlight = pool.submit(
                    () -> chat(userId, notebookId, "帮我生成一个学习计划"));
            assertTrue(enteredGate.await(10, TimeUnit.SECONDS), "计划提取调用应已到达假端点");
            aiWorkspaceService.deleteNotebook(userId, notebookId);
            blockGate.countDown();
            ExecutionException error = assertThrows(ExecutionException.class,
                    () -> inFlight.get(30, TimeUnit.SECONDS));
            assertInstanceOf(BusinessException.class, error.getCause());
        } finally {
            pool.shutdownNow();
        }
        Integer liveMessages = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM ai_message m JOIN ai_conversation c ON c.id = m.conversation_id "
                        + "WHERE c.user_id = ? AND c.conversation_key = ? AND m.deleted = 0",
                Integer.class, userId, AiConversation.notebookKey(notebookId));
        assertEquals(0, liveMessages);
        assertEquals(1, ((Number) conversationRow(userId, notebookId).get("deleted")).intValue());
    }

    @Test
    void streamClearMemoryDuringModelRebindsRetrieverArtifactsToRebuiltMessage() throws Exception {
        Long notebookId = createNotebook(userId, "重绑真实工件");
        // 直接种入 READY 资料 + 分块,让 RESEARCH 模式在模型调用前产出真实 CITATION 工件(来源=旧用户消息)
        jdbcTemplate.update(
                "INSERT INTO ai_notebook_source(user_id, notebook_id, source_type, title, status, deleted) "
                        + "VALUES (?, ?, 'TEXT', '种子资料', 'READY', 0)",
                userId, notebookId);
        Long sourceId = jdbcTemplate.queryForObject(
                "SELECT id FROM ai_notebook_source WHERE user_id = ? AND notebook_id = ?", Long.class, userId, notebookId);
        jdbcTemplate.update(
                "INSERT INTO ai_source_chunk(source_id, chunk_index, content) VALUES (?, 0, '象限时间管理法测试资料内容')",
                sourceId);

        requestCounter.set(0);
        blockAtRequest = 1;
        enteredGate = new CountDownLatch(1);
        blockGate = new CountDownLatch(1);
        aiService.streamChat(userId, "总结一下这份资料", modelId, false, "OFF", notebookId, "RESEARCH", Map.of());
        assertTrue(enteredGate.await(10, TimeUnit.SECONDS));
        aiService.clearMemory(userId);
        blockGate.countDown();
        awaitLatestRunFinished(userId, notebookId);

        // 重建后:run 外键指向存活新行,检索阶段以旧用户消息为来源的 CITATION 工件必须全部改指新行
        Map<String, Object> run = jdbcTemplate.queryForMap(
                "SELECT id, status, user_message_id, assistant_message_id FROM ai_agent_run "
                        + "WHERE user_id = ? AND notebook_id = ? ORDER BY id DESC LIMIT 1",
                userId, notebookId);
        assertEquals("DONE", run.get("status"));
        Long liveUserId = jdbcTemplate.queryForObject(
                "SELECT m.id FROM ai_message m JOIN ai_conversation c ON c.id = m.conversation_id "
                        + "WHERE c.user_id = ? AND c.conversation_key = ? AND m.deleted = 0 AND m.role = 'user' "
                        + "ORDER BY m.id DESC LIMIT 1",
                Long.class, userId, AiConversation.notebookKey(notebookId));
        assertNotNull(liveUserId);
        assertEquals(liveUserId.longValue(), ((Number) run.get("user_message_id")).longValue());
        Long runId = ((Number) run.get("id")).longValue();
        Integer citationArtifacts = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM ai_agent_artifact WHERE run_id = ? AND source_message_id IS NOT NULL",
                Integer.class, runId);
        assertTrue(citationArtifacts != null && citationArtifacts >= 1, "检索阶段应产出至少一个带来源的工件");
        Integer staleArtifacts = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM ai_agent_artifact WHERE run_id = ? AND source_message_id IS NOT NULL "
                        + "AND source_message_id <> ?",
                Integer.class, runId, liveUserId);
        assertEquals(0, staleArtifacts, "重建后不得有工件仍指向已软删的旧用户消息");
    }

    @Test
    void memoryWorthyChatClearedDuringSecondModelCallKeepsPairIntact() throws Exception {
        Long notebookId = createNotebook(userId, "记忆整理竞态");
        // “记住…”触发记忆整理的第二次模型调用;在第二次调用期间清空记忆
        requestCounter.set(0);
        blockAtRequest = 2;
        enteredGate = new CountDownLatch(1);
        blockGate = new CountDownLatch(1);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<Map<String, Object>> inFlight = pool.submit(
                    () -> chat(userId, notebookId, "记住我不喜欢在早上学习"));
            assertTrue(enteredGate.await(10, TimeUnit.SECONDS), "记忆整理调用应已到达假端点");
            aiService.clearMemory(userId);
            blockGate.countDown();
            inFlight.get(30, TimeUnit.SECONDS);
        } finally {
            pool.shutdownNow();
        }
        // 成对落库在全部慢计算之后:清空竞态下用户/助手消息要么都在、要么都不在,绝不只剩助手
        List<Map<String, Object>> visible = aiService.getRecentChatMessages(userId, notebookId, 50);
        assertEquals(2, visible.size());
        assertEquals("user", visible.get(0).get("role"));
        assertEquals("记住我不喜欢在早上学习", visible.get(0).get("content"));
        assertEquals("assistant", visible.get(1).get("role"));
    }

    @Test
    void concurrentFirstChatDoesNotHitUniqueKey() throws Exception {
        Long notebookId = createNotebook(userId, "并发首聊");
        int threads = 2;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            CountDownLatch ready = new CountDownLatch(threads);
            CountDownLatch go = new CountDownLatch(1);
            Future<?>[] futures = new Future<?>[threads];
            for (int i = 0; i < threads; i++) {
                final int seq = i;
                futures[i] = pool.submit(() -> {
                    ready.countDown();
                    go.await();
                    return chat(userId, notebookId, "并发消息 " + seq);
                });
            }
            assertTrue(ready.await(5, TimeUnit.SECONDS));
            go.countDown();
            for (Future<?> future : futures) {
                future.get(30, TimeUnit.SECONDS); // 任何一边撞唯一键都会在这里抛出
            }
        } finally {
            pool.shutdownNow();
        }
        Integer active = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM ai_conversation WHERE user_id = ? AND conversation_key = ? AND deleted = 0",
                Integer.class, userId, AiConversation.notebookKey(notebookId));
        assertEquals(1, active);
        assertEquals(4, aiService.getRecentChatMessages(userId, notebookId, 50).size());
    }

    /** 一个用例：这句话该造出哪些节点，其中哪些该被 settleUnrunTasks 扫成 SKIPPED。 */
    private record GraphCase(String message, Set<String> created, Set<String> swept, String why) {
    }

    /**
     * 表驱动：每一轮问答<b>造出哪些节点</b>、其中<b>哪些被扫掉</b>，都必须是写在案上的预期。
     *
     * <h2>为什么不能只断言「都到了终态」</h2>
     *
     * <p>TASK_DRAFTER 那个缺陷（成功结束的 run 里留着永久 PENDING 行）是靠 PENDING 被逮到的。
     * 收尾的 settleUnrunTasks 是对的网，但它把 PENDING 抹成 SKIPPED 之后，
     * <b>和一次正当的「本轮无事可做」在库里完全同形</b> —— 那条判据在 PENDING 这一侧的牙就被拔掉了，
     * 只剩 RUNNING 那半边。所以这里连「被扫掉的集合」一起钉住：它变了，就有东西红。
     *
     * <p>第三行不是补充，是这张网的<b>第一个真实客户</b>：「知识库里有什么」是最普通的 wiki 读问题，
     * 建图侧平表 OR 命中「知识库」造出 WIKI_CURATOR，执行侧两张表 AND 要求写动词 ——
     * 这个节点结构上不可能运行。<b>每一次这样的提问</b>都会造出它，然后被扫掉。
     * 把它记在案上，是为了让「常见交互每次都造一个跑不了的节点」这件事有人看着，
     * 而不是躺在 SKIPPED 里和正常情形混在一起。
     */
    @Test
    void 每轮造出的节点与被扫掉的节点都必须符合预期() throws Exception {
        List<GraphCase> cases = List.of(
                new GraphCase("你好",
                        Set.of("ORCHESTRATOR", "NOTEBOOK_RESEARCHER", "VERIFIER", "FINAL_WRITER"),
                        Set.of(),
                        "对照组：不造条件节点，也就没有东西可扫。少了这一行，下面两行可能是在「什么都被扫」上通过的"),
                new GraphCase("帮我生成任务",
                        Set.of("ORCHESTRATOR", "NOTEBOOK_RESEARCHER", "PLANNER", "TASK_DRAFTER", "VERIFIER", "FINAL_WRITER"),
                        Set.of("TASK_DRAFTER"),
                        "命中 needsTaskDraft 造出节点，而模型没解析出计划 → 那段 if 整个不进"),
                new GraphCase("知识库里有什么",
                        Set.of("ORCHESTRATOR", "NOTEBOOK_RESEARCHER", "WIKI_CURATOR", "VERIFIER", "FINAL_WRITER"),
                        Set.of("WIKI_CURATOR"),
                        "建图侧 OR 命中「知识库」，执行侧 AND 还要写动词 → 结构上不可能运行"));

        for (GraphCase testCase : cases) {
            Long notebookId = createNotebook(userId, "节点预期 " + testCase.message());
            aiService.streamChat(userId, testCase.message(), modelId, false, "OFF", notebookId, "AUTO", Map.of());
            awaitLatestRunFinished(userId, notebookId);

            Map<String, Object> run = jdbcTemplate.queryForMap(
                    "SELECT id, status FROM ai_agent_run WHERE user_id = ? AND notebook_id = ? ORDER BY id DESC LIMIT 1",
                    userId, notebookId);
            assertEquals("DONE", run.get("status"),
                    "「" + testCase.message() + "」应正常结束，否则下面查的是失败路径");
            List<Map<String, Object>> rows = jdbcTemplate.queryForList(
                    "SELECT agent_type, status, public_summary FROM ai_agent_task WHERE run_id = ?",
                    ((Number) run.get("id")).longValue());

            assertEquals(testCase.created(),
                    rows.stream().map(row -> String.valueOf(row.get("agent_type"))).collect(Collectors.toSet()),
                    "「" + testCase.message() + "」造出的节点与预期不符（" + testCase.why() + "）");

            Set<String> swept = rows.stream()
                    .filter(row -> "SKIPPED".equals(row.get("status"))
                            && AiServiceImpl.UNRUN_TASK_SUMMARY.equals(row.get("public_summary")))
                    .map(row -> String.valueOf(row.get("agent_type")))
                    .collect(Collectors.toSet());
            assertEquals(testCase.swept(), swept,
                    "「" + testCase.message() + "」被 settleUnrunTasks 扫掉的节点与预期不符（" + testCase.why()
                            + "）。这一列变了就说明有节点开始（或不再）空跑，值得看一眼再改预期");

            List<Map<String, Object>> stranded = rows.stream()
                    .filter(row -> !List.of("DONE", "SKIPPED", "ERROR").contains(String.valueOf(row.get("status"))))
                    .toList();
            assertTrue(stranded.isEmpty(),
                    "「" + testCase.message() + "」的 run 已结束，这些节点仍停在非终态：" + stranded
                            + "。造出来的节点必须走到终态，否则执行轨迹里永远挂着一个转圈的 agent");
        }
    }

    /** 摘要注入块的表头，与 AiServiceImpl.SUMMARY_BLOCK_HEADER 同源；出现在请求体里就说明摘要被用上了。 */
    private static final String SUMMARY_MARK = "【对话摘要";

    /**
     * 摘要的读侧指纹：删掉一条被摘要覆盖的消息之后，那份摘要必须立刻判脏 —— 既不能再注入给模型，
     * 也必须在同一轮重算。
     *
     * <h2>为什么观察「发给模型的请求体」而不是查库</h2>
     *
     * <p>查库只能确认摘要行还在，确认不了它<b>有没有被用上</b>。而这条判据要防的正是
     * 「摘要里留着用户已删的内容、还继续喂给模型」—— 那是「清空/删除」这个动作没有真正生效。
     * 唯一能分辨的观察点是这一轮实际发出去的提示词。
     *
     * <h2>三步各自的作用，缺一不可</h2>
     *
     * <ol>
     *   <li><b>删之前必须先看到摘要在场</b>（下界）。少了这一步，最后一步的「不在场」可能是
     *       从头到尾就没生成过摘要 —— 一条永远绿的判据。</li>
     *   <li>删一条 {@code id <= summary_upto_message_id} 的消息 —— 必须落在覆盖区间内，
     *       删窗口内的消息不改变区间指纹，测不到东西。</li>
     *   <li>删之后摘要既不注入（判脏），指纹又重新对上（当轮重算）。只断言前者的话，
     *       「摘要功能整个坏掉」也能满足它。</li>
     * </ol>
     *
     * <p>扰动：拿掉 {@code usableSummary} 里的指纹比对 → 第三步的「不注入」变红。
     */
    @Test
    void 删掉被摘要覆盖的消息后摘要必须判脏并重算() throws Exception {
        Long notebookId = createNotebook(userId, "滚动摘要判脏");
        // 16 轮 = 32 条消息；流式那轮再加 2 条，窗口(20)之外剩 14 条 ≥ SUMMARY_REFRESH_MIN
        for (int i = 1; i <= 16; i++) {
            chat(userId, notebookId, "第 " + i + " 句闲聊");
        }
        Long conversationId = ((Number) conversationRow(userId, notebookId).get("id")).longValue();

        Long before = latestRunId(userId, notebookId);
        aiService.streamChat(userId, "再聊一句", modelId, false, "OFF", notebookId, "AUTO", Map.of());
        awaitRunAfter(userId, notebookId, before);
        Map<String, Object> summary = jdbcTemplate.queryForMap(
                "SELECT encrypted_summary, summary_upto_message_id, summary_live_count"
                        + " FROM ai_conversation WHERE id = ?", conversationId);
        assertNotNull(summary.get("encrypted_summary"),
                "滑出窗口的消息够多时应生成摘要，否则下面测的是「本来就没有摘要」");
        long upto = ((Number) summary.get("summary_upto_message_id")).longValue();

        // ① 下界：摘要必须先真的被注入过
        lastStreamingRequestBody = null;
        before = latestRunId(userId, notebookId);
        aiService.streamChat(userId, "接着聊", modelId, false, "OFF", notebookId, "AUTO", Map.of());
        awaitRunAfter(userId, notebookId, before);
        assertNotNull(lastStreamingRequestBody, "这一轮必须真的发出过流式请求，否则下面比的是上一轮的残留");
        assertTrue(lastStreamingRequestBody.contains(SUMMARY_MARK),
                "指纹干净时摘要应注入本轮提示词，否则第 ③ 步的「未注入」证明不了任何事");

        // ② 删一条落在覆盖区间内的消息
        Long covered = jdbcTemplate.queryForObject(
                "SELECT id FROM ai_message WHERE conversation_id = ? AND id <= ? AND deleted = 0"
                        + " ORDER BY id LIMIT 1", Long.class, conversationId, upto);
        assertNotNull(covered, "覆盖区间内应当有存活消息可删");
        aiService.deleteChatMessage(userId, covered);

        // ③ 判脏：不再注入，且同一轮重算
        lastStreamingRequestBody = null;
        before = latestRunId(userId, notebookId);
        aiService.streamChat(userId, "删完再聊", modelId, false, "OFF", notebookId, "AUTO", Map.of());
        awaitRunAfter(userId, notebookId, before);
        // 先钉住"这一轮真的发过流式请求"：body 为 null 时 contains 也是 false，
        // 空扫描和干净扫描在断言里同形 —— 本仓库栽过的那一种
        assertNotNull(lastStreamingRequestBody, "这一轮必须真的发出过流式请求，否则「未注入」是空扫描");
        assertFalse(lastStreamingRequestBody.contains(SUMMARY_MARK),
                "被摘要覆盖的消息已删，这份摘要里留着用户删掉的内容，不得再注入 ——"
                        + " 否则「删除」只是从列表里消失，模型那边照旧看得见");

        Map<String, Object> rebuilt = jdbcTemplate.queryForMap(
                "SELECT summary_upto_message_id, summary_live_count FROM ai_conversation WHERE id = ?",
                conversationId);
        Integer liveNow = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM ai_message WHERE conversation_id = ? AND id <= ? AND deleted = 0",
                Integer.class, conversationId, ((Number) rebuilt.get("summary_upto_message_id")).longValue());
        assertEquals(liveNow, ((Number) rebuilt.get("summary_live_count")).intValue(),
                "判脏后必须当轮重算，指纹重新对上；只「不注入」不重算的话，这段历史就一直丢着");
    }
}
