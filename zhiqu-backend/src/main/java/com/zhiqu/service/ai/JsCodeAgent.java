package com.zhiqu.service.ai;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.common.Texts;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.harness.HarnessContext;
import com.zhiqu.service.harness.HarnessModelGateway;
import com.zhiqu.service.workspace.WorkspaceExecutor;
import com.zhiqu.service.workspace.WorkspaceProperties;
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

    private final ObjectProvider<HarnessModelGateway> gateway;
    private final WorkspaceService workspaceService;
    private final WorkspaceExecutor executor;
    private final WorkspaceProperties workspaceProperties;
    private final ObjectMapper json;
    private final String engine;
    private final String node;
    private final String cliDir;

    public JsCodeAgent(ObjectProvider<HarnessModelGateway> gateway, WorkspaceService workspaceService, WorkspaceExecutor executor,
                       WorkspaceProperties workspaceProperties, ObjectMapper json,
                       @Value("${app.ai.code-agent.engine:js}") String engine,
                       @Value("${app.ai.code-agent.node:node}") String node,
                       @Value("${app.ai.code-agent.cli-dir:}") String cliDir) {
        this.gateway = gateway;
        this.workspaceService = workspaceService;
        this.executor = executor;
        this.workspaceProperties = workspaceProperties;
        this.json = json;
        this.engine = engine == null ? "" : engine.trim();
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

    /** 开关是 js、脚本也在 */
    public boolean enabled() {
        return "js".equalsIgnoreCase(engine) && hostScript() != null;
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
        Path script = hostScript();
        String nodeBin = nodeBinary();
        Path root = workspaceService.access().root();
        if (script == null || nodeBin == null || root == null) {
            log.warn("代码模式的 JS 循环起不来（node={} script={}），退回 Java 的循环", nodeBin, script);
            return null;
        }
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

        Map<String, Object> model = new LinkedHashMap<>();
        model.put("id", config.getId());
        model.put("label", config.getDisplayName() == null || config.getDisplayName().isBlank() ? config.getModelName() : config.getDisplayName());
        model.put("modelName", config.getModelName());
        model.put("effectiveContextWindow", HarnessContext.effectiveWindow(config.getContextWindowTokens()));
        Map<String, Object> run = new LinkedHashMap<>();
        run.put("type", "run");
        run.put("root", root.toString());
        run.put("message", userMessage);
        run.put("history", history == null ? List.of() : history);
        run.put("canWrite", canWrite);
        run.put("canExec", canExec);
        run.put("commands", canExec ? workspaceProperties.getAllowedCommands() : List.of());
        run.put("maxRounds", budget.rounds());
        run.put("timeoutMs", budget.millis());
        run.put("model", model);
        run.put("remoteTools", remote == null ? List.of() : remote.always());
        run.put("remoteToolsAfterRun", remote == null ? List.of() : remote.afterRun());

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
                    ranCommand[0] |= exec(msg, canExec, channel);
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
            child.descendants().forEach(ProcessHandle::destroyForcibly);
            child.destroyForcibly();
            watchdog.interrupt();
            deleteQuietly(home);
        }
        if (result == null) {
            return new CodeWorkspaceAgent.Result("", List.of(), null, canWrite, List.of(), false);
        }
        log.info("代码模式的 JS 循环收尾 userId={}：{} 轮、草稿 {} 份、结论：{}", userId, result.path("rounds").asInt(),
                result.path("drafts").size(), Texts.limitRaw(result.path("text").asText(""), 200));
        return new CodeWorkspaceAgent.Result(Texts.limitRaw(result.path("context").asText(""), limits.codeContextChars()),
                drafts(result.path("drafts"), canWrite), null, canWrite, List.of(), result.path("writeCalls").asInt(0) > 0);
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

    /** @return 真的跑了（交给了执行器、没被拒） */
    private boolean exec(JsonNode msg, boolean canExec, Channel channel) throws IOException {
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
    List<Map<String, Object>> drafts(JsonNode nodes, boolean canWrite) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (!canWrite || !nodes.isArray()) {
            return out;
        }
        for (JsonNode d : nodes) {
            String path = d.path("path").asText("");
            try {
                workspaceService.checkWritable(path);
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

    private static void deleteQuietly(Path dir) {
        try (var walk = Files.walk(dir)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        } catch (IOException ignored) {
            // 临时目录，删不掉也无妨
        }
    }
}
