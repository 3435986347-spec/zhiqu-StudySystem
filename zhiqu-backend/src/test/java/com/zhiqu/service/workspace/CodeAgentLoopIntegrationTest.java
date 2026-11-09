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
import java.util.List;
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
 * 只在真的跑过一次命令之后才会下发给模型。拿不到工具就调不出来，
 * 调不出来就不会有草稿。这比直接断言「exec 被调用过」更硬：它验的是那道门本身。
 *
 * <p>第九十七轮起循环是命令行那一份（后端真起 node 跑 zhiqu-cli/src/host/code-host.js，模型经网关、命令经执行器、
 * Wiki 经桥回到后端）：假模型照网关发的流式请求回工具调用的增量，整条路照样从头走到尾。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "app.cookie.secure=false",
        "app.rag.enabled=false",
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
        String node = com.zhiqu.NodeRunner.findNode();
        org.junit.jupiter.api.Assumptions.assumeTrue(node != null || !Boolean.getBoolean("zhiqu.skipNodeTests"), "显式跳过了 node 判据");
        assertNotNull(node, "找不到 node：代码模式的端到端判据没有跑 —— 这不是通过（-Dzhiqu.nodePath 指过来，或 -Dzhiqu.skipNodeTests=true 写明跳过）");
        registry.add("app.ai.code-agent.node", () -> node);
    }

    private static HttpServer fakeModelServer;
    /** code agent 那一轮调用的计数 —— 脚本按它决定这一轮请求哪个工具。 */
    private static final AtomicInteger codeAgentRound = new AtomicInteger();
    private static final java.util.concurrent.atomic.AtomicBoolean shellOffered = new java.util.concurrent.atomic.AtomicBoolean();

    /** 命令行那份循环发的请求里才有这个工具 —— 用来把它的调用和主流程别的调用区分开 */
    private static final String CODE_AGENT_MARK = "\"name\":\"read_file\"";
    private static final com.fasterxml.jackson.databind.ObjectMapper JSON = new com.fasterxml.jackson.databind.ObjectMapper();

    /** 写最终回答的那次模型调用（流式、不带代码工具）有几次：第一百二十一轮起代码 agent 交了结论就一次都没有 */
    private static final AtomicInteger answerCalls = new AtomicInteger();
    /** 最后一次写最终回答的请求：代码 agent 没交结论（用完轮数）时兜底的那一步，看它知不知道这一轮生成了什么 */
    private static final java.util.concurrent.atomic.AtomicReference<String> lastAnswerBody = new java.util.concurrent.atomic.AtomicReference<>("");
    /** 「写一个文件」：线上那一次的样子 —— 代码 agent 看了一眼空的工作区、反问，一个文件都不写 */
    private static final String ASK_BACK = "写一个文件";
    private static final String QUESTION = "工作区现在是空的，还没有建立任何文件。你想写哪个文件，我还缺少关键信息：文件名、格式，以及内容主题。";

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
            String sse = null;
            String json = null;
            if (streaming && requestBody.contains(CODE_AGENT_MARK)) {
                boolean shell = requestBody.contains("\"name\":\"shell\"");
                shellOffered.set(shell);
                int round = codeAgentRound.incrementAndGet();
                sse = requestBody.contains(ASK_BACK) ? askBackScript(round) : codeAgentScript(round, shell);
            } else if (streaming && requestBody.contains("\"tools\"")) {
                // 别的带工具的那几步（Wiki 工具循环）：不是写最终回答的，直接收尾
                sse = sseLine(Map.of("choices", java.util.List.of(Map.of("delta", Map.of("content", "好"), "finish_reason", "stop")))) + "data: [DONE]\n\n";
            } else if (streaming) {
                answerCalls.incrementAndGet();
                lastAnswerBody.set(requestBody);
                // 写最终回答的那一步要是还被调用，就照线上那一次编：说写了、连内容都给
                sse = "data: {\"choices\":[{\"delta\":{\"content\":\"## 已写入文件\\n\\n文件路径：`./四象限周计划.md`\"}}]}\n\ndata: [DONE]\n\n";
            } else {
                json = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"测试回复\"}}]}";
            }
            byte[] body = (sse != null ? sse : json).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", sse != null ? "text/event-stream" : "application/json");
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
    private static String codeAgentScript(int round, boolean shell) {
        String name;
        Map<String, Object> args;
        switch (round) {
            case 1 -> { name = "read_file"; args = Map.of("path", "solve.py"); }
            // 有系统沙箱给的是 shell（第一百零九轮），没有才是白名单的 run_command：看请求里实际下发了什么
            case 2 -> {
                name = shell ? "shell" : "run_command";
                args = shell ? Map.of("command", "python3 test_solve.py") : Map.of("command", "python3", "args", java.util.List.of("test_solve.py"));
            }
            // 这一轮能不能调到，取决于上一轮真的跑过命令（宿主每一轮重建工具表，跑过才给）
            case 3 -> { name = "create_wiki_patch"; args = Map.of("title", "薄弱点：两数之和", "content", "返回空列表，没有实现查找", "pageType", "WEAKNESS"); }
            case 4 -> { name = "write_file"; args = Map.of("path", "solve.py", "content", "def two_sum(nums, target):\n    seen = {}\n    return []\n"); }
            default -> {
                return sseLine(Map.of("choices", java.util.List.of(Map.of("delta", Map.of("content", "看完了"), "finish_reason", "stop")),
                        "usage", Map.of("prompt_tokens", 10, "completion_tokens", 2))) + "data: [DONE]\n\n";
            }
        }
        try {
            Map<String, Object> call = Map.of("index", 0, "id", "call_" + round, "type", "function",
                    "function", Map.of("name", name, "arguments", JSON.writeValueAsString(args)));
            return sseLine(Map.of("choices", java.util.List.of(Map.of("delta", Map.of("tool_calls", java.util.List.of(call))))))
                    + sseLine(Map.of("choices", java.util.List.of(Map.of("delta", Map.of(), "finish_reason", "tool_calls")),
                            "usage", Map.of("prompt_tokens", 10, "completion_tokens", 5)))
                    + "data: [DONE]\n\n";
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** 第一轮看一眼工作区，第二轮反问，一个文件都不写 */
    private static String askBackScript(int round) {
        if (round == 1) {
            Map<String, Object> call = Map.of("index", 0, "id", "call_ask_1", "type", "function",
                    "function", Map.of("name", "list_files", "arguments", "{}"));
            return sseLine(Map.of("choices", java.util.List.of(Map.of("delta", Map.of("tool_calls", java.util.List.of(call))))))
                    + sseLine(Map.of("choices", java.util.List.of(Map.of("delta", Map.of(), "finish_reason", "tool_calls")),
                            "usage", Map.of("prompt_tokens", 10, "completion_tokens", 5)))
                    + "data: [DONE]\n\n";
        }
        return sseLine(Map.of("choices", java.util.List.of(Map.of("delta", Map.of("content", QUESTION), "finish_reason", "stop")),
                "usage", Map.of("prompt_tokens", 10, "completion_tokens", 20))) + "data: [DONE]\n\n";
    }

    private String lastAnswer() {
        return jdbcTemplate.queryForObject("SELECT content FROM ai_message WHERE user_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
                String.class, userId);
    }

    private static String sseLine(Map<String, Object> chunk) {
        try {
            return "data: " + JSON.writeValueAsString(chunk) + "\n\n";
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
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
        answerCalls.set(0);
        String username = "code_loop_" + UUID.randomUUID().toString().replace("-", "");
        // 第一百一十五轮起普通账号就能走这条环路（用户要的）：这个文件里的每一条都是普通账号跑的
        jdbcTemplate.update(
                "INSERT INTO sys_user(username, password, nickname, role, deleted) VALUES (?, ?, ?, 'USER', 0)",
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

        // macOS 一定有系统沙箱：整个应用接起来之后模型要真的拿到 shell（别的平台看有没有装 bubblewrap）
        if (System.getProperty("os.name", "").toLowerCase().contains("mac") && !Boolean.getBoolean("zhiqu.skipSandboxTests")) {
            assertTrue(shellOffered.get(), "macOS 上模型没拿到 shell：沙箱没接上");
        }

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

        // 四、回答里按顺序列出的每一步（第一百二十七轮）：存进了库、列表接口读得回来，顺序就是做的顺序，带结果
        stepsArePersisted();
    }

    @SuppressWarnings("unchecked")
    private void stepsArePersisted() throws Exception {
        String raw = jdbcTemplate.queryForObject(
                "SELECT steps_json FROM ai_message WHERE user_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", String.class, userId);
        assertNotNull(raw, "这一轮的步骤没存进 ai_message.steps_json");
        List<Map<String, Object>> steps = (List<Map<String, Object>>) JSON.readValue(raw, Map.class).get("steps");
        List<String> kinds = steps.stream().map(st -> String.valueOf(st.get("kind"))).toList();
        // 代码 agent 那四步按顺序：读 → 运行 → 知识库草稿 → 改（write_file 覆盖已有文件 = 修改）
        List<String> code = kinds.stream().filter(k -> List.of("read", "run", "wiki", "edit", "create").contains(k)).toList();
        assertEquals(List.of("read", "run", "wiki", "edit"), code.subList(0, 4), "顺序不对：" + kinds);
        assertTrue(steps.stream().noneMatch(st -> "running".equals(st.get("status"))), "收尾了还有 running 的：" + steps);
        Map<String, Object> run = steps.stream().filter(st -> "run".equals(st.get("kind"))).findFirst().orElseThrow();
        Map<String, Object> detail = (Map<String, Object>) run.get("detail");
        assertNotNull(detail, "运行那一步没有输出：" + run);
        assertTrue(String.valueOf(detail.get("output")).contains("期望 [0, 1]"), "判题的输出没进步骤：" + detail);
        assertEquals("error", run.get("status"), "判题没过（退出码不是 0）要标成失败");
        Map<String, Object> edit = steps.stream().filter(st -> "edit".equals(st.get("kind"))).findFirst().orElseThrow();
        List<Map<String, Object>> files = (List<Map<String, Object>>) ((Map<String, Object>) edit.get("detail")).get("files");
        assertEquals("solve.py", files.get(0).get("path"));
        assertTrue(((List<String>) files.get(0).get("hunks")).contains("+    seen = {}"), "改动的 diff 没进步骤：" + files);
        assertTrue(String.valueOf(edit.get("summary")).contains("草稿"), "草稿模式要说是草稿：" + edit.get("summary"));

        // 列表接口（页面刷新后拿的就是它）读得回来
        // 这里的对话没挂 Notebook（streamChat 的 notebookId 是 null）
        List<Map<String, Object>> rows = aiService.getRecentChatMessages(userId, null, 20, null);
        Map<String, Object> last = rows.get(rows.size() - 1);
        assertEquals("assistant", last.get("role"));
        assertNotNull(last.get("steps"), "列表接口没带步骤：页面一刷新就没了 " + rows.stream().map(r -> r.get("id") + ":" + r.get("role") + ":" + (r.get("steps") != null)).toList()
                + " 库里：" + jdbcTemplate.queryForList("SELECT id, role, steps_json IS NOT NULL s, conversation_id FROM ai_message WHERE user_id = ? ORDER BY id", userId));
        List<Map<String, Object>> listed = (List<Map<String, Object>>) ((Map<String, Object>) last.get("steps")).get("steps");
        assertEquals(steps.size(), listed.size());
        // 列表里一行一步、不带细节（review：一页 50 条回答的输出和 diff 原来每次都整份下来）；点开时拿整份
        Map<String, Object> listedRun = listed.stream().filter(st -> "run".equals(st.get("kind"))).findFirst().orElseThrow();
        assertTrue(!listedRun.containsKey("detail") && Boolean.TRUE.equals(listedRun.get("hasDetail")), "列表里的那一步带了细节 / 没标 hasDetail：" + listedRun);
        Map<String, Object> full = aiService.getMessageSteps(userId, ((Number) last.get("id")).longValue());
        assertTrue(String.valueOf(full).contains("期望 [0, 1]"), "点开时拿不到细节：" + full);
        // 别人拿不到
        org.junit.jupiter.api.Assertions.assertThrows(Exception.class, () -> aiService.getMessageSteps(userId + 99_999, ((Number) last.get("id")).longValue()));
    }

    /** 第一百零四轮：状态文件一存在就盖过这里配的 EXEC 和临时目录。原来读的是用户的 ~/.zhiqu/workspace-state.json，跟着他在桌面应用里选的档位变红，选 EXEC 时判题命令跑进他真实的项目 */
    @Test
    void 测试不读用户的工作区状态文件(@Autowired org.springframework.core.env.Environment env) {
        String stateFile = env.getProperty("app.workspace.state-file");
        assertNotNull(stateFile, "src/test/resources/application.properties 要把 app.workspace.state-file 指到临时目录");
        assertTrue(!stateFile.startsWith(System.getProperty("user.home")), "测试用的状态文件在用户目录下：" + stateFile);
    }

    /** 档位分账号：确认草稿写进这个账号自己选的文件夹，配置给的那个默认目录一个字都不动。 */
    @Test
    void 确认写进这个账号自己选的文件夹(@Autowired WorkspaceRegistry workspaces, @Autowired com.zhiqu.service.AiWorkspaceService ai) throws Exception {
        Path own = Files.createTempDirectory("code-loop-own-").toRealPath();
        for (String name : List.of("solve.py", "test_solve.py")) {
            Files.copy(workspaceRoot.resolve(name), own.resolve(name));
        }
        String before = Files.readString(workspaceRoot.resolve("solve.py"), StandardCharsets.UTF_8);
        workspaces.service(userId).applySettings("EXEC", own.toString());

        aiService.streamChat(userId, "判一下我的解法对不对", modelId, false, "OFF", null, "CHAT_ONLY", Map.of());
        awaitRunFinished();

        Long artifact = jdbcTemplate.queryForObject(
                "SELECT a.id FROM ai_agent_artifact a JOIN ai_agent_run r ON r.id = a.run_id "
                        + "WHERE r.user_id = ? AND a.artifact_type = 'CODE_DRAFT' ORDER BY a.id DESC LIMIT 1",
                Long.class, userId);
        ai.confirmArtifact(userId, artifact, null);
        assertTrue(Files.readString(own.resolve("solve.py"), StandardCharsets.UTF_8).contains("seen"), "写进自己选的文件夹");
        assertEquals(before, Files.readString(workspaceRoot.resolve("solve.py"), StandardCharsets.UTF_8), "别处一个字都不动");
    }

    /** 生成到产物（第一百一十六轮）：不选文件夹，写的文件进数据库；只有本人能取；清掉临时空间接着聊能恢复；不是草稿 */
    @Test
    void 不选文件夹生成到产物(@Autowired WorkspaceRegistry workspaces, @Autowired com.zhiqu.service.AiWorkspaceService ai,
                     @Autowired com.zhiqu.controller.AiController controller) throws Exception {
        String configRoot = Files.readString(workspaceRoot.resolve("solve.py"), StandardCharsets.UTF_8);
        workspaces.service(userId).applySettings("EXEC", "");
        assertTrue(workspaces.service(userId).access().artifactMode());

        aiService.streamChat(userId, "判一下我的解法对不对", modelId, false, "OFF", null, "CHAT_ONLY", Map.of());
        awaitRunFinished();

        assertEquals(configRoot, Files.readString(workspaceRoot.resolve("solve.py"), StandardCharsets.UTF_8), "配置的目录一个字都不动");
        Integer drafts = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM ai_agent_artifact a JOIN ai_agent_run r ON r.id = a.run_id "
                + "WHERE r.user_id = ? AND a.artifact_type = 'CODE_DRAFT'", Integer.class, userId);
        assertEquals(0, drafts, "不走草稿");
        Map<String, Object> artifact = jdbcTemplate.queryForMap("SELECT a.id, a.status, a.content_json FROM ai_agent_artifact a JOIN ai_agent_run r ON r.id = a.run_id "
                + "WHERE r.user_id = ? AND a.artifact_type = 'GENERATED_FILES'", userId);
        assertEquals("READY", artifact.get("status"));
        Long artifactId = ((Number) artifact.get("id")).longValue();
        assertTrue(String.valueOf(artifact.get("content_json")).contains("solve.py"), String.valueOf(artifact.get("content_json")));
        assertEquals(0, jdbcTemplate.queryForObject("SELECT COUNT(*) FROM ai_agent_artifact a JOIN ai_agent_run r ON r.id = a.run_id WHERE r.user_id = ? AND a.artifact_type = 'GENERATED_FILES' AND a.title NOT LIKE '生成了 % 个文件'", Integer.class, userId), "标题说几个文件");
        Map<String, Object> file = jdbcTemplate.queryForMap("SELECT id, conversation_id, size_bytes FROM ai_artifact_file WHERE artifact_id = ? AND path = 'solve.py'", artifactId);
        Long fileId = ((Number) file.get("id")).longValue();
        Long conversationId = ((Number) file.get("conversation_id")).longValue();

        assertTrue(new String(ai.artifactFile(userId, artifactId, fileId).getContent(), StandardCharsets.UTF_8).contains("seen"), "存的是模型写的内容");
        org.junit.jupiter.api.Assertions.assertThrows(com.zhiqu.common.BusinessException.class, () -> ai.artifactFile(userId + 1, artifactId, fileId), "别的账号取不到");
        org.junit.jupiter.api.Assertions.assertThrows(com.zhiqu.common.BusinessException.class, () -> ai.artifactFile(userId, artifactId + 1, fileId), "文件和产物要对得上");
        Path space = workspaces.space(userId, conversationId);
        assertTrue(Files.isRegularFile(space.resolve("solve.py")), "写在这段对话的临时空间里");

        // 这一轮代码 agent 用完了轮数（4 轮工具），没有自己的结论：兜底由写最终回答的那一步说，它要知道生成了什么
        // （代码 agent 交了结论的情形见「代码agent反问时回答就是它的反问」：那时这一步根本不调用）
        assertTrue(answerCalls.get() >= 1, "没有结论时要兜底");
        assertTrue(lastAnswerBody.get().contains("本轮生成了这些文件") && lastAnswerBody.get().contains("solve.py"), "最终回答要知道生成了什么");

        // 再跑一轮，内容没变：不重复存；临时空间被清掉了：先恢复，模型看得到之前的文件
        Files.writeString(space(workspaces, conversationId).resolve("keep-me.txt"), "");
        ArtifactSpaces.deleteTree(space(workspaces, conversationId));
        jdbcTemplate.update("INSERT INTO ai_artifact_file(artifact_id, user_id, conversation_id, path, size_bytes, sha256, content) VALUES (?, ?, ?, 'keep-me.txt', 1, 'x', 'n')", artifactId, userId, conversationId);
        codeAgentRound.set(0);
        int runsBefore = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM ai_agent_run WHERE user_id = ?", Integer.class, userId);
        aiService.streamChat(userId, "判一下我的解法对不对", modelId, false, "OFF", null, "CHAT_ONLY", Map.of());
        awaitAnotherRunFinished(runsBefore);
        assertTrue(Files.isRegularFile(space(workspaces, conversationId).resolve("keep-me.txt")), "这一轮开始之前要恢复");
        assertEquals(1, jdbcTemplate.queryForObject("SELECT COUNT(*) FROM ai_agent_artifact a JOIN ai_agent_run r ON r.id = a.run_id WHERE r.user_id = ? AND a.artifact_type = 'GENERATED_FILES'", Integer.class, userId),
                "内容没变、恢复回来的也不算新生成，不该再存一份");
        jdbcTemplate.update("DELETE FROM ai_artifact_file WHERE user_id = ? AND sha256 = 'x'", userId);

        // 面板：换一轮、刷新之后还点得到；每个路径只列最新的；别的账号、别的对话看不到
        var listed = ai.generatedFiles(userId, null);
        assertTrue(listed.stream().anyMatch(r -> "solve.py".equals(r.get("path")) && artifactId.equals(r.get("artifactId")) && fileId.equals(r.get("id"))), String.valueOf(listed));
        assertTrue(listed.stream().noneMatch(r -> r.containsKey("content")), "列表不带内容");
        assertTrue(ai.generatedFiles(userId + 1, null).isEmpty(), "别的账号看不到");
        jdbcTemplate.update("INSERT INTO ai_artifact_file(artifact_id, user_id, conversation_id, path, size_bytes, sha256, content) VALUES (?, ?, ?, 'solve.py', 1, 'x', 'n')", artifactId, userId, conversationId);
        jdbcTemplate.update("INSERT INTO ai_artifact_file(artifact_id, user_id, conversation_id, path, size_bytes, sha256, content) VALUES (?, ?, ?, 'other-conversation.txt', 1, 'x', 'n')", artifactId, userId, conversationId + 1_000_000);
        var again = ai.generatedFiles(userId, null);
        assertEquals(1, again.stream().filter(r -> "solve.py".equals(r.get("path"))).count(), "同一个路径只列最新的");
        assertTrue(again.stream().noneMatch(r -> fileId.equals(r.get("id"))), "旧版本不列");
        assertTrue(again.stream().noneMatch(r -> "other-conversation.txt".equals(r.get("path"))), "别的对话的不列");
        jdbcTemplate.update("DELETE FROM ai_artifact_file WHERE user_id = ? AND sha256 = 'x'", userId);

        // 清掉临时空间：接着聊之前恢复；还在的时候不覆盖
        ArtifactSpaces.deleteTree(space);
        ai.prepareArtifactSpace(userId, conversationId);
        assertTrue(Files.readString(space.resolve("solve.py"), StandardCharsets.UTF_8).contains("seen"), "从数据库恢复");
        Files.writeString(space.resolve("solve.py"), "命令后来改过的");
        ai.prepareArtifactSpace(userId, conversationId);
        assertEquals("命令后来改过的", Files.readString(space.resolve("solve.py"), StandardCharsets.UTF_8), "还在的不覆盖");

        // 恢复时路径不能跳出去：数据库里的路径也不信
        ArtifactSpaces.deleteTree(space);
        Path escaped = space.getParent().resolve("escaped-by-restore.txt");
        jdbcTemplate.update("INSERT INTO ai_artifact_file(artifact_id, user_id, conversation_id, path, size_bytes, sha256, content) VALUES (?, ?, ?, '../escaped-by-restore.txt', 1, 'x', 'n')", artifactId, userId, conversationId);
        ai.prepareArtifactSpace(userId, conversationId);
        assertTrue(Files.isRegularFile(space.resolve("solve.py")), "正常的照样恢复");
        assertTrue(!Files.exists(escaped), "../ 不能写到临时空间外面");
        jdbcTemplate.update("DELETE FROM ai_artifact_file WHERE user_id = ? AND sha256 = 'x'", userId);

        // 下载：一律当下载，不在本站打开；带上名字；只有本人
        org.springframework.security.core.context.SecurityContextHolder.getContext().setAuthentication(
                new org.springframework.security.authentication.UsernamePasswordAuthenticationToken(userId, null, List.of()));
        try {
            var res = controller.artifactFile(artifactId, fileId);
            assertEquals("application/octet-stream", String.valueOf(res.getHeaders().getContentType()));
            assertEquals("attachment; filename*=UTF-8''solve.py", res.getHeaders().getFirst("Content-Disposition"));
            assertEquals("nosniff", res.getHeaders().getFirst("X-Content-Type-Options"));
            assertEquals("sandbox", res.getHeaders().getFirst("Content-Security-Policy"));
            assertEquals("private, no-store", res.getHeaders().getFirst("Cache-Control"));
            assertTrue(new String(res.getBody(), StandardCharsets.UTF_8).contains("seen"));
            assertEquals(1, ((List<?>) controller.generatedFiles(null).getData()).stream().filter(r -> "solve.py".equals(((Map<?, ?>) r).get("path"))).count());
        } finally {
            org.springframework.security.core.context.SecurityContextHolder.clearContext();
        }

        // 删 Notebook：那段对话的文件和临时空间一起删，别的对话不动
        Long notebookId = ((Number) ai.createNotebook(userId, Map.of("title", "要删的")).get("id")).longValue();
        jdbcTemplate.update("INSERT INTO ai_conversation(user_id, conversation_key, deleted) VALUES (?, ?, 0)", userId, com.zhiqu.entity.AiConversation.notebookKey(notebookId));
        Long notebookConversation = jdbcTemplate.queryForObject("SELECT id FROM ai_conversation WHERE user_id = ? AND conversation_key = ?", Long.class, userId, com.zhiqu.entity.AiConversation.notebookKey(notebookId));
        jdbcTemplate.update("INSERT INTO ai_artifact_file(artifact_id, user_id, conversation_id, path, size_bytes, sha256, content) VALUES (?, ?, ?, 'in-notebook.txt', 1, 'x', 'n')", artifactId, userId, notebookConversation);
        Files.createDirectories(workspaces.space(userId, notebookConversation));
        ai.deleteNotebook(userId, notebookId);
        assertEquals(0, jdbcTemplate.queryForObject("SELECT COUNT(*) FROM ai_artifact_file WHERE conversation_id = ?", Integer.class, notebookConversation), "文件要一起删");
        assertTrue(!Files.exists(workspaces.space(userId, notebookConversation)), "临时空间要一起删");
        assertTrue(ai.generatedFiles(userId, null).stream().anyMatch(r -> "solve.py".equals(r.get("path"))), "别的对话不动");

        // 账号的总量：只放得下一个字节时，第一个存、第二个不存但要说
        long used = jdbcTemplate.queryForObject("SELECT COALESCE(SUM(size_bytes), 0) FROM ai_artifact_file WHERE user_id = ?", Long.class, userId);
        jdbcTemplate.update("INSERT INTO ai_artifact_file(artifact_id, user_id, path, size_bytes, sha256, content) VALUES (?, ?, 'pad', ?, 'x', '')",
                artifactId, userId, ArtifactFiles.MAX_ACCOUNT_BYTES - used - 1);
        var over = ai.saveGeneratedFiles(((Number) jdbcTemplate.queryForMap("SELECT run_id FROM ai_agent_artifact WHERE id = ?", artifactId).get("run_id")).longValue(), null, userId, conversationId,
                List.of(new ArtifactFiles.Generated("more1.txt", 1, "x", new byte[] {1}, null), new ArtifactFiles.Generated("more2.txt", 1, "x", new byte[] {1}, null)), null);
        assertTrue(over.getContentJson().contains("空间用完了"), over.getContentJson());
        assertEquals(1, jdbcTemplate.queryForObject("SELECT COUNT(*) FROM ai_artifact_file WHERE path = 'more1.txt' AND user_id = ?", Integer.class, userId));
        assertEquals(0, jdbcTemplate.queryForObject("SELECT COUNT(*) FROM ai_artifact_file WHERE path = 'more2.txt' AND user_id = ?", Integer.class, userId), "放不下的不存");
    }

    /**
     * 第一百二十一轮（线上撞到的）：auto 档、生成到产物，用户说「写一个文件」。代码 agent 看了一眼空的工作区、反问要写什么，一个文件都没写；
     * 原来写最终回答的那一步另调一次模型，照上一轮列过的选项替他选了一个，说「## 已写入文件」，产物里什么都没有。
     * 这里那一步要是还被调用，假模型就照那一次编 —— 回答里出现「已写入」就是又分家了。
     */
    @Test
    void 代码agent反问时回答就是它的反问不编已写入(@Autowired WorkspaceRegistry workspaces) throws Exception {
        workspaces.service(userId).applySettings("EXEC", "");
        aiService.streamChat(userId, ASK_BACK, modelId, false, "OFF", null, "CHAT_ONLY", Map.of("codeMode", true));
        awaitRunFinished();

        assertTrue(codeAgentRound.get() >= 2, "代码 agent 没走完：" + codeAgentRound.get() + " 轮");
        String answer = lastAnswer();
        assertEquals(QUESTION, answer, "回答要是代码 agent 自己的反问");
        assertTrue(!answer.contains("已写入"), answer);
        assertEquals(0, answerCalls.get(), "不该再另调一次模型重写回答");
        assertEquals(0, jdbcTemplate.queryForObject("SELECT COUNT(*) FROM ai_artifact_file WHERE user_id = ?", Integer.class, userId), "本来就一个文件都没写");
    }

    /**
     * 同一轮里 Wiki 工具循环也跑了：它的回执要由写最终回答的那一步拼进去，所以这时照旧由那一步说 ——
     * 但它拿到的要有代码 agent 的反问，和「这一轮一个文件都没写，不许说写了」。
     */
    @Test
    void 同一轮也查了Wiki时由最终回答合并但不许说写了文件(@Autowired WorkspaceRegistry workspaces) throws Exception {
        workspaces.service(userId).applySettings("EXEC", "");
        aiService.streamChat(userId, ASK_BACK + "，顺便查一下知识库", modelId, false, "OFF", null, "CHAT_ONLY", Map.of("codeMode", true));
        awaitRunFinished();

        assertTrue(codeAgentRound.get() >= 2, "代码 agent 没走完：" + codeAgentRound.get() + " 轮");
        assertEquals(1, answerCalls.get(), "Wiki 也跑了：由写最终回答的那一步合并");
        String body = lastAnswerBody.get();
        assertTrue(body.contains("你想写哪个文件"), "那一步要看得到代码 agent 的反问");
        assertTrue(body.contains("这一轮一个文件都没有写"), "那一步要被告知一个文件都没写");
    }

    private Path space(WorkspaceRegistry workspaces, Long conversationId) {
        return workspaces.space(userId, conversationId);
    }

    private void awaitAnotherRunFinished(int before) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 60_000;
        while (System.currentTimeMillis() < deadline) {
            int started = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM ai_agent_run WHERE user_id = ?", Integer.class, userId);
            int running = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM ai_agent_run WHERE user_id = ? AND status = 'RUNNING'", Integer.class, userId);
            if (started > before && running == 0) {
                TimeUnit.MILLISECONDS.sleep(300);
                return;
            }
            TimeUnit.MILLISECONDS.sleep(200);
        }
        throw new AssertionError("第二轮未在 60s 内结束");
    }

    /** 档位分账号：这个账号自己把档位关了，走同一条路什么都拿不到；配置给的默认对别的账号还在。 */
    @Test
    void 账号自己关了档位走同一条路什么都拿不到(@Autowired WorkspaceRegistry workspaces) throws Exception {
        workspaces.service(userId).applySettings("OFF", "");
        assertTrue(workspaces.service(userId + 1_000_000).access().enabled(), "别的账号不受影响");

        aiService.streamChat(userId, "判一下我的解法对不对", modelId, false, "OFF",
                null, "CHAT_ONLY", Map.of());
        awaitRunFinished();

        assertEquals(0, codeAgentRound.get(), "档位是关的，不该触发任何工作区工具调用");
        Integer drafts = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM ai_agent_artifact a JOIN ai_agent_run r ON r.id = a.run_id "
                        + "WHERE r.user_id = ? AND a.artifact_type = 'CODE_DRAFT'",
                Integer.class, userId);
        assertEquals(0, drafts);
    }

    /**
     * 等这一轮真的跑完。streamChat 立刻返回，run 那一行是后台线程里建的 —— 原来只看「没有 RUNNING 的」，
     * 而 run 还没建出来的时候也是「没有」：这里立刻返回、断言对着一轮没跑的环路，接着测试类收尾把假模型和库都关了，
     * 后台那一轮撞上「连接被拒绝」。机器快的时候 run 抢在第一次查询之前建好，所以时好时坏；慢一点的机器上次次红。
     */
    private void awaitRunFinished() throws InterruptedException {
        long deadline = System.currentTimeMillis() + 60_000;
        while (System.currentTimeMillis() < deadline) {
            Integer started = jdbcTemplate.queryForObject(
                    "SELECT COUNT(*) FROM ai_agent_run WHERE user_id = ?", Integer.class, userId);
            Integer running = jdbcTemplate.queryForObject(
                    "SELECT COUNT(*) FROM ai_agent_run WHERE user_id = ? AND status = 'RUNNING'",
                    Integer.class, userId);
            if (started != null && started > 0 && running != null && running == 0) {
                TimeUnit.MILLISECONDS.sleep(300);   // 让 COMMIT 相位的写入落完
                return;
            }
            TimeUnit.MILLISECONDS.sleep(200);
        }
        throw new AssertionError("流式 run 未在 60s 内结束");
    }
}
