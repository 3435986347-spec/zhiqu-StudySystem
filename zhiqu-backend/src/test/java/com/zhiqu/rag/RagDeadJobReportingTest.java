package com.zhiqu.rag;

import com.zhiqu.entity.RagIndexJob;
import com.zhiqu.entity.RuntimeIssue;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import com.zhiqu.mapper.RagIndexGenerationMapper;
import com.zhiqu.mapper.RuntimeIssueMapper;
import com.zhiqu.service.RuntimeFlagService;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 作业判定 DEAD 之后的故障上报：失败要留痕，而且不得中断整批。
 *
 * <h2>这里修的是什么</h2>
 *
 * <p>{@code reportDeadJob} 往 {@code runtime_issue} 写一行，然后
 * {@code catch (Exception ignored) {}} —— 一声不响。吞掉异常本身是对的
 * （不能让上报失败把 worker 打挂），但吞得没有任何痕迹意味着：这条作业的死亡
 * <b>一点记录都不会留</b>。{@code runtime_issue} 表是它唯一的记录，写不进去就什么都没有。
 * 而整个 {@code rag} 包在此之前只有一条 warn 日志，没有别的兜底。
 *
 * <h2>判据钉的是行为，不是日志文本</h2>
 *
 * <p>断言日志内容会把判据钉死在措辞上，改一个字就红。所以这里钉两件可观察的事：
 * 上报炸了不得抛出去；<b>而且不得让同一批里后面的作业不再被处理</b>。
 * 后者才是真正会伤到人的那一面 —— 一条作业上报失败，整批剩下的全部被跳过，
 * 下一轮再领又是同样的结果。
 */
class RagDeadJobReportingTest {

    private static RagIndexJob job(long id) {
        RagIndexJob job = new RagIndexJob();
        job.setId(id);
        job.setOperation("INDEX_UNIT");
        return job;
    }

    /**
     * 同一批两条作业都会死。第一条的上报写入抛异常 —— 第二条仍然必须被处理。
     *
     * <p>扰动：把 {@code reportDeadJob} 的 try/catch 去掉 → 本条红（异常冲出 run()）。
     */
    @Test
    void 上报失败不得中断整批() {
        RagIndexJobService jobService = mock(RagIndexJobService.class);
        RuntimeIssueMapper runtimeIssueMapper = mock(RuntimeIssueMapper.class);
        RuntimeFlagService flags = mock(RuntimeFlagService.class);
        RagClient client = mock(RagClient.class);

        when(flags.workerMode()).thenReturn(RuntimeFlagService.WorkerMode.NORMAL);
        when(client.configured()).thenReturn(true);
        when(jobService.claimDueJobs(anyInt(), anyString(), anyBoolean()))
                .thenReturn(List.of(job(1L), job(2L)));
        // 续租失败 → assertLease 抛 IllegalStateException → 走失败链路
        when(jobService.renewLease(any())).thenReturn(false);
        // 两条都判定为 DEAD
        when(jobService.handleFailure(any(), any(), any(), any())).thenReturn(true);
        // 上报写入每次都炸
        when(runtimeIssueMapper.insert(any(RuntimeIssue.class)))
                .thenThrow(new IllegalStateException("runtime_issue 写入失败"));

        RagIndexWorker worker = new RagIndexWorker(new RagProperties(), jobService, client,
                mock(RagIndexGenerationMapper.class), mock(AiNotebookSourceMapper.class),
                runtimeIssueMapper, flags, mock(RagUnitRegistry.class));

        assertDoesNotThrow(worker::run,
                "上报路径是便利路径，它炸了不得把 worker 的这一轮打挂");

        verify(jobService, times(2)).handleFailure(any(), any(), any(), any());
        verify(runtimeIssueMapper, times(2)).insert(any(RuntimeIssue.class));
    }

    /**
     * 反例：作业没死就不该上报。
     *
     * <p>没有这条，把 {@code reportDeadJob} 改成无条件调用也能让上面那条绿，
     * 而每一次可重试的失败都会往 {@code runtime_issue} 里塞一行噪声，
     * 把真正需要人看的 DEAD 淹掉。
     */
    @Test
    void 未判定DEAD时不得上报() {
        RagIndexJobService jobService = mock(RagIndexJobService.class);
        RuntimeIssueMapper runtimeIssueMapper = mock(RuntimeIssueMapper.class);
        RuntimeFlagService flags = mock(RuntimeFlagService.class);
        RagClient client = mock(RagClient.class);

        when(flags.workerMode()).thenReturn(RuntimeFlagService.WorkerMode.NORMAL);
        when(client.configured()).thenReturn(true);
        when(jobService.claimDueJobs(anyInt(), anyString(), anyBoolean())).thenReturn(List.of(job(1L)));
        when(jobService.renewLease(any())).thenReturn(false);
        when(jobService.handleFailure(any(), any(), any(), any())).thenReturn(false);   // 还能重试

        RagIndexWorker worker = new RagIndexWorker(new RagProperties(), jobService, client,
                mock(RagIndexGenerationMapper.class), mock(AiNotebookSourceMapper.class),
                runtimeIssueMapper, flags, mock(RagUnitRegistry.class));

        worker.run();

        verify(jobService, times(1)).handleFailure(any(), any(), any(), any());
        verify(runtimeIssueMapper, org.mockito.Mockito.never()).insert(any(RuntimeIssue.class));
    }

    /** 下界：worker 关停时一条作业都不该领 —— 没有它，上面两条在「worker 根本没跑」时也会绿。 */
    @Test
    void 关停时一条都不领() {
        RagIndexJobService jobService = mock(RagIndexJobService.class);
        RuntimeFlagService flags = mock(RuntimeFlagService.class);
        when(flags.workerMode()).thenReturn(RuntimeFlagService.WorkerMode.OFF);

        RagIndexWorker worker = new RagIndexWorker(new RagProperties(), jobService, mock(RagClient.class),
                mock(RagIndexGenerationMapper.class), mock(AiNotebookSourceMapper.class),
                mock(RuntimeIssueMapper.class), flags, mock(RagUnitRegistry.class));

        worker.run();

        verify(jobService, org.mockito.Mockito.never()).claimDueJobs(anyInt(), anyString(), anyBoolean());
        assertEquals(RuntimeFlagService.WorkerMode.OFF, flags.workerMode());
    }
}
