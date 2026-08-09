package com.zhiqu.rag;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.entity.RagIndexGeneration;
import com.zhiqu.entity.RagIndexableUnit;
import com.zhiqu.entity.RagSourceIndexState;
import com.zhiqu.mapper.RagIndexGenerationMapper;
import com.zhiqu.mapper.RagSourceIndexStateMapper;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Service
public class RagRetriever {
    private final RagProperties properties;
    private final RagClient client;
    private final RagIndexGenerationMapper generationMapper;
    private final RagSourceIndexStateMapper stateMapper;
    private final RagUnitRegistry registry;
    private final RagMetricsService metrics;

    public RagRetriever(RagProperties properties,
                        RagClient client,
                        RagIndexGenerationMapper generationMapper,
                        RagSourceIndexStateMapper stateMapper,
                        RagUnitRegistry registry,
                        RagMetricsService metrics) {
        this.properties = properties;
        this.client = client;
        this.generationMapper = generationMapper;
        this.stateMapper = stateMapper;
        this.registry = registry;
        this.metrics = metrics;
    }

    /**
     * 检索。范围由 {@link ScopeSelection} 给出 —— {@code userId} 仍单独传，
     * 因为它是 sidecar 请求体的字段，与「范围里有哪些单元」是两件事。
     *
     * <p><b>1B-2 step 2：请求体换成 unit 方言</b>（{@code unitIds} + {@code namespaces}），
     * 索引状态也改按 {@code unit_id} 查、按 {@code canonical_hash} 判新鲜。
     *
     * <p>这一步<b>不是</b>「顺手把键名改整齐」，两侧都已经没有退路：
     * <ul>
     *   <li>请求侧 —— Stage D 之后 sidecar 的 {@code QueryRequest} 必填
     *       {@code namespaces} + {@code unitIds}（rag-service/app/main.py:51-59），
     *       少哪个都是 422，整个请求被拒。</li>
     *   <li>状态侧 —— 1c 之后 {@code upsertUnitState} 是状态行的唯一写入口，
     *       它写的行 {@code source_id} 恒为 NULL（RagIndexJobService.java:729）。
     *       继续按 {@code sourceId} 查状态的话，查到的<b>永远是空集</b>，
     *       于是每一次检索都回落到 {@code NO_INDEXED_SOURCE} —— 不报错、不告警，
     *       只是向量检索从此再也不生效。</li>
     * </ul>
     *
     * <p><b>{@code notebookId} 不再进请求体。</b>sidecar 的 {@code QueryRequest} 没有这个字段，
     * 而 pydantic 默认 {@code extra='ignore'}（实测：2.13.4 静默丢弃未声明字段，不是 422）。
     * 也就是说留着它不会报错 —— 这正是要删的理由：请求体里带一个<b>看起来像范围限定、
     * 实际不被执行</b>的字段，与 sidecar 自己那条 namespace 校验想挡的是同一种静默分区。
     * 真正的范围限定由 {@code unitIds} 给出，而单元行自带 {@code scopeId}。
     * 同理 {@code sourceIds} 必须一起消失，不能靠「反正对方会忽略」留着。
     */
    public RetrievalResult retrieve(String requestId, Long userId,
                                    ScopeSelection scope, String question) {
        // 两种不可用分开处理，而且**行为不同**，不只是文案不同：
        // DISABLED 是设计内的正常状态（仓库默认就是 false），记进 fallback 指标只会把它刷满、
        // 淹掉真正的回落原因；TOKEN_MISSING 是「开着却不工作」的配置错误，必须留下痕迹。
        String unavailable = client.unavailableReason();
        if (RagClient.REASON_DISABLED.equals(unavailable)) return disabled();
        if (unavailable != null) return fallback(unavailable);
        RagIndexGeneration generation = generationMapper.selectOne(new LambdaQueryWrapper<RagIndexGeneration>()
                .eq(RagIndexGeneration::getStatus, "ACTIVE").orderByDesc(RagIndexGeneration::getId).last("LIMIT 1"));
        if (generation == null) return fallback("NO_ACTIVE_GENERATION");
        List<RagIndexableUnit> indexedUnits = freshlyIndexedUnits(scope, generation);
        if (indexedUnits.isEmpty()) return fallback("NO_INDEXED_SOURCE", generation);
        long started = System.nanoTime();
        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("requestId", requestId);
            payload.put("userId", userId);
            payload.put("question", question == null ? "" : question);
            payload.put("candidateK", properties.getCandidateK());
            payload.put("namespaces", indexedUnits.stream()
                    .map(RagIndexableUnit::getNamespace).distinct().toList());
            payload.put("unitIds", indexedUnits.stream().map(RagIndexableUnit::getId).toList());
            payload.put("indexVersion", generation.getIndexVersion());
            payload.put("collectionName", generation.getCollectionName());
            Map<String, Object> response = client.query(payload);
            if (!generation.getIndexVersion().equals(String.valueOf(response.get("indexVersion")))) {
                return fallback("INDEX_VERSION_MISMATCH", generation);
            }
            List<Map<String, Object>> candidates = mapList(response.get("candidates"));
            metrics.recordQuery((System.nanoTime() - started) / 1_000_000, candidates.size(), 0, 0);
            return new RetrievalResult(true, null, generation, candidates,
                    indexedNotebookSourceIds(indexedUnits));
        } catch (Exception e) {
            return fallback(e.getClass().getSimpleName());
        }
    }

    /**
     * 范围里<b>在当前代次已索引、且内容没变过</b>的投影单元，保持范围的顺序。
     *
     * <p>新鲜度比对的是 {@code state.contentHash} 与 {@code unit.canonicalHash} ——
     * 不是资料的 {@code content_hash}。两者是不同的哈希：写状态行的
     * {@code upsertUnitState} 存的就是 {@code canonicalHash}（RagIndexJobService.java:733/745），
     * 拿资料哈希去比会<b>恒不相等</b>，表现为「索引明明是好的，检索却永远回落」。
     *
     * <p>{@code scope.projectedUnits()} 今天恒为空（Wiki 侧在 step 3 才接进来），
     * 但这里刻意<b>现在就把它算进去</b>：只写 Notebook 那一半的话，step 3 要动的就不止是回填，
     * 而「检索范围少了一个命名空间」不会抛异常，只表现为 Wiki 页检索不到。
     */
    private List<RagIndexableUnit> freshlyIndexedUnits(ScopeSelection scope, RagIndexGeneration generation) {
        List<RagIndexableUnit> units = new ArrayList<>(
                registry.findUnits(RagNamespace.NOTEBOOK_SOURCE, scope.notebookSourceIds()));
        units.addAll(scope.projectedUnits());
        if (units.isEmpty()) return List.of();
        Map<Long, RagIndexableUnit> byUnitId = new LinkedHashMap<>();
        units.forEach(unit -> byUnitId.put(unit.getId(), unit));
        List<RagSourceIndexState> states = stateMapper.selectList(
                new LambdaQueryWrapper<RagSourceIndexState>()
                        .eq(RagSourceIndexState::getGenerationId, generation.getId())
                        .eq(RagSourceIndexState::getStatus, "INDEXED")
                        .in(RagSourceIndexState::getUnitId, byUnitId.keySet()));
        Map<Long, String> hashByUnitId = new LinkedHashMap<>();
        states.forEach(state -> hashByUnitId.put(state.getUnitId(), state.getContentHash()));
        List<RagIndexableUnit> fresh = new ArrayList<>();
        for (RagIndexableUnit unit : units) {
            String indexedHash = hashByUnitId.get(unit.getId());
            if (indexedHash != null && indexedHash.equals(unit.getCanonicalHash())) fresh.add(unit);
        }
        return fresh;
    }

    /**
     * 调用方据此决定哪些资料还要补关键词行（AiWorkspaceServiceImpl.java:480-482），
     * 所以这里必须过滤出 <b>NOTEBOOK_SOURCE 的 {@code refId}</b>，而不是单元 id。
     *
     * <p>直接把 unit id 交出去的话类型照样是 {@code Set<Long>}、编译照样通过，
     * 而 {@code contains} 从此恒为 false —— 每一份资料都会再补一遍关键词行，
     * 表现只是「上下文里重复内容变多」。
     */
    private Set<Long> indexedNotebookSourceIds(List<RagIndexableUnit> indexedUnits) {
        Set<Long> refIds = new LinkedHashSet<>();
        for (RagIndexableUnit unit : indexedUnits) {
            if (RagNamespace.NOTEBOOK_SOURCE.equals(unit.getNamespace())) refIds.add(unit.getRefId());
        }
        return refIds;
    }

    /**
     * <b>唯一的回落出口</b>：记一次指标，再构造结果。
     *
     * <p>不变量：{@code retrieve} 的每一条非成功返回<b>恰好记一次</b>回落原因，
     * {@link #disabled()} 是唯一刻意的例外。
     *
     * <p>此前这条不变量靠「写 return 的时候记得在旁边加一行 recordFallback」维持，
     * 而那条纪律<b>已经失效过一次</b>：sidecar 不可用那一条返回压根没记指标，
     * 是拆 {@code DISABLED_OR_TOKEN_MISSING} 时偶然发现的 —— 于是 token 配错时
     * 健康信息里的原因是合并的、指标里干脆没有，两层诊断同时失效。
     *
     * <p>检索侧的改动会新增返回路径（Wiki 候选回填失败、回填时解密失败……），
     * 每一条都要记。收成一个出口之后，「新增了一条不记指标的返回路径」要写出来才行 ——
     * <b>但这是收窄不是消除</b>：同一个文件里仍能直接 {@code new RetrievalResult(false, ...)}。
     * 剩下那半由 {@code RagFallbackAccountingTest} 数构造点兜住。
     */
    private RetrievalResult fallback(String reason) {
        return fallback(reason, null);
    }

    private RetrievalResult fallback(String reason, RagIndexGeneration generation) {
        metrics.recordFallback(reason);
        return new RetrievalResult(false, reason, generation, List.of(), Set.of());
    }

    /**
     * 未启用 —— <b>唯一不记指标的非成功出口</b>，而且刻意写成一个有名字的方法。
     *
     * <p>写成 {@code if (!DISABLED.equals(r)) record(r)} 那种条件的话，
     * 「哪些原因不记」就散在条件表达式里；给它一个出口，例外就是可数的。
     */
    private RetrievalResult disabled() {
        return new RetrievalResult(false, RagClient.REASON_DISABLED, null, List.of(), Set.of());
    }

    private List<Map<String, Object>> mapList(Object value) {
        if (!(value instanceof List<?> list)) return List.of();
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> source)) continue;
            Map<String, Object> row = new LinkedHashMap<>();
            source.forEach((key, entry) -> { if (key != null) row.put(String.valueOf(key), entry); });
            rows.add(row);
        }
        return rows;
    }

    /**
     * <p><b>刻意没有 {@code unavailable(...)} 静态工厂了。</b>它是一条绕过指标记账的近路，
     * 而且看起来完全无辜 —— 留着它，收敛出口这件事就只剩一句约定。
     */
    public record RetrievalResult(boolean available, String fallbackReason, RagIndexGeneration generation,
                                  List<Map<String, Object>> candidates, Set<Long> indexedSourceIds) {
    }
}
