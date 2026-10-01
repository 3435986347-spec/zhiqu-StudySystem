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
     * 同一并发组里最多几路同时跑。<b>已接线</b>：{@code AgentStageExecutor.execute} 拿它做线程池上限，
     * ≤1 时退化为顺序执行。
     */
    private Integer maxParallelTasks;


    /**
     * 本轮 SSE 连接的截止时间（秒）。<b>是如实上报，不是独立的护栏</b> —— 区别要紧。
     *
     * <p>它与 {@code AiServiceImpl} 里 {@code new SseEmitter(...)} 读同一个常量
     * {@link com.zhiqu.service.AiWorkspaceService#STREAM_TIMEOUT_MS}，所以这个字段说的
     * 就是「这条流最晚什么时候被容器掐断」。此前它写死 120，而 emitter 用的是 300：
     * 字段宣称的和真实发生的差了一倍半，从它推断超时会得到错的结论。
     *
     * <p><b>没有</b>按这个值主动收口整轮的逻辑，也不打算加：一轮对话可能串起 wiki 工具循环、
     * 流式回答、记忆抽取、计划提取、摘要、检索改写，按一个总时长砍掉的会是<b>合法的慢轮次</b>，
     * 比没有护栏更糟。挂死风险由每次模型调用各自的 HTTP 超时兜住
     * （connectTimeout 10s / readTimeout 60s 与 25s）。
     *
     * <p>真要加整轮护栏，先定一个基于真实耗时分布的值，并想清楚被截断的流对前端是什么状态。
     */
    private Integer timeoutSeconds;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    private LocalDateTime completedAt;
    private String errorMessage;
}
