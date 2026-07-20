package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.SysUser;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.time.LocalDate;

@Mapper
public interface SysUserMapper extends BaseMapper<SysUser> {
    @Select("""
            SELECT id FROM sys_user
            WHERE id = #{userId} AND deleted = 0
            FOR UPDATE
            """)
    Long lockKnowledgeTreeOwner(@Param("userId") Long userId);

    @Update("""
            UPDATE sys_user
            SET total_study_minutes = COALESCE(total_study_minutes, 0) + #{minutes},
                consecutive_days = CASE
                    WHEN last_study_date IS NULL THEN 1
                    WHEN #{studyDate} = last_study_date THEN GREATEST(COALESCE(consecutive_days, 0), 1)
                    WHEN #{studyDate} = DATE_ADD(last_study_date, INTERVAL 1 DAY) THEN COALESCE(consecutive_days, 0) + 1
                    WHEN #{studyDate} > DATE_ADD(last_study_date, INTERVAL 1 DAY) THEN 1
                    ELSE consecutive_days
                END,
                last_study_date = CASE
                    WHEN last_study_date IS NULL OR #{studyDate} > last_study_date THEN #{studyDate}
                    ELSE last_study_date
                END,
                updated_at = NOW(),
                version = version + 1
            WHERE id = #{userId}
            """)
    int addStudyMinutesAndRefreshStreak(@Param("userId") Long userId,
                                        @Param("minutes") Integer minutes,
                                        @Param("studyDate") LocalDate studyDate);

    @Update("""
            UPDATE sys_user
            SET achievement_points = COALESCE(achievement_points, 0) + #{points},
                updated_at = NOW(),
                version = version + 1
            WHERE id = #{userId}
            """)
    int addAchievementPoints(@Param("userId") Long userId, @Param("points") Integer points);
}
