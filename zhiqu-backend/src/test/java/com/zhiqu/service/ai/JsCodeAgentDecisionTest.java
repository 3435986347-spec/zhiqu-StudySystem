package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.NodeRunner;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.ai.stream.ReasoningEffort;
import com.zhiqu.service.harness.HarnessModelGateway;
import com.zhiqu.service.support.ChatRunHub;
import com.zhiqu.service.workspace.SingleAccountRegistry;
import com.zhiqu.service.workspace.WorkspaceAccess;
import com.zhiqu.service.workspace.WorkspaceExecutor;
import com.zhiqu.service.workspace.WorkspaceProperties;
import com.zhiqu.service.workspace.WorkspaceService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class JsCodeAgentDecisionTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path CLI_DIR = Path.of("../zhiqu-cli").toAbsolutePath().normalize();

    @TempDir Path root;
    private final WorkspaceService workspace = mock(WorkspaceService.class);
    private final WorkspaceExecutor executor = mock(WorkspaceExecutor.class);
    private final HarnessModelGateway gateway = mock(HarnessModelGateway.class);
    private final List<Map<String, Object>> bodies = new CopyOnWriteArrayList<>();
    private final List<Map<String, Object>> notes = new CopyOnWriteArrayList<>();
    private final AiModelConfig config = new AiModelConfig();
    private String node;

    @BeforeEach
    void setUp() {
        node = NodeRunner.findNode();
        assumeTrue(node != null || !Boolean.getBoolean("zhiqu.skipNodeTests"), "显式跳过了 node 判据");
        assertNotNull(node, "找不到 node：这几条判据没有跑");
        WorkspaceAccess access = mock(WorkspaceAccess.class);
        when(access.root()).thenReturn(root);
        when(workspace.access()).thenReturn(access);
        config.setId(42L);
        config.setModelName("fake");
        config.setContextWindowTokens(1_000_000);
    }

    private JsCodeAgent agent(List<Map<String, Object>> replies) {
        int[] n = {0};
        doAnswer(inv -> {
            bodies.add(new LinkedHashMap<>((Map<String, Object>) inv.getArgument(1)));
            Map<String, Object> reply = replies.get(Math.min(n[0]++, replies.size() - 1));
            HarnessModelGateway.Sink sink = inv.getArgument(2);
            sink.event("start", Map.of("contextWindow", 1_000_000));
            sink.event("done", reply);
            return null;
        }).when(gateway).stream(eq(7L), any(), any(), eq(false));
        ObjectProvider<HarnessModelGateway> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(gateway);
        return new JsCodeAgent(provider, new SingleAccountRegistry(workspace, executor), new WorkspaceProperties(), JSON, node, CLI_DIR.toString());
    }

    private static Map<String, Object> ask() throws Exception {
        String arguments = JSON.writeValueAsString(Map.of("questions", List.of(DecisionPortTest.questions().get(0))));
        return Map.of("message", Map.of("role", "assistant", "content", "", "tool_calls",
                        List.of(Map.of("id", "c1", "type", "function", "function", Map.of("name", "ask_user", "arguments", arguments)))),
                "finishReason", "tool_calls", "maxTokens", 16384,
                "usage", Map.of("promptTokens", 100, "completionTokens", 5, "estimated", false));
    }

    private static Map<String, Object> text(String content) {
        return Map.of("message", Map.of("role", "assistant", "content", content), "finishReason", "stop", "maxTokens", 16384,
                "usage", Map.of("promptTokens", 100, "completionTokens", 5, "estimated", false));
    }

    private CodeWorkspaceAgent.Result run(JsCodeAgent js, DecisionPort decisions) {
        return js.run(config, 7L, "开始做", List.of(), false, false, new CodeLoopBudget(5, 0L, 16384, 150_000),
                ContextBudget.DEFAULT, notes::add, null, ReasoningEffort.OFF, null, null, null, decisions);
    }

    @Test
    void 真Node提问后_HTTP答案经Hub回来_模型继续且只推进一步() throws Exception {
        DecisionPort decisions = new DecisionPort();
        ChatRunHub hub = new ChatRunHub(JSON);
        ChatRunHub.LiveRun live = hub.open(99L, text -> true);
        live.useDecisions(decisions);
        JsCodeAgent js = agent(List.of(ask(), text("收到决定")));
        CompletableFuture<CodeWorkspaceAgent.Result> running = CompletableFuture.supplyAsync(() -> run(js, decisions));
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(4);
        while (notes.stream().noneMatch(note -> "decision".equals(note.get("phase"))) && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        Map<String, Object> asked = notes.stream().filter(note -> "decision".equals(note.get("phase"))).findFirst().orElse(null);
        assertNotNull(asked, "后端没有收到宿主的 question：" + notes);
        String decisionId = String.valueOf(asked.get("decisionId"));
        Map<String, Object> accepted = hub.answer(99L, decisionId, Map.of("cancelled", false, "answers",
                List.of(Map.of("questionId", "q1", "optionId", "o2"))));
        assertEquals(true, accepted.get("accepted"));
        CodeWorkspaceAgent.Result result = running.get(5, TimeUnit.SECONDS);
        assertEquals("收到决定", result.conclusion());
        assertEquals(2, bodies.size());
        assertTrue(String.valueOf(bodies.get(1).get("messages")).contains("方案乙"), bodies.toString());
        Map<String, Object> duplicate = hub.answer(99L, decisionId, Map.of("cancelled", false, "answers",
                List.of(Map.of("questionId", "q1", "optionId", "o2"))));
        assertEquals(true, duplicate.get("duplicate"));
        hub.finish(99L);
    }

    @Test
    void 客户端没能力时_模型硬调也只收到无人回答说明() throws Exception {
        JsCodeAgent js = agent(List.of(ask(), text("改用文字说明")));
        CodeWorkspaceAgent.Result result = run(js, null);
        assertEquals("改用文字说明", result.conclusion());
        assertTrue(notes.stream().noneMatch(note -> "decision".equals(note.get("phase"))));
        assertTrue(String.valueOf(bodies.get(1).get("messages")).contains("没有人能用结构化面板"), bodies.toString());
    }
}
