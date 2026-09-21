package com.zhiqu.common;

import java.util.ArrayList;
import java.util.List;

/**
 * Wiki 正文的规范化清洗。
 *
 * <p>从 {@code KnowledgeServiceImpl} 的私有方法提取而来，逐字未改。提取的原因是它成了
 * <b>跨模块的哈希口径</b>：`pageStateHash`（合入前的冲突检测基准）与 RAG 投影表的
 * `canonical_hash`（重索引闸门）必须喂进同一份清洗结果，否则两边哈希永不相等——
 * Wiki 钩子会判定"内容变了"、worker 索引完又判定"还是变了"，形成无限重建。
 * 留在私有方法里，第二个调用方只能复制一份，而复制品会漂。
 *
 * <p><b>幂等是承重性质。</b>{@code KnowledgePageSnapshot.content} 已经是清洗过的，
 * 而调用方常常把它直接再传进来（避免二次解密）。若清洗不幂等，同一页会因为"洗了几次"
 * 产生不同哈希——故障形态与上面那条一模一样，但更难查，因为每一处代码看起来都对。
 */
public final class MarkdownCanonicalizer {

    private MarkdownCanonicalizer() {
    }

    /**
     * 归一换行、剥离整体代码围栏、丢弃空标题行与「已写入 Wiki」这类模型自述行。
     *
     * <p>丢弃自述行是有意的：模型经常在正文末尾附一句"已将内容写入知识库"，那是对话内容
     * 而非页面内容，留着会让每次重新生成都产生不同正文、进而不停触发重索引。
     */
    public static String clean(String value) {
        if (value == null) {
            return "";
        }
        String text = value.replace("\r\n", "\n").replace("\r", "\n").trim();
        if (text.startsWith("```")) {
            text = text.replaceFirst("^```[A-Za-z0-9_-]*\\s*", "")
                    .replaceFirst("\\s*```$", "")
                    .trim();
        }
        List<String> lines = new ArrayList<>();
        for (String line : text.split("\n")) {
            String compact = line.replaceAll("\\s+", "");
            boolean emptyHeading = line.matches("^\\s*#{1,6}\\s*$");
            boolean wikiConfirmation = (compact.contains("已将") || compact.contains("已经") || compact.contains("已存入") || compact.contains("已写入"))
                    && (compact.toLowerCase().contains("wiki") || compact.contains("知识库") || compact.contains("知识树"));
            if (!emptyHeading && !wikiConfirmation) {
                lines.add(line);
            }
        }
        return String.join("\n", lines).trim();
    }
}
