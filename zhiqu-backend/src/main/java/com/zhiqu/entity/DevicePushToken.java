package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("device_push_token")
public class DevicePushToken {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String deviceType;
    private String endpointHash;
    private String encryptedToken;
    private String permissionStatus;
    private String userAgent;
    private LocalDateTime lastActiveAt;
    private String encryptionVersion;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
