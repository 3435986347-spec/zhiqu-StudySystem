package com.zhiqu;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 后台页面集合的三份拷贝之间必须对齐。
 *
 * <p>「哪些页面属于后台」这件事今天写在三个地方，而只有第一处是<b>定义</b>：
 * <ol>
 *   <li>{@code zhiqu-ui.js} 的 {@code NAV.admin} —— 定义。侧栏分组与
 *       {@code ZQUI.isAdminPage()} 都从它派生；</li>
 *   <li>{@code zhiqu-api.js} 的 {@code route()} —— <b>不该</b>有第二份拷贝，
 *       它问 {@code ZQUI.isAdminPage(page)}；</li>
 *   <li>{@code SecurityConfig} 的 permitAll 白名单 —— 跨语言，没法从 {@code NAV.admin}
 *       派生，只能是一份硬拷贝，所以只能靠判据钉住。</li>
 * </ol>
 *
 * <h2>两条判据买的东西不一样，别当成同一档</h2>
 *
 * <table border="1">
 *   <caption>失败形态</caption>
 *   <tr><th>判据</th><th>它防的改动</th><th>没有它时怎么失败</th><th>买到的</th></tr>
 *   <tr><td>{@link #route必须问ZQUI_isAdminPage()}</td>
 *       <td>有人把派生换回在 {@code route()} 里硬写一个四元数组</td>
 *       <td><b>沉默</b>：换掉当场不坏，等到加第五个后台页那天，
 *           {@code NAV.admin} 加了、门里忘了，那一页就静默可直达，没有任何东西会红</td>
 *       <td><b>不沉默</b></td></tr>
 *   <tr><td>{@link #每个后台页都在SecurityConfig白名单里()}</td>
 *       <td>加了后台页却忘了加白名单</td>
 *       <td><b>响的</b>：管理员直达就吃 403，立刻撞上</td>
 *       <td>只是<b>早</b>——把发现时机从部署后提到构建时</td></tr>
 * </table>
 *
 * <p>第二条仍然值得有，但它不是「防静默」，别在排优先级时把两者混为一谈。
 *
 * <h2>覆盖边界</h2>
 *
 * <ol>
 *   <li>{@code NAV.admin} 必须写在<b>一行</b>里才解析得到（今天是）。
 *       改成多行会让解析扫空 —— 由 {@link #后台页集合解析不能扫空()} 报出来，
 *       而不是让下面两条判据在空集合上真空通过；</li>
 *   <li>第二条判据只查文件里<b>有没有</b>那个调用，不解析 {@code route()} 的函数体
 *       （提取函数体是脆的，改一次缩进就漂）。所以它挡的是「调用被删掉」，
 *       挡不住「调用还在、但旁边又抄了一份数组」。后者今天没有动机，
 *       真出现的话是下一条判据的活。</li>
 * </ol>
 */
class AdminPageWiringTest {

    private static final Path STATIC_DIR = Path.of("src", "main", "resources", "static");
    private static final Path SECURITY_CONFIG =
            Path.of("src", "main", "java", "com", "zhiqu", "config", "SecurityConfig.java");

    /** {@code admin: [ ['admin.html',…], … ]} —— 取到行尾，因为条目本身带方括号，非贪婪会在第一个 ] 停下。 */
    private static final Pattern NAV_ADMIN_LINE = Pattern.compile("admin:\\s*\\[(.*)$", Pattern.MULTILINE);
    private static final Pattern PAGE_IN_NAV = Pattern.compile("'([A-Za-z0-9_-]+\\.html)'");

    @Test
    void 后台页集合解析不能扫空() throws IOException {
        Set<String> pages = adminPages();
        assertFalse(pages.isEmpty(),
                "未能从 zhiqu-ui.js 的 NAV.admin 解析出任何后台页面。"
                        + "NAV.admin 今天写在一行里，改成多行会让 NAV_ADMIN_LINE 扫空 —— "
                        + "请同步更新本测试的正则，不要直接删除本类的判据："
                        + "集合为空时，下面两条判据会在空集合上真空通过，什么都不再钉");
    }

    @Test
    void route必须问ZQUI_isAdminPage() throws IOException {
        // 必须先剥注释再查。第一版直接对全文 contains，结果被 route() 里那句解释性注释
        //   「页面集合问 ZQUI.isAdminPage()，它从 NAV.admin 派生 —— 不在这里抄第二份文件名。」
        // 满足了：把真正的调用换成硬写数组，判据照样绿。扰动实测逮到的，不是推演出来的。
        // 一条被自己要防的那段文字满足的判据，正是本轮反复记的那个物种。
        String shell = stripComments(
                Files.readString(STATIC_DIR.resolve("assets/zhiqu-api.js"), StandardCharsets.UTF_8));
        assertTrue(shell.contains("ZQUI.isAdminPage("),
                "zhiqu-api.js 里找不到 ZQUI.isAdminPage( 的调用。"
                        + "后台页集合必须从 zhiqu-ui.js 的 NAV.admin 派生，不能在 route() 里抄第二份文件名 —— "
                        + "抄了之后当场不坏，等到加第五个后台页那天，NAV.admin 加了、门里忘了，"
                        + "那一页就静默可直达，而没有任何东西会红");
    }

    @Test
    void 每个后台页都在SecurityConfig白名单里() throws IOException {
        Set<String> pages = adminPages();
        String config = Files.readString(SECURITY_CONFIG, StandardCharsets.UTF_8);

        List<String> missing = new ArrayList<>();
        for (String page : pages) {
            if (!config.contains("\"/" + page + "\"")) missing.add(page);
        }

        assertTrue(missing.isEmpty(),
                "以下后台页在 NAV.admin 里，却不在 SecurityConfig 的 permitAll 白名单里："
                        + missing + "。它们会落到 anyRequest().authenticated()，"
                        + "而浏览器导航不带 Authorization 头 —— 管理员直达也会吃 403");
    }

    /**
     * 剥掉 JS 注释，让判据只看可执行的部分。
     *
     * <p>{@code //} 的匹配刻意<b>排除前面紧跟冒号</b>的情况，否则 {@code https://…} 会被当成
     * 注释起点、把整行后半截吞掉，判据就可能因为一条 URL 而假阴性。
     * 这是个便宜的启发式，不是 JS 词法分析：字符串字面量里写的 {@code "/*"} 仍会骗到它。
     * 对本判据够用 —— 它只需要「注释里的那句话不算数」。
     */
    private String stripComments(String source) {
        return source.replaceAll("(?s)/\\*.*?\\*/", " ").replaceAll("(?<!:)//[^\\n]*", " ");
    }

    /** 从 {@code NAV.admin} 解析后台页文件名。空集合本身是一种失败，由独立判据报出。 */
    private Set<String> adminPages() throws IOException {
        String ui = Files.readString(STATIC_DIR.resolve("assets/zhiqu-ui.js"), StandardCharsets.UTF_8);
        Set<String> pages = new LinkedHashSet<>();
        Matcher line = NAV_ADMIN_LINE.matcher(ui);
        if (line.find()) {
            Matcher page = PAGE_IN_NAV.matcher(line.group(1));
            while (page.find()) {
                pages.add(page.group(1));
            }
        }
        return pages;
    }
}
