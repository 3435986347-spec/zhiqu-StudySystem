package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 第二十六轮：定位从「学生学习系统」改成「AI 办公助手」（用户 2026-10-04 定的，`docs/product-plan.md` 第 3 步）。
 *
 * <p>界面改了而 AI 照旧自称「帮助大学生做学习规划」，定位就只落了一半 —— 开工时最重的一处恰恰在系统提示里。
 * 所以这里同时看两边：用户看得到的（页面、壳、安装到桌面的名字）和写给模型的（系统提示、工具说明）。
 * 用户自己的数据里可以有这些词（他写了「考研」那就是考研）；意图词表要认得用户的说法，也不算。
 */
class PositioningCopyTest {

    private static final Path STATIC = Path.of("src/main/resources/static");
    private static final Path JAVA = Path.of("src/main/java/com/zhiqu");

    /** 只对学生说得通的说法。 */
    static final List<String> STUDENT_ONLY = List.of(
            "考研", "期末", "备考", "大学生", "学习系统", "自主学习", "教学周", "六级", "四级",
            "学习统计", "学习时长", "学习任务", "学习计划", "学习助手", "学习规划", "早八", "一名学生");

    /**
     * 认用户自己说的话的地方 —— 这些字面量是拿来匹配用户输入的，不是写给谁看的。
     * 意图词表整个文件不扫（{@code AgentPlanDecision}）；其余按「文件 → 允许的字面量」逐个列。
     */
    private static final Set<String> LEXICON_FILES = Set.of("AgentPlanDecision.java");
    private static final Map<String, Set<String>> USER_WORDS = Map.of(
            // 参考计划按内容自动归类：用户的计划里写了「考研」「备考」，归到「考证与培训」
            "SharedPlanServiceImpl.java", Set.of("考研", "备考"),
            // 从用户自己的话里给知识库草稿起标题：他说的是考研计划，标题就叫考研计划
            "AiServiceImpl.java", Set.of("考研", "暑假考研保底计划", "暑假考研计划", "考研计划"));

    private static final Pattern TEXT_BLOCK = Pattern.compile("(?s)\"\"\"(.*?)\"\"\"");
    private static final Pattern STRING = Pattern.compile("\"((?:[^\"\\\\\\n]|\\\\.)*)\"");

    private static String read(Path p) throws IOException {
        return Files.readString(p, StandardCharsets.UTF_8);
    }

    private static void scan(String where, String text, List<String> found) {
        for (String word : STUDENT_ONLY) {
            int at = text.indexOf(word);
            if (at >= 0) {
                String around = text.substring(Math.max(0, at - 12), Math.min(text.length(), at + word.length() + 12));
                found.add(where + " 写着「" + word + "」：…" + around.replace('\n', ' ') + "…");
            }
        }
    }

    @Test
    @DisplayName("页面、壳、安装名里没有只对学生说得通的说法")
    void 用户看得到的地方() throws IOException {
        List<String> found = new ArrayList<>();
        int pages = 0;
        try (Stream<Path> files = Files.list(STATIC)) {
            for (Path page : files.filter(p -> p.toString().endsWith(".html")).sorted().toList()) {
                pages++;
                String html = SourceText.stripComments(read(page).replaceAll("(?s)<!--.*?-->", " "));
                scan(page.getFileName().toString(), html, found);
            }
        }
        // assets 下的脚本一个不落（第三十轮起页面模块拆成单独的文件，比如 settings.js；手写名单会漏掉下一个）
        int scripts = 0;
        try (Stream<Path> files = Files.list(STATIC.resolve("assets"))) {
            for (Path js : files.filter(p -> p.toString().endsWith(".js")).sorted().toList()) {
                scripts++;
                scan("assets/" + js.getFileName(), SourceText.stripComments(read(js)), found);
            }
        }
        for (String asset : List.of("service-worker.js", "manifest.json")) {
            scan(asset, SourceText.stripComments(read(STATIC.resolve(asset))), found);
        }
        assertTrue(pages >= 14 && scripts >= 3, "只扫到 " + pages + " 个页面、" + scripts + " 个脚本 —— 空扫和干净的扫长得一样");
        assertEquals(List.of(), found, "界面里还有学生系统的说法");
    }

    @Test
    @DisplayName("写给模型的系统提示、工具说明、发给用户的消息里没有只对学生说得通的说法")
    void 写给模型和发出去的话() throws IOException {
        List<String> found = new ArrayList<>();
        int blocks = 0, literals = 0;
        try (Stream<Path> files = Files.walk(JAVA)) {
            for (Path file : files.filter(p -> p.toString().endsWith(".java")).sorted().toList()) {
                String name = file.getFileName().toString();
                if (LEXICON_FILES.contains(name)) {
                    continue;
                }
                String code = SourceText.stripComments(read(file));
                Matcher block = TEXT_BLOCK.matcher(code);
                while (block.find()) {
                    blocks++;
                    scan(name + " 的文本块", block.group(1), found);
                }
                String rest = TEXT_BLOCK.matcher(code).replaceAll(" ");
                Set<String> allowed = USER_WORDS.getOrDefault(name, Set.of());
                Matcher literal = STRING.matcher(rest);
                while (literal.find()) {
                    literals++;
                    if (!allowed.contains(literal.group(1))) {
                        scan(name, literal.group(1), found);
                    }
                }
            }
        }
        assertTrue(blocks >= 15 && literals >= 3000,
                "只扫到 " + blocks + " 个文本块、" + literals + " 个字符串 —— 空扫和干净的扫长得一样");
        assertEquals(List.of(), found, "写给模型或发出去的话里还有学生系统的说法");
    }

    @Test
    @DisplayName("命令行 zhiqu 的源码里也没有（第二十九轮：内置系统提示写着「『知趣·象限』学习系统的 coding agent」，第二十六轮只扫了网页和后端）")
    void 命令行() throws IOException {
        Path cli = Path.of("../zhiqu-cli/src");
        List<String> found = new ArrayList<>();
        int files = 0;
        try (Stream<Path> walk = Files.walk(cli)) {
            for (Path f : walk.filter(p -> p.toString().endsWith(".js")).sorted().toList()) {
                files++;
                scan("zhiqu-cli/" + cli.relativize(f), SourceText.stripComments(read(f)), found);
            }
        }
        assertTrue(files >= 20, "只扫到 " + files + " 个文件 —— 空扫和干净的扫长得一样");
        assertEquals(List.of(), found, "命令行里还有学生系统的说法（系统提示、终端里显示的字）");
    }

    @Test
    @DisplayName("AI 助手在侧栏第一位、登录后落在 AI 助手、安装到桌面也从它打开；成就从导航收起")
    void AI放在第一位() throws IOException {
        String ui = SourceText.stripComments(read(STATIC.resolve("assets/zhiqu-ui.js")));
        Matcher first = Pattern.compile("main:\\s*\\[\\s*\\['([^']+)'").matcher(ui);
        assertTrue(first.find(), "找不到侧栏的 NAV.main");
        assertEquals("ai-assistant.html", first.group(1), "侧栏第一项应当是 AI 助手");
        // 只看 NAV 那一段：第三十九轮起 zhiqu-ui.js 别处要认出 achievement.html 这个旧地址的跳转页（holdsUntilBoot），那不是导航
        int navAt = ui.indexOf("var NAV = {");
        int navEnd = navAt < 0 ? -1 : ui.indexOf("};", navAt);
        assertTrue(navAt >= 0 && navEnd > navAt, "找不到 NAV 的定义");
        String nav = ui.substring(navAt, navEnd);
        assertTrue(nav.contains("'ai-assistant.html'"), "NAV 截错了：里面连 AI 助手都没有");
        assertFalse(nav.contains("'achievement.html'"), "成就从导航收起（用户 2026-10-04 定的），页面和数据都还在");

        String api = SourceText.stripComments(read(STATIC.resolve("assets/zhiqu-api.js")));
        Matcher home = Pattern.compile("var HOME_PAGE = '([^']+)';").matcher(api);
        assertTrue(home.find(), "找不到 HOME_PAGE");
        assertEquals("ai-assistant.html", home.group(1), "登录后落在 AI 助手");
        assertTrue(read(STATIC.resolve("manifest.json")).contains("\"start_url\": \"/" + home.group(1) + "\""),
                "安装到桌面的应用从哪一页打开，要和登录后的首页一致");
    }
}
