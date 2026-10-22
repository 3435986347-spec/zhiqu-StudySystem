package com.zhiqu.common;

import java.util.Set;

/**
 * 系统页的保留标题 —— <b>全仓唯一定义</b>。
 *
 * <p>为什么标题也是锚点、而不只看 {@code page_type}：{@code page_type} 会被历史请求改坏
 * （{@code savePage} 的非系统页分支把它当请求可写字段），而 {@code ensureSystemPage} 是
 * <b>按标题</b>查找并覆写内容的。也就是说，一个标题叫 {@code index} 的页无论 {@code page_type}
 * 写着什么，事实上都会被系统页机制当成系统页对待。
 *
 * <p>提取成公共常量的直接原因是一次真实的不一致：知识库侧按「类型或标题」判定系统页，
 * 而 RAG 的排除集只看类型。于是一个 {@code page_type='NOTE'}、标题为 {@code index} 的页
 * 会被知识库当系统页保护（不许改名/移动/删除），却<b>照常被 RAG 索引</b> ——
 * 而 {@code index} 是自动生成的全站标题目录，几乎能命中任何查询、挤掉真正的检索结果。
 *
 * <p><b>注意这里的不对称是有意的</b>：GUIDE（学习守则）刻意<b>不</b>进本集合。把它塞进来
 * 等于给它装回标题锚点、连带封死用户对它改名，而按 {@code page_type} 定位 GUIDE 的整个
 * 设计前提就是「它是用户可以自由改名的自己的笔记页」。GUIDE 的排除只在 RAG 侧按类型做。
 */
public final class SystemPageTitles {

    /** 仅供展示与测试枚举；判定一律走 {@link #matches}，因为大小写与空白规则在那里。 */
    public static final Set<String> RESERVED = Set.of("index", "log", "Wiki 维护规则");

    private SystemPageTitles() {
    }

    /**
     * 标题是否是系统页保留标题。
     *
     * <p>规则逐字保留自 {@code KnowledgeServiceImpl.isSystemPageTitle} 的原实现：
     * 先 trim；{@code index} / {@code log} 忽略大小写，{@code Wiki 维护规则} 精确匹配。
     * 改动这里会同时改变知识库的改名/移动/删除保护与 RAG 的排除范围。
     */
    public static boolean matches(String title) {
        String trimmed = title == null ? "" : title.trim();
        return "index".equalsIgnoreCase(trimmed)
                || "log".equalsIgnoreCase(trimmed)
                || "Wiki 维护规则".equals(trimmed);
    }
}
