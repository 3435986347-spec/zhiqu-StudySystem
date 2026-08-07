package com.zhiqu.rag;

import com.zhiqu.entity.AiNotebookSource;

import java.util.List;

/**
 * 一次问答的检索范围。
 *
 * <p>取代原先直接传 {@code List<AiNotebookSource>} 的写法 —— 投影表让「范围」不再只有
 * Notebook 资料一种命名空间，把它收进一个有名字的类型里，加第四种时调用方签名不必再改一遍。
 *
 * <p><b>元素顺序是承重的，因此这里是 {@link List} 而不是 {@code Set}，且构造时复制成不可变。</b>
 * 换成 {@code Set} 会让基数不变、成员不变、<b>行为改变</b>，而且现有的
 * {@code ContextBudgeterCharacterizationTest} 看不见 —— 它直接拿固定 list 调
 * {@code select()}，根本不经过调用方。链路是这样的：
 * <ol>
 *   <li>{@code legacyContextRows} 按本列表的顺序逐个建行；</li>
 *   <li>这些行进入 {@code supplements}；</li>
 *   <li>{@code ContextBudgeter.roundRobinExplicit} 用 {@code LinkedHashMap} 按
 *       {@code sourceKey} <b>首次出现的顺序</b>建桶（ContextBudgeter.java:69）；</li>
 *   <li>桶序决定每源配额卡住时，哪几条 explicit 行活下来。</li>
 * </ol>
 * 也就是说改顺序 = 改「上下文里留下哪些资料」，而没有任何异常会提示这件事。
 *
 * <p><b>1B-1 阶段 {@link #notebookSourceCount()} 只数 NOTEBOOK_SOURCE。</b>这是刻意的口径等价：
 * 该值是 {@code ContextBudgeter} 每源配额的触发点，现在放宽到「所有命名空间」会立刻改变
 * 选取结果，而 1B-1 声称自己是纯重构。放宽属于 1B-2。
 */
public record ScopeSelection(Long userId, Long notebookId, List<AiNotebookSource> notebookSources) {

    public ScopeSelection {
        notebookSources = notebookSources == null ? List.of() : List.copyOf(notebookSources);
    }

    /**
     * 保序的资料 id 列表。
     *
     * <p>测试断言应当比对<b>这个列表</b>而不是 {@link #notebookSourceCount()} ——
     * 只比基数的话，「少收一份资料、多收一个 Wiki 单元」这种换而不增的改动照样绿。
     */
    public List<Long> notebookSourceIds() {
        return notebookSources.stream().map(AiNotebookSource::getId).toList();
    }

    /**
     * 喂给 {@code ContextBudgeter.select} 的第三个实参。
     *
     * <p>刻意<b>不</b>叫 {@code size()}：那个名字不说明数的是什么，而这正是口径会悄悄漂移的
     * 入口 —— 调用点写着 {@code sources.size()} 时，没人看得出它数的是「资料」还是「全部单元」。
     */
    public int notebookSourceCount() {
        return notebookSources.size();
    }

    public boolean isEmpty() {
        return notebookSources.isEmpty();
    }
}
