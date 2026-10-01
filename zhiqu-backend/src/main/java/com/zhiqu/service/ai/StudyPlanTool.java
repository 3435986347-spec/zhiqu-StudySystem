package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessClock;
import com.zhiqu.common.BusinessException;
import com.zhiqu.service.ReminderPlanService;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code create_study_plan} 这个工具：它的声明，以及怎么读懂模型交回来的 {@code {tasks, routines}}。
 *
 * <p>拆 {@code AiServiceImpl} 的第六刀。PLANNER（聊天里「帮我制定计划」）和 code agent（项目式引导的
 * 里程碑）都用它 —— 而且<b>必须</b>是同一份：字段形状另猜一套的话，确认落库时会静默丢掉象限、时长、
 * 截止日期，任务照样建出来，没人会发现。它在大类里时，code agent 只能经一个接缝
 * （{@code MilestonePlanning}）借用它；有了自己的家，那个接缝就成了多余的一层，已删。
 *
 * <p>搬家不改行为，这一点是<b>验证过</b>的：搬之前用反射调大类里原来的私有方法，把 schema 与一组
 * 边界输入的解析结果拍成金样（{@code src/test/resources/golden/study-plan-tool.json}），
 * {@code StudyPlanToolTest} 拿这个类的输出逐项比对。
 */
@Component
public class StudyPlanTool {

    /**
     * 工具名 —— <b>唯一定义</b>。PLANNER 的 tool_choice、按名字取回工具调用、code agent 的分派、
     * 步骤叙述都引用它。它原来在四个文件里各写了一份字面量（共 7 处）：改了这里的声明而漏了那几处，
     * tool_choice 会强制一个不存在的工具，按名字匹配的地方永远匹配不上 —— 计划静默地产不出来。
     */
    public static final String NAME = "create_study_plan";

    private final BusinessClock clock;
    private final ReminderPlanService reminderPlanService;
    private final ObjectMapper objectMapper;

    public StudyPlanTool(BusinessClock clock, ReminderPlanService reminderPlanService, ObjectMapper objectMapper) {
        this.clock = clock;
        this.reminderPlanService = reminderPlanService;
        this.objectMapper = objectMapper;
    }

    /**
     * 解析，但解析不出<b>有内容的</b>计划时返回 {@code null}，不抛。
     *
     * <p>给工具循环用：{@link #parse} 对坏 JSON 抛异常，在循环里那会让整轮提前结束，
     * 模型连改参数重试的机会都没有。循环要的是「告诉模型参数不对」。
     */
    public Map<String, Object> parseOrNull(String argsJson) {
        try {
            Map<String, Object> plan = parse(argsJson);
            return hasContent(plan) ? plan : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    public List<Map<String, Object>> tools() {
        Map<String, Object> taskProps = new LinkedHashMap<>();
        taskProps.put("title", ToolSchemas.schemaProp("string", "任务标题，简洁明确"));
        taskProps.put("description", ToolSchemas.schemaProp("string", "任务说明，含背景/范围/验收标准"));
        taskProps.put("startTime", ToolSchemas.schemaProp("string", "YYYY-MM-DD HH:mm:ss 开始时间，无法确定则省略"));
        taskProps.put("deadline", ToolSchemas.schemaProp("string", "YYYY-MM-DD HH:mm:ss 截止时间，无法确定则省略"));
        taskProps.put("durationMinutes", ToolSchemas.schemaProp("integer", "预计时长（分钟）"));
        taskProps.put("taskType", ToolSchemas.schemaProp("string", "assignment/exam/report/presentation/course/activity/other 中最接近的一类"));
        taskProps.put("difficulty", ToolSchemas.schemaProp("integer", "1..5，1很简单 5很复杂"));
        taskProps.put("suggestedReminderOffsets", ToolSchemas.schemaArray("integer", "提前提醒天数，如 [7,4,2]；无 deadline 则为空数组"));
        taskProps.put("reminderReason", ToolSchemas.schemaProp("string", "提醒节奏的一句话理由"));
        taskProps.put("priority", ToolSchemas.schemaProp("integer", "0低 1中 2高"));
        taskProps.put("suggestedQuadrant", ToolSchemas.schemaProp("integer", "1重要且紧急 2重要不紧急 3紧急不重要 4不重要不紧急"));
        taskProps.put("reason", ToolSchemas.schemaProp("string", "象限建议的一句话理由"));
        Map<String, Object> taskItem = new LinkedHashMap<>();
        taskItem.put("type", "object");
        taskItem.put("properties", taskProps);
        taskItem.put("required", List.of("title"));

        Map<String, Object> routineProps = new LinkedHashMap<>();
        routineProps.put("title", ToolSchemas.schemaProp("string", "例行计划标题，如 每天背单词"));
        routineProps.put("description", ToolSchemas.schemaProp("string", "例行计划说明"));
        routineProps.put("frequency", ToolSchemas.schemaEnum("重复频率", "DAILY", "WEEKLY"));
        routineProps.put("daysOfWeek", ToolSchemas.schemaArray("integer", "周一=1..周日=7；DAILY 可为空数组"));
        routineProps.put("startDate", ToolSchemas.schemaProp("string", "YYYY-MM-DD"));
        routineProps.put("endDate", ToolSchemas.schemaProp("string", "YYYY-MM-DD，无法确定则用今天起 30 天后"));
        routineProps.put("preferredTime", ToolSchemas.schemaProp("string", "HH:mm，无法确定则省略"));
        routineProps.put("durationMinutes", ToolSchemas.schemaProp("integer", "预计时长（分钟）"));
        routineProps.put("taskType", ToolSchemas.schemaProp("string", "assignment/exam/report/presentation/course/activity/other"));
        routineProps.put("difficulty", ToolSchemas.schemaProp("integer", "1..5"));
        routineProps.put("priority", ToolSchemas.schemaProp("integer", "0低 1中 2高"));
        routineProps.put("suggestedQuadrant", ToolSchemas.schemaProp("integer", "1..4"));
        routineProps.put("reminderEnabled", ToolSchemas.schemaProp("boolean", "是否开启提醒"));
        routineProps.put("reminderOffsets", ToolSchemas.schemaArray("integer", "提醒偏移，通常 [0]"));
        routineProps.put("reminderReason", ToolSchemas.schemaProp("string", "为何适合做成例行计划"));
        Map<String, Object> routineItem = new LinkedHashMap<>();
        routineItem.put("type", "object");
        routineItem.put("properties", routineProps);
        routineItem.put("required", List.of("title", "frequency"));

        Map<String, Object> props = new LinkedHashMap<>();
        props.put("tasks", ToolSchemas.schemaArrayOf(taskItem, "一次性任务/里程碑：有明确 DDL 或阶段交付物的项目"));
        props.put("routines", ToolSchemas.schemaArrayOf(routineItem, "每天/每周重复执行的例行计划，不要展开成大量 tasks"));
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("type", "object");
        params.put("properties", props);
        params.put("required", List.of("tasks", "routines"));

        Map<String, Object> function = new LinkedHashMap<>();
        function.put("name", NAME);
        function.put("description", "把用户认可的学习计划拆解为可写入知趣系统的一次性任务(tasks)和例行计划(routines)，"
                + "生成草稿供用户确认后落库。当用户希望把计划写进系统时调用；没有可落地项时两个数组都传空。");
        function.put("parameters", params);

        Map<String, Object> tool = new LinkedHashMap<>();
        tool.put("type", "function");
        tool.put("function", function);
        return List.of(tool);
    }

    public Map<String, Object> parse(String aiResponse) {
        try {
            JsonNode root = objectMapper.readTree(extractJsonObject(aiResponse));
            Map<String, Object> plan = new HashMap<>();
            plan.put("tasks", parseTasks(root.get("tasks")));
            plan.put("routines", parseRoutines(root.get("routines")));
            return plan;
        } catch (Exception e) {
            throw new BusinessException("AI 计划格式解析失败，请重试");
        }
    }

    public List<Map<String, Object>> parseTasks(JsonNode array) {
        try {
            List<Map<String, Object>> tasks = new ArrayList<>();
            if (array == null || !array.isArray()) {
                return tasks;
            }
            for (JsonNode node : array) {
                Map<String, Object> task = new HashMap<>();
                task.put("title", node.has("title") ? node.get("title").asText() : "");
                task.put("description", node.has("description") ? node.get("description").asText() : "");
                task.put("startTime", node.has("startTime") && !node.get("startTime").isNull()
                        ? node.get("startTime").asText() : null);
                task.put("deadline", node.has("deadline") && !node.get("deadline").isNull()
                        ? node.get("deadline").asText() : null);
                task.put("durationMinutes", node.has("durationMinutes") && !node.get("durationMinutes").isNull()
                        ? node.get("durationMinutes").asInt() : null);
                task.put("repeatWeeks", node.has("repeatWeeks") && !node.get("repeatWeeks").isNull()
                        ? node.get("repeatWeeks").asInt() : null);
                String taskType = node.has("taskType") && !node.get("taskType").isNull()
                        ? node.get("taskType").asText() : "other";
                Integer difficulty = node.has("difficulty") && !node.get("difficulty").isNull()
                        ? node.get("difficulty").asInt(3) : 3;
                task.put("taskType", taskType);
                task.put("difficulty", Math.max(1, Math.min(5, difficulty)));
                List<Integer> offsets = parseOffsets(node.get("suggestedReminderOffsets"));
                if (offsets.isEmpty() && task.get("deadline") != null) {
                    offsets = reminderPlanService.suggestOffsets(taskType, difficulty);
                }
                task.put("suggestedReminderOffsets", offsets);
                task.put("reminderReason", node.has("reminderReason") ? node.get("reminderReason").asText() : "");
                task.put("priority", node.has("priority") ? node.get("priority").asInt(0) : 0);
                task.put("suggestedQuadrant", node.has("suggestedQuadrant")
                        ? node.get("suggestedQuadrant").asInt(2) : 2);
                task.put("reason", node.has("reason") ? node.get("reason").asText() : "");
                tasks.add(task);
            }
            return tasks;
        } catch (Exception e) {
            throw new BusinessException("AI 返回格式解析失败，请重试");
        }
    }

    private List<Map<String, Object>> parseRoutines(JsonNode array) {
        List<Map<String, Object>> routines = new ArrayList<>();
        if (array == null || !array.isArray()) {
            return routines;
        }
        LocalDate today = clock.today();
        for (JsonNode node : array) {
            Map<String, Object> routine = new HashMap<>();
            routine.put("title", node.has("title") ? node.get("title").asText() : "");
            routine.put("description", node.has("description") ? node.get("description").asText() : "");
            routine.put("frequency", node.has("frequency") ? node.get("frequency").asText("DAILY") : "DAILY");
            routine.put("daysOfWeek", parseIntArray(node.get("daysOfWeek")));
            routine.put("startDate", node.has("startDate") && !node.get("startDate").isNull()
                    ? node.get("startDate").asText() : today.toString());
            routine.put("endDate", node.has("endDate") && !node.get("endDate").isNull()
                    ? node.get("endDate").asText() : today.plusDays(29).toString());
            routine.put("preferredTime", node.has("preferredTime") && !node.get("preferredTime").isNull()
                    ? node.get("preferredTime").asText() : null);
            routine.put("durationMinutes", node.has("durationMinutes") && !node.get("durationMinutes").isNull()
                    ? node.get("durationMinutes").asInt() : null);
            routine.put("taskType", node.has("taskType") ? node.get("taskType").asText("other") : "other");
            int difficulty = node.has("difficulty") ? node.get("difficulty").asInt(3) : 3;
            routine.put("difficulty", Math.max(1, Math.min(5, difficulty)));
            routine.put("priority", node.has("priority") ? node.get("priority").asInt(1) : 1);
            routine.put("suggestedQuadrant", node.has("suggestedQuadrant")
                    ? node.get("suggestedQuadrant").asInt(2) : 2);
            routine.put("quadrant", routine.get("suggestedQuadrant"));
            routine.put("reminderEnabled", !node.has("reminderEnabled") || node.get("reminderEnabled").asBoolean(true));
            List<Integer> offsets = parseOffsets(node.get("reminderOffsets"));
            routine.put("reminderOffsets", offsets.isEmpty() ? List.of(0) : offsets);
            routine.put("reminderReason", node.has("reminderReason") ? node.get("reminderReason").asText() : "");
            routines.add(routine);
        }
        return routines;
    }

    private static List<Integer> parseIntArray(JsonNode node) {
        List<Integer> result = new ArrayList<>();
        if (node == null || !node.isArray()) {
            return result;
        }
        for (JsonNode item : node) {
            if (item.isNumber()) {
                result.add(item.asInt());
            }
        }
        return result;
    }

    private static List<Integer> parseOffsets(JsonNode node) {
        List<Integer> offsets = new ArrayList<>();
        if (node == null || !node.isArray()) {
            return offsets;
        }
        for (JsonNode item : node) {
            if (!item.isNumber()) {
                continue;
            }
            int offset = item.asInt();
            if (offset >= 0 && offset <= 365 && !offsets.contains(offset)) {
                offsets.add(offset);
            }
        }
        offsets.sort(Comparator.reverseOrder());
        return offsets;
    }

    private static String extractJsonObject(String text) {
        int start = text.indexOf('{');
        int end = text.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return text.substring(start, end + 1);
        }
        throw new RuntimeException("未找到 JSON 对象");
    }

    public static boolean hasContent(Map<String, Object> planArtifactContent) {
        if (planArtifactContent == null) {
            return false;
        }
        Object tasks = planArtifactContent.get("tasks");
        Object routines = planArtifactContent.get("routines");
        return (tasks instanceof List<?> taskList && !taskList.isEmpty())
                || (routines instanceof List<?> routineList && !routineList.isEmpty());
    }
}
