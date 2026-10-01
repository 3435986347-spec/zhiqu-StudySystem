package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("user_ai_memory")
public class UserAiMemory {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String memoryText;
    private String encryptedMemoryText;
    private String encryptionVersion;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
