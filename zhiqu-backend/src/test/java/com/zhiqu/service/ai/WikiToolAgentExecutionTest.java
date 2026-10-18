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

    /**
     * 第七十四轮 review：「生成 / 创建」加进写词之后，知识库只是来源的说法也成了写 Wiki ——「根据知识库生成一份复习计划」拿到写工具、
     * 被催着调 create_wiki_patch，没有工具时计划回答还被存成 Wiki 草稿。这一类词（还有常作名词的记录、更新、补充）只在 Wiki 是要写的地方时才算写。
     */
    @ParameterizedTest
    @ValueSource(strings = {"根据知识库生成一份复习计划", "用笔记里的内容生成一个摘要", "从wiki里找资料创建一个任务", "基于知识库的资料帮我生成周报",
            "生成一份基于知识库的复习计划", "根据我上周在会议上记的笔记生成一份总结", "使用笔记生成周报", "知识库里那篇我看过了，帮我生成一份总结",
            "读一下我的笔记然后生成复习计划", "看看知识库后生成一份计划", "把知识库里的内容生成思维导图",
            "帮我看看之前创建的知识页", "生成一份关于知识库的使用说明", "根据知识库生成复习计划，再看看之前创建的知识页",
            "把知识库内容生成思维导图", "笔记内容帮我生成复习计划", "看到知识库中的错题帮我生成练习", "读到笔记里的内容生成总结",
            "帮我生成一份笔记的总结", "因为笔记太多帮我生成一份整理建议"})
    void knowledgeAsTheSourceOfAGenerationIsNotAWikiWrite(String text) {
        assertFalse(AgentPlanDecision.wikiWriteIntent(text), text);
    }

    @ParameterizedTest
    @ValueSource(strings = {"在知识库里创建一页会议纪要", "根据会议记录生成一个wiki页", "帮我在wiki中生成本周总结",
            "在知识库里根据会议记录创建一页纪要", "在知识库里为用户访谈创建一页", "根据知识库在wiki里创建一页总结", "从今天开始在知识库里创建一页打卡记录",
            "根据讲义生成一个wiki页", "帮我创建一个用于复习的知识页", "创建一个用来记错题的笔记", "生成一页常用公式笔记",
            "帮我生成一份从零开始的笔记", "创建一个结合例题的wiki页", "根据课堂讲义给知识库生成一页总结", "从今天开始给wiki创建一页打卡",
            "知识库里新建一页周报", "把这次讨论记录到知识库",
            "把这页笔记补充完整", "将笔记更新为最新版本", "把笔记更新一下", "笔记需要更新", "帮我把知识页里的内容更新一下", "我记的笔记需要更新"})
    void theWikiAsTheThingGeneratedIsStillAWrite(String text) {
        assertTrue(AgentPlanDecision.wikiWriteIntent(text), text);
    }

    /**
     * 明示的取舍（第七十四轮第三遍 review）：这几句判错了，而且是故意留着的。写意图只看这一句话的字面，接不住的不往词表里塞词 ——
     * 第二遍为了「会议记录」把记录 / 更新也按位置判，「把笔记更新一下」就不算写了。改它们之前先想清楚另一边会坏掉哪些说法。
     */
    @ParameterizedTest
    @ValueSource(strings = {"根据知识库里的会议记录生成复习计划", "根据笔记里的学习记录生成一份周报", "根据知识库补充一下你的回答",
            "在笔记里找一下错题生成复习计划", "生成我的笔记摘要"})
    void knownOverTriggersArePinnedAsExplicitTradeoffs(String text) {
        assertTrue(AgentPlanDecision.wikiWriteIntent(text), "这一句原来是过触发的取舍；不再触发了就把它挪到不写的那一组：" + text);
    }

    @ParameterizedTest
    @ValueSource(strings = {"生成知识库的目录页"})
    void knownUnderTriggersArePinnedAsExplicitTradeoffs(String text) {
        assertFalse(AgentPlanDecision.wikiWriteIntent(text), "这一句原来是接不住的取舍；接住了就把它挪到写的那一组：" + text);
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

    /** 第七十四轮第二遍 review：工具把模型给的正文 trim 掉，缩进四格的代码块开头的页一改就成了一段正文（首尾空行交给 cleanKeeping） */
    @Test
    @SuppressWarnings("unchecked")
    void thePatchContentReachesTheServiceWithItsFirstLineIndentation() {
        Rig rig = new Rig(false);
        when(rig.knowledge.createPatchSet(eq(1L), anyMap(), anyMap())).thenReturn(Map.of("id", 73L, "status", "PENDING"));
        String args = "{\"title\":\"代码页\",\"content\":\"    int x = 1;\\n    int y;\\n\"}";
        assertTrue(rig.agent.executeWikiTool(1L, "create_wiki_patch", args, new WikiToolAgent.WikiLoopState()).wrotePatch);
        org.mockito.ArgumentCaptor<Map<String, Object>> body = org.mockito.ArgumentCaptor.forClass(Map.class);
        verify(rig.knowledge).createPatchSet(eq(1L), body.capture(), anyMap());
        Map<String, Object> item = ((List<Map<String, Object>>) body.getValue().get("items")).get(0);
        assertEquals("    int x = 1;\n    int y;\n", item.get("content"));
        assertTrue(rig.agent.executeWikiTool(1L, "create_wiki_patch", "{\"title\":\"空\",\"content\":\"  \\n \"}", new WikiToolAgent.WikiLoopState())
                .result.contains("不能为空"), "只有空白的正文照样拒");
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
