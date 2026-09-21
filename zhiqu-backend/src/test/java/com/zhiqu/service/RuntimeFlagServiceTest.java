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

        // 期望值里只放本条声称的那件事：**每一行**都回落 YAML_DEFAULT。
        // 原来写的是 assertEquals(2, described.size()) + 第 0 行的 source —— 那两样都不是
        // 「回落到 yaml 默认」这条性质的一部分：加一个开关就会让它红，而红的理由与它的名字无关。
        // （实测：加 rag.wiki-scope-max 后它报 expected <2> but was <3>。
        //  那时最省力的动作是把 2 改成 3 —— 而那和「调期望值直到变绿」在 diff 里一模一样。）
        assertEquals(List.of("YAML_DEFAULT", "YAML_DEFAULT", "YAML_DEFAULT"),
                described.stream().map(row -> row.get("source")).toList(),
                "表里无行时每一个开关都该标 YAML_DEFAULT");

        // 顺带钉住「管理端看得见全部开关」：describeAll 与 set 的白名单必须同源。
        // 两者漂开时新开关能被 set 写进去却不出现在管理端 —— 运维看不到它，也就不知道它生效着。
        assertEquals(RuntimeFlagService.KNOWN_KEY_ORDER,
                described.stream().map(row -> row.get("key")).toList(),
                "describeAll 必须逐个列出 KNOWN_KEY_ORDER，且顺序一致");
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
