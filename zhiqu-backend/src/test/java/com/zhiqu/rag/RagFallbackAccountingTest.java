package com.zhiqu.rag;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 不变量：{@code RagRetriever.retrieve} 的每一条<b>非成功返回恰好记一次回落原因</b>，
 * {@code disabled()} 是唯一刻意的例外。
 *
 * <p>为什么需要一条测试而不是一句注释：这条纪律<b>已经失效过一次</b>。
 * sidecar 不可用那一条返回压根没调 {@code recordFallback} —— 于是 token 配错时，
 * 健康信息里的原因是合并的（{@code DISABLED_OR_TOKEN_MISSING}）、指标里干脆没有，
 * 两层诊断同时失效。而它是拆那个合并字符串时<b>偶然</b>发现的，不是被任何东西报出来的。
 *
 * <p>这是本仓库「声称存在、实际未接线」的第四次：{@code RECONCILE_UNITS}、
 * {@code DELETE_SCOPE}、{@code DELETE_INDEX_VERSION}，加这次的 fallback 指标。
 * 四次之后它不再是一串意外，是这个代码库的结构性洞。
 *
 * <p>检索侧的改动会新增返回路径（Wiki 候选回填失败、回填时解密失败……），每一条都要记。
 * 靠「写 return 的时候记得在旁边加一行」维持不住 —— 所以出口收成了
 * {@code fallback(...)} / {@code disabled()} 两个，本测试数的是<b>绕过它们的可能性</b>。
 */
class RagFallbackAccountingTest {

    private static final Path SOURCE = Path.of("src/main/java/com/zhiqu/rag/RagRetriever.java");

    /**
     * 构造点必须恰好三处：{@code fallback(reason, generation)}、{@code disabled()}、成功返回。
     * （{@code fallback(reason)} 只做委托，不构造。）数字变了就意味着有人新开了一个出口。
     *
     * <p><b>这是绊线，不是证明。</b>同一个文件里仍然写得出
     * {@code new RetrievalResult(false, ...)}；Java 在单个类内部没有更强的可见性可用。
     * 它唯一的作用是逼人在新增出口时来这里解释一句 —— 与
     * {@code RagOperationCoverageTest.作业类型词表非空} 的下限数字是同一种东西。
     */
    @Test
    void 结果构造点没有增加() throws IOException {
        String source = withoutComments(Files.readString(SOURCE, StandardCharsets.UTF_8));
        assertEquals(3, countMatches(source, "new\\s+RetrievalResult\\s*\\("),
                "三处：fallback(reason, generation) 一处、disabled() 一处、成功返回一处。"
                        + "多出来的每一处都是一条可能不记指标的返回路径");
    }

    /**
     * 那个静态工厂必须保持删除状态。
     *
     * <p>{@code RetrievalResult.unavailable(reason)} 是一条绕过指标记账的近路，
     * 而且看起来完全无辜 —— 正是它让「sidecar 不可用不记指标」那个洞看起来像正常代码。
     */
    @Test
    void 没有绕过记账的静态工厂() throws IOException {
        String source = withoutComments(Files.readString(SOURCE, StandardCharsets.UTF_8));
        assertEquals(0, count(source, "RetrievalResult unavailable("),
                "回落结果只能经 fallback(...) 出去；再加一个静态工厂等于把出口重新散开");
    }

    /**
     * 记账属于出口，不属于调用点：整个文件里 {@code recordFallback} <b>只许出现一次</b>，
     * 且必须落在两参 {@code fallback(...)} 之后。
     *
     * <p><b>此前这条是靠「{@code retrieve} 与 {@code fallback} 两个声明之间」这个窗口写的，
     * 而那是位置耦合。</b>step 2 在两者之间插了两个私有辅助方法，窗口当场悄悄变宽 ——
     * 断言仍然绿，但它此刻报的已经不是自己声称的那条性质（「retrieve 方法体内」）。
     * 同一个物种，这次的方向是<b>变宽</b>：它会因为一个并非「调用点自己记账」的原因而红，
     * 而红的时候给出的解释是错的。
     *
     * <p>改成文件级计数之后：不依赖任何声明的先后，覆盖面严格更大
     * （连 {@code disabled()} 里偷偷记一次也会红 —— 那正是「唯一不记指标的出口」这条
     * 例外的静态那一半），而且再也不会出现「锚点没找到」这种与被测性质无关的失败。
     */
    @Test
    void 记账只发生在出口里() throws IOException {
        String source = withoutComments(Files.readString(SOURCE, StandardCharsets.UTF_8));
        assertEquals(1, count(source, "metrics.recordFallback("),
                "调用点自己记账，就又回到了「写 return 时记得加一行」那条靠不住的纪律");
        int exit = source.indexOf("private RetrievalResult fallback(String reason, RagIndexGeneration");
        assertTrue(exit > 0, "两参 fallback 是唯一的记账出口，它不见了说明出口结构变了");
        assertTrue(source.indexOf("metrics.recordFallback(") > exit,
                "唯一那次记账必须落在出口方法里，不能在别处");
    }

    /**
     * 数之前必须先去掉注释 —— <b>第一次跑就是被这条绊倒的</b>：
     * {@code fallback} 的 javadoc 里写着「同一个文件里仍能直接
     * {@code new RetrievalResult(false, ...)}」，那句话本身被数成了第四处构造点。
     *
     * <p>判据的定义域比它声称报告的性质宽：它要数的是<b>构造点</b>，数到的是<b>字符串出现</b>。
     * 同一个物种，只是这次出现在测试自己身上 —— 而且它是靠一次红报出来的，
     * 不是靠读代码。若那句注释当初没写，这条判据会带着同一个缺陷长期绿着。
     */
    private static String withoutComments(String source) {
        return source.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)//.*$", "");
    }

    /**
     * 按<b>正则</b>数构造点，不按字面子串 —— 收的是「少数」方向（漏掉一个绕过点）。
     *
     * <p>剥注释修掉的是「多数」方向：数多了会红，噪声自己会报。少数方向是静默的 ——
     * 漏掉的绕过点不会让任何东西变红，而绊线恰好在它该响的那一刻不响。
     *
     * <p><b>实测过三种写法，结论与直觉不同：</b>
     * <ul>
     *   <li>{@code new RetrievalResult(ok, ...)}（布尔是变量或表达式）—— 旧的字面匹配<b>已经能捕获</b>，
     *       因为它匹配的是 {@code new RetrievalResult(} 这个前缀，根本不看第一个实参；</li>
     *   <li>{@code new  RetrievalResult(}（两个空格）—— 旧判据 <b>GREEN，漏了</b>；</li>
     *   <li>{@code new} 与类型名之间换行 —— 旧判据 <b>GREEN，漏了</b>。</li>
     * </ul>
     * 也就是说真正的缺口是<b>空白与折行</b>，而那是 IDE 自动格式化就能产生的形态，不是刁钻构造。
     * {@code new\s+RetrievalResult\s*\(} 把三种都盖住。
     */
    private static int countMatches(String haystack, String regex) {
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile(regex).matcher(haystack);
        int total = 0;
        while (matcher.find()) total++;
        return total;
    }

    private static int count(String haystack, String needle) {
        int total = 0;
        for (int at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) total++;
        return total;
    }
}

// ── 扰动记录（三条性质三次扰动，实测）────────────────────────────────────
//
//   K1  新开一条绕过 fallback(...) 的返回          RED
//   K2  把 unavailable(...) 静态工厂加回来          RED
//   K3  在调用点重新自己记一次指标                  RED
//
// K3 的**判据在 step 2 换过一次**（窗口计数 → 文件级计数），所以上面那个 RED 是旧判据下的。
// 新判据严格更宽（多出来的那一次记账在文件任何位置都会让计数变成 2），K3 照旧红；
// 但记在这里是因为「扰动记录」与「当前判据」漂开正是这份记录会失效的方式 ——
// 一条实测结果只对它当时那个判据成立。
//
// 另有一次**判据自身**的红，值得单独记：第一次跑 结果构造点没有增加 时实测 4 而非 3，
// 多出来的那一处在 RagRetriever 的 javadoc 里 —— 那句注释写着
// 「同一个文件里仍能直接 new RetrievalResult(false, ...)」，被数成了构造点。
//
// 判据的定义域比它声称报告的性质宽：要数的是**构造点**，数到的是**字符串出现**。
// 同一个物种，这次长在测试自己身上。修法是先剥注释再数。
// 它是靠一次红报出来的 —— 若那句注释当初没写，这条判据会带着同一个缺陷长期绿着，
// 而且是在「新增出口」真的发生时才失效。
//
// ── 少数方向（静默那一半）的实测 ────────────────────────────────────────
//
// 剥注释修的是「多数」方向：数多了会红，噪声自己会报。
// 「少数」方向是漏掉一个绕过点 —— 不会让任何东西变红，绊线在该响的那一刻不响。
// 三种写法，字面子串判据下的实测：
//
//   L1  new RetrievalResult(ok, ...)   布尔是变量    RED    ← 本来就能捕获
//   L2  new  RetrievalResult(          两个空格      GREEN  ← 漏
//   L3  new 与类型名之间换行                          GREEN  ← 漏
//
// **L1 与直觉相反**：字面判据匹配的是 "new RetrievalResult(" 这个前缀，根本不看第一个实参，
// 所以「布尔从字面 false 变成算出来的」这种形态一直在覆盖里。
// 真正的缺口是**空白与折行** —— 而那是 IDE 自动格式化就能产生的，不是刁钻构造。
// 换成 new\s+RetrievalResult\s*\( 之后 L1/L2/L3 全红。
//
// 真正的消除要把这个 record 挪到别的包、规范构造器降包内可见、只暴露工厂。
// **不做**：为一个小值类型换包，代价大于收益。绊线加准确的边界说明，在这个位置是对的取舍。
