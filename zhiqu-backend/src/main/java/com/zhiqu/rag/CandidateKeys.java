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
 *
 * <h2>这些名字是<b>已持久化的线格式</b>，收成一处<b>不</b>等于改名变安全了</h2>
 *
 * <p>读到「收成一处、重命名于是变成编译期改动」很容易顺推出「那改名现在安全了，
 * 编译器会管」。<b>那个推论是错的</b>，而且错在编译器看不见的三个地方：
 *
 * <ul>
 *   <li>候选行<b>整行</b>落进 {@code AiAgentArtifact} 的 content
 *       （{@code AiServiceImpl.java:544-552}）—— 存量 artifact 会永远带着旧键名；</li>
 *   <li>同一行的 {@link #SOURCE_TYPE} / {@link #SOURCE_ID} 被抽成
 *       {@code AiAgentEvidence} 的两个列（{@code AiServiceImpl.java:558-559}）；</li>
 *   <li>前端按名字读（{@code assets/zhiqu-api.js:2313}、{@code :2489}）——
 *       改名要连带 14 个页面与 service worker 的 {@code ?v=} 令牌一起动。</li>
 * </ul>
 *
 * <p>所以本类消掉的是<b>「生产端与消费端取值分叉」这一个</b>风险，
 * 它<b>邀请了一个自己无力保护的动作</b>：改名的代价是存量数据迁移 + 前端改动 + 缓存令牌重置，
 * 而这三处编译器全都无话可说。要改名，必须连带迁移存量 artifact/evidence 与前端。
 *
 * <p>这条约束是 1B-2 step 2 才查出来的 —— 在那之前
 * {@code ContextBudgeterCharacterizationTest} 的注释里还写着「检索侧把 sourceId 换成
 * unitId 的那一刻本文件必然转红」，那句话的前提就是这次改名会发生。它不会。
 * step 3 的形状是<b>键名不动，{@link #SOURCE_TYPE} 的取值域加进 {@code WIKI_PAGE}</b>。
 */
public final class CandidateKeys {

    /** 单元所属命名空间；与 {@link #SOURCE_ID} 一起构成每源配额的桶键。 */
    public static final String SOURCE_TYPE = "sourceType";
    /**
     * 单元标识。Notebook 行是资料 id，Wiki 行是 {@code "wiki:" + pageId}，都会被字符串化。
     *
     * <h3>不变量：<b>同一个单元，无论由哪个生产者产出，必须发同一个 {@code (sourceType, sourceId)}</b></h3>
     *
     * <p>承重的是<b>生产者之间的一致</b>，不是取值形状本身。今天 Wiki 行有一个既有生产者：
     * {@code wikiContext}（{@code AiWorkspaceServiceImpl.java:983}）发
     * {@code WIKI_PAGE} + {@code "wiki:" + pageId}。step 3 的回填器是<b>第二个</b>，
     * 两者必须逐字一致 —— 所以 step 3 沿用 {@code "wiki:" + pageId}，
     * 换形状（比如改发 {@code unitId}）就得连 {@code wikiContext} 一起换。
     *
     * <p><b>两者不一致时的具体链路（不是推测，可照着读）：</b>
     * <ol>
     *   <li>{@code sourceContext} 在 {@code includeWiki=true} 时把 {@code wikiContext} 的行
     *       并进 {@code supplements}（{@code :492}）；</li>
     *   <li>同一次调用里 {@code vectorRows} 与 {@code supplements} 一起进
     *       {@code contextBudgeter.select(...)}（{@code :498}）；</li>
     *   <li>于是一个既被显式选中、又被向量检索命中的页，会以<b>两行</b>出现，
     *       而两行的 {@code sourceId} 形状不同 → 两个桶键；</li>
     *   <li>{@code effectiveSourceCount = max(sourceCount, distinct(sourceKey))}
     *       （{@code ContextBudgeter.java:36}）随之虚高一格。</li>
     * </ol>
     * 那正是第三条新基准声称在测量的量，于是它会因为与「{@code sourceCount} 放宽」
     * 毫不相干的原因变色 —— 转绿转红读出来都是错的。
     *
     * <h3>本字段已经承载两条性质，将来要拆</h3>
     *
     * <p>「直接改用 {@code unitId}」看起来更干净（V29 的代理主键跨命名空间天然唯一，
     * 不需要任何前缀），但今天做不了，因为本字段还担着第二个角色：
     * <b>与请求里的 {@code selectedSourceIds} 比对</b>
     * （{@code AiWorkspaceServiceImpl.java:488} 拿 {@code parseLong(row.get(SOURCE_ID))}
     * 去 {@code selectedIds.contains(...)}）。那个比对要的是<b>资料 id</b>，不是单元 id ——
     * 换成 {@code unitId} 会让它恒不命中，显式行不再被标记，轮转优先级悄悄改变，
     * <b>不抛异常、不记指标</b>。
     *
     * <p>一个字段同时承载「分桶身份」与「请求侧匹配身份」，正是判据不等宽那件事在数据模型上的形态：
     * 将来任一侧的口径变化都会波及另一侧。<b>正确的收尾是拆成两个字段</b>
     * （分桶用 {@code unitId}，请求侧匹配用资料 id），而不是继续用一个带前缀的字符串
     * 把两件事编码进同一个值里。不在 step 3 做：它要动 {@code wikiContext}、{@code :488}
     * 与存量 evidence 的取值形状，属于另一步。
     */
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
