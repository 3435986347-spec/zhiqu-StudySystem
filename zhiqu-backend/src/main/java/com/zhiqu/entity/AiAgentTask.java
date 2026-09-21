package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("ai_agent_task")
public class AiAgentTask {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long runId;
    private Long parentTaskId;
    private String agentType;
    private String taskType;
    private String status;
    private Integer priority;
    private String parallelGroupId;
    /**
     * <b>未接线，而且刻意不接。</b>今天所有任务的 dependsOn 都是 {@code [orchestrator]} ——
     * 星形，没有真实次序信息。而次序的权威是 {@code AgentPosition}（相位 + 次序）。
     *
     * <p>让它成为第二个次序来源，就是这个仓库反复在消灭的「同一事实两个真相」：
     * 两者一旦分叉，谁说了算取决于读代码的人先看到哪一个。
     * 它今天的用途只有一个：发给前端画依赖线。
     */
    private String dependsOnJson;
    private String inputJson;
    private String outputJson;
    private String publicSummary;
    private String errorMessage;
    private LocalDateTime startedAt;
    private LocalDateTime completedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
