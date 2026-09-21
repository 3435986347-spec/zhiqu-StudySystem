package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("rag_index_generation")
public class RagIndexGeneration {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String indexVersion;
    private String collectionName;
    private String status;
    private Integer expectedSourceCount;
    private Integer indexedSourceCount;
    private String errorMessage;
    private LocalDateTime completedAt;
    private LocalDateTime activatedAt;
    private LocalDateTime retiredAt;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
