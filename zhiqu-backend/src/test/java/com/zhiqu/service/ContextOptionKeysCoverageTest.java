package com.zhiqu.service;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@code contextOptions} 这份<b>跨前后端</b>的键词表的覆盖检查。
 *
 * <h2>它关的是第五个「声称存在、实际未接线」的洞</h2>
 *
 * <p>前四次都在后端内部，识别点是「标识符里出现 {@code OR}」。第五次是
 * {@code selectedWikiPageIds}：名字毫无问题，问题是<b>没有任何客户端设它</b>，
 * 于是那条显式选择路径在发布产品里从未产出过一行 —— 而两侧都没有任何东西会红。
 * {@code Map<String, Object>} 让「拼错」与「从未设置」在编译期、运行期都不可见。
 *
 * <p>后端那一半已经用 {@link ContextOptionKeys} 消掉了（常量引用，改名是编译期改动）。
 * <b>跨语言那一半消不掉</b> —— JS 与 Java 之间没有编译器 —— 所以这里只能是检测，
 * 而检测要写得让它在该响的时候响：新增一个后端读的客户端键、前端忘了发，当天变红。
 */
class ContextOptionKeysCoverageTest {

    /** 14 个页面加载的那个 shell。{@code js/*.js} 是零页面加载的 legacy，<b>不算</b>。 */
    private static final Path LIVE_SHELL =
            Path.of("src/main/resources/static/assets/zhiqu-api.js");

    /**
     * 每个客户端键，活壳里至少有一处在发 —— <b>有意未接线的除外，且豁免要写明理由</b>。
     *
     * <p>豁免名单不是逃生口：它把「没接线」从沉默变成一次显式声明。
     * 往里加一项要过一次人的判断（并在常量的 javadoc 里写清楚为什么），
     * 而漏接一个新键会当天变红。
     */
    @Test
    void 每个客户端键在活壳里都有人发() throws IOException {
        String shell = Files.readString(LIVE_SHELL, StandardCharsets.UTF_8);

        List<String> missing = new ArrayList<>();
        for (String key : ContextOptionKeys.CLIENT_SUPPLIED) {
            if (ContextOptionKeys.UNWIRED_BY_DECISION.contains(key)) continue;
            if (!shell.contains(key)) missing.add(key);
        }

        assertEquals(List.of(), missing,
                "这些键后端在读、活壳却没有一处在发。要么补上前端，要么把它加进 "
                        + "UNWIRED_BY_DECISION 并在常量 javadoc 里写明理由 —— "
                        + "不写理由的豁免和忘了接线长得一模一样");
    }

    /**
     * <b>已知的那一处未接线必须留在名单里，而且必须真的没接。</b>
     *
     * <p>这条是上一条的阳性对照：只有上一条的话，把整个 {@code CLIENT_SUPPLIED} 塞进
     * 豁免名单也能全绿 —— 判据会退化成「名单里的都跳过」，而它声称报告的是「没有漏接的键」。
     *
     * <p>它同时是一条<b>会自己退休</b>的断言：等 Wiki 显式选择真的接上前端，
     * 这条会红，而那时正确动作是把 {@code SELECTED_WIKI_PAGE_IDS} 移出豁免名单 ——
     * 红的含义是「洞补上了」，不是「坏了」。
     */
    @Test
    void 豁免名单里的键确实没有被前端发送() throws IOException {
        String shell = Files.readString(LIVE_SHELL, StandardCharsets.UTF_8);

        for (String key : ContextOptionKeys.UNWIRED_BY_DECISION) {
            assertTrue(ContextOptionKeys.CLIENT_SUPPLIED.contains(key),
                    key + " 不是客户端键，豁免它没有意义 —— 豁免名单只对 CLIENT_SUPPLIED 有效");
            assertTrue(!shell.contains(key),
                    key + " 已经被活壳发送了，它不再是「有意未接线」。"
                            + "把它移出 UNWIRED_BY_DECISION —— 这条红代表洞补上了，不是坏了");
        }
    }

    /**
     * 服务端注入的键<b>不得</b>混进客户端键集合。
     *
     * <p>{@code query} 由 {@code AiServiceImpl.java:529} 在调用前塞进去，客户端发不发都不影响行为。
     * 混进去的话第一条会把它报成第二个洞 —— 判据的定义域比它声称报告的性质宽，
     * 而那正是本仓库反复记的那一族。这条把「分类正确」本身钉住。
     */
    @Test
    void 服务端注入的键不参与前端覆盖检查() {
        for (String key : ContextOptionKeys.SERVER_INJECTED) {
            assertTrue(!ContextOptionKeys.CLIENT_SUPPLIED.contains(key),
                    key + " 是服务端注入的，不该出现在 CLIENT_SUPPLIED 里");
        }
        assertTrue(ContextOptionKeys.SERVER_INJECTED.contains(ContextOptionKeys.QUERY),
                "query 是服务端注入的那一个；它要是从这个集合里掉出去，"
                        + "第一条会立刻把它报成一个不存在的洞");
    }

    /**
     * 后端读键必须经 {@link ContextOptionKeys}，不得内联字面量。
     *
     * <p><b>刻意不检查 {@code query}</b>：那个词在别的 map 上也是键
     * （{@code AiServiceImpl.java:3103} 读工具调用参数里的 {@code args.get("query")}），
     * 把它一起扫会把一处正确代码报成违规。判据只覆盖三个不会撞名的键 ——
     * <b>覆盖面写小一点，好过让判据在它管不着的地方误报</b>。
     *
     * <p>这是绊线不是证明：同一份源码里仍然写得出裸字面量，只是要绕过这条才行。
     */
    @Test
    void 后端不再内联contextOptions的键名() throws IOException {
        List<String> unambiguous = List.of(
                ContextOptionKeys.INCLUDE_WIKI,
                ContextOptionKeys.SELECTED_SOURCE_IDS,
                ContextOptionKeys.SELECTED_WIKI_PAGE_IDS);

        List<String> offenders = new ArrayList<>();
        try (var paths = Files.walk(Path.of("src/main/java/com/zhiqu/service"))) {
            for (Path file : paths.filter(p -> p.toString().endsWith(".java")).toList()) {
                if (file.endsWith("ContextOptionKeys.java")) continue;
                String source = Files.readString(file, StandardCharsets.UTF_8)
                        .replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)//.*$", "");
                for (String key : unambiguous) {
                    if (source.contains('"' + key + '"')) offenders.add(file.getFileName() + " → " + key);
                }
            }
        }

        assertEquals(List.of(), offenders,
                "这些地方内联了键名字面量。词表只有一份定义才挡得住拼错 —— "
                        + "而拼错在 Map<String,Object> 上不报错，只表现为那个选项从此无效");
    }
}
