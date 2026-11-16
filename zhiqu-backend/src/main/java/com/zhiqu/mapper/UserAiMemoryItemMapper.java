package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.UserAiMemoryItem;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.time.LocalDateTime;
import java.util.List;

@Mapper
public interface UserAiMemoryItemMapper extends BaseMapper<UserAiMemoryItem> {

    /** 还在用的条目，按建的先后。读—改—写一律用加锁读（理由同 {@link UserAiMemoryMapper#selectForUpdate}）。 */
    @Select("SELECT * FROM user_ai_memory_item WHERE user_id = #{userId} AND invalidated_at IS NULL ORDER BY id")
    List<UserAiMemoryItem> selectActive(@Param("userId") Long userId);

    @Select("SELECT * FROM user_ai_memory_item WHERE user_id = #{userId} AND invalidated_at IS NULL ORDER BY id FOR UPDATE")
    List<UserAiMemoryItem> selectActiveForUpdate(@Param("userId") Long userId);

    /** 只动这两列（作废 / 被取代）；只作废还活着的、属于这个人的。 */
    @Update("UPDATE user_ai_memory_item SET invalidated_at = #{at}, superseded_by = #{by}, updated_at = #{at} "
            + "WHERE id = #{id} AND user_id = #{userId} AND invalidated_at IS NULL")
    int invalidate(@Param("userId") Long userId, @Param("id") Long id, @Param("by") Long supersededBy,
                   @Param("at") LocalDateTime at);

    @Update("<script>UPDATE user_ai_memory_item SET last_used_at = #{at} WHERE user_id = #{userId} AND id IN "
            + "<foreach collection='ids' item='i' open='(' separator=',' close=')'>#{i}</foreach></script>")
    int touch(@Param("userId") Long userId, @Param("ids") List<Long> ids, @Param("at") LocalDateTime at);

    /** 清空记忆：连作废的一起删掉（用户要的是「忘掉」，留着历史就没忘）。 */
    @Delete("DELETE FROM user_ai_memory_item WHERE user_id = #{userId}")
    int deleteAllOf(@Param("userId") Long userId);
}
