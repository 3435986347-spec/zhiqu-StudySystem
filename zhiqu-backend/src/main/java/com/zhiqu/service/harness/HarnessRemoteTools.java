package com.zhiqu.service.harness;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiAgentArtifact;
import com.zhiqu.service.AiWorkspaceService;
import com.zhiqu.service.ai.StudyPlanTool;
import com.zhiqu.service.ai.ToolSchemas;
import com.zhiqu.service.ai.WikiToolAgent;
import com.zhiqu.service.memory.LongTermMemoryStore;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 远程工具：知识 Wiki、学习计划、长期记忆。
 *
 * <p>它们是学习系统自己的能力，数据在服务器的数据库里，所以<b>在服务器上执行</b>，不装进命令行 ——
 * 命令行只从 {@link #tools()} 拿到名字和参数说明，调用时把请求转过来。
 *
 * <p>写类操作一律是草稿，与网页那一侧同一条纪律：
 * <ul>
 *   <li>{@code create_wiki_patch} → 「待合入变更」，在知识 Wiki 里确认；</li>
 *   <li>{@code create_study_plan} → TASK_DRAFT / ROUTINE_DRAFT，在 AI 助手里打开这段会话的 Notebook 确认；</li>
 *   <li>{@code propose_memory} → MEMORY_DRAFT，同上。</li>
 * </ul>
 * 没有一个远程工具能直接改库。
 *
 * <p>Wiki 的防护（未完整读取不许整页覆盖、本轮幂等）靠 {@link WikiToolAgent.WikiLoopState} 记着「这一轮读过什么」。
 * 网页里一轮就是一次请求；命令行的一段会话横跨很多次请求，所以状态按「用户 + 会话」存在这里。
 * 服务重启会丢 —— 丢了的结果是要求重新读一遍再改，是安全的那个方向。
 */
@Service
public class HarnessRemoteTools {

    static final String READ_MEMORY = "read_memory";
    static final String PROPOSE_MEMORY = "propose_memory";
    static final int MAX_MEMORY_ITEMS = 20;
    static final int MAX_MEMORY_ITEM_CHARS = 200;
    private static final long STATE_TTL_MS = 6 * 3600_000L;

    private final WikiToolAgent wiki;
    private final StudyPlanTool plans;
    private final LongTermMemoryStore memory;
    private final AiWorkspaceService workspace;
    private final HarnessSessionService sessions;
    private final ObjectMapper json;
    private final Map<String, TimedState> wikiStates = new ConcurrentHashMap<>();

    private record TimedState(WikiToolAgent.WikiLoopState state, long touched) {
    }

    public HarnessRemoteTools(WikiToolAgent wiki, StudyPlanTool plans, LongTermMemoryStore memory,
                              AiWorkspaceService workspace, HarnessSessionService sessions, ObjectMapper json) {
        this.wiki = wiki;
        this.plans = plans;
        this.memory = memory;
        this.workspace = workspace;
        this.sessions = sessions;
        this.json = json;
    }

    public List<Map<String, Object>> tools() {
        List<Map<String, Object>> out = new ArrayList<>(wiki.buildWikiTools(true));
        out.addAll(plans.tools());
        out.add(ToolSchemas.functionTool(READ_MEMORY,
                "读取用户在学习系统里保存的长期记忆（偏好、目标、习惯）。回答涉及「我之前说过」「按我的习惯」时先读。",
                new LinkedHashMap<>(), List.of()));
        Map<String, Object> memoryProps = new LinkedHashMap<>();
        memoryProps.put("items", ToolSchemas.schemaArray("string",
                "要记住的条目，每条一句话、独立成立（如「偏好用 Python 做算法题」）"));
        out.add(ToolSchemas.functionTool(PROPOSE_MEMORY,
                "把值得长期记住的事实提议写进长期记忆。只会生成草稿，用户在网页确认后才写入；不要记一次性的细节。",
                memoryProps, List.of("items")));
        return out;
    }

    public Map<String, Object> call(Long userId, String clientSessionId, String name, Object arguments) {
        HarnessSessionService.requireClientId(clientSessionId);
        String args = argumentsJson(arguments);
        if (WikiToolAgent.TOOL_NAMES.contains(name)) {
            WikiToolAgent.WikiToolExecution exec = wiki.executeWikiTool(userId, name, args, wikiState(userId, clientSessionId));
            Map<String, Object> out = result(exec.result);
            if (exec.wrotePatch) {
                out.put("drafts", List.of(Map.of("type", "WIKI_PATCH", "title", "知识 Wiki 待合入变更",
                        "where", "网页「知识 Wiki」→ 待合入变更")));
            }
            return out;
        }
        if (StudyPlanTool.NAME.equals(name)) {
            return studyPlan(userId, clientSessionId, args);
        }
        if (READ_MEMORY.equals(name)) {
            String text = memory.read(userId);
            return result(text == null || text.isBlank() ? "（用户还没有保存任何长期记忆）"
                    : text.length() > 4000 ? text.substring(0, 4000) + "\n…（已截断）" : text);
        }
        if (PROPOSE_MEMORY.equals(name)) {
            return proposeMemory(userId, clientSessionId, args);
        }
        throw new BusinessException("没有这个远程工具：" + name);
    }

    private String argumentsJson(Object arguments) {
        if (arguments == null) return "{}";
        if (arguments instanceof String s) return s.isBlank() ? "{}" : s;
        try {
            return json.writeValueAsString(arguments);
        } catch (Exception e) {
            throw new BusinessException("参数不是合法的 JSON");
        }
    }

    private WikiToolAgent.WikiLoopState wikiState(Long userId, String clientSessionId) {
        long now = System.currentTimeMillis();
        wikiStates.entrySet().removeIf(e -> now - e.getValue().touched() > STATE_TTL_MS);
        String key = userId + ":" + clientSessionId;
        TimedState timed = wikiStates.compute(key, (k, v) ->
                new TimedState(v == null ? new WikiToolAgent.WikiLoopState() : v.state(), now));
        return timed.state();
    }

    int trackedWikiStates() {
        return wikiStates.size();
    }

    private static Map<String, Object> result(String content) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("content", content == null ? "" : content);
        return out;
    }

    private Map<String, Object> studyPlan(Long userId, String clientSessionId, String args) {
        Map<String, Object> plan = plans.parseOrNull(args);
        if (plan == null) {
            return result("参数不对：没有解析出任何任务或例行计划。请按 create_study_plan 的参数格式重新给出 tasks / routines。");
        }
        Long runId = sessions.draftRun(userId, clientSessionId);
        List<Map<String, Object>> drafts = new ArrayList<>();
        int tasks = plan.get("tasks") instanceof List<?> t ? t.size() : 0;
        int routines = plan.get("routines") instanceof List<?> r ? r.size() : 0;
        if (tasks > 0) {
            AiAgentArtifact a = workspace.createArtifact(runId, null, "TASK_DRAFT", "AI 任务草稿",
                    Map.of("tasks", plan.get("tasks")), null);
            drafts.add(draftRow(a));
        }
        if (routines > 0) {
            AiAgentArtifact a = workspace.createArtifact(runId, null, "ROUTINE_DRAFT", "AI 例行计划草稿",
                    Map.of("routines", plan.get("routines")), null);
            drafts.add(draftRow(a));
        }
        Map<String, Object> out = result("已生成计划草稿：" + tasks + " 个任务、" + routines + " 个例行计划。"
                + "还没有写进日历 —— 用户要在网页「AI 助手」里打开这段会话的 Notebook，确认后才会落库。"
                + "请如实告诉用户这一点，不要说已经加进日历。");
        out.put("drafts", drafts);
        return out;
    }

    private Map<String, Object> proposeMemory(Long userId, String clientSessionId, String args) {
        List<String> items = new ArrayList<>();
        try {
            Object raw = json.readValue(args, Map.class).get("items");
            if (raw instanceof List<?> list) {
                for (Object o : list) {
                    String s = o == null ? "" : String.valueOf(o).replaceAll("\\s+", " ").trim();
                    if (!s.isEmpty()) items.add(s.length() > MAX_MEMORY_ITEM_CHARS ? s.substring(0, MAX_MEMORY_ITEM_CHARS) : s);
                }
            }
        } catch (Exception e) {
            return result("参数不对：items 应当是字符串数组");
        }
        if (items.isEmpty()) {
            return result("参数不对：items 为空，没有要记住的内容");
        }
        if (items.size() > MAX_MEMORY_ITEMS) {
            items = items.subList(0, MAX_MEMORY_ITEMS);
        }
        List<Map<String, Object>> rows = new ArrayList<>();
        for (String item : items) rows.add(Map.of("text", item));
        Long runId = sessions.draftRun(userId, clientSessionId);
        AiAgentArtifact a = workspace.createArtifact(runId, null, "MEMORY_DRAFT", "AI 记忆草稿", Map.of("items", rows), null);
        Map<String, Object> out = result("已生成记忆草稿（" + rows.size() + " 条）。还没有写入长期记忆 —— 用户在网页确认后才会写入。");
        out.put("drafts", List.of(draftRow(a)));
        return out;
    }

    private static Map<String, Object> draftRow(AiAgentArtifact a) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", a.getId());
        row.put("type", a.getArtifactType());
        row.put("title", a.getTitle());
        row.put("where", "网页「AI 助手」→ 这段会话的 Notebook → 执行面板");
        return row;
    }
}
