package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.UserKnowledgePage;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.util.List;

@Mapper
public interface UserKnowledgePageMapper extends BaseMapper<UserKnowledgePage> {
    @Select("""
            SELECT * FROM user_knowledge_page
            WHERE id = #{id} AND user_id = #{userId} AND deleted = 0
            FOR UPDATE
            """)
    UserKnowledgePage selectOwnedByIdForUpdate(@Param("userId") Long userId,
                                               @Param("id") Long id);

    @Select("""
            <script>
            SELECT * FROM user_knowledge_page
            WHERE user_id = #{userId} AND deleted = 0
              AND id IN
              <foreach collection="ids" item="id" open="(" separator="," close=")">
                #{id}
              </foreach>
            ORDER BY id ASC
            FOR UPDATE
            </script>
            """)
    List<UserKnowledgePage> selectOwnedByIdsForUpdate(@Param("userId") Long userId,
                                                       @Param("ids") List<Long> ids);

    @Select("""
            SELECT * FROM user_knowledge_page
            WHERE user_id = #{userId} AND parent_id = #{parentId} AND deleted = 0
            ORDER BY id ASC
            FOR UPDATE
            """)
    List<UserKnowledgePage> selectDirectChildrenForUpdate(@Param("userId") Long userId,
                                                           @Param("parentId") Long parentId);

    @Update("""
            UPDATE user_knowledge_page
            SET deleted = 1, version = version + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = #{id} AND user_id = #{userId} AND version = #{version} AND deleted = 0
            """)
    int softDeleteByVersion(@Param("userId") Long userId,
                            @Param("id") Long id,
                            @Param("version") Integer version);

    @Update("""
            UPDATE user_knowledge_page
            SET parent_id = #{parentId}, sort_order = #{sortOrder},
                version = version + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = #{id} AND user_id = #{userId} AND version = #{version} AND deleted = 0
            """)
    int reparentByVersion(@Param("userId") Long userId,
                          @Param("id") Long id,
                          @Param("parentId") Long parentId,
                          @Param("sortOrder") Integer sortOrder,
                          @Param("version") Integer version);
}
