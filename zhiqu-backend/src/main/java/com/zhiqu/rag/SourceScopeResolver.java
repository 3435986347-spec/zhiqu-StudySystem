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

    public SourceScopeResolver(AiNotebookMapper notebookMapper, AiNotebookSourceMapper sourceMapper) {
        this.notebookMapper = notebookMapper;
        this.sourceMapper = sourceMapper;
    }

    public List<AiNotebookSource> resolve(Long userId, Long notebookId, List<Long> selectedSourceIds) {
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
        return sources;
    }
}
