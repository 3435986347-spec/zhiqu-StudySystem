package com.zhiqu.service.agent;

/**
 * 任务图里一个节点的执行体。<b>次序由它声明的位置决定，不由调用点的书写顺序决定。</b>
 *
 * <h2>三个位置，因为代码里真有三个时刻</h2>
 *
 * <p>宣告、工作、落库不一定同处一相，而且方向可以相反：
 *
 * <table border="1">
 *   <caption>现有流水线里各节点的三个位置</caption>
 *   <tr><th>runner</th><th>宣告</th><th>工作</th><th>落库</th></tr>
 *   <tr><td>RETRIEVER / VERIFIER</td><td>PRE_STREAM</td><td>PRE_STREAM</td><td>PRE_STREAM</td></tr>
 *   <tr><td>FINAL_WRITER</td><td><b>PRE_STREAM</b></td><td>STREAM</td><td><b>COMMIT</b></td></tr>
 *   <tr><td>PLANNER</td><td><b>PRE_STREAM</b></td><td><b>POST_STREAM</b>（要调模型）</td><td><b>COMMIT</b></td></tr>
 *   <tr><td>TASK_DRAFTER / WIKI_CURATOR</td><td>COMMIT</td><td>COMMIT</td><td>COMMIT</td></tr>
 * </table>
 *
 * <p>PLANNER 的<b>宣告在 FINAL_WRITER 之前，工作却在 FINAL_WRITER 之后</b>：
 * 宣告提前是 UX 要求（用户在整个流式期间看到「正在准备计划草稿」），
 * 工作靠后是真实依赖（planner 要解析 writer 的产出）。两个次序方向相反，
 * <b>一个位置表达不了</b>，所以宣告与工作各有各的 {@link AgentPosition}。
 *
 * <h2>图决定跑不跑</h2>
 *
 * <p>{@link #inGraph} 默认就是「图里有没有我这个类型的节点」。
 * 节点不在图里时，executor <b>只调 {@link #announceSkipped}</b>，绝不调
 * {@link #run} / {@link #commit} —— 「造了节点却不跑」和「跑了却没造节点」这两种历史故障
 * （幽灵 agent / 隐形 agent，见 {@link AgentPlanDecision}）因此在结构上写不出来。
 */
public interface AgentStageRunner {

    /** 注册键，同时是 {@link #inGraph} 默认实现的查询键。 */
    String agentType();

    /** 工作在哪跑。必填。 */
    AgentPosition runAt();

    /** 宣告在哪发。默认与工作同处。 */
    default AgentPosition announceAt() {
        return runAt();
    }

    /** 落库与完成事件在哪发。默认与工作同处。 */
    default AgentPosition commitAt() {
        return runAt();
    }

    /**
     * 本轮图里有没有这个节点。默认按 {@link #agentType()} 查图。
     *
     * <h2>覆盖它的地方一共五处，分三类 —— grep 到这里的人不必自己重推</h2>
     *
     * <table border="1">
     *   <caption>AiServiceImpl 里的 inGraph 覆盖</caption>
     *   <tr><th>runner</th><th>返回</th><th>属于哪一类</th></tr>
     *   <tr><td>RETRIEVER</td><td>查一组类型</td>
     *       <td><b>正常</b>：图里的节点可能叫三种专职 researcher 之一，键不止一个</td></tr>
     *   <tr><td>WIKI_TOOL_AGENT</td><td>恒真</td>
     *       <td rowspan="3"><b>还没被图管住</b>：图里根本没有它们的节点。
     *           建节点会让执行轨迹多出用户此前看不到的 agent，是行为变化，本阶段不做</td></tr>
     *   <tr><td>MEMORY_EXTRACTOR</td><td>恒真</td></tr>
     *   <tr><td>PLAN_EXTRACTOR</td><td>恒真</td></tr>
     *   <tr><td>WIKI_CURATOR</td><td>恒真</td>
     *       <td><b>被图管着却不理图（重一档）</b>：图里<b>有</b>它的节点
     *           （{@code needsWikiCurator} 会造），但 runner 不问那个节点，
     *           改用自己的 {@code looksWikiWriteIntent}。两个门形状不同（OR vs AND），
     *           偏差是系统性的 —— 说明见该 runner 的类注释</td></tr>
     * </table>
     */
    default boolean inGraph(AgentRunContext ctx) {
        return ctx.task(agentType()) != null;
    }

    /** 节点在图里时的宣告（起任务、起步骤）。 */
    default void announce(AgentRunContext ctx) {
    }

    /** 节点不在图里时的公告（多数 runner 无声跳过；RETRIEVER / PLANNER 要告诉用户「本轮不需要」）。 */
    default void announceSkipped(AgentRunContext ctx) {
    }

    /** 工作。 */
    void run(AgentRunContext ctx);

    /** 落库与完成事件。 */
    default void commit(AgentRunContext ctx) {
    }
}
