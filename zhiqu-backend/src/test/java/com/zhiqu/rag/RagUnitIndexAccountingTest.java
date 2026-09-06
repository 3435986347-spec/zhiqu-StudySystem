package com.zhiqu.rag;

import com.zhiqu.entity.RagIndexGeneration;
import com.zhiqu.entity.RagIndexJob;
import com.zhiqu.entity.RagIndexableUnit;
import com.zhiqu.entity.RagUnitChunk;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import com.zhiqu.mapper.RagIndexGenerationMapper;
import com.zhiqu.mapper.RuntimeIssueMapper;
import com.zhiqu.service.RuntimeFlagService;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * unit 索引路径的<b>记账</b>与<b>代次选择</b>。
 *
 * <p>与 {@code RagUnitIndexBatchTest} 分家：那个文件钉的是「发出去的载荷长什么样」，
 * 这个文件钉的是「发完之后记了什么账、发给了哪几个代次」。
 * 1b 把前一半做完了、后一半整个漏了，而漏掉的表现不在这里 ——
 * 是 cutover runbook 第 9 步 {@code activate} 抛异常：门禁按投影表数分母、
 * 按状态行数分子，分子恒为 0。<b>分子与分母来自两处而只做了一处</b>是这族缺陷的形状。
 */
class RagUnitIndexAccountingTest {

    /** 一次记账调用的四个实参。 */
    private record Accounted(Long jobId, Long unitId, Long generationId, int vectorCount) {}

    private record Fixture(RagIndexWorker worker, List<Map<String, Object>> sent, List<Accounted> accounted) {}

    private Fixture worker(Long jobGenerationId, List<RagIndexGeneration> live, int writtenPerBatch) {
        RagIndexJobService jobService = mock(RagIndexJobService.class);
        RagClient client = mock(RagClient.class);
        RagIndexGenerationMapper generationMapper = mock(RagIndexGenerationMapper.class);
        RuntimeFlagService flags = mock(RuntimeFlagService.class);
        RagUnitRegistry registry = mock(RagUnitRegistry.class);

        RagIndexJob job = new RagIndexJob();
        job.setId(77L);
        job.setOperation("UPSERT_UNIT");
        job.setUserId(1L);
        job.setNamespace(RagNamespace.WIKI_PAGE);
        job.setSourceId(5L);
        job.setGenerationId(jobGenerationId);
        job.setLeaseVersion(1L);
        job.setLockedBy("worker-1");

        RagIndexableUnit unit = new RagIndexableUnit();
        unit.setId(31L);
        unit.setUserId(1L);
        unit.setNamespace(RagNamespace.WIKI_PAGE);
        unit.setCanonicalHash("canonical-hash-abc");

        List<RagUnitChunk> chunks = new ArrayList<>();
        for (int index = 0; index < 12; index++) {   // 12 > PARENT_CHUNKS_PER_BATCH(8) → 每代两批
            RagUnitChunk chunk = new RagUnitChunk();
            chunk.setId(1000L + index);
            chunk.setUnitId(31L);
            chunk.setChunkIndex(index);
            chunk.setCharStart(index * 4);
            chunk.setCharEnd((index + 1) * 4);
            chunks.add(chunk);
        }

        when(client.configured()).thenReturn(true);
        when(jobService.claimDueJobs(anyInt(), anyString(), anyBoolean())).thenReturn(List.of(job));
        when(jobService.renewLease(any())).thenReturn(true);
        when(flags.workerMode()).thenReturn(RuntimeFlagService.WorkerMode.NORMAL);
        when(registry.refreshUnitIfLive(anyString(), any())).thenReturn(true);
        when(registry.loadForIndexing(anyString(), any()))
                .thenReturn(new RagUnitRegistry.IndexableUnitSnapshot(unit, "a".repeat(48), chunks));
        when(generationMapper.selectList(any())).thenReturn(live);
        when(generationMapper.selectById(any())).thenAnswer(call -> live.stream()
                .filter(item -> item.getId().equals(call.getArgument(0))).findFirst().orElse(null));

        List<Map<String, Object>> sent = new ArrayList<>();
        when(client.indexSource(any())).thenAnswer(call -> {
            sent.add(call.getArgument(0));
            return Map.of("written", writtenPerBatch);
        });

        List<Accounted> accounted = new ArrayList<>();
        org.mockito.Mockito.doAnswer(call -> {
            accounted.add(new Accounted(
                    ((RagIndexJob) call.getArgument(0)).getId(),
                    ((RagIndexableUnit) call.getArgument(1)).getId(),
                    ((RagIndexGeneration) call.getArgument(2)).getId(),
                    call.getArgument(3)));
            return null;
        }).when(jobService).markUnitIndexedWithLease(any(), any(), any(), anyInt());

        RagIndexWorker worker = new RagIndexWorker(new RagProperties(), jobService, client,
                generationMapper, mock(AiNotebookSourceMapper.class),
                mock(RuntimeIssueMapper.class), flags, registry);
        return new Fixture(worker, sent, accounted);
    }

    private static RagIndexGeneration generation(long id, String status) {
        RagIndexGeneration generation = new RagIndexGeneration();
        generation.setId(id);
        generation.setStatus(status);
        generation.setIndexVersion("version-" + id);
        generation.setCollectionName("zhiqu_rag_g_" + id);
        return generation;
    }

    /**
     * 索引完成后必须记账，且向量数是各批 {@code written} 的<b>和</b>。
     *
     * <p>只取最后一批（或干脆传 0）在单批次夹具里看不出来，所以这里是两批。
     */
    @Test
    void 索引完成后写状态行且向量数是各批之和() {
        Fixture f = worker(null, List.of(generation(9, "ACTIVE")), 3);

        f.worker().run();

        assertEquals(2, f.sent().size(), "12 个父块、每批 8 个应当发出 2 批");
        assertEquals(1, f.accounted().size(), "索引完一个代次必须记一次账 —— "
                + "不记账的话门禁的分子恒为 0，覆盖率永远够不到，activate 在 runbook 第 9 步抛异常");
        assertEquals(6, f.accounted().get(0).vectorCount(),
                "3 + 3：只取最后一批会让向量计数长期偏小，而它不参与任何判断，没人会发现");
        assertEquals(77L, f.accounted().get(0).jobId());
        assertEquals(31L, f.accounted().get(0).unitId());
        assertEquals(9L, f.accounted().get(0).generationId());
    }

    /**
     * 不带代次的增量作业写进<b>所有</b>在建/在用代次。
     *
     * <p>重建窗口里 ACTIVE（旧）与 BUILDING（新）并存。只挑一个的话，
     * 用户这次编辑要么进不了新代次、要么当前服役的代次搜不到 ——
     * 表现是「刚改完的内容搜不到」，且要等代次切换后才自愈。
     */
    @Test
    void 增量作业写进全部在建与在用代次() {
        Fixture f = worker(null, List.of(generation(9, "ACTIVE"), generation(10, "BUILDING")), 1);

        f.worker().run();

        assertEquals(4, f.sent().size(), "两个代次 × 每代两批");
        assertEquals(List.of(9L, 10L), f.accounted().stream().map(Accounted::generationId).toList());
    }

    /** 代次展开产生的作业带代次，只能写那一个 —— 否则一次重建会把向量灌进服役中的旧代次。 */
    @Test
    void 带代次的作业只写那一个代次() {
        Fixture f = worker(10L, List.of(generation(9, "ACTIVE"), generation(10, "BUILDING")), 1);

        f.worker().run();

        assertEquals(2, f.sent().size());
        assertEquals(List.of(10L), f.accounted().stream().map(Accounted::generationId).toList());
    }

    /**
     * {@code operationId} 必须带代次。
     *
     * <p>sidecar 按 {@code (operationId, batchNo)} 做幂等键，而每个代次的批号都从 0 重来。
     * 不带代次时第二个代次的每一批都会被判成「这批已经收过了」而跳过，<b>并返回成功</b> ——
     * 于是新代次一条向量都没有，而每一层都显示正常。
     */
    @Test
    void 不同代次的operationId不相同() {
        Fixture f = worker(null, List.of(generation(9, "ACTIVE"), generation(10, "BUILDING")), 1);

        f.worker().run();

        String first = String.valueOf(f.sent().get(0).get("operationId"));
        String second = String.valueOf(f.sent().get(2).get("operationId"));
        assertTrue(first.startsWith("job-77"), "仍要能看出是哪条作业：" + first);
        org.junit.jupiter.api.Assertions.assertNotEquals(first, second,
                "两个代次共用 operationId 时，第二个代次的批会被 sidecar 当成重复批静默跳过");
    }
}

// ── 扰动记录（2026-08-08 实测，五条性质五次扰动）──────────────────────────
//
//   G1  删掉 markUnitIndexedWithLease 调用            RED（3 条用例同时红）
//   G2  written = 改成只取最后一批（去掉 +=）          RED
//   G3  不带代次的分支只取第一个在用代次              RED（1 failure + 1 error）
//   G4  带代次的分支改成取全部在用代次                RED
//   G5  operationId 去掉 -g<代次> 后缀                RED
//
// 五条都红，且红的集合与预期一致（G1 红三条是对的：记账在三条用例里都被断言）。
//
// G5 值得单独说：它扰动的是一个**只在 sidecar 侧才会显形**的性质 ——
// 同一个 operationId 下批号从 0 重来，sidecar 会把第二个代次的每一批当成
// 「这批收过了」而跳过**并返回成功**。Java 侧没有任何异常，向量库里少一个代次的内容。
// 这里能钉住它，靠的是把「两个代次的 operationId 必须不同」提成一条可观察的载荷性质，
// 而不是去测 sidecar 的幂等行为。
