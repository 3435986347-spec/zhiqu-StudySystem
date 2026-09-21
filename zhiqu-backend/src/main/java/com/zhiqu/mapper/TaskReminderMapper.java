package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.TaskReminder;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface TaskReminderMapper extends BaseMapper<TaskReminder> {
    @Update("""
            UPDATE task_reminder
            SET status = 'PROCESSING',
                updated_at = NOW()
            WHERE id = #{id}
              AND status = 'PENDING'
              AND deleted = 0
            """)
    int claimPending(@Param("id") Long id);
}
