package com.zhiqu.rag;

import com.zhiqu.entity.RagIndexJob;
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
 * UNIT 方言的删除请求形状。
 *
 * <p>双删的两条作业共享同一个 {@code operation}（一次「删除资料」入队的是两条
 * {@code DELETE_SOURCE}，只有 dialect 不同），所以 UNIT 那条要在消费端把
 * SOURCE/NOTEBOOK 翻译成 UNIT/SCOPE，并换一整套字段。
 *
 * <p><b>只钉可达的性质。</b>{@code unitScopeFor} 里 NAMESPACE/USER/COLLECTION 三个透传
 * 分支今天走不到（它们只由 DELETE_GENERATION 使用，而它不参与双删）——不给不可达路径
 * 写测试：那会把「不可达」这件事冻在测试里，将来它变得可达时，那条测试会以「通过」的
 * 形式误导人。为什么今天走不到，由 worker 里的注释承载。
 */
class RagUnitScopeTranslationTest {

    private record Fixture(RagIndexWorker worker, List<Map<String, Object>> sent) {}

    private Fixture workerWith(RagIndexJob job) {
        RagIndexJobService jobService = mock(RagIndexJobService.class);
        RagClient client = mock(RagClient.class);
        RuntimeFlagService flags = mock(RuntimeFlagService.class);
        when(client.configured()).thenReturn(true);
        when(jobService.claimDueJobs(anyInt(), anyString(), anyBoolean())).thenReturn(List.of(job));
        when(jobService.renewLease(any())).thenReturn(true);
        when(flags.workerMode()).thenReturn(RuntimeFlagService.WorkerMode.NORMAL);

        List<Map<String, Object>> sent = new ArrayList<>();
        when(client.deleteIndex(any())).thenAnswer(call -> {
            sent.add(call.getArgument(0));
            return Map.of("deleted", 0);
        });

        RagIndexWorker worker = new RagIndexWorker(new RagProperties(), jobService, client,
                mock(RagIndexGenerationMapper.class), mock(AiNotebookSourceMapper.class),
                mock(RuntimeIssueMapper.class), flags,
                mock(RagUnitRegistry.class));
        return new Fixture(worker, sent);
    }

    private RagIndexJob job(String operation, String dialect) {
        RagIndexJob job = new RagIndexJob();
        job.setId(7L);
        job.setOperation(operation);
        job.setDeleteDialect(dialect);
        job.setUserId(1L);
        job.setNotebookId(2L);
        job.setSourceId(3L);
        job.setUnitId(31L);
        job.setNamespace(RagNamespace.NOTEBOOK_SOURCE);
        job.setScopeId(2L);
        job.setLeaseVersion(1L);
        job.setLockedBy("worker-1");
        return job;
    }

    /**
     * UNIT 方言不再是 no-op。Phase 1A 时它被显式跳过（那时没有 unit 格式的向量），
     * 1B-2 起两种格式并存，缺哪一半都会留下删不掉的残留。
     */
    @Test
    void unit方言的删除资料发出_UNIT_作用域与_unit_字段() {
        Fixture f = workerWith(job("DELETE_SOURCE", RagIndexJobService.DIALECT_UNIT));

        f.worker().run();

        assertEquals(1, f.sent().size(), "UNIT 方言必须真的发出请求，不能再是 no-op");
        Map<String, Object> payload = f.sent().get(0);
        assertEquals("UNIT", payload.get("scope"));
        assertEquals(31L, payload.get("unitId"));
        assertFalse(payload.containsKey("sourceId"), "unit 方言不得混入 LEGACY 字段");
        assertFalse(payload.containsKey("notebookId"), "unit 方言不得混入 LEGACY 字段");
    }

    /** 删 Notebook 的 UNIT 半边翻译成 SCOPE，并带上 namespace + scopeId。 */
    @Test
    void unit方言的删除notebook翻译成_SCOPE() {
        Fixture f = workerWith(job("DELETE_NOTEBOOK", RagIndexJobService.DIALECT_UNIT));

        f.worker().run();

        Map<String, Object> payload = f.sent().get(0);
        assertEquals("SCOPE", payload.get("scope"));
        assertEquals(RagNamespace.NOTEBOOK_SOURCE, payload.get("namespace"));
        assertEquals(2L, payload.get("scopeId"));
    }

    /** LEGACY 半边保持原样 —— 旧代次的向量只有这套字段定位得到。 */
    @Test
    void legacy方言保持旧作用域与旧字段() {
        Fixture f = workerWith(job("DELETE_SOURCE", RagIndexJobService.DIALECT_LEGACY));

        f.worker().run();

        Map<String, Object> payload = f.sent().get(0);
        assertEquals("SOURCE", payload.get("scope"));
        assertEquals(3L, payload.get("sourceId"));
        assertEquals(2L, payload.get("notebookId"));
        assertFalse(payload.containsKey("unitId"), "LEGACY 方言不得混入 unit 字段");
    }

    /**
     * 无法翻译的作用域必须抛异常，**不能原样透传**。
     *
     * <p>这条与那三个透传分支不同：它是可达且静默的。透传的话 sidecar 会看到一个
     * 合法的 scope、却配着另一套字段，于是删出一个比预期宽的范围 ——
     * 而 scope 合法意味着没有任何一层会报错。
     *
     * <p>断言的是「请求没有发出去」：抛出的异常被 worker 的 catch 接住转成失败作业，
     * 所以从外部看不到异常本身，能看到的是 sidecar 一个请求都没收到。
     */
    @Test
    void 无法用unit方言表达的作用域不得透传给sidecar() {
        Fixture f = workerWith(job("DELETE_UNKNOWN_SCOPE", RagIndexJobService.DIALECT_UNIT));

        f.worker().run();

        assertTrue(f.sent().isEmpty(),
                "未知作用域被透传了 —— sidecar 会按合法 scope 配另一套字段删出更宽的范围，且不报错");
    }
}
