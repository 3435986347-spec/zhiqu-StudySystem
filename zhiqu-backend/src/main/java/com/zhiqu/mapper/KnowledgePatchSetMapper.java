package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.KnowledgePatchSet;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface KnowledgePatchSetMapper extends BaseMapper<KnowledgePatchSet> {
    @Select("""
            SELECT * FROM knowledge_patch_set
            WHERE id = #{id} AND user_id = #{userId} AND deleted = 0
            FOR UPDATE
            """)
    KnowledgePatchSet selectOwnedByIdForUpdate(@Param("userId") Long userId,
                                               @Param("id") Long id);
}
