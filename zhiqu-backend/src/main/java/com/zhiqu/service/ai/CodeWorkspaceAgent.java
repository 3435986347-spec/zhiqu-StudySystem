package com.zhiqu.service.ai;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.common.Texts;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.AdminGuard;
import com.zhiqu.service.agent.AgentPlanDecision;
import com.zhiqu.service.workspace.WorkspaceExecutor;
import com.zhiqu.service.workspace.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

/**
 * 代码工作区的工具循环 —— coding agent 的全部「手脚」。
 *
 * <p>拆 {@code AiServiceImpl} 的第五刀。形状与第二刀的 {@link WikiToolAgent} 一致：
 * 自己的工具声明、执行器、循环状态、系统提示词，以及一整套只对它有意义的防护
 * （最小权限、下发即清单、没读过不许改、判过题才给写薄弱点的工具）。
 *
 * <h2>为什么能整块搬、而检索那一块不能</h2>
 *
 * <p>搬之前量过：这一块只碰注入的服务（模型客户端、工作区、执行器、Wiki agent、管理员守卫），
 * <b>不碰任何一个轮次状态（StreamState）字段</b>。第四刀量检索 runner 时是 22 个字段，
 * 搬出去等于把整个轮次状态一起暴露，所以没搬。量了再决定，是那一刀留下的规矩。
 *
 * <h2>和 PLANNER 共用一份计划工具</h2>
 *
 * <p>项目式引导要把里程碑排成任务草稿，用的必须是 PLANNER 那条路<b>同一个</b>
 * {@code create_study_plan} schema 和<b>同一个</b>解析器 —— 另猜字段名，确认落库时会静默丢掉
 * 象限、时长、截止日期。那一份是 {@link StudyPlanTool}（第六刀）。第五刀时它还住在大类里，
 * 这里只能经一个 {@code MilestonePlanning} 接缝借用；它搬出来之后接缝就是多余的一层，已删。
 */
@Component
public class CodeWorkspaceAgent {
    private static final Logger log = LoggerFactory.getLogger(CodeWorkspaceAgent.class);

    /** 代码工作区上下文的长度上限（没配窗口时）—— 与 Wiki 那条同量级。配了窗口见 ContextBudget。 */
    static final int CODE_CONTEXT_LIMIT = 12000;

    /*
     * 交给工具循环的对话历史，上限由 ContextBudget.codeHistoryChars 给（没配窗口时 24000 字）。
     *
     * 2026-09-23 之前这个循环完全看不到历史：发给模型的只有系统提示词和这一句话。
     * 用户在命令行里说「直接生成完整代码」「确认创建」，循环只看到这几个字，列一下目录就停了；
     * 真正写出代码的是后面那次没有工具的最终回答 —— 有历史的没工具，有工具的没历史。
     */

    /**
     * 从新往旧取历史，总长不超过预算；最新那一条单独就超预算时只留它的<b>结尾</b>
     * （对话里最近说的事在结尾）。返回时恢复成时间顺序。
     */
    static List<Map<String, Object>> recentHistory(List<Map<String, Object>> history, int charBudget) {
        List<Map<String, Object>> picked = new ArrayList<>();
        if (history == null) {
            return picked;
        }
        int used = 0;
        for (int i = history.size() - 1; i >= 0; i--) {
            Map<String, Object> m = history.get(i);
            String content = String.valueOf(m.getOrDefault("content", ""));
            if (content.isBlank()) {
                continue;
            }
            int room = charBudget - used;
            if (room <= 0) {
                break;
            }
            if (content.length() > room) {
                if (!picked.isEmpty()) {
                    break;   // 旧的放不下就不放：半截的旧消息比没有更容易误导
                }
                content = "…（前面省略）" + content.substring(content.length() - room);
            }
            picked.add(0, Map.of("role", String.valueOf(m.get("role")), "content", content));
            used += content.length();
        }
        return picked;
    }

    private final ModelProviderClient provider;
    private final WorkspaceService workspaceService;
    private final WorkspaceExecutor workspaceExecutor;
    private final WikiToolAgent wikiToolAgent;
    private final AdminGuard adminGuard;
    private final ObjectMapper objectMapper;
    private final StudyPlanTool studyPlanTool;

    public CodeWorkspaceAgent(ModelProviderClient provider, WorkspaceService workspaceService,
                              WorkspaceExecutor workspaceExecutor, WikiToolAgent wikiToolAgent,
                              AdminGuard adminGuard, ObjectMapper objectMapper, StudyPlanTool studyPlanTool) {
        this.provider = provider;
        this.workspaceService = workspaceService;
        this.workspaceExecutor = workspaceExecutor;
        this.wikiToolAgent = wikiToolAgent;
        this.adminGuard = adminGuard;
        this.objectMapper = objectMapper;
        this.studyPlanTool = studyPlanTool;
    }

    /** 这一轮的产物：给最终回答用的上下文、待确认的写草稿、里程碑计划（可为 null）。 */
    public record Result(String context, List<Map<String, Object>> drafts, Map<String, Object> milestonePlan,
                         boolean writeOffered) {
        public static final Result EMPTY = new Result("", List.of(), null, false);
    }

    /**
     * 循环的状态。
     *
     * <p>{@code baselines} 记的是<b>模型读到某个文件的那一刻</b>它内容的指纹。
     * 写草稿要带着它走完「草稿 → 用户确认 → 落盘」整条路，确认时拿它和磁盘现状比 ——
     * 中间隔的这几分钟里用户完全可能在自己的编辑器里改了同一个文件。
     */
    static final class LoopState {
        final Map<String, String> baselines = new LinkedHashMap<>();
        final List<Map<String, Object>> drafts = new ArrayList<>();
        /**
         * 本轮有没有真的跑过一次判题。
         *
         * <p>「把错题记进薄弱点页」这件事的前提不是用户说了什么关键词，而是<b>确实判过题</b>。
         * 关键词门会过触发也会漏触发（{@code codeIntent} 那条就明示了自己会过触发），
         * 而「跑过没跑过」是事实，不是猜测。所以 {@code create_wiki_patch} 只在这之后才下发。
         */
        boolean ranCommand;
        /** Wiki 工具自己的循环状态（读过哪些页、快照、本轮已提过哪些草稿）—— 复用同一套防护。 */
        final WikiToolAgent.WikiLoopState wiki = new WikiToolAgent.WikiLoopState();
        /** 模型给出的里程碑计划（{@code {tasks, routines}}），形状由 {@link StudyPlanTool} 决定。 */
        Map<String, Object> milestonePlan;
    }

    /**
     * 这个用户能不能读工作区 —— <b>唯一判定</b>。
     *
     * <p>两个条件缺一不可：工作区本身生效，且用户是管理员。后者容易漏 ——
     * 工作区读的是服务器磁盘，不是用户自己的数据，所以它和 Notebook 那种按 userId
     * 分账的资源不是一回事，不能只靠「登录了」就给。建图（要不要造 CODE_AGENT 节点）
     * 和执行（要不要真的跑循环）都问这一处。
     */
    public boolean readableBy(Long userId) {
        return workspaceService.access().effectiveMode().allowsRead() && adminGuard.isAdmin(userId);
    }

    /**
     * 跑一轮工具循环。失败不影响主回答 —— 最坏是空结果。
     *
     * @param onStep 每次工具调用前后的叙述（{@code agent.step.note}），网页轨迹与命令行都读它；可为 null
     */
    public Result run(AiModelConfig config, Long userId, String userMessage, List<Map<String, Object>> history,
                      Map<String, Object> contextOptions, ContextBudget contextBudget,
                      Consumer<Map<String, Object>> onStep) {
        ContextBudget limits = contextBudget == null ? ContextBudget.DEFAULT : contextBudget;
        if (!AgentPlanDecision.codeAgentIntent(userMessage, contextOptions) || !provider.supportsToolCalling(config)) {
            return Result.EMPTY;
        }
        if (!readableBy(userId)) {
            return Result.EMPTY;
        }
        LoopState loop = new LoopState();
        StringBuilder context = new StringBuilder();
        boolean writeOffered = false;
        try {
            List<Map<String, Object>> messages = new ArrayList<>();
            Path wsRoot = workspaceService.access().root();
            messages.add(Map.of("role", "system", "content", systemPrompt()
                    + "\n工作区根目录的文件夹名：" + (wsRoot == null || wsRoot.getFileName() == null
                            ? "(未知)" : wsRoot.getFileName())));
            // 最近的对话 —— 追问（「确认创建」「直接写进去」）要靠它才知道指的是什么
            messages.addAll(recentHistory(history, limits.codeHistoryChars()));
            messages.add(Map.of("role", "user", "content", userMessage));
            // 最小权限：只有明确的写意图才把写工具下发给模型。不下发，它就不会尝试，
            // 也不会承诺自己改了文件 —— 与 buildWikiTools(includeWrite) 同一个做法。
            boolean canWrite = workspaceService.access().effectiveMode().allowsWrite()
                    && AgentPlanDecision.codeWriteIntent(userMessage, contextOptions);
            writeOffered = canWrite;
            // 执行这一档由 WorkspaceExecutor 自己说了算（档位 + 非生产 profile 两条都在它里面）。
            // 这里不再复述那两个条件 —— 复述就是第二份真相。
            boolean canExec = workspaceExecutor.enabled();
            // 项目式引导才给「把里程碑排成任务」的能力：别的语境下模型不该往用户日历里塞东西。
            boolean canPlanMilestones = AgentPlanDecision.projectIntent(userMessage);
            // 显式按了「代码」给大预算，关键词触发给小预算 —— 理由见 CodeLoopBudget
            CodeLoopBudget budget = CodeLoopBudget.forRequest(AgentPlanDecision.codeModeRequested(contextOptions));
            long loopStart = System.currentTimeMillis();
            for (int round = 0; round < budget.rounds(); round++) {
                if (System.currentTimeMillis() - loopStart > budget.millis()) {
                    log.warn("代码工作区工具循环超出预算，提前结束 userId={} round={} budget={}", userId, round, budget);
                    narrate(onStep, Map.of("phase", "budget",
                            "message", "已用完这一轮的时间预算，先把目前的结果交给你"));
                    break;
                }
                // 工具表<b>每轮重建</b>：写薄弱点页的工具要等到真的判过题之后才出现。
                // 一次性算好的话，这个条件只能用「用户说了什么」来近似，而那是猜。
                List<Map<String, Object>> tools = new ArrayList<>(buildTools(canWrite, canExec));
                // Wiki 的读工具一直给：出题之前先看看这个人以前错在哪，题才出得准。
                // 写工具（create_wiki_patch）只在 ranCommand 之后给 —— 见 LoopState.ranCommand。
                tools.addAll(wikiToolAgent.buildWikiTools(loop.ranCommand));
                if (canPlanMilestones) {
                    // 复用 PLANNER 那条路的 schema，不另写一份 —— 见 StudyPlanTool
                    tools.addAll(studyPlanTool.tools());
                }
                // 这一轮到底给了哪些工具 —— 执行侧要照着它拒绝没给过的调用。
                // 不这么做的话，上面那几道「最小权限」的门只决定<b>声明</b>什么，
                // 不阻止<b>执行</b>什么：模型随便报一个名字就能调到没下发的工具，门形同虚设。
                // 2026-09-21 端到端扰动发现的：把写工具改成永不下发，草稿照样产了出来。
                Set<String> offered = offeredToolNames(tools);
                // 每次调用的限额随预算走：显式「代码」模式要能一次写出一整个文件（见 CodeLoopBudget）
                JsonNode message;
                try {
                    message = provider.callOpenAiToolTurn(config, messages, tools,
                            budget.turnLimits(System.currentTimeMillis() - loopStart));
                } catch (ModelProviderClient.ToolTurnTruncatedException truncated) {
                    // 被截断不是「说完了」：说出来，并让模型换个写法再来一轮，而不是静默结束
                    narrate(onStep, Map.of("phase", "budget", "message",
                            "模型这一轮的输出超出单次上限被截断了 —— 已让它把文件拆小再写"));
                    messages.add(Map.of("role", "user", "content",
                            "你上一次的回复超出了单次输出上限（" + truncated.maxTokens() + " token），被截断了，"
                                    + "工具调用没有完成。如果要写的文件很长，请把它拆成几个较小的文件分别用 "
                                    + "write_workspace_file 写，或者先写一个精简但能运行的版本。"));
                    continue;
                }
                if (message == null) {
                    break;
                }
                messages.add(objectMapper.convertValue(message, new TypeReference<Map<String, Object>>() {}));
                JsonNode toolCalls = message.path("tool_calls");
                if (!toolCalls.isArray() || toolCalls.isEmpty()) {
                    break;
                }
                for (JsonNode call : toolCalls) {
                    String name = call.at("/function/name").asText("");
                    JsonNode argsNode = call.at("/function/arguments");
                    String argsRaw = argsNode.isTextual() ? argsNode.asText("")
                            : (argsNode.isMissingNode() ? "{}" : argsNode.toString());
                    narrate(onStep, Map.of("phase", "call", "tool", name,
                            "message", CodeToolNarration.describeCall(name, argsRaw)));
                    String result = !offered.contains(name)
                            ? "操作被拒绝：这一轮没有给你「" + name + "」这个工具。"
                                    + "如实告诉用户你没有这个能力，不要换个名字再试。"
                            : StudyPlanTool.NAME.equals(name)
                            ? recordMilestonePlan(argsRaw, loop)
                            : WikiToolAgent.isWikiTool(name)
                            // 原样交给 Wiki 那条已经加固过的路：保留页、未完整读取不许整页覆盖、
                            // 本轮幂等、条带锁、可信快照基线。这里<b>不</b>另写一份。
                            ? wikiToolAgent.executeWikiTool(userId, name, argsRaw, loop.wiki).result
                            : executeWorkspaceTool(name, argsRaw, loop);
                    String shown = CodeToolNarration.describeResult(name, result);
                    if (shown != null) {
                        narrate(onStep, Map.of("phase", "result", "tool", name, "message", shown));
                    }
                    if (Texts.hasText(result)) {
                        context.append("【工作区 ").append(name).append("】\n").append(result).append("\n\n");
                    }
                    Map<String, Object> toolMsg = new LinkedHashMap<>();
                    toolMsg.put("role", "tool");
                    toolMsg.put("tool_call_id", call.path("id").asText(""));
                    toolMsg.put("name", name);
                    toolMsg.put("content", result);
                    messages.add(toolMsg);
                }
            }
        } catch (Exception e) {
            log.warn("代码工作区工具循环失败（不影响主回答） userId={} err={}", userId, e.getMessage());
            // 说出来：这一行原来只进日志，用户看到的是「卡住了」，然后一段没头没尾的回答
            narrate(onStep, Map.of("phase", "error", "message", "工具循环中断：" + e.getMessage()));
        }
        return new Result(Texts.limitRaw(context.toString(), limits.codeContextChars()),
                List.copyOf(loop.drafts), loop.milestonePlan, writeOffered);
    }

    /**
     * 发一条步骤叙述。叙述是给人看的旁白，<b>它出错不能拖垮工具循环</b> ——
     * 连接断了、序列化失败，都只丢这一行旁白，模型那边的活照干。
     */
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

    /**
     * 把模型给出的里程碑计划收下来 —— <b>只收下，不落库</b>。
     *
     * <p>与计划草稿同一条纪律：它会变成 {@code TASK_DRAFT} 工件，用户在确认弹窗里
     * 逐条勾选之后才进日历。项目式引导一次会给出好几个里程碑，直接写进去的话
     * 用户第二天打开看板会发现多了一堆自己没安排过的任务。
     *
     * <p>解析不出来时回给模型一句能照着改的话。搬家之前这里直接调 PLANNER 的解析器，
     * 而它对坏 JSON 是<b>抛异常</b>的 —— 在工具循环里，那会让整个循环提前结束，
     * 模型连重试的机会都没有。
     */
    private String recordMilestonePlan(String argsJson, LoopState loop) {
        Map<String, Object> plan = studyPlanTool.parseOrNull(argsJson);
        if (plan == null) {
            return "没有解析出可用的里程碑。请给出 tasks 数组，每项至少有 title。";
        }
        loop.milestonePlan = plan;
        int tasks = plan.get("tasks") instanceof List<?> list ? list.size() : 0;
        int routines = plan.get("routines") instanceof List<?> list ? list.size() : 0;
        return "已生成 " + tasks + " 个里程碑任务" + (routines > 0 ? "、" + routines + " 项例行计划" : "")
                + "的草稿（还没有写进日历）。请告诉用户到确认面板勾选后才会生效。";
    }

    /**
     * 从工具表里取出函数名 —— 执行侧据此拒绝没下发过的调用。
     *
     * <p>「下发了什么」和「能执行什么」必须是同一份清单。分开的话，
     * {@code canWrite} / {@code canExec} / {@code ranCommand} 这几道门就只是在
     * 「建议」模型别用，而不是在阻止它用。
     */
    static Set<String> offeredToolNames(List<Map<String, Object>> tools) {
        Set<String> names = new HashSet<>();
        for (Map<String, Object> tool : tools) {
            if (tool.get("function") instanceof Map<?, ?> function && function.get("name") != null) {
                names.add(String.valueOf(function.get("name")));
            }
        }
        return names;
    }

    /** 工作区工具集。写与执行按档位分档声明 —— 模型看不到的工具，它就不会尝试，也不会承诺自己用过。 */
    List<Map<String, Object>> buildTools(boolean canWrite, boolean canExec) {
        List<Map<String, Object>> tools = new ArrayList<>();

        Map<String, Object> listProps = new LinkedHashMap<>();
        listProps.put("path", ToolSchemas.schemaProp("string", "相对工作区根的目录路径；留空表示根目录"));
        tools.add(ToolSchemas.functionTool("list_workspace_files",
                "列出工作区里某个目录下的文件与子目录（不递归）。不知道项目结构时先用它。"
                        + "返回里的 readable=false 表示那个文件不允许读取（例如密钥、超大文件）。",
                listProps, List.of()));

        Map<String, Object> readProps = new LinkedHashMap<>();
        readProps.put("path", ToolSchemas.schemaProp("string", "相对工作区根的文件路径，例如 src/main/java/Foo.java"));
        tools.add(ToolSchemas.functionTool("read_workspace_file",
                "读取工作区里一个文件的完整内容。回答关于具体代码的问题前必须先读，不要凭文件名猜。",
                readProps, List.of("path")));

        Map<String, Object> searchProps = new LinkedHashMap<>();
        searchProps.put("query", ToolSchemas.schemaProp("string", "要找的字面量文本，大小写不敏感。不支持正则表达式。"));
        searchProps.put("path", ToolSchemas.schemaProp("string", "搜索起点目录，相对工作区根；留空表示整个工作区"));
        tools.add(ToolSchemas.functionTool("search_workspace",
                "在工作区里按关键词搜索（字面量，大小写不敏感，递归）。"
                        + "找一个类、方法、配置项在哪里定义或被谁调用时用它，比一层层列目录快得多。"
                        + "结果里若标注「还有更多」，说明命中被截断了，应当换一个更具体的关键词再搜。",
                searchProps, List.of("query")));

        if (canWrite) {
            Map<String, Object> writeProps = new LinkedHashMap<>();
            writeProps.put("path", ToolSchemas.schemaProp("string", "相对工作区根的文件路径"));
            writeProps.put("content", ToolSchemas.schemaProp("string", "这个文件修改后的<b>完整</b>内容，不是差异片段"));
            tools.add(ToolSchemas.functionTool("write_workspace_file",
                    "把一个文件修改后的完整内容写成<b>草稿</b>。注意：这不会改动磁盘上的文件，"
                            + "只是生成一份待用户确认的草稿，用户在界面上看过 diff、点了确认才会落盘。"
                            + "所以不要说「我已经改好了」，要说「改动已生成草稿，确认后生效」。"
                            + "改一个已存在的文件之前必须先 read_workspace_file 读过它 —— 没读过就改是盲写。",
                    writeProps, List.of("path", "content")));
        }
        if (canExec) {
            Map<String, Object> runProps = new LinkedHashMap<>();
            runProps.put("command", ToolSchemas.schemaProp("string", "命令名，例如 python3 / node / javac。不接受路径，也不接受 shell 语句"));
            runProps.put("args", Map.of("type", "array", "items", Map.of("type", "string"),
                    "description", "参数数组。不接受 -c/-e 这类行内代码开关，也不接受绝对路径或 ../"));
            runProps.put("path", ToolSchemas.schemaProp("string", "工作目录，相对工作区根；留空表示根"));
            tools.add(ToolSchemas.functionTool("run_workspace_command",
                    "在工作区里跑一条命令，拿到退出码和输出。"
                            + "只能执行工作区里<b>已经存在的文件</b>：不接受 -c/-e 这类把代码写在命令行上的用法，"
                            + "要跑新代码就先用 write_workspace_file 生成草稿、让用户确认落盘，再跑它。"
                            + "输出可能被截断，结果里会明说；超时会被强制结束。",
                    runProps, List.of("command")));
        }
        return tools;
    }

    /** 执行一个工作区工具，返回给模型的文本。拒绝时把<b>原因</b>给模型，让它能如实转述。 */
    String executeWorkspaceTool(String name, String argsJson, LoopState loop) {
        Map<String, Object> args = ToolSchemas.argsOf(objectMapper, argsJson);
        try {
            if ("list_workspace_files".equals(name)) {
                String path = String.valueOf(args.getOrDefault("path", ""));
                if ("null".equals(path)) {
                    path = "";
                }
                WorkspaceService.Listing listing = workspaceService.listing(path);
                List<WorkspaceService.Entry> entries = listing.entries();
                if (entries.isEmpty()) {
                    return "这个目录是空的：" + (path.isBlank() ? "(工作区根)" : path);
                }
                StringBuilder out = new StringBuilder();
                for (WorkspaceService.Entry e : entries) {
                    out.append(e.directory() ? "[目录] " : "[文件] ").append(e.path());
                    if (!e.directory()) {
                        out.append("  ").append(e.size()).append(" 字节");
                        if (!e.readable()) {
                            out.append("  （不允许读取）");
                        }
                    }
                    out.append('\n');
                }
                if (listing.truncated()) {
                    // 说不出来的话，模型会把「500 个」当成「一共 500 个」，
                    // 然后据此下「这个目录里没有 X」这种错误结论
                    out.append("（条目过多，只列出了前 ").append(entries.size())
                            .append(" 条 —— 这不是全部，请进到子目录再看）\n");
                }
                return out.toString();
            }
            if ("read_workspace_file".equals(name)) {
                String path = String.valueOf(args.getOrDefault("path", ""));
                String content = workspaceService.read(path);
                // 记下读到这一刻的指纹：写草稿要靠它，确认时拿它和磁盘现状比
                loop.baselines.put(path, workspaceService.baselineOf(path));
                return content;
            }
            if ("write_workspace_file".equals(name)) {
                String path = String.valueOf(args.getOrDefault("path", ""));
                String content = String.valueOf(args.getOrDefault("content", ""));
                String baseline = loop.baselines.get(path);
                if (baseline == null) {
                    // 没读过就要改：对已存在的文件这是盲写，必须挡住。
                    // 文件本来就不存在（新建）则不需要先读 —— 基线就是 ABSENT。
                    String current = workspaceService.baselineOf(path);
                    if (!WorkspaceService.ABSENT.equals(current)) {
                        return "操作被拒绝：改动一个已存在的文件之前必须先 read_workspace_file 读过它。"
                                + "没读过就改是拿想象中的内容覆盖真实内容。";
                    }
                    baseline = WorkspaceService.ABSENT;
                }
                // 先按写入规则校验一遍路径，让不合法的路径当场告诉模型，而不是等到用户点确认
                workspaceService.checkWritable(path);
                Map<String, Object> draft = new LinkedHashMap<>();
                draft.put("path", path);
                draft.put("content", content);
                draft.put("baseline", baseline);
                draft.put("creating", WorkspaceService.ABSENT.equals(baseline));
                loop.drafts.removeIf(d -> path.equals(d.get("path")));   // 同一文件以最后一次为准
                loop.drafts.add(draft);
                return "已生成草稿（磁盘上的文件没有改动）：" + path
                        + "。请告诉用户到「待确认」面板看过 diff 之后确认才会落盘。";
            }
            if ("run_workspace_command".equals(name)) {
                String command = String.valueOf(args.getOrDefault("command", ""));
                Object rawArgs = args.get("args");
                List<String> argv = new ArrayList<>();
                if (rawArgs instanceof List<?> list) {
                    for (Object one : list) {
                        argv.add(String.valueOf(one));
                    }
                }
                String dir = String.valueOf(args.getOrDefault("path", ""));
                if ("null".equals(dir)) {
                    dir = "";
                }
                WorkspaceExecutor.ExecResult run = workspaceExecutor.exec(command, argv, dir);
                // 判过题了 —— 下一轮起才允许把错题记进薄弱点页
                loop.ranCommand = true;
                return "退出码 " + run.exitCode() + (run.timedOut() ? "（超时被强制结束）" : "")
                        + "，用时 " + run.millis() + "ms\n"
                        + (run.output().isBlank() ? "（没有输出）" : run.output());
            }
            if ("search_workspace".equals(name)) {
                String query = String.valueOf(args.getOrDefault("query", ""));
                String path = String.valueOf(args.getOrDefault("path", ""));
                if ("null".equals(path)) {
                    path = "";
                }
                WorkspaceService.SearchResult result = workspaceService.search(query, path);
                if (result.hits().isEmpty()) {
                    return "没有找到「" + query + "」（扫了 " + result.filesScanned() + " 个文件）。"
                            + "换个关键词，或者先用 list_workspace_files 看看目录结构。";
                }
                StringBuilder out = new StringBuilder();
                for (WorkspaceService.Hit hit : result.hits()) {
                    out.append(hit.path()).append(':').append(hit.line()).append("  ")
                            .append(hit.text()).append('\n');
                }
                // 截断必须说出来：模型把「80 条」当成「一共 80 条」就会给出错误的结论
                out.append(result.truncated()
                        ? "\n（还有更多，只返回了前 " + result.hits().size() + " 条 —— 换一个更具体的关键词再搜）"
                        : "\n（共 " + result.hits().size() + " 条，扫了 " + result.filesScanned() + " 个文件）");
                return out.toString();
            }
            return "未知的工作区工具：" + name;
        } catch (BusinessException e) {
            // 拒绝的理由要原样给模型：它需要如实转述给用户，而不是换个路径再试一次
            return "操作被拒绝：" + e.getMessage();
        } catch (Exception e) {
            return "工作区操作失败：" + e.getMessage();
        }
    }

    String systemPrompt() {
        return """
                你在帮一名学生读懂和改进他自己电脑上的代码。你可以列目录、读文件、按关键词搜。

                几条硬性要求：
                1. 回答之前先去读真实的文件，不要凭文件名猜内容。
                2. 引用代码时给出文件路径，最好带行号，让他能自己去看。
                2.1 项目大的时候先 search_workspace 定位，再 read_workspace_file 细看 ——
                    一层层列目录会把轮次用光却什么都没读到。
                2.2 搜索结果说「还有更多」时，你看到的<b>不是全部</b>。这时不要下
                    「只有这几处用到」这类结论，换一个更具体的关键词再搜。
                3. 你能不能改文件、能不能跑命令，取决于这一轮给了你哪些工具 —— 没给就是没有。
                   3.1 有 write_workspace_file 时：它<b>只生成草稿</b>，磁盘没有改动。
                       所以说「改动已生成草稿，你确认后才会写入」，不要说「我已经改好了」。
                   3.2 没有 write_workspace_file 时：把改动写成代码块给他，说明改哪个文件的哪一段。
                   3.3 有 run_workspace_command 时：只能跑工作区里<b>已经存在的文件</b>。
                       想跑一段新代码，先写成草稿让他确认落盘，再跑 —— 这样他知道自己机器上
                       将要执行的是什么。命令行上塞代码（-c/-e）会被拒绝。
                   3.4 他要你<b>新做</b>一个东西（小游戏、网页、脚本、小工具）时，不必先找已有文件：
                       直接用 write_workspace_file 新建。尽量做成单个文件、打开或运行就能用的，
                       并在回答里说清楚怎么打开或怎么跑。新建的文件不需要先读。
                   3.5 路径一律相对工作区根目录。根目录本身就是他选的那个文件夹（名字见最后一行）——
                       他说「放在 X 文件夹里」而 X 正是根目录的名字时，直接写在根目录下，
                       不要再套一层同名子文件夹。
                   3.6 对话历史里你已经写出了代码、而他说「确认创建」「直接写进去」「新建文件」时，
                       就用 write_workspace_file 把那份代码写成草稿 —— 不要再贴一遍，也不要再问一遍。
                4. 工具返回「不在允许清单里」「超出工作区范围」时，那是刻意的保护，
                   如实告诉他，不要换着法子绕过去。

                如果他是在刷题 / 练习，按这条环路走：
                5.1 出题之前先 search_wiki 看看「薄弱点」类的页，题要照着他真正错过的地方出，
                    而不是照着通用大纲出。
                5.2 题目和测试用例写成文件草稿（write_workspace_file），让他确认落盘。
                    测试要能单独跑，而且失败信息要说清期望什么、实际什么。
                5.3 他写完解法之后用 run_workspace_command 跑测试。
                5.4 <b>判题失败之后</b>才记薄弱点，而且要先 read_wiki_page 完整读出那一页，
                    把新的一条<b>追加</b>在原有内容后面再提交草稿 —— 直接提交只有新内容的整页
                    会把他以前积累的笔记全冲掉。没读整页的话工具会拒绝你，那是刻意的。
                5.5 判题通过就别记薄弱点。那一页是给他复习用的，掺进通过的题会稀释它。

                如果他是在做一个项目，按这条环路走：
                6.1 先看工作区里已经有什么，再说下一步 —— 不要给一份脱离现状的通用路线图。
                6.2 一次只推进<b>一个</b>里程碑：说清这一步要做出什么、怎么算做完。
                    一口气把十步都写出来，他哪一步都不会开始。
                6.3 这一步的脚手架和验收测试写成文件草稿，让他确认落盘；他写完之后跑测试验收。
                6.4 有 create_study_plan 时，把里程碑排成任务草稿 —— 一个里程碑一条，
                    标题要具体（「实现登录接口并通过 3 个测试」而不是「第二阶段」）。
                    它同样是草稿，他在确认面板勾选之后才进日历，所以不要说「已经加到你日历了」。
                """;
    }
}
