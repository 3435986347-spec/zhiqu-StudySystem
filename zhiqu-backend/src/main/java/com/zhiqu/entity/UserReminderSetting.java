package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("user_reminder_setting")
public class UserReminderSetting {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String channel;
    private String webhookUrl;
    private String qqAppId;
    private String qqAppSecret;
    private String qqGroupOpenid;
    private Integer qqSandbox;
    private String pushplusToken;
    private Integer enabled;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
