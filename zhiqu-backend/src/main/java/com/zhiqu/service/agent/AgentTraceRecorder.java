package com.zhiqu.service.agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.entity.AiAgentArtifact;
import com.zhiqu.entity.AiAgentClaim;
import com.zhiqu.entity.AiAgentEvidence;
import com.zhiqu.entity.AiVerifierFinding;
import com.zhiqu.entity.AiAgentRun;
import com.zhiqu.entity.AiAgentStep;
import com.zhiqu.entity.AiAgentTask;
import com.zhiqu.service.AgentTaskGraphService;
import com.zhiqu.service.AiWorkspaceService;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 执行轨迹的写入者 —— 拆 {@code AiServiceImpl} 的第三刀。
 *
 * <h2>它是什么</h2>
 *
 * <p>用户在 AI 助手右侧看到的那一串方块（「正在检索」「已生成计划草稿」…）就是它写出来的。
 * 每个 agent 开工要 {@code startTask} + {@code startStep}，收工要 {@code finishStep} +
 * {@code completeTask}，不跑要 {@code skipTask}，出错要 {@code errorStep}。
 * 这些调用在 15 个 runner 里出现了 44 次，原来全都散在 5770 行的那个大类里。
 *
 * <h2>它<b>按一轮</b>构造，而不是一个单例</h2>
 *
 * <p>{@code requestId} 与 {@code run} 在一轮里是不变的，所以绑在实例上，调用方不必每次重复传。
 * 原来的写法是 {@code startTask(ctx, s, task)} —— 每个调用点都要把整个 StreamState 递进去，
 * 而这些方法真正用到的只有它的两个字段。
 *
 * <h2>这里有一条不变量，而它坏过</h2>
 *
 * <p><b>开了工就必须收工</b>：每个 {@code startTask} 都要有对应的 complete / skip / error。
 * 漏掉的后果不是报错，是用户看着一个永远停在「进行中」的方块 —— 与装配窗口那次同一个物种
 * （见 CLAUDE.md「宁可启动就炸」那一段）。{@code settleUnrunTasks} 就是兜底：
 * 一轮结束时把还停在 PENDING 的节点统一收成 SKIPPED。
 */
public final class AgentTraceRecorder {

    /** {@link #settleUnrunTasks} 给被扫节点写的公开说明；判据靠它把「被扫掉」与「正常跳过」分开。 */
    public static final String UNRUN_TASK_SUMMARY = "本轮未产出内容";
    /** 失败路径上被收尾的节点。与 {@link #UNRUN_TASK_SUMMARY} 刻意不同：它们不是「没产出」，是没轮到。 */
    public static final String FAILED_RUN_TASK_SUMMARY = "本轮失败，未执行";

    private final ObjectMapper objectMapper;
    private final AiWorkspaceService aiWorkspaceService;
    private final AgentTaskGraphService agentTaskGraphService;
    private final String requestId;
    private final AiAgentRun run;

    public AgentTraceRecorder(ObjectMapper objectMapper,
                              AiWorkspaceService aiWorkspaceService,
                              AgentTaskGraphService agentTaskGraphService,
                              String requestId,
                              AiAgentRun run) {
        this.objectMapper = objectMapper;
        this.aiWorkspaceService = aiWorkspaceService;
        this.agentTaskGraphService = agentTaskGraphService;
        this.requestId = requestId;
        this.run = run;
    }

    /**
     * 收尾：把本轮没有任何 runner 碰过、仍停在 PENDING 的节点标成 SKIPPED。
     *
     * <p>此前没有这一步，于是「造了节点但运行期条件没满足」会在成功结束的 run 里留下永久 PENDING 行 ——
     * 实测可复现：消息命中 {@code needsTaskDraft} 造出 TASK_DRAFTER，而模型没解析出计划，
     * 那一行就一直停在 PENDING，执行轨迹里挂着一个永远转圈的 agent。
     *
     * <p><b>只扫 PENDING，不扫 RUNNING。</b>RUNNING 意味着某个 runner 起了却没收尾，那是真 bug，
     * 应该让判据红出来，而不是在这里悄悄抹成 SKIPPED。
     *
     * <p><b>这张网会吃掉证据，所以扫了什么必须有人看着。</b>被扫成 SKIPPED 的节点，
     * 和一次正当的「本轮无事可做」在库里完全同形 —— TASK_DRAFTER 那个缺陷正是靠 PENDING 才被逮到的，
     * 而它的第一个真实客户其实是最常见的 wiki 读问题（见 {@link WikiCuratorRunner}）。
     * 所以集成判据不只断言「都到了终态」，还逐用例断言<b>被扫掉的节点集合</b>：
     * 见 {@code AiConversationLifecycleIntegrationTest.每轮造出的节点与被扫掉的节点都必须符合预期}。
     */
    public void settleUnrunTasks(AgentRunContext ctx) {
        settleUnrunTasks(ctx, UNRUN_TASK_SUMMARY);
    }

    /**
     * 把还停在 PENDING 的节点收成 SKIPPED。
     *
     * <p><b>两条路径都要收，而且理由不能混。</b>此前只有成功路径收（settleUnrunTasks 写在
     * 最终事务里），出错时只有 {@link #errorRunningTasks} 跑，而它只碰 RUNNING 的节点 ——
     * 于是一个失败的 run 会把所有还没轮到的节点永久留在 PENDING，执行轨迹里挂着一排转圈的 agent。
     * 这正是引入 settleUnrunTasks 时要消灭的症状，只是发生在另一条路径上，
     * 而钉它的判据先断言 run 是 DONE，结构上看不见失败路径。
     *
     * <p>两条路径的公开说明必须<b>不同</b>：「跑了但没产出」与「本轮失败，根本没轮到它」
     * 是两件事，用同一句话会让它们在库里同形 —— 正是判据要分开的那两种。
     */
    public void settleUnrunTasks(AgentRunContext ctx, String publicSummary) {
        for (AiAgentTask task : ctx.tasks()) {
            if (task != null && "PENDING".equals(task.getStatus())) {
                skipTask(ctx, task, publicSummary);
            }
        }
    }

    public void errorStep(AiAgentStep step, Exception error) {
        if (step != null && "RUNNING".equals(step.getStatus())) {
            aiWorkspaceService.errorStep(step, error);
        }
    }

    /**
     * 起一个执行步骤并发出 step.start。
     *
     * <p>此前这一族辅助方法有<b>两份平行实现</b>（{@code startAgentStep} / {@code startAgentStepTx}、
     * {@code completeTask} / {@code completeTaskTx}、{@code completeStep} / {@code completeStepTx}…），
     * 差别只在事件往直发通道还是缓冲队列走 —— 也就是「同一事实两份拷贝」的又一例，
     * 而这一例的分叉后果特别隐蔽：在事务里错用直发那一支，只有回滚时才会暴露成
     * 「前端收到指向不存在数据的事件」。收成一份之后通道由 {@link AgentRunContext#emit}
     * 按当前遍历相位决定，调用方不再有选错的机会。
     */
    public AiAgentStep startStep(AgentRunContext ctx, AiAgentTask task,
                                       String agentType, int order, String publicSummary) {
        AiAgentStep step = aiWorkspaceService.startStep(
                run.getId(), task == null ? null : task.getId(), agentType, order, publicSummary);
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("requestId", requestId);
        event.put("runId", run.getId());
        event.put("agentRunId", run.getId());
        event.put("taskId", task == null ? null : task.getId());
        event.put("stepId", step.getId());
        event.put("agentType", agentType);
        event.put("stepOrder", order);
        event.put("status", step.getStatus());
        event.put("publicSummary", publicSummary);
        ctx.emit("agent.step.start", event);
        return step;
    }

    /** 收尾一个执行步骤并发出 step.done。 */
    public void finishStep(AgentRunContext ctx, AiAgentStep step,
                            String publicSummary, String outputSummary) {
        if (step == null) {
            return;
        }
        aiWorkspaceService.completeStep(step, publicSummary, outputSummary);
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("requestId", requestId);
        event.put("runId", run.getId());
        event.put("agentRunId", run.getId());
        event.put("stepId", step.getId());
        event.put("agentType", step.getAgentType());
        event.put("stepOrder", step.getStepOrder());
        event.put("status", step.getStatus());
        event.put("publicSummary", step.getPublicSummary() == null ? "" : step.getPublicSummary());
        ctx.emit("agent.step.done", event);
    }

    /** 本轮不需要某个步骤：落一条 SKIPPED 记录并当场告诉用户「本轮不需要…」。 */
    public void skipStep(AgentRunContext ctx, String agentType, int order, String publicSummary) {
        aiWorkspaceService.skipStep(run.getId(), agentType, order, publicSummary);
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("requestId", requestId);
        event.put("runId", run.getId());
        event.put("agentRunId", run.getId());
        event.put("agentType", agentType);
        event.put("stepOrder", order);
        event.put("status", "SKIPPED");
        event.put("publicSummary", publicSummary);
        ctx.emit("agent.step.done", event);
    }

    public void startTask(AgentRunContext ctx, AiAgentTask task) {
        if (task == null || "RUNNING".equals(task.getStatus()) || "DONE".equals(task.getStatus())) {
            return;
        }
        agentTaskGraphService.startTask(task);
        ctx.emit("agent.task.start", taskEvent(task));
    }

    public void completeTask(AgentRunContext ctx, AiAgentTask task,
                              Map<String, Object> output, String publicSummary) {
        if (task == null || "DONE".equals(task.getStatus()) || "SKIPPED".equals(task.getStatus())) {
            return;
        }
        agentTaskGraphService.completeTask(task, output, publicSummary);
        ctx.emit("agent.task.done", taskEvent(task));
    }

    public void skipTask(AgentRunContext ctx, AiAgentTask task, String publicSummary) {
        if (task == null || "DONE".equals(task.getStatus()) || "SKIPPED".equals(task.getStatus())) {
            return;
        }
        agentTaskGraphService.skipTask(task, publicSummary);
        ctx.emit("agent.task.done", taskEvent(task));
    }

    public void errorRunningTasks(AgentRunContext ctx, Exception error) {
        for (AiAgentTask task : ctx.tasks()) {
            if (task != null && "RUNNING".equals(task.getStatus())) {
                agentTaskGraphService.errorTask(task, error);
                ctx.emit("agent.task.error", taskEvent(task));
            }
        }
    }

    public Map<String, Object> taskEvent(AiAgentTask task) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("requestId", requestId);
        event.put("runId", run.getId());
        event.put("agentRunId", run.getId());
        event.put("taskId", task.getId());
        event.put("agentType", task.getAgentType());
        event.put("taskType", task.getTaskType());
        event.put("status", task.getStatus());
        event.put("dependsOn", parseJsonList(task.getDependsOnJson()));
        event.put("parallelGroupId", task.getParallelGroupId());
        event.put("publicSummary", task.getPublicSummary() == null ? "" : task.getPublicSummary());
        return event;
    }

    /**
     * 产物事件。{@code summary}（预览长什么样）由<b>调用方</b>给出，不在这里算。
     *
     * <p>轨迹写入者只管「什么时候发生了什么」；一个产物该怎么摘要给用户看，
     * 是展示层的事，而且它依赖一串只有 AiServiceImpl 才有的文本工具。
     * 让它反过来依赖那些，这一刀就白拆了。
     */
    public Map<String, Object> artifactEvent(AiAgentStep step, AiAgentArtifact artifact, Map<String, Object> summary) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("requestId", requestId);
        event.put("runId", run.getId());
        event.put("agentRunId", run.getId());
        event.put("stepId", step == null ? null : step.getId());
        event.put("artifactId", artifact.getId());
        event.put("artifactType", artifact.getArtifactType());
        event.put("title", artifact.getTitle());
        event.put("status", artifact.getStatus());
        event.put("artifact", summary);
        return event;
    }

    public Map<String, Object> evidenceEvent(AiAgentEvidence evidence) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("requestId", requestId);
        event.put("runId", run.getId());
        event.put("agentRunId", run.getId());
        event.put("evidenceId", evidence.getId());
        event.put("taskId", evidence.getTaskId());
        event.put("stepId", evidence.getStepId());
        event.put("sourceType", evidence.getSourceType());
        event.put("sourceId", evidence.getSourceId());
        event.put("artifactId", evidence.getArtifactId());
        event.put("snippet", evidence.getSnippet() == null ? "" : evidence.getSnippet());
        return event;
    }

    public Map<String, Object> claimEvent(AiAgentClaim claim) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("requestId", requestId);
        event.put("runId", run.getId());
        event.put("agentRunId", run.getId());
        event.put("claimId", claim.getId());
        event.put("taskId", claim.getTaskId());
        event.put("stepId", claim.getStepId());
        event.put("claimType", claim.getClaimType());
        event.put("content", claim.getContent());
        event.put("confidence", claim.getConfidence());
        event.put("evidenceIds", parseJsonList(claim.getEvidenceIdsJson()));
        return event;
    }

    public Map<String, Object> findingEvent(AiVerifierFinding finding) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("requestId", requestId);
        event.put("runId", run.getId());
        event.put("agentRunId", run.getId());
        event.put("findingId", finding.getId());
        event.put("taskId", finding.getTaskId());
        event.put("severity", finding.getSeverity());
        event.put("code", finding.getCode());
        event.put("message", finding.getMessage());
        event.put("targetType", finding.getTargetType());
        event.put("targetId", finding.getTargetId());
        event.put("action", finding.getAction());
        return event;
    }

    private List<Object> parseJsonList(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            return objectMapper.readValue(json, List.class);
        } catch (Exception e) {
            return List.of();
        }
    }
}
