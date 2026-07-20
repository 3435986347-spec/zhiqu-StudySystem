package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.RagIndexJob;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.time.LocalDateTime;
import java.util.List;

@Mapper
public interface RagIndexJobMapper extends BaseMapper<RagIndexJob> {
    @Select("SELECT * FROM rag_index_job WHERE id = #{id} FOR UPDATE")
    RagIndexJob lockById(@Param("id") Long id);

    @Select("SELECT * FROM rag_index_job " +
            "WHERE (status IN ('PENDING','RETRY') AND (next_retry_at IS NULL OR next_retry_at <= #{dueBefore})) " +
            "OR (status='RUNNING' AND locked_at < #{staleBefore}) " +
            "ORDER BY id LIMIT #{limit} FOR UPDATE SKIP LOCKED")
    List<RagIndexJob> lockDueJobs(@Param("limit") int limit,
                                  @Param("dueBefore") LocalDateTime dueBefore,
                                  @Param("staleBefore") LocalDateTime staleBefore);

    @Update("UPDATE rag_index_job SET locked_at=#{lockedAt} " +
            "WHERE id=#{id} AND status='RUNNING' AND locked_by=#{lockedBy} AND lease_version=#{leaseVersion}")
    int renewLease(@Param("id") Long id,
                   @Param("lockedBy") String lockedBy,
                   @Param("leaseVersion") Long leaseVersion,
                   @Param("lockedAt") LocalDateTime lockedAt);

    @Update("UPDATE rag_index_job SET status='COMPLETED', completed_at=#{completedAt}, " +
            "locked_at=NULL, locked_by=NULL, last_error=NULL, next_retry_at=NULL " +
            "WHERE id=#{id} AND status='RUNNING' AND locked_by=#{lockedBy} AND lease_version=#{leaseVersion}")
    int completeLease(@Param("id") Long id,
                      @Param("lockedBy") String lockedBy,
                      @Param("leaseVersion") Long leaseVersion,
                      @Param("completedAt") LocalDateTime completedAt);

    /**
     * 陈旧写入被墓碑拒绝（sidecar 409）：置为终态 SUPERSEDED。
     * 它既不算未完成（PENDING/RUNNING/RETRY），也不算 DEAD，因此不会把索引代次拖成 FAILED。
     * 原因写入 last_error 仅供排查，不代表故障。
     */
    @Update("UPDATE rag_index_job SET status='SUPERSEDED', completed_at=#{completedAt}, " +
            "locked_at=NULL, locked_by=NULL, last_error=#{reason}, next_retry_at=NULL " +
            "WHERE id=#{id} AND status='RUNNING' AND locked_by=#{lockedBy} AND lease_version=#{leaseVersion}")
    int supersedeLease(@Param("id") Long id,
                       @Param("lockedBy") String lockedBy,
                       @Param("leaseVersion") Long leaseVersion,
                       @Param("completedAt") LocalDateTime completedAt,
                       @Param("reason") String reason);

    @Update("UPDATE rag_index_job SET status=#{status}, last_error=#{lastError}, " +
            "next_retry_at=#{nextRetryAt}, locked_at=NULL, locked_by=NULL " +
            "WHERE id=#{id} AND status='RUNNING' AND locked_by=#{lockedBy} AND lease_version=#{leaseVersion}")
    int failLease(@Param("id") Long id,
                  @Param("lockedBy") String lockedBy,
                  @Param("leaseVersion") Long leaseVersion,
                  @Param("status") String status,
                  @Param("lastError") String lastError,
                  @Param("nextRetryAt") LocalDateTime nextRetryAt);
}
