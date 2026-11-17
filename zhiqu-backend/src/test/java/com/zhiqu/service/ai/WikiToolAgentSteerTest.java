package com.zhiqu.service.ai;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.KnowledgeService;
import com.zhiqu.service.agent.AgentPlanDecision;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * 干活中途补充第 5 步（第一百五十四轮，docs/steer-plan.md）：普通聊天的 Wiki 工具循环在轮与轮之间读用户补的话。
 * 跑的是生产的循环，模型和存储是假的；OpenAI、Anthropic 两种协议各一遍。
 */
class WikiToolAgentSteerTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String REQUEST = "在知识库里找一下项目计划";
    private static final String SAID = "只看 2026 年的";

    private final KnowledgeService knowledge = mock(KnowledgeService.class);
    private final ModelProviderClient provider = mock(ModelProviderClient.class);
    private final WikiToolAgent agent = new WikiToolAgent(knowledge, provider, JSON);
    private final List<List<Map<String, Object>>> requests = new ArrayList<>();

    private void rig(boolean anthropic, JsonNode... replies) {
        when(provider.supportsToolCalling(any())).thenReturn(true);
        when(provider.isAnthropicProvider(any())).thenReturn(anthropic);
        when(provider.toAnthropicTools(anyList())).thenAnswer(call -> call.getArgument(0));
        AtomicInteger turn = new AtomicInteger();
        org.mockito.stubbing.Answer<JsonNode> answer = call -> {
            List<Map<String, Object>> messages = call.getArgument(anthropic ? 2 : 1);
            requests.add(JSON.convertValue(messages, new TypeReference<>() {}));
            return replies[Math.min(turn.getAndIncrement(), replies.length - 1)];
        };
        if (anthropic) when(provider.callAnthropicToolTurn(any(), anyString(), anyList(), anyList())).thenAnswer(answer);
        else when(provider.callOpenAiToolTurn(any(), anyList(), anyList())).thenAnswer(answer);
    }

    private static JsonNode text(boolean anthropic, String value) {
        return anthropic ? JSON.valueToTree(List.of(Map.of("type", "text", "text", value)))
                : JSON.valueToTree(Map.of("role", "assistant", "content", value));
    }

    private static JsonNode search(boolean anthropic) {
        return anthropic
                ? JSON.valueToTree(List.of(Map.of("type", "tool_use", "id", "call_1", "name", "search_wiki", "input", Map.of("query", "项目计划"))))
                : JSON.valueToTree(Map.of("role", "assistant", "tool_calls", List.of(Map.of("id", "call_1", "type", "function",
                "function", Map.of("name", "search_wiki", "arguments", "{\"query\":\"项目计划\"}")))));
    }

    /** 模型调用过 {@code after} 次之后才补那句话（只补一次）；记下每次取的时候有没有取到 */
    private WikiToolAgent.Steer steerAfter(int after, List<Integer> takenAt) {
        boolean[] given = {false};
        return () -> {
            if (!given[0] && requests.size() == after) {
                given[0] = true;
                takenAt.add(requests.size());
                return List.of(SAID);
            }
            return List.of();
        };
    }

    private static String flat(Object content) {
        return content instanceof String str ? str : JSON.valueToTree(content).toString();
    }

    private static long mentions(List<Map<String, Object>> request) {
        return request.stream().filter(m -> flat(m.get("content")).contains(SAID)).count();
    }

    @ParameterizedTest(name = "anthropic={0}")
    @ValueSource(booleans = {false, true})
    @DisplayName("工具跑完、下一次调用之前补的：下一次请求里有，排在整批工具结果之后，只出现一次；Anthropic 不造连着的两条 user")
    void 轮与轮之间(boolean anthropic) {
        assertTrue(AgentPlanDecision.wikiToolIntent(REQUEST), "样本不是 Wiki 工具请求");
        rig(anthropic, search(anthropic), text(anthropic, "找到了"));
        List<Integer> takenAt = new ArrayList<>();
        agent.runWikiToolAgent(new AiModelConfig(), 1L, REQUEST, WikiToolAgent.WIKI_CONTEXT_LIMIT, steerAfter(1, takenAt));
        assertEquals(2, requests.size(), "补充不该多出模型调用");
        assertEquals(0, mentions(requests.get(0)));
        List<Map<String, Object>> second = requests.get(1);
        assertEquals(1, mentions(second), "补的话没进第 2 次请求（或者进了两次）：" + second);
        Map<String, Object> last = second.get(second.size() - 1);
        assertEquals("user", last.get("role"));
        assertTrue(flat(last.get("content")).contains(WikiToolAgent.STEER_LEAD), "补充没有标明是中途补充");
        if (anthropic) {
            String content = flat(last.get("content"));
            assertTrue(content.indexOf("tool_result") >= 0 && content.indexOf("tool_result") < content.indexOf(SAID),
                    "补充要并进 tool_result 那条 user 消息、排在结果后面：" + content);
            for (int i = 1; i < second.size(); i++) {
                assertFalse("user".equals(second.get(i).get("role")) && "user".equals(second.get(i - 1).get("role")), "Anthropic 出现了连着的两条 user");
            }
        } else {
            assertEquals("tool", second.get(second.size() - 2).get("role"), "补充没有排在整批工具结果之后");
        }
    }

    @ParameterizedTest(name = "anthropic={0}")
    @ValueSource(booleans = {false, true})
    @DisplayName("模型要收尾时正好补了：不收尾，带上补充再调一次")
    void 要收尾时(boolean anthropic) {
        assertTrue(AgentPlanDecision.wikiToolIntent(REQUEST), "样本不是 Wiki 工具请求");
        assertFalse(AgentPlanDecision.wikiWriteIntent(REQUEST), "样本是写请求：收尾时会被「还没写」推回去，照不出补充那一支");
        rig(anthropic, text(anthropic, "没什么要做的"), text(anthropic, "按补充看了"));
        List<Integer> takenAt = new ArrayList<>();
        agent.runWikiToolAgent(new AiModelConfig(), 1L, REQUEST, WikiToolAgent.WIKI_CONTEXT_LIMIT, steerAfter(1, takenAt));
        assertEquals(List.of(1), takenAt);
        assertEquals(2, requests.size(), "模型说完了、补充还没读：这一段直接收尾了");
        assertEquals(1, mentions(requests.get(1)), requests.get(1).toString());
    }

    @ParameterizedTest(name = "anthropic={0}")
    @ValueSource(booleans = {false, true})
    @DisplayName("没有补充：请求和不带补充的老路一模一样")
    void 没有补充(boolean anthropic) {
        rig(anthropic, search(anthropic), text(anthropic, "找到了"));
        agent.runWikiToolAgent(new AiModelConfig(), 1L, REQUEST, WikiToolAgent.WIKI_CONTEXT_LIMIT, () -> List.of());
        List<List<Map<String, Object>>> withSteer = new ArrayList<>(requests);
        rig(anthropic, search(anthropic), text(anthropic, "找到了"));   // 假模型从第一句重新回
        requests.clear();   // 重新装的时候 when(...) 会调一次旧的答复，记下一条空请求
        agent.runWikiToolAgent(new AiModelConfig(), 1L, REQUEST, WikiToolAgent.WIKI_CONTEXT_LIMIT);
        assertEquals(2, withSteer.size(), "一次模型调用都没有：比的是两份空的");
        assertEquals(requests, withSteer);
    }
}
