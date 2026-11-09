package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("ai_message")
public class AiMessage {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private Long conversationId;
    private Long agentRunId;
    private String role;
    private String content;
    private String status;
    private String requestId;
    private String providerType;
    private String modelName;
    private String reasoningSummary;
    private String citationsJson;
    private String retrievalStatusJson;
    private String usageJson;
    private String suggestedPlanJson;
    /**
     * 回答里按顺序列出的每一步（第一百二十七轮）。<b>只在 {@link com.zhiqu.mapper.AiMessageMapper#saveSteps} 里写</b>：
     * 实体上默认是 null、查询时不读（select = false）—— 整行 updateById 跳过 null，就不会拿内存里一份旧的盖掉库里的；
     * 历史查询也不用每一条都拉这一大列。
     */
    @TableField(select = false)
    private String stepsJson;
    private String reasoningMode;
    private Boolean webSearchEnabled;
    private LocalDateTime completedAt;
    private String errorMessage;
    /** 回答能用但不完整时的说明（V38）。见 AiServiceImpl.FinalWriterRunner。 */
    private String notice;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableLogic
    private Integer deleted;
}
