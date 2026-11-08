package com.zhiqu.rag;

import com.zhiqu.service.RuntimeFlagService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 第一百二十四轮：「默认启动」的定时任务。往前推的那一步本身在 RagBootstrapIntegrationTest（真库、真 worker） */
class RagBootstrapSchedulerTest {

    private final RagAdminService admin = mock(RagAdminService.class);
    private final RagClient client = mock(RagClient.class);
    private final RuntimeFlagService flags = mock(RuntimeFlagService.class);

    private RagBootstrapScheduler scheduler(boolean enabled) {
        RagProperties properties = new RagProperties();
        properties.setEnabled(enabled);
        return new RagBootstrapScheduler(admin, client, properties, flags);
    }

    @Test
    @DisplayName("旁路准备好没有照实传进去（拿锁之前问）；没准备好就传 false")
    void 旁路准备好没有() {
        when(flags.workerMode()).thenReturn(RuntimeFlagService.WorkerMode.NORMAL);
        when(client.meta()).thenReturn(Map.of("ready", true));
        when(admin.bootstrapStep(anyBoolean())).thenReturn("building");
        scheduler(true).tick();
        verify(admin).bootstrapStep(true);
        when(client.meta()).thenReturn(Map.of("ready", false, "reason", "Connection refused"));
        scheduler(true).tick();
        verify(admin).bootstrapStep(false);
    }

    @Test
    @DisplayName("切换期间（worker 关了、生产冻结）、RAG 关着：不替管理员推")
    void 不替管理员推() {
        when(client.meta()).thenReturn(Map.of("ready", true));
        when(flags.workerMode()).thenReturn(RuntimeFlagService.WorkerMode.OFF);
        scheduler(true).tick();
        when(flags.workerMode()).thenReturn(RuntimeFlagService.WorkerMode.NORMAL);
        when(flags.producerFrozen()).thenReturn(true);
        scheduler(true).tick();
        when(flags.producerFrozen()).thenReturn(false);
        scheduler(false).tick();
        verify(admin, never()).bootstrapStep(anyBoolean());
    }

    @Test
    @DisplayName("这一步出错（库断了、覆盖核对抛了）：吞掉，下一次再来 —— 不能把定时任务整个弄停")
    void 出错下次再来() {
        when(flags.workerMode()).thenReturn(RuntimeFlagService.WorkerMode.NORMAL);
        when(client.meta()).thenReturn(Map.of("ready", true));
        when(admin.bootstrapStep(anyBoolean())).thenThrow(new IllegalStateException("库断了"));
        scheduler(true).tick();
        scheduler(true).tick();
        verify(admin, org.mockito.Mockito.times(2)).bootstrapStep(true);
    }
}
