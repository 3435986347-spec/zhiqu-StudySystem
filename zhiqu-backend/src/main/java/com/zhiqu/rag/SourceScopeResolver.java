package com.zhiqu.rag;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiNotebook;
import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.mapper.AiNotebookMapper;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class SourceScopeResolver {
    private final AiNotebookMapper notebookMapper;
    private final AiNotebookSourceMapper sourceMapper;
    private final RagUnitRegistry registry;

    public SourceScopeResolver(AiNotebookMapper notebookMapper, AiNotebookSourceMapper sourceMapper,
                               RagUnitRegistry registry) {
        this.notebookMapper = notebookMapper;
        this.sourceMapper = sourceMapper;
        this.registry = registry;
    }

    /**
     * 解析一次问答的检索范围。
     *
     * <p>返回 {@link ScopeSelection} 而不是裸 {@code List}：范围不只有 Notebook 资料一种
     * 命名空间，而「顺序承重」这件事必须写在类型里（见 ScopeSelection 的类注释）。
     *
     * <p><b>1B-2 step 3：Wiki 页进入检索范围。</b>取的是该用户<b>全部</b> READY 的
     * {@code WIKI_PAGE} 单元 —— Wiki 不按 Notebook 划分，也没有「选中哪几页」的检索侧语义
     * （{@code selectedWikiPageIds} 今天只喂 {@code wikiContext} 那条关键词补充路径，
     * 语义要到 E-3 才改）。
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
        return new ScopeSelection(userId, notebookId, sources,
                registry.readyUnitsOf(RagNamespace.WIKI_PAGE, userId));
    }
}
