package com.zhiqu.rag;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * {@link ContextBudgeter} 的特征化测试（golden master）。
 *
 * <h2>本文件变红时，先读这一段再动手</h2>
 *
 * <p><b>本文件里 7 处 {@code "sourceId"} / {@code "sourceType"} 是硬编码的，刻意的。</b>
 * 生产端已经把这些键名收进 {@code CandidateKeys}，而这里<b>不引用那个常量</b> ——
 * 引用了就两侧同源，键名一改夹具跟着漂移，从此对键名改动完全不敏感
 * （本项目记过的「协议版本断言两侧用同一个常量」那个物种）。
 * 所以它是刻意留在收敛之外的，不是收敛没做完。
 *
 * <p>由此推出：<b>检索侧把候选行的 {@code sourceId} 换成 {@code unitId} 的那一刻，
 * 本文件必然转红，而那是设计内的正确结果。</b>那时最省力、最自然的动作是
 * 「把期望里的键名改掉让它绿」—— 而那正是整套替换流程从头到尾要防的那一个动作，
 * 且做的时候会觉得自己在修一个显然的破损。
 *
 * <h3>正确动作是<b>拆</b>，不是删 —— 因为本类有两个寿命不同的角色</h3>
 *
 * <table border="1">
 *   <caption>本类的两个角色</caption>
 *   <tr><th>角色</th><th>靠什么</th><th>寿命</th></tr>
 *   <tr><td>检测键名改动</td><td>上面那 7 处刻意保留的字面量</td>
 *       <td><b>一次性</b> —— 红一次、任务完成即耗尽</td></tr>
 *   <tr><td>钉 {@code select()} 隔离级的选取行为<br>（去重、每源配额、{@code cropToBudget}）</td>
 *       <td>逐位固定的有序三元组断言</td><td><b>应当长期存活</b></td></tr>
 * </table>
 *
 * <p>三条新基准走的是端到端的 {@code sourceContext}，<b>覆盖不到 {@code select()} 的隔离级行为</b> ——
 * 尤其 {@code cropToBudget} 那段（{@code _hitStart/_hitEnd} 居中裁剪）与配额和 {@code finalK}
 * 的交互，端到端夹具很难精确构造。整类删掉，这一层就没了，
 * <b>而没有任何东西会红来告诉你少了它</b>。
 *
 * <table border="1">
 *   <caption>本文件转红时怎么读</caption>
 *   <tr><th>新基准第二条（payload 换 unitIds）</th><th>含义</th><th>动作</th></tr>
 *   <tr><td><b>已绿</b></td><td>使本类变红的那条性质已有替代品</td>
 *       <td><b>拆</b>：删掉「检测键名改动」这一角色（已耗尽），
 *           夹具的<b>输入</b>改用 {@code CandidateKeys} 构造，<b>行为断言一个期望值都不动</b></td></tr>
 *   <tr><td><b>仍红</b></td><td>在没有替代品的时候拆掉了旧的度量</td><td><b>回退</b>，改早了</td></tr>
 * </table>
 *
 * <p><b>触发条件是「使它变红的那条性质，替代品已绿」，不是「三条新基准全绿」。</b>
 * step 2 时只有第二条转绿、第一三条仍红 —— 按「全绿」那个条件会判成「回退」，
 * 而它的红明明是计划内的。使本类红的是键形状，替代品就是新基准第二条，别的两条无关。
 *
 * <p><b>那时把字面量改成 {@code CandidateKeys} 是合法的，而且理由与当初相反：</b>
 * 当初它们必须是字面量才检测得到重命名；那次检测已经完成一次，
 * 且不可能再需要 —— 生产端现在全部经 {@code CandidateKeys}，重命名已是编译期改动。
 * 一次性的角色耗尽之后，保留它只剩维护成本。
 *
 * <p>把「拆」与「回退」分开是这一段的全部意义：两种情况下本文件都是整类红的，
 * 看起来一模一样，而正确动作相反；而「删」在两种情况下都是错的。
 *
 * <h3>更正（step 2 实测后）：上面那句「必然转红」是个未经核对的前提</h3>
 *
 * <p>它假定了「候选行的 {@code sourceId} 会换成 {@code unitId}」。查过之后，
 * <b>那次重命名不会发生</b>，因为这些键名不止 {@code ContextBudgeter} 在读：
 *
 * <ul>
 *   <li>候选行被<b>整行持久化</b>成 {@code AiAgentArtifact} 的 content
 *       （AiServiceImpl.java:544-552），历史行会永远留着旧键名；</li>
 *   <li>同一行的 {@code sourceType} / {@code sourceId} 还被抽成
 *       {@code AiAgentEvidence} 的两个列（AiServiceImpl.java:558-559）；</li>
 *   <li>前端按名字读它们（assets/zhiqu-api.js:2313、:2489）—— 改名要连带
 *       14 个页面与 service worker 的 {@code ?v=} 令牌一起动。</li>
 * </ul>
 *
 * <p>所以 step 3 的形状是：键名不动，{@code sourceType} 的<b>取值域</b>加进 {@code WIKI_PAGE}。
 * 于是本类的「检测键名改动」这个一次性角色<b>不会被触发</b>，7 处字面量也就不会耗尽。
 *
 * <p><b>这不推翻退休判据，反而是它起作用的样子：</b>判据锚在因果上
 * （「使它变红的那条性质，替代品已绿」），因不发生则果不发生，什么都不必做。
 * 若当初把它锚成「step 2 到了就拆」，此刻就会在没有任何原因的情况下执行一次退休，
 * 把上表第二行那个<b>没有替代品</b>的角色一起丢掉。
 *
 * <p>留下的是一个诚实的代价：7 处字面量此刻是<b>为一个可能永远不来的事件</b>留的。
 * 不删 —— 它们的成本是每次改夹具时多打几个字，而它们挡的是一次没有其他判据能挡的改动。
 *
 * <p><b>写在重构之前，用来钉住当前行为。</b>投影表改造会把 {@code SourceScopeResolver} 的返回类型
 * 换成 ScopeSelection，进而影响每一行的 {@code sourceType} / {@code sourceId} / {@code chunkId}
 * 取值口径。这三个字段不经过类型系统，却决定了三件事：
 *
 * <ol>
 *   <li><b>去重键</b> {@code sourceType:sourceId:(chunkId ?? chunkIndex)} —— 口径一变，
 *       要么过度去重（上下文被吞），要么去重失效（重复内容吃掉预算）。两种都不报错。</li>
 *   <li><b>effectiveSourceCount</b> = {@code max(sourceCount, distinct(sourceKey))} ——
 *       它驱动每源配额的节流点。distinct 数一变，选出来的行跟着变。</li>
 *   <li><b>显式行 round-robin</b> —— {@code selectedWikiPageIds} 的「保底」语义挂在这条上，
 *       分组依据同样是 sourceKey。</li>
 * </ol>
 *
 * <p>因此断言的形状是**逐位固定有序三元组列表**，而不是「返回了结果」。顺序也必须钉：
 * 它决定预算耗尽时谁被截掉。
 *
 * <p><b>这条测试在整个重构过程中必须一行未改且保持绿。</b>若要改断言才能变绿，
 * 说明那次改动不再是纯重构，必须先说清改的是什么、为什么。
 */
class ContextBudgeterCharacterizationTest {

    /**
     * 混合场景：显式 Wiki 页 + 显式附件 + 两个 Notebook 资料的向量行 + 重复行 + 非显式补充。
     * 一次性覆盖去重、每源配额、显式轮转三条机制的相互作用。
     */
    @Test
    void 混合候选下选中行的类型来源与分块三元组被逐位钉死() {
        RagProperties properties = new RagProperties();
        properties.setFinalK(8);
        properties.setMaxPerSource(3);
        properties.setMaxContextChars(10000);
        ContextBudgeter budgeter = new ContextBudgeter(properties);

        // 显式补充：两个 Wiki 页各一段 + 一个 Notebook 附件两段。
        // 轮转按 sourceKey 首次出现顺序分组，因此期望是 wiki7 → wiki8 → src1 → src1。
        List<Map<String, Object>> supplements = new ArrayList<>();
        supplements.add(explicit(wikiRow(7, 70, "wiki 七")));
        supplements.add(explicit(wikiRow(8, 80, "wiki 八")));
        supplements.add(explicit(sourceRow(1, 11, "附件一段")));
        supplements.add(explicit(sourceRow(1, 12, "附件二段")));
        // 非显式补充排在全部向量行之后
        supplements.add(sourceRow(3, 31, "legacy 兜底"));

        // 向量行：资料 1 四段（会撞每源配额 3）、资料 2 两段，外加一条与首行完全同键的重复行
        List<Map<String, Object>> preferred = new ArrayList<>();
        preferred.add(sourceRow(1, 11, "向量 1-11 与显式附件同键"));
        preferred.add(sourceRow(1, 13, "向量 1-13"));
        preferred.add(sourceRow(1, 14, "向量 1-14"));
        preferred.add(sourceRow(1, 15, "向量 1-15"));
        preferred.add(sourceRow(2, 21, "向量 2-21"));
        preferred.add(sourceRow(2, 21, "向量 2-21 重复"));
        preferred.add(sourceRow(2, 22, "向量 2-22"));

        List<Map<String, Object>> selected = budgeter.select(preferred, supplements, 2);

        assertEquals(
                List.of(
                        "WIKI_PAGE:wiki:7:70",
                        "WIKI_PAGE:wiki:8:80",
                        "TEXT:1:11",
                        "TEXT:1:12",
                        "TEXT:1:13",
                        "TEXT:2:21",
                        "TEXT:2:22",
                        "TEXT:3:31"),
                triples(selected),
                "选中行的 (sourceType, sourceId, chunkId) 有序列表发生了变化。"
                        + "若这是重构，说明字段取值口径漂了；若这是有意的行为变更，请在提交说明里讲清楚");
    }

    /**
     * 单一来源时每源配额不生效（{@code effectiveSourceCount > 1} 才节流）。
     * 这条把「distinct(sourceKey) 计数」的边界钉住——投影表改造若让同一份资料
     * 产生两个不同的 sourceKey，本条会立刻红。
     */
    @Test
    void 单一来源时不触发每源配额() {
        RagProperties properties = new RagProperties();
        properties.setFinalK(8);
        properties.setMaxPerSource(2);
        properties.setMaxContextChars(10000);
        ContextBudgeter budgeter = new ContextBudgeter(properties);

        List<Map<String, Object>> preferred = List.of(
                sourceRow(1, 11, "一"),
                sourceRow(1, 12, "二"),
                sourceRow(1, 13, "三"),
                sourceRow(1, 14, "四"));

        List<Map<String, Object>> selected = budgeter.select(preferred, List.of(), 1);

        assertEquals(List.of("TEXT:1:11", "TEXT:1:12", "TEXT:1:13", "TEXT:1:14"), triples(selected),
                "sourceCount=1 且只有一个 distinct sourceKey 时，maxPerSource 不应生效");
    }

    /**
     * <b>sourceType 是去重键里的承重构件。</b>
     *
     * <p>今天 Wiki 行发的是 {@code "wiki:" + pageId}（String），资料行发的是裸 Long，
     * 所以 sourceId 本身就全局互不相同，sourceType 在键里「碰巧」不起作用——
     * 这会让只钉常规场景的特征化测试对「键里丢掉 sourceType」这类改动完全无感。
     *
     * <p>本条用同 sourceId、同 chunkId、不同 sourceType 的两行把它逼出来：
     * 当前实现下两行都应保留。若投影表改造让 Wiki 改发裸 refId，而键又不含 sourceType，
     * 资料 7 与 Wiki 页 7 就会互相吞掉——这正是 unit_id 设计要根除的跨命名空间撞车。
     */
    @Test
    void 同sourceId不同sourceType的两行不得互相去重() {
        RagProperties properties = new RagProperties();
        properties.setFinalK(8);
        properties.setMaxPerSource(1);
        properties.setMaxContextChars(10000);
        ContextBudgeter budgeter = new ContextBudgeter(properties);

        Map<String, Object> notebook = sourceRow(7, 70, "资料 7 的第 70 块");
        Map<String, Object> wiki = new LinkedHashMap<>(notebook);
        wiki.put("sourceType", "WIKI_PAGE");
        wiki.put("content", "Wiki 页 7 的第 70 块");
        // 第三行与第一行同 sourceKey（TEXT:7）。它今天必然被 maxPerSource=1 挤掉——
        // 期望列表里「它不在」这件事，就是配额闸门确实开着的证据。
        // 这样一来 select() 的第三个实参不再是隐形承重件：把它改小成 1 会让闸门整个关掉，
        // 第三行随之出现在结果里，本条立刻红。
        Map<String, Object> sameSource = sourceRow(7, 71, "资料 7 的第 71 块");

        List<Map<String, Object>> selected =
                budgeter.select(List.of(notebook, wiki, sameSource), List.of(), 2);

        assertEquals(List.of("TEXT:7:70", "WIKI_PAGE:7:70"), triples(selected),
                "三条性质同时钉在这一个期望上："
                        + "① TEXT:7:70 与 WIKI_PAGE:7:70 都在 → sourceType 参与去重键；"
                        + "② 第二行未被配额挤掉 → sourceType 也参与 sourceKey 分组；"
                        + "③ TEXT:7:71 被挤掉 → 配额闸门确实开着（sourceCount 实参 ≥ 2）");
    }

    /** 去重键退化到 chunkIndex 的分支（向量行没有 chunkId 时）。 */
    @Test
    void 缺少chunkId时去重键退化到chunkIndex() {
        RagProperties properties = new RagProperties();
        properties.setFinalK(8);
        properties.setMaxPerSource(9);
        properties.setMaxContextChars(10000);
        ContextBudgeter budgeter = new ContextBudgeter(properties);

        Map<String, Object> first = sourceRow(1, 11, "有 chunkId");
        Map<String, Object> noChunkIdA = sourceRow(1, 11, "无 chunkId A");
        noChunkIdA.remove("chunkId");
        noChunkIdA.put("chunkIndex", 5);
        Map<String, Object> noChunkIdB = sourceRow(1, 11, "无 chunkId B 同 index");
        noChunkIdB.remove("chunkId");
        noChunkIdB.put("chunkIndex", 5);

        List<Map<String, Object>> selected =
                budgeter.select(List.of(first, noChunkIdA, noChunkIdB), List.of(), 1);

        assertEquals(List.of("TEXT:1:11", "TEXT:1:5"), triples(selected),
                "有 chunkId 时用 chunkId，缺失时退化到 chunkIndex；同 index 的两行应被去重");
    }

    private List<String> triples(List<Map<String, Object>> rows) {
        return rows.stream()
                .map(row -> row.getOrDefault("sourceType", "") + ":"
                        + row.getOrDefault("sourceId", "") + ":"
                        + row.getOrDefault("chunkId", row.getOrDefault("chunkIndex", "")))
                .toList();
    }

    /** Notebook 资料的向量行：sourceId 是 Long，sourceType 取自 AiNotebookSource.sourceType。 */
    private Map<String, Object> sourceRow(long sourceId, long chunkId, String content) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("sourceId", sourceId);
        row.put("sourceType", "TEXT");
        row.put("chunkId", chunkId);
        row.put("chunkIndex", 0);
        row.put("content", content);
        return row;
    }

    /** Wiki 行：sourceId 是 "wiki:{pageId}" 形态的 String——这个口径本身也在钉住范围内。 */
    private Map<String, Object> wikiRow(long pageId, long chunkId, String content) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("sourceId", "wiki:" + pageId);
        row.put("sourceType", "WIKI_PAGE");
        row.put("chunkId", chunkId);
        row.put("content", content);
        return row;
    }

    private Map<String, Object> explicit(Map<String, Object> row) {
        row.put("_explicit", true);
        return row;
    }
}
