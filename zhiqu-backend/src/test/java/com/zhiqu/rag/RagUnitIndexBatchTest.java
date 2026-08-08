package com.zhiqu.rag;

import com.zhiqu.entity.RagIndexGeneration;
import com.zhiqu.entity.RagIndexJob;
import com.zhiqu.entity.RagIndexableUnit;
import com.zhiqu.entity.RagUnitChunk;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import com.zhiqu.mapper.AiSourceChunkMapper;
import com.zhiqu.mapper.RagIndexGenerationMapper;
import com.zhiqu.mapper.RuntimeIssueMapper;
import com.zhiqu.service.RuntimeFlagService;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * unit 索引路径的分批与载荷形状。
 *
 * <p><b>夹具必须是多批次的。</b>{@code finalBatch} 是必填 bool，所以不会忘记传；
 * 危险在于「每批都传 false」是完全合法的载荷 —— pydantic 照过，而 sidecar 的
 * {@code _finalize_source} 只在它为真时跑。后果是上一次索引留下的过期向量永不清理、
 * 继续参与检索命中，且 operation 一直挂着不终结，每一层都显示成功。
 *
 * <p>而这条性质<b>在单批次用例里恒绿</b>：只有一批时它必然是最后一批。
 * 所以 chunk 数必须超过 worker 的 PARENT_CHUNKS_PER_BATCH（当前 8）。
 * 用 20 而不是 9，是为了让「多于两批」也被覆盖 —— 只跨两批时
 * 「除第一批外全为 true」和「只有最后一批为 true」两种实现都能通过。
 */
class RagUnitIndexBatchTest {

    private static final int CHUNK_COUNT = 20;

    private record Fixture(RagIndexWorker worker, List<Map<String, Object>> sent) {}

    private Fixture worker(String canonicalText, List<RagUnitChunk> chunks, Long scopeId) {
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
        job.setLeaseVersion(1L);
        job.setLockedBy("worker-1");

        RagIndexableUnit unit = new RagIndexableUnit();
        unit.setId(31L);
        unit.setUserId(1L);
        unit.setNamespace(RagNamespace.WIKI_PAGE);
        unit.setScopeId(scopeId);
        unit.setCanonicalHash("canonical-hash-abc");

        RagIndexGeneration generation = new RagIndexGeneration();
        generation.setId(9L);
        generation.setStatus("ACTIVE");
        generation.setIndexVersion("version-1");
        generation.setCollectionName("zhiqu_rag_g_9");

        when(client.configured()).thenReturn(true);
        when(jobService.claimDueJobs(anyInt(), anyString(), anyBoolean())).thenReturn(List.of(job));
        when(jobService.renewLease(any())).thenReturn(true);
        when(flags.workerMode()).thenReturn(RuntimeFlagService.WorkerMode.NORMAL);
        when(registry.refreshUnitIfLive(anyString(), any())).thenReturn(true);
        when(registry.loadForIndexing(anyString(), any()))
                .thenReturn(new RagUnitRegistry.IndexableUnitSnapshot(unit, canonicalText, chunks));
        when(generationMapper.selectOne(any())).thenReturn(generation);

        List<Map<String, Object>> sent = new ArrayList<>();
        when(client.indexSource(any())).thenAnswer(call -> {
            sent.add(call.getArgument(0));
            return Map.of("written", 1);
        });

        RagIndexWorker worker = new RagIndexWorker(new RagProperties(), jobService, client,
                generationMapper, mock(AiNotebookSourceMapper.class), mock(AiSourceChunkMapper.class),
                mock(RuntimeIssueMapper.class), flags, registry);
        return new Fixture(worker, sent);
    }

    private static List<RagUnitChunk> chunks(int count, int width) {
        List<RagUnitChunk> rows = new ArrayList<>();
        for (int index = 0; index < count; index++) {
            RagUnitChunk chunk = new RagUnitChunk();
            chunk.setId(1000L + index);
            chunk.setUnitId(31L);
            chunk.setChunkIndex(index);
            chunk.setCharStart(index * width);
            chunk.setCharEnd((index + 1) * width);
            rows.add(chunk);
        }
        return rows;
    }

    @Test
    void 只有最后一批的_finalBatch_为真() {
        Fixture f = worker("a".repeat(CHUNK_COUNT * 4), chunks(CHUNK_COUNT, 4), 2L);

        f.worker().run();

        assertEquals(3, f.sent().size(), "20 个父块、每批 8 个应当发出 3 批");
        for (int i = 0; i < f.sent().size() - 1; i++) {
            assertFalse((Boolean) f.sent().get(i).get("finalBatch"),
                    "第 " + i + " 批不是最后一批，finalBatch 必须为 false");
        }
        assertTrue((Boolean) f.sent().get(f.sent().size() - 1).get("finalBatch"),
                "最后一批必须为 true —— 否则 sidecar 的 _finalize_source 永不执行，"
                        + "上次索引的过期向量永不清理且继续参与命中，而每一层都显示成功");
    }

    /** 批号必须连续从 0 递增：sidecar 用 (operationId, batchNo) 做幂等键。 */
    @Test
    void 批号从零连续递增() {
        Fixture f = worker("a".repeat(CHUNK_COUNT * 4), chunks(CHUNK_COUNT, 4), 2L);

        f.worker().run();

        for (int i = 0; i < f.sent().size(); i++) {
            assertEquals(i, f.sent().get(i).get("batchNo"));
        }
    }

    /** 三个硬约束的来源，逐个钉住（理由见 docs/rag-1b2-stage-e-handoff.md）。 */
    @Test
    void 载荷的三个硬约束字段来源正确() {
        Fixture f = worker("a".repeat(CHUNK_COUNT * 4), chunks(CHUNK_COUNT, 4), 2L);

        f.worker().run();
        Map<String, Object> first = f.sent().get(0);

        assertEquals(77L, first.get("mutationToken"),
                "必须是 job.getId() —— 与删除侧同一个单调序列，换成时间戳会在时钟回拨时倒向索引");
        assertEquals("canonical-hash-abc", first.get("contentHash"),
                "必须是投影行的 canonical_hash，否则同一份内容会有两个哈希");
        assertEquals(31L, first.get("unitId"), "unitId 是投影行的代理主键，不是 refId");
        assertEquals(RagNamespace.WIKI_PAGE, first.get("namespace"));
        assertFalse(first.containsKey("sourceId"), "unit 方言不得混入 LEGACY 字段");
    }

    /** scopeId 为空时整个键不写 —— Chroma 的 metadata 不接受 None。 */
    @Test
    void scopeId为空时载荷里没有这个键() {
        Fixture f = worker("a".repeat(CHUNK_COUNT * 4), chunks(CHUNK_COUNT, 4), null);

        f.worker().run();

        assertFalse(f.sent().get(0).containsKey("scopeId"),
                "传 null 会让 sidecar 的 metadata 写入失败；缺省时必须整个键不写");
    }

    /**
     * 切片按 code point，不是 UTF-16 code unit。
     *
     * <p>用 emoji 构造：每个 emoji 是 1 个 code point、2 个 char。若实现用了
     * {@code substring}，切出的是半个代理对，内容会错位且哈希对不上。
     */
    @Test
    void 切片按codepoint而不是char() {
        String emoji = "😀";
        String text = emoji.repeat(CHUNK_COUNT * 2);
        Fixture f = worker(text, chunks(CHUNK_COUNT, 2), 2L);

        f.worker().run();

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> payloadChunks =
                (List<Map<String, Object>>) f.sent().get(0).get("chunks");
        String content = String.valueOf(payloadChunks.get(0).get("content"));
        assertEquals(2, content.codePointCount(0, content.length()),
                "应当切出 2 个 code point；按 char 切会得到 1 个 emoji（4 char 中的 2 个）");
        assertEquals(emoji + emoji, content);
    }
}

// ── 扰动记录（2026-08-08 实测）──────────────────────────────────────────────
//
//   F1  finalBatch 恒为 false          RED  只有最后一批的_finalBatch_为真
//   F2  finalBatch 恒为 true           RED  同上（非末批必须为 false 那一半）
//   F3  切片改用 substring              RED  切片按codepoint而不是char
//   F4  mutationToken 换 currentTimeMillis  RED  载荷的三个硬约束字段来源正确
//   F5  scopeId 恒写（含 null）         RED  scopeId为空时载荷里没有这个键
//
// **F1/F2 第一次跑是 GREEN 的，而那不是「测试不敏感」，是扰动打偏了。**
// 锚点 `payload.put("finalBatch", end >= chunks.size());` 在本文件里有**两处**
// （legacy 的 indexSource 与新的 indexUnit），而 replace(old, new, 1) 改的是第一处 ——
// legacy 路径，本测试根本不走它。
//
// 危险在于**判据看不出来**：锚点确实匹配上了，扰动确实被施加了，测试确实是绿的。
// 三个「确实」凑起来就是一句「测试不敏感」的结论 —— 而结论是错的。
// 这与容器瞬时故障被读成 RED 是镜像的一对：那次是装置坏了被当成结论，
// 这次是装置打偏了被当成结论，方向相反、形状相同。
//
// 修法是让锚点唯一（带上足以区分两处的上下文），并在施加前断言
// `s.count(anchor) == 1` —— 把「扰动是否落在被验对象上」变成机器可检的前置条件，
// 而不是靠写扰动的人记得两处同名。
