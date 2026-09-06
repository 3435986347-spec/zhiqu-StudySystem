package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("rag_index_job")
public class RagIndexJob {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String dedupeKey;
    private String operation;
    /** 1=旧 source 协议，2=unit 协议。只用于让回滚后的旧 worker 不误领新格式作业。 */
    private Integer protocolVersion;
    private Long generationId;
    private Long userId;
    private Long notebookId;
    private Long sourceId;
    private Long unitId;
    private String namespace;
    /** LEGACY=旧 SOURCE/NOTEBOOK 作用域，UNIT=新 UNIT/SCOPE 作用域。双删的两条都是 v2，靠本列区分。 */
    private String deleteDialect;
    private String scopeKind;
    private Long scopeId;
    private String contentHash;
    private String targetIndexVersion;
    private String status;
    private Integer attempts;
    private LocalDateTime nextRetryAt;
    private LocalDateTime lockedAt;
    private String lockedBy;
    private Long leaseVersion;
    private String lastError;
    private LocalDateTime completedAt;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
