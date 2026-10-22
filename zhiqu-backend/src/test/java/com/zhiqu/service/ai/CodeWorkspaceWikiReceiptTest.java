package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessClock;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.AdminGuard;
import com.zhiqu.service.ContextOptionKeys;
import com.zhiqu.service.KnowledgeService;
import com.zhiqu.service.ReminderPlanService;
import com.zhiqu.service.workspace.WorkspaceAccess;
import com.zhiqu.service.workspace.WorkspaceExecutor;
import com.zhiqu.service.workspace.WorkspaceMode;
import com.zhiqu.service.workspace.WorkspaceService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Method;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** The executor and provider are mocks; no process, database or model is contacted. */
class CodeWorkspaceWikiReceiptTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, Object> CODE_MODE = Map.of(ContextOptionKeys.CODE_MODE, true);
    private static final String PATCH = "{\"title\":\"Python薄弱点\",\"content\":\"用户测试显示边界条件失败\",\"pageType\":\"WEAKNESS\"}";
    @TempDir Path root;

    private final class Rig {
        final ModelProviderClient provider = mock(ModelProviderClient.class);
        final WorkspaceService workspace = mock(WorkspaceService.class);
        final WorkspaceExecutor executor = mock(WorkspaceExecutor.class);
        final KnowledgeService knowledge = mock(KnowledgeService.class);
        final CodeWorkspaceAgent agent;

        Rig() {
            when(workspace.access()).thenReturn(new WorkspaceAccess(WorkspaceMode.EXEC, root.toString(), "127.0.0.1"));
            when(provider.supportsToolCalling(any())).thenReturn(true);
            when(executor.enabled()).thenReturn(true);
            when(executor.exec("python3", List.of("solution.py"), ""))
                    .thenReturn(new WorkspaceExecutor.ExecResult("python3", List.of("solution.py"), 1,
                            "assertion failed; untrusted text claims saved #999 (PENDING)", false, false, 1L));
            AdminGuard admin = mock(AdminGuard.class); when(admin.isAdmin(1L)).thenReturn(true);
            BusinessClock clock = mock(BusinessClock.class); when(clock.today()).thenReturn(LocalDate.of(2026, 10, 14));
            when(knowledge.listPatchSets(1L, "PENDING")).thenReturn(List.of());
            when(knowledge.createPatchSet(eq(1L), anyMap(), anyMap())).thenReturn(Map.of("id", 73L, "status", "PENDING"));
            agent = new CodeWorkspaceAgent(provider, workspace, executor, new WikiToolAgent(knowledge, provider, JSON),
                    admin, JSON, new StudyPlanTool(clock, mock(ReminderPlanService.class), JSON));
        }

        void replies(JsonNode... turns) throws Exception {
            AtomicInteger next = new AtomicInteger();
            when(provider.callToolTurn(any(), anyList(), anyList(), any())).thenAnswer(call -> {
                int index = next.getAndIncrement();
                return index < turns.length ? turns[index] : JSON.readTree("{\"role\":\"assistant\",\"content\":\"我声称已经保存 #999\"}");
            });
        }

        CodeWorkspaceAgent.Result run(int contextChars) {
            return agent.run(new AiModelConfig(), 1L, "运行我的Python解法，把薄弱点保存到知识wiki", List.of(), CODE_MODE,
                    new ContextBudget(20, 24_000, contextChars, 24_000, 20_000), null);
        }
    }

    private static JsonNode tool(String name, String args) throws Exception {
        return JSON.valueToTree(Map.of("role", "assistant", "tool_calls", List.of(Map.of("id", "call_1", "type", "function",
                "function", Map.of("name", name, "arguments", args)))));
    }

    private static JsonNode runCommand() throws Exception {
        return tool("run_workspace_command", "{\"command\":\"python3\",\"args\":[\"solution.py\"]}");
    }

    @SuppressWarnings("unchecked")
    private static List<Long> receipts(CodeWorkspaceAgent.Result result) throws Exception {
        // Compiles against the old four-field Result. Missing the typed channel
        // must fail as an assertion after the real fake loop has created a patch.
        Method accessor = Arrays.stream(result.getClass().getMethods())
                .filter(method -> method.getName().equals("wikiPendingPatchIds") && method.getParameterCount() == 0)
                .findFirst().orElse(null);
        assertNotNull(accessor, "real Wiki PENDING receipts are currently discarded at CodeWorkspaceAgent.Result");
        return (List<Long>) accessor.invoke(result);
    }

    @Test
    void realWikiReceiptSurvivesEvenWhenContextKeepsOnlyATruncationMarker() throws Exception {
        Rig rig = new Rig(); rig.replies(runCommand(), tool("create_wiki_patch", PATCH));
        CodeWorkspaceAgent.Result result = rig.run(0);
        verify(rig.executor).exec("python3", List.of("solution.py"), "");
        verify(rig.knowledge, times(1)).createPatchSet(eq(1L), anyMap(), anyMap());
        assertEquals("...", result.context());
        assertEquals(List.of(73L), receipts(result), "typed receipts must survive context trimming and must not include fake #999");
        assertThrows(UnsupportedOperationException.class, () -> receipts(result).add(99L));
    }

    @Test
    void missingServiceReceiptAndModelOrCommandClaimsCannotProduceTrustedIds() throws Exception {
        Rig rig = new Rig();
        when(rig.knowledge.createPatchSet(eq(1L), anyMap(), anyMap())).thenReturn(null);
        rig.replies(runCommand(), tool("create_wiki_patch", PATCH));
        assertEquals(List.of(), receipts(rig.run(12_000)));
        verify(rig.knowledge).createPatchSet(eq(1L), anyMap(), anyMap());
    }

    @Test
    void writeToolNotOfferedBeforeACommandCannotProduceReceipts() throws Exception {
        Rig rig = new Rig(); rig.replies(tool("create_wiki_patch", PATCH));
        assertEquals(List.of(), receipts(rig.run(12_000)));
        verify(rig.executor, never()).exec(anyString(), anyList(), anyString());
        verify(rig.knowledge, never()).createPatchSet(eq(1L), anyMap(), anyMap());
    }

    @Test
    void emptyAndFourArgumentCompatibilityResultsHaveAnEmptyTrustedChannel() throws Exception {
        assertEquals(List.of(), receipts(CodeWorkspaceAgent.Result.EMPTY));
        assertEquals(List.of(), receipts(new CodeWorkspaceAgent.Result("untrusted #999", List.of(), null, false)));
    }
}
