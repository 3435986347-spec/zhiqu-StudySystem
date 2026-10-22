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
     * <h2>覆盖它的地方只剩一处，而且是正当的 —— grep 到这里的人不必自己重推</h2>
     *
     * <p><b>这张表没有任何东西会因为它过时而红。</b>加/减一处覆盖时必须手动改这里 ——
     * 图那一侧倒是有保护（{@code GraphCase} 钉住了每个用例造出的节点集合，新增节点会直接红）。
     *
     * <table border="1">
     *   <caption>AiServiceImpl 里的 inGraph 覆盖</caption>
     *   <tr><th>runner</th><th>返回</th><th>属于哪一类</th></tr>
     *   <tr><td>RETRIEVER</td><td>查一组类型</td>
     *       <td><b>正常</b>：图里的节点可能叫三种专职 researcher 之一，键不止一个</td></tr>
     * </table>
     *
     * <p>曾经在这张表里、现在不在的四个：
     *
     * <ul>
     *   <li>MEMORY_CURATOR（那时叫 MEMORY_EXTRACTOR）、WIKI_TOOL_AGENT、PLAN_EXTRACTOR ——
     *       都属于「还没被图管住」，各自有了自己的节点。</li>
     *   <li>WIKI_CURATOR 属于更重的一类：<b>被图管着却不理图</b> ——
     *       图里有它的节点，runner 却不问，改用一个与建图侧<b>形状不同</b>的门（AND vs OR），
     *       两个方向都漏。两个门已统一到 {@link AgentPlanDecision#wikiWriteIntent}。</li>
     * </ul>
     *
     * <p><b>现在「跑了却没造节点」这件事在结构上写不出来了</b>，除了 RETRIEVER 那一处正当覆盖。
     * 再想加后门，先问自己为什么这个 agent 不该出现在用户看得到的执行轨迹里。
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

    /**
     * 并发组。同组的 {@link #run} 会在同一相位里<b>并发</b>执行；返回 null 表示不参与并发。
     *
     * <p><b>只有 run 并发，宣告与落库始终顺序执行。</b>宣告的次序是 UX（用户按顺序看到 agent 上场），
     * 落库要往 {@code AgentRunContext} 的缓冲队列里写，那个队列不是并发容器 ——
     * 而且 COMMIT 整段在一个事务里，并发写库会把事务边界搅乱。
     *
     * <p>组内成员仍各占一个唯一的 {@link AgentPosition}（executor 会拒绝抢同一槽位的配置）。
     * 位置在组内只决定「谁先被提交到线程池」，不决定谁先完成 —— 并发本来就没有组内次序，
     * 依赖组内次序的东西不该放进同一个组。
     */
    default String parallelGroup() {
        return null;
    }

    /** 工作。 */
    void run(AgentRunContext ctx);

    /** 落库与完成事件。 */
    default void commit(AgentRunContext ctx) {
    }
}
