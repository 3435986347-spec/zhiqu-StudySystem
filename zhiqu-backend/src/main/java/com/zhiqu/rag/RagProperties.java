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

    /**
     * Wiki 检索范围的<b>页数</b>上界（按 updated_at 倒序取最近 N 页）。
     *
     * <p><b>它限的是 id 基数，不是 token 成本。</b>后者已被三道闸门夹死且与范围大小无关：
     * sidecar 最多回 {@code min(max_candidate_k, candidateK)} 条候选（vector_store.py:230），
     * 之后还有 finalK=8 / maxContextChars=10000 / maxPerSource=3。
     * 无论 {@code $in} 里塞 5 个还是 5000 个 unitId，进模型的东西都一样多。
     *
     * <p>真正随范围线性增长的只有 id 基数：{@code payload.unitIds} 的长度、
     * Chroma {@code $in} 的元素个数、Java 侧状态查询的 {@code IN (...)}。三者都按
     * <b>单元个数</b>增长，与每个单元有多少 chunk 无关 —— 所以上界按<b>页数</b>而不是 chunk 数。
     *
     * <p><b>按 chunk 数给预算是反的：</b>一个 500 chunk 的巨页在 id 基数上的成本是 1，
     * 而按 chunk 预算它会独占预算、把其余几百页全挤出范围。
     * 页数上界是抗巨页的那一个，chunk 预算是怕巨页的那一个。
     *
     * <p>200 是<b>暂定值，没有实测依据</b>。能把它变成有依据的量法见
     * {@code docs/rag-1b2-stage-e-handoff.md}：命中候选在「按 updated_at 倒序」里的排名分布。
     * 延迟 vs N 的曲线回答不了这个问题（它对 N 单调，读不出门槛）。
     */
    private int maxWikiScopeUnits = 200;
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
