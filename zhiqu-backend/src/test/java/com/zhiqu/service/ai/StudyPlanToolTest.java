package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.SourceText;
import com.zhiqu.common.BusinessClock;
import com.zhiqu.common.BusinessException;
import com.zhiqu.service.ReminderPlanService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * {@link StudyPlanTool}：搬家不改行为（金样比对），以及 schema 全仓只有一份。
 *
 * <p>金样 {@code golden/study-plan-tool.json} 是拆第六刀<b>之前</b>拍的：用反射调 {@code AiServiceImpl}
 * 里原来的 {@code buildCreateStudyPlanTools} / {@code parsePlanFromResponse} / {@code hasPlanDraft}，
 * 时钟固定在 2026-09-23、提醒服务固定返回 [7,3,1]。这里用同样的固定条件跑新类，逐项比对。
 * 比的是 JSON 树而不是字符串：任务用 HashMap 装，键的顺序本来就不固定。
 */
class StudyPlanToolTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path GOLDEN = Path.of("src/test/resources/golden/study-plan-tool.json");

    private static StudyPlanTool tool() {
        BusinessClock clock = mock(BusinessClock.class);
        when(clock.today()).thenReturn(LocalDate.of(2026, 9, 23));
        ReminderPlanService reminder = mock(ReminderPlanService.class);
        when(reminder.suggestOffsets(any(), any())).thenReturn(List.of(7, 3, 1));
        return new StudyPlanTool(clock, reminder, JSON);
    }

    @Test
    @DisplayName("金样：schema 与搬家前逐字段一致")
    void schema与金样一致() throws IOException {
        JsonNode golden = JSON.readTree(GOLDEN.toFile());
        assertEquals(golden.get("schema"), JSON.valueToTree(tool().tools()),
                "create_study_plan 的声明和搬家前不一样了 —— 模型拿到的工具变了，PLANNER 与里程碑都会受影响");
    }

    @Test
    @DisplayName("金样：每个边界输入的解析结果（或抛出的异常）与搬家前一致")
    void 解析与金样一致() throws IOException {
        JsonNode rows = JSON.readTree(GOLDEN.toFile()).get("parse");
        assertTrue(rows.size() >= 6, "金样里只有 " + rows.size() + " 条输入 —— 读空了");
        StudyPlanTool tool = tool();
        List<String> diffs = new ArrayList<>();
        for (JsonNode row : rows) {
            String input = row.get("input").asText();
            JsonNode got;
            try {
                got = JSON.createObjectNode().set("output", JSON.valueToTree(tool.parse(input)));
            } catch (RuntimeException e) {
                got = JSON.createObjectNode().put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
            }
            JsonNode want = row.has("output") ? JSON.createObjectNode().set("output", row.get("output"))
                    : JSON.createObjectNode().set("error", row.get("error"));
            if (!want.equals(got)) {
                diffs.add("输入 " + input + "\n  应为 " + want + "\n  实为 " + got);
            }
        }
        assertTrue(diffs.isEmpty(), "搬家改变了解析行为：\n" + String.join("\n", diffs));
    }

    @Test
    @DisplayName("金样：hasContent 与搬家前的 hasPlanDraft 一致")
    void 判空与金样一致() throws IOException {
        for (JsonNode row : JSON.readTree(GOLDEN.toFile()).get("hasPlanDraft")) {
            @SuppressWarnings("unchecked")
            Map<String, Object> in = row.get("input").isNull() ? null : JSON.convertValue(row.get("input"), Map.class);
            assertEquals(row.get("output").asBoolean(), StudyPlanTool.hasContent(in), "输入 " + row.get("input"));
        }
    }

    /** 给工具循环用的那一个：坏 JSON、空计划都不抛，一律 null。 */
    @Test
    @DisplayName("parseOrNull：坏 JSON 与空计划都返回 null，不抛；有内容才交出去")
    void parseOrNull不抛() {
        StudyPlanTool tool = tool();
        try {
            tool.parse("{不是json");
            fail("parse 对坏 JSON 应当抛 —— 否则 parseOrNull 这条判据测的就不是「接住异常」");
        } catch (BusinessException expected) {
            // 前提成立：parse 确实会抛
        }
        assertNull(tool.parseOrNull("{不是json"), "坏 JSON 冲出来了 —— 在工具循环里这会让整轮提前结束");
        assertNull(tool.parseOrNull("{\"tasks\":[],\"routines\":[]}"), "空计划被交了出去 —— 会产出一个没有任务的草稿");
        Map<String, Object> plan = tool.parseOrNull("{\"tasks\":[{\"title\":\"实现登录\"}]}");
        assertEquals("实现登录", ((List<?>) plan.get("tasks")).isEmpty() ? null
                : ((Map<?, ?>) ((List<?>) plan.get("tasks")).get(0)).get("title"));
    }

    /**
     * 工具名与 schema 都只许有一份。
     *
     * <p>这条第一版查的是「哪些文件声明了它」，第一次跑就报了 {@code AiServiceImpl} ——
     * 细看是误报（命中了 tool_choice 里的 {@code Map.of("name", "create_study_plan")}），
     * 但它照出了一个真问题：工具名的<b>字面量</b>散在四个文件里共 7 处。改了声明漏了别处，
     * tool_choice 强制一个不存在的工具、按名字匹配的地方永远匹配不上 —— 计划静默地产不出来。
     * 所以现在判的是最朴素的那件事：去掉注释后，这个字面量全仓只出现一次，就在 {@link StudyPlanTool#NAME}。
     */
    @Test
    @DisplayName("create_study_plan 字面量全仓只出现一次（StudyPlanTool.NAME），schema 也只在 StudyPlanTool 里")
    void 工具名与schema全仓只有一份() throws IOException {
        List<String> literal = new ArrayList<>();
        List<String> schema = new ArrayList<>();
        int scanned = 0;
        try (Stream<Path> files = Files.walk(Path.of("src/main/java"))) {
            for (Path f : (Iterable<Path>) files.filter(p -> p.toString().endsWith(".java"))::iterator) {
                scanned++;
                String code = SourceText.stripComments(Files.readString(f, StandardCharsets.UTF_8));
                for (int i = code.indexOf("\"create_study_plan\""); i >= 0; i = code.indexOf("\"create_study_plan\"", i + 1)) {
                    literal.add(f.getFileName().toString());
                }
                // schema 的特征：参数里有 tasks / routines 两个数组的描述
                if (code.contains("props.put(\"tasks\", ToolSchemas.schemaArrayOf(")) {
                    schema.add(f.getFileName().toString());
                }
            }
        }
        assertTrue(scanned > 100, "只扫到 " + scanned + " 个源文件 —— 路径不对，判据什么也没看");
        assertEquals(List.of("StudyPlanTool.java"), literal,
                "工具名字面量应当只在 StudyPlanTool.NAME 出现一次。实际出现在：" + literal);
        assertEquals(List.of("StudyPlanTool.java"), schema,
                "create_study_plan 的 schema 应当只在 StudyPlanTool 里有一份。实际：" + schema);
    }
}
