package com.zhiqu.service.harness;

import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiNotebook;
import com.zhiqu.entity.HarnessSession;
import com.zhiqu.mapper.HarnessSessionMapper;
import com.zhiqu.service.AiService;
import com.zhiqu.service.AiWorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DuplicateKeyException;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 第一百四十五轮（docs/app-resume-plan.md）：应用里发起的会话，会话记录的 id 是 app-<Notebook 号>。
 * 命令行接着说时存档回到原来那个对话，不另建「命令行 · …」；别人的号、已删的号照旧新建；并发撞上时不删用户自己的对话。
 */
class HarnessSessionBindTest {

    private final HarnessSessionMapper mapper = mock(HarnessSessionMapper.class);
    private final AiWorkspaceService workspace = mock(AiWorkspaceService.class);
    private final AiService ai = mock(AiService.class);
    private final HarnessSessionService service = new HarnessSessionService(mapper, workspace, ai);

    private void owns(long userId, long notebookId) {
        when(workspace.requireOwnedNotebook(userId, notebookId)).thenReturn(new AiNotebook());
    }

    private void notOwned(long userId, long notebookId) {
        when(workspace.requireOwnedNotebook(userId, notebookId)).thenThrow(new BusinessException("对话不存在"));
    }

    @Test
    @DisplayName("只认 app-<正整数>：别的 id 不是应用来的")
    void 认得的id() {
        assertEquals(12L, HarnessSessionService.appNotebookId("app-12"));
        for (String s : new String[]{"app-0", "app-012", "app-", "app-default", "xapp-12", "app-12x", "20261117-101010-abcd",
                "app-1234567890123456789", null}) {
            assertNull(HarnessSessionService.appNotebookId(s), s);
        }
    }

    @Test
    @DisplayName("app-<自己的对话>：绑到那个对话上，不新建")
    void 绑到原来的对话() {
        owns(1L, 12L);
        HarnessSession s = service.open(1L, "app-12", "接着说", "game");
        assertEquals(12L, s.getNotebookId());
        verify(workspace, never()).createNotebook(anyLong(), any());
    }

    @Test
    @DisplayName("app-<别人的 / 删掉的对话>：照旧新建一个，不绑过去")
    void 别人的号新建() {
        notOwned(1L, 99L);
        when(workspace.createNotebook(eq(1L), any())).thenReturn(Map.of("id", 500L));
        HarnessSession s = service.open(1L, "app-99", "x", "game");
        assertEquals(500L, s.getNotebookId(), "绑到了不属于这个用户的对话上");
    }

    @Test
    @DisplayName("并发打开同一个 app-<号> 撞上：用对方那一行，不删用户自己的对话（命令行来的 id 照旧删多建的那个）")
    void 撞上不删用户的对话() {
        owns(1L, 12L);
        HarnessSession other = new HarnessSession();
        other.setNotebookId(12L);
        when(mapper.selectOne(any())).thenReturn(null, other);
        when(mapper.insert(any(HarnessSession.class))).thenThrow(new DuplicateKeyException("dup"));
        assertEquals(12L, service.open(1L, "app-12", "x", "game").getNotebookId());
        verify(workspace, never()).deleteNotebook(anyLong(), anyLong());

        // 对照组：命令行来的 id，多建的那个照删
        HarnessSession cli = new HarnessSession();
        cli.setNotebookId(7L);
        when(mapper.selectOne(any())).thenReturn(null, cli);
        when(workspace.createNotebook(eq(1L), any())).thenReturn(Map.of("id", 501L));
        service.open(1L, "20261117-101010-abcd", "x", "game");
        verify(workspace).deleteNotebook(1L, 501L);
    }

    @Test
    @DisplayName("app-default（应用的默认对话，第一百四十六轮）：存档写进默认对话，不建「命令行 · …」、不落 harness_session")
    void 默认对话() {
        java.util.List<Map<String, Object>> msgs = java.util.List.of(Map.of("role", "user", "content", "x"));
        when(ai.appendArchivedMessages(1L, null, msgs)).thenReturn(java.util.List.of(9L));
        Map<String, Object> out = service.append(1L, "app-default", "t", "game", msgs);
        assertNull(out.get("notebookId"));
        assertEquals(java.util.List.of(9L), out.get("messageIds"));
        assertNull(service.open(1L, "app-default", "t", "game").getNotebookId());
        verify(workspace, never()).createNotebook(anyLong(), any());
        verify(mapper, never()).insert(any(HarnessSession.class));
        verify(mapper, never()).updateById(any(HarnessSession.class));
    }

    @Test
    @DisplayName("对话号 → 命令行会话的 id：只列命令行来的（app-<号> 自己绑的不列）")
    void 对话号对命令行id() {
        HarnessSession cli = new HarnessSession();
        cli.setNotebookId(7L);
        cli.setClientSessionId("20261117-101010-abcd");
        HarnessSession app = new HarnessSession();
        app.setNotebookId(12L);
        app.setClientSessionId("app-12");
        // 原来的对话被删、改挂到新对话 15 上的 app-9：要列（应用里打开 15 接的是 app-9 那份记录）
        HarnessSession moved = new HarnessSession();
        moved.setNotebookId(15L);
        moved.setClientSessionId("app-9");
        when(mapper.selectList(any())).thenReturn(java.util.List.of(cli, app, moved));
        assertEquals(Map.of(7L, "20261117-101010-abcd", 15L, "app-9"), service.clientIdsByNotebook(1L));
    }

    @Test
    @DisplayName("应用里的对话（第一百四十七轮）：默认对话有消息才列、在最前；命令行来的对话带它自己的会话 id，别的是 app-<号>")
    void 应用里的对话() {
        when(ai.getRecentChatMessages(1L, null, 1)).thenReturn(java.util.List.of(Map.of("id", 1L)));
        when(workspace.listNotebooks(1L)).thenReturn(java.util.List.of(Map.of("id", 7L, "title", "命令行来的"), Map.of("id", 12L, "title", "应用里的")));
        HarnessSession cli = new HarnessSession();
        cli.setNotebookId(7L);
        cli.setClientSessionId("20261117-101010-abcd");
        when(mapper.selectList(any())).thenReturn(java.util.List.of(cli));
        java.util.List<Map<String, Object>> rows = service.conversations(1L);
        assertEquals(java.util.List.of("app-default", "20261117-101010-abcd", "app-12"), rows.stream().map(r -> r.get("sessionId")).toList());
        assertEquals(java.util.List.of(false, true, false), rows.stream().map(r -> r.get("fromCli")).toList());
        when(ai.getRecentChatMessages(1L, null, 1)).thenReturn(java.util.List.of());
        assertEquals(2, service.conversations(1L).size(), "默认对话没有消息也列了");
    }

    @Test
    @DisplayName("一个对话的文字版：default 是默认对话、号是那个对话；带上命令行那边用的会话 id；认不出的号拒绝")
    void 对话的文字版() {
        when(ai.conversationHandoff(1L, null, 40)).thenReturn(Map.of("summary", "S", "messages", java.util.List.of()));
        when(ai.conversationHandoff(1L, 12L, 40)).thenReturn(Map.of("messages", java.util.List.of()));
        assertEquals("app-default", service.handoff(1L, "default").get("sessionId"));
        assertEquals("S", service.handoff(1L, "default").get("summary"));
        assertEquals("app-12", service.handoff(1L, "12").get("sessionId"));
        org.junit.jupiter.api.Assertions.assertThrows(BusinessException.class, () -> service.handoff(1L, "abc"));
    }
}
