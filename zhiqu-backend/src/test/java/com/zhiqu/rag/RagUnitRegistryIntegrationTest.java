package com.zhiqu.rag;

import com.zhiqu.entity.RagIndexableUnit;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import com.zhiqu.mapper.RagIndexableUnitMapper;
import com.zhiqu.mapper.RagUnitChunkMapper;
import com.zhiqu.mapper.UserKnowledgePageMapper;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 投影表注册与对账的特征化测试。
 *
 * <p>本类声称钉住四条性质，因此配四次扰动验证（见提交说明）：
 * <ol>
 *   <li><b>回读需 {@code ref_id} 且 {@code user_id}</b> —— 去掉归属条件就能读到别人的页；</li>
 *   <li><b>解密失败标 SKIPPED 且不中断整批</b> —— 一页坏密文不能拖垮同批的好页；</li>
 *   <li><b>非解密异常不得被记成 SKIPPED</b> —— 它必须逃出对账循环；</li>
 *   <li><b>软删页转 RETIRED 而非 SKIPPED</b> —— 两者的后果相反。</li>
 * </ol>
 *
 * <p>第三条最容易被漏，因为它断言的是「某件事<b>没有</b>发生」：实现写对时它绿，
 * 实现写错成 {@code catch (Exception)} 时它<b>也绿</b>（异常被吞了，测试只看到一个跳过计数），
 * 除非专门去扰动。它的严重性在于与跳过率门禁的乘积 —— {@code max-skipped-ratio: 0.05}
 * 意味着每 20 个单元可以藏一个静默失败而代次照常 READY。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class RagUnitRegistryIntegrationTest {
    static {
        System.setProperty("api.version", System.getProperty("api.version", "1.40"));
    }

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_unit_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;
    @Autowired private RagUnitRegistry registry;
    @Autowired private WikiPageContentProvider wikiProvider;
    @Autowired private SensitiveCryptoService crypto;
    @Autowired private RagIndexableUnitMapper unitMapper;
    @Autowired private RagUnitChunkMapper chunkMapper;
    @Autowired private AiNotebookSourceMapper sourceMapper;
    @Autowired private UserKnowledgePageMapper pageMapper;
    @Autowired private RagUnitChunker chunker;
    @Autowired private RagContentHashService hashService;
    @Autowired private TransactionTemplate transactions;

    private Long ownerId;
    private Long strangerId;

    @BeforeEach
    void prepare() {
        // 这些用例共享同一测试库，投影行会跨用例累积并让 report 的计数互相污染。
        jdbc.update("DELETE FROM rag_unit_chunk");
        jdbc.update("DELETE FROM rag_indexable_unit");
        jdbc.update("DELETE FROM ai_source_chunk");
        jdbc.update("UPDATE user_knowledge_page SET deleted=1");
        jdbc.update("UPDATE ai_notebook_source SET deleted=1");
        jdbc.update("UPDATE ai_notebook SET deleted=1");
        ownerId = createUser("owner");
        strangerId = createUser("stranger");
    }

    // ── 性质 1：回读需 ref_id 且 user_id ──────────────────────────────────

    /**
     * 投影行是异步写进去的，与当前请求的登录态无关。只按 {@code ref_id} 回读的话，
     * 任何一次写错归属的注册都会变成「把别人的 Wiki 正文喂进模型上下文」——
     * 而这条链路上没有第二层会拦住它。
     */
    @Test
    void 回读必须同时匹配引用id与归属用户() {
        Long pageId = createWikiPage(ownerId, "机密复习计划", "只有本人能看到的正文");

        RagIndexableUnit forged = new RagIndexableUnit();
        forged.setId(-1L);
        forged.setNamespace(RagNamespace.WIKI_PAGE);
        forged.setRefId(pageId);
        forged.setUserId(strangerId);   // 归属写错/被伪造

        UnitContent content = wikiProvider.load(forged);

        assertEquals(UnitContent.Outcome.GONE, content.outcome(),
                "按 ref_id + user_id 双条件回读时，别人的页必须查不到。"
                        + "这里若返回 OK，说明 user_id 条件被去掉了，正文会跨用户泄漏");
        assertNull(content.canonicalText());
    }

    /** 反面：归属正确时必须真的读得到，否则上一条可能是被某种「永远 GONE」的实现骗过的。 */
    @Test
    void 归属正确时回读得到规范化全文() {
        Long pageId = createWikiPage(ownerId, "机密复习计划", "只有本人能看到的正文");

        RagIndexableUnit real = new RagIndexableUnit();
        real.setNamespace(RagNamespace.WIKI_PAGE);
        real.setRefId(pageId);
        real.setUserId(ownerId);

        UnitContent content = wikiProvider.load(real);
        assertEquals(UnitContent.Outcome.OK, content.outcome());
        assertEquals(CanonicalText.wiki("机密复习计划", "只有本人能看到的正文"), content.canonicalText());
    }

    // ── 性质 2：解密失败标 SKIPPED，不中断整批 ────────────────────────────

    @Test
    void 坏密文只跳过该页而不拖垮整批() {
        Long goodBefore = createWikiPage(ownerId, "高数复习", "第一章 极限");
        Long broken = createWikiPageWithRawContent(ownerId, "损坏的页", "v1:Zm9v:YmFy");   // 能过前缀判断，解不开
        Long goodAfter = createWikiPage(ownerId, "线代复习", "第二章 矩阵");

        RagUnitRegistry.ReconcileReport report = registry.reconcileAll();

        assertEquals(RagNamespace.STATUS_SKIPPED, statusOf(RagNamespace.WIKI_PAGE, broken));
        assertEquals("DECRYPT_FAILED", indexErrorOf(RagNamespace.WIKI_PAGE, broken));
        assertEquals(1, report.skipped);

        // 整批没被拖垮：坏页两侧的好页都照常入了投影，而不是「批处理在中间断掉」。
        assertEquals(RagNamespace.STATUS_READY, statusOf(RagNamespace.WIKI_PAGE, goodBefore));
        assertEquals(RagNamespace.STATUS_READY, statusOf(RagNamespace.WIKI_PAGE, goodAfter));
        assertTrue(chunkCountOf(RagNamespace.WIKI_PAGE, goodAfter) > 0);

        // 不变量：切分边界只在 READY 单元上存在。
        assertEquals(0, chunkCountOf(RagNamespace.WIKI_PAGE, broken));
        assertNull(canonicalHashOf(RagNamespace.WIKI_PAGE, broken),
                "跳过时必须清空哈希，否则解密恢复后新内容会与旧哈希比对成「没变」，这页永远停在 SKIPPED");
    }

    // ── 性质 3：非解密异常不得被记成 SKIPPED ──────────────────────────────

    /**
     * <b>这条断言的是「某件事没有发生」。</b>把 {@code reconcileAll} 里的
     * {@code resolver.load} 包进 {@code catch (Exception e) { markSkipped(...); }}，
     * 本类其余用例全部照常绿 —— 只有这条会红。
     *
     * <p>为什么值得单独写：{@code max-skipped-ratio: 0.05} 是按「数据质量」定的阈值。
     * 一旦实现缺陷也能被计成跳过，这个阈值就变成了「每 20 个单元允许藏一个 bug」的许可，
     * 而代次照常转 READY、没有任何告警。
     */
    @Test
    void 非解密异常必须逃出对账循环且不被计成跳过() {
        createWikiPage(ownerId, "高数复习", "第一章 极限");

        UnitContentProvider exploding = new UnitContentProvider() {
            @Override public String namespace() { return RagNamespace.WIKI_PAGE; }
            @Override public UnitContent load(RagIndexableUnit unit) {
                throw new IllegalStateException("模拟实现缺陷：不是解密失败");
            }
        };
        RagUnitRegistry isolated = new RagUnitRegistry(unitMapper, chunkMapper, sourceMapper, pageMapper,
                new UnitContentResolver(List.of(exploding)), chunker, hashService, transactions);

        assertThrows(IllegalStateException.class, isolated::reconcileAll,
                "非解密异常必须逃出对账循环。被吞掉的话它会被记成一次「跳过」，"
                        + "低于跳过率门禁时代次照常 READY —— 门禁从数据质量信号变成 bug 藏身处");

        Integer skipped = jdbc.queryForObject(
                "SELECT COUNT(*) FROM rag_indexable_unit WHERE status='SKIPPED'", Integer.class);
        assertEquals(0, skipped, "实现缺陷不得留下 SKIPPED 痕迹——那会把 bug 伪装成数据质量问题");
    }

    // ── 性质 4：软删页转 RETIRED 而非 SKIPPED ─────────────────────────────

    /**
     * 「页面被删了」与「页面还在但读不出来」后果相反，不能混成一类：
     * 当成 SKIPPED 的话，软删页的向量<b>永远不会被清理</b>，用户以为删掉的内容
     * 还能被检索到，而 {@code status} 列上看不出任何问题。
     */
    @Test
    void 软删页转退役而非跳过并清掉切分边界() {
        Long pageId = createWikiPage(ownerId, "临时草稿", "写完就删");
        registry.reconcileAll();
        assertEquals(RagNamespace.STATUS_READY, statusOf(RagNamespace.WIKI_PAGE, pageId));
        assertTrue(chunkCountOf(RagNamespace.WIKI_PAGE, pageId) > 0, "前提：退役前必须真的有切分边界");

        jdbc.update("UPDATE user_knowledge_page SET deleted=1 WHERE id=?", pageId);
        RagUnitRegistry.ReconcileReport report = registry.reconcileAll();

        assertEquals(RagNamespace.STATUS_RETIRED, statusOf(RagNamespace.WIKI_PAGE, pageId),
                "软删页必须转 RETIRED 才会触发向量清理；转 SKIPPED 会让删掉的内容一直可被检索到");
        assertEquals(1, report.retired());
        assertEquals(List.of(unitIdOf(RagNamespace.WIKI_PAGE, pageId)), report.retiredUnitIds,
                "退役的 unit id 必须作为有类型的输出返回——调用方据此入队 DELETE_UNIT，"
                        + "而不是去反查 status='RETIRED' AND index_status='INDEXED' 这个隐式组合");
        assertEquals(0, report.skipped, "删除不是跳过——混进跳过率会污染门禁的分子");
        assertEquals(0, chunkCountOf(RagNamespace.WIKI_PAGE, pageId));
    }

    // ── 归属校验在写入侧（三步静默链的入口）────────────────────────────────

    /**
     * 归属为空必须在<b>写入侧</b>当场抛出。
     *
     * <p><b>这条用例直接调 {@code ensureRow}，而不是经某个公开入口 —— 刻意的。</b>
     * 1c 删掉了 {@code upsertWikiUnit} / {@code upsertNotebookUnit}（补登记之后它们零生产调用方），
     * 而这条性质并没有跟着死：{@code ensureRow} 仍被 {@code ensureRegistered} 与
     * {@code reconcileAll} 走到。若当时顺手把这条断言一起删了，
     * {@code requireOwner} 会继续活着且从此无人验证 ——
     * 「删死代码顺带删掉活代码的测试覆盖」，而 {@code RagOperationCoverageTest}
     * 那套看的是作业词表，看不到这种形状。
     *
     * <p>今天两条 DB 路径都喂不出空 userId（{@code user_knowledge_page.user_id} 与
     * {@code ai_notebook_source.user_id} 都是 NOT NULL），所以这道闸门防的是<b>将来</b>
     * 从 {@code SecurityContext} 取归属的写法 —— 那在异步 worker 线程里恒为空。
     * 正因为构造不出真实的 DB 触发路径，才更要在写入侧这一层直接钉住它。
     */
    @Test
    void 注册时归属为空必须当场抛出() {
        com.zhiqu.entity.UserKnowledgePage detached = new com.zhiqu.entity.UserKnowledgePage();
        detached.setId(9999L);
        detached.setUserId(null);
        detached.setTitle("没有归属的页");
        detached.setPageType("NOTE");

        assertThrows(IllegalStateException.class, () -> registry.ensureRow(detached),
                "归属必须在写入侧断言。放行的话会走成三步静默链："
                        + "双条件回读命中 0 行 → 记 SKIPPED → 低于门禁 → 代次照常 READY");
    }

    /** 系统页（含 GUIDE）不入索引：GUIDE 每轮逐字注入提示词，再索引一遍等于重复计数。 */
    @Test
    void 系统页不入索引且既有单元会被退役() {
        Long pageId = createWikiPage(ownerId, "普通笔记", "正文");
        registry.reconcileAll();
        assertEquals(RagNamespace.STATUS_READY, statusOf(RagNamespace.WIKI_PAGE, pageId));

        jdbc.update("UPDATE user_knowledge_page SET page_type='GUIDE' WHERE id=?", pageId);
        registry.reconcileAll();

        assertEquals(RagNamespace.STATUS_RETIRED, statusOf(RagNamespace.WIKI_PAGE, pageId));
        assertEquals(0, chunkCountOf(RagNamespace.WIKI_PAGE, pageId));
    }

    // ── Notebook：行为不变的两条支点 ──────────────────────────────────────

    /**
     * <b>「1B-1 是纯重构」这句话的全部依据就是这条等式。</b>
     *
     * <p>生产写 {@code ai_notebook_source.content_hash} 的那一行是
     * {@code AiWorkspaceServiceImpl:912} → {@code hashChunkTexts(texts)} =
     * sha256({@code String.join(SEP, texts)})；而投影侧是
     * {@code CanonicalText.notebook(texts)} = {@code String.join(SEP, texts)} 再 sha256。
     * 两者逐字节相等 —— 这正是存量资料<b>不会</b>被重建的原因。
     *
     * <p>不相等的后果不是报错：每份存量资料都会被判定「内容变了」，触发一次没人要求的
     * 全量重建，烧掉全部 embedding 配额，而每一处代码单看都合理。
     */
    @Test
    void notebook单元的规范化哈希与资料内容哈希逐字节相等() {
        List<String> parentChunks = List.of("第一章 极限与连续", "第二章 导数与微分", "第三章 积分🚀");
        Long sourceId = createNotebookSource(ownerId, "高数讲义.pdf", parentChunks);

        String productionHash = hashService.hashChunkTexts(parentChunks);
        jdbc.update("UPDATE ai_notebook_source SET content_hash=? WHERE id=?", productionHash, sourceId);

        registry.reconcileAll();

        assertEquals(productionHash, canonicalHashOf(RagNamespace.NOTEBOOK_SOURCE, sourceId),
                "投影的 canonical_hash 必须与 ai_notebook_source.content_hash 逐字节相等。"
                        + "不等则每份存量资料都会被判成「内容变了」并触发一次全量重建");
    }

    /**
     * Notebook <b>不重新分块</b>：复用 {@code ai_source_chunk} 的既有父块边界。
     *
     * <p>样本刻意让其中一个父块长达 3000 code point —— 超过 {@code RagUnitChunker} 的硬上限
     * 2000。若哪天忽略了 {@code presetChunks} 改走通用分块器，那一块会被拆成两块，
     * 块数从 3 变成 4 以上，本条立刻红。用短父块构造的话分块器碰巧也切成 3 块，
     * 这条就恒真、白写了（同 filler=1198 的教训）。
     */
    @Test
    void notebook复用父块边界而不重新分块() {
        String oversized = "长".repeat(3000);
        List<String> parentChunks = List.of("短块甲", oversized, "短块乙");
        Long sourceId = createNotebookSource(ownerId, "超长讲义.pdf", parentChunks);

        assertTrue(chunker.chunk(oversized).size() > 1,
                "样本构造前提：该父块必须超过分块器硬上限，否则重新分块与复用边界结果相同、本条测不出差别");

        registry.reconcileAll();

        assertEquals(3, chunkCountOf(RagNamespace.NOTEBOOK_SOURCE, sourceId),
                "块数必须等于父块数。变多说明走了通用分块器，全部存量资料的边界会跟着变");

        // 每块的 content_hash 必须等于对应父块正文的哈希——这不是同义反复：
        // 左边来自库里的行，右边来自我们手上的原始父块文本，两者独立。
        Long unitId = ((Number) unitRow(RagNamespace.NOTEBOOK_SOURCE, sourceId).get("id")).longValue();
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT chunk_index, content_hash FROM rag_unit_chunk WHERE unit_id=? ORDER BY chunk_index", unitId);
        for (int i = 0; i < parentChunks.size(); i++) {
            assertEquals(hashService.hashCanonicalText(parentChunks.get(i)),
                    String.valueOf(rows.get(i).get("content_hash")),
                    "第 " + i + " 块的边界没有落在父块上");
        }
    }

    // ── 刻意选择「抛异常」而不是「降级」的三处 ────────────────────────────

    /**
     * 同一个 {@code (namespace, ref_id)} 换了归属必须抛出。
     *
     * <p>触发路径从「构造一个改了 userId 的实体传给公开入口」换成「改库里的行再跑对账」——
     * 后者才是真实形态（主键被复用，或某条注册路径写错了 user_id），
     * 而且它不依赖 1c 删掉的那两个入口。
     */
    @Test
    void 换归属必须抛出而不是以新值为准() {
        Long pageId = createWikiPage(ownerId, "复习计划", "正文");
        registry.reconcileAll();

        jdbc.update("UPDATE user_knowledge_page SET user_id=? WHERE id=?", strangerId, pageId);

        assertThrows(IllegalStateException.class, () -> registry.reconcileAll(),
                "「以新值为准」等于把一份内容的向量交给另一个用户");
        assertEquals(ownerId, ((Number) unitRow(RagNamespace.WIKI_PAGE, pageId).get("user_id")).longValue());
    }

    @Test
    void 同一命名空间注册两个provider必须抛出() {
        UnitContentProvider first = stubProvider(RagNamespace.WIKI_PAGE);
        UnitContentProvider second = stubProvider(RagNamespace.WIKI_PAGE);

        assertThrows(IllegalStateException.class, () -> new UnitContentResolver(List.of(first, second)),
                "哪个生效取决于 bean 顺序；两者算出的 canonical_hash 一旦不同，该命名空间会被无限重建");
    }

    /**
     * 缺 provider 必须抛出，<b>不能降级成 GONE</b>。
     *
     * <p>降级的后果是一批完好的单元被静默退役并删掉向量 —— 而「这版代码还不支持该命名空间」
     * 和「这些内容没了」是完全不同的两件事。
     */
    @Test
    void 缺少provider必须抛出而不是当成已消失() {
        UnitContentResolver onlyNotebook = new UnitContentResolver(List.of(stubProvider(RagNamespace.NOTEBOOK_SOURCE)));

        RagIndexableUnit wikiUnit = new RagIndexableUnit();
        wikiUnit.setId(1L);
        wikiUnit.setNamespace(RagNamespace.WIKI_PAGE);
        wikiUnit.setRefId(1L);
        wikiUnit.setUserId(ownerId);

        assertThrows(IllegalStateException.class, () -> onlyNotebook.load(wikiUnit),
                "降级成 GONE 会让一批完好单元被静默退役并删向量");
    }

    // ── 系统页：类型与标题两个锚点 ────────────────────────────────────────

    /**
     * {@code page_type} 不可信 —— 知识库自己的代码就是这么说的
     * （{@code isSystemKnowledgePage} 在类型之外还看标题，注释写着「pageType 可能被历史请求改坏」）。
     *
     * <p>只按类型排除的话，一个 {@code page_type='NOTE'}、标题为 {@code index} 的页会被
     * 知识库当系统页保护（不许改名/移动/删除），却<b>照常被索引</b>。而 {@code index} 是
     * 自动生成的全站标题目录，几乎能命中任何查询、挤掉真正的检索结果 ——
     * 与 GUIDE 被排除的理由是同一件事。
     */
    @Test
    void 标题是保留系统页标题的页不入索引即使类型是普通笔记() {
        Long disguised = createWikiPage(ownerId, "index", "# 全站目录\n- 页面甲\n- 页面乙");
        Long normal = createWikiPage(ownerId, "我的复习计划", "正文");

        registry.reconcileAll();

        Integer projected = jdbc.queryForObject(
                "SELECT COUNT(*) FROM rag_indexable_unit WHERE namespace=? AND ref_id=?",
                Integer.class, RagNamespace.WIKI_PAGE, disguised);
        assertEquals(0, projected,
                "标题为 index 的页不得进入索引：知识库已把它当系统页保护，"
                        + "而它是全站标题目录、几乎命中任何查询");
        assertEquals(RagNamespace.STATUS_READY, statusOf(RagNamespace.WIKI_PAGE, normal),
                "普通页不受影响——否则上一条可能是被某种「全都排除」的实现骗过的");
    }

    /** 保留标题的判定必须与知识库共用一份定义，不是各写一份词表。 */
    @Test
    void 保留标题词表全仓只有一份() {
        for (String title : com.zhiqu.common.SystemPageTitles.RESERVED) {
            assertTrue(RagNamespace.isExcludedWikiPage("NOTE", title),
                    "保留标题 " + title + " 未被 RAG 排除，两份定义已分叉");
        }
        assertTrue(RagNamespace.isExcludedWikiPage("NOTE", "  INDEX  "), "trim 与大小写规则必须一并复用");
        assertTrue(RagNamespace.isExcludedWikiPage("GUIDE", "学习守则"), "GUIDE 按类型排除");
        // 反方向的不对称是有意的：GUIDE 不进保留标题集合，否则等于给它装回标题锚点并封死改名。
        assertTrue(!com.zhiqu.common.SystemPageTitles.matches("学习守则"),
                "「学习守则」不得进入保留标题集合——那会封死用户对 GUIDE 页的改名");
    }

    // ── 工具 ────────────────────────────────────────────────────────────

    private UnitContentProvider stubProvider(String namespace) {
        return new UnitContentProvider() {
            @Override public String namespace() { return namespace; }
            @Override public UnitContent load(RagIndexableUnit unit) { return UnitContent.gone("STUB"); }
        };
    }

    private Long createNotebookSource(Long userId, String title, List<String> parentChunks) {
        jdbc.update("INSERT INTO ai_notebook(user_id,title,status,deleted) VALUES(?,?,'ACTIVE',0)", userId, "对账用 Notebook");
        Long notebookId = jdbc.queryForObject(
                "SELECT id FROM ai_notebook WHERE user_id=? ORDER BY id DESC LIMIT 1", Long.class, userId);
        jdbc.update("INSERT INTO ai_notebook_source(user_id,notebook_id,source_type,title,status,index_status,deleted) " +
                "VALUES(?,?,'TEXT',?,'READY','NOT_INDEXED',0)", userId, notebookId, title);
        Long sourceId = jdbc.queryForObject(
                "SELECT id FROM ai_notebook_source WHERE notebook_id=? ORDER BY id DESC LIMIT 1", Long.class, notebookId);
        for (int i = 0; i < parentChunks.size(); i++) {
            jdbc.update("INSERT INTO ai_source_chunk(source_id,chunk_index,content) VALUES(?,?,?)",
                    sourceId, i, parentChunks.get(i));
        }
        return sourceId;
    }

    private Long createUser(String prefix) {
        String username = prefix + "_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES(?,?,?,'USER',0)",
                username, "test-password", prefix);
        return jdbc.queryForObject("SELECT id FROM sys_user WHERE username=?", Long.class, username);
    }

    private Long createWikiPage(Long userId, String title, String body) {
        return createWikiPageWithRawContent(userId, title, crypto.encrypt(body));
    }

    private Long createWikiPageWithRawContent(Long userId, String title, String storedContent) {
        jdbc.update("INSERT INTO user_knowledge_page(user_id,page_type,title,encrypted_content," +
                        "encryption_version,version,sort_order,pinned,deleted) " +
                        "VALUES(?,'NOTE',?,?,'v1',0,0,0,0)",
                userId, title, storedContent);
        return jdbc.queryForObject("SELECT id FROM user_knowledge_page WHERE user_id=? ORDER BY id DESC LIMIT 1",
                Long.class, userId);
    }

    private Map<String, Object> unitRow(String namespace, Long refId) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT * FROM rag_indexable_unit WHERE namespace=? AND ref_id=?", namespace, refId);
        assertEquals(1, rows.size(), "投影行应当恰好一条：" + namespace + "#" + refId);
        return rows.get(0);
    }

    private Long unitIdOf(String namespace, Long refId) {
        return ((Number) unitRow(namespace, refId).get("id")).longValue();
    }

    private String statusOf(String namespace, Long refId) {
        return String.valueOf(unitRow(namespace, refId).get("status"));
    }

    private String indexErrorOf(String namespace, Long refId) {
        Object value = unitRow(namespace, refId).get("index_error");
        return value == null ? null : String.valueOf(value);
    }

    private String canonicalHashOf(String namespace, Long refId) {
        Object value = unitRow(namespace, refId).get("canonical_hash");
        return value == null ? null : String.valueOf(value);
    }

    private int chunkCountOf(String namespace, Long refId) {
        Long unitId = ((Number) unitRow(namespace, refId).get("id")).longValue();
        Integer rows = jdbc.queryForObject("SELECT COUNT(*) FROM rag_unit_chunk WHERE unit_id=?", Integer.class, unitId);
        assertNotNull(rows);
        // chunk_count 列与实际行数必须一致，否则进度核算会按一个不存在的分母算覆盖率
        Integer declared = ((Number) unitRow(namespace, refId).get("chunk_count")).intValue();
        assertEquals(rows, declared, "chunk_count 列与 rag_unit_chunk 实际行数不一致");
        return rows;
    }
}

// ── 入口删除前的覆盖迁移（2026-08-08 实测）────────────────────────────────
//
// 1c 删掉了 upsertNotebookUnit / upsertWikiUnit：补登记（ensureRegistered）落地后
// 它们的职能被完全吸收，只剩测试在调 —— 与 DELETE_INDEX_VERSION 同一种形状。
//
// **删之前先迁移覆盖，顺序不能反。**这两条断言钉的是仍然活着的性质
// （requireOwner 空归属抛出、(namespace, ref_id) 换归属被拒），
// 只是此前经一个即将死掉的入口被测到。直接删入口，断言会跟着消失，
// 而 requireOwner 继续活着且从此无人验证 ——「删死代码顺带删掉活代码的测试覆盖」。
// RagOperationCoverageTest 看的是作业词表的生产端，看不到「公开方法只有测试在调」这种形状。
//
//   H3  requireOwner 不再拒绝空 userId              RED
//   H4  换归属改成「以新值为准」                     RED
//
// 迁移后的触达路径：H3 直接调包内可见的 ensureRow（两张源表的 user_id 都是 NOT NULL，
// 构造不出真实 DB 触发路径，闸门防的是将来从 SecurityContext 取归属的写法）；
// H4 改库里的行再跑 reconcileAll，比原来构造一个改了 userId 的实体更贴近真实形态。
//
// ── 归属闸门的定义域修正（2026-08-08）────────────────────────────────────
//
//   I1  从本类之外传一个游离的 userId 给 ensureRow   COMPILE-FAIL ✓（实测）
//
// 原注释声称这道检查关掉了「三步静默链」。**它没有 —— 而且那条链本身就记错了。**
// rag_indexable_unit.user_id 是 BIGINT NOT NULL（V29:19），null 走到 INSERT 会直接
// 撞约束 —— 响亮，不静默。危险输入是**非空但写错**的 userId。
//
// 而它走的不是 SKIPPED：两个 provider 双条件命中 0 行时返回 gone(...) 不是 unusable(...)
// （WikiPageContentProvider:38、NotebookSourceContentProvider:42），
// 所以形态是 GONE → RETIRED → 删切分边界 → DELETE_UNIT → 向量清理。
// **不是静默漏索引，是把一份健康数据销毁掉**，而每一步单看都是正确行为。
// 也就是说闸门在，但它和它声称防的性质定义域不同，且后果比记错的那条更重。
//
// 修法选的是消除而不是改注释：ensureRow 对外只剩两个收实体的重载，
// 游离 userId 那个签名转 private。I1 是对这条**工具链声称**的必需扰动
// ——「凡是『某件事现在不可能发生』的声称，如果依据是编译器，必须有一次尝试做那件事的扰动」。
//
// **但要说准：这是收窄，不是消除。**同一个文件里的人仍能直接调那个 private 方法，
// Java 在单个类内部没有更强的可见性。真要关死，得把「归属不匹配」从 **GONE** 里
// 分出来（不是 UNUSABLE）成第四种结局：实体还在，退役它等于拿删除去响应注册缺陷。
// 记在 docs/rag-1b2-stage-e-handoff.md，不在本轮。
