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
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
}
