package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.RagSourceIndexState;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface RagSourceIndexStateMapper extends BaseMapper<RagSourceIndexState> {
    @Select("SELECT * FROM rag_source_index_state " +
            "WHERE source_id = #{sourceId} AND generation_id = #{generationId} FOR UPDATE")
    RagSourceIndexState lockBySourceAndGeneration(@Param("sourceId") Long sourceId,
                                                   @Param("generationId") Long generationId);
}
