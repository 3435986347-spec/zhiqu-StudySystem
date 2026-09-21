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

    // ── 写入（阶段 2）────────────────────────────────────────────────────────

    private static WorkspaceService writableAt(Path root) {
        return new WorkspaceService(props(root, "WRITE"), "127.0.0.1");
    }

    /**
     * READ 档不许写。
     *
     * <p>这是档位这个设计存在的全部理由：用户把工作区开成只读，就该是一个字节都不会变。
     * 「能读就能写」在别处也许无害，在这里是直接改用户硬盘上的源码。
     */
    @Test
    void 只读档不许写(@TempDir Path root) throws IOException {
        seed(root, "Main.java", "class Main {}");
        WorkspaceService readOnly = serviceAt(root, "READ");
        String baseline = readOnly.baselineOf("Main.java");

        assertThrows(BusinessException.class, () -> readOnly.write("Main.java", "改过了", baseline),
                "READ 档下写入必须被拒");
        assertEquals("class Main {}", Files.readString(root.resolve("Main.java")),
                "被拒之后文件必须一个字节都没动");
    }

    /**
     * 基线不符就拒绝 —— 这一条挡的是「用旧内容覆盖掉用户刚改的东西」。
     *
     * <p>agent 读文件到用户点确认之间可能隔着几分钟。这段时间里用户完全可能在自己的
     * 编辑器里改了同一个文件。不校验的话，一个基于旧内容生成的改动会把新内容整份吃掉，
     * 而用户以为自己确认的只是「应用刚才那个建议」。与知识 Wiki 的 base_content_hash 同一条纪律。
     */
    @Test
    void 草稿生成之后文件被改过就不许写(@TempDir Path root) throws IOException {
        seed(root, "Main.java", "原始内容");
        WorkspaceService service = writableAt(root);
        String baseline = service.baselineOf("Main.java");     // agent 读到的那一刻

        Files.writeString(root.resolve("Main.java"), "用户自己改的内容");   // 中途被改

        BusinessException e = assertThrows(BusinessException.class,
                () -> service.write("Main.java", "基于旧内容生成的改动", baseline));
        assertTrue(e.getMessage().contains("Main.java") && e.getMessage().contains("改过"),
                "理由要点名是哪个文件、为什么拒 —— 用户得知道自己该重新生成。实际：" + e.getMessage());
        assertEquals("用户自己改的内容", Files.readString(root.resolve("Main.java")),
                "用户自己的改动必须原样还在");
    }

    /** 没记基线的草稿一律不许写 —— 「没有基线」不等于「基线通过」。 */
    @Test
    void 没有基线的草稿不许写(@TempDir Path root) throws IOException {
        seed(root, "Main.java", "原始内容");
        WorkspaceService service = writableAt(root);

        for (String noBaseline : new String[]{null, "", "   "}) {
            assertThrows(BusinessException.class, () -> service.write("Main.java", "x", noBaseline),
                    "基线为「" + noBaseline + "」时必须拒绝，不能当成校验通过");
        }
        assertEquals("原始内容", Files.readString(root.resolve("Main.java")));
    }

    /** 新建文件：基线是 ABSENT，写完内容要逐字一致。 */
    @Test
    void 新建文件要能写且内容逐字一致(@TempDir Path root) throws IOException {
        WorkspaceService service = writableAt(root);
        assertEquals(WorkspaceService.ABSENT, service.baselineOf("New.java"),
                "还不存在的文件基线必须是 ABSENT，而不是 null 或空串");

        String body = "class New {\n    // 中文注释\n}\n";
        service.write("New.java", body, WorkspaceService.ABSENT);
        assertEquals(body, Files.readString(root.resolve("New.java")));
    }

    /** 「新建」和「覆盖」是两件事：草稿说要新建，而文件已经被别人建出来了，要拒。 */
    @Test
    void 说好新建却已经存在要拒(@TempDir Path root) throws IOException {
        WorkspaceService service = writableAt(root);
        String baseline = service.baselineOf("New.java");      // ABSENT

        seed(root, "New.java", "别人先建的内容");

        BusinessException e = assertThrows(BusinessException.class,
                () -> service.write("New.java", "草稿内容", baseline));
        assertTrue(e.getMessage().contains("还不存在"),
                "理由要说清「生成草稿时它还不存在」。实际：" + e.getMessage());
        assertEquals("别人先建的内容", Files.readString(root.resolve("New.java")));
    }

    /** 文件在确认之前被删掉了，也要拒 —— 不能把它悄悄复活。 */
    @Test
    void 文件已被删除则草稿不能再应用(@TempDir Path root) throws IOException {
        seed(root, "Main.java", "原始内容");
        WorkspaceService service = writableAt(root);
        String baseline = service.baselineOf("Main.java");

        Files.delete(root.resolve("Main.java"));

        BusinessException e = assertThrows(BusinessException.class,
                () -> service.write("Main.java", "草稿内容", baseline));
        assertTrue(e.getMessage().contains("已经被删除"), "实际：" + e.getMessage());
        assertFalse(Files.exists(root.resolve("Main.java")), "被拒之后不该把文件复活");
    }

    /** 写入也要守白名单 —— 否则它就是一条覆盖 .env / id_rsa 的路径。 */
    @Test
    void 写入不得碰白名单外的文件(@TempDir Path root) throws IOException {
        seed(root, ".env", "DB_PASSWORD=hunter2");
        WorkspaceService service = writableAt(root);

        assertThrows(BusinessException.class, () -> service.baselineOf(".env"));
        assertThrows(BusinessException.class, () -> service.write(".env", "被改写", "任意基线"));
        assertEquals("DB_PASSWORD=hunter2", Files.readString(root.resolve(".env")));
    }

    /** 写入不得跳出工作区。 */
    @Test
    void 写入不得跳出工作区(@TempDir Path tmp) throws IOException {
        Path root = Files.createDirectory(tmp.resolve("ws"));
        Path outside = Files.createDirectory(tmp.resolve("outside"));
        Files.writeString(outside.resolve("target.java"), "工作区外");
        WorkspaceService service = writableAt(root);

        assertThrows(BusinessException.class,
                () -> service.write("../outside/target.java", "被改写", "任意基线"));
        assertEquals("工作区外", Files.readString(outside.resolve("target.java")));
    }

    /**
     * 上级目录不存在时报错，<b>不</b>替用户建目录。
     *
     * <p>模型把路径写成 {@code src/mian/java/Foo.java} 时，自动建目录会静默造出一棵
     * 没人要的目录树，而用户以为自己确认的是「改一个文件」。
     */
    @Test
    void 上级目录不存在时不自动创建(@TempDir Path root) {
        WorkspaceService service = writableAt(root);

        BusinessException e = assertThrows(BusinessException.class,
                () -> service.write("src/mian/java/Foo.java", "内容", WorkspaceService.ABSENT));
        assertTrue(e.getMessage().contains("上级目录"), "实际：" + e.getMessage());
        assertFalse(Files.exists(root.resolve("src")), "不该顺手造出目录树");
    }

    /** 超过上限的内容要拒，而且拒之前不许先把文件截断。 */
    @Test
    void 内容超上限要拒且不留半截文件(@TempDir Path root) throws IOException {
        seed(root, "Main.java", "原始内容");
        WorkspaceProperties p = props(root, "WRITE");
        p.setMaxFileBytes(64);
        WorkspaceService service = new WorkspaceService(p, "127.0.0.1");
        String baseline = service.baselineOf("Main.java");

        assertThrows(BusinessException.class, () -> service.write("Main.java", "x".repeat(500), baseline));
        assertEquals("原始内容", Files.readString(root.resolve("Main.java")),
                "被拒时原文件必须完好 —— 先截断再校验等于毁掉用户的源码");
    }

    /**
     * 写成功之后目录里只该有目标文件。
     *
     * <h2>这条绿证明了什么，没证明什么</h2>
     *
     * <p><b>证明了</b>：成功路径不漏临时文件 —— 如果有人把「写临时文件 + 原子改名」
     * 改成「复制 + 删原件」之类的写法，漏一步就会在用户的源码目录里留下 {@code .zhiqu-tmp}。
     *
     * <p><b>没证明</b>：{@code finally} 里那句清理。成功路径上 {@code Files.move} 已经把
     * 临时文件消耗掉了，{@code deleteIfExists} 本来就是空操作 —— 把它整句去掉，这条判据
     * 照样绿（2026-09-21 扰动实测）。它真正兜的是「写成功、改名失败」那条路径，
     * 而那条路径要靠让 {@code move} 失败才能触发，在不 mock 文件系统的前提下造不出来。
     *
     * <p>写在这里而不是假装覆盖到了：一条绿要说得清自己的边界，否则下一个人会以为
     * 清理逻辑有判据守着。
     */
    @Test
    void 写入不留临时文件(@TempDir Path root) throws IOException {
        WorkspaceService service = writableAt(root);
        service.write("New.java", "内容", WorkspaceService.ABSENT);

        try (java.util.stream.Stream<Path> files = Files.list(root)) {
            List<String> names = files.map(f -> f.getFileName().toString()).sorted().toList();
            assertEquals(List.of("New.java"), names,
                    "写完之后目录里只该有目标文件。实际：" + names);
        }
    }

    /**
     * 成批写入：一个文件过不了校验，<b>一个字节都不许落盘</b>。
     *
     * <p>逐个「校验并写」的话，第三个文件基线不符时前两个已经写进去了 ——
     * 用户看到一条报错，却不知道工作目录已经被改了一半，而那一半属于一个
     * 他并没有完整确认的方案。旧内容已经被覆盖，回滚也无从谈起。
     */
    @Test
    void 成批写入有一个过不了校验就全都不写(@TempDir Path root) throws IOException {
        seed(root, "A.java", "A 原始");
        seed(root, "B.java", "B 原始");
        seed(root, "C.java", "C 原始");
        WorkspaceService service = writableAt(root);
        String a = service.baselineOf("A.java");
        String b = service.baselineOf("B.java");
        String c = service.baselineOf("C.java");

        Files.writeString(root.resolve("C.java"), "C 被用户改过");    // 第三个的基线失效

        assertThrows(BusinessException.class, () -> service.writeAll(List.of(
                new WorkspaceService.PendingWrite("A.java", "A 新内容", a),
                new WorkspaceService.PendingWrite("B.java", "B 新内容", b),
                new WorkspaceService.PendingWrite("C.java", "C 新内容", c))));

        assertEquals("A 原始", Files.readString(root.resolve("A.java")),
                "第一个文件在校验阶段就该被拦住，不能已经落盘 —— 半批落盘是这条判据要挡的全部");
        assertEquals("B 原始", Files.readString(root.resolve("B.java")));
        assertEquals("C 被用户改过", Files.readString(root.resolve("C.java")));
    }

    /** 全部通过时成批写入要真的都写进去。 */
    @Test
    void 成批写入全部通过时逐字落盘(@TempDir Path root) throws IOException {
        seed(root, "A.java", "A 原始");
        WorkspaceService service = writableAt(root);

        service.writeAll(List.of(
                new WorkspaceService.PendingWrite("A.java", "A 新内容", service.baselineOf("A.java")),
                new WorkspaceService.PendingWrite("New.java", "新建的内容", WorkspaceService.ABSENT)));

        assertEquals("A 新内容", Files.readString(root.resolve("A.java")));
        assertEquals("新建的内容", Files.readString(root.resolve("New.java")));
    }

    /** 空批次要明确拒绝，而不是悄悄成功 —— 「确认了但什么都没发生」是最难查的那种。 */
    @Test
    void 空批次要被拒(@TempDir Path root) {
        WorkspaceService service = writableAt(root);
        assertThrows(BusinessException.class, () -> service.writeAll(List.of()));
        assertThrows(BusinessException.class, () -> service.writeAll(null));
    }
}
