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
 * 任何行为：当时的 {@code notebookSourceCount()} 与 {@link #notebookSourceIds()} 语义一个字不变，
 * 全部现有构造点传空列表。<b>那一步的预期是全量测试全绿</b>，而这个预期是事先声明的 ——
 * 否则「结构加宽而行为不变」和「改了结构却什么都没验」长得一样。
 * 它同时有诊断价值：加宽后若有东西红了，说明有调用点依赖了 record 的组件个数或顺序
 * （比如某处用了规范构造器的位置参数），那是在动行为之前就该发现的事。
 *
 * <p><b>口径放宽已在 1B-2 step 4 完成</b>：{@link #scopedUnitCount()} 现在数的是范围里的
 * 全部单元（跨命名空间）。1B-1 时它叫 {@code notebookSourceCount()} 且只数 NOTEBOOK_SOURCE，
 * 那是刻意的口径等价 —— 该值是 {@code ContextBudgeter} 每源配额的触发点，
 * 放宽会立刻改变选取结果，而 1B-1 声称自己是纯重构。
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
     * <p>测试断言应当比对<b>这个列表</b>而不是 {@link #scopedUnitCount()} ——
     * 只比基数的话，「少收一份资料、多收一个 Wiki 单元」这种换而不增的改动照样绿。
     * step 4 放宽之后这条更要紧了：那个计数现在<b>本来就</b>把两个命名空间加在一起，
     * 拿它当断言等于主动放弃区分能力。
     */
    public List<Long> notebookSourceIds() {
        return notebookSources.stream().map(AiNotebookSource::getId).toList();
    }

    /**
     * 喂给 {@code ContextBudgeter.select} 的第三个实参：<b>范围里的单元总数，跨命名空间</b>
     * （Notebook 资料 + 投影单元）。
     *
     * <p>刻意<b>不</b>叫 {@code size()}：那个名字不说明数的是什么，而这正是口径会悄悄漂移的
     * 入口 —— 调用点写着 {@code sources.size()} 时，没人看得出它数的是「资料」还是「全部单元」。
     * 1B-2 step 4 之前它叫 {@code notebookSourceCount()} 且只数 NOTEBOOK_SOURCE，
     * 那个名字当时也是准确的；<b>放宽口径时连名字一起换</b>，就不会留下一个名字说 A、行为是 B 的方法。
     *
     * <h3>数的是<b>单元个数</b>，不是命名空间个数</h3>
     *
     * <p>两者今天行为完全相同 —— 这个值只进 {@code ContextBudgeter} 的一处
     * {@code effectiveSourceCount > 1} 比较（ContextBudgeter.java:47），
     * 而 1 和 2 与 301 和 2 在 {@code > 1} 上没有差别。
     * 选「单元个数」是因为<b>它才是这个量的定义</b>：每源配额限的是「一个来源吃掉多少预算」，
     * 而来源就是单元 —— 两份 Notebook 资料是两个来源，不是一个。
     *
     * <p><b>目前只用于 {@code > 1}。改用途前先回来看这条。</b>
     * 一旦有人把它用在别处（比如按它分预算、除它算均摊），
     * 「单元个数」与「命名空间个数」会立刻分道扬镳：一个用户几百页 Wiki 时前者是 301、后者是 2。
     * 那时选错的表现是预算分配失衡，不是异常。
     */
    public int scopedUnitCount() {
        return notebookSources.size() + projectedUnits.size();
    }

    /**
     * 范围里<b>一个单元都没有</b>。
     *
     * <p>刻意在加宽这一步就把 {@code projectedUnits} 算进来，尽管今天它恒为空 ——
     * 所以这仍是行为不变的纯增量。留成「只看资料」的话，Wiki 单元接进来的那天
     * 「范围非空却报告 isEmpty」会成立，而这个名字读起来完全无辜。
     * 口径漂移正是从一个名字不说明它数什么的方法开始的
     * （对照 {@link #scopedUnitCount()} 刻意不叫 {@code size()}）。
     */
    public boolean isEmpty() {
        return notebookSources.isEmpty() && projectedUnits.isEmpty();
    }
}
