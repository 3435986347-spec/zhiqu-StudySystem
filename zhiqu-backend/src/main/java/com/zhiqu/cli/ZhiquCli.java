package com.zhiqu.cli;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.Console;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Stream;

/**
 * {@code zhiqu} —— 命令行里的 coding agent。
 *
 * <h2>它只是一个客户端</h2>
 *
 * <p>后端就是桌面应用里那一个（{@code 127.0.0.1:47615}）：同一个库、同一个账号、同一条 agent 流水线。
 * CLI 不自己调模型、不自己读写磁盘、不自己跑命令 —— 那些都走后端已经加固过的路
 * （工作区六道路径判定、草稿 → 确认 → 落盘、执行沙箱不继承环境变量……）。
 * 在这里另写一套，就是第二份安全规则，而第二份迟早比第一份松。
 *
 * <p>它做的事：登录一次（令牌存 {@code ~/.zhiqu/cli-token}，600 权限）；把<b>当前目录</b>设成工作区；
 * 用「代码」模式发消息；把 coding agent 的每一步画出来；草稿在终端里看 diff，按 y 才落盘。
 *
 * <h2>启动</h2>
 *
 * <p>应用包里的 {@code bin/zhiqu} 脚本用应用自带的 JRE 拉起本类（不启动 Spring）。
 * 后端没在运行时，本类用同一份 JRE 和 JAR 在后台把它拉起来，参数与原生外壳一致 ——
 * 之后再打开图形界面，外壳的单实例检测会直接连上这个后端。
 */
public final class ZhiquCli {

    static final String VERSION = "1.0";
    static final String DEFAULT_SERVER = "http://127.0.0.1:47615";
    static final String NOTEBOOK_TITLE = "命令行";

    private final PrintStream out;
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .version(HttpClient.Version.HTTP_1_1)
            .build();
    private final Path home = Paths.get(System.getProperty("user.home"));
    private final Path stateDir = home.resolve(".zhiqu");
    private final boolean color;
    private final CliRenderer paint;

    private String server = DEFAULT_SERVER;
    private String token;
    private Long notebookId;
    private Long modelId;

    ZhiquCli(PrintStream out, boolean color) {
        this.out = out;
        this.color = color;
        this.paint = new CliRenderer(out, color);
    }

    public static void main(String[] args) {
        boolean color = System.console() != null && System.getenv("NO_COLOR") == null
                && !"dumb".equals(System.getenv("TERM"));
        PrintStream stdout = new PrintStream(System.out, true, StandardCharsets.UTF_8);
        System.exit(new ZhiquCli(stdout, color).run(args));
    }

    int run(String[] args) {
        Options o;
        try {
            o = Options.parse(args);
        } catch (IllegalArgumentException e) {
            out.println(paint.red(e.getMessage()));
            out.println(USAGE);
            return 2;
        }
        if (o.help) {
            out.println(USAGE);
            return 0;
        }
        if (o.version) {
            out.println("zhiqu " + VERSION);
            return 0;
        }
        if (o.server != null) server = stripSlash(o.server);
        else if (System.getenv("ZHIQU_SERVER") != null) server = stripSlash(System.getenv("ZHIQU_SERVER"));
        modelId = o.model;
        try {
            if ("logout".equals(o.command)) {
                Files.deleteIfExists(tokenFile());
                out.println("已退出登录（删除了 " + tokenFile() + "）");
                return 0;
            }
            if ("stop".equals(o.command)) {
                return stopBackend();
            }
            // 纯本地就能判断的拒绝放在最前面：不该让人先输完密码、等完后端启动，才被告知这里不能用
            Path cwd = Paths.get("").toAbsolutePath().normalize();
            String refusal = broadRootRefusal(cwd, home);
            if (refusal != null && !o.allowBroadRoot && !"login".equals(o.command)) {
                out.println(paint.red(refusal));
                return 2;
            }
            ensureBackend();
            if ("login".equals(o.command)) {
                login();
                return 0;
            }
            ensureLogin();
            if (!setupWorkspace(cwd, o.mode)) {
                return 2;
            }
            notebookId = ensureNotebook();
            if (!announceModel()) {
                return 2;
            }
            if (o.prompt != null) {
                turn(o.prompt);
                return 0;
            }
            repl();
            return 0;
        } catch (CliError e) {
            out.println(paint.red("✗ " + e.getMessage()));
            return 1;
        } catch (Unauthorized e) {
            out.println(paint.red("✗ 登录已过期或没有权限 —— 运行 zhiqu login 重新登录"));
            return 1;
        } catch (IOException e) {
            out.println(paint.red("✗ " + e.getMessage()));
            return 1;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return 130;
        }
    }

    // ── 工作区 ────────────────────────────────────────────────────────────

    /**
     * 当前目录太宽时拒绝把它当工作区：根目录、家目录。
     *
     * <p>工作区里的每一个可读文件都可能被读进模型上下文。在家目录下敲一句 {@code zhiqu}，
     * 等于把整个家目录交出去 —— 白名单挡得住 {@code .env} / {@code id_rsa}，挡不住你的日记和论文。
     * 真要这么用，加 {@code --allow-broad-root} 明说。
     */
    static String broadRootRefusal(Path cwd, Path home) {
        Path c = cwd.toAbsolutePath().normalize();
        if (c.getParent() == null) {
            return "不在根目录 / 下开工作区：那会把整块磁盘交给 agent。cd 到一个项目文件夹再运行（或加 --allow-broad-root）。";
        }
        if (c.equals(home.toAbsolutePath().normalize())) {
            return "不在家目录下开工作区：那会把你所有的文件交给 agent。cd 到一个项目文件夹再运行（或加 --allow-broad-root）。";
        }
        return null;
    }

    private boolean setupWorkspace(Path cwd, String modeFlag) throws IOException, InterruptedException {
        JsonNode s = call("GET", "/api/workspace/settings", null);
        String selected = s.path("selectedMode").asText("OFF");
        String mode = modeFlag != null ? modeFlag : ("OFF".equals(selected) ? "WRITE" : selected);
        String root = cwd.toString();
        if (!mode.equals(selected) || !root.equals(s.path("selectedRoot").asText(""))) {
            ObjectNode body = json.createObjectNode().put("mode", mode).put("root", root);
            s = call("PUT", "/api/workspace/settings", body);
        }
        String effective = s.path("effectiveMode").asText("OFF");
        if ("OFF".equals(effective)) {
            out.println(paint.red("✗ 工作区没有生效：" + s.path("reason").asText("原因未知")));
            return false;
        }
        out.println(paint.dim("zhiqu " + VERSION + " · " + server));
        out.println("📁 " + cwd.getFileName() + "/  " + paint.dim(root));
        out.println(paint.dim("档位：" + MODE_LABEL.getOrDefault(effective, effective)
                + "（网页里的工作区也跟着切到了这个文件夹）· /help 查看命令"));
        return true;
    }

    static final Map<String, String> MODE_LABEL = Map.of(
            "OFF", "未启用", "READ", "只读", "WRITE", "读+写（草稿确认后落盘）", "EXEC", "读+写+运行");

    private Long ensureNotebook() throws IOException, InterruptedException {
        JsonNode list = call("GET", "/api/ai/notebooks", null);
        for (JsonNode n : list) {
            if (NOTEBOOK_TITLE.equals(n.path("title").asText())) {
                return n.path("id").asLong();
            }
        }
        ObjectNode body = json.createObjectNode()
                .put("title", NOTEBOOK_TITLE)
                .put("description", "zhiqu 命令行里的对话。网页里切到这个 Notebook 也能看到。");
        return call("POST", "/api/ai/notebooks", body).path("id").asLong();
    }

    // ── 对话 ──────────────────────────────────────────────────────────────

    private void repl() throws IOException, InterruptedException {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        while (true) {
            out.print(paint.green("\n› "));
            out.flush();
            String line = readMessage(in);
            if (line == null) {
                out.println();
                return;
            }
            String msg = line.trim();
            if (msg.isEmpty()) continue;
            if (msg.startsWith("/")) {
                if (!command(msg)) return;
                continue;
            }
            turn(msg);
        }
    }

    /** 读一条消息；行尾是反斜杠就接着读下一行（多行输入）。EOF 返回 null。 */
    static String readMessage(BufferedReader in) throws IOException {
        StringBuilder sb = new StringBuilder();
        while (true) {
            String l = in.readLine();
            if (l == null) return sb.length() == 0 ? null : sb.toString();
            if (l.endsWith("\\")) {
                sb.append(l, 0, l.length() - 1).append('\n');
                continue;
            }
            return sb.append(l).toString();
        }
    }

    /** 斜杠命令。返回 false 表示退出。 */
    private boolean command(String cmd) throws IOException, InterruptedException {
        String[] parts = cmd.split("\\s+", 2);
        String arg = parts.length > 1 ? parts[1].trim() : "";
        switch (parts[0]) {
            case "/exit", "/quit" -> {
                return false;
            }
            case "/help" -> out.println(REPL_HELP);
            case "/mode" -> {
                String m = arg.toUpperCase(Locale.ROOT);
                if (!List.of("READ", "WRITE", "EXEC").contains(m)) {
                    out.println(paint.yellow("用法：/mode read | write | exec"));
                } else {
                    setupWorkspace(Paths.get("").toAbsolutePath().normalize(), m);
                }
            }
            case "/model" -> {
                List<CliModels.Model> models = CliModels.parse(call("GET", "/api/ai/models", null));
                if (arg.isEmpty()) {
                    CliModels.Model now = CliModels.effective(models, modelId);
                    for (CliModels.Model m : models) {
                        out.println((now != null && m.id() == now.id() ? paint.green("* ") : "  ") + m.id() + "  "
                                + describe(m) + (m.knownNoToolCalling() ? paint.yellow("  （不支持工具调用）") : ""));
                    }
                    if (models.isEmpty()) {
                        out.println(paint.yellow("  还没有可用的模型 —— 先在个人中心配置一个"));
                    }
                    out.println(paint.dim("/model <id> 切换（只对这次会话有效），/model default 回到默认"));
                } else {
                    Long wanted;
                    try {
                        wanted = "default".equals(arg) ? null : Long.valueOf(arg);
                    } catch (NumberFormatException e) {
                        out.println(paint.yellow("用法：/model <id> 或 /model default"));
                        return true;
                    }
                    CliModels.Model m = CliModels.effective(models, wanted);
                    if (m == null) {
                        // 不校验的话，下一句话发出去才被后端拒 —— 那时用户已经在等回答了
                        out.println(paint.red("没有 id 为 " + arg + " 的可用模型（/model 查看列表）"));
                    } else {
                        modelId = wanted;
                        out.println(paint.dim("已切换到 ") + describe(m));
                        warnIfNoToolCalling(m);
                    }
                }
            }
            case "/drafts" -> reviewDrafts(null);
            default -> out.println(paint.yellow("不认识的命令：" + parts[0] + "（/help 查看）"));
        }
        return true;
    }

    /**
     * 启动时说清这一轮用的是哪个模型，并在它不支持工具调用时明说。
     *
     * <p>coding agent 需要工具调用（读文件、写草稿、跑命令都是工具）。Ollama / Gemini 不支持时，
     * 后端连 CODE_AGENT 节点都不会造 —— 用户看到的是一个只会聊天、说「我没法读你的文件」的助手，
     * 而没有任何一处告诉他为什么。{@code toolCalling} 由后端给出，这里只负责说出来。
     *
     * @return false 表示 {@code --model} 指定的 id 不存在，应当退出
     */
    private boolean announceModel() throws IOException, InterruptedException {
        List<CliModels.Model> models = CliModels.parse(call("GET", "/api/ai/models", null));
        CliModels.Model m = CliModels.effective(models, modelId);
        if (m == null && modelId != null) {
            out.println(paint.red("✗ 没有 id 为 " + modelId + " 的可用模型。去掉 --model 用默认模型，或进会话后 /model 查看列表。"));
            return false;
        }
        if (m == null) {
            out.println(paint.yellow("还没有可用的模型：先在个人中心（网页或桌面应用）配置一个，再回来用 zhiqu。"));
            return true;
        }
        out.println(paint.dim("模型：") + describe(m) + paint.dim(modelId == null ? "（默认）" : ""));
        warnIfNoToolCalling(m);
        return true;
    }

    private static String describe(CliModels.Model m) {
        return m.label() + (m.modelName().isEmpty() || m.modelName().equals(m.label()) ? "" : "（" + m.modelName() + "）")
                + (m.system() ? " · 系统" : "");
    }

    private void warnIfNoToolCalling(CliModels.Model m) {
        if (m.knownNoToolCalling()) {
            out.println(paint.yellow("⚠ 这个模型不支持工具调用：coding agent 不会读写你的代码、也不会跑命令，只能聊天。"
                    + "换一个 OpenAI 兼容或 Anthropic 的模型（/model）。"));
        }
    }

    private void turn(String message) throws IOException, InterruptedException {
        CliRenderer r = new CliRenderer(out, color);
        ObjectNode body = json.createObjectNode();
        body.put("message", message);
        if (modelId == null) body.putNull("modelConfigId"); else body.put("modelConfigId", modelId);
        body.put("enableWebSearch", false);
        body.put("reasoningMode", "OFF");
        body.put("notebookId", notebookId);
        body.put("agentMode", "AUTO");
        ObjectNode ctx = body.putObject("contextOptions");
        ctx.put("includeWiki", false);
        ctx.putArray("selectedSourceIds");
        // 命令行里就是来写代码的：显式开关，不靠关键词猜（见 ContextOptionKeys.CODE_MODE）
        ctx.put("codeMode", true);
        stream("/api/ai/chat/stream", body, r);
        if (r.agentRunId() != null && !r.artifactIds().isEmpty()) {
            reviewDrafts(r.agentRunId());
        }
    }

    // ── 草稿：看 diff，按 y 落盘 ───────────────────────────────────────────

    /**
     * 取这一轮（或最近几轮）还没处理的代码草稿，画 diff，问要不要写。
     *
     * <p>写盘走的是和网页确认框<b>同一个</b>端点（{@code /api/ai/artifacts/{id}/confirm}）：
     * 基线校验、成批要么全写要么全不写、原子改名，全在后端。这里只负责给人看、问人要不要。
     */
    private void reviewDrafts(Long runId) throws IOException, InterruptedException {
        List<JsonNode> runs = new ArrayList<>();
        if (runId != null) {
            runs.add(call("GET", "/api/ai/agent-runs/" + runId, null));
        } else {
            int seen = 0;
            for (JsonNode r : call("GET", "/api/ai/agent-runs?notebookId=" + notebookId, null)) {
                if (++seen > 5) break;   // 只翻最近几轮 —— 更早的草稿去网页里处理
                runs.add(call("GET", "/api/ai/agent-runs/" + r.path("id").asLong(), null));
            }
        }
        int otherDrafts = 0;
        boolean any = false;
        for (JsonNode run : runs) {
            for (JsonNode a : run.path("artifacts")) {
                String status = a.path("status").asText("").toUpperCase(Locale.ROOT);
                boolean pending = "DRAFT".equals(status) || "PENDING".equals(status);
                if (!pending) continue;
                if (!"CODE_DRAFT".equals(a.path("artifactType").asText())) {
                    otherDrafts++;
                    continue;
                }
                any = true;
                if (!reviewCodeDraft(a)) return;
            }
        }
        if (otherDrafts > 0) {
            out.println(paint.dim("另有 " + otherDrafts + " 个其它草稿（计划 / Wiki / 记忆），到网页的 AI 助手里确认。"));
        }
        if (!any && runId == null) {
            out.println(paint.dim("没有待确认的代码草稿。"));
        }
    }

    /** 返回 false 表示用户中途退出（EOF）。 */
    private boolean reviewCodeDraft(JsonNode artifact) throws IOException, InterruptedException {
        JsonNode files = artifact.path("content").path("files");
        out.println();
        out.println(paint.yellow("── 代码草稿 #" + artifact.path("id").asLong() + "：" + files.size() + " 个文件（还没写到磁盘上）"));
        for (JsonNode f : files) {
            String path = f.path("path").asText();
            boolean creating = f.path("creating").asBoolean(false);
            String now = creating ? "" : readWorkspaceFile(path);
            out.println(paint.cyan("── " + path + (creating ? "（新建）" : "（修改）")));
            List<String> lines = LineDiff.hunks(now, f.path("content").asText(""), 3);
            if (lines.isEmpty()) out.println(paint.dim("   （内容没有变化）"));
            for (String l : lines) {
                if (l.startsWith("@@")) out.println(paint.dim(l));
                else if (l.startsWith("+")) out.println(paint.green(l));
                else if (l.startsWith("-")) out.println(paint.red(l));
                else out.println(l);
            }
        }
        Console console = System.console();
        if (console == null) {
            out.println(paint.dim("（不是交互终端：草稿先放着，可以在网页里确认，或在终端里用 /drafts）"));
            return true;
        }
        String answer = console.readLine("写入这 %d 个文件？ [y] 写入  [n] 丢弃  [回车] 先放着 › ", files.size());
        if (answer == null) return false;
        long id = artifact.path("id").asLong();
        switch (answer.trim().toLowerCase(Locale.ROOT)) {
            case "y", "yes", "是" -> {
                try {
                    call("POST", "/api/ai/artifacts/" + id + "/confirm", null);
                    out.println(paint.green("✓ 已写入 " + files.size() + " 个文件"));
                } catch (CliError e) {
                    // 基线不符（文件在你看 diff 的时候被改了）等：后端拒绝整批，一个字节都没写
                    out.println(paint.red("✗ 没有写入：" + e.getMessage()));
                }
            }
            case "n", "no", "否" -> {
                call("POST", "/api/ai/artifacts/" + id + "/discard", null);
                out.println(paint.dim("已丢弃这份草稿"));
            }
            default -> out.println(paint.dim("先放着。之后用 /drafts 再看，或在网页的 AI 助手里确认。"));
        }
        return true;
    }

    private String readWorkspaceFile(String path) throws IOException, InterruptedException {
        try {
            return call("GET", "/api/workspace/file?path=" + URLEncoder.encode(path, StandardCharsets.UTF_8), null)
                    .path("content").asText("");
        } catch (CliError e) {
            return "";
        }
    }

    // ── 登录 ──────────────────────────────────────────────────────────────

    private Path tokenFile() {
        return stateDir.resolve("cli-token");
    }

    private void ensureLogin() throws IOException, InterruptedException {
        String env = System.getenv("ZHIQU_TOKEN");
        if (env != null && !env.isBlank()) {
            token = env.trim();
            return;
        }
        if (Files.exists(tokenFile())) {
            token = Files.readString(tokenFile(), StandardCharsets.UTF_8).trim();
            try {
                call("GET", "/api/ai/notebooks", null);
                return;
            } catch (Unauthorized e) {
                out.println(paint.yellow("登录已过期，重新登录一次。"));
            }
        }
        login();
    }

    /**
     * 在终端里问用户名和密码，换一个令牌存下来。
     *
     * <p>密码用 {@link Console#readPassword} 读 —— 不回显、不进 shell 历史、不落盘；
     * 落盘的只有换来的令牌（600 权限）。不是交互终端时拒绝，而不是去读 stdin：
     * 从管道里读密码的脚本迟早会把它写进某个日志。
     */
    private void login() throws IOException, InterruptedException {
        Console console = System.console();
        if (console == null) {
            throw new CliError("需要在终端里交互登录（或者设置环境变量 ZHIQU_TOKEN）");
        }
        out.println("登录知趣（和网页、桌面应用是同一个账号）");
        String user = console.readLine("用户名：");
        char[] pass = console.readPassword("密码：");
        if (user == null || pass == null) throw new CliError("登录已取消");
        ObjectNode body = json.createObjectNode()
                .put("username", user.trim())
                .put("password", new String(pass))
                .put("rememberMe", true);
        java.util.Arrays.fill(pass, '\0');
        token = null;
        String t = call("POST", "/api/auth/login", body).path("token").asText("");
        if (t.isEmpty()) throw new CliError("登录没有返回令牌");
        token = t;
        Files.createDirectories(stateDir);
        Path f = tokenFile();
        Files.writeString(f, t, StandardCharsets.UTF_8);
        try {
            Files.setPosixFilePermissions(f, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException ignored) {
            // Windows 上没有 POSIX 权限；文件在用户自己的目录里
        }
        out.println(paint.green("✓ 已登录，30 天内不用再输密码"));
    }

    // ── 后端 ──────────────────────────────────────────────────────────────

    private boolean reachable() {
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(server + "/index.html"))
                    .method("HEAD", HttpRequest.BodyPublishers.noBody())
                    .timeout(Duration.ofMillis(1500)).build();
            return http.send(req, HttpResponse.BodyHandlers.discarding()).statusCode() == 200;
        } catch (Exception e) {
            return false;
        }
    }

    private Path pidFile() {
        return stateDir.resolve("cli-backend.pid");
    }

    /**
     * 后端没在运行就在后台拉起来 —— 只在连的是默认地址、且知道应用的 JRE 和 JAR 在哪时。
     *
     * <p>用 {@code sh -c 'nohup … &'} 起：非交互 shell 的后台命令会忽略 SIGINT，nohup 再忽略 SIGHUP ——
     * 于是你在终端里按 Ctrl+C、或者关掉终端，都不会把后端一起带走（它和 CLI 在同一个进程组里，
     * 直接 ProcessBuilder 起的话 Ctrl+C 会同时杀掉两个）。停掉它用 {@code zhiqu stop}。
     */
    private void ensureBackend() throws IOException, InterruptedException {
        if (reachable()) return;
        String java = System.getProperty("zhiqu.cli.java");
        String jar = System.getProperty("zhiqu.cli.jar");
        boolean windows = System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
        if (!DEFAULT_SERVER.equals(server) || java == null || jar == null || windows) {
            throw new CliError("连不上 " + server + " —— 先打开知趣象限应用，再运行 zhiqu");
        }
        Files.createDirectories(stateDir.resolve("logs"));
        Path log = stateDir.resolve("logs").resolve("backend-cli.log");
        Path portFile = Files.createTempFile("zhiqu-port-cli", ".txt");
        Files.deleteIfExists(portFile);
        List<String> cmd = new ArrayList<>(List.of("/bin/sh", "-c",
                "nohup \"$@\" >\"$ZHIQU_LOG\" 2>&1 & echo $!", "sh",
                java,
                "-Dspring.profiles.active=desktop",
                "-Dserver.port=47615",
                "-Dfile.encoding=UTF-8",
                "-Djava.awt.headless=true",
                "-Dzhiqu.desktop.port-file=" + portFile,
                "-Xmx1g",
                "-jar", jar));
        ProcessBuilder pb = new ProcessBuilder(cmd).directory(home.toFile());
        pb.environment().put("ZHIQU_LOG", log.toString());
        pb.redirectErrorStream(true);
        Process sh = pb.start();
        String pid = new String(sh.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        sh.waitFor();
        if (!pid.isEmpty()) {
            Files.writeString(pidFile(), pid, StandardCharsets.UTF_8);
        }
        out.print(paint.dim("知趣后端没在运行，正在后台启动（日志：" + log + "）"));
        out.flush();
        long deadline = System.currentTimeMillis() + 120_000L;
        while (System.currentTimeMillis() < deadline) {
            if (reachable()) {
                out.println(paint.green(" ✓"));
                return;
            }
            out.print(paint.dim("."));
            out.flush();
            Thread.sleep(1000);
        }
        out.println();
        throw new CliError("后端两分钟内没起来，看看日志：" + log);
    }

    /** 只停<b>本 CLI 拉起的</b>那个后端（记在 pid 文件里）。图形界面起的那个不动。 */
    private int stopBackend() throws IOException {
        if (!Files.exists(pidFile())) {
            out.println("没有由 zhiqu 在后台启动的后端（图形界面启动的那个请直接退出应用）。");
            return 0;
        }
        long pid = Long.parseLong(Files.readString(pidFile(), StandardCharsets.UTF_8).trim());
        var handle = ProcessHandle.of(pid);
        boolean ours = handle.flatMap(h -> h.info().commandLine())
                .map(c -> c.contains("zhiqu.desktop.port-file")).orElse(false);
        if (handle.isPresent() && ours) {
            handle.get().destroy();
            out.println("已停止后台的知趣后端（pid " + pid + "）");
        } else {
            out.println("pid " + pid + " 已经不是我们启动的后端了，什么也没做。");
        }
        Files.deleteIfExists(pidFile());
        return 0;
    }

    // ── HTTP ──────────────────────────────────────────────────────────────

    static final class CliError extends RuntimeException {
        CliError(String message) {
            super(message);
        }
    }

    static final class Unauthorized extends RuntimeException {
        Unauthorized() {
            super("未登录或登录已过期");
        }
    }

    private HttpRequest.Builder request(String path) {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(server + path))
                .header("User-Agent", userAgent())
                .header("Content-Type", "application/json");
        if (token != null) b.header("Authorization", "Bearer " + token);
        return b;
    }

    /** 登录设备列表靠它认出「这是命令行」—— 见 zhiqu-api.js 的 shortUA。 */
    static String userAgent() {
        return CliUserAgent.current();
    }

    /** 发一个普通请求，拆开 {@code Result<T>}：code ≠ 200 抛 {@link CliError}，返回 data。 */
    private JsonNode call(String method, String path, Object body) throws IOException, InterruptedException {
        HttpRequest.BodyPublisher pub = body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body), StandardCharsets.UTF_8);
        HttpRequest req = request(path).method(method, pub).timeout(Duration.ofSeconds(60)).build();
        HttpResponse<String> res;
        try {
            res = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (java.net.ConnectException e) {
            throw new CliError("连不上 " + server + "（后端停了？）");
        }
        if (res.statusCode() == 401 || res.statusCode() == 403) throw new Unauthorized();
        JsonNode node;
        try {
            node = json.readTree(res.body());
        } catch (IOException e) {
            throw new CliError("后端返回了看不懂的内容（HTTP " + res.statusCode() + "）");
        }
        if (node.path("code").asInt(res.statusCode()) != 200) {
            throw new CliError(node.path("message").asText("请求失败（HTTP " + res.statusCode() + "）"));
        }
        return node.path("data");
    }

    private void stream(String path, Object body, CliRenderer r) throws IOException, InterruptedException {
        HttpRequest req = request(path)
                .header("Accept", "text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body), StandardCharsets.UTF_8))
                .timeout(Duration.ofMinutes(6))
                .build();
        HttpResponse<Stream<String>> res = http.send(req, HttpResponse.BodyHandlers.ofLines());
        if (res.statusCode() == 401 || res.statusCode() == 403) throw new Unauthorized();
        SseParser parser = new SseParser(ev -> {
            JsonNode data;
            try {
                data = json.readTree(ev.data());
            } catch (IOException e) {
                data = json.createObjectNode().put("text", ev.data());
            }
            r.onEvent(ev.name(), data);
        });
        try (Stream<String> lines = res.body()) {
            lines.forEach(parser::line);
        }
        parser.end();
    }

    // ── 参数 ──────────────────────────────────────────────────────────────

    static final class Options {
        String command;
        String prompt;
        String mode;
        String server;
        Long model;
        boolean allowBroadRoot;
        boolean help;
        boolean version;

        static Options parse(String[] args) {
            Options o = new Options();
            for (int i = 0; i < args.length; i++) {
                String a = args[i];
                switch (a) {
                    case "-h", "--help" -> o.help = true;
                    case "-v", "--version" -> o.version = true;
                    case "--allow-broad-root" -> o.allowBroadRoot = true;
                    case "-p", "--print" -> o.prompt = need(args, ++i, a);
                    case "--server" -> o.server = need(args, ++i, a);
                    case "--model" -> o.model = Long.valueOf(need(args, ++i, a));
                    case "--mode" -> {
                        String m = need(args, ++i, a).toUpperCase(Locale.ROOT);
                        if (!List.of("READ", "WRITE", "EXEC").contains(m)) {
                            throw new IllegalArgumentException("--mode 只能是 read / write / exec");
                        }
                        o.mode = m;
                    }
                    case "login", "logout", "stop" -> {
                        if (o.command != null) throw new IllegalArgumentException("只能给一个子命令");
                        o.command = a;
                    }
                    default -> throw new IllegalArgumentException("不认识的参数：" + a);
                }
            }
            return o;
        }

        private static String need(String[] args, int i, String flag) {
            if (i >= args.length) throw new IllegalArgumentException(flag + " 后面要跟一个值");
            return args[i];
        }
    }

    static final String USAGE = """
            用法：zhiqu [选项]            在当前文件夹里开一个 coding agent 会话
                  zhiqu -p "消息"         只问一句就退出
                  zhiqu login | logout    登录 / 退出登录
                  zhiqu stop              停掉由 zhiqu 在后台启动的后端

            选项：
              --mode read|write|exec    工作区档位（默认沿用上次选的；从没开过则是 write）
              --model <id>              用哪个模型（/model 可在会话里查看和切换）
              --server <url>            后端地址（默认 http://127.0.0.1:47615，也可设 ZHIQU_SERVER）
              --allow-broad-root        允许在家目录或根目录下运行（默认拒绝）
            """;

    static final String REPL_HELP = """
              /mode read|write|exec   切换档位（写 = 草稿确认后落盘；运行 = 还能跑工作区里的文件）
              /model [id|default]     查看 / 切换模型
              /drafts                 再看一遍还没处理的代码草稿
              /exit                   退出（也可以按 Ctrl+D）
              行尾加 \\ 可以换行输入多行。""";

    private static String stripSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    private static String firstNonEmpty(String... xs) {
        for (String x : xs) if (x != null && !x.isEmpty()) return x;
        return "";
    }
}
