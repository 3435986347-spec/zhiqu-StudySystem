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
    private Long generationId;
    private Long userId;
    private Long notebookId;
    private Long sourceId;
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
