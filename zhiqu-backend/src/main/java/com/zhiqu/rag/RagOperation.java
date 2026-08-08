package com.zhiqu.rag;

/**
 * RAG 作业类型的<b>唯一定义</b>。
 *
 * <p>存在的理由不是「用枚举比字符串好」，而是这个代码库结构上会长出一种特定的洞：
 * <b>有消费端、没有生产端的作业类型</b>。生产端在 {@link RagIndexJobService}、
 * 消费端在 {@link RagIndexWorker} 的 switch，两边在不同文件、不同时间写，
 * 而字符串字面量让编译器对「两边是否覆盖同一个集合」毫无意见。
 *
 * <p>实际发生过三次，没有一次是编译或测试发现的：
 * <ul>
 *   <li>{@code RECONCILE_UNITS} —— 回滚演练走到第 3 步无路可走时才暴露；</li>
 *   <li>{@code DELETE_SCOPE} —— 自查时发现（消费端刚写完、生产端还没有）；</li>
 *   <li>{@code DELETE_INDEX_VERSION} —— 评审时发现，<b>一直就没有生产端</b>，
 *       且它与 {@code DELETE_GENERATION} 指向同一批向量（代次与 collection 一对一，
 *       见 {@code RagIndexJobService} 的 {@code "zhiqu_rag_g_" + id}），已删除。</li>
 * </ul>
 *
 * <p>两半分别交给两种手段，因为它们的可判定性不同：
 * <ul>
 *   <li><b>消费端 —— 交给编译器。</b>{@code RagIndexWorker.process()} 对本枚举做增强 switch
 *       且<b>不写 default 分支</b>：加一个常量而不处理它，编译当场失败。这是消除，代价为零。</li>
 *   <li><b>生产端 —— 只能靠测试。</b>没有任何语言机制能要求「这个常量必须被谁调用」，
 *       所以由 {@code RagOperationCoverageTest} 断言每个常量至少有一个入队点。
 *       一次断言覆盖整个词表，不是每个操作各写一条 —— 后者的问题正是「加了新常量的人
 *       也不会想起来加那一条」。</li>
 * </ul>
 *
 * <p><b>1B-2 的 1c 删掉了 {@code UPSERT_SOURCE} 与 {@code REINDEX_SOURCE}。</b>
 * 不是清理，是被迫的：Stage D 之后 sidecar 的 {@code IndexRequest} 要求
 * {@code namespace} 与 {@code unitId}，旧载荷会被 422 拒绝。留着它们就等于留下两个
 * 「有消费端、生产端已死」的常量 —— 正是本枚举要消除的形状。索引侧现在只有
 * {@code UPSERT_UNIT} 一条路径，Notebook 资料与 Wiki 页共用它。
 *
 * <p>删除的代价是明确的：切换期间队列里若还有 {@code UPSERT_SOURCE} 行，
 * {@link #from} 会返回 null，worker 把它当失败作业上报直至 DEAD 并写 RuntimeIssue。
 * runbook 第 1 步先冻结生产者、等队列排空，就是为了这个。<b>吵，但看得见</b> ——
 * 比留一个永不被入队的常量强。
 */
public enum RagOperation {
    /** 删除单个资料的向量。双删下 LEGACY 发 SOURCE、UNIT 发 UNIT。 */
    DELETE_SOURCE,
    /** 删除整个 Notebook 的向量。双删下 LEGACY 发 NOTEBOOK、UNIT 发 SCOPE。 */
    DELETE_NOTEBOOK,
    /** 删除一个作用域（Notebook / 会话）下的全部单元向量 —— UNIT 方言专用。 */
    DELETE_SCOPE,
    /** 删除整个代次的 collection。旧代次 24h 后清理走这条（runbook 第 11 步）。 */
    DELETE_GENERATION,
    /** 展开一个 BUILDING 代次，为其中每个目标入队索引作业。 */
    REBUILD_GENERATION,
    /** 增量刷新一个投影单元。 */
    UPSERT_UNIT,
    /** 退役一个投影单元并删除其向量。 */
    DELETE_UNIT,
    /** 全量对账：从原始表重新枚举投影。<b>不与 sidecar 交互</b>，故不受其可用性约束。 */
    RECONCILE_UNITS;

    /**
     * 字符串 → 枚举。作业表里存的是字符串，且可能是**旧版本写入的**未知值。
     *
     * <p>返回 null 而不是抛异常，由调用方决定怎么处理：worker 需要把未知操作当成
     * 失败作业上报（它可能来自一个更新的版本），而不是让整个批次的循环炸掉。
     */
    public static RagOperation from(String value) {
        if (value == null) return null;
        try {
            return valueOf(value);
        } catch (IllegalArgumentException unknown) {
            return null;
        }
    }
}
