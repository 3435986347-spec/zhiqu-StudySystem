package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.UserAchievement;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Insert;

import java.time.LocalDateTime;

@Mapper
public interface UserAchievementMapper extends BaseMapper<UserAchievement> {
    @Insert("""
            INSERT IGNORE INTO user_achievement(user_id, achievement_id, unlocked_at)
            VALUES(#{userId}, #{achievementId}, #{unlockedAt})
            """)
    int insertIgnore(@Param("userId") Long userId,
                     @Param("achievementId") Long achievementId,
                     @Param("unlockedAt") LocalDateTime unlockedAt);
}
