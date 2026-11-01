package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/** 模型网关的一次调用用量。见 V36。 */
@Data
@TableName("harness_usage")
public class HarnessUsage {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private Long modelConfigId;
    private String modelName;
    private Integer promptTokens;
    private Integer completionTokens;
    /** 缓存命中的输入 token 数（V46）；供应商不报为 null */
    private Integer cachedTokens;
    private Integer estimated;
    private String finishReason;
    private LocalDateTime createdAt;
}
