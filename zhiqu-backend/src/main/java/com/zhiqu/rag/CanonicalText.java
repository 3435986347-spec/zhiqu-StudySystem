package com.zhiqu.rag;

import com.zhiqu.common.MarkdownCanonicalizer;

import java.util.List;

/**
 * 可索引单元的规范化全文 —— <b>唯一入口</b>。
 *
 * <p>每个命名空间的"全文"由什么拼成，必须只有一处定义。散开写的后果不是编译错误，而是
 * 钩子算出的 canonical_hash 与 worker 算出的对不上：钩子判定"内容变了"入队，worker 索引完
 * 又判定"还是变了"，同一页无限重建，而两处代码单看都合理。
 *
 * <p><b>Wiki 形态是 {@code title + "\n\n" + cleanedBody}，与
 * {@code KnowledgeService.pageStateHash} 逐字一致。</b>这条一致性有两层，缺一层就复现上述故障：
 * <ol>
 *   <li>拼接形态一致 —— 都带标题、都用两个换行分隔；</li>
 *   <li><b>body 口径一致</b> —— 都是 {@code MarkdownCanonicalizer.clean(decrypt(...))} 的输出。
 *       已核实 pageStateHash 的两个调用点（快照与合入检查）都走清洗后的正文，因此这里直接
 *       复用清洗器即可天然同源，无需重算存量页的哈希。</li>
 * </ol>
 * 标题参与哈希是有意的：改标题就该重索引，标题本身也要能被检索命中。
 */
public final class CanonicalText {

    private CanonicalText() {
    }

    /**
     * Wiki 页的规范化全文。
     *
     * <p>正文会再过一次清洗，因此传入已清洗的 {@code KnowledgePageSnapshot.content} 也安全 ——
     * {@link MarkdownCanonicalizer#clean} 幂等是这条便利的前提，已由测试钉住。
     */
    public static String wiki(String title, String body) {
        return (title == null ? "" : title) + "\n\n" + MarkdownCanonicalizer.clean(body);
    }

    /**
     * Notebook 资料的规范化全文：父块按既有分隔符拼接。
     *
     * <p>必须与 {@code RagContentHashService.hashParentChunks} 用同一个分隔符，否则同一份资料
     * 在投影表与既有索引状态里会得到两个哈希，每次 reconcile 都判定"变了"。
     */
    public static String notebook(List<String> parentChunks) {
        return parentChunks == null ? "" : String.join(RagContentHashService.CHUNK_SEPARATOR, parentChunks);
    }

    /**
     * 会话轮次的规范化全文。
     *
     * <p>用户提问与助手回答必须一起进，单独一条在检索里没有意义（"对，就这样"这类回答
     * 脱离提问后不可理解）。Phase 3 才会有生产调用方，这里先把口径定死。
     */
    public static String conversationTurn(String userText, String assistantText) {
        return (userText == null ? "" : userText.strip())
                + RagContentHashService.CHUNK_SEPARATOR
                + (assistantText == null ? "" : assistantText.strip());
    }
}
