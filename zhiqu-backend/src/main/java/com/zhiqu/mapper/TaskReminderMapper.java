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

    /*
     * 认领了却一直没有结果的提醒（进程在发送途中被杀、重启）。两条都只用数据库自己的 NOW() ——
     * 和 claimPending 写 updated_at 用的是同一个时钟，不会因为 JVM 与数据库时区不同而误判。
     * 先执行 failStaleRequeued、再执行 requeueStale：反过来的话，重排过一次、又中断了的那些会被第二条
     * 再放回队列 —— 永远不放弃，每小时重发一遍。顺序就是「重试一次」的全部实现，requeueStale 里不再另判标记。
     */

    /** 已经因中断重新排过一次队、又中断了：不再重试，标失败并写明原因。 */
    @Update("""
            UPDATE task_reminder
            SET status = 'FAILED',
                failure_reason = #{reason},
                updated_at = NOW()
            WHERE status = 'PROCESSING'
              AND deleted = 0
              AND failure_reason = #{marker}
              AND updated_at < NOW() - INTERVAL #{minutes} MINUTE
            """)
    int failStaleRequeued(@Param("minutes") int minutes, @Param("marker") String marker, @Param("reason") String reason);

    /** 第一次中断：放回 PENDING 再发一次，用 failure_reason 记下「重新排过队」。重排过的已被上一条判死，这里剩下的都是第一次。 */
    @Update("""
            UPDATE task_reminder
            SET status = 'PENDING',
                failure_reason = #{marker},
                updated_at = NOW()
            WHERE status = 'PROCESSING'
              AND deleted = 0
              AND updated_at < NOW() - INTERVAL #{minutes} MINUTE
            """)
    int requeueStale(@Param("minutes") int minutes, @Param("marker") String marker);
}
