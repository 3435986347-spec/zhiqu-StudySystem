package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("rag_source_index_state")
public class RagSourceIndexState {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long sourceId;
    private Long generationId;
    private String indexVersion;
    private String contentHash;
    private String status;
    private Integer vectorCount;
    private String lastError;
    private LocalDateTime indexedAt;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
