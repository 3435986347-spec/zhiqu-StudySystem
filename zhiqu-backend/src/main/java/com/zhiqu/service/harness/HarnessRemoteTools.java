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

    /** 读用户没做完的任务（第二十九轮）。和网页 AI 读到的是同一份，多带 #编号；和网页同一个开关。 */
    static final String LIST_TASKS = "list_tasks";
    /** 改一条任务的状态（第二十九轮）。用户定的：新建走草稿（create_study_plan），改状态直接做。 */
    static final String UPDATE_TASK_STATUS = "update_task_status";
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
    private final com.zhiqu.service.ai.AssistantTaskReader taskReader;
    private final com.zhiqu.service.StudyTaskService taskService;
    private final com.zhiqu.mapper.SysUserMapper users;
    private final Map<String, TimedState> wikiStates = new ConcurrentHashMap<>();

    private record TimedState(WikiToolAgent.WikiLoopState state, long touched) {
    }

    public HarnessRemoteTools(WikiToolAgent wiki, StudyPlanTool plans, LongTermMemoryStore memory,
                              AiWorkspaceService workspace, HarnessSessionService sessions, ObjectMapper json,
                              com.zhiqu.service.ai.AssistantTaskReader taskReader, com.zhiqu.service.StudyTaskService taskService,
                              com.zhiqu.mapper.SysUserMapper users) {
        this.taskReader = taskReader;
        this.taskService = taskService;
        this.users = users;
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
        out.add(ToolSchemas.functionTool(LIST_TASKS,
                "读用户没做完的任务：逾期的、今天的、接下来的、没有日期的，每条带 #编号、象限、优先级、开始 / 截止时间。"
                        + "问到今天、这周怎么安排，或者要改任务状态之前先读。",
                new LinkedHashMap<>(), List.of()));
        Map<String, Object> statusProps = new LinkedHashMap<>();
        statusProps.put("task_id", ToolSchemas.schemaProp("integer", "list_tasks 给的 #编号（只写数字）"));
        statusProps.put("status", ToolSchemas.schemaEnum("todo 待办 / doing 进行中 / done 已完成", "todo", "doing", "done"));
        out.add(ToolSchemas.functionTool(UPDATE_TASK_STATUS,
                "把一条任务标成待办 / 进行中 / 已完成。直接生效，不是草稿。新建任务用 create_study_plan（草稿，用户在网页确认）。",
                statusProps, List.of("task_id", "status")));
        out.add(ToolSchemas.functionTool(READ_MEMORY,
                "读取用户在知趣·象限里保存的长期记忆（偏好、目标、习惯）。回答涉及「我之前说过」「按我的习惯」时先读。",
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
        if (LIST_TASKS.equals(name)) {
            com.zhiqu.entity.SysUser user = users.selectById(userId);
            if (user == null || !user.aiReadsTasks()) {
                // 和网页同一个开关：用户关掉了「让 AI 读我的任务」，这里也读不到 —— 说清楚，免得模型去编
                return result(com.zhiqu.service.ai.AssistantTaskContext.DECLINED);
            }
            return result(taskReader.read(userId, true).block());
        }
        if (UPDATE_TASK_STATUS.equals(name)) {
            return updateTaskStatus(userId, args);
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

    /** 改一条任务的状态：只能改自己的（StudyTaskService.updateStatus 按用户查），编号 / 状态不对说清楚，不抛到协议层。 */
    private Map<String, Object> updateTaskStatus(Long userId, String args) {
        Map<String, Object> a = ToolSchemas.argsOf(json, args);
        Long taskId;
        try {
            taskId = Long.valueOf(String.valueOf(a.get("task_id")).replace("#", "").trim());
        } catch (NumberFormatException e) {
            return result("task_id 不对：要写 list_tasks 给的 #编号里的数字，比如 12。");
        }
        Integer status = switch (String.valueOf(a.get("status")).trim().toLowerCase(java.util.Locale.ROOT)) {
            case "todo" -> 0;
            case "doing" -> 1;
            case "done" -> 2;
            default -> null;
        };
        if (status == null) {
            return result("status 只能是 todo（待办）、doing（进行中）、done（已完成）之一。");
        }
        com.zhiqu.entity.StudyTask task;
        try {
            task = taskService.updateStatus(userId, taskId, status);
        } catch (BusinessException e) {
            return result("没有改成：" + e.getMessage() + "（编号要用 list_tasks 给的 #编号）");
        }
        String label = status == 2 ? "已完成" : status == 1 ? "进行中" : "待办";
        return result("已把 #" + taskId + "「" + com.zhiqu.service.ai.AssistantTaskContext.oneLine(task == null ? "" : task.getTitle())
                + "」标成" + label + "。");
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
