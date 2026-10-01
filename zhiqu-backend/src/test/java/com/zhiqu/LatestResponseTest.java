package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 同一处连着查了几次，只认最后一次的响应（第十四轮）。来回切「日 / 周 / 月」、改筛选条件、写完之后的重载 ——
 * 响应可能乱序回来，先发的那次后回来就会把旧结果画在新选的条件下面。
 *
 * <p>行为判据跑在 node 上、直接加载发布的实现（latest-check.js，拿趋势图做样本）；
 * 其余几处由调用约定钉住：拿到结果之后、画之前先问一句 {@code current()}。
 */
class LatestResponseTest {

    @Test
    @DisplayName("趋势图：先点的那次后回来，不许盖掉后点的")
    void 乱序响应() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/latest-check.js"), NodeRunner.API_JS);
    }

    @Test
    @DisplayName("筛选 / 刷新会连着触发的列表：拿到结果先问 current()，过期的不画")
    void 列表都只认最后一次() throws Exception {
        String code = SourceText.stripComments(Files.readString(Path.of("src/main/resources/static/assets/zhiqu-api.js")));
        for (String name : List.of("paintTrend", "loadTasks", "loadRoutineSources", "loadPlans")) {
            Matcher m = Pattern.compile("async function " + name + "\\([^)]*\\)\\s*\\{").matcher(code);
            assertTrue(m.find(), "找不到 " + name + " —— 改名了？这条判据要跟着改");
            int next = Math.min(indexOrMax(code, "\n  async function ", m.end()), indexOrMax(code, "\n  function ", m.end()));
            String body = code.substring(m.end(), next);
            int token = body.indexOf("latestOnly(");
            int fetch = body.indexOf("await api.get(");
            int check = body.indexOf("if (!current()) return;");
            assertTrue(token >= 0 && fetch > token && check > fetch,
                    name + "：要在发请求之前领一个 latestOnly、拿到结果之后先 if (!current()) return; —— 否则乱序回来的旧结果会盖掉新的");
        }
    }

    private static int indexOrMax(String s, String needle, int from) {
        int i = s.indexOf(needle, from);
        return i < 0 ? s.length() : i;
    }
}
