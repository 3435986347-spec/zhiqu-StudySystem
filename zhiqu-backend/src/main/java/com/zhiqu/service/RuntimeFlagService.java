package com.zhiqu.service;

import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AppRuntimeFlag;
import com.zhiqu.mapper.AppRuntimeFlagMapper;
import com.zhiqu.rag.RagProperties;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 运行时可变开关。
 *
 * <p>存在的唯一理由是 Spring Boot 不热读 application.yml，而 RAG 索引协议的停机切换需要
 * 先在不重启的前提下冻结生产者、等队列自然排空，再停机换版本。yaml 只提供种子默认值，
 * 表里有行时以表为准。
 *
 * <p><b>本方案假定单实例部署</b>：本类不是为多实例准备的，缓存也没有跨实例失效机制。
 *
 * <p>缓存 5 秒：RagIndexWorker 每秒轮询一次，每轮都打库既无必要也会放大 cutover 期间的
 * 数据库压力。代价是翻转开关后最长 5 秒仍有旧值生效。
 *
 * <p><b>runbook 为什么在 set() 之后还要等 ≥2×TTL</b>（别把这段等待当冗余优化掉）：
 * {@code set()} 确实会立刻失效缓存，但 {@link #snapshot} 是普通字段写，存在丢失更新窗口——
 * 线程 B 可能在 A 失效之前读到旧值、在 A 失效之后才把带新时间戳的快照写回去，于是旧值
 * 又活了最多一个 TTL。翻转 producer-frozen 后若不等待就判定 {@code PENDING == 0}，
 * 这个 0 可能是假的：仍有实例在按旧值入队。原因是这个窗口，不是多实例。
 */
@Service
public class RuntimeFlagService {

    /** true = 业务钩子不再入队新 job；已入队的照常被消费。 */
    public static final String RAG_PRODUCER_FROZEN = "rag.producer-frozen";
    /** NORMAL | REBUILD_ONLY | OFF，见 {@link WorkerMode}。 */
    public static final String RAG_WORKER_MODE = "rag.worker-mode";
    /** Wiki 检索范围的页数上界。E-4 现场要能不重启地调，所以走运行时开关而不是只读 yaml。 */
    public static final String RAG_WIKI_SCOPE_MAX = "rag.wiki-scope-max";

    public static final long CACHE_TTL_MS = 5_000L;

    private static final Set<String> BOOLEAN_KEYS = Set.of(RAG_PRODUCER_FROZEN);

    /**
     * 全部已知开关，<b>唯一定义</b>，且顺序即管理端展示顺序。
     *
     * <p>此前「有哪些开关」写了两份：这个集合负责 {@link #set} 的白名单，
     * {@link #describeAll()} 里另有一份手写的 {@code List.of(...)}。
     * 两份漂开的失效形态很静默：新开关能被 {@code set} 写进去，却<b>不出现在管理端</b> ——
     * 运维看不到它、也就不知道它生效着，而每一处单看都是对的。
     * 这是本仓库第六次「共享词表没有单一定义」，修法同前：收成一处，让调用点派生。
     */
    public static final List<String> KNOWN_KEY_ORDER =
            List.of(RAG_PRODUCER_FROZEN, RAG_WORKER_MODE, RAG_WIKI_SCOPE_MAX);

    private static final Set<String> KNOWN_KEYS = Set.copyOf(KNOWN_KEY_ORDER);

    public enum WorkerMode {
        /** 领取全部作业。 */
        NORMAL,
        /** 只领取代次重建相关作业，不碰业务侧增量——cutover 第 8 步用它跑 rebuild。 */
        REBUILD_ONLY,
        /** 不领取任何作业。 */
        OFF
    }

    private final AppRuntimeFlagMapper flagMapper;
    private final RagProperties ragProperties;

    private volatile Snapshot snapshot = new Snapshot(Map.of(), 0L);

    public RuntimeFlagService(AppRuntimeFlagMapper flagMapper, RagProperties ragProperties) {
        this.flagMapper = flagMapper;
        this.ragProperties = ragProperties;
    }

    public boolean producerFrozen() {
        return Boolean.parseBoolean(get(RAG_PRODUCER_FROZEN));
    }

    public WorkerMode workerMode() {
        // 先判空再 valueOf：Enum.valueOf(null) 抛的是 NPE 而非 IllegalArgumentException，
        // 只 catch IAE 会漏掉「yaml 里写了 worker-mode: 却不给值」这条——Spring 会绑成 null，
        // 而那恰恰是本兜底最想挡住的场景（宁可按 NORMAL 继续跑，也不要让索引 worker 整个哑掉）。
        String raw = get(RAG_WORKER_MODE);
        if (raw == null || raw.isBlank()) {
            return WorkerMode.NORMAL;
        }
        try {
            return WorkerMode.valueOf(raw);
        } catch (IllegalArgumentException e) {
            // 表里被人手工写入了非法值
            return WorkerMode.NORMAL;
        }
    }

    /**
     * Wiki 范围页数上界。非法值（负数、非数字）一律回落到 yaml 默认，
     * 与 {@link #workerMode()} 同一个取舍：宁可按默认继续跑，也不要因为表里被手工写坏
     * 而让整个 Wiki 检索范围塌成 0 —— 那种失效是静默的（检索不到，不报错）。
     */
    public int wikiScopeMax() {
        try {
            int value = Integer.parseInt(get(RAG_WIKI_SCOPE_MAX));
            return value > 0 ? value : ragProperties.getMaxWikiScopeUnits();
        } catch (NumberFormatException | NullPointerException e) {
            return ragProperties.getMaxWikiScopeUnits();
        }
    }

    /** 表里没有该键时回落到 yaml 种子默认值。 */
    public String get(String key) {
        String stored = currentValues().get(key);
        return stored != null ? stored : seedDefault(key);
    }

    /** 管理端展示用：每个已知开关的当前生效值与来源。 */
    public List<Map<String, Object>> describeAll() {
        Map<String, String> values = currentValues();
        List<Map<String, Object>> rows = new java.util.ArrayList<>();
        for (String key : KNOWN_KEY_ORDER) {
            Map<String, Object> row = new LinkedHashMap<>();
            String stored = values.get(key);
            row.put("key", key);
            row.put("value", stored != null ? stored : seedDefault(key));
            row.put("source", stored != null ? "DB" : "YAML_DEFAULT");
            row.put("seedDefault", seedDefault(key));
            rows.add(row);
        }
        return rows;
    }

    public void set(String key, String rawValue, String updatedBy) {
        if (!KNOWN_KEYS.contains(key)) {
            throw new BusinessException("未知的运行时开关：" + key);
        }
        String value = normalize(key, rawValue);
        flagMapper.upsert(key, value, updatedBy);
        // 立刻失效本地缓存，让管理端翻转后的读取不必再等 TTL
        snapshot = new Snapshot(Map.of(), 0L);
    }

    /** 校验并归一化，避免一个拼错的值把 worker 静默卡在错误模式上。 */
    private String normalize(String key, String rawValue) {
        String trimmed = rawValue == null ? "" : rawValue.trim();
        if (BOOLEAN_KEYS.contains(key)) {
            if (!"true".equalsIgnoreCase(trimmed) && !"false".equalsIgnoreCase(trimmed)) {
                throw new BusinessException("开关 " + key + " 只接受 true 或 false");
            }
            return trimmed.toLowerCase(Locale.ROOT);
        }
        if (RAG_WORKER_MODE.equals(key)) {
            try {
                return WorkerMode.valueOf(trimmed.toUpperCase(Locale.ROOT)).name();
            } catch (IllegalArgumentException e) {
                throw new BusinessException("开关 " + key + " 只接受 NORMAL / REBUILD_ONLY / OFF");
            }
        }
        if (RAG_WIKI_SCOPE_MAX.equals(key)) {
            // 在**写入边界**拒绝，而不是等读取时回落到默认值。回落是有的
            // （wikiScopeMax() 对非法值兜底），但那条兜底只防「表被手工写坏」；
            // 经 set(...) 写进来的非法值如果也静默回落，运维会看到自己刚设的 5000
            // 却仍按 200 生效，且没有任何提示 —— 与 sidecar 把 namespace 校验放在唯一入口同理。
            try {
                int value = Integer.parseInt(trimmed);
                if (value <= 0) throw new NumberFormatException();
                return String.valueOf(value);
            } catch (NumberFormatException e) {
                throw new BusinessException("开关 " + key + " 只接受正整数（页数），收到：" + rawValue);
            }
        }
        return trimmed;
    }

    private String seedDefault(String key) {
        return switch (key) {
            case RAG_PRODUCER_FROZEN -> String.valueOf(ragProperties.isProducerFrozen());
            case RAG_WORKER_MODE -> ragProperties.getWorkerMode();
            case RAG_WIKI_SCOPE_MAX -> String.valueOf(ragProperties.getMaxWikiScopeUnits());
            default -> null;
        };
    }

    private Map<String, String> currentValues() {
        Snapshot current = snapshot;
        if (System.currentTimeMillis() - current.loadedAt() < CACHE_TTL_MS) {
            return current.values();
        }
        Map<String, String> loaded = new LinkedHashMap<>();
        for (AppRuntimeFlag flag : flagMapper.selectList(null)) {
            loaded.put(flag.getFlagKey(), flag.getFlagValue());
        }
        Snapshot refreshed = new Snapshot(Map.copyOf(loaded), System.currentTimeMillis());
        snapshot = refreshed;
        return refreshed.values();
    }

    private record Snapshot(Map<String, String> values, long loadedAt) {
    }
}
