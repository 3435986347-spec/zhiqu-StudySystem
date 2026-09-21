package com.zhiqu.service.workspace;

import com.sun.net.httpserver.HttpServer;
import com.zhiqu.service.AiService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
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
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 刷题环路的<b>端到端</b>判据：读文件 → 跑判题 → 记薄弱点 → 生成改动草稿。
 *
 * <h2>为什么非要这一条</h2>
 *
 * <p>阶段 1–5 的其余判据都只验到<b>接缝</b>：门算得对不对、工具有没有下发、
 * 工件类型对不对。它们全绿，也不代表这条环路真的能从头走到尾 —— 中间任何一处
 * 「看起来接通、实际不通」都不会被它们发现。本轮已经撞到过三次这种东西：
 *
 * <ul>
 *   <li>刷题说法一条都不命中现有的门（环路建好了，用户走不到）</li>
 *   <li>图里造出 CODE_AGENT 节点而 runner 直接返回空（方块什么也没做）</li>
 *   <li>里程碑被 PLAN_EXTRACTOR 用空计划抹掉（草稿永远产不出）</li>
 * </ul>
 *
 * <p>所以这里用一个<b>脚本化的假模型</b>把整条链路真跑一遍：模型按顺序请求
 * 读文件、跑命令、写薄弱点、写代码草稿，然后断言磁盘和数据库上留下了正确的痕迹。
 *
 * <h2>其中一条断言是间接的，而这恰恰是它最有力的地方</h2>
 *
 * <p>「待合入变更草稿存在」<b>证明了命令确实跑过</b> —— 因为 {@code create_wiki_patch}
 * 只在 {@code CodeLoopState.ranCommand} 置位之后才会下发给模型。拿不到工具就调不出来，
 * 调不出来就不会有草稿。这比直接断言「exec 被调用过」更硬：它验的是那道门本身。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false",
        "app.ai.allow-private-provider-url=true",
        "server.address=127.0.0.1",
        "app.workspace.mode=EXEC"
})
class CodeAgentLoopIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    /** 工作区根要在 Spring 起来之前就存在 —— 它是启动期校验的输入。 */
    static Path workspaceRoot;

    @DynamicPropertySource
    static void workspaceProperties(DynamicPropertyRegistry registry) throws IOException {
        workspaceRoot = Files.createTempDirectory("zhiqu-code-loop");
        Files.writeString(workspaceRoot.resolve("solve.py"),
                "def two_sum(nums, target):\n    return []\n", StandardCharsets.UTF_8);
        Files.writeString(workspaceRoot.resolve("test_solve.py"),
                "from solve import two_sum\n"
                        + "assert two_sum([2, 7], 9) == [0, 1], '期望 [0, 1]'\n", StandardCharsets.UTF_8);
        registry.add("app.workspace.root", () -> workspaceRoot.toString());
    }

    private static HttpServer fakeModelServer;
    /** code agent 那一轮调用的计数 —— 脚本按它决定这一轮请求哪个工具。 */
    private static final AtomicInteger codeAgentRound = new AtomicInteger();

    /** code agent 的系统提示词里独有的一句，用来把它的调用和别的调用区分开。 */
    private static final String CODE_AGENT_MARK = "你在帮一名学生读懂和改进他自己电脑上的代码";

    @Autowired private AiService aiService;
    @Autowired private JdbcTemplate jdbcTemplate;

    private Long userId;
    private Long modelId;

    @BeforeAll
    static void startFakeModelServer() throws Exception {
        fakeModelServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        fakeModelServer.createContext("/v1/chat/completions", exchange -> {
            String requestBody = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            boolean streaming = requestBody.contains("\"stream\":true") || requestBody.contains("\"stream\": true");
            String json;
            if (!streaming && requestBody.contains(CODE_AGENT_MARK)) {
                json = codeAgentScript(codeAgentRound.incrementAndGet());
            } else if (streaming) {
                json = null;
            } else {
                json = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"测试回复\"}}]}";
            }
            byte[] body = (json == null
                    ? "data: {\"choices\":[{\"delta\":{\"content\":\"流式测试回复\"}}]}\n\ndata: [DONE]\n\n"
                    : json).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", json == null ? "text/event-stream" : "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        fakeModelServer.setExecutor(Executors.newCachedThreadPool());
        fakeModelServer.start();
    }

    /**
     * 脚本化的模型：第 n 轮请求第 n 个工具。
     *
     * <p>顺序是有意的 —— 它就是刷题环路本身：先读他的解法，再跑判题，
     * 判题失败之后记薄弱点，最后给出改动草稿。
     */
    private static String codeAgentScript(int round) {
        String name;
        String args;
        switch (round) {
            case 1 -> {
                name = "read_workspace_file";
                args = "{\\\"path\\\":\\\"solve.py\\\"}";
            }
            case 2 -> {
                name = "run_workspace_command";
                args = "{\\\"command\\\":\\\"python3\\\",\\\"args\\\":[\\\"test_solve.py\\\"]}";
            }
            case 3 -> {
                // 这一轮能不能调到，取决于上一轮真的跑过命令（ranCommand 门）
                name = "create_wiki_patch";
                args = "{\\\"title\\\":\\\"薄弱点：两数之和\\\",\\\"content\\\":\\\"返回空列表，没有实现查找\\\","
                        + "\\\"pageType\\\":\\\"WEAKNESS\\\"}";
            }
            case 4 -> {
                name = "write_workspace_file";
                args = "{\\\"path\\\":\\\"solve.py\\\",\\\"content\\\":\\\"def two_sum(nums, target):\\\\n"
                        + "    seen = {}\\\\n    return []\\\\n\\\"}";
            }
            default -> {
                return "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"看完了\"}}]}";
            }
        }
        return "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{"
                + "\"id\":\"call_" + round + "\",\"type\":\"function\",\"function\":{"
                + "\"name\":\"" + name + "\",\"arguments\":\"" + args + "\"}}]}}]}";
    }

    @AfterAll
    static void stopFakeModelServer() {
        if (fakeModelServer != null) {
            fakeModelServer.stop(0);
        }
    }

    @BeforeEach
    void seed() {
        codeAgentRound.set(0);
        String username = "code_loop_" + UUID.randomUUID().toString().replace("-", "");
        // 工作区只对管理员开放 —— 普通用户跑这条环路会（正确地）什么都拿不到
        jdbcTemplate.update(
                "INSERT INTO sys_user(username, password, nickname, role, deleted) VALUES (?, ?, ?, 'ADMIN', 0)",
                username, "test-password", "Code Loop Test");
        userId = jdbcTemplate.queryForObject("SELECT id FROM sys_user WHERE username = ?", Long.class, username);
        assertNotNull(userId);
        String apiUrl = "http://127.0.0.1:" + fakeModelServer.getAddress().getPort() + "/v1/chat/completions";
        modelId = ((Number) aiService.saveModel(userId, null, Map.of(
                "providerType", "OPENAI_COMPATIBLE",
                "displayName", "fake-endpoint",
                "apiUrl", apiUrl,
                "apiKey", "sk-test",
                "modelName", "fake-model")).get("id")).longValue();
    }

    @Test
    void 刷题环路要能从头走到尾() throws Exception {
        // 「我的解法」命中 practiceIntent（strong 档），把 code agent 拉起来
        aiService.streamChat(userId, "判一下我的解法对不对", modelId, false, "OFF",
                null, "CHAT_ONLY", Map.of());
        awaitRunFinished();

        // 一、模型确实走完了四轮工具调用
        assertTrue(codeAgentRound.get() >= 4,
                "code agent 只调了 " + codeAgentRound.get() + " 轮 —— 环路没走完。"
                        + "轮次不够通常意味着某一步的工具没有下发给模型");

        // 二、薄弱点草稿存在。这一条<b>间接证明了命令真的跑过</b>：
        //     create_wiki_patch 只在 ranCommand 置位之后才下发，拿不到工具就调不出来。
        Integer patchSets = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM knowledge_patch_set WHERE user_id = ? AND title LIKE '薄弱点%'",
                Integer.class, userId);
        assertEquals(1, patchSets,
                "应当留下一条「薄弱点」待合入草稿。没有的话，要么写工具没下发"
                        + "（说明判题那一步没跑成，ranCommand 没置位），要么 Wiki 那条路没接通");

        // 三、代码改动草稿存在，且<b>磁盘没有被改动</b> —— 草稿优先这条纪律
        Integer codeDrafts = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM ai_agent_artifact a JOIN ai_agent_run r ON r.id = a.run_id "
                        + "WHERE r.user_id = ? AND a.artifact_type = 'CODE_DRAFT'",
                Integer.class, userId);
        assertEquals(1, codeDrafts, "应当留下一份 CODE_DRAFT 工件");

        assertEquals("def two_sum(nums, target):\n    return []\n",
                Files.readString(workspaceRoot.resolve("solve.py"), StandardCharsets.UTF_8),
                "确认之前磁盘必须一个字节都没动 —— 这是草稿优先的全部意义");
    }

    /** 普通用户走同一条路：什么都拿不到。工作区读的是服务器磁盘，不是他的东西。 */
    @Test
    void 普通用户走同一条路什么都拿不到() throws Exception {
        jdbcTemplate.update("UPDATE sys_user SET role = 'USER' WHERE id = ?", userId);

        aiService.streamChat(userId, "判一下我的解法对不对", modelId, false, "OFF",
                null, "CHAT_ONLY", Map.of());
        awaitRunFinished();

        assertEquals(0, codeAgentRound.get(),
                "非管理员不该触发任何工作区工具调用 —— 触发了就说明 /api/workspace/** 上的"
                        + "管理员限制可以被「对助手说一句话」绕过");
        Integer drafts = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM ai_agent_artifact a JOIN ai_agent_run r ON r.id = a.run_id "
                        + "WHERE r.user_id = ? AND a.artifact_type = 'CODE_DRAFT'",
                Integer.class, userId);
        assertEquals(0, drafts);
    }

    private void awaitRunFinished() throws InterruptedException {
        long deadline = System.currentTimeMillis() + 60_000;
        while (System.currentTimeMillis() < deadline) {
            Integer running = jdbcTemplate.queryForObject(
                    "SELECT COUNT(*) FROM ai_agent_run WHERE user_id = ? AND status = 'RUNNING'",
                    Integer.class, userId);
            if (running != null && running == 0) {
                TimeUnit.MILLISECONDS.sleep(300);   // 让 COMMIT 相位的写入落完
                return;
            }
            TimeUnit.MILLISECONDS.sleep(200);
        }
        throw new AssertionError("流式 run 未在 60s 内结束");
    }
}
