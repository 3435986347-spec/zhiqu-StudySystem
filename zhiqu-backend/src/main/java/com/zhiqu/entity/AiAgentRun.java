package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("ai_agent_run")
public class AiAgentRun {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private Long userMessageId;
    private Long assistantMessageId;
    private Long notebookId;
    private String status;
    private String agentMode;

    /** run 开始时的 {@code sys_user.memory_epoch} 快照；记忆草稿确认时与用户活值比对。 */
    private Long memoryEpoch;
    private String contextOptionsJson;

    /**
     * 本轮的执行形态。<b>已接线</b>：beginRun 先写 SERIAL 占位（那时图还没建），
     * 建完图由 {@code AiWorkspaceService.markExecutionMode} 按真实形态订正。
     */
    private String executionMode;

    /**
     * <b>未接线。</b>本意是「一轮最多几个步骤」。今天步骤数由图决定，图由意图判定决定，
     * 没有哪条路径会无限生成步骤 —— 所以它是一个没有对应风险的护栏。
     * 要接的话得先说清它拦的是什么；在那之前，别从这个字段推断系统在限制步骤数。
     */
    private Integer maxSteps;

    /**
     * 同一并发组里最多几路同时跑。<b>已接线</b>：{@code AgentStageExecutor.execute} 拿它做线程池上限，
     * ≤1 时退化为顺序执行。
     */
    private Integer maxParallelTasks;

    /**
     * <b>未接线，而且它重复了一个硬编码值。</b>模型请求里的 {@code max_tokens} 在
     * {@code AiServiceImpl} 里四处写死为 4096，与本列无关。
     * 要接的话应当是「本列为准、硬编码退位」，而不是两个值并存 ——
     * 并存的结果必然是有人改了一个、以为两个都改了。
     */
    private Integer maxTokens;

    /**
     * <b>未接线，而且按字面接会造成回退。</b>本意是整轮的超时上限（默认 120 秒）。
     *
     * <p>两个理由：其一，每次模型调用<b>已经有 HTTP 层超时</b>
     * （{@code AiServiceImpl} 里 connectTimeout 10s / readTimeout 60s 与 25s），挂死风险已被兜住；
     * 其二，一轮对话可能串起 wiki 工具循环、流式回答、记忆抽取、计划提取、摘要、检索改写 ——
     * 合计轻易超过 120 秒。按这个值砍掉的会是<b>合法的慢轮次</b>，比没有护栏更糟。
     *
     * <p>要接的话，先定一个基于真实耗时分布的值，并想清楚超时之后 SSE 流怎么收口
     * （中途切断的流对前端是什么状态）。在那之前别从这个字段推断存在整轮超时。
     */
    private Integer timeoutSeconds;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    private LocalDateTime completedAt;
    private String errorMessage;
}
