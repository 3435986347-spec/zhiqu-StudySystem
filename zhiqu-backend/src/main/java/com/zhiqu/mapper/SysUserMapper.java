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

    /**
     * 锁住用户行，串行化长期记忆的读—改—写。
     *
     * <p>{@code user_ai_memory} 每用户一行自由文本，合并条目的动作是「读全文 → 合并 → 整份写回」。
     * 不加锁时两个并发确认会各读到同一份旧全文，后写的覆盖先写的 —— 用户勾了两批条目，
     * 最后只留一批，<b>而且两个请求都返回成功</b>；首次写入则直接撞 user_id 的唯一键。
     *
     * <p>锁的是 sys_user 行而不是 user_ai_memory 行：首次写入时后者还不存在，
     * {@code FOR UPDATE} 锁不住不存在的行，挡不住并发 INSERT。与 {@link #lockKnowledgeTreeOwner}
     * 是同一行，两者会互相串行 —— 可接受，都是低频的用户级写操作。
     */
    @Select("SELECT id FROM sys_user WHERE id = #{userId} AND deleted = 0 FOR UPDATE")
    Long lockMemoryOwner(@Param("userId") Long userId);

    /** 清空记忆时纪元 +1 —— 在途 run 的快照就此过期，它们的记忆草稿不再能确认。 */
    @Update("UPDATE sys_user SET memory_epoch = COALESCE(memory_epoch, 0) + 1 WHERE id = #{userId}")
    int bumpMemoryEpoch(@Param("userId") Long userId);

    @Select("SELECT COALESCE(memory_epoch, 0) FROM sys_user WHERE id = #{userId}")
    Long currentMemoryEpoch(@Param("userId") Long userId);

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
