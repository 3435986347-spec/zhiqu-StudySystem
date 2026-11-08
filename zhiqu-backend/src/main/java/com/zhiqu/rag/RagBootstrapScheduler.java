package com.zhiqu.rag;

import com.zhiqu.service.RuntimeFlagService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * RAG 的「默认启动」（第一百二十四轮）：一个启用的索引都没有时，每隔一会儿往前推一步 —— 对账、建、启用，
 * 见 {@link RagAdminService#bootstrapStep}。定时任务总开关是 {@code app.scheduling.enabled}（测试里关着，直接调 bootstrapStep）。
 */
@Component
public class RagBootstrapScheduler {

    private static final Logger log = LoggerFactory.getLogger(RagBootstrapScheduler.class);

    private final RagAdminService admin;
    private final RagClient client;
    private final RagProperties properties;
    private final RuntimeFlagService runtimeFlags;
    private String last = "";

    public RagBootstrapScheduler(RagAdminService admin, RagClient client, RagProperties properties, RuntimeFlagService runtimeFlags) {
        this.admin = admin;
        this.client = client;
        this.properties = properties;
        this.runtimeFlags = runtimeFlags;
    }

    @Scheduled(initialDelayString = "${app.rag.bootstrap-initial-delay-ms:20000}", fixedDelayString = "${app.rag.bootstrap-delay-ms:30000}")
    public void tick() {
        if (!properties.isEnabled()) return;
        // 切换（cutover）期间管理员把 worker 关了：别替他推
        if (runtimeFlags.workerMode() == RuntimeFlagService.WorkerMode.OFF || runtimeFlags.producerFrozen()) return;
        try {
            // 旁路准备好没有，在拿锁之前问：不在锁里等 HTTP
            boolean ready = Boolean.TRUE.equals(client.meta().get("ready"));
            String step = admin.bootstrapStep(ready);
            if (!step.equals(last) && !"active".equals(step)) log.info("RAG 还没有启用的索引，往前推一步：{}", step);
            last = step;
        } catch (Exception e) {
            log.warn("RAG 自举这一步没做成（下一次再来）：{}", e.toString());
        }
    }
}
