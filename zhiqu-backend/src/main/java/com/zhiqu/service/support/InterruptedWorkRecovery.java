package com.zhiqu.service.support;

import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.zhiqu.entity.AiAgentRun;
import com.zhiqu.entity.AiAgentStep;
import com.zhiqu.entity.AiAgentTask;
import com.zhiqu.entity.AiMessage;
import com.zhiqu.mapper.AiAgentRunMapper;
import com.zhiqu.mapper.AiAgentStepMapper;
import com.zhiqu.mapper.AiAgentTaskMapper;
import com.zhiqu.mapper.AiMessageMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.util.List;

/**
 * 上一个进程没做完的事，启动时收干净（第二十二轮）。
 *
 * <p>流式回答、agent 的执行记录都在请求线程里一步一步写库：开始时插一条 STREAMING / RUNNING，结束时改成终态。进程在中间没了
 * （部署、崩溃、{@code kill -9}、桌面应用被关掉），就没人去改 —— 真的 kill -9 实测：重启之后那条回答在库里是 STREAMING、
 * 执行记录 / 步骤 / 任务是 RUNNING，页面上是「正在生成…（已等 18 秒）」，接着「还在等模型开始回答（已等 88 秒）」，一直数下去；
 * 已经收到的那半截也不显示。
 *
 * <p>这些事在内存里执行（请求线程、它派出的线程），新进程里不会有谁接着做 —— 所以启动时一律收成失败：回答改成 ERROR、
 * 已经落库的半截留着、说清楚为什么（页面按第十九轮的规矩把原因显示在半截下面）；执行记录、步骤、正在跑的任务改成 ERROR，
 * 还没轮到的任务改成 SKIPPED。只动<b>这个进程开始之前</b>建的行（{@link #startedAt} 在 bean 创建时记下 —— 那时 Tomcat 还没开始接请求），
 * 所以启动之后新来的回答碰不到。部署是单实例的（见 WikiToolAgent 那条锁的注释）；将来多实例，这里要改成按心跳判断。
 *
 * <p>RAG 的索引任务不在这里：它们有租约，过期了会被别的 worker 捡回去。上传资料的解析在一个事务里，进程没了整行回滚，不会停在 PARSING。
 */
@Component
public class InterruptedWorkRecovery implements ApplicationRunner {
    private static final Logger log = LoggerFactory.getLogger(InterruptedWorkRecovery.class);

    static final String ANSWER_REASON = "服务在回答途中重启了，这条回答没说完（已经收到的部分留着）。可以再问一次。";
    /** 一个字都没落库时不能说「已经收到的部分留着」：正文是节流落库的（1.5 秒且多了 24 个字才写一次），刚开始回答就断的那种什么都没有。 */
    static final String ANSWER_REASON_EMPTY = "服务在回答途中重启了，这条回答没能说出来。可以再问一次。";
    static final String RUN_REASON = "服务在执行途中重启了，这一轮没有做完。";

    private final AiMessageMapper messages;
    private final AiAgentRunMapper runs;
    private final AiAgentStepMapper steps;
    private final AiAgentTaskMapper tasks;
    private final LocalDateTime startedAt;

    public InterruptedWorkRecovery(AiMessageMapper messages, AiAgentRunMapper runs, AiAgentStepMapper steps, AiAgentTaskMapper tasks) {
        this.messages = messages;
        this.runs = runs;
        this.steps = steps;
        this.tasks = tasks;
        this.startedAt = LocalDateTime.now();
    }

    @Override
    public void run(ApplicationArguments args) {
        recover();
    }

    /** 收拾一遍，返回各改了几行：[回答, 执行记录, 步骤, 任务]。 */
    public int[] recover() {
        LocalDateTime now = LocalDateTime.now();
        int answers = messages.update(null, new LambdaUpdateWrapper<AiMessage>()
                .set(AiMessage::getStatus, "ERROR")
                .set(AiMessage::getErrorMessage, ANSWER_REASON)
                .set(AiMessage::getCompletedAt, now)
                .eq(AiMessage::getStatus, "STREAMING")
                .lt(AiMessage::getCreatedAt, startedAt)
                .isNotNull(AiMessage::getContent)
                .ne(AiMessage::getContent, ""));
        answers += messages.update(null, new LambdaUpdateWrapper<AiMessage>()
                .set(AiMessage::getStatus, "ERROR")
                .set(AiMessage::getErrorMessage, ANSWER_REASON_EMPTY)
                .set(AiMessage::getCompletedAt, now)
                .eq(AiMessage::getStatus, "STREAMING")
                .lt(AiMessage::getCreatedAt, startedAt));
        int runRows = runs.update(null, new LambdaUpdateWrapper<AiAgentRun>()
                .set(AiAgentRun::getStatus, "ERROR")
                .set(AiAgentRun::getErrorMessage, RUN_REASON)
                .set(AiAgentRun::getCompletedAt, now)
                .eq(AiAgentRun::getStatus, "RUNNING")
                .lt(AiAgentRun::getCreatedAt, startedAt));
        int stepRows = steps.update(null, new LambdaUpdateWrapper<AiAgentStep>()
                .set(AiAgentStep::getStatus, "ERROR")
                .set(AiAgentStep::getErrorMessage, RUN_REASON)
                .set(AiAgentStep::getCompletedAt, now)
                .eq(AiAgentStep::getStatus, "RUNNING")
                .lt(AiAgentStep::getCreatedAt, startedAt));
        int running = tasks.update(null, new LambdaUpdateWrapper<AiAgentTask>()
                .set(AiAgentTask::getStatus, "ERROR")
                .set(AiAgentTask::getErrorMessage, RUN_REASON)
                .set(AiAgentTask::getCompletedAt, now)
                .set(AiAgentTask::getUpdatedAt, now)
                .eq(AiAgentTask::getStatus, "RUNNING")
                .lt(AiAgentTask::getCreatedAt, startedAt));
        int waiting = tasks.update(null, new LambdaUpdateWrapper<AiAgentTask>()
                .set(AiAgentTask::getStatus, "SKIPPED")
                .set(AiAgentTask::getErrorMessage, RUN_REASON)
                .set(AiAgentTask::getUpdatedAt, now)
                .in(AiAgentTask::getStatus, List.of("PENDING", "READY"))
                .lt(AiAgentTask::getCreatedAt, startedAt));
        if (answers + runRows + stepRows + running + waiting > 0) {
            log.warn("上一个进程没做完的事已收成失败：回答 {} 条、执行记录 {} 条、步骤 {} 条、任务 {} 条（另有 {} 条没轮到的标成跳过）",
                    answers, runRows, stepRows, running, waiting);
        }
        return new int[]{answers, runRows, stepRows, running + waiting};
    }
}
