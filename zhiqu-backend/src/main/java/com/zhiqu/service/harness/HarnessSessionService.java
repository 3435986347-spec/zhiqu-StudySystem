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
        session.setNotebookId(newNotebook(userId, clientSessionId, workspaceName, title));
        session.setCreatedAt(LocalDateTime.now());
        session.setUpdatedAt(LocalDateTime.now());
        try {
            mapper.insert(session);
            return session;
        } catch (DuplicateKeyException e) {
            // 并发打开同一个 id：另一个请求先插进去了。多建的那个 Notebook 删掉，用对方的
            workspace.deleteNotebook(userId, session.getNotebookId());
            return find(userId, clientSessionId);
        }
    }

    public Map<String, Object> append(Long userId, String clientSessionId, List<Map<String, Object>> messages) {
        HarnessSession session = open(userId, clientSessionId, null, null);
        List<Long> ids = aiService.appendArchivedMessages(userId, session.getNotebookId(), messages);
        session.setUpdatedAt(LocalDateTime.now());
        mapper.updateById(session);
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
        mapper.updateById(session);
        return run.getId();
    }

    public HarnessSession describe(Long userId, String clientSessionId) {
        return open(userId, clientSessionId, null, null);
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
