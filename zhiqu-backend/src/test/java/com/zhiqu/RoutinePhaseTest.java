package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 例行计划列表分得清没开始 / 进行中 / 已结束（第十四轮）。原来一律「进行中」、都给「标记完成」：已经结束的点了只会报
 * 「该日期不在例行计划范围内」；标题旁那句「5 个进行中」是设计稿写死的，从来不变。
 */
class RoutinePhaseTest {

    @Test
    @DisplayName("routinePhase：区间两端都算进行中、跨年、没有结束日期；freqLabel：每天 / 每周一、三、五")
    void 分段() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/routine-phase-check.js"), NodeRunner.API_JS);
    }

    @Test
    @DisplayName("列表：只给进行中的「标记完成」，「N 个进行中」按真实数目写")
    void 列表按分段画() throws Exception {
        String code = SourceText.stripComments(Files.readString(Path.of("src/main/resources/static/assets/zhiqu-api.js")));
        int a = code.indexOf("async function loadRoutines()");
        int b = code.indexOf("\n  async function ", a + 10);
        assertTrue(a >= 0 && b > a, "找不到 loadRoutines");
        String body = code.substring(a, b);
        assertTrue(body.contains("var check = phase === 'active' ? '<button data-check-routine="), "「标记完成」要只给进行中的例行计划");
        assertTrue(!body.replace("var check = phase === 'active' ? '<button data-check-routine=", "").contains("<button data-check-routine="),
                "列表里另有一处不看分段就画「标记完成」");
        assertTrue(body.contains("countEl.textContent = active + ' 个进行中'"), "「N 个进行中」要按真实数目写");
    }

    @Test
    @DisplayName("周期只经 freqLabel 显示：例行计划列表、参考计划里的例行计划、AI 草稿，三处都不再露出 DAILY / WEEKLY（第十九轮）")
    void 周期显示成中文() throws Exception {
        String code = SourceText.stripComments(Files.readString(Path.of("src/main/resources/static/assets/zhiqu-api.js")));
        java.util.regex.Matcher raw = java.util.regex.Pattern.compile(
                "\\(\\s*\\w+\\.frequency\\s*\\|\\|\\s*'DAILY'\\s*\\)|String\\(\\s*\\w+\\.frequency\\s*\\)").matcher(code);
        boolean found = raw.find();
        assertTrue(!found, "还有地方把周期原样显示：" + (found ? raw.group() : ""));
        int calls = 0;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("freqLabel\\(\\w+\\.frequency, \\w+\\.daysOfWeek\\)").matcher(code);
        while (m.find()) calls++;
        assertTrue(calls >= 3, "只扫到 " + calls + " 处 freqLabel(…frequency, …daysOfWeek) —— 列表、参考计划、AI 草稿三处都该用它");
    }
}
