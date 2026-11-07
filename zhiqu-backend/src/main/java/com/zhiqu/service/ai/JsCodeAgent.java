package com.zhiqu.service.ai;

import com.zhiqu.service.ai.stream.ReasoningEffort;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.common.Texts;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.harness.HarnessContext;
import com.zhiqu.service.harness.HarnessModelGateway;
import com.zhiqu.service.workspace.ArtifactFiles;
import com.zhiqu.service.workspace.WorkspaceExecutor;
import com.zhiqu.service.workspace.WorkspaceProperties;
import com.zhiqu.service.workspace.WorkspaceRegistry;
import com.zhiqu.service.workspace.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * 网页 / 桌面应用的代码模式跑命令行那一份循环（第九十四轮，用户 2026-11-02 定的「一份 JS，后端用子进程跑」）。
 *
 * <p>门（管理员、工作区档位、写意图、能不能执行、生产 profile）在 {@link CodeWorkspaceAgent#run} 里判完才到这里。
 * 这里起 node 跑 {@code zhiqu-cli/src/host/code-host.js}，一行一个 JSON：
 * <ul>
 *   <li>子进程请调模型 → {@link HarnessModelGateway}（同一个进程里调，温度、输出上限、不思考、上下文裁剪和命令行同一条路）；
 *       用哪个模型这里说了算，子进程给的 modelId 不认。</li>
 *   <li>子进程请跑命令 → {@link WorkspaceExecutor}（服务器上执行命令只有这一处；不能执行时这里直接回拒绝）。</li>
 *   <li>轨迹一步一句；收尾交回结论、草稿 —— 草稿的路径照写入规矩再判一遍，照旧成 CODE_DRAFT，用户确认才落盘。</li>
 * </ul>
 * 子进程不继承环境变量（HOME 是自己的临时目录、PATH 只有 node 那一个目录）；到了时间预算整组杀掉；协议里认不出的东西就停，不猜。
 * 第 1 步放在 {@code app.ai.code-agent.engine=js} 后面，默认还是 Java 的循环；起不来（没有 node、没有脚本）返回 null，调用方退回 Java 的循环。
 */
@Component
public class JsCodeAgent {

    private static final Logger log = LoggerFactory.getLogger(JsCodeAgent.class);
    /** 一行协议的上限：一份草稿最多几百 KB，再大就是出了错 */
    static final int MAX_LINE_CHARS = 8_000_000;
    static final String HOST_SCRIPT = "src/host/code-host.js";
    /** 沙箱只有一份实现（zhiqu-cli/src/tools/sandbox.js）：后端问这个脚本「这条命令怎么起」，不在 Java 里再写一份（第一百零九轮） */
    static final String SANDBOX_SCRIPT = "sandbox-launch.js";
    /** 不是秘密的工具链变量（和 sandbox.js 的 TOOLCHAIN_ENV 同一份）：mvn 要 JAVA_HOME，虚拟环境要 VIRTUAL_ENV。AI 密钥、数据库密码一律不传 */
    private static final List<String> TOOLCHAIN_ENV = List.of("JAVA_HOME", "GOROOT", "GOPATH", "GOMODCACHE", "CARGO_HOME", "RUSTUP_HOME",
            "PYENV_ROOT", "NVM_DIR", "VIRTUAL_ENV", "CONDA_PREFIX", "SDKROOT", "DEVELOPER_DIR", "LC_ALL", "LANG");

    private final ObjectProvider<HarnessModelGateway> gateway;
    private final WorkspaceRegistry workspaces;
    private final WorkspaceProperties workspaceProperties;
    private final ObjectMapper json;
    private final String node;
    private final String cliDir;

    public JsCodeAgent(ObjectProvider<HarnessModelGateway> gateway, WorkspaceRegistry workspaces,
                       WorkspaceProperties workspaceProperties, ObjectMapper json,
                       @Value("${app.ai.code-agent.node:node}") String node,
                       @Value("${app.ai.code-agent.cli-dir:}") String cliDir) {
        this.gateway = gateway;
        this.workspaces = workspaces;
        this.workspaceProperties = workspaceProperties;
        this.json = json;
        this.node = node == null || node.isBlank() ? "node" : node.trim();
        this.cliDir = cliDir == null ? "" : cliDir.trim();
    }

    /**
     * 命令行那份循环里的远程工具（第九十五轮：Wiki 工具、把里程碑排成任务）—— 照旧由 {@link CodeWorkspaceAgent} 那一套执行，这里只转。
     * 下发和执行同一份清单：{@link #always()} 一直给，{@link #afterRun()} 真的跑过一次命令才给（宿主每一轮重建工具表），{@link #call} 执行时照样核。
     */
    public interface RemoteTools {
        List<Map<String, Object>> always();

        List<Map<String, Object>> afterRun();

        String call(String name, String argsJson, boolean ranCommand);
    }

    /** 宿主脚本找得到（zhiqu-cli 目录或 JAR 里带的）；node 找不到时 run 返回 null */
    public boolean enabled() {
        return hostScript() != null;
    }

    /**
     * 宿主脚本。cli-dir 没配时按工作目录找 zhiqu-cli（第九十五轮：开发时从仓库根或 zhiqu-backend 起都找得到）；
     * 桌面应用的工作目录是 /、网页服务器部署没带命令行源码 —— 找不到就退回 Java 的循环（第 3 步打包之前桌面上照旧是 Java）。
     */
    Path hostScript() {
        List<Path> candidates = new ArrayList<>();
        if (!cliDir.isEmpty()) {
            candidates.add(Path.of(cliDir));
        } else {
            Path here = Path.of(System.getProperty("user.dir", ".")).toAbsolutePath();
            candidates.add(here.resolve("zhiqu-cli"));
            candidates.add(here.resolveSibling("zhiqu-cli"));
        }
        for (Path dir : candidates) {
            Path script = dir.toAbsolutePath().normalize().resolve(HOST_SCRIPT);
            if (Files.isRegularFile(script)) {
                return script;
            }
        }
        // 第九十六轮：都没有（桌面应用、网页服务器部署）就用 JAR 里带的那一份（pom 的 bundle-zhiqu-cli）
        Path bundledDir = bundledCliDir();
        return bundledDir == null ? null : bundledDir.resolve(HOST_SCRIPT);
    }

    /** JAR 里带的命令行源码解到临时目录 —— 解一次；没带（老 JAR）是 null */
    private volatile Path bundled;

    Path bundledCliDir() {
        Path known = bundled;
        if (known != null && Files.isRegularFile(known.resolve(HOST_SCRIPT))) {
            return known;
        }
        synchronized (this) {
            if (bundled != null && Files.isRegularFile(bundled.resolve(HOST_SCRIPT))) {
                return bundled;
            }
            try {
                org.springframework.core.io.Resource[] all = new org.springframework.core.io.support.PathMatchingResourcePatternResolver(
                        getClass().getClassLoader()).getResources("classpath*:zhiqu-cli/**");
                Path root = null;
                for (org.springframework.core.io.Resource r : all) {
                    String url = r.getURL().toString();
                    int at = url.lastIndexOf("/zhiqu-cli/");
                    String rel = at < 0 ? "" : java.net.URLDecoder.decode(url.substring(at + "/zhiqu-cli/".length()), StandardCharsets.UTF_8);
                    if (rel.isEmpty() || rel.endsWith("/") || !r.isReadable()) {
                        continue;   // 目录
                    }
                    if (root == null) {
                        root = Files.createTempDirectory("zhiqu-cli-");
                    }
                    Path target = root.resolve(rel).normalize();
                    if (!target.startsWith(root)) {
                        continue;
                    }
                    Files.createDirectories(target.getParent());
                    try (var in = r.getInputStream()) {
                        Files.copy(in, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                    }
                }
                bundled = root != null && Files.isRegularFile(root.resolve(HOST_SCRIPT)) ? root : null;
            } catch (IOException e) {
                log.warn("JAR 里带的命令行源码解不出来：{}", e.toString());
                bundled = null;
            }
            return bundled;
        }
    }

    /** node 的绝对路径：给的就是绝对路径就用它，否则从 PATH 里找；找不到是 null */
    String nodeBinary() {
        Path given = Path.of(node);
        if (given.isAbsolute()) {
            return Files.isExecutable(given) ? given.toString() : null;
        }
        String path = System.getenv("PATH");
        if (path == null) {
            return null;
        }
        boolean windows = System.getProperty("os.name", "").toLowerCase().contains("win");
        for (String dir : path.split(File.pathSeparator)) {
            for (String name : windows ? List.of(node + ".exe", node) : List.of(node)) {
                Path candidate = Path.of(dir, name);
                if (Files.isExecutable(candidate) && !Files.isDirectory(candidate)) {
                    return candidate.toAbsolutePath().toString();
                }
            }
        }
        return null;
    }

    /**
     * 跑一轮。起不来返回 null（调用方退回 Java 的循环）；起来了以后出什么错都只影响这一轮的代码上下文，不拖垮主回答。
     *
     * @param history 最近的对话（{@link CodeWorkspaceAgent#recentHistory} 截过的）
     */
    public CodeWorkspaceAgent.Result run(AiModelConfig config, Long userId, String userMessage, List<Map<String, Object>> history,
                                         boolean canWrite, boolean canExec, CodeLoopBudget budget, ContextBudget limits,
                                         Consumer<Map<String, Object>> onStep) {
        return run(config, userId, userMessage, history, canWrite, canExec, budget, limits, onStep, null);
    }

    public CodeWorkspaceAgent.Result run(AiModelConfig config, Long userId, String userMessage, List<Map<String, Object>> history,
                                         boolean canWrite, boolean canExec, CodeLoopBudget budget, ContextBudget limits,
                                         Consumer<Map<String, Object>> onStep, RemoteTools remote) {
        return run(config, userId, userMessage, history, canWrite, canExec, budget, limits, onStep, remote, ReasoningEffort.OFF);
    }

    public CodeWorkspaceAgent.Result run(AiModelConfig config, Long userId, String userMessage, List<Map<String, Object>> history,
                                         boolean canWrite, boolean canExec, CodeLoopBudget budget, ContextBudget limits,
                                         Consumer<Map<String, Object>> onStep, RemoteTools remote, String reasoningMode) {
        return run(config, userId, userMessage, history, canWrite, canExec, budget, limits, onStep, remote, reasoningMode, null);
    }

    public CodeWorkspaceAgent.Result run(AiModelConfig config, Long userId, String userMessage, List<Map<String, Object>> history,
                                         boolean canWrite, boolean canExec, CodeLoopBudget budget, ContextBudget limits,
                                         Consumer<Map<String, Object>> onStep, RemoteTools remote, String reasoningMode, Long conversationId) {
        Path script = hostScript();
        String nodeBin = nodeBinary();
        // 这个账号自己的文件夹和档位（第一百一十五轮起分账号），或者这段对话的临时空间，这一轮从头到尾用同一份
        WorkspaceRegistry.CodeTarget target = workspaces.target(userId, conversationId);
        WorkspaceService workspace = target.service();
        WorkspaceExecutor executor = target.executor();
        Path root = workspace.access().root();
        if (script == null || nodeBin == null || root == null) {
            log.warn("代码模式的 JS 循环起不来（node={} script={}），退回 Java 的循环", nodeBin, script);
            return null;
        }
        Map<String, ArtifactFiles.Stamp> before = target.artifact() ? ArtifactFiles.snapshot(root) : Map.of();
        Path home;
        Process process;
        try {
            home = Files.createTempDirectory("zhiqu-code-host-");
            ProcessBuilder pb = new ProcessBuilder(nodeBin, script.toRealPath().toString());   // 真实路径：临时目录可能在软链下
            // 不继承环境变量：HOME 是自己的空目录（仓库里带的配置文件不会被当成全局配置），PATH 只有 node 那一个目录
            pb.environment().clear();
            pb.environment().put("HOME", home.toString());
            pb.environment().put("PATH", Path.of(nodeBin).getParent().toString());
            pb.directory(home.toFile());
            pb.redirectError(home.resolve("stderr.log").toFile());
            process = pb.start();
        } catch (IOException e) {
            log.warn("代码模式的 JS 循环起不来，退回 Java 的循环：{}", e.toString());
            return null;
        }
        Process child = process;
        Thread watchdog = new Thread(() -> {
            try {
                if (!child.waitFor(budget.millis() + 5_000, TimeUnit.MILLISECONDS)) {
                    log.warn("代码模式的 JS 循环超出时间预算，整组结束 userId={}", userId);
                    child.descendants().forEach(ProcessHandle::destroyForcibly);
                    child.destroyForcibly();
                }
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }, "code-host-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();

        // 这台机器有系统沙箱就给 shell（第一百零九轮，和命令行一致）。能写工作区要 auto 档（EXEC）+ 这一轮有写意图；plan、manual 是只读沙箱
        boolean canShell = executor.shellEnabled() && sandboxAvailable(nodeBin, script, executor.hostedShell());
        boolean shellWrite = canShell && canExec && canWrite;
        Map<String, Object> model = new LinkedHashMap<>();
        model.put("id", config.getId());
        model.put("label", config.getDisplayName() == null || config.getDisplayName().isBlank() ? config.getModelName() : config.getDisplayName());
        model.put("modelName", config.getModelName());
        model.put("effectiveContextWindow", HarnessContext.effectiveWindow(config.getContextWindowTokens()));
        Map<String, Object> run = new LinkedHashMap<>();
        run.put("type", "run");
        run.put("root", root.toString());
        run.put("artifact", target.artifact());
        run.put("hosted", executor.hostedShell());
        run.put("message", userMessage);
        run.put("history", history == null ? List.of() : history);
        run.put("canWrite", canWrite);
        run.put("canExec", canExec);
        run.put("canShell", canShell);
        run.put("shellWrite", shellWrite);
        run.put("sandboxNetwork", workspaceProperties.getSandboxNetwork());
        run.put("commands", canExec ? workspaceProperties.getAllowedCommands() : List.of());
        run.put("maxRounds", budget.rounds());
        run.put("effort", ReasoningEffort.cliName(reasoningMode));
        run.put("timeoutMs", budget.millis());
        run.put("model", model);
        run.put("remoteTools", remote == null ? List.of() : remote.always());
        run.put("remoteToolsAfterRun", remote == null ? List.of() : remote.afterRun());

        Map<String, WorkspaceExecutor.Background> jobs = new LinkedHashMap<>();
        JsonNode result = null;
        try (BufferedWriter out = new BufferedWriter(new OutputStreamWriter(child.getOutputStream(), StandardCharsets.UTF_8));
             BufferedReader in = new BufferedReader(new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8))) {
            Channel channel = new Channel(out);
            channel.send(run);
            boolean[] ranCommand = {false};
            String line;
            while ((line = in.readLine()) != null) {
                if (line.length() > MAX_LINE_CHARS) {
                    throw new IllegalStateException("子进程的一行太长");
                }
                JsonNode msg = json.readTree(line);
                String type = msg.path("type").asText("");
                if ("model".equals(type)) {
                    callModel(config, userId, msg, channel);
                } else if ("exec".equals(type)) {
                    // 下发的和能执行的同一份清单：给了 shell 就不再接白名单的命令，没给 shell 就不接 shell
                    ranCommand[0] |= msg.hasNonNull("job")
                            ? job(msg, jobs, channel)
                            : msg.path("shell").asBoolean(false)
                            ? shell(executor, msg, canShell, shellWrite, nodeBin, script, jobs, channel)
                            : exec(executor, msg, canExec && !canShell, channel);
                } else if ("tool".equals(type)) {
                    tool(msg, remote, ranCommand[0], channel);
                } else if ("step".equals(type)) {
                    narrate(onStep, Map.of("phase", "call", "tool", "", "message", Texts.limitRaw(msg.path("text").asText(""), 400)));
                } else if ("result".equals(type)) {
                    result = msg;
                    break;
                } else if ("fatal".equals(type)) {
                    log.warn("代码模式的 JS 循环出错：{}", msg.path("message").asText(""));
                    narrate(onStep, Map.of("phase", "error", "message", "工具循环中断：" + Texts.limitRaw(msg.path("message").asText(""), 400)));
                    break;
                } else {
                    // 认不出就停，不猜
                    log.warn("代码模式的 JS 循环发来认不出的消息：{}", Texts.limitRaw(type, 40));
                    break;
                }
            }
        } catch (Exception e) {
            log.warn("代码模式的 JS 循环失败（不影响主回答） userId={} err={}", userId, e.toString());
            narrate(onStep, Map.of("phase", "error", "message", "工具循环中断：" + e.getMessage()));
        } finally {
            // 这一轮起的后台命令不留过夜（网页没有 /ps，留着就没人管了）
            jobs.values().forEach(WorkspaceExecutor.Background::stop);
            child.descendants().forEach(ProcessHandle::destroyForcibly);
            child.destroyForcibly();
            watchdog.interrupt();
            if (result == null) {
                // 子进程没交回结果：它的 stderr 是唯一的线索，临时目录删掉之前记下来（第九十九轮 review：第九十六轮软链那回一声不响退出，原来什么都没留下）
                log.warn("代码模式的 JS 循环没交回结果 userId={} stderr 末尾：{}", userId, stderrTail(home.resolve("stderr.log")));
            }
            deleteQuietly(home);
        }
        if (result == null) {
            narrate(onStep, Map.of("phase", "error", "message", "工具循环中断：代码模式的循环没交回结果（后端日志里有它的错误输出）"));
            return new CodeWorkspaceAgent.Result("", List.of(), null, canWrite, List.of(), false);
        }
        log.info("代码模式的 JS 循环收尾 userId={}：{} 轮、草稿 {} 份、结论：{}", userId, result.path("rounds").asInt(),
                result.path("drafts").size(), Texts.limitRaw(result.path("text").asText(""), 200));
        return new CodeWorkspaceAgent.Result(Texts.limitRaw(result.path("context").asText(""), limits.codeContextChars()),
                drafts(workspace, result.path("drafts"), canWrite), null, canWrite, List.of(), result.path("writeCalls").asInt(0) > 0,
                target.artifact() ? ArtifactFiles.changes(root, before) : List.of());
    }

    /** 一行一个 JSON 写给子进程（模型的事件和命令的结果都从这里走） */
    private final class Channel {
        private final BufferedWriter out;

        Channel(BufferedWriter out) {
            this.out = out;
        }

        synchronized void send(Map<String, Object> msg) throws IOException {
            out.write(json.writeValueAsString(msg));
            out.write('\n');
            out.flush();
        }
    }

    private void callModel(AiModelConfig config, Long userId, JsonNode msg, Channel channel) throws IOException {
        String id = msg.path("id").asText("");
        Map<String, Object> body = json.convertValue(msg.path("body"), new TypeReference<Map<String, Object>>() {});
        if (body == null) {
            body = new LinkedHashMap<>();
        }
        body.put("modelId", config.getId());   // 用哪个模型这里说了算
        try {
            gateway.getObject().stream(userId, body, (name, data) -> {
                Map<String, Object> event = new LinkedHashMap<>();
                event.put("type", "event");
                event.put("id", id);
                event.put("name", name);
                event.put("data", data);
                channel.send(event);
            }, false);   // 不记进命令行的用量表：这不是命令行的调用
        } catch (HarnessModelGateway.ModelCallException e) {
            channel.send(error(id, e.getMessage(), e.retryable()));
        } catch (BusinessException e) {
            channel.send(error(id, e.getMessage(), false));
        }
    }

    /** 远程工具：交给 CodeWorkspaceAgent 那一套执行；出错照实说给模型 */
    private void tool(JsonNode msg, RemoteTools remote, boolean ranCommand, Channel channel) throws IOException {
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("type", "tool_result");
        reply.put("id", msg.path("id").asText(""));
        String name = msg.path("name").asText("");
        JsonNode args = msg.path("arguments");
        String argsJson = args.isTextual() ? args.asText() : args.isMissingNode() ? "{}" : args.toString();
        try {
            reply.put("content", remote == null ? "没有叫 " + name + " 的工具。" : remote.call(name, argsJson, ranCommand));
        } catch (RuntimeException e) {
            reply.put("content", "工具执行失败：" + e.getMessage());
        }
        channel.send(reply);
    }

    /**
     * 这台机器有没有能用的系统沙箱：问一次记住（真跑一次，嵌套沙箱、用户命名空间被关时算没有）。没有就退回白名单的 run_command，和命令行一样。
     */
    boolean sandboxAvailable(String nodeBin, Path hostScript) {
        return sandboxAvailable(nodeBin, hostScript, false);
    }

    /** hosted：问的是服务器上那份最小环境。一个后端只会问其中一种（生产 profile 决定），记一份就够 */
    boolean sandboxAvailable(String nodeBin, Path hostScript, boolean hosted) {
        Boolean known = sandboxKnown;
        if (known != null) {
            return known;
        }
        boolean available = false;
        try {
            Map<String, Object> request = new LinkedHashMap<>();
            request.put("probe", true);
            request.put("hosted", hosted);
            request.put("env", toolEnv(nodeBin));
            available = askSandbox(nodeBin, hostScript, request).path("box").isObject();
        } catch (Exception e) {
            log.warn("探测系统沙箱失败，代码模式退回白名单命令：{}", e.toString());
        }
        sandboxKnown = available;
        if (!available) {
            log.info("这台机器没有可用的系统沙箱，代码模式跑命令退回白名单");
        }
        return available;
    }

    private volatile Boolean sandboxKnown;
    /** 真家目录：沙箱默认读不到的那个。判据换成假的，不碰用户真的 ~/.ssh */
    private volatile String sandboxHome = System.getProperty("user.home");

    void useSandboxHome(String home) {
        this.sandboxHome = home;
    }

    /** 判据用：假子进程旁边没有沙箱脚本，要看「给了 shell」时后端的门 */
    void assumeSandbox(boolean available) {
        this.sandboxKnown = available;
    }

    /** 命令能看到的工具链：后端自己的 PATH，加上 node 在的地方和常见的安装位置（桌面应用从 Finder 起时 PATH 只有系统目录） */
    static Map<String, String> toolEnv(String nodeBin) {
        Map<String, String> env = new LinkedHashMap<>();
        List<String> dirs = new ArrayList<>();
        String path = System.getenv("PATH");
        if (path != null) {
            dirs.addAll(List.of(path.split(File.pathSeparator)));
        }
        dirs.add(Path.of(nodeBin).getParent().toString());
        for (String dir : List.of("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin")) {
            if (Files.isDirectory(Path.of(dir))) {
                dirs.add(dir);
            }
        }
        env.put("PATH", String.join(File.pathSeparator, new java.util.LinkedHashSet<>(dirs)));
        for (String key : TOOLCHAIN_ENV) {
            String value = System.getenv(key);
            if (value != null && !value.isBlank()) {
                env.put(key, value);
            }
        }
        return env;
    }

    /** 问沙箱实现。输入全部来自后端；这个进程只回答，不跑命令。 */
    private JsonNode askSandbox(String nodeBin, Path hostScript, Map<String, Object> request) throws IOException, InterruptedException {
        Path helper = hostScript.toRealPath().resolveSibling(SANDBOX_SCRIPT);
        if (!Files.isRegularFile(helper)) {
            throw new IOException("找不到 " + helper);
        }
        ProcessBuilder pb = new ProcessBuilder(nodeBin, helper.toString());
        pb.environment().clear();
        pb.environment().put("PATH", Path.of(nodeBin).getParent().toString());
        pb.environment().put("HOME", System.getProperty("java.io.tmpdir"));
        pb.environment().put("TMPDIR", System.getProperty("java.io.tmpdir"));
        pb.redirectError(ProcessBuilder.Redirect.DISCARD);
        Process p = pb.start();
        try (var stdin = p.getOutputStream()) {
            stdin.write(json.writeValueAsBytes(request));
        }
        byte[] out = p.getInputStream().readAllBytes();
        if (!p.waitFor(15, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            throw new IOException("沙箱脚本没有回答");
        }
        JsonNode answer = json.readTree(out);
        if (answer.hasNonNull("error")) {
            throw new IOException(answer.path("error").asText());
        }
        return answer;
    }

    /** @return 真的跑了（交给了执行器、没被拒） */
    private boolean shell(WorkspaceExecutor executor, JsonNode msg, boolean canShell, boolean shellWrite, String nodeBin, Path hostScript, Map<String, WorkspaceExecutor.Background> jobs, Channel channel) throws IOException {
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("type", "exec_result");
        reply.put("id", msg.path("id").asText(""));
        if (!canShell) {
            reply.put("error", "这一次不能跑命令。");
            channel.send(reply);
            return false;
        }
        try {
            if (msg.path("background").asBoolean(false)) {
                if (jobs.values().stream().filter(WorkspaceExecutor.Background::running).count() >= MAX_JOBS) {
                    reply.put("error", "后台已经有 " + MAX_JOBS + " 个命令在跑了，先用 shell_stop 停掉不用的。");
                    channel.send(reply);
                    return false;
                }
                WorkspaceExecutor.Background started = executor.startShell(msg.path("command").asText(""), msg.path("cwd").asText(""), shellWrite,
                        request -> sandboxLaunch(nodeBin, hostScript, request));
                String id = "job-" + (jobs.size() + 1);
                jobs.put(id, started);
                log.info("代码模式起后台命令 {}：{}", id, Texts.limitRaw(msg.path("command").asText(""), 200));
                putSnapshot(reply, id, started.read(jobWait(msg.path("waitMs").asLong(0))));
                channel.send(reply);
                return true;
            }
            WorkspaceExecutor.ExecResult r = executor.shell(msg.path("command").asText(""), msg.path("cwd").asText(""), shellWrite,
                    request -> sandboxLaunch(nodeBin, hostScript, request), msg.path("timeoutMs").asLong(0));
            log.info("代码模式跑 shell {} → 退出码 {}（{}ms）", Texts.limitRaw(r.command(), 200), r.exitCode(), r.millis());
            reply.put("exitCode", r.exitCode());
            reply.put("output", r.output() + (r.truncated() ? "\n（输出太长，已截断 —— 这不是全部）" : ""));
            reply.put("timedOut", r.timedOut());
            reply.put("millis", r.millis());
        } catch (BusinessException e) {
            log.info("代码模式的 shell 被拒：{}", e.getMessage());
            reply.put("error", "没有运行：" + e.getMessage());
            channel.send(reply);
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            reply.put("error", "已中断");
            channel.send(reply);
            return false;
        }
        channel.send(reply);
        return true;
    }

    /** 一轮最多几个后台命令；shell_output 最多等多久（和命令行 MAX_WAIT_SECONDS 一样） */
    private static final int MAX_JOBS = 4;
    private static final long MAX_JOB_WAIT_MS = 60_000L;

    /** 子进程说等多久不全算数：后端的线程在这里等着 */
    static long jobWait(long asked) {
        return Math.max(0, Math.min(asked, MAX_JOB_WAIT_MS));
    }

    private static void putSnapshot(Map<String, Object> reply, String id, WorkspaceExecutor.Background.Snapshot s) {
        reply.put("jobId", id);
        reply.put("running", s.running());
        reply.put("exitCode", s.exitCode());
        reply.put("stopped", s.stopped());
        reply.put("output", s.output());
        reply.put("skipped", s.skipped());
        reply.put("more", s.more());
        reply.put("millis", s.millis());
    }

    /** shell_output、shell_stop：只认这一轮自己起的 */
    private boolean job(JsonNode msg, Map<String, WorkspaceExecutor.Background> jobs, Channel channel) throws IOException {
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("type", "exec_result");
        reply.put("id", msg.path("id").asText(""));
        String jobId = msg.path("jobId").asText("");
        WorkspaceExecutor.Background target = jobs.get(jobId);
        if (target == null) {
            reply.put("error", "没有 " + jobId + " 这个后台命令（现在有：" + String.join("、", jobs.keySet()) + "）。");
            channel.send(reply);
            return false;
        }
        try {
            putSnapshot(reply, jobId, "stop".equals(msg.path("job").asText(""))
                    ? target.stop()
                    : target.read(jobWait(msg.path("waitMs").asLong(0))));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            reply.put("error", "已中断");
        }
        channel.send(reply);
        return false;
    }

    WorkspaceExecutor.Launch sandboxLaunch(String nodeBin, Path hostScript, WorkspaceExecutor.SandboxRequest r) {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("command", r.command());
        request.put("root", r.root().toString());
        request.put("cwd", r.cwd().toString());
        request.put("policy", r.write() ? "workspace-write" : "read-only");
        request.put("network", r.network());   // 认不出的值由沙箱实现按断网算
        request.put("home", sandboxHome);
        request.put("env", toolEnv(nodeBin));
        request.put("privateDir", r.privateDir().toString());
        request.put("hosted", r.hosted());
        try {
            JsonNode answer = askSandbox(nodeBin, hostScript, request);
            List<String> args = new ArrayList<>();
            answer.path("args").forEach(a -> args.add(a.asText("")));
            Map<String, String> env = new LinkedHashMap<>();
            answer.path("env").fields().forEachRemaining(e -> env.put(e.getKey(), e.getValue().asText("")));
            if (answer.path("binary").asText("").isEmpty()) {
                throw new IOException("沙箱脚本没有给出怎么起");
            }
            return new WorkspaceExecutor.Launch(answer.path("binary").asText(), args, env);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BusinessException("执行被中断");
        } catch (IOException e) {
            // 拿不到沙箱就不跑：绝不退回不带沙箱地跑
            throw new BusinessException("系统沙箱起不来，这条命令没有运行：" + e.getMessage());
        }
    }

    /** @return 真的跑了（交给了执行器、没被拒） */
    private boolean exec(WorkspaceExecutor executor, JsonNode msg, boolean canExec, Channel channel) throws IOException {
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("type", "exec_result");
        reply.put("id", msg.path("id").asText(""));
        if (!canExec) {
            reply.put("error", "这一次不能跑命令。");
            channel.send(reply);
            return false;
        }
        List<String> args = new ArrayList<>();
        msg.path("args").forEach(a -> args.add(a.asText("")));
        try {
            WorkspaceExecutor.ExecResult r = executor.exec(msg.path("command").asText(""), args, msg.path("cwd").asText(""));
            log.info("代码模式跑命令 {} {} → 退出码 {}（{}ms）", r.command(), r.args(), r.exitCode(), r.millis());
            reply.put("exitCode", r.exitCode());
            reply.put("output", r.output() + (r.truncated() ? "\n（输出太长，已截断 —— 这不是全部）" : ""));
            reply.put("timedOut", r.timedOut());
            reply.put("millis", r.millis());
        } catch (BusinessException e) {
            log.info("代码模式跑命令 {} 被拒：{}", msg.path("command").asText(""), e.getMessage());
            reply.put("error", "没有运行：" + e.getMessage());
            channel.send(reply);
            return false;
        }
        channel.send(reply);
        return true;
    }

    private static Map<String, Object> error(String id, String message, boolean retryable) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "error");
        m.put("id", id);
        m.put("message", message == null ? "模型调用失败" : message);
        m.put("retryable", retryable);
        return m;
    }

    /** 子进程交回的草稿：路径照写入规矩再判一遍（不合法的丢掉、记日志），形状和 Java 循环出的一样 */
    List<Map<String, Object>> drafts(WorkspaceService workspace, JsonNode nodes, boolean canWrite) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (!canWrite || !nodes.isArray()) {
            return out;
        }
        for (JsonNode d : nodes) {
            String path = d.path("path").asText("");
            try {
                workspace.checkWritable(path);
            } catch (BusinessException e) {
                log.warn("JS 循环交回的草稿路径不合法，丢掉：{} —— {}", path, e.getMessage());
                continue;
            }
            Map<String, Object> draft = new LinkedHashMap<>();
            draft.put("path", path);
            draft.put("content", d.path("content").asText(""));
            draft.put("baseline", d.path("baseline").asText(WorkspaceService.ABSENT));
            draft.put("creating", WorkspaceService.ABSENT.equals(d.path("baseline").asText(WorkspaceService.ABSENT)));
            List<String> dirs = new ArrayList<>();
            d.path("newDirectories").forEach(x -> dirs.add(x.asText("")));
            if (!dirs.isEmpty()) {
                draft.put("newDirectories", dirs);
            }
            out.add(draft);
        }
        return out;
    }

    private static void narrate(Consumer<Map<String, Object>> onStep, Map<String, Object> note) {
        if (onStep == null) {
            return;
        }
        try {
            onStep.accept(note);
        } catch (RuntimeException e) {
            log.debug("步骤叙述发送失败（不影响工具循环）：{}", e.toString());
        }
    }

    /** stderr 的最后 2000 字（读不到是空串） */
    static String stderrTail(Path file) {
        try {
            String text = Files.readString(file, StandardCharsets.UTF_8).strip();
            return text.length() > 2000 ? "…" + text.substring(text.length() - 2000) : text;
        } catch (IOException | RuntimeException e) {
            return "";
        }
    }

    private static void deleteQuietly(Path dir) {
        try (var walk = Files.walk(dir)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        } catch (IOException ignored) {
            // 临时目录，删不掉也无妨
        }
    }
}
