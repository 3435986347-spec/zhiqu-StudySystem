package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("login_log")
public class LoginLog {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String ip;
    private String userAgent;
    private LocalDateTime loginAt;
}
