package com.zhiqu.service.harness;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiAgentRun;
import com.zhiqu.entity.HarnessSession;
import com.zhiqu.mapper.HarnessSessionMapper;
import com.zhiqu.service.AiService;
import com.zhiqu.service.AiWorkspaceService;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 命令行会话的存档：一段命令行会话在网页里就是一个 Notebook。
 *
 * <p>为什么是「一段会话一个 Notebook」而不是都塞进一个「命令行」Notebook：网页的会话是按 Notebook 分的，
 * 几段命令行会话挤在同一个会话里会交错在一起，看不出哪句是哪次的。一个 Notebook 一段，打开就是完整的一次。
 *
 * <p>完整记录（含每次工具调用）在用户自己电脑上的 {@code .zhiqu/sessions/<id>.jsonl}，那是 {@code /resume} 用的；
 * 这里存的是给人在网页里看的那一份：人说了什么、助手回了什么、中间做了哪些事。
 *
 * <p>远程工具产出的草稿（计划、记忆）挂在这个会话自己的一轮 {@code ai_agent_run} 上 ——
 * 网页打开这个 Notebook 时，执行面板读的就是它最新的一轮，草稿在那里确认。
 */
@Service
public class HarnessSessionService {

    private static final Pattern CLIENT_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    /** 应用里发起的会话（第一百四十五轮）：桌面应用的本机代码助手用 app-<Notebook 号> 当会话记录的 id */
    private static final Pattern APP_ID = Pattern.compile("app-([1-9][0-9]{0,17})");

    private final HarnessSessionMapper mapper;
    private final AiWorkspaceService workspace;
    private final AiService aiService;

    public HarnessSessionService(HarnessSessionMapper mapper, AiWorkspaceService workspace, AiService aiService) {
        this.mapper = mapper;
        this.workspace = workspace;
        this.aiService = aiService;
    }

    static String requireClientId(String clientSessionId) {
        if (clientSessionId == null || !CLIENT_ID.matcher(clientSessionId).matches()) {
            throw new BusinessException("会话 id 格式不对");
        }
        return clientSessionId;
    }

    static String notebookTitle(String workspaceName, String title) {
        String ws = workspaceName == null || workspaceName.isBlank() ? "" : workspaceName.trim();
        String t = title == null ? "" : title.replaceAll("\\s+", " ").trim();
        if (t.length() > 40) {
            t = t.substring(0, 40) + "…";
        }
        String out = "命令行" + (ws.isEmpty() ? "" : " · " + ws) + (t.isEmpty() ? "" : " · " + t);
        return out.length() > 120 ? out.substring(0, 120) : out;
    }

    /** 应用里的「默认对话」（不是 Notebook）：会话记录 id 是 app-default，存档直接写进默认对话，不建 harness_session 那一行（那一列不许空） */
    static final String APP_DEFAULT = "app-default";

    /** app-<号> 里的 Notebook 号；不是这种 id 返回 null */
    static Long appNotebookId(String clientSessionId) {
        java.util.regex.Matcher m = clientSessionId == null ? null : APP_ID.matcher(clientSessionId);
        return m != null && m.matches() ? Long.valueOf(m.group(1)) : null;
    }

    private HarnessSession find(Long userId, String clientSessionId) {
        return mapper.selectOne(new LambdaQueryWrapper<HarnessSession>()
                .eq(HarnessSession::getUserId, userId)
                .eq(HarnessSession::getClientSessionId, clientSessionId));
    }

    private boolean notebookAlive(Long userId, Long notebookId) {
        try {
            workspace.requireOwnedNotebook(userId, notebookId);
            return true;
        } catch (BusinessException e) {
            return false;
        }
    }

    private Long newNotebook(Long userId, String clientSessionId, String workspaceName, String title) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", notebookTitle(workspaceName, title));
        body.put("description", "命令行会话 " + clientSessionId + " 的存档（完整记录在工作区的 .zhiqu/sessions/ 里）");
        Object id = workspace.createNotebook(userId, body).get("id");
        return ((Number) id).longValue();
    }

    /** 打开（没有就建）一段会话。同一个 id 重复打开是幂等的；用户在网页里删了那个 Notebook 就再建一个。 */
    public HarnessSession open(Long userId, String clientSessionId, String title, String workspaceName) {
        requireClientId(clientSessionId);
        if (APP_DEFAULT.equals(clientSessionId)) {
            // 默认对话：不落 harness_session（notebook_id 不许空），给一个只在内存里的
            HarnessSession s = new HarnessSession();
            s.setUserId(userId);
            s.setClientSessionId(clientSessionId);
            return s;
        }
        HarnessSession session = find(userId, clientSessionId);
        if (session != null) {
            if (!notebookAlive(userId, session.getNotebookId())) {
                session.setNotebookId(newNotebook(userId, clientSessionId, session.getWorkspaceName(), session.getTitle()));
                session.setAgentRunId(null);
                session.setUpdatedAt(LocalDateTime.now());
                mapper.updateById(session);
            }
            return session;
        }
        session = new HarnessSession();
        session.setUserId(userId);
        session.setClientSessionId(clientSessionId);
        session.setTitle(title == null ? null : title.length() > 200 ? title.substring(0, 200) : title);
        session.setWorkspaceName(workspaceName == null ? null : workspaceName.length() > 200 ? workspaceName.substring(0, 200) : workspaceName);
        // 应用里发起的会话在命令行里接着说（第一百四十五轮）：存档回到原来那个对话，不另建「命令行 · …」。
        // 只认这个用户自己的、还在的 Notebook —— 别人的号照旧新建一个，不串、也不说那个号存不存在
        Long app = appNotebookId(clientSessionId);
        boolean bound = app != null && notebookAlive(userId, app);
        session.setNotebookId(bound ? app : newNotebook(userId, clientSessionId, workspaceName, title));
        session.setCreatedAt(LocalDateTime.now());
        session.setUpdatedAt(LocalDateTime.now());
        try {
            mapper.insert(session);
            return session;
        } catch (DuplicateKeyException e) {
            // 并发打开同一个 id：另一个请求先插进去了。多建的那个 Notebook 删掉，用对方的 ——
            // 绑上的是用户自己原来的对话，不是这里建的，不能删
            if (!bound) {
                workspace.deleteNotebook(userId, session.getNotebookId());
            }
            return find(userId, clientSessionId);
        }
    }

    public Map<String, Object> append(Long userId, String clientSessionId, List<Map<String, Object>> messages) {
        return append(userId, clientSessionId, null, null, messages);
    }

    /** 同上；会话还不存在时用给的标题和工作区名建。 */
    public Map<String, Object> append(Long userId, String clientSessionId, String title, String workspaceName,
                                      List<Map<String, Object>> messages) {
        HarnessSession session = open(userId, clientSessionId, title, workspaceName);
        // 默认对话（app-default）的 notebookId 是 null：写进默认对话；它没有 harness_session 那一行，不写库
        List<Long> ids = aiService.appendArchivedMessages(userId, session.getNotebookId(), messages);
        session.setUpdatedAt(LocalDateTime.now());
        if (session.getId() != null) {
            mapper.updateById(session);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("notebookId", session.getNotebookId());
        out.put("messageIds", ids);
        return out;
    }

    /** 这段会话用来挂草稿的那一轮；没有就开一轮。它一开就是 DONE：草稿的确认不看轮次状态。 */
    public Long draftRun(Long userId, String clientSessionId) {
        HarnessSession session = open(userId, clientSessionId, null, null);
        if (session.getAgentRunId() != null) {
            return session.getAgentRunId();
        }
        AiAgentRun run = workspace.beginRun(userId, session.getNotebookId(), "AUTO",
                Map.of("source", "harness", "clientSessionId", clientSessionId), null, null);
        workspace.completeRun(run, null);
        session.setAgentRunId(run.getId());
        session.setUpdatedAt(LocalDateTime.now());
        // 默认对话没有那一行，记不住「哪一轮挂草稿」：每次开一轮（网页的执行面板看的是最新的一轮）
        if (session.getId() != null) {
            mapper.updateById(session);
        }
        return run.getId();
    }

    public HarnessSession describe(Long userId, String clientSessionId) {
        return open(userId, clientSessionId, null, null);
    }

    /**
     * 对话号 → 命令行会话的 id（第一百四十六轮）：应用里打开一个「命令行 · …」的对话接着说，
     * 本机代码助手用的是那段命令行会话自己的记录，不另起一份 app-<号>。app-<号> 绑在自己那个号上的不列（页面本来就这么叫它）。
     */
    public Map<Long, String> clientIdsByNotebook(Long userId) {
        Map<Long, String> out = new LinkedHashMap<>();
        for (HarnessSession s : mapper.selectList(new LambdaQueryWrapper<HarnessSession>()
                .eq(HarnessSession::getUserId, userId)
                .orderByAsc(HarnessSession::getUpdatedAt))) {
            // app-<号> 绑在它自己那个号上的不列（页面本来就这么叫它）；原来的对话被删、改挂到新对话上的要列 ——
            // 不然应用里打开那个新对话会另起一份 app-<新号>，接不上原来那份记录（第一百四十八轮在本机后端上撞到的）
            if (s.getNotebookId() != null && !s.getNotebookId().equals(appNotebookId(s.getClientSessionId()))) {
                out.put(s.getNotebookId(), s.getClientSessionId());
            }
        }
        return out;
    }

    /**
     * 应用里的对话，给命令行 /resume 的第二段（第一百四十七轮）：最近的对话（含默认对话，有消息才列），
     * 每个带上命令行那边用的会话 id（命令行来的是它自己的，别的是 app-<号> / app-default），命令行据此认出「这个文件夹里已经有了」。
     */
    public List<Map<String, Object>> conversations(Long userId) {
        Map<Long, String> cli = clientIdsByNotebook(userId);
        List<Map<String, Object>> out = new ArrayList<>();
        if (!aiService.getRecentChatMessages(userId, null, 1).isEmpty()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", "default");
            row.put("sessionId", APP_DEFAULT);
            row.put("title", "默认对话");
            row.put("fromCli", false);
            out.add(row);
        }
        for (Map<String, Object> nb : workspace.listNotebooks(userId)) {
            if (out.size() >= 50) {
                break;
            }
            Long id = nb.get("id") instanceof Number n ? n.longValue() : null;
            if (id == null) {
                continue;
            }
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", id);
            row.put("sessionId", cli.getOrDefault(id, "app-" + id));
            row.put("title", nb.get("title"));
            row.put("updatedAt", nb.get("updatedAt"));
            row.put("fromCli", cli.containsKey(id));
            out.add(row);
        }
        return out;
    }

    /** 一个对话的文字版（摘要 + 最近的问答），id 是对话号或 default */
    public Map<String, Object> handoff(Long userId, String id) {
        Long notebookId;
        if ("default".equals(id)) {
            notebookId = null;
        } else {
            try {
                notebookId = Long.valueOf(id);
            } catch (NumberFormatException e) {
                throw new BusinessException("对话号不对");
            }
        }
        Map<String, Object> out = new LinkedHashMap<>(aiService.conversationHandoff(userId, notebookId, 40));
        String sessionId = notebookId == null ? APP_DEFAULT : clientIdsByNotebook(userId).getOrDefault(notebookId, "app-" + notebookId);
        out.put("sessionId", sessionId);
        return out;
    }

    public List<Map<String, Object>> list(Long userId) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (HarnessSession s : mapper.selectList(new LambdaQueryWrapper<HarnessSession>()
                .eq(HarnessSession::getUserId, userId)
                .orderByDesc(HarnessSession::getUpdatedAt)
                .last("LIMIT 100"))) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("clientSessionId", s.getClientSessionId());
            row.put("notebookId", s.getNotebookId());
            row.put("title", s.getTitle());
            row.put("workspaceName", s.getWorkspaceName());
            row.put("updatedAt", s.getUpdatedAt());
            out.add(row);
        }
        return out;
    }
}
