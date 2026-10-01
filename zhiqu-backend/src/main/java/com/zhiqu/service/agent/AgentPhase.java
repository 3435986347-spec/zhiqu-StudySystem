package com.zhiqu.service.agent;

/**
 * 一轮流式问答的四个时刻 —— 遍历按 {@code (phase, order)} 走，事件按<b>正在遍历的相位</b>路由。
 *
 * <h2>为什么是四个而不是三个</h2>
 *
 * <p>「流式之后」看着像一段，实际是两段，中间隔着一把用户级锁和一个事务：
 *
 * <pre>
 *   computeLongTermMemoryUpdate(...)   ← 调模型
 *   suggestPlanFromChatIfNeeded(...)   ← 调模型（Function Calling）
 *   conversationLocks.withUserLock(userId, () -&gt; conversationTx.execute(tx -&gt; {
 *       ... 只有短 DB 操作，无模型调用 ...
 *   }));
 * </pre>
 *
 * <p>两次模型调用<b>刻意放在锁外</b>：把它们挪进事务，锁的持有时长就从毫秒级变成一次模型往返，
 * 而这段代码自己的注释写着「全部原子完成(只有短 DB 操作,无模型调用)」。
 * 所以 PLANNER 这种「工作要调模型、落库要在事务里」的节点<b>必须能声明两个不同的位置</b> ——
 * 这正是 {@link AgentStageRunner#runAt()} 与 {@link AgentStageRunner#commitAt()} 分开的原因。
 * 只有一个 {@code POST_STREAM} 的话，二选一都是错：放锁外则落库不原子，放锁内则模型调用进事务。
 */
public enum AgentPhase {

    /** 流式之前：检索、校验，以及那些<b>刻意提前发</b>的宣告。事件直发。 */
    PRE_STREAM,

    /** 流式模型调用本身。事件直发（增量要实时到前端）。 */
    STREAM,

    /**
     * 流式之后、最终事务之前。<b>不持锁、不在事务里，可以调模型</b>。事件直发。
     * 记忆整理与计划提取都在这里。
     */
    POST_STREAM,

    /**
     * 锁内短事务：归属校验、消息收尾、草稿工件落库、节点终态、run 终态。
     * <b>只允许短 DB 操作，不得调模型。</b>
     * 事件<b>不能直发</b> —— 回滚时前端会收到指向不存在数据的事件，
     * 所以这一相位的 {@code emit} 一律进缓冲，由编排层在事务提交后按序补发。
     */
    COMMIT
}
