package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/** 个人访问令牌（只存哈希）。见 V36 与 {@code service.harness.AccessTokenService}。 */
@Data
@TableName("user_access_token")
public class UserAccessToken {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String name;
    private String tokenHash;
    private String tokenHint;
    private String scope;
    private LocalDateTime lastUsedAt;
    private String lastUsedIp;
    private LocalDateTime expiresAt;
    private LocalDateTime revokedAt;
    private LocalDateTime createdAt;
}
