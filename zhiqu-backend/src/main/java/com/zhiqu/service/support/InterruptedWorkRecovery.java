package com.zhiqu.service.support;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
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
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.util.List;
import java.util.concurrent.CompletableFuture;

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
 * 还没轮到的任务改成 SKIPPED。
 *
 * <p><b>看心跳，不看「是不是这个进程启动之前建的」</b>（第二十八轮）。原来只动启动之前建的行 —— 单实例时没错，可用户的部署是
 * 桌面应用和网页端连同一个远程 MySQL：桌面应用一启动，服务器上正在生成的回答就被收成「服务在回答途中重启了」。
 * 现在进行中的回答和执行记录每 30 秒碰一下 {@code heartbeat_at}（{@link StreamLiveness}，数据库的钟），这里只收心跳停了
 * {@link #STALE_MINUTES} 分钟以上的 —— 不管是哪个进程的；步骤和任务跟着它们的执行记录走。旧行没有心跳，按建立时间算。
 * 启动时一趟，之后每 2 分钟一趟（进程没了、没有重启的那台的遗留，也由别的实例收）。
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

    /** 心跳停了多久算「没人在做了」。心跳 30 秒一次，留六次的余量（GC 停顿、库慢一下）。 */
    static final int STALE_MINUTES = 3;
    /**
     * 「心跳停了」：每个时间跟写它的那个钟比。心跳是数据库的 {@code NOW()} 写的，就跟 {@code NOW()} 比（不同机器的钟对不齐）；
     * 没有心跳的旧行只有 {@code created_at}，那是后端 JVM 按业务时区写的，就跟 JVM 算的截止时刻比（{0}）。
     * 第一版两样都跟 {@code NOW()} 比，测试里当场红了：数据库会话时区只在 {@code main} 里钉成业务时区（ProcessTimeZone），
     * 不是每条路都钉 —— 差 8 小时的时候，5 分钟前建的行在数据库眼里还在 8 小时以后。
     */
    static final String STALE = "((heartbeat_at IS NOT NULL AND heartbeat_at < NOW() - INTERVAL " + STALE_MINUTES + " MINUTE)"
            + " OR (heartbeat_at IS NULL AND created_at < {0}))";

    public InterruptedWorkRecovery(AiMessageMapper messages, AiAgentRunMapper runs, AiAgentStepMapper steps, AiAgentTaskMapper tasks) {
        this.messages = messages;
        this.runs = runs;
        this.steps = steps;
        this.tasks = tasks;
    }

    /** 每 2 分钟一趟：别的进程没了、又不再启动的那一份遗留，由还活着的实例收。 */
    @Scheduled(initialDelay = 120_000, fixedDelay = 120_000)
    public void sweep() {
        try {
            recover();
        } catch (RuntimeException e) {
            log.warn("收拾心跳停了的回答 / 执行记录失败了（下一趟再收）：{}", e.getMessage());
        }
    }

    private volatile CompletableFuture<int[]> lastRun = CompletableFuture.completedFuture(new int[4]);

    /**
     * 在后台收，不挡启动。这几条 UPDATE 在大库上要整表扫（状态列没有索引；实测 60 万行的 ai_agent_step 一条约 1 秒），
     * 同步跑会把服务就绪（桌面应用的端口文件、窗口）拖住几秒；更糟的是一条 UPDATE 出错（锁等待超时）整个服务就起不来。
     * 只动心跳停了的行，和正在进行的回答（不管是哪个进程的）互不相干，所以放到后台是安全的；出错只记日志，下一趟再收。
     */
    @Override
    public void run(ApplicationArguments args) {
        lastRun = CompletableFuture.supplyAsync(this::recover, task -> {
            Thread t = new Thread(task, "interrupted-work-recovery");
            t.setDaemon(true);
            t.start();
        }).exceptionally(e -> {
            log.warn("收拾上一个进程没做完的事失败了（下次启动再收）：{}", e.getMessage());
            return null;
        });
    }

    /** 启动时那一趟（测试等它）。之后每 2 分钟一趟由 {@link #sweep()} 跑。 */
    CompletableFuture<int[]> lastRun() {
        return lastRun;
    }

    /** 收拾一遍，返回各改了几行：[回答, 执行记录, 步骤, 任务]。只动心跳停了的（见类注释）。 */
    public int[] recover() {
        LocalDateTime now = LocalDateTime.now();
        LocalDateTime cutoff = now.minusMinutes(STALE_MINUTES);
        int answers = messages.update(null, new LambdaUpdateWrapper<AiMessage>()
                .set(AiMessage::getStatus, "ERROR")
                .set(AiMessage::getErrorMessage, ANSWER_REASON)
                .set(AiMessage::getCompletedAt, now)
                .eq(AiMessage::getStatus, "STREAMING")
                .apply(STALE, cutoff)
                .isNotNull(AiMessage::getContent)
                .ne(AiMessage::getContent, ""));
        answers += messages.update(null, new LambdaUpdateWrapper<AiMessage>()
                .set(AiMessage::getStatus, "ERROR")
                .set(AiMessage::getErrorMessage, ANSWER_REASON_EMPTY)
                .set(AiMessage::getCompletedAt, now)
                .eq(AiMessage::getStatus, "STREAMING")
                .apply(STALE, cutoff));
        // 执行记录：先找出心跳停了的那几条，再连同它们下面的步骤、任务一起收 —— 步骤和任务没有自己的心跳，跟着执行记录走
        List<Long> staleRuns = runs.selectList(new LambdaQueryWrapper<AiAgentRun>()
                        .select(AiAgentRun::getId)
                        .eq(AiAgentRun::getStatus, "RUNNING")
                        .apply(STALE, cutoff))
                .stream().map(AiAgentRun::getId).toList();
        int runRows = 0, stepRows = 0, running = 0, waiting = 0;
        if (!staleRuns.isEmpty()) {
            runRows = runs.update(null, new LambdaUpdateWrapper<AiAgentRun>()
                    .set(AiAgentRun::getStatus, "ERROR")
                    .set(AiAgentRun::getErrorMessage, RUN_REASON)
                    .set(AiAgentRun::getCompletedAt, now)
                    .eq(AiAgentRun::getStatus, "RUNNING")
                    .in(AiAgentRun::getId, staleRuns));
            stepRows = steps.update(null, new LambdaUpdateWrapper<AiAgentStep>()
                    .set(AiAgentStep::getStatus, "ERROR")
                    .set(AiAgentStep::getErrorMessage, RUN_REASON)
                    .set(AiAgentStep::getCompletedAt, now)
                    .eq(AiAgentStep::getStatus, "RUNNING")
                    .in(AiAgentStep::getRunId, staleRuns));
            running = tasks.update(null, new LambdaUpdateWrapper<AiAgentTask>()
                    .set(AiAgentTask::getStatus, "ERROR")
                    .set(AiAgentTask::getErrorMessage, RUN_REASON)
                    .set(AiAgentTask::getCompletedAt, now)
                    .set(AiAgentTask::getUpdatedAt, now)
                    .eq(AiAgentTask::getStatus, "RUNNING")
                    .in(AiAgentTask::getRunId, staleRuns));
            waiting = tasks.update(null, new LambdaUpdateWrapper<AiAgentTask>()
                    .set(AiAgentTask::getStatus, "SKIPPED")
                    .set(AiAgentTask::getErrorMessage, RUN_REASON)
                    .set(AiAgentTask::getUpdatedAt, now)
                    .in(AiAgentTask::getStatus, List.of("PENDING", "READY"))
                    .in(AiAgentTask::getRunId, staleRuns));
        }
        if (answers + runRows + stepRows + running + waiting > 0) {
            log.warn("上一个进程没做完的事已收成失败：回答 {} 条、执行记录 {} 条、步骤 {} 条、任务 {} 条（另有 {} 条没轮到的标成跳过）",
                    answers, runRows, stepRows, running, waiting);
        }
        return new int[]{answers, runRows, stepRows, running + waiting};
    }
}
