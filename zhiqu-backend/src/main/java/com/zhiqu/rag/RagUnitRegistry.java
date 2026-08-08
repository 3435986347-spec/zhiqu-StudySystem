package com.zhiqu.rag;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.entity.RagIndexableUnit;
import com.zhiqu.entity.RagUnitChunk;
import com.zhiqu.entity.UserKnowledgePage;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import com.zhiqu.mapper.RagIndexableUnitMapper;
import com.zhiqu.mapper.RagUnitChunkMapper;
import com.zhiqu.mapper.UserKnowledgePageMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.LongFunction;

/**
 * 可索引单元投影表的唯一写入口。
 *
 * <p>投影表存在的意义是把「代次展开、进度核算、启用门禁」三处各自的
 * {@code SELECT ... FROM ai_notebook_source WHERE status='READY'} 收敛成同一条查询。
 * 如果注册逻辑也散开写，收敛就只完成了一半。
 *
 * <p><b>本类不写向量、不发 sidecar 请求</b>，只维护投影行与切分边界。入队 DELETE_UNIT /
 * UPSERT_UNIT 是调用方（业务钩子与 reconcile 作业）的事。
 *
 * <p><b>{@code ref_id} 与 {@code turn_id} 的分工（Phase 3 会用到，先在此定死）：</b>
 * {@code ref_id} 是 BIGINT，对 CONVERSATION_TURN 取<b>助手消息的 id</b>；而
 * {@code ai_message.turn_id}（CHAR(32)）只用于把 user 与 assistant 两行配成一轮，
 * <b>不进投影表</b>。两者混用会很自然地写成「拿 turn_id 当 ref_id」，而 ref_id 是
 * BIGINT —— 于是 UUID 被静默截断成一个数字，不同轮次撞进同一个 (namespace, ref_id)。
 *
 * <p><b>状态更新一律走 {@link LambdaUpdateWrapper} 的显式 {@code set}，不用
 * {@code updateById(entity)}。</b>MyBatis-Plus 默认的 {@code NOT_NULL} 更新策略会跳过值为
 * null 的字段，于是 {@code setCanonicalHash(null)} 这类「清空」动作会被静默丢弃 ——
 * 单元标成了 SKIPPED，哈希却还留着旧值，下次对账拿新内容一比对判成「没变」，
 * 这页就永远停在 SKIPPED 且看起来一切正常。
 */
@Service
public class RagUnitRegistry {

    private static final Logger log = LoggerFactory.getLogger(RagUnitRegistry.class);
    private static final int RECONCILE_PAGE_SIZE = 200;
    private static final int TITLE_MAX = 200;
    private static final int SOURCE_TYPE_MAX = 40;
    private static final int ERROR_MAX = 1000;

    private final RagIndexableUnitMapper unitMapper;
    private final RagUnitChunkMapper chunkMapper;
    private final AiNotebookSourceMapper sourceMapper;
    private final UserKnowledgePageMapper pageMapper;
    private final UnitContentResolver resolver;
    private final RagUnitChunker chunker;
    private final RagContentHashService hashService;
    private final TransactionTemplate transactionTemplate;

    public RagUnitRegistry(RagIndexableUnitMapper unitMapper,
                           RagUnitChunkMapper chunkMapper,
                           AiNotebookSourceMapper sourceMapper,
                           UserKnowledgePageMapper pageMapper,
                           UnitContentResolver resolver,
                           RagUnitChunker chunker,
                           RagContentHashService hashService,
                           TransactionTemplate transactionTemplate) {
        this.unitMapper = unitMapper;
        this.chunkMapper = chunkMapper;
        this.sourceMapper = sourceMapper;
        this.pageMapper = pageMapper;
        this.resolver = resolver;
        this.chunker = chunker;
        this.hashService = hashService;
        this.transactionTemplate = transactionTemplate;
    }

    // ── 单点注册（业务钩子调用）──────────────────────────────────────────

    public RagIndexableUnit upsertNotebookUnit(AiNotebookSource source) {
        RagIndexableUnit unit = ensureRow(RagNamespace.NOTEBOOK_SOURCE, source.getId(), source.getUserId(),
                RagNamespace.SCOPE_NOTEBOOK, source.getNotebookId(), source.getTitle(), source.getSourceType());
        refresh(unit, new ReconcileReport());
        return unit;
    }

    /**
     * 注册或刷新一个 Wiki 页单元。系统页（INDEX/LOG/SCHEMA/GUIDE）不入索引 ——
     * 若它此前登记过（例如用户把普通页改成了 GUIDE），这里顺手把它退役掉，
     * 否则那份向量会一直留在库里被检索到。
     */
    public RagIndexableUnit upsertWikiUnit(UserKnowledgePage page) {
        if (isExcludedPage(page)) {
            retireUnit(RagNamespace.WIKI_PAGE, page.getId());
            return null;
        }
        RagIndexableUnit unit = ensureRow(RagNamespace.WIKI_PAGE, page.getId(), page.getUserId(),
                RagNamespace.SCOPE_WIKI_TREE, null, page.getTitle(), RagNamespace.WIKI_PAGE);
        refresh(unit, new ReconcileReport());
        return unit;
    }

    /**
     * worker 执行 {@code UPSERT_UNIT} 时的入口：<b>以投影行为准，不以作业里的快照为准。</b>
     *
     * <p>这条消除的是「删除后又被写回来」的竞态。编辑后立刻删除会排出 UPSERT 与 DELETE 两条
     * 作业，而领取走的是 {@code FOR UPDATE SKIP LOCKED} —— 多个 worker 线程可以同时拿到它们，
     * DELETE 先落、UPSERT 后落，已删页的向量就被重新写回去了。用户以为删掉的内容还能被检索到。
     *
     * <p>不靠排序解决：作业里带的是<b>发起时</b>的快照，投影行才是<b>当前</b>真相。
     * 非 READY 就直接成功返回（不是失败——删除已经赢了，这是预期结果，不该转 RETRY/DEAD）。
     *
     * @return 是否真的刷新了；false 表示单元已退役/已跳过，本次 upsert 让位
     */
    public boolean refreshUnitIfLive(String namespace, Long refId) {
        RagIndexableUnit unit = findUnit(namespace, refId);
        if (unit == null) {
            log.debug("投影行已不存在，UPSERT 让位 {}#{}", namespace, refId);
            return false;
        }
        if (!RagNamespace.STATUS_READY.equals(unit.getStatus())) {
            log.debug("投影行已是 {}，UPSERT 让位 {}#{}", unit.getStatus(), namespace, refId);
            return false;
        }
        refresh(unit, new ReconcileReport());
        return true;
    }

    /**
     * 读取某个单元的索引状态；投影行不存在时返回 {@code null}，由调用方回落到旧列。
     *
     * <p><b>存在的理由是「让写回不必发生」。</b>{@code ai_notebook_source.index_status} 目前是
     * 15 写 / 1 读：写入方散在 {@code RagIndexJobService}(8)、{@code AiWorkspaceServiceImpl}(6)、
     * {@code RagAdminService}(1)，而唯一的生产读取方是资料列表行里的一个展示字段
     * （前端拿它画一个圆点的颜色和一行文字）。给它再挂第 16 个写入方，只为让那个点变色，
     * 代价与收益不成比例 —— 而且与投影表的存在意义相反：投影是来收敛重复状态的，
     * 回写等于把刚收敛的东西再散开一次。翻转那一个读取点，新增零个写入方。
     *
     * <p><b>回落是必需的，不是防御性编程。</b>V29 只建表不填数据，投影行由
     * {@code RECONCILE_UNITS} 作业从原始表枚举；在对账跑完之前本表是空的。回落同时覆盖
     * 迁移窗口与「某份资料还没被对账到」两种情况。
     */
    public String indexStatusOf(String namespace, Long refId) {
        RagIndexableUnit unit = findUnit(namespace, refId);
        return unit == null ? null : unit.getIndexStatus();
    }

    /**
     * 索引一个单元所需的全部输入。
     *
     * <p><b>正文不落库</b> —— {@code rag_unit_chunk} 只存 {@code char_start/char_end}
     * 与哈希，这是「sidecar 永不存明文、解密只在 JVM 内」那条不变量的一部分。
     * 所以每次索引都要现取现解密，没有更便宜的路。
     */
    public record IndexableUnitSnapshot(RagIndexableUnit unit, String canonicalText,
                                        List<RagUnitChunk> chunks) {}

    /**
     * 取出可索引快照；不可索引时返回 {@code null}。
     *
     * <p><b>刻意不在这里区分三种「不可索引」</b>（投影行没了 / 不是 READY / 正文这次读不出来）：
     * 状态转换已经由 {@link #refreshUnitIfLive} 与 {@code refresh} 做过一遍，
     * 这里再判一次并写一次状态，就会出现两个都能改 {@code status} 的入口 ——
     * 而两个入口对同一件事的判断一旦分歧，谁最后写谁赢，且没有任何东西会报错。
     * 本方法只回答「现在能不能索引」，状态归属仍然只有一个写入方。
     *
     * <p>调用顺序因此是固定的：先 {@code refreshUnitIfLive}（它负责让位与状态转换），
     * 为真时再调本方法拿正文。代价是一次额外解密 —— 已知且接受，
     * 因为让 {@code refresh} 顺带把正文吐出来会把它的返回类型和职责一起撑开。
     */
    public IndexableUnitSnapshot loadForIndexing(String namespace, Long refId) {
        RagIndexableUnit unit = findUnit(namespace, refId);
        if (unit == null || !RagNamespace.STATUS_READY.equals(unit.getStatus())) return null;

        UnitContent content = resolver.load(unit);
        if (content.outcome() != UnitContent.Outcome.OK) {
            log.debug("单元 {}#{} 这次取不到正文（{}），跳过索引", namespace, refId, content.reason());
            return null;
        }
        List<RagUnitChunk> chunks = chunkMapper.selectList(new LambdaQueryWrapper<RagUnitChunk>()
                .eq(RagUnitChunk::getUnitId, unit.getId())
                .orderByAsc(RagUnitChunk::getChunkIndex));
        if (chunks.isEmpty()) {
            log.debug("单元 {}#{} 没有切分边界，跳过索引", namespace, refId);
            return null;
        }
        return new IndexableUnitSnapshot(unit, content.canonicalText(), chunks);
    }

    /** 退役一个单元（幂等）。投影行不存在时是 no-op —— 删除比注册先到是正常的。 */
    public void retireUnit(String namespace, Long refId) {
        RagIndexableUnit unit = findUnit(namespace, refId);
        if (unit == null || RagNamespace.STATUS_RETIRED.equals(unit.getStatus())) return;
        transactionTemplate.executeWithoutResult(status -> markRetired(unit, "RETIRED_BY_CALLER"));
    }

    // ── 全量对账（RECONCILE_UNITS 作业调用）──────────────────────────────

    /**
     * 从原始表重新枚举，补齐缺失的单元、刷新变化的单元、退役已消失的单元。
     *
     * <p><b>这里刻意没有 {@code catch}。</b>解密失败已由 provider 收敛成
     * {@link UnitContent.Outcome#UNUSABLE}，是一个返回值而不是异常；除此之外的任何异常
     * （NPE、mapper 报错、约束冲突）都必须逃出本方法，让作业转 RETRY/DEAD 并告警。
     *
     * <p>若在这里补一个 {@code catch (Exception e) { markSkipped(...); }}，故障形态会变成：
     * 一个空指针被记成「跳过一个单元」→ 跳过比例只要低于
     * {@code app.rag.max-skipped-ratio}（0.05）就不触发任何告警 → 代次照常转 READY。
     * 于是每 20 个单元里可以藏一个 bug 而没人知道，跳过率门禁从数据质量信号变成 bug 藏身处。
     * 这条由 {@code RagUnitRegistryIntegrationTest} 的「非解密异常必须逃逸」钉住。
     */
    public ReconcileReport reconcileAll() {
        return reconcileAll(() -> { });
    }

    /**
     * @param heartbeat 每批开始前调用一次 —— worker 传入续租动作。
     *
     * <p><b>续租必须在循环里，不能只在开头。</b>全量对账很可能超过 stale-lease 阈值，
     * 于是租约过期、另一个 worker 重新领走同一条作业 → 两个 reconcile 并发跑。
     * {@code ensureRow} 扛得住（撞键后走更新分支），但白做一遍功，
     * 更要紧的是两份 report 各算各的跳过比例，门禁判据跟着失真。
     */
    public ReconcileReport reconcileAll(Runnable heartbeat) {
        ReconcileReport report = new ReconcileReport();
        Set<Long> touched = new LinkedHashSet<>();

        // 第一趟：Notebook 资料。只枚举 READY —— 解析中的资料还没有可索引正文，
        // 登记进来只会变成一条 SKIPPED，白白推高跳过率、逼近门禁。
        forEachPage(heartbeat, lastId -> sourceMapper.selectList(new LambdaQueryWrapper<AiNotebookSource>()
                        .eq(AiNotebookSource::getStatus, "READY")
                        .gt(AiNotebookSource::getId, lastId)
                        .orderByAsc(AiNotebookSource::getId)
                        .last("LIMIT " + RECONCILE_PAGE_SIZE)),
                AiNotebookSource::getId,
                source -> {
                    RagIndexableUnit unit = ensureRow(RagNamespace.NOTEBOOK_SOURCE, source.getId(), source.getUserId(),
                            RagNamespace.SCOPE_NOTEBOOK, source.getNotebookId(), source.getTitle(), source.getSourceType());
                    touched.add(unit.getId());
                    refresh(unit, report);
                });

        // 第二趟：Wiki 页。软删的页在这里就不会出现（@TableLogic），留给第三趟处理。
        forEachPage(heartbeat, lastId -> pageMapper.selectList(new LambdaQueryWrapper<UserKnowledgePage>()
                        .gt(UserKnowledgePage::getId, lastId)
                        .orderByAsc(UserKnowledgePage::getId)
                        .last("LIMIT " + RECONCILE_PAGE_SIZE)),
                UserKnowledgePage::getId,
                page -> {
                    if (isExcludedPage(page)) {
                        RagIndexableUnit existing = findUnit(RagNamespace.WIKI_PAGE, page.getId());
                        if (existing == null) return;
                        touched.add(existing.getId());
                        report.total++;
                        if (!RagNamespace.STATUS_RETIRED.equals(existing.getStatus())) {
                            String pageType = String.valueOf(page.getPageType()).toUpperCase();
                            transactionTemplate.executeWithoutResult(s ->
                                    markRetired(existing, "EXCLUDED_SYSTEM_PAGE:" + pageType));
                            report.recordRetired(existing.getId());
                        } else {
                            report.unchanged++;
                        }
                        return;
                    }
                    RagIndexableUnit unit = ensureRow(RagNamespace.WIKI_PAGE, page.getId(), page.getUserId(),
                            RagNamespace.SCOPE_WIKI_TREE, null, page.getTitle(), RagNamespace.WIKI_PAGE);
                    touched.add(unit.getId());
                    refresh(unit, report);
                });

        // 第三趟：投影里还是 READY、但上面两趟没枚举到的行。软删的 Wiki 页正是走到这里 ——
        // provider 按 ref_id + user_id 回读拿到 null → GONE → RETIRED，向量才会被清理。
        // 当成 SKIPPED 的话，用户以为删掉的内容会一直留在向量库里被检索到。
        forEachPage(heartbeat, lastId -> unitMapper.selectList(new LambdaQueryWrapper<RagIndexableUnit>()
                        .eq(RagIndexableUnit::getStatus, RagNamespace.STATUS_READY)
                        .gt(RagIndexableUnit::getId, lastId)
                        .orderByAsc(RagIndexableUnit::getId)
                        .last("LIMIT " + RECONCILE_PAGE_SIZE)),
                RagIndexableUnit::getId,
                unit -> {
                    if (touched.contains(unit.getId())) return;
                    refresh(unit, report);
                });

        log.info("RAG 投影对账完成：{}", report);
        return report;
    }

    // ── 内部 ────────────────────────────────────────────────────────────

    private boolean isExcludedPage(UserKnowledgePage page) {
        return RagNamespace.isExcludedWikiPage(page.getPageType(), page.getTitle());
    }

    /** 建行或更新元数据。<b>归属校验在这里，不在回读侧。</b> */
    private RagIndexableUnit ensureRow(String namespace, Long refId, Long userId,
                                       String scopeKind, Long scopeId, String title, String sourceType) {
        requireOwner(namespace, refId, userId);

        String safeTitle = limit(title == null ? "" : title, TITLE_MAX);
        String safeSourceType = limit(sourceType == null ? namespace : sourceType, SOURCE_TYPE_MAX);

        RagIndexableUnit existing = findUnit(namespace, refId);
        if (existing == null) {
            RagIndexableUnit fresh = new RagIndexableUnit();
            fresh.setUserId(userId);
            fresh.setNamespace(namespace);
            fresh.setRefId(refId);
            fresh.setScopeKind(scopeKind);
            fresh.setScopeId(scopeId);
            fresh.setTitle(safeTitle);
            fresh.setSourceType(safeSourceType);
            fresh.setChunkCount(0);
            fresh.setStatus(RagNamespace.STATUS_READY);
            fresh.setIndexStatus("NOT_INDEXED");
            try {
                unitMapper.insert(fresh);
                return fresh;
            } catch (DuplicateKeyException concurrent) {
                // 「查不到就插」是 check-then-act，uk_rag_unit_ns_ref 会把并发的第二个写者顶掉。
                // 今天这条路走不到（upsertWikiUnit 还没有生产调用方），但 Wiki 钩子一接上就活了：
                // 业务钩子与 RECONCILE_UNITS 作业同时碰同一页时，用户的一次保存会直接 500。
                // 沿用 RagIndexJobService.enqueue 的做法——把撞键当成「别人已经建好了」，重查后走更新分支。
                log.debug("可索引单元已被并发创建，改走更新分支 {}#{}", namespace, refId);
                existing = findUnit(namespace, refId);
                if (existing == null) throw concurrent;   // 撞了键却查不到：不是并发，是真异常，别吞
            }
        }

        if (!userId.equals(existing.getUserId())) {
            // 同一个 (namespace, ref_id) 换了归属：要么是注册路径写错了 user_id，要么是主键被复用。
            // 两种都不能靠「以新值为准」蒙混过去——那等于把一份内容的向量交给另一个用户。
            throw new IllegalStateException("可索引单元的归属发生变化：" + namespace + "#" + refId
                    + " 原属用户 " + existing.getUserId() + "，本次注册声称属于 " + userId);
        }

        unitMapper.update(null, new LambdaUpdateWrapper<RagIndexableUnit>()
                .eq(RagIndexableUnit::getId, existing.getId())
                .set(RagIndexableUnit::getScopeKind, scopeKind)
                .set(RagIndexableUnit::getScopeId, scopeId)
                .set(RagIndexableUnit::getTitle, safeTitle)
                .set(RagIndexableUnit::getSourceType, safeSourceType));
        existing.setScopeKind(scopeKind);
        existing.setScopeId(scopeId);
        existing.setTitle(safeTitle);
        existing.setSourceType(safeSourceType);
        return existing;
    }

    /**
     * 归属必须在<b>写入侧</b>断言，不能等回读侧发现空。
     *
     * <p>回读侧发现的形态是三步静默链：user_id 为空 → {@code ref_id + user_id} 双条件命中 0 行
     * → 记 SKIPPED → 跳过率低于门禁 → 代次照常 READY。这批内容检索不到，全程没有任何报错。
     *
     * <p>最可能写空的路径是从 {@code SecurityContext} 取 userId：注册发生在异步 worker 线程里，
     * 而 SecurityContext 不向异步线程传播（CLAUDE.md 已就 AI 工具执行器记过同一条）。
     * 归属只能来自实体行本身。
     */
    private void requireOwner(String namespace, Long refId, Long userId) {
        if (refId == null) {
            throw new IllegalStateException("注册可索引单元时 ref_id 为空：" + namespace);
        }
        if (userId == null) {
            throw new IllegalStateException("注册可索引单元时 user_id 为空：" + namespace + "#" + refId
                    + "。归属必须取自实体行，不得取自 SecurityContext（异步线程里恒为空）");
        }
    }

    /**
     * 回读一次并把结果落到投影行上。三种结局对应三种状态，<b>不得合并</b>：
     * GONE → RETIRED（并删掉切分边界，向量由调用方发 DELETE_UNIT 清理）；
     * UNUSABLE → SKIPPED（保留单元，等下次对账重试）；OK → READY。
     */
    private void refresh(RagIndexableUnit unit, ReconcileReport report) {
        report.total++;
        UnitContent content = resolver.load(unit);
        switch (content.outcome()) {
            case GONE -> {
                if (!RagNamespace.STATUS_RETIRED.equals(unit.getStatus())) {
                    transactionTemplate.executeWithoutResult(s -> markRetired(unit, content.reason()));
                    report.recordRetired(unit.getId());
                } else {
                    report.unchanged++;
                }
            }
            case UNUSABLE -> {
                transactionTemplate.executeWithoutResult(s -> markSkipped(unit, content.reason()));
                report.skipped++;
                report.skippedReasons.add(unit.getNamespace() + "#" + unit.getRefId() + " " + content.reason());
            }
            case OK -> transactionTemplate.executeWithoutResult(s -> applyContent(unit, content, report));
        }
    }

    private void applyContent(RagIndexableUnit unit, UnitContent content, ReconcileReport report) {
        String canonicalHash = hashService.hashCanonicalText(content.canonicalText());
        String safeTitle = limit(content.title() == null ? "" : content.title(), TITLE_MAX);

        if (canonicalHash.equals(unit.getCanonicalHash()) && RagNamespace.STATUS_READY.equals(unit.getStatus())) {
            if (!safeTitle.equals(unit.getTitle())) {
                unitMapper.update(null, new LambdaUpdateWrapper<RagIndexableUnit>()
                        .eq(RagIndexableUnit::getId, unit.getId())
                        .set(RagIndexableUnit::getTitle, safeTitle));
                unit.setTitle(safeTitle);
            }
            report.unchanged++;
            return;
        }

        List<RagUnitChunker.Chunk> chunks = content.presetChunks() != null
                ? content.presetChunks()
                : chunker.chunk(content.canonicalText());

        replaceChunks(unit, content.canonicalText(), chunks);

        unitMapper.update(null, new LambdaUpdateWrapper<RagIndexableUnit>()
                .eq(RagIndexableUnit::getId, unit.getId())
                .set(RagIndexableUnit::getTitle, safeTitle)
                .set(RagIndexableUnit::getCanonicalHash, canonicalHash)
                .set(RagIndexableUnit::getChunkCount, chunks.size())
                .set(RagIndexableUnit::getStatus, RagNamespace.STATUS_READY)
                // 内容变了就必须重索引；沿用旧的 INDEXED 会让新正文永远不进向量库。
                .set(RagIndexableUnit::getIndexStatus, "NOT_INDEXED")
                .set(RagIndexableUnit::getIndexError, null)
                .set(RagIndexableUnit::getIndexedAt, null));

        unit.setTitle(safeTitle);
        unit.setCanonicalHash(canonicalHash);
        unit.setChunkCount(chunks.size());
        unit.setStatus(RagNamespace.STATUS_READY);
        unit.setIndexStatus("NOT_INDEXED");
        unit.setIndexError(null);
        unit.setIndexedAt(null);
        report.updated++;
    }

    private void replaceChunks(RagIndexableUnit unit, String canonicalText, List<RagUnitChunker.Chunk> chunks) {
        deleteChunks(unit.getId());
        for (RagUnitChunker.Chunk chunk : chunks) {
            RagUnitChunk row = new RagUnitChunk();
            row.setUnitId(unit.getId());
            row.setChunkIndex(chunk.index());
            row.setCharStart(chunk.charStart());
            row.setCharEnd(chunk.charEnd());
            // 按 code point 切片——用 substring 会把 code point 偏移当 UTF-16 偏移，
            // 在含 emoji 的正文上算出一个「看起来正常但错位」的哈希。
            row.setContentHash(hashService.hashCanonicalText(
                    RagUnitChunker.sliceByCodePoints(canonicalText, chunk.charStart(), chunk.charEnd())));
            chunkMapper.insert(row);
        }
    }

    /** 不变量：切分边界只在 READY 单元上存在。退役与跳过都要把它们清掉。 */
    private void deleteChunks(Long unitId) {
        chunkMapper.delete(new LambdaQueryWrapper<RagUnitChunk>().eq(RagUnitChunk::getUnitId, unitId));
    }

    /**
     * <b>刻意不写 {@code index_status}。</b>这是一次「承重的没有写」：在 DELETE_UNIT 作业接上之前
     * （1B-2），「哪些单元已退役但向量还留在库里」的<b>唯一</b>痕迹就是
     * {@code status='RETIRED' AND index_status='INDEXED'} 这个组合。
     *
     * <p>将来若有人为了整洁补一句 {@code .set(indexStatus, "NOT_INDEXED")}，这条痕迹就没了，
     * 软删页的向量永远没人清理 —— 而那正是 GONE / UNUSABLE 分家要防的事，且没有任何测试会红。
     * 退役单元的 id 同时通过 {@link ReconcileReport#retiredUnitIds} 显式返回，
     * 调用方据此入队 DELETE_UNIT，不必反查这个组合。
     */
    private void markRetired(RagIndexableUnit unit, String reason) {
        deleteChunks(unit.getId());
        unitMapper.update(null, new LambdaUpdateWrapper<RagIndexableUnit>()
                .eq(RagIndexableUnit::getId, unit.getId())
                .set(RagIndexableUnit::getStatus, RagNamespace.STATUS_RETIRED)
                .set(RagIndexableUnit::getChunkCount, 0)
                .set(RagIndexableUnit::getCanonicalHash, null)
                .set(RagIndexableUnit::getIndexError, limit(reason, ERROR_MAX)));
        unit.setStatus(RagNamespace.STATUS_RETIRED);
        unit.setChunkCount(0);
        unit.setCanonicalHash(null);
    }

    private void markSkipped(RagIndexableUnit unit, String reason) {
        deleteChunks(unit.getId());
        unitMapper.update(null, new LambdaUpdateWrapper<RagIndexableUnit>()
                .eq(RagIndexableUnit::getId, unit.getId())
                .set(RagIndexableUnit::getStatus, RagNamespace.STATUS_SKIPPED)
                .set(RagIndexableUnit::getChunkCount, 0)
                // 哈希必须清空：留着旧值的话，等解密恢复正常后新内容会与旧哈希比对成「没变」，
                // 于是这页永远停在 SKIPPED，而每一处代码单看都是对的。
                .set(RagIndexableUnit::getCanonicalHash, null)
                .set(RagIndexableUnit::getIndexError, limit(reason, ERROR_MAX)));
        unit.setStatus(RagNamespace.STATUS_SKIPPED);
        unit.setChunkCount(0);
        unit.setCanonicalHash(null);
    }

    private RagIndexableUnit findUnit(String namespace, Long refId) {
        return unitMapper.selectOne(new LambdaQueryWrapper<RagIndexableUnit>()
                .eq(RagIndexableUnit::getNamespace, namespace)
                .eq(RagIndexableUnit::getRefId, refId));
    }

    /** 按主键翻页遍历，避免一次性把整张表读进内存。 */
    private <T> void forEachPage(Runnable heartbeat, LongFunction<List<T>> fetchAfter,
                                 Function<T, Long> idOf, Consumer<T> action) {
        long lastId = 0L;
        while (true) {
            heartbeat.run();   // 续租：不做的话长对账会被另一个 worker 重新领走，两份 report 各算各的比例
            List<T> batch = fetchAfter.apply(lastId);
            if (batch.isEmpty()) return;
            for (T row : batch) {
                action.accept(row);
                lastId = Math.max(lastId, idOf.apply(row));
            }
            if (batch.size() < RECONCILE_PAGE_SIZE) return;
        }
    }

    private String limit(String value, int max) {
        if (value == null) return null;
        return value.length() <= max ? value : value.substring(0, max);
    }

    /**
     * 对账结果。{@code skipped} 与 {@code total} 供跳过率门禁使用。
     *
     * <p>{@link #retiredUnitIds} 是有类型的输出，不是日志：调用方据此入队 DELETE_UNIT。
     * 只给一个计数的话，「谁退役了」就只能靠反查
     * {@code status='RETIRED' AND index_status='INDEXED'} 这个组合来重建 ——
     * 那是一条没人知道它承重的隐式约定（见 {@code markRetired} 的注释）。
     */
    public static final class ReconcileReport {
        public int total;
        public int updated;
        public int unchanged;
        public int skipped;
        public final List<Long> retiredUnitIds = new ArrayList<>();
        public final List<String> skippedReasons = new ArrayList<>();

        void recordRetired(Long unitId) {
            retiredUnitIds.add(unitId);
        }

        public int retired() {
            return retiredUnitIds.size();
        }

        public double skippedRatio() {
            return total == 0 ? 0.0 : (double) skipped / total;
        }

        @Override
        public String toString() {
            return "total=" + total + ", updated=" + updated + ", unchanged=" + unchanged
                    + ", retired=" + retired() + ", skipped=" + skipped;
        }
    }
}
