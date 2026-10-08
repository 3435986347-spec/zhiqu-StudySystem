package com.zhiqu.service.harness;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessClock;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiAgentArtifact;
import com.zhiqu.service.AiWorkspaceService;
import com.zhiqu.service.ReminderPlanService;
import com.zhiqu.service.ai.StudyPlanTool;
import com.zhiqu.service.ai.WikiToolAgent;
import com.zhiqu.service.memory.LongTermMemoryStore;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.lang.reflect.Method;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 远程工具：写类操作一律是草稿；Wiki 的「这一轮读过什么」按会话记住。 */
class HarnessRemoteToolsTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private final WikiToolAgent wiki = mock(WikiToolAgent.class);
    private final LongTermMemoryStore memory = mock(LongTermMemoryStore.class);
    private final AiWorkspaceService workspace = mock(AiWorkspaceService.class);
    private final HarnessSessionService sessions = mock(HarnessSessionService.class);
    private final com.zhiqu.service.ai.AssistantTaskReader taskReader = mock(com.zhiqu.service.ai.AssistantTaskReader.class);
    private final com.zhiqu.service.StudyTaskService taskService = mock(com.zhiqu.service.StudyTaskService.class);
    private final com.zhiqu.mapper.SysUserMapper users = mock(com.zhiqu.mapper.SysUserMapper.class);
    private final HarnessRemoteTools tools;

    HarnessRemoteToolsTest() {
        BusinessClock clock = mock(BusinessClock.class);
        when(clock.today()).thenReturn(LocalDate.of(2026, 9, 24));
        StudyPlanTool plans = new StudyPlanTool(clock, mock(ReminderPlanService.class), JSON);
        tools = new HarnessRemoteTools(wiki, plans, memory, workspace, sessions, JSON, taskReader, taskService, users);
        // 工具声明用真实的那一份（只拼 schema，不碰字段）—— 判的是远程工具表和 Wiki 真实声明一致
        when(wiki.buildWikiTools(org.mockito.ArgumentMatchers.anyBoolean())).thenCallRealMethod();
        when(sessions.draftRun(anyLong(), anyString())).thenReturn(77L);
        when(workspace.createArtifact(anyLong(), any(), anyString(), anyString(), any(), any())).thenAnswer(inv -> {
            AiAgentArtifact a = new AiAgentArtifact();
            a.setId(900L);
            a.setArtifactType(inv.getArgument(2));
            a.setTitle(inv.getArgument(3));
            return a;
        });
    }

    private static WikiToolAgent.WikiToolExecution execution(String text) throws Exception {
        Method read = WikiToolAgent.WikiToolExecution.class.getDeclaredMethod("read", String.class);
        read.setAccessible(true);
        return (WikiToolAgent.WikiToolExecution) read.invoke(null, text);
    }

    @Test
    @DisplayName("工具表：Wiki 三个、计划一个、记忆两个、任务两个，不重名")
    void 工具表() {
        List<String> names = new ArrayList<>();
        for (Map<String, Object> t : tools.tools()) names.add(String.valueOf(((Map<?, ?>) t.get("function")).get("name")));
        assertEquals(Set.of("search_wiki", "read_wiki_page", "create_wiki_patch", "create_study_plan",
                "read_memory", "propose_memory", "list_tasks", "update_task_status"), new HashSet<>(names));
        assertEquals(names.size(), new HashSet<>(names).size());
    }

    @Test
    @DisplayName("Wiki：同一段会话的几次调用拿到同一份「读过什么」；另一段会话是另一份")
    void wiki状态按会话() throws Exception {
        List<WikiToolAgent.WikiLoopState> seen = new ArrayList<>();
        when(wiki.executeWikiTool(anyLong(), anyString(), anyString(), any())).thenAnswer(inv -> {
            seen.add(inv.getArgument(3));
            return execution("ok");
        });
        tools.call(1L, "s1", "read_wiki_page", Map.of("title", "薄弱点"));
        tools.call(1L, "s1", "create_wiki_patch", Map.of("title", "薄弱点", "content", "…"));
        tools.call(1L, "s2", "read_wiki_page", Map.of("title", "薄弱点"));
        tools.call(2L, "s1", "read_wiki_page", Map.of("title", "薄弱点"));
        assertSame(seen.get(0), seen.get(1), "同一段会话里先读后改，改的时候必须知道刚才读过");
        assertNotSame(seen.get(0), seen.get(2));
        assertNotSame(seen.get(0), seen.get(3), "别的用户同名会话不能共用");
    }

    @Test
    @DisplayName("计划：参数不对就告诉模型，一个草稿都不建；对了就建 TASK_DRAFT，挂在这段会话的那一轮上，并说明还没进日历")
    @SuppressWarnings("unchecked")
    void 计划() {
        Map<String, Object> bad = tools.call(1L, "s1", StudyPlanTool.NAME, "{\"tasks\":[]}");
        assertTrue(String.valueOf(bad.get("content")).contains("参数不对"));
        verify(workspace, never()).createArtifact(anyLong(), any(), anyString(), anyString(), any(), any());

        Map<String, Object> ok = tools.call(1L, "s1", StudyPlanTool.NAME,
                "{\"tasks\":[{\"title\":\"做完马里奥第一关\",\"deadline\":\"2026-09-30 20:00:00\"}]}");
        ArgumentCaptor<Map<String, Object>> content = ArgumentCaptor.forClass(Map.class);
        verify(workspace).createArtifact(eq(77L), any(), eq("TASK_DRAFT"), anyString(), content.capture(), any());
        assertEquals("做完马里奥第一关", ((List<Map<String, Object>>) content.getValue().get("tasks")).get(0).get("title"));
        assertTrue(String.valueOf(ok.get("content")).contains("还没有写进日历"), ok.toString());
        assertEquals(1, ((List<?>) ok.get("drafts")).size());
    }

    @Test
    @DisplayName("记忆：propose_memory 只建 MEMORY_DRAFT，不碰长期记忆本身；空的不建")
    void 记忆() {
        tools.call(1L, "s1", HarnessRemoteTools.PROPOSE_MEMORY, "{\"items\":[]}");
        verify(workspace, never()).createArtifact(anyLong(), any(), anyString(), anyString(), any(), any());
        Map<String, Object> ok = tools.call(1L, "s1", HarnessRemoteTools.PROPOSE_MEMORY, Map.of("items", List.of("偏好用 Python 刷题")));
        verify(workspace).createArtifact(eq(77L), any(), eq("MEMORY_DRAFT"), anyString(), any(), any());
        verify(memory, never()).write(anyLong(), anyString());
        verify(memory, never()).appendItems(anyLong(), any());
        assertTrue(String.valueOf(ok.get("content")).contains("还没有写入"));
    }

    @Test
    @DisplayName("不认识的工具名、不合法的会话 id 都拒")
    void 拒绝() {
        assertThrows(BusinessException.class, () -> tools.call(1L, "s1", "rm_rf", "{}"));
        assertThrows(BusinessException.class, () -> tools.call(1L, "../x", "read_memory", "{}"));
    }

    // ── 任务（第二十九轮：命令行 / MCP 接上任务；用户定的「新建走草稿，改状态直接做」）──

    private static com.zhiqu.entity.SysUser userWithSwitch(Integer aiReadTasks) {
        com.zhiqu.entity.SysUser u = new com.zhiqu.entity.SysUser();
        u.setId(1L);
        u.setAiReadTasks(aiReadTasks);
        return u;
    }

    @Test
    @DisplayName("列工具里有 list_tasks（无参数）和 update_task_status（task_id 整数、status 只有三种）")
    void 任务工具的声明() {
        Map<String, Map<String, Object>> byName = new java.util.HashMap<>();
        for (Map<String, Object> t : tools.tools()) {
            @SuppressWarnings("unchecked") Map<String, Object> fn = (Map<String, Object>) t.get("function");
            byName.put(String.valueOf(fn.get("name")), fn);
        }
        assertTrue(byName.containsKey("list_tasks") && byName.containsKey("update_task_status"), byName.keySet().toString());
        String schema = byName.get("update_task_status").get("parameters").toString();
        assertTrue(schema.contains("task_id") && schema.contains("integer") && schema.contains("todo") && schema.contains("done"), schema);
    }

    @Test
    @DisplayName("list_tasks：开关开着（空也算开）读带 #编号的那一份；关着读不到、说清楚，连读都不去读")
    void 读任务跟着开关() {
        when(users.selectById(1L)).thenReturn(userWithSwitch(null));
        when(taskReader.read(1L, true)).thenReturn(new com.zhiqu.service.ai.AssistantTaskReader.Read("【任务】- #12 交周报", 1, 1));
        assertEquals("【任务】- #12 交周报", tools.call(1L, "s1", "list_tasks", "{}").get("content"));

        when(users.selectById(1L)).thenReturn(userWithSwitch(0));
        String off = String.valueOf(tools.call(1L, "s1", "list_tasks", "{}").get("content"));
        assertTrue(off.contains("关掉了「让 AI 读我的任务」"), off);
        verify(taskReader, org.mockito.Mockito.times(1)).read(anyLong(), org.mockito.ArgumentMatchers.anyBoolean());
    }

    @Test
    @DisplayName("update_task_status：直接改（不是草稿），#12 和 12 都认；状态 / 编号不对、不是自己的任务都说清楚，不抛到协议层")
    void 改任务状态() {
        when(users.selectById(1L)).thenReturn(userWithSwitch(null));
        com.zhiqu.entity.StudyTask t = new com.zhiqu.entity.StudyTask();
        t.setId(12L);
        t.setTitle("交周报");
        when(taskService.updateStatus(1L, 12L, 2)).thenReturn(t);
        String done = String.valueOf(tools.call(1L, "s1", "update_task_status", "{\"task_id\":\"#12\",\"status\":\"done\"}").get("content"));
        assertEquals("已把 #12「交周报」标成已完成。", done);
        verify(taskService).updateStatus(1L, 12L, 2);

        String badStatus = String.valueOf(tools.call(1L, "s1", "update_task_status", "{\"task_id\":12,\"status\":\"finished\"}").get("content"));
        assertTrue(badStatus.contains("todo") && badStatus.contains("done"), badStatus);
        String badId = String.valueOf(tools.call(1L, "s1", "update_task_status", "{\"task_id\":\"周报\",\"status\":\"done\"}").get("content"));
        assertTrue(badId.contains("#编号"), badId);
        verify(taskService, org.mockito.Mockito.times(1)).updateStatus(anyLong(), anyLong(), org.mockito.ArgumentMatchers.anyInt());

        when(taskService.updateStatus(1L, 99L, 1)).thenThrow(new BusinessException("任务不存在"));
        String notMine = String.valueOf(tools.call(1L, "s1", "update_task_status", "{\"task_id\":99,\"status\":\"doing\"}").get("content"));
        assertTrue(notMine.startsWith("没有改成：任务不存在"), notMine);
    }

    @Test
    @DisplayName("update_task_status 也跟着开关：关着时不改、也不回任务标题（第四十七轮 review：拿编号一个个试，回复里的标题就把关着的开关读穿了）")
    void 改状态也跟着开关() {
        when(users.selectById(1L)).thenReturn(userWithSwitch(0));
        com.zhiqu.entity.StudyTask t = new com.zhiqu.entity.StudyTask();
        t.setId(12L);
        t.setTitle("季度汇报");
        when(taskService.updateStatus(1L, 12L, 2)).thenReturn(t);
        String off = String.valueOf(tools.call(1L, "s1", "update_task_status", "{\"task_id\":12,\"status\":\"done\"}").get("content"));
        assertTrue(off.contains("关掉了「让 AI 读我的任务」") && !off.contains("季度汇报"), off);
        verify(taskService, org.mockito.Mockito.never()).updateStatus(anyLong(), anyLong(), org.mockito.ArgumentMatchers.anyInt());
    }
}
