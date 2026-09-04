package com.zhiqu.service.agent;

import com.zhiqu.service.ContextOptionKeys;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 一轮问答的意图判定 —— <b>唯一定义</b>。建图与执行都读它。
 *
 * <h2>为什么需要它：同一件事此前写在两处，而且已经分叉了</h2>
 *
 * <p>「这轮要不要跑 planner / retriever」此前有两套实现：
 * {@code MultiAgentOrchestratorImpl} 用一套决定<b>造哪些任务节点</b>，
 * {@code AiServiceImpl} 用另一套决定<b>跑不跑</b>。两套已经不一致，
 * 而且<b>方向相反</b>——这正是「同一事实两份拷贝」积累久了的样子，它不会只朝一个方向漂：
 *
 * <table border="1">
 *   <caption>合并前的两处分歧与裁决</caption>
 *   <tr><th>分歧点</th><th>建图侧</th><th>执行侧</th><th>裁决</th><th>症状</th></tr>
 *   <tr><td>{@code 安排}（planner 触发词）</td><td>有</td><td><b>无</b></td>
 *       <td><b>保留</b>（以建图侧为准）</td>
 *       <td><b>幽灵 agent</b>：造出 PLANNER 节点 → 执行侧判 false → 立刻 skip，
 *           用户看到一个宣告出现又立即消失的 agent</td></tr>
 *   <tr><td>{@link ContextOptionKeys#SELECTED_SOURCE_IDS}（retriever 触发）</td>
 *       <td><b>无</b></td><td>有</td><td><b>保留</b>（以执行侧为准）</td>
 *       <td><b>隐形 agent</b>：检索真的跑了，图里却没有 RETRIEVER 节点，
 *           用户在执行轨迹里看不到这次检索</td></tr>
 * </table>
 *
 * <p><b>合并必须逐个关键词裁决，不能整体择一。</b>整体择一必然错一半：
 * 以建图侧为准会删掉 {@code SELECTED_SOURCE_IDS} 那一条（用户选了资料源却不再检索，
 * 是功能回退）；以执行侧为准会丢掉「安排」。
 *
 * <p>两条裁决的性质不同，别笼统记成「一次行为变化」：
 * 「安排」是<b>新增行为</b>（此前造了节点不跑），{@code SELECTED_SOURCE_IDS} 是<b>保留行为</b>
 * （此前跑了不造节点，本次补上节点，执行侧一如既往）。
 *
 * <p>隐形 agent 那条今天被前端掩着：活壳恒发 {@code includeWiki: true}
 * （见 {@link ContextOptionKeys#INCLUDE_WIKI}），于是两侧都为真、撞不到分歧。
 * <b>走 UI 撞不到，直接调 API 撞得到。</b>
 */
public record AgentPlanDecision(
        String mode,
        boolean needsRetriever,
        boolean needsNotebook,
        boolean needsWeb,
        boolean includeWiki,
        boolean needsPlanner,
        boolean needsTaskDraft,
        boolean needsWikiCurator
) {

    private static final Set<String> MODES = Set.of("AUTO", "CHAT_ONLY", "RESEARCH", "PLAN");

    /**
     * 合并后的 planner 触发词。<b>「安排」在内</b> —— 建图侧此前有、执行侧此前没有，裁决为保留。
     * 与 {@code looksTaskCreationIntent} 是两件事：那个决定「是否调 create_study_plan 工具」，
     * 这个决定「造不造 PLANNER 节点、跑不跑」，合并需单独论证，本轮不动。
     */
    private static final List<String> PLANNER_WORDS = List.of("计划", "安排", "任务", "例行", "plan");
    private static final List<String> TASK_DRAFT_WORDS = List.of("生成任务", "写入任务", "例行任务", "task");
    private static final List<String> WIKI_CURATOR_WORDS = List.of("wiki", "知识库", "知识 wiki", "写进知识");

    public static String normalizeMode(String agentMode) {
        String value = agentMode == null ? "AUTO" : agentMode.trim().toUpperCase(Locale.ROOT);
        return MODES.contains(value) ? value : "AUTO";
    }

    public static AgentPlanDecision of(String agentMode, String message, boolean enableWebSearch,
                                       Long notebookId, Map<String, Object> contextOptions) {
        String mode = normalizeMode(agentMode);
        Map<String, Object> options = contextOptions == null ? Map.of() : contextOptions;
        boolean chatOnly = "CHAT_ONLY".equals(mode);

        boolean includeWiki = Boolean.TRUE.equals(options.get(ContextOptionKeys.INCLUDE_WIKI))
                || hasNonEmptyList(options.get(ContextOptionKeys.SELECTED_WIKI_PAGE_IDS));
        boolean hasSelectedSources = hasNonEmptyList(options.get(ContextOptionKeys.SELECTED_SOURCE_IDS));
        boolean needsNotebook = !chatOnly && notebookId != null;
        boolean needsWeb = !chatOnly && enableWebSearch;
        // hasSelectedSources 这一项来自执行侧，是本次合并里「保留行为」的那一条：
        // 少了它，用户勾选资料源却不再触发检索。
        boolean needsRetriever = !chatOnly
                && ("RESEARCH".equals(mode) || needsNotebook || needsWeb || includeWiki || hasSelectedSources);

        return new AgentPlanDecision(
                mode,
                needsRetriever,
                needsNotebook,
                needsWeb,
                includeWiki,
                plannerNeeded(mode, message),
                containsAny(message, TASK_DRAFT_WORDS),
                containsAny(message, WIKI_CURATOR_WORDS)
        );
    }

    private static boolean plannerNeeded(String mode, String message) {
        if ("PLAN".equals(mode)) {
            return true;
        }
        if ("CHAT_ONLY".equals(mode) || "RESEARCH".equals(mode)) {
            return false;
        }
        return containsAny(message, PLANNER_WORDS);
    }

    private static boolean containsAny(String message, List<String> words) {
        String text = message == null ? "" : message.toLowerCase(Locale.ROOT);
        return words.stream().anyMatch(text::contains);
    }

    private static boolean hasNonEmptyList(Object value) {
        return value instanceof List<?> list && !list.isEmpty();
    }
}
