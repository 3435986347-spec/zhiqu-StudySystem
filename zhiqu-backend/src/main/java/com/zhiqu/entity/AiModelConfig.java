package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalDateTime;

@Data
@TableName("ai_model_config")
public class AiModelConfig {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String ownerType;
    private String providerType;
    private String displayName;
    private String apiUrl;
    private String encryptedApiKey;
    private String modelName;
    private String capabilities;
    private String capabilityProbeStatus;
    private String visionStatus;
    private String reasoningStatus;
    private LocalDateTime lastProbeAt;
    private Integer enabled;
    private Integer isDefault;
    private String encryptionVersion;
    /** 上下文窗口（token）。空 = 按保守默认上限；各处怎么用见 ContextBudget。 */
    private Integer contextWindowTokens;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
