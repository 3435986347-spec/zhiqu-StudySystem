package com.zhiqu.service;

import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AppRuntimeFlag;
import com.zhiqu.mapper.AppRuntimeFlagMapper;
import com.zhiqu.rag.RagProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 运行时开关的校验与回落语义。
 *
 * <p>这两条是 cutover runbook 的地基：开关值写错会让 worker 静默停在错误模式上，
 * 而「表里没有行就回落 yaml 种子默认」保证首次部署不需要预先塞数据。
 */
class RuntimeFlagServiceTest {

    private AppRuntimeFlagMapper flagMapper;
    private RagProperties ragProperties;
    private RuntimeFlagService flags;

    @BeforeEach
    void setUp() {
        flagMapper = mock(AppRuntimeFlagMapper.class);
        ragProperties = new RagProperties();
        when(flagMapper.selectList(any())).thenReturn(new ArrayList<>());
        flags = new RuntimeFlagService(flagMapper, ragProperties);
    }

    @Test
    void 表里无行时回落到yaml种子默认值() {
        assertFalse(flags.producerFrozen());
        assertEquals(RuntimeFlagService.WorkerMode.NORMAL, flags.workerMode());

        List<Map<String, Object>> described = flags.describeAll();
        assertEquals(2, described.size());
        assertEquals("YAML_DEFAULT", described.get(0).get("source"));
    }

    @Test
    void 表里有行时以表为准并标注来源() {
        AppRuntimeFlag stored = new AppRuntimeFlag();
        stored.setFlagKey(RuntimeFlagService.RAG_WORKER_MODE);
        stored.setFlagValue("REBUILD_ONLY");
        when(flagMapper.selectList(any())).thenReturn(List.of(stored));

        assertEquals(RuntimeFlagService.WorkerMode.REBUILD_ONLY, flags.workerMode());
        Map<String, Object> workerRow = flags.describeAll().stream()
                .filter(row -> RuntimeFlagService.RAG_WORKER_MODE.equals(row.get("key")))
                .findFirst().orElseThrow();
        assertEquals("DB", workerRow.get("source"));
        assertEquals("NORMAL", workerRow.get("seedDefault"));
    }

    @Test
    void 非法开关值被拒绝而不是静默写入() {
        assertThrows(BusinessException.class,
                () -> flags.set(RuntimeFlagService.RAG_WORKER_MODE, "REBUILD", "1"));
        assertThrows(BusinessException.class,
                () -> flags.set(RuntimeFlagService.RAG_PRODUCER_FROZEN, "yes", "1"));
        assertThrows(BusinessException.class,
                () -> flags.set("rag.unknown-switch", "true", "1"));
    }

    @Test
    void 合法值被归一化后写入() {
        flags.set(RuntimeFlagService.RAG_WORKER_MODE, " rebuild_only ", "42");
        ArgumentCaptor<String> value = ArgumentCaptor.forClass(String.class);
        verify(flagMapper).upsert(eq(RuntimeFlagService.RAG_WORKER_MODE), value.capture(), eq("42"));
        assertEquals("REBUILD_ONLY", value.getValue());

        flags.set(RuntimeFlagService.RAG_PRODUCER_FROZEN, "TRUE", "42");
        verify(flagMapper).upsert(eq(RuntimeFlagService.RAG_PRODUCER_FROZEN), eq("true"), eq("42"));
    }

    /**
     * yaml 里写了 {@code worker-mode:} 却不给值时 Spring 会绑成 null，
     * 而 {@code Enum.valueOf(null)} 抛的是 NPE 不是 IllegalArgumentException——
     * 只 catch IAE 会漏掉这条，而它恰恰是兜底最想挡住的场景。
     */
    @Test
    void 种子默认值为null时不抛NPE而是回落NORMAL() {
        ragProperties.setWorkerMode(null);

        assertEquals(RuntimeFlagService.WorkerMode.NORMAL, flags.workerMode());
    }

    /** 表里被人手工写坏时宁可按 NORMAL 继续跑，也不要让索引 worker 整个哑掉。 */
    @Test
    void 表中非法值不会让worker哑掉() {
        AppRuntimeFlag broken = new AppRuntimeFlag();
        broken.setFlagKey(RuntimeFlagService.RAG_WORKER_MODE);
        broken.setFlagValue("whatever");
        when(flagMapper.selectList(any())).thenReturn(List.of(broken));

        assertEquals(RuntimeFlagService.WorkerMode.NORMAL, flags.workerMode());
    }

    @Test
    void 写入后立即失效缓存以免管理端还要等TTL() {
        assertFalse(flags.producerFrozen());

        AppRuntimeFlag frozen = new AppRuntimeFlag();
        frozen.setFlagKey(RuntimeFlagService.RAG_PRODUCER_FROZEN);
        frozen.setFlagValue("true");
        when(flagMapper.selectList(any())).thenReturn(List.of(frozen));
        flags.set(RuntimeFlagService.RAG_PRODUCER_FROZEN, "true", "1");

        assertTrue(flags.producerFrozen(), "set() 之后必须立刻可见，不能等 5 秒 TTL");
    }
}
