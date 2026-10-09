package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.UserKnowledgeRevision;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.List;

@Mapper
public interface UserKnowledgeRevisionMapper extends BaseMapper<UserKnowledgeRevision> {
    @Select("""
            SELECT * FROM user_knowledge_revision
            WHERE id = #{id} AND user_id = #{userId} AND deleted = 0
            FOR UPDATE
            """)
    UserKnowledgeRevision selectOwnedByIdForUpdate(@Param("userId") Long userId,
                                                   @Param("id") Long id);

    @Select("""
            SELECT * FROM user_knowledge_revision
            WHERE patch_set_id = #{patchSetId} AND user_id = #{userId}
              AND deleted = 0
            ORDER BY id ASC
            FOR UPDATE
            """)
    List<UserKnowledgeRevision> selectByPatchSetForUpdate(@Param("userId") Long userId,
                                                          @Param("patchSetId") Long patchSetId);
}
