package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("user_ai_config")
public class UserAiConfig {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String apiUrl;
    private String apiKey;
    private String modelName;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
