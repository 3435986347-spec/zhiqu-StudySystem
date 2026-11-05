package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.AdminGuard;
import com.zhiqu.service.agent.AgentPlanDecision;
import com.zhiqu.service.workspace.WorkspaceExecutor;
import com.zhiqu.service.workspace.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

/**
 * 网页 / 桌面应用代码模式的门和桥。
 *
 * <p>循环本身是命令行那一份（第九十四到九十七轮，用户 2026-11-02 定的「两份 coding agent 合成一份：一份 JS，后端用子进程跑」）：
 * {@link JsCodeAgent} 起 node 跑 {@code zhiqu-cli/src/host/code-host.js}，工具、提示、提醒、草稿模式都在那边。
 * 这里只剩两件事：
 * <ul>
 *   <li><b>门</b>：是不是管理员、工作区档位、有没有写意图、能不能执行、是不是项目引导 —— 只在这里判，判完原样交过去；</li>
 *   <li><b>远程工具</b>：Wiki 工具和「把里程碑排成任务」经桥回到这里执行（{@link WikiToolAgent} 那一套加固过的路、
 *       {@link StudyPlanTool} 那一份 schema 和解析器），里程碑计划、Wiki 待合入草稿交回主流程。</li>
 * </ul>
 * 原来的 Java 工具循环（第五刀从 {@code AiServiceImpl} 搬出来的那一整块）第九十七轮删了。
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

    /** 跑命令行那一份循环（第九十四轮起）；它起不来（找不到 node）代码模式就没有，主回答照常 */
    private JsCodeAgent jsEngine;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setJsEngine(JsCodeAgent jsEngine) {
        this.jsEngine = jsEngine;
    }

    /**
     * 这一轮的产物：给最终回答用的上下文、待确认的写草稿、里程碑计划（可为 null）。
     * {@code writeAttempted}：这一轮真的调过写文件的工具（第九十四轮）—— 能写、没草稿时，「没写成」只在试过写的时候才说；
     * 只是跑了个测试（用户说「写进去了，跑一下」）就不该说没写成、让他再说一次「写进去」。说不清的老构造器按「试过」算，和原来一样。
     */
    public record Result(String context, List<Map<String, Object>> drafts, Map<String, Object> milestonePlan,
                         boolean writeOffered, List<Long> wikiPendingPatchIds, boolean writeAttempted) {
        public Result {
            wikiPendingPatchIds = wikiPendingPatchIds == null ? List.of() : List.copyOf(wikiPendingPatchIds);
        }
        public Result(String context, List<Map<String, Object>> drafts, Map<String, Object> milestonePlan,
                      boolean writeOffered, List<Long> wikiPendingPatchIds) {
            this(context, drafts, milestonePlan, writeOffered, wikiPendingPatchIds, true);
        }
        public Result(String context, List<Map<String, Object>> drafts, Map<String, Object> milestonePlan,
                      boolean writeOffered) {
            this(context, drafts, milestonePlan, writeOffered, List.of());
        }
        public static final Result EMPTY = new Result("", List.of(), null, false, List.of(), false);
    }

    /** 经桥执行的远程工具的状态 —— 和原来 Java 循环里同一份防护 */
    static final class LoopState {
        /**
         * 这一次有没有真的跑过一次命令（判过题）。「把错题记进薄弱点页」的前提不是用户说了什么关键词，而是<b>确实判过题</b> ——
         * 所以 {@code create_wiki_patch} 只在这之后才下发（宿主每一轮重建工具表）、执行时也核。
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
     * 跑一轮。失败不影响主回答 —— 最坏是空结果。
     *
     * @param onStep 每一步的叙述（{@code agent.step.note}），网页的执行轨迹读它；可为 null
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
        // 最小权限：只有明确的写意图才给写工具。不给，它就不会尝试，也不会承诺自己改了文件
        boolean canWrite = workspaceService.access().effectiveMode().allowsWrite()
                && AgentPlanDecision.codeWriteIntent(userMessage, contextOptions);
        // 执行这一档由 WorkspaceExecutor 自己说了算（档位 + 非生产 profile 两条都在它里面）。这里不再复述那两个条件
        boolean canExec = workspaceExecutor.enabled();
        // 项目式引导才给「把里程碑排成任务」的能力：别的语境下模型不该往用户日历里塞东西
        boolean canPlanMilestones = AgentPlanDecision.projectIntent(userMessage);
        // 代码模式（档位开着）给大预算，关键词触发给小预算 —— 理由见 CodeLoopBudget
        CodeLoopBudget budget = CodeLoopBudget.forRequest(AgentPlanDecision.codeModeRequested(contextOptions));
        LoopState loop = new LoopState();
        Result viaJs = jsEngine == null || !jsEngine.enabled() ? null
                : jsEngine.run(config, userId, userMessage, recentHistory(history, limits.codeHistoryChars()),
                        canWrite, canExec, budget, limits, onStep, remoteTools(userId, loop, canPlanMilestones));
        if (viaJs == null) {
            // 第九十七轮删了 Java 的循环，没有后路了：说清楚缺什么，主回答照常
            log.warn("代码模式起不来（找不到 node 或命令行源码），这一轮没有读工作区 userId={}", userId);
            narrate(onStep, Map.of("phase", "error", "message",
                    "代码模式要用 Node（≥ 18.17）：这台机器上找不到，这一轮没有读工作区。装好 Node，或者用 app.ai.code-agent.node 指过去"));
            return Result.EMPTY;
        }
        return new Result(viaJs.context(), viaJs.drafts(), loop.milestonePlan, viaJs.writeOffered(),
                loop.wiki.pendingPatchIdsByTitle.values().stream().distinct().toList(), viaJs.writeAttempted());
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

    /**
     * 没下发的调用怎么回。分两种，不能混成一句：
     * <ul>
     *   <li>这个工具<b>存在</b>、只是这一轮的门关着（没有写意图、档位不许执行、还没判过题）——
     *       如实告诉用户没有这个能力，不许换个名字绕过去；</li>
     *   <li><b>根本没有</b>这个名字 —— 模型把别家 agent 的 {@code replace} / {@code edit_file} 带了过来。
     *       原来也回上一句，于是写工具明明下发了，模型却去告诉用户「我改不了文件」。
     *       现在说清「不是暂时的」、这一轮能用的是哪几个。能执行的仍然只有 {@code offered} 里的，所以这不会绕过任何门。</li>
     * </ul>
     */
    /** 交给命令行那份循环的远程工具（Wiki 读工具一直给，记薄弱点等判过题，里程碑只在项目引导时给）—— 第九十五轮起经桥执行 */
    JsCodeAgent.RemoteTools remoteTools(Long userId, LoopState loop, boolean canPlanMilestones) {
        List<Map<String, Object>> always = new ArrayList<>(wikiToolAgent.buildWikiTools(false));
        if (canPlanMilestones) {
            always.addAll(studyPlanTool.tools());
        }
        Set<String> alwaysNames = offeredToolNames(always);
        List<Map<String, Object>> afterRun = wikiToolAgent.buildWikiTools(true).stream()
                .filter(t -> !alwaysNames.containsAll(offeredToolNames(List.of(t)))).toList();
        return new JsCodeAgent.RemoteTools() {
            @Override
            public List<Map<String, Object>> always() {
                return always;
            }

            @Override
            public List<Map<String, Object>> afterRun() {
                return afterRun;
            }

            @Override
            public String call(String name, String argsJson, boolean ranCommand) {
                // 下发和执行同一份清单：没下发的照样拒（判过题之前的 create_wiki_patch 也在这里挡）
                Set<String> offered = new HashSet<>(alwaysNames);
                if (ranCommand) {
                    offered.addAll(offeredToolNames(afterRun));
                }
                if (!offered.contains(name)) {
                    return refusal(name, offered);
                }
                loop.ranCommand = ranCommand;
                return StudyPlanTool.NAME.equals(name) ? recordMilestonePlan(argsJson, loop)
                        : wikiToolAgent.executeWikiTool(userId, name, argsJson, loop.wiki).result;
            }
        };
    }

    String refusal(String name, Set<String> offered) {
        Set<String> existing = new HashSet<>(WikiToolAgent.TOOL_NAMES);
        existing.add(StudyPlanTool.NAME);
        if (existing.contains(name)) {
            return "操作被拒绝：这一轮没有给你「" + name + "」这个工具。"
                    + "如实告诉用户你没有这个能力，不要换个名字再试。";
        }
        return "操作被拒绝：没有叫「" + name + "」的工具 —— 不是暂时不可用，重试也不会有。这一轮能用的是："
                + String.join("、", new java.util.TreeSet<>(offered)) + "。";
    }
}
