package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/** 命令行设备码登录的一次授权。见 V36 与 {@code service.harness.DeviceLoginService}。 */
@Data
@TableName("harness_device_grant")
public class HarnessDeviceGrant {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String deviceCodeHash;
    private String userCode;
    private String clientName;
    private String clientIp;
    private String status;
    private Long userId;
    private Long tokenId;
    private LocalDateTime expiresAt;
    private LocalDateTime createdAt;
}
