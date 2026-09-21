package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 运行时可变开关。主键是业务键（flag_key）而非自增 id，因此用 {@link IdType#INPUT}。
 *
 * <p>不加 createdAt / updatedAt 的自动填充：本表由 {@code ON DUPLICATE KEY UPDATE} 写入，
 * updated_at 交给 DDL 上的 {@code ON UPDATE CURRENT_TIMESTAMP} 维护。
 */
@Data
@TableName("app_runtime_flag")
public class AppRuntimeFlag {
    @TableId(type = IdType.INPUT)
    private String flagKey;
    private String flagValue;
    private String updatedBy;
    private LocalDateTime updatedAt;
}
