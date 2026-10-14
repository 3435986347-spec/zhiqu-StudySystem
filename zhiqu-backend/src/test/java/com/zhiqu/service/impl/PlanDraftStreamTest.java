package com.zhiqu.service.impl;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessClock;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiAgentArtifact;
import com.zhiqu.entity.AiAgentRun;
import com.zhiqu.entity.AiMessage;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.mapper.AiMessageMapper;
import com.zhiqu.service.ReminderPlanService;
import com.zhiqu.service.agent.AgentRunContext;
import com.zhiqu.service.agent.AgentStageRunner;
import com.zhiqu.service.ai.ModelProviderClient;
import com.zhiqu.service.ai.StudyPlanTool;
import com.zhiqu.service.ai.stream.ModelStreamAdapter;
import com.zhiqu.service.ai.stream.ModelStreamAdapterFactory;
import com.zhiqu.service.ai.stream.ModelStreamRequest;
import com.zhiqu.service.ai.stream.ModelStreamResult;
import com.zhiqu.service.ai.stream.NormalizedStreamEvent;
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
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

/** 真正的 runner / SSE payload，业务依赖用进程内 mock；不联网、不用数据库或 Docker。 */
class PlanDraftStreamTest {
    private final ModelProviderClient provider = mock(ModelProviderClient.class);
    private final ModelStreamAdapterFactory adapters = mock(ModelStreamAdapterFactory.class);
    private final BusinessClock clock = mock(BusinessClock.class);
    private final ObjectMapper json = new ObjectMapper();

    private AiServiceImpl service() {
        when(clock.today()).thenReturn(LocalDate.of(2026, 10, 14));
        return new AiServiceImpl(null, null, null, mock(AiMessageMapper.class), null, null, null, null, null,
                null, null, null, null, null, null, null, null, adapters, null,
                provider, null, null, null, null, mock(PlatformTransactionManager.class),
                false, "", "OPENAI_COMPATIBLE", "https://example.invalid/v1", "test", "", "2023-06-01", "", false,
                clock, null, null, null, new StudyPlanTool(clock, mock(ReminderPlanService.class), json), null);
    }

    @Test
    void 已提交计划事件必须直接带完整可确认内容而不是仅标题() throws Exception {
        AiServiceImpl service = service();
        Map<String, Object> content = Map.of("tasks", List.of(Map.of("title", "准备汇报", "durationMinutes", 45,
                "suggestedQuadrant", 2, "deadline", "2026-10-15 18:00:00")), "routines", List.of());
        Method summary = AiServiceImpl.class.getDeclaredMethod("artifactStreamSummary", AiAgentArtifact.class);
        summary.setAccessible(true);
        assertAll(
                () -> assertEquals(content, ((Map<?, ?>) summary.invoke(service, artifact("PLAN_DRAFT", content))).get("content"), "计划到达即可确认"),
                () -> assertEquals(content, ((Map<?, ?>) summary.invoke(service, artifact("TASK_DRAFT", content))).get("content"), "任务到达即可确认"),
                () -> assertEquals(content, ((Map<?, ?>) summary.invoke(service, artifact("ROUTINE_DRAFT", content))).get("content"), "例行计划到达即可确认"),
                () -> assertFalse(((Map<?, ?>) summary.invoke(service, artifact("CITATION", content))).containsKey("content"),
                        "资料引用仍走预览，不能为计划把所有大正文塞进 SSE"));
    }

    @Test
    void 已有结构化计划时实际提取runner不得再次请求模型() throws Exception {
        AiServiceImpl service = service();
        Object state = state("帮我制定下周工作计划");
        Map<String, Object> plan = Map.of("tasks", List.of(Map.of("title", "已有里程碑")), "routines", List.of());
        set(state, "suggestedPlan", plan);
        doThrow(new BusinessException("offline control")).when(provider).validateProviderRequestUrl(anyString());
        runner(service, state, "PlanExtractorRunner").run(new AgentRunContext(List.of(), (name, data) -> {}));
        assertSame(plan, get(state, "suggestedPlan"), "已有字段和对象应直接复用");
        verifyNoInteractions(provider);
    }

    @Test
    void 回答之后请求计划模型之前必须先发真实整理状态() throws Exception {
        AiServiceImpl service = service();
        List<String> order = new ArrayList<>();
        doAnswer(call -> { order.add("model-request"); throw new BusinessException("offline control"); })
                .when(provider).validateProviderRequestUrl(anyString());
        Object state = state("帮我制定下周工作计划");
        set(state, "finalReply", "周一准备汇报。");
        runner(service, state, "PlanExtractorRunner").run(new AgentRunContext(List.of(), (name, data) -> {
            if (name.equals("message.processing")) {
                Map<?, ?> event = (Map<?, ?>) data;
                assertEquals("PLAN_DRAFT", event.get("stage"));
                assertEquals(9L, event.get("assistantMessageId"));
                assertTrue(String.valueOf(event.get("message")).contains("正在整理"));
                order.add(name);
            }
        }));
        assertEquals(List.of("message.processing", "model-request"), order,
                "原来正文结束之后几秒空档，没有告诉页面正在提取草稿");
    }

    @Test
    void 实际writer请求须说明可确认草稿尚未保存() throws Exception {
        AiServiceImpl service = service();
        AtomicReference<ModelStreamRequest> sent = new AtomicReference<>();
        ModelStreamAdapter adapter = mock(ModelStreamAdapter.class);
        when(provider.normalizeProviderType(anyString())).thenReturn("OPENAI_COMPATIBLE");
        when(adapters.getAdapter(anyString())).thenReturn(adapter);
        when(adapter.stream(any(), any())).thenAnswer(call -> {
            sent.set(call.getArgument(0));
            java.util.function.Consumer<NormalizedStreamEvent> sink = call.getArgument(1);
            sink.accept(NormalizedStreamEvent.message("我会把这些安排整理成待确认草稿。"));
            return new ModelStreamResult("我会把这些安排整理成待确认草稿。", "", Map.of(), "stop");
        });
        runner(service, state("帮我制定下周工作计划"), "FinalWriterRunner")
                .run(new AgentRunContext(List.of(), (name, data) -> {}));
        assertNotNull(sent.get(), "必须真正执行发布的 writer");
        assertTrue(sent.get().messages().stream().anyMatch(message ->
                "system".equals(message.get("role"))
                        && String.valueOf(message.get("content")).contains("不要宣称计划草稿已生成")
                        && String.valueOf(message.get("content")).contains("确认后才会写入日历")),
                "自然语言生成时 artifact 还没提交，不能提前宣称它已经可用");
    }

    private AiAgentArtifact artifact(String type, Map<String, Object> content) throws Exception {
        AiAgentArtifact artifact = new AiAgentArtifact();
        artifact.setId(17L); artifact.setArtifactType(type); artifact.setStatus("DRAFT");
        artifact.setContentJson(json.writeValueAsString(content));
        return artifact;
    }

    private Object state(String message) throws Exception {
        Class<?> type = Class.forName(AiServiceImpl.class.getName() + "$StreamState");
        Constructor<?> ctor = type.getDeclaredConstructors()[0]; ctor.setAccessible(true);
        AiAgentRun run = new AiAgentRun(); run.setId(2L);
        AiMessage assistant = new AiMessage(); assistant.setId(9L);
        AiModelConfig config = new AiModelConfig();
        config.setApiUrl("https://example.invalid/v1"); config.setProviderType("OPENAI_COMPATIBLE");
        return ctor.newInstance(null, "request-2", run, config, 42L, null, message, Map.of(), false, "OFF",
                "", null, List.of(), new AiMessage(), assistant);
    }

    private AgentStageRunner runner(AiServiceImpl service, Object state, String name) throws Exception {
        Class<?> type = Class.forName(AiServiceImpl.class.getName() + "$" + name);
        Constructor<?> ctor = type.getDeclaredConstructors()[0]; ctor.setAccessible(true);
        return (AgentStageRunner) ctor.newInstance(service, state);
    }

    private static Object get(Object target, String name) throws Exception {
        Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(target);
    }
    private static void set(Object target, String name, Object value) throws Exception {
        Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); field.set(target, value);
    }
}
