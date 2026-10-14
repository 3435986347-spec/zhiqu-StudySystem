package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.KnowledgePageSnapshot;
import com.zhiqu.service.KnowledgeService;
import com.zhiqu.service.agent.AgentPlanDecision;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Runs the production loop; both model protocols and storage are offline fakes. */
class WikiToolAgentExecutionTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String WRITE_REQUEST = "把这份项目计划写入知识wiki";
    private static final String PATCH_ARGS = "{\"title\":\"项目计划\",\"content\":\"# 项目计划\\n用户已提供的计划\",\"pageType\":\"PROJECT\"}";

    private static final class Rig {
        final KnowledgeService knowledge = mock(KnowledgeService.class);
        final ModelProviderClient provider = mock(ModelProviderClient.class);
        final WikiToolAgent agent = new WikiToolAgent(knowledge, provider, JSON);
        final boolean anthropic;
        final List<List<Map<String, Object>>> requests = new ArrayList<>();

        Rig(boolean anthropic) {
            this.anthropic = anthropic;
            when(provider.supportsToolCalling(any())).thenReturn(true);
            when(provider.isAnthropicProvider(any())).thenReturn(anthropic);
            when(provider.toAnthropicTools(anyList())).thenAnswer(call -> call.getArgument(0));
            when(knowledge.listPatchSets(1L, "PENDING")).thenReturn(List.of());
            when(knowledge.createPatchSet(eq(1L), anyMap(), anyMap()))
                    .thenReturn(Map.of("id", 73L, "status", "PENDING", "title", "项目计划"));
        }

        void replies(JsonNode... replies) {
            java.util.concurrent.atomic.AtomicInteger turn = new java.util.concurrent.atomic.AtomicInteger();
            org.mockito.stubbing.Answer<JsonNode> answer = call -> {
                int index = anthropic ? 2 : 1;
                List<Map<String, Object>> messages = call.getArgument(index);
                requests.add(JSON.convertValue(messages, new com.fasterxml.jackson.core.type.TypeReference<>() {}));
                int next = turn.getAndIncrement();
                return replies[Math.min(next, replies.length - 1)];
            };
            if (anthropic) when(provider.callAnthropicToolTurn(any(), anyString(), anyList(), anyList())).thenAnswer(answer);
            else when(provider.callOpenAiToolTurn(any(), anyList(), anyList())).thenAnswer(answer);
        }

        WikiToolAgent.WikiAgentResult run(String request) {
            return agent.runWikiToolAgent(new AiModelConfig(), 1L, request);
        }

        JsonNode text(String value) throws Exception {
            return anthropic ? JSON.valueToTree(List.of(Map.of("type", "text", "text", value)))
                    : JSON.valueToTree(Map.of("role", "assistant", "content", value));
        }

        JsonNode tool(String name, String args) throws Exception {
            return anthropic ? JSON.valueToTree(List.of(Map.of("type", "tool_use", "id", "call_1", "name", name, "input", JSON.readTree(args))))
                    : JSON.valueToTree(Map.of("role", "assistant", "tool_calls", List.of(Map.of("id", "call_1", "type", "function",
                    "function", Map.of("name", name, "arguments", args)))));
        }
    }

    @Test
    void generateAndCreateWikiAreWriteRequests() {
        for (String text : List.of("帮我生成知识wiki计划", "请创建一个知识页", "帮我生成一个wiki计划，可以吗", "请更新已经创建过的知识页")) {
            assertTrue(AgentPlanDecision.wikiWriteIntent(text), text);
            assertTrue(AgentPlanDecision.wikiToolIntent(text), text);
        }
    }

    @Test
    void pastTenseAndStatusQuestionsStayReadOnly() {
        for (String text : List.of("你生成了wiki待合入吗", "有没有生成过wiki草稿", "你更新知识页了吗", "wiki草稿有没有保存", "如何创建知识页", "如何生成Wiki")) {
            assertFalse(AgentPlanDecision.wikiWriteIntent(text), text);
            assertTrue(AgentPlanDecision.wikiToolIntent(text), text);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"你生成了Wiki草稿吗？没有的话请创建一个Wiki页", "把生成的报告保存到Wiki", "请帮我生成Wiki", "把如何生成Wiki的说明保存到Wiki"})
    void anExplicitLaterWriteRequestIsNotHiddenByAnEarlierPastVerbOrQuotedQuestion(String text) {
        assertTrue(AgentPlanDecision.wikiWriteIntent(text), text);
        assertTrue(AgentPlanDecision.wikiToolIntent(text), text);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void plainTextClaimMustBeFollowedByOneBoundedReminderAndARealPatchInBothProtocols(boolean anthropic) throws Exception {
        Rig rig = new Rig(anthropic);
        rig.replies(rig.text("我已写好了计划，并更新 index/log"), rig.tool("create_wiki_patch", PATCH_ARGS), rig.text("草稿已提交"));
        WikiToolAgent.WikiAgentResult result = rig.run(WRITE_REQUEST);
        assertTrue(result.wrotePatch, "natural language alone must not end a requested write: " + anthropic);
        verify(rig.knowledge, times(1)).createPatchSet(eq(1L), anyMap(), anyMap());
        assertTrue(result.context.contains("#73"), result.context);
        assertEquals(List.of(73L), result.pendingPatchIds); assertTrue(result.writeRequested);
        Map<String, Object> reminder = rig.requests.get(1).get(rig.requests.get(1).size() - 1);
        assertEquals("user", reminder.get("role"));
        assertTrue(String.valueOf(reminder.get("content")).contains("create_wiki_patch"));
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void modelThatKeepsReturningOnlyTextGetsAtMostOneReminderAndNoDraft(boolean anthropic) throws Exception {
        Rig rig = new Rig(anthropic); rig.replies(rig.text("已经创建"));
        assertFalse(rig.run(WRITE_REQUEST).wrotePatch);
        assertEquals(2, rig.requests.size(), "reminder must be bounded in both protocols");
        verify(rig.knowledge, never()).createPatchSet(anyLong(), anyMap(), anyMap());
    }

    @Test
    void createNeedsAnActualPendingIdReceiptAndErrorsNeverCountAsSaved() {
        List<Map<String, Object>> invalid = new ArrayList<>();
        invalid.add(null); invalid.add(Map.of()); invalid.add(Map.of("id", 73L, "status", "APPLIED"));
        invalid.add(Map.of("id", 0L, "status", "PENDING")); invalid.add(Map.of("id", "not-an-id", "status", "PENDING"));
        invalid.add(Map.of("id", 1.5, "status", "PENDING"));
        for (Map<String, Object> receipt : invalid) {
            Rig rig = new Rig(false);
            when(rig.knowledge.createPatchSet(eq(1L), anyMap(), anyMap())).thenReturn(receipt);
            WikiToolAgent.WikiToolExecution result = rig.agent.executeWikiTool(1L, "create_wiki_patch", PATCH_ARGS, new WikiToolAgent.WikiLoopState());
            assertFalse(result.wrotePatch, "unverified receipt: " + receipt);
            assertTrue(result.result.contains("未确认"), result.result);
        }
        Rig rig = new Rig(false);
        when(rig.knowledge.createPatchSet(eq(1L), anyMap(), anyMap())).thenThrow(new IllegalStateException("保存失败"));
        WikiToolAgent.WikiToolExecution result = rig.agent.executeWikiTool(1L, "create_wiki_patch", PATCH_ARGS, new WikiToolAgent.WikiLoopState());
        assertFalse(result.wrotePatch); assertTrue(result.result.contains("工具执行失败"));
    }

    @Test
    void pendingDedupNeedsARealIdAndStatusAndSameLoopKeepsTheConfirmedId() {
        Rig rig = new Rig(false);
        when(rig.knowledge.listPatchSets(1L, "PENDING")).thenReturn(List.of(Map.of("title", "项目计划", "status", "PENDING")));
        assertFalse(rig.agent.executeWikiTool(1L, "create_wiki_patch", PATCH_ARGS, new WikiToolAgent.WikiLoopState()).wrotePatch);
        verify(rig.knowledge, never()).createPatchSet(eq(1L), anyMap(), anyMap());
        when(rig.knowledge.listPatchSets(1L, "PENDING")).thenReturn(List.of(Map.of("title", "项目计划", "id", 88L, "status", "PENDING")));
        WikiToolAgent.WikiLoopState state = new WikiToolAgent.WikiLoopState();
        assertTrue(rig.agent.executeWikiTool(1L, "create_wiki_patch", PATCH_ARGS, state).result.contains("#88"));
        assertTrue(rig.agent.executeWikiTool(1L, "create_wiki_patch", PATCH_ARGS, state).result.contains("#88"));
        verify(rig.knowledge, never()).createPatchSet(eq(1L), anyMap(), anyMap());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void readOnlyRequestsCannotExecuteForgedWriteToolCallsInEitherProtocol(boolean anthropic) throws Exception {
        Rig rig = new Rig(anthropic); rig.replies(rig.tool("create_wiki_patch", PATCH_ARGS), rig.text("已提交"));
        assertFalse(rig.run("查一下知识wiki里的项目计划").wrotePatch);
        verify(rig.knowledge, never()).createPatchSet(eq(1L), anyMap(), anyMap());
    }

    @Test
    void existingFullReadReservedPageAndPerLoopIdempotencyRemainEnforced() {
        Rig rig = new Rig(false); WikiToolAgent.WikiLoopState state = new WikiToolAgent.WikiLoopState();
        when(rig.knowledge.findPageSnapshotByTitle(1L, "项目计划")).thenReturn(new KnowledgePageSnapshot(9L, "项目计划", "PROJECT", "已有完整内容", 4, "state-hash"));
        assertFalse(rig.agent.executeWikiTool(1L, "create_wiki_patch", PATCH_ARGS, state).wrotePatch);
        rig.agent.executeWikiTool(1L, "read_wiki_page", "{\"title\":\"项目计划\"}", state);
        assertTrue(rig.agent.executeWikiTool(1L, "create_wiki_patch", PATCH_ARGS, state).wrotePatch);
        assertTrue(rig.agent.executeWikiTool(1L, "create_wiki_patch", PATCH_ARGS, state).wrotePatch);
        verify(rig.knowledge, times(1)).createPatchSet(eq(1L), anyMap(), argThat(snapshots -> snapshots.containsKey(9L)));
        for (String title : List.of("index", "log", "Wiki 维护规则")) {
            assertFalse(rig.agent.executeWikiTool(1L, "create_wiki_patch", "{\"title\":\"" + title + "\",\"content\":\"x\"}", state).wrotePatch);
        }
    }
}
