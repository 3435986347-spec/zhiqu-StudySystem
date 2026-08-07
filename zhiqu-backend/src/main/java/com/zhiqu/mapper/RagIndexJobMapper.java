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

    /**
     * 领取到期作业。
     *
     * <p>{@code protocolVersion} 是前置条件而非事后过滤：本查询带 FOR UPDATE SKIP LOCKED，
     * 若先领后筛会把不属于本 worker 的行也锁住。
     *
     * <p>{@code rebuildOnly=true} 对应 cutover 的 REBUILD_ONLY 模式：只放行代次重建相关操作。
     * 允许的操作是一组固定常量，不需要动态 IN。
     *
     * <p><b>它不是通用的限流开关。</b>{@code UPSERT_SOURCE} 这个 operation 被两条路共用——
     * 业务侧的 {@code enqueueSource} 与 rebuild 展开——SQL 层面区分不了，所以本模式会领走
     * 一条在冻结之前入队的业务 UPSERT_SOURCE。在 cutover runbook 里这是安全的：第 2 步已排空、
     * 第 3 步已停流量，到第 7 步不可能还有业务作业。**安全性来自流程，不来自这个过滤器**，
     * 因此不要在故障时拿它当节流阀用，那会得到与预期不符的行为。
     */
    @Select("SELECT * FROM rag_index_job " +
            "WHERE protocol_version = #{protocolVersion} " +
            "AND (#{rebuildOnly} = false OR operation IN ('REBUILD_GENERATION','UPSERT_SOURCE','DELETE_GENERATION')) " +
            "AND ((status IN ('PENDING','RETRY') AND (next_retry_at IS NULL OR next_retry_at <= #{dueBefore})) " +
            "  OR (status='RUNNING' AND locked_at < #{staleBefore})) " +
            "ORDER BY id LIMIT #{limit} FOR UPDATE SKIP LOCKED")
    List<RagIndexJob> lockDueJobs(@Param("limit") int limit,
                                  @Param("dueBefore") LocalDateTime dueBefore,
                                  @Param("staleBefore") LocalDateTime staleBefore,
                                  @Param("protocolVersion") int protocolVersion,
                                  @Param("rebuildOnly") boolean rebuildOnly);

    @Update("UPDATE rag_index_job SET locked_at=#{lockedAt} " +
            "WHERE id=#{id} AND status='RUNNING' AND locked_by=#{lockedBy} AND lease_version=#{leaseVersion}")
    int renewLease(@Param("id") Long id,
                   @Param("lockedBy") String lockedBy,
                   @Param("leaseVersion") Long leaseVersion,
                   @Param("lockedAt") LocalDateTime lockedAt);

    /**
     * 终态必须释放 {@code dedupe_key}（置 NULL，见 V30）。
     *
     * <p>不释放的话，唯一键会让「同一目标一辈子只能入队一次」：用户第二次编辑同一页时
     * {@code enqueue} 撞键，而那里刻意把 {@code DuplicateKeyException} 当幂等成功吞掉，
     * 于是第二次编辑<b>永不入索引</b>——没有报错，只有一行 debug 日志。
     */
    @Update("UPDATE rag_index_job SET status='COMPLETED', completed_at=#{completedAt}, " +
            "locked_at=NULL, locked_by=NULL, last_error=NULL, next_retry_at=NULL, dedupe_key=NULL " +
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
            "locked_at=NULL, locked_by=NULL, last_error=#{reason}, next_retry_at=NULL, dedupe_key=NULL " +
            "WHERE id=#{id} AND status='RUNNING' AND locked_by=#{lockedBy} AND lease_version=#{leaseVersion}")
    int supersedeLease(@Param("id") Long id,
                       @Param("lockedBy") String lockedBy,
                       @Param("leaseVersion") Long leaseVersion,
                       @Param("completedAt") LocalDateTime completedAt,
                       @Param("reason") String reason);

    /**
     * 失败转 RETRY 或 DEAD。<b>只有 DEAD 是终态，因此只在 DEAD 时释放 {@code dedupe_key}。</b>
     * RETRY 的行还要继续排队，此时释放键会让同一目标被重复入队、并发跑两遍。
     */
    @Update("UPDATE rag_index_job SET status=#{status}, last_error=#{lastError}, " +
            "next_retry_at=#{nextRetryAt}, locked_at=NULL, locked_by=NULL, " +
            "dedupe_key = IF(#{status} = 'DEAD', NULL, dedupe_key) " +
            "WHERE id=#{id} AND status='RUNNING' AND locked_by=#{lockedBy} AND lease_version=#{leaseVersion}")
    int failLease(@Param("id") Long id,
                  @Param("lockedBy") String lockedBy,
                  @Param("leaseVersion") Long leaseVersion,
                  @Param("status") String status,
                  @Param("lastError") String lastError,
                  @Param("nextRetryAt") LocalDateTime nextRetryAt);
}
