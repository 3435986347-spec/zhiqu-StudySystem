package com.zhiqu.rag;

import java.util.Map;

/**
 * 上下文候选行的键名 —— <b>唯一定义</b>。
 *
 * <p>候选行是一个 {@code Map<String, Object>}，生产端（{@code ContextCandidateHydrator}、
 * {@code AiWorkspaceServiceImpl} 的 legacy 行与 Wiki 行）与消费端
 * （{@link ContextBudgeter}）靠键名对接，而键名此前以字符串字面量散在两侧。
 *
 * <p><b>这是本仓库第五次「共享词表没有单一定义」</b>，处境与 {@code DELETE_SCOPES}
 * 当初一样，修法也一样：收成一处常量，两侧都引用它，重命名于是变成编译期改动。
 *
 * <p>为什么现在收：检索侧要把候选里的 {@code sourceId}/{@code sourceType} 换成
 * {@code unitId}/{@code namespace}，而 {@code ContextBudgeter} 是按字符串取值<b>且带
 * {@code getOrDefault(..., "")} 兜底</b>的 —— 两侧不同步时它不报错，只是退化：
 *
 * <ul>
 *   <li>去重键退化成 {@code ":" + chunkId} —— 跨命名空间 chunkId 撞上就误判重复；</li>
 *   <li>{@code sourceKey} 退化成 {@code ":"} —— <b>所有候选落进同一个桶</b>，
 *       于是 {@code maxPerSource=3} 作用在整个候选集上，最终只留 3 条。</li>
 * </ul>
 *
 * <p>后者尤其坏：不抛异常、不记指标，表现只是「检索回来的东西比预期少」——
 * 而那正好是第三条新基准要测量的维度（每源配额的口径）。
 * 在一个已经塌成一个桶的分母上去验「配额按所有命名空间计数」，
 * 得到的绿说明不了任何事情。
 */
public final class CandidateKeys {

    /** 单元所属命名空间；与 {@link #SOURCE_ID} 一起构成每源配额的桶键。 */
    public static final String SOURCE_TYPE = "sourceType";
    /** 单元标识。Notebook 行是资料 id，Wiki 行是 {@code "wiki:" + pageId}，都会被字符串化。 */
    public static final String SOURCE_ID = "sourceId";
    /** 父块 id；缺失时去重键回落到 {@link #CHUNK_INDEX}。 */
    public static final String CHUNK_ID = "chunkId";
    public static final String CHUNK_INDEX = "chunkIndex";
    public static final String CONTENT = "content";
    public static final String TITLE = "title";

    /** 内部标记，选完即从结果里删掉，不进模型上下文。 */
    public static final String SCORE = "_score";
    public static final String EXPLICIT = "_explicit";
    public static final String HIT_START = "_hitStart";
    public static final String HIT_END = "_hitEnd";

    /**
     * 取桶键的两段，<b>缺失即抛而不是回落成空串</b>。
     *
     * <p>三个生产端今天都必然填这两个键，所以缺失是<b>程序错误</b>而不是数据状况 ——
     * 与 {@code RagIndexWorker.unitScopeFor} 对不认识的作用域抛出是同一个取舍：
     * 不认识的输入要响亮地失败，而不是原样透传成一个更宽的行为。
     *
     * <p><b>代价说清楚：</b>这里在同步的用户请求路径上，抛出会变成一次 500。
     * 接受它，是因为另一边是「所有人的上下文长期少一半而无人知晓」——
     * 前者在开发与测试期就会当场暴露（三个生产端全被用例覆盖），
     * 后者只会以「AI 回答质量下降」的形式出现，且没有任何一层会报。
     */
    public static String sourceKeyOf(Map<String, Object> row) {
        Object type = row.get(SOURCE_TYPE);
        Object id = row.get(SOURCE_ID);
        if (type == null || id == null) {
            throw new IllegalStateException("上下文候选行缺少每源配额的桶键（"
                    + SOURCE_TYPE + "=" + type + ", " + SOURCE_ID + "=" + id
                    + "）。缺一个都会让全部候选塌进同一个桶，maxPerSource 于是作用在整个候选集上，"
                    + "而这不会抛异常也不会记指标 —— 所以在这里抛");
        }
        return type + ":" + id;
    }

    private CandidateKeys() {
    }
}
