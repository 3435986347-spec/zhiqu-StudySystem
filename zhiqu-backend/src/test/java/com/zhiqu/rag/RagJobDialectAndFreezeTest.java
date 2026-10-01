package com.zhiqu.rag;

import com.zhiqu.entity.RagIndexJob;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import com.zhiqu.mapper.AiSourceChunkMapper;
import com.zhiqu.mapper.RagIndexGenerationMapper;
import com.zhiqu.mapper.RagIndexJobMapper;
import com.zhiqu.mapper.RagIndexableUnitMapper;
import com.zhiqu.mapper.RagSourceIndexStateMapper;
import com.zhiqu.service.RuntimeFlagService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 双删方言与 producer-frozen 闸门。
 *
 * <p>这两条都是停机切换的地基，而且都属于「坏了不会报错」的类别：
 * dedupe key 少了方言，第二条删除会被 DuplicateKeyException 静默吞掉；
 * producer-frozen 若连代次生命周期一起冻结，runbook 第 8 步的 rebuild 跑不起来、整个切换自锁。
 */
class RagJobDialectAndFreezeTest {

    private RagIndexJobMapper jobMapper;
    private RagProperties properties;
    private RuntimeFlagService runtimeFlags;
    private RagIndexJobService jobService;

    @BeforeEach
    void setUp() {
        jobMapper = mock(RagIndexJobMapper.class);
        properties = new RagProperties();
        runtimeFlags = mock(RuntimeFlagService.class);
        when(runtimeFlags.producerFrozen()).thenReturn(false);
        when(runtimeFlags.workerMode()).thenReturn(RuntimeFlagService.WorkerMode.NORMAL);
        jobService = new RagIndexJobService(
                jobMapper,
                mock(RagIndexGenerationMapper.class),
                mock(RagSourceIndexStateMapper.class),
                mock(RagIndexableUnitMapper.class),
                mock(AiNotebookSourceMapper.class),
                mock(AiSourceChunkMapper.class),
                new RagContentHashService(),
                properties,
                runtimeFlags);
    }

    @Test
    void 双删窗口打开时两条删除的dedupeKey必须不同() {
        properties.setDualDeleteWindow(true);

        jobService.enqueueDeleteSource(1L, 2L, 3L);

        List<RagIndexJob> inserted = captureInserts();
        assertEquals(2, inserted.size(), "双删窗口下必须入队两条，而不是一条");

        Set<String> dialects = inserted.stream()
                .map(RagIndexJob::getDeleteDialect).collect(Collectors.toSet());
        assertEquals(Set.of(RagIndexJobService.DIALECT_LEGACY, RagIndexJobService.DIALECT_UNIT), dialects);

        assertNotEquals(inserted.get(0).getDedupeKey(), inserted.get(1).getDedupeKey(),
                "dedupeKey 相同的话第二条会被 DuplicateKeyException 静默吞掉——"
                        + "而升级期恰好少掉的就是清理旧格式向量的那条");
        inserted.forEach(job -> assertTrue(
                job.getDedupeKey().contains(job.getDeleteDialect()),
                "dedupeKey 必须含方言：" + job.getDedupeKey()));
    }

    @Test
    void 双删窗口关闭时只发LEGACY() {
        properties.setDualDeleteWindow(false);

        jobService.enqueueDeleteNotebook(1L, 2L);

        List<RagIndexJob> inserted = captureInserts();
        assertEquals(1, inserted.size());
        assertEquals(RagIndexJobService.DIALECT_LEGACY, inserted.get(0).getDeleteDialect());
    }

    /**
     * 把协议版本常量钉成字面量 1。
     *
     * <p>这条不是同义反复，而是**变更闸门**：{@code protocol_version} 存在的唯一目的是
     * 「回滚到旧 JAR 时旧 worker 不误领新格式作业」，而它只有在 Phase 1B 把常量改成 2 时才真正生效。
     * 若忘了改，入队写 1、领取查 1，功能全对、队列照跑、没有任何测试红或日志——
     * 直到某次回滚，旧 JAR 领走 unit 格式作业，一路 handleFailure → DEAD → 整代次 FAILED。
     *
     * <p>断言两边都写常量的话，常量改成任何值这条都照样绿，闸门就不存在了。
     */
    @Test
    void 协议版本常量必须被刻意修改() {
        assertEquals(1, RagIndexJobService.SUPPORTED_PROTOCOL_VERSION,
                "改这个常量时请一并确认：① 双删方言的 UNIT 分支已有真实向量可清；"
                        + "② runbook 的「回滚前排空队列」已写明；③ 本断言的期望值同步更新");
    }

    @Test
    void 入队的作业都带当前协议版本() {
        jobService.enqueueDeleteSource(1L, 2L, 3L);

        assertEquals(RagIndexJobService.SUPPORTED_PROTOCOL_VERSION,
                captureInserts().get(0).getProtocolVersion(),
                "入队写入的版本必须与领取查询用的版本一致，否则作业永远领不走");
    }

    @Test
    void producerFrozen拦截业务侧入队() {
        when(runtimeFlags.producerFrozen()).thenReturn(true);

        jobService.enqueueDeleteSource(1L, 2L, 3L);
        jobService.enqueueDeleteNotebook(1L, 2L);

        // 必须带类型：BaseMapper.insert 有重载，裸 any() 的引用是二义的
        verify(jobMapper, never()).insert(any(RagIndexJob.class));
    }

    /**
     * REBUILD_ONLY 模式必须下推到 SQL 而不是先领后筛——领取查询带 FOR UPDATE SKIP LOCKED，
     * 先领后筛会把不属于本 worker 的行也锁住。
     */
    @Test
    void 领取时按协议版本与worker模式过滤() {
        when(runtimeFlags.workerMode()).thenReturn(RuntimeFlagService.WorkerMode.REBUILD_ONLY);
        when(jobMapper.lockDueJobs(org.mockito.ArgumentMatchers.anyInt(), any(), any(),
                org.mockito.ArgumentMatchers.anyInt(), org.mockito.ArgumentMatchers.anyBoolean(),
                org.mockito.ArgumentMatchers.anyBoolean()))
                .thenReturn(List.of());

        jobService.claimDueJobs(4, "worker-1", true);

        ArgumentCaptor<Integer> protocol = ArgumentCaptor.forClass(Integer.class);
        ArgumentCaptor<Boolean> rebuildOnly = ArgumentCaptor.forClass(Boolean.class);
        verify(jobMapper).lockDueJobs(org.mockito.ArgumentMatchers.anyInt(), any(), any(),
                protocol.capture(), rebuildOnly.capture(), org.mockito.ArgumentMatchers.anyBoolean());
        // 这里断言的是「领取用的版本 == 入队用的常量」这条接线，值本身由
        // 协议版本常量必须被刻意修改() 钉住
        assertEquals(RagIndexJobService.SUPPORTED_PROTOCOL_VERSION, protocol.getValue(),
                "领取查询必须用与入队相同的协议版本");
        assertTrue(rebuildOnly.getValue(), "REBUILD_ONLY 必须作为查询条件传下去");
    }

    private List<RagIndexJob> captureInserts() {
        ArgumentCaptor<RagIndexJob> captor = ArgumentCaptor.forClass(RagIndexJob.class);
        verify(jobMapper, org.mockito.Mockito.atLeastOnce()).insert(captor.capture());
        return captor.getAllValues();
    }
}
