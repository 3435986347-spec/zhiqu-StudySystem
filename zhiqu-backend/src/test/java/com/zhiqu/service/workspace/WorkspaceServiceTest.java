package com.zhiqu.service.workspace;

import com.zhiqu.common.BusinessException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 工作区的只读能力：关着的时候必须什么都不给，开着的时候拒绝要说得出理由。
 *
 * <h2>「关着」这条为什么排第一</h2>
 *
 * <p>这个服务是 Spring 单例，在每个部署里都会被构造出来 —— 包括那些<b>压根没配工作区</b>的。
 * 它默认必须一个文件都读不到，而且这件事不能靠「调用方记得先判断 mode」，
 * 必须由服务自己在每个入口挡住。
 */
class WorkspaceServiceTest {

    private static WorkspaceProperties props(Path root, String mode) {
        WorkspaceProperties p = new WorkspaceProperties();
        p.setMode(mode);
        p.setRoot(root == null ? "" : root.toString());
        return p;
    }

    private static WorkspaceService serviceAt(Path root, String mode) {
        return new WorkspaceService(props(root, mode), "127.0.0.1");
    }

    private static void seed(Path dir, String name, String content) throws IOException {
        Files.createDirectories(dir);
        Files.writeString(dir.resolve(name), content, StandardCharsets.UTF_8);
    }

    /**
     * 没配工作区时，每个入口都要挡住。
     *
     * <p>扰动：把 {@code requireRead()} 从 {@code list} 或 {@code read} 里去掉 → 本条红
     * （而且会是 NullPointerException —— guard 在关闭时是 null，那也算红，但报错难读，
     * 所以入口的显式检查不只是礼貌）。
     */
    @Test
    void 未启用时每个入口都要挡住(@TempDir Path root) throws IOException {
        seed(root, "Main.java", "class Main {}");
        WorkspaceService off = serviceAt(root, "OFF");

        assertThrows(BusinessException.class, () -> off.list(""),
                "关着的时候列目录必须被拒");
        assertThrows(BusinessException.class, () -> off.read("Main.java"),
                "关着的时候读文件必须被拒");
        assertFalse(off.access().enabled());
    }

    /** 默认配置（什么都不配）必须是关着的 —— 绝大多数部署走的就是这一条路径。 */
    @Test
    void 默认配置下服务是关着的() {
        WorkspaceService service = new WorkspaceService(new WorkspaceProperties(), "127.0.0.1");
        assertFalse(service.access().enabled(), "不配 app.workspace 的部署必须完全没有这个能力");
        assertThrows(BusinessException.class, () -> service.read("任意路径"));
    }

    @Test
    void 开着时能列目录与读文件(@TempDir Path root) throws IOException {
        seed(root, "README.md", "# 项目");
        seed(root.resolve("src"), "Main.java", "class Main {}");
        WorkspaceService service = serviceAt(root, "READ");

        List<WorkspaceService.Entry> top = service.list("");
        assertTrue(top.stream().anyMatch(e -> e.path().equals("README.md") && !e.directory()));
        assertTrue(top.stream().anyMatch(e -> e.path().equals("src") && e.directory()));
        assertEquals("class Main {}", service.read("src/Main.java"));
    }

    /**
     * 列表要<b>预先</b>告诉用户哪些文件读不了。
     *
     * <p>否则用户点开一个 {@code .env} 才被拒绝 —— 而那时他已经认为这个功能能读任何文件了。
     */
    @Test
    void 列表要标出哪些文件读不了(@TempDir Path root) throws IOException {
        seed(root, "Main.java", "class Main {}");
        seed(root, ".env", "DB_PASSWORD=hunter2");
        WorkspaceService service = serviceAt(root, "READ");

        List<WorkspaceService.Entry> entries = service.list("");
        WorkspaceService.Entry java = entries.stream().filter(e -> e.path().equals("Main.java")).findFirst().orElseThrow();
        WorkspaceService.Entry env = entries.stream().filter(e -> e.path().equals(".env")).findFirst().orElseThrow();
        assertTrue(java.readable(), "源码文件必须标成可读");
        assertFalse(env.readable(), ".env 必须在列表里就标成不可读，而不是点开才拒绝");
    }

    /** 噪声目录不占条数上限 —— 否则一个 node_modules 就把真正的源码全挤出去了。 */
    @Test
    void 噪声目录不出现在列表里(@TempDir Path root) throws IOException {
        seed(root, "Main.java", "class Main {}");
        Files.createDirectories(root.resolve("node_modules/left-pad"));
        Files.createDirectories(root.resolve(".git/objects"));
        Files.createDirectories(root.resolve("target/classes"));
        Files.createDirectories(root.resolve("src"));

        List<String> paths = serviceAt(root, "READ").list("").stream().map(WorkspaceService.Entry::path).toList();
        assertTrue(paths.contains("src"), "正常目录要在，否则这条判据是空过的。实际：" + paths);
        assertFalse(paths.contains("node_modules"), "实际：" + paths);
        assertFalse(paths.contains(".git"));
        assertFalse(paths.contains("target"));
    }

    /** 条数上限必须生效。 */
    @Test
    void 列表条数有上限(@TempDir Path root) throws IOException {
        for (int i = 0; i < 40; i++) {
            seed(root, "F" + i + ".java", "//");
        }
        WorkspaceProperties p = props(root, "READ");
        p.setMaxEntries(10);
        assertEquals(10, new WorkspaceService(p, "127.0.0.1").list("").size(),
                "超过上限要截断 —— 一个大目录不该把内存打满");
    }

    /**
     * 六种拒绝理由必须各说各的，不能都说「读不到」。
     *
     * <p>工作区的使用者是人。「文件不存在」「后缀不允许」「超出范围」是三件完全不同的事，
     * 混成一句话的话，用户只会觉得这个功能坏了。
     */
    @Test
    void 拒绝理由必须各不相同(@TempDir Path root) throws IOException {
        seed(root, ".env", "secret");
        seed(root, "big.java", "x".repeat(300));
        Files.createDirectories(root.resolve("adir"));
        WorkspaceProperties p = props(root, "READ");
        p.setMaxFileBytes(100);
        WorkspaceService service = new WorkspaceService(p, "127.0.0.1");

        String outside = assertThrows(BusinessException.class, () -> service.read("../secret.java")).getMessage();
        String ext = assertThrows(BusinessException.class, () -> service.read(".env")).getMessage();
        String big = assertThrows(BusinessException.class, () -> service.read("big.java")).getMessage();
        String missing = assertThrows(BusinessException.class, () -> service.read("nope.java")).getMessage();

        assertTrue(outside.contains("工作区范围"), "实际：" + outside);
        assertTrue(ext.contains("允许清单"), "实际：" + ext);
        assertTrue(big.contains("上限"), "实际：" + big);
        assertTrue(missing.contains("普通文件"), "实际：" + missing);
        assertEquals(4, java.util.Set.of(outside, ext, big, missing).size(),
                "四种原因必须给出四条不同的话");
    }

    /** 搜索也要经 requireRead —— 它是第三个入口，最容易在加功能时漏掉。 */
    @Test
    void 搜索在未启用时必须被挡住(@TempDir Path root) throws IOException {
        seed(root, "Main.java", "class Main {}");
        assertThrows(BusinessException.class, () -> serviceAt(root, "OFF").search("Main", ""),
                "关着的时候搜索必须被拒 —— 否则它就是一条绕过 mode 的读取路径");
    }

    @Test
    void 搜索能递归找到并给出行号(@TempDir Path root) throws IOException {
        seed(root, "README.md", "# 项目\n没有关键词");
        seed(root.resolve("src").resolve("deep"), "Main.java", "class Main {\n  void 目标方法() {}\n}");
        WorkspaceService.SearchResult r = serviceAt(root, "READ").search("目标方法", "");

        assertEquals(1, r.hits().size(), "应当只命中一处，实际：" + r.hits());
        WorkspaceService.Hit hit = r.hits().get(0);
        assertTrue(hit.path().endsWith("Main.java"), "命中的文件不对：" + hit.path());
        assertEquals(2, hit.line(), "行号必须从 1 开始数 —— 报错到 0 或 3 会让人翻到错误的行");
        assertTrue(hit.text().contains("目标方法"));
    }

    /** 大小写不敏感，但不接受正则 —— 正则来自模型，灾难性回溯会打死我们自己的进程。 */
    @Test
    void 搜索是字面量而不是正则(@TempDir Path root) throws IOException {
        seed(root, "Main.java", "String s = a.b(c);");
        WorkspaceService service = serviceAt(root, "READ");

        assertEquals(1, service.search("STRING S", "").hits().size(), "大小写必须不敏感");

        // 正则里 . 匹配任意字符、() 是分组。当字面量处理的话，这些都只匹配它们自己。
        assertEquals(1, service.search("a.b(c)", "").hits().size(), "字面量 a.b(c) 应当命中自己");
        assertEquals(0, service.search("a.b(.)", "").hits().size(),
                "a.b(.) 只有被当成正则时才会命中 —— 命中了就说明它走的是正则路径，"
                        + "而模型写出 (a+)+b 这类正则会让 JVM 灾难性回溯");
    }

    /** 噪声目录在搜索里也要跳过 —— 不只是列目录时跳过。 */
    @Test
    void 搜索要跳过噪声目录(@TempDir Path root) throws IOException {
        seed(root, "Main.java", "关键词");
        seed(root.resolve("node_modules").resolve("pkg"), "index.js", "关键词");
        seed(root.resolve("target").resolve("classes"), "Gen.java", "关键词");

        WorkspaceService.SearchResult r = serviceAt(root, "READ").search("关键词", "");
        assertEquals(List.of("Main.java"),
                r.hits().stream().map(WorkspaceService.Hit::path).toList(),
                "node_modules / target 里的命中会把真正的源码挤出上限");
    }

    /** 不在白名单里的扩展名，搜索也不能读 —— 否则搜索就成了绕过白名单的读取路径。 */
    @Test
    void 搜索不得读到白名单外的文件(@TempDir Path root) throws IOException {
        seed(root, "Main.java", "password 出现在源码里");
        seed(root, ".env", "DB_PASSWORD=hunter2");
        seed(root, "id_rsa", "PRIVATE KEY hunter2");

        WorkspaceService.SearchResult r = serviceAt(root, "READ").search("hunter2", "");
        assertEquals(List.of(), r.hits(),
                "搜索命中会把整行内容返回给模型。.env / id_rsa 不在扩展名白名单里，"
                        + "如果搜索能读它们，白名单就只挡住了「点开」这一条路");
    }

    /**
     * 命中到顶时必须<b>说出来</b>。
     *
     * <p>「找到 80 条」和「至少 80 条，没找完」是两件事：模型按前者会得出
     * 「这个方法只在 80 处被调用」这样的结论，而那是错的。
     */
    @Test
    void 命中截断必须被如实报告(@TempDir Path root) throws IOException {
        StringBuilder many = new StringBuilder();
        for (int i = 0; i < 40; i++) {
            many.append("命中行 ").append(i).append('\n');
        }
        seed(root, "A.java", many.toString());
        seed(root, "B.java", many.toString());

        WorkspaceProperties p = props(root, "READ");
        p.setMaxSearchHits(10);
        WorkspaceService.SearchResult r = new WorkspaceService(p, "127.0.0.1").search("命中行", "");

        assertEquals(10, r.hits().size(), "必须按上限截断");
        assertTrue(r.truncated(), "截断了却报告 truncated=false —— 模型会把它当成全部");
    }

    /** 超长行要截断：压缩过的 .js 一行可能有几十万字符，原样返回会挤爆上下文。 */
    @Test
    void 超长命中行要截断(@TempDir Path root) throws IOException {
        seed(root, "bundle.js", "x".repeat(5000) + "关键词" + "y".repeat(5000));

        WorkspaceProperties p = props(root, "READ");
        p.setMaxSearchLineChars(100);
        WorkspaceService.SearchResult r = new WorkspaceService(p, "127.0.0.1").search("关键词", "");

        assertEquals(1, r.hits().size());
        assertTrue(r.hits().get(0).text().length() < 200,
                "超长行必须截断，实际长度 " + r.hits().get(0).text().length());
    }

    /** 空关键词要明确拒绝，而不是把整个工作区都当成命中返回。 */
    @Test
    void 空关键词必须被拒(@TempDir Path root) throws IOException {
        seed(root, "Main.java", "class Main {}");
        WorkspaceService service = serviceAt(root, "READ");
        assertThrows(BusinessException.class, () -> service.search("", ""));
        assertThrows(BusinessException.class, () -> service.search("   ", ""));
        assertThrows(BusinessException.class, () -> service.search(null, ""));
    }

    /**
     * 截断判定的两条边 —— 这两条是同一个 off-by-one 的两面。
     *
     * <h2>第一版两边都错</h2>
     *
     * <p>收集时卡在「满 max 条就不再收」，循环里用 {@code size() >= max} 判截断。于是：
     *
     * <ul>
     *   <li><b>正好 max 条</b>（其实已经找全了）→ 下一轮循环一进来就判成截断，误报</li>
     *   <li><b>在最后一个文件上撞到上限</b> → 循环没有下一轮了，而循环后那句收口写的是
     *       {@code size() > max}，收集时既然卡死在 max，它永远不成立 → 漏报</li>
     * </ul>
     *
     * <p>漏报是更糟的那个：模型拿到 80 条会写下「这个方法只在这 80 处被调用」，
     * 而那句话是错的，日志里什么都看不出来。
     *
     * <p>现在的做法是多收一条：有没有第 {@code max+1} 条，才是「还有没有」的准确回答。
     */
    @Test
    void 正好到上限不算截断(@TempDir Path root) throws IOException {
        StringBuilder exactly = new StringBuilder();
        for (int i = 0; i < 10; i++) {
            exactly.append("命中行 ").append(i).append('\n');
        }
        seed(root, "Only.java", exactly.toString());

        WorkspaceProperties p = props(root, "READ");
        p.setMaxSearchHits(10);
        WorkspaceService.SearchResult r = new WorkspaceService(p, "127.0.0.1").search("命中行", "");

        assertEquals(10, r.hits().size());
        assertFalse(r.truncated(),
                "一共就 10 条、上限也是 10 条 —— 已经找全了，报成截断会让用户白换关键词重搜");
    }

    @Test
    void 在最后一个文件上截断也要报出来(@TempDir Path root) throws IOException {
        // 只有一个文件，命中数超过上限：撞上限时循环已经没有下一轮了。
        StringBuilder many = new StringBuilder();
        for (int i = 0; i < 25; i++) {
            many.append("命中行 ").append(i).append('\n');
        }
        seed(root, "Only.java", many.toString());

        WorkspaceProperties p = props(root, "READ");
        p.setMaxSearchHits(10);
        WorkspaceService.SearchResult r = new WorkspaceService(p, "127.0.0.1").search("命中行", "");

        assertEquals(10, r.hits().size(), "必须按上限截断");
        assertTrue(r.truncated(),
                "截断发生在最后一个文件上时同样要报告 —— 漏报会让模型把 10 条当成全部，"
                        + "然后写下「只有这 10 处用到」这种错误结论");
    }
}
