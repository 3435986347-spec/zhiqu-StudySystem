package com.zhiqu.rag;

import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.entity.RagIndexableUnit;

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
 * <p><b>{@code projectedUnits} 加宽是纯增量（1B-2 / 1c 检索侧）。</b>加它的那一步刻意不改
 * 任何行为：{@link #notebookSourceCount()} 与 {@link #notebookSourceIds()} 语义一个字不变，
 * 全部现有构造点传空列表。<b>那一步的预期是全量测试全绿</b>，而这个预期是事先声明的 ——
 * 否则「结构加宽而行为不变」和「改了结构却什么都没验」长得一样。
 * 它同时有诊断价值：加宽后若有东西红了，说明有调用点依赖了 record 的组件个数或顺序
 * （比如某处用了规范构造器的位置参数），那是在动行为之前就该发现的事。
 *
 * <p><b>1B-1 阶段 {@link #notebookSourceCount()} 只数 NOTEBOOK_SOURCE。</b>这是刻意的口径等价：
 * 该值是 {@code ContextBudgeter} 每源配额的触发点，现在放宽到「所有命名空间」会立刻改变
 * 选取结果，而 1B-1 声称自己是纯重构。放宽属于 1B-2。
 */
public record ScopeSelection(Long userId, Long notebookId,
                             List<AiNotebookSource> notebookSources,
                             List<RagIndexableUnit> projectedUnits) {

    /**
     * 范围里<b>非 NOTEBOOK_SOURCE</b> 命名空间的投影单元（今天是 WIKI_PAGE，Phase 3 加会话轮次）。
     *
     * <p><b>为什么单独一个组件，而不是把资料也换成投影行：</b>候选回填仍然需要
     * {@code AiNotebookSource} 实体去取父块正文（{@code ai_source_chunk.content} 是明文，
     * 直接读），而 Wiki 正文加密、不落库，要经 {@code UnitContentResolver} 现取现解密。
     * 两种回填路径不同，合并成一个列表只会把差别推进 if 里。合并是另一步的事。
     *
     * <p><b>紧接着的不变量：{@code projectedUnits} 里不得出现 NOTEBOOK_SOURCE。</b>
     * 出现了就会被数两遍 —— 而「配额分母虚高」不会抛异常，只表现为选出来的行变少。
     * 在紧凑构造器里当场拒绝，不靠调用方自律。
     */
    public ScopeSelection {
        notebookSources = notebookSources == null ? List.of() : List.copyOf(notebookSources);
        projectedUnits = projectedUnits == null ? List.of() : List.copyOf(projectedUnits);
        for (RagIndexableUnit unit : projectedUnits) {
            if (RagNamespace.NOTEBOOK_SOURCE.equals(unit.getNamespace())) {
                throw new IllegalArgumentException("NOTEBOOK_SOURCE 单元属于 notebookSources，"
                        + "放进 projectedUnits 会被数两遍：unit=" + unit.getId());
            }
        }
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

    /**
     * 范围里<b>一个单元都没有</b>。
     *
     * <p>刻意在加宽这一步就把 {@code projectedUnits} 算进来，尽管今天它恒为空 ——
     * 所以这仍是行为不变的纯增量。留成「只看资料」的话，Wiki 单元接进来的那天
     * 「范围非空却报告 isEmpty」会成立，而这个名字读起来完全无辜。
     * 口径漂移正是从一个名字不说明它数什么的方法开始的
     * （对照 {@link #notebookSourceCount()} 刻意不叫 {@code size()}）。
     */
    public boolean isEmpty() {
        return notebookSources.isEmpty() && projectedUnits.isEmpty();
    }
}
