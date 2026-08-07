package com.zhiqu.rag;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Data
@Component
@ConfigurationProperties(prefix = "app.rag")
public class RagProperties {
    private boolean enabled = false;
    private String baseUrl = "http://127.0.0.1:8001";
    private String serviceToken = "";
    private int connectTimeoutMs = 300;
    private int readTimeoutMs = 1800;
    private int candidateK = 24;
    private int finalK = 8;
    private int maxContextChars = 10000;
    private int maxPerSource = 3;
    private int maxSnippetChars = 1600;
    private boolean fallbackEnabled = true;
    private String indexVersion = "bge-small-zh-v1.5@pinned-token448-overlap64-v1-cosine";
    private int workerBatchSize = 4;
    private int maxAttempts = 8;

    // 以下两项是 app_runtime_flag 的种子默认值：表里没有对应行时才生效。
    // 停机切换期间由管理端在运行时翻转（Spring Boot 不热读 yaml），不要指望改这里能立刻生效。
    private boolean producerFrozen = false;
    private String workerMode = "NORMAL";

    /**
     * 升级期双删窗口：打开时每次删除同时入队 LEGACY 与 UNIT 两种方言的清理作业。
     * Phase 1B 上线后保留一个发布周期，确认旧代次已 PURGED 再关掉。
     * Phase 1A 阶段 UNIT 方言还没有对应向量可清，因此默认关闭。
     */
    private boolean dualDeleteWindow = false;

    /**
     * 全量对账允许的跳过比例上限。超过则作业失败（RETRY→DEAD 并告警），不是记条日志了事。
     *
     * <p><b>这个值此前只活在注释里</b>：{@code ReconcileReport.skippedRatio()} 有定义、零消费方，
     * 于是「每 20 个单元最多藏 1 个静默失败」这条论证的前提根本不成立 —— 实际是藏多少个都行。
     * 它是「写在散文里的不变量，没有任何东西执行它」的又一例（同迁移纪律、同四个声明里
     * 只实现了两个的操作）。现在由 {@code RagIndexWorker.reconcileUnits} 执行。
     *
     * <p>主要防的是主密钥配错：那时全部 Wiki 页解密失败、全部标 SKIPPED，
     * 而代次照常 READY —— 检索结果悄悄少掉一整类语料，没有任何报错。
     */
    private double maxSkippedRatio = 0.05;
}
