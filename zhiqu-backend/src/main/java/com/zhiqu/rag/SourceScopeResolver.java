package com.zhiqu.rag;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiNotebook;
import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.entity.RagIndexableUnit;
import com.zhiqu.mapper.AiNotebookMapper;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import com.zhiqu.service.RuntimeFlagService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class SourceScopeResolver {
    private static final Logger log = LoggerFactory.getLogger(SourceScopeResolver.class);

    private final AiNotebookMapper notebookMapper;
    private final AiNotebookSourceMapper sourceMapper;
    private final RagUnitRegistry registry;
    private final RuntimeFlagService runtimeFlags;
    private final RagMetricsService metrics;

    public SourceScopeResolver(AiNotebookMapper notebookMapper, AiNotebookSourceMapper sourceMapper,
                               RagUnitRegistry registry,
                               RuntimeFlagService runtimeFlags,
                               RagMetricsService metrics) {
        this.notebookMapper = notebookMapper;
        this.sourceMapper = sourceMapper;
        this.registry = registry;
        this.runtimeFlags = runtimeFlags;
        this.metrics = metrics;
    }

    /**
     * Wiki 检索范围：按 {@code updated_at} 倒序取最近 N 页，N 由运行时开关
     * {@code rag.wiki-scope-max} 给出（E-4 现场可不重启收紧）。
     *
     * <p><b>为什么必须有上界：</b>活壳无条件发 {@code includeWiki: true}
     * （{@code assets/zhiqu-api.js:2930} 是硬编码的字面 {@code true}，不是用户开关），
     * 所以翻开 {@code app.rag.enabled} 之后，<b>每一次对话</b>都会把该用户的整个知识库
     * 拉进检索范围。客户端没有下车口，唯一的杠杆是把开关翻回 false —— 那是全局的，
     * 所有人一起停。这条链上其余每一处都留了粒度对齐的出口，这里不该是二值的。
     *
     * <p><b>截断必须留痕。</b>被截掉的页在检索里不存在，而用户什么都看不到 ——
     * 这正是本仓库堵过五次的静默形状。指标记「发生几次 + 见过的最大语料量」，
     * 日志按用户记一行；两者分工的理由见 {@code RagMetricsService.recordWikiScopeTruncated}。
     */
    private List<RagIndexableUnit> wikiScope(Long userId) {
        int limit = runtimeFlags.wikiScopeMax();
        List<RagIndexableUnit> units = registry.readyUnitsOf(RagNamespace.WIKI_PAGE, userId, limit);
        if (units.size() < limit) return units;
        // 取满不一定等于被截：恰好等于 N 时没有溢出。所以这里再数一次，拿到真实总量。
        long total = registry.countReadyUnits(RagNamespace.WIKI_PAGE, userId);
        if (total <= limit) return units;
        metrics.recordWikiScopeTruncated(total);
        log.warn("Wiki 检索范围被截断：userId={} 总单元数={} 上界={}（超出 {}）。"
                        + "调大 rag.wiki-scope-max 可放宽，无需重启",
                userId, total, limit, total - limit);
        return units;
    }

    /**
     * 解析一次问答的检索范围。
     *
     * <p>返回 {@link ScopeSelection} 而不是裸 {@code List}：范围不只有 Notebook 资料一种
     * 命名空间，而「顺序承重」这件事必须写在类型里（见 ScopeSelection 的类注释）。
     *
     * <p><b>Wiki 页在范围里，但有页数上界</b>（见 {@link #wikiScope(Long)}）——
     * Wiki 不按 Notebook 划分，检索侧也没有「只搜这几页」的语义：
     * {@code selectedWikiPageIds} 走的是 {@code wikiContext} 那条<b>直读保底</b>路径
     * （E-3 决定保留：「勾了就一定用」与「匹配到才用」不是同一个产品）。
     *
     * <p><b>{@code selectedSourceIds} 不过滤 Wiki。</b>它是「选中哪几份资料」，
     * 拿它去筛 Wiki 会让「只选了一份资料」这个动作顺带把整个知识库踢出检索范围，
     * 而用户没做过这个选择。两个命名空间的选择语义不同，合用一个参数就会这样悄悄串味。
     */
    public ScopeSelection resolve(Long userId, Long notebookId, List<Long> selectedSourceIds) {
        AiNotebook notebook = notebookMapper.selectOne(new LambdaQueryWrapper<AiNotebook>()
                .eq(AiNotebook::getId, notebookId)
                .eq(AiNotebook::getUserId, userId));
        if (notebook == null) throw new BusinessException("Notebook 不存在或无权限访问");

        LambdaQueryWrapper<AiNotebookSource> query = new LambdaQueryWrapper<AiNotebookSource>()
                .eq(AiNotebookSource::getUserId, userId)
                .eq(AiNotebookSource::getNotebookId, notebookId)
                .eq(AiNotebookSource::getStatus, "READY");
        if (selectedSourceIds != null && !selectedSourceIds.isEmpty()) {
            query.in(AiNotebookSource::getId, selectedSourceIds);
        }
        List<AiNotebookSource> sources = sourceMapper.selectList(query
                .orderByDesc(AiNotebookSource::getUpdatedAt)
                .orderByDesc(AiNotebookSource::getId));
        if (selectedSourceIds != null && !selectedSourceIds.isEmpty()
                && sources.stream().map(AiNotebookSource::getId).distinct().count()
                != selectedSourceIds.stream().distinct().count()) {
            throw new BusinessException("选择的资料不存在、不可用或无权限访问");
        }
        return new ScopeSelection(userId, notebookId, sources, wikiScope(userId));
    }
}
