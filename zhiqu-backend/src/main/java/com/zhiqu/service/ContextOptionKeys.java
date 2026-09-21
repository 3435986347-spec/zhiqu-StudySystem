package com.zhiqu.service;

import java.util.Set;

/**
 * {@code contextOptions} 的键名 —— <b>唯一定义</b>，并标明每个键的<b>来源</b>。
 *
 * <h2>为什么需要它：这是「声称存在、实际未接线」的第五次，而且识别点不同</h2>
 *
 * <p>前四次（{@code RECONCILE_UNITS}、{@code DELETE_SCOPE}、{@code DELETE_INDEX_VERSION}、
 * {@code RagRetriever} 的 fallback 指标）都在后端内部，识别点是「标识符里出现 {@code OR}」。
 * 第五次是 {@link #SELECTED_WIKI_PAGE_IDS}：名字毫无问题，问题是<b>没有任何客户端设它</b> ——
 * 那个识别点抓不到它。
 *
 * <p>结构上的洞是：{@code contextOptions} 是<b>跨前后端共享的一份键词表</b>，
 * 而它此前无单一定义、无覆盖测试，且类型是 {@code Map<String, Object>} ——
 * 拼错或从未设置，在两侧都不可见。这正是 {@code RagOperationCoverageTest} 为作业词表
 * 关掉的那个洞，只是这份词表跨了语言边界，所以那套办法没覆盖到。
 *
 * <h2>三类来源必须分开，否则覆盖测试会在 {@link #QUERY} 上误报</h2>
 *
 * <p>{@code query} <b>不是客户端键</b>：它由服务端在调用前塞进去
 * （{@code AiServiceImpl.java:527-528} 复制一份 contextOptions 再 {@code put("query", …)}）。
 * 一条只会问「活壳有没有发这个键」的测试，会把它报成第二个洞 —— 而判据的定义域
 * 比它声称报告的性质宽，正是本仓库反复记的那一族。
 */
public final class ContextOptionKeys {

    /** 客户端发：选中的资料 id 列表。活壳 {@code assets/zhiqu-api.js:2931} 在发。 */
    public static final String SELECTED_SOURCE_IDS = "selectedSourceIds";

    /**
     * 客户端发：这次问答要不要带上 Wiki。活壳 {@code assets/zhiqu-api.js:2930} 在发，
     * 而且是<b>无条件的字面 {@code true}</b> —— 不是用户开关。
     */
    public static final String INCLUDE_WIKI = "includeWiki";

    /**
     * 客户端发：显式选中的 Wiki 页 —— <b>今天没有任何活客户端设它</b>。
     *
     * <p>唯一的设值处是 {@code js/ai-assistant.js:1504}，而 {@code js/*.js} 被<b>零个页面</b>加载
     * （CLAUDE.md 已记）。加上 {@code wikiContext} 在选择为空时直接返回空表，
     * 结论是这条显式选择路径<b>在发布产品里从未产出过一行</b>。
     *
     * <p>保留而不删：E-3 已决定保留「勾了就一定用」这条语义（直读保底），
     * 它只是还没有界面。列进 {@link #UNWIRED_BY_DECISION} 是<b>显式豁免</b>，
     * 不是遗漏 —— 覆盖测试会要求每一个豁免都在这里写明理由。
     */
    public static final String SELECTED_WIKI_PAGE_IDS = "selectedWikiPageIds";

    /**
     * <b>服务端注入</b>，不是客户端键：{@code AiServiceImpl.java:528} 把用户这轮的消息
     * 放进这个键再调 {@code sourceContext}。客户端发不发它都不影响行为。
     */
    public static final String QUERY = "query";

    /** 由客户端提供的键 —— 覆盖测试要求活壳里至少有一处在发。 */
    public static final Set<String> CLIENT_SUPPLIED =
            Set.of(SELECTED_SOURCE_IDS, INCLUDE_WIKI, SELECTED_WIKI_PAGE_IDS);

    /** 由服务端在调用前注入的键 —— 不参与前端覆盖检查。 */
    public static final Set<String> SERVER_INJECTED = Set.of(QUERY);

    /**
     * <b>有意未接线</b>的客户端键，每一个都必须在自己的常量 javadoc 里写明理由。
     *
     * <p>它存在的意义是让「没接线」这件事从<b>沉默</b>变成<b>一次显式声明</b>：
     * 名单为空是正常状态，往里加一项要过一次人的判断，
     * 而漏接一个新键会让覆盖测试当天变红，不必等到某天发现一个功能从来没跑过。
     */
    public static final Set<String> UNWIRED_BY_DECISION = Set.of(SELECTED_WIKI_PAGE_IDS);

    private ContextOptionKeys() {
    }
}
