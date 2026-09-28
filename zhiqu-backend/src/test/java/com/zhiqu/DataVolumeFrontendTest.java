package com.zhiqu;

import com.zhiqu.dto.StudyStatisticsVO;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 用了很久的账号（第十七轮）：页面不许为了显示几十条把全部任务 / 记录取回来。
 * 原来任务页、例行计划页、统计页、看板、提交参考计划各自 GET /task/list 取全部（三千条任务 1.6MB，任务页画出四万多个节点）。
 */
class DataVolumeFrontendTest {

    private static String api() throws Exception {
        return SourceText.stripComments(Files.readString(Path.of("src/main/resources/static/assets/zhiqu-api.js")));
    }

    private static String body(String code, String signature) {
        int a = code.indexOf(signature);
        assertTrue(a >= 0, "找不到 " + signature + " —— 改名了？");
        int b = code.indexOf("\n  async function ", a + signature.length());
        int c = code.indexOf("\n  function ", a + signature.length());
        int end = Math.min(b < 0 ? code.length() : b, c < 0 ? code.length() : c);
        return code.substring(a, end);
    }

    @Test
    @DisplayName("页面里不再有「取回全部任务」：要多少取多少（/task/page），要数字就用统计接口")
    void 不取全部任务() throws Exception {
        String code = api();
        assertTrue(!code.contains("api.get('/task/list"), "还有地方 GET /task/list 取回全部任务：用 /task/page?limit=…");
        int pages = 0;
        Matcher m = Pattern.compile("api\\.get\\('/task/page\\?").matcher(code);
        while (m.find()) pages++;
        assertTrue(pages >= 4, "只扫到 " + pages + " 处 /task/page —— 任务页、例行计划、番茄钟、提交参考计划都该用它");
    }

    @Test
    @DisplayName("看板：今天几个番茄钟只取今天的学习记录")
    void 番茄钟只取今天() throws Exception {
        String f = body(api(), "async function updatePomoCount()");
        assertTrue(f.contains("api.get('/record/list?from=' + t + '&to=' + t)"), "看板取回了全部学习记录只为数今天的");
    }

    @Test
    @DisplayName("统计页读的每一个 stat.xxx 都是接口真的给的字段（原来读 completedTasks / totalTasks，接口给的是 …Count —— 两格永远是 0）")
    void 统计页字段对得上() throws Exception {
        String f = body(api(), "async function bootStatistics()");
        Set<String> real = Arrays.stream(StudyStatisticsVO.class.getDeclaredFields()).map(Field::getName).collect(Collectors.toSet());
        List<String> used = new ArrayList<>();
        Matcher m = Pattern.compile("\\bstat\\.([A-Za-z_]\\w*)").matcher(f);
        while (m.find()) used.add(m.group(1));
        assertTrue(used.size() >= 4, "只扫到 " + used + " —— 扫空了？");
        List<String> missing = used.stream().filter(u -> !real.contains(u)).distinct().toList();
        // totalMinutes 是给旧字段名留的兜底（后面跟着 || stat.totalStudyMinutes），不算
        assertEquals(List.of("totalMinutes"), missing, "统计页读了接口没有的字段（会一直显示 0）：" + missing + "；接口有：" + real);
        assertTrue(f.contains("renderQuadrantDonut(stat.quadrantDistribution"), "四象限饼图要用接口已经数好的分布，不要再取全部任务来数");
    }

    @Test
    @DisplayName("任务页「加载更多」：这期间换了筛选条件，就不把旧条件下的那一页接到新列表后面")
    void 加载更多认筛选条件() throws Exception {
        String f = body(api(), "async function loadMoreTasks()");
        int fetch = f.indexOf("await api.get('/task/page?' + query");
        int guard = f.indexOf("if (query !== state.taskQuery) return;");
        assertTrue(fetch > 0 && guard > fetch, "加载更多要在拿到结果之后核对筛选条件还是不是发请求时那一套");
    }
}
