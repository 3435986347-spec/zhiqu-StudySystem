package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.NodeRunner;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.ai.stream.ReasoningEffort;
import com.zhiqu.service.harness.HarnessModelGateway;
import com.zhiqu.service.workspace.SingleAccountRegistry;
import com.zhiqu.service.workspace.WorkspaceAccess;
import com.zhiqu.service.workspace.WorkspaceExecutor;
import com.zhiqu.service.workspace.WorkspaceProperties;
import com.zhiqu.service.workspace.WorkspaceService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 网页代码模式的中途补充（第一百五十二轮，docs/steer-plan.md 第 3 步）：真起 node 跑命令行那一份宿主，模型是假的。
 * 「用户在模型想的时候补了一句」= 假模型被叫到时，另起一个线程（像 HTTP 线程那样）调 {@link SteerPort#say}。
 */
class JsCodeAgentSteerTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path CLI_DIR = Path.of("../zhiqu-cli").toAbsolutePath().normalize();

    @TempDir Path root;
    private final WorkspaceService workspace = mock(WorkspaceService.class);
    private final WorkspaceExecutor executor = mock(WorkspaceExecutor.class);
    private final HarnessModelGateway gateway = mock(HarnessModelGateway.class);
    private final List<Map<String, Object>> bodies = new ArrayList<>();
    private final List<Map<String, Object>> notes = new ArrayList<>();
    /** 补了、可在模型这次调用回来之前还没有结果的那几句 */
    private final List<String> late = new java.util.concurrent.CopyOnWriteArrayList<>();
    private final AiModelConfig config = new AiModelConfig();
    private String node;

    @BeforeEach
    void setUp() {
        node = NodeRunner.findNode();
        assumeTrue(node != null || !Boolean.getBoolean("zhiqu.skipNodeTests"), "显式跳过了 node 判据");
        assertNotNull(node, "找不到 node：这几条判据没有跑 —— 这不是通过（-Dzhiqu.nodePath 指过来，或 -Dzhiqu.skipNodeTests=true 写明跳过）");
        WorkspaceAccess access = mock(WorkspaceAccess.class);
        when(access.root()).thenReturn(root);
        when(workspace.access()).thenReturn(access);
        config.setId(42L);
        config.setModelName("deepseek-v4-pro");
        config.setContextWindowTokens(1_000_000);
    }

    /** during[n]：第 n 次模型调用进行中，另一个线程补的那句；结果（宿主收没收）放进 accepted */
    @SuppressWarnings("unchecked")
    private JsCodeAgent agent(List<Map<String, Object>> replies, Map<Integer, String> during, SteerPort port, List<Boolean> accepted) {
        int[] n = {0};
        doAnswer(inv -> {
            bodies.add(new LinkedHashMap<>((Map<String, Object>) inv.getArgument(1)));
            int k = n[0]++;
            if (during.containsKey(k)) {
                // 真实的样子：模型这次调用要很久（几十秒），用户在这期间补的话要当场知道收没收下 ——
                // 所以这次调用在补充有结果之前不回。原来读宿主输出的就是调模型的这个线程：回音没人读，5 秒后当「没收下」，
                // 页面排进队列、这一轮结束又发一遍（真浏览器里撞到的重复）。原来这里睡 300 毫秒就回，回音恰好在那之后被读到，照不出来
                Thread http = new Thread(() -> accepted.add(port.say(during.get(k))));
                http.start();
                http.join(3000);
                if (http.isAlive()) {
                    late.add(during.get(k));   // 模型这次调用还没回，就该知道收没收下；到这里还没有结果 = 回音被卡住了
                }
            }
            HarnessModelGateway.Sink sink = inv.getArgument(2);
            sink.event("start", Map.of("contextWindow", 1_000_000));
            sink.event("done", replies.get(Math.min(k, replies.size() - 1)));
            return null;
        }).when(gateway).stream(eq(7L), any(), any(), eq(false));
        ObjectProvider<HarnessModelGateway> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(gateway);
        return new JsCodeAgent(provider, new SingleAccountRegistry(workspace, executor), new WorkspaceProperties(), JSON, node, CLI_DIR.toString());
    }

    private static Map<String, Object> read(String path) {
        return Map.of("message", Map.of("role", "assistant", "content", "", "tool_calls",
                        List.of(Map.of("id", "c1", "type", "function", "function", Map.of("name", "read_file", "arguments", "{\"path\":\"" + path + "\"}")))),
                "finishReason", "tool_calls", "maxTokens", 16384, "usage", Map.of("promptTokens", 100, "completionTokens", 5, "estimated", false));
    }

    private static Map<String, Object> text(String content) {
        return Map.of("message", Map.of("role", "assistant", "content", content), "finishReason", "stop", "maxTokens", 16384,
                "usage", Map.of("promptTokens", 100, "completionTokens", 5, "estimated", false));
    }

    @SuppressWarnings("unchecked")
    private static String lastContent(Map<String, Object> body) {
        List<Map<String, Object>> messages = (List<Map<String, Object>>) body.get("messages");
        return String.valueOf(messages.get(messages.size() - 1).get("content"));
    }

    private CodeWorkspaceAgent.Result run(JsCodeAgent js, CodeLoopBudget budget, SteerPort port) {
        return js.run(config, 7L, "看看 a.txt", List.of(), false, false, budget, ContextBudget.DEFAULT, notes::add, null,
                ReasoningEffort.OFF, null, null, port);
    }

    @Test
    @DisplayName("模型想的时候补了一句：宿主收下（say 回 true）、下一次问模型就带着它；读到时交来 steered（原话）和一步「你补充」")
    void 跑着的时候补() throws Exception {
        Files.writeString(root.resolve("a.txt"), "hello");
        SteerPort port = new SteerPort(List.of());
        List<Boolean> accepted = new java.util.concurrent.CopyOnWriteArrayList<>();
        JsCodeAgent js = agent(List.of(read("a.txt"), text("只看了第一行")), Map.of(0, "只看第一行"), port, accepted);
        CodeWorkspaceAgent.Result r = run(js, CodeLoopBudget.forRequest(true), port);
        assertEquals(List.of(true), accepted);
        assertEquals(List.of(), late, "宿主收下的回音在模型调用期间没人读：页面会当成没收下、这一轮结束再发一遍（重复）");
        assertEquals(2, bodies.size());
        assertTrue(lastContent(bodies.get(1)).contains("只看第一行"), lastContent(bodies.get(1)));
        assertTrue(notes.stream().anyMatch(n -> "steered".equals(n.get("phase")) && List.of("只看第一行").equals(n.get("texts"))), notes.toString());
        assertTrue(notes.stream().anyMatch(n -> n.get("trace") instanceof Map<?, ?> t && "steer".equals(t.get("kind")) && "只看第一行".equals(t.get("target"))),
                "回答里要有一步「你补充」（TraceSteps 认 steer，不当成 other）");
        assertEquals("只看了第一行", r.conclusion());
        assertEquals(List.of(), port.unconsumed());
        assertFalse(port.say("收尾之后"), "宿主收尾之后不收");
    }

    @Test
    @DisplayName("宿主起来之前就补了的：随 run 交过去，第一次问模型就在")
    void 起来之前补的() throws Exception {
        SteerPort port = new SteerPort(List.of("用 Python 写"));
        JsCodeAgent js = agent(List.of(text("好")), Map.of(), port, new ArrayList<>());
        run(js, CodeLoopBudget.forRequest(true), port);
        assertTrue(lastContent(bodies.get(0)).contains("用 Python 写"), lastContent(bodies.get(0)));
    }

    @Test
    @DisplayName("最后一步才补、没赶上：宿主交回的 leftover 回到口子里（调用方交给最终回答 / 页面），不丢")
    void 没赶上() throws Exception {
        SteerPort port = new SteerPort(List.of());
        List<Boolean> accepted = new java.util.concurrent.CopyOnWriteArrayList<>();
        JsCodeAgent js = agent(List.of(text("收尾了")), Map.of(0, "再加个测试"), port, accepted);
        run(js, new CodeLoopBudget(1, 0L, 16384, 150_000), port);
        assertEquals(List.of(true), accepted);
        assertEquals(1, bodies.size());
        assertEquals(List.of("再加个测试"), port.unconsumed());
    }
}
