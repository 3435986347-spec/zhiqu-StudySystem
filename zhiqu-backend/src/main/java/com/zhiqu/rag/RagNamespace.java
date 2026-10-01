package com.zhiqu.rag;

import com.zhiqu.common.SystemPageTitles;

import java.util.Set;

/** 投影表的取值词表。散落成字面量的话，拼错只会表现为「查不到」而不是编译错误。 */
public final class RagNamespace {

    public static final String NOTEBOOK_SOURCE = "NOTEBOOK_SOURCE";
    public static final String WIKI_PAGE = "WIKI_PAGE";
    public static final String CONVERSATION_TURN = "CONVERSATION_TURN";

    public static final String SCOPE_NOTEBOOK = "NOTEBOOK";
    public static final String SCOPE_WIKI_TREE = "WIKI_TREE";
    public static final String SCOPE_CONVERSATION = "CONVERSATION";

    /** 单元生命周期。刻意不用 {@code deleted}，见 {@code RagIndexableUnit} 的类注释。 */
    public static final String STATUS_READY = "READY";
    public static final String STATUS_RETIRED = "RETIRED";
    public static final String STATUS_SKIPPED = "SKIPPED";

    /**
     * 不进 RAG 的 Wiki 页类型。
     *
     * <p>INDEX/LOG/SCHEMA 是系统维护页，GUIDE（学习守则）是每轮逐字注入提示词的内容 ——
     * 再索引一遍等于同一段文字在上下文里重复计数，挤掉真正的检索结果。
     */
    public static final Set<String> EXCLUDED_PAGE_TYPES = Set.of("INDEX", "LOG", "SCHEMA", "GUIDE");

    /**
     * 该 Wiki 页是否排除出索引。<b>类型与标题都要看。</b>
     *
     * <p>只看 {@code page_type} 会漏掉一整类：知识库侧的系统页判定是「类型<b>或</b>标题」
     * （{@code KnowledgeServiceImpl.isSystemKnowledgePage}），因为 {@code page_type} 会被历史
     * 请求改坏、而 {@code ensureSystemPage} 按标题查找覆写。于是标题为 {@code index} 而
     * {@code page_type='NOTE'} 的页，知识库当系统页保护、RAG 却照常索引它 ——
     * 而 {@code index} 是自动生成的全站标题目录，几乎能命中任何查询。
     *
     * <p>标题那一半复用 {@link SystemPageTitles#matches}，不在这里复制词表：两份词表迟早分叉，
     * 而分叉的表现是「某类页悄悄进了索引」，不是编译错误。
     *
     * <p>反方向刻意不对称：GUIDE 只在这里按类型排除，<b>不</b>进 {@code SystemPageTitles} ——
     * 那会给它装回标题锚点并封死改名，与「GUIDE 是用户可自由改名的自己的笔记页」直接冲突。
     */
    public static boolean isExcludedWikiPage(String pageType, String title) {
        String type = pageType == null ? "" : pageType.toUpperCase();
        return EXCLUDED_PAGE_TYPES.contains(type) || SystemPageTitles.matches(title);
    }

    private RagNamespace() {
    }
}
