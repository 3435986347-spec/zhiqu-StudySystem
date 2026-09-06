package com.zhiqu.rag;

import com.zhiqu.common.MarkdownCanonicalizer;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * canonical 契约的特征化测试。
 *
 * <p>这里钉住的每一条性质，失效时的故障形态都是同一个：钩子算出的 canonical_hash 与
 * worker 算出的对不上 → 钩子判定「内容变了」入队 → worker 索引完又判定「还是变了」→
 * 同一页无限重建。没有异常、没有日志，只有 CPU 和 embedding 配额在烧。
 *
 * <p>声称钉住四条性质，因此配四次扰动验证（见提交说明）：
 * <ol>
 *   <li>清洗输出逐字节不变（提取前后同输入同输出）</li>
 *   <li>两个调用方共用同一实现，不存在漏改的副本</li>
 *   <li>{@code CHUNK_SEPARATOR} 取值未变</li>
 *   <li>清洗幂等 —— 已清洗的快照再传进来必须得到同一结果</li>
 * </ol>
 */
class CanonicalTextCharacterizationTest {

    /** 覆盖清洗器的全部分支：CRLF、整体代码围栏、空标题行、模型自述行、首尾空白。 */
    private static final String RAW_BODY = """
            ```markdown\r
            # 复习计划\r
            ##   \r
            每天两小时高数。\r
            已将以上内容写入知识库。\r
            ```""";

    private static final String CLEANED_BODY = "# 复习计划\n每天两小时高数。";

    // ── 性质 1：清洗输出逐字节不变 ────────────────────────────────────────

    @Test
    void 清洗输出在提取前后逐字节不变() {
        assertEquals(CLEANED_BODY, MarkdownCanonicalizer.clean(RAW_BODY),
                "清洗结果变了就等于全部存量页的 pageStateHash 失效");
    }

    @Test
    void 清洗的各条规则单独可见() {
        assertEquals("正文", MarkdownCanonicalizer.clean("  正文  "));
        assertEquals("a\nb", MarkdownCanonicalizer.clean("a\r\nb"));
        assertEquals("留下", MarkdownCanonicalizer.clean("###\n留下"));
        assertEquals("留下", MarkdownCanonicalizer.clean("留下\n已将内容写入 wiki"));
        assertEquals("", MarkdownCanonicalizer.clean(null));
    }

    // ── 性质 2：两个调用方共用同一实现 ────────────────────────────────────

    /**
     * <b>这条扰动最容易漏</b>：它不是「函数返回值错了」，而是「两处调用了不同的函数、
     * 却都返回了合理的值」。因此断言的形状是**两侧的输出必须逐字节相等**，
     * 而不是各自与某个期望值相等 —— 后者在存在漏改副本时照样能全绿。
     *
     * <p>验证方式：给共享清洗器注入一个可辨识行为，两侧必须**同时**变化。
     * 只有一侧变，就说明还有一份没改到的副本。
     */
    @Test
    void wiki规范化与页状态哈希喂进同一份清洗结果() {
        String viaCanonicalText = CanonicalText.wiki("复习计划", RAW_BODY);
        // pageStateHash 的口径：title + "\n\n" + cleanMarkdownContent(decrypt(...))
        String viaPageStateHashShape = "复习计划" + "\n\n" + MarkdownCanonicalizer.clean(RAW_BODY);

        assertEquals(viaPageStateHashShape, viaCanonicalText,
                "CanonicalText.wiki 与 pageStateHash 的拼接形态或 body 口径不一致；"
                        + "两者哈希将永不相等，Wiki 页会被无限重索引");
    }

    /**
     * 清洗实现只有一份 —— <b>靠结构消除，不靠测试检测</b>。
     *
     * <p>此前这里试过两种做法，都不成立：
     * ① 比较两个「都调用共享实现」的表达式 —— 副本压根不在测试路径上，扰动验证是绿的；
     * ② 扫描源码找特征片段 —— 会误报（{@code KnowledgeServiceImpl} 里给摘要剥 markdown 的
     * 正则、{@code AiServiceImpl} 里清洗模型输出的近似逻辑都是合法的），而真副本只要改个
     * 变量名就能绕过。会误报的不变量测试会被下一个人删掉，比没有更糟。
     *
     * <p>最终做法是把 {@code KnowledgeServiceImpl} 的薄委托整个删除、12 个调用点直接调
     * {@link MarkdownCanonicalizer#clean}，让「第二份实现」无处可藏。本条只钉住委托不会被加回来。
     */
    @Test
    void knowledgeServiceImpl不再持有私有清洗副本() {
        boolean hasPrivateCleaner = java.util.Arrays.stream(
                        com.zhiqu.service.impl.KnowledgeServiceImpl.class.getDeclaredMethods())
                .anyMatch(m -> m.getName().equals("cleanMarkdownContent"));

        assertTrue(!hasPrivateCleaner,
                "cleanMarkdownContent 被加回来了。委托本身无害，但它会诱使下一个人在里面"
                        + "「顺手改一点」，于是 pageStateHash 与 canonical_hash 分叉、Wiki 页无限重索引。"
                        + "请直接调用 MarkdownCanonicalizer.clean");
    }

    @Test
    void wiki形态带标题且用两个换行分隔() {
        assertTrue(CanonicalText.wiki("标题", "正文").startsWith("标题\n\n"),
                "标题必须参与哈希：改标题应触发重索引，标题本身也要能被检索命中");
        assertEquals("\n\n正文", CanonicalText.wiki(null, "正文"));
    }

    // ── 性质 3：CHUNK_SEPARATOR 取值未变 ──────────────────────────────────

    @Test
    void 父块分隔符取值未变且被两处共用() {
        assertEquals("\n\u001E\n", RagContentHashService.CHUNK_SEPARATOR,
                "改动它会让全部存量 content_hash 失效并触发一次全量重建");

        // notebook 形态必须用同一个分隔符，否则同一份资料在投影表与既有索引状态里得到两个哈希
        assertEquals("甲" + RagContentHashService.CHUNK_SEPARATOR + "乙",
                CanonicalText.notebook(List.of("甲", "乙")));
        assertEquals("", CanonicalText.notebook(null));
    }

    @Test
    void 会话轮次形态把提问与回答一起纳入() {
        assertEquals("问" + RagContentHashService.CHUNK_SEPARATOR + "答",
                CanonicalText.conversationTurn("  问  ", "  答  "));
    }

    // ── 性质 4：清洗幂等 ──────────────────────────────────────────────────

    /**
     * 幂等是一条便利的前提：调用方手上常常已经有清洗过的 {@code KnowledgePageSnapshot.content}，
     * 会直接再传进 {@link CanonicalText#wiki} 以避免二次解密。若清洗不幂等，同一页会因为
     * 「洗了几次」产生不同哈希 —— 而每一处代码单看都是对的。
     */
    @Test
    void 清洗幂等且已清洗内容再进canonicalText结果相同() {
        String once = MarkdownCanonicalizer.clean(RAW_BODY);
        assertEquals(once, MarkdownCanonicalizer.clean(once), "清洗必须幂等");
        assertSame(once, once);

        assertEquals(CanonicalText.wiki("复习计划", RAW_BODY),
                CanonicalText.wiki("复习计划", once),
                "传原文与传已清洗内容必须得到同一规范化全文");
    }

    /** 反面：内容真的变了必须产出不同结果，否则上面几条可能是被某种恒等实现骗过的。 */
    @Test
    void 内容变化仍会改变规范化全文() {
        assertNotEquals(CanonicalText.wiki("复习计划", RAW_BODY),
                CanonicalText.wiki("复习计划", RAW_BODY + "\n新增一行"));
        assertNotEquals(CanonicalText.wiki("复习计划", RAW_BODY),
                CanonicalText.wiki("另一个标题", RAW_BODY));
    }
}
