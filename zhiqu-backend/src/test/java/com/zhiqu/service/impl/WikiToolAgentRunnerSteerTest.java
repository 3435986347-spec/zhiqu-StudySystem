package com.zhiqu.service.impl;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessClock;
import com.zhiqu.entity.AiAgentRun;
import com.zhiqu.entity.AiMessage;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.mapper.AiMessageMapper;
import com.zhiqu.service.ReminderPlanService;
import com.zhiqu.service.agent.AgentRunContext;
import com.zhiqu.service.agent.AgentStageRunner;
import com.zhiqu.service.agent.AgentTraceRecorder;
import com.zhiqu.service.ai.ModelProviderClient;
import com.zhiqu.service.ai.StudyPlanTool;
import com.zhiqu.service.ai.WikiToolAgent;
import com.zhiqu.service.ai.stream.ModelStreamAdapter;
import com.zhiqu.service.ai.stream.ModelStreamAdapterFactory;
import com.zhiqu.service.ai.stream.ModelStreamRequest;
import com.zhiqu.service.ai.stream.ModelStreamResult;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * 干活中途补充第 5 步（第一百五十四轮）：普通聊天里，Wiki 工具循环途中补的话交给循环（发一次送达、记一步「你补充」），
 * 最终回答照样按它写，但同一句只出现一次、不再发第二次送达。跑的是发布的 runner（WikiToolAgentRunner、FinalWriterRunner），模型是假的。
 */
class WikiToolAgentRunnerSteerTest {
    private final ModelProviderClient provider = mock(ModelProviderClient.class);
    private final ModelStreamAdapterFactory adapters = mock(ModelStreamAdapterFactory.class);
    private final WikiToolAgent wiki = mock(WikiToolAgent.class);
    private final BusinessClock clock = mock(BusinessClock.class);
    private final ObjectMapper json = new ObjectMapper();

    @Test
    @DisplayName("循环途中读到的补充：发一次送达、记一步；最终回答里有它（只一次），后补的那句在最终回答时送达")
    void 循环里读到的只送达一次() throws Exception {
        AiServiceImpl service = service();
        Object state = state();
        assertTrue(inject(state, "标题别动"), "生成途中补的话没收下");

        List<List<String>> seenByLoop = new ArrayList<>();
        when(wiki.runWikiToolAgent(any(), any(), anyString(), anyInt(), any(WikiToolAgent.Steer.class))).thenAnswer(call -> {
            WikiToolAgent.Steer steer = call.getArgument(4);
            seenByLoop.add(steer.take());   // 第 1 次调模型之前
            seenByLoop.add(steer.take());   // 第 2 次：已经取走了
            return result();
        });
        List<String[]> loopEvents = new ArrayList<>();
        runner(service, state, "WikiToolAgentRunner").run(ctx(loopEvents));
        assertEquals(List.of(List.of("标题别动"), List.of()), seenByLoop, "Wiki 工具循环没取到补充（或者取了两次）");
        assertEquals(1, loopEvents.stream().filter(e -> e[0].equals("message.steer.delivered") && e[1].contains("标题别动")).count(),
                "循环读到了，页面没收到送达：" + names(loopEvents));
        assertTrue(loopEvents.stream().anyMatch(e -> e[0].equals("trace.step") && e[1].contains("steer") && e[1].contains("标题别动")),
                "回答里没有「你补充」那一步");

        assertTrue(inject(state, "再补一句"), "循环跑完、最终回答动笔之前补的没收下");
        List<String[]> finalEvents = new ArrayList<>();
        List<Map<String, Object>> messages = writerMessages(service, state, finalEvents);
        assertEquals(1, messages.stream().filter(m -> String.valueOf(m.get("content")).contains("标题别动")).count(),
                "最终回答要按循环里读到的补充写，且只出现一次：" + messages);
        assertEquals(1, messages.stream().filter(m -> String.valueOf(m.get("content")).contains("再补一句")).count());
        assertFalse(finalEvents.stream().anyMatch(e -> e[0].equals("message.steer.delivered") && e[1].contains("标题别动")),
                "循环里已经送达的，最终回答又发了一次送达");
        assertTrue(finalEvents.stream().anyMatch(e -> e[0].equals("message.steer.delivered") && e[1].contains("再补一句")),
                "最终回答时才读到的没有送达");
    }

    @Test
    @DisplayName("没补话：循环取到的是空的，不发送达、不记步骤")
    void 没补话() throws Exception {
        AiServiceImpl service = service();
        Object state = state();
        List<List<String>> seenByLoop = new ArrayList<>();
        when(wiki.runWikiToolAgent(any(), any(), anyString(), anyInt(), any(WikiToolAgent.Steer.class))).thenAnswer(call -> {
            seenByLoop.add(((WikiToolAgent.Steer) call.getArgument(4)).take());
            return result();
        });
        List<String[]> events = new ArrayList<>();
        runner(service, state, "WikiToolAgentRunner").run(ctx(events));
        assertEquals(List.of(List.of()), seenByLoop, "循环没拿到补充的口子");
        assertFalse(events.stream().anyMatch(e -> e[0].equals("message.steer.delivered")));
    }

    private static String names(List<String[]> events) {
        return events.stream().map(e -> e[0]).toList().toString();
    }

    private AgentRunContext ctx(List<String[]> events) {
        return new AgentRunContext(List.of(), (name, data) -> events.add(new String[]{name, String.valueOf(data)}));
    }

    private static boolean inject(Object state, String text) throws Exception {
        Method m = state.getClass().getDeclaredMethod("inject", String.class);
        m.setAccessible(true);
        return (boolean) m.invoke(state, text);
    }

    private List<Map<String, Object>> writerMessages(AiServiceImpl service, Object state, List<String[]> events) throws Exception {
        AtomicReference<ModelStreamRequest> sent = new AtomicReference<>();
        ModelStreamAdapter adapter = mock(ModelStreamAdapter.class);
        when(provider.normalizeProviderType(anyString())).thenReturn("OPENAI_COMPATIBLE");
        when(adapters.getAdapter(anyString())).thenReturn(adapter);
        when(adapter.stream(any(), any())).thenAnswer(call -> {
            sent.set(call.getArgument(0));
            return new ModelStreamResult("好的。", "", Map.of(), "stop");
        });
        runner(service, state, "FinalWriterRunner").run(ctx(events));
        assertNotNull(sent.get());
        return sent.get().messages();
    }

    private AiServiceImpl service() throws Exception {
        when(clock.today()).thenReturn(LocalDate.of(2026, 11, 17));
        AiServiceImpl service = new AiServiceImpl(null, null, null, mock(AiMessageMapper.class), null, null, null, null, null,
                null, null, null, null, null, null, null, null, adapters, null,
                provider, null, null, null, null, mock(PlatformTransactionManager.class),
                false, "", "OPENAI_COMPATIBLE", "https://example.invalid/v1", "test", "", "2023-06-01", "", false,
                clock, null, null, null, new StudyPlanTool(clock, mock(ReminderPlanService.class), json), null, null);
        set(service, "wikiToolAgent", wiki);
        return service;
    }

    private static WikiToolAgent.WikiAgentResult result() throws Exception {
        Constructor<WikiToolAgent.WikiAgentResult> ctor = WikiToolAgent.WikiAgentResult.class
                .getDeclaredConstructor(String.class, boolean.class, List.class);
        ctor.setAccessible(true);
        return ctor.newInstance("", false, List.of());
    }

    private Object state() throws Exception {
        Class<?> type = Class.forName(AiServiceImpl.class.getName() + "$StreamState");
        Constructor<?> ctor = type.getDeclaredConstructors()[0]; ctor.setAccessible(true);
        AiAgentRun run = new AiAgentRun(); run.setId(2L);
        AiMessage assistant = new AiMessage(); assistant.setId(9L);
        AiMessage user = new AiMessage(); user.setId(8L);
        AiModelConfig config = new AiModelConfig();
        config.setApiUrl("https://example.invalid/v1"); config.setProviderType("OPENAI_COMPATIBLE");
        Object state = ctor.newInstance(mock(AgentTraceRecorder.class), "request-2", run, config, 42L, null,
                "在知识库里找一下项目计划", Map.of(), false, "OFF", "", null, List.of(), user, assistant);
        set(state, "liveUser", user);
        return state;
    }

    private AgentStageRunner runner(AiServiceImpl service, Object state, String name) throws Exception {
        Class<?> type = Class.forName(AiServiceImpl.class.getName() + "$" + name);
        Constructor<?> ctor = type.getDeclaredConstructors()[0]; ctor.setAccessible(true);
        return (AgentStageRunner) ctor.newInstance(service, state);
    }

    private static void set(Object target, String name, Object value) throws Exception {
        Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); field.set(target, value);
    }
}
