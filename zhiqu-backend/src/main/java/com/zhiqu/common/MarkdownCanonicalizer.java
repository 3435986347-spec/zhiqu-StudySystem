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
 * <p><b>幂等是承重性质。</b>调用方常常把已经清洗过的正文再传进来（避免二次解密）。若清洗不幂等，同一页会因为"洗了几次"
 * 产生不同哈希——故障形态与上面那条一模一样，但更难查，因为每一处代码看起来都对。
 * （第七十四轮起 {@code KnowledgePageSnapshot.content} 是给模型看的原文，哈希另算；传进来照样安全，因为 clean(原文) 和 clean(clean(原文)) 一样。）
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
            if (!modelOnlyLine(line)) {
                lines.add(line);
            }
        }
        return String.join("\n", lines).trim();
    }

    /** 空标题行、「已写入 Wiki」这类模型自述行 */
    private static boolean modelOnlyLine(String line) {
        String compact = line.replaceAll("\\s+", "");
        boolean emptyHeading = line.matches("^\\s*#{1,6}\\s*$");
        boolean wikiConfirmation = (compact.contains("已将") || compact.contains("已经") || compact.contains("已存入") || compact.contains("已写入"))
                && (compact.toLowerCase().contains("wiki") || compact.contains("知识库") || compact.contains("知识树"));
        return emptyHeading || wikiConfirmation;
    }

    /**
     * Wiki 草稿入库前都过这一道（第七十四轮 review；新页 {@code base} 为 null）：照 {@link #clean} 去掉模型自己加的东西，但原页里本来就有的行不删、
     * 原页本来就以代码块开头时不剥那道围栏。合入时不再洗（第四遍 review），所以五处建草稿的地方都得经过这里（{@code WikiDraftCleaningTest} 扫着）。第七十一轮起用户保存是原样存的 —— 用户写在页里的「我已经把资料整理进知识库了」、
     * 页开头的代码块，过一遍 clean() 就没了。{@code clean} 本身不动（页状态哈希和 RAG 的规范全文靠它逐字节不变）。
     *
     * <p>和 clean() 另外两处不同（第二遍 review）：外层围栏只在整页都被包住时才剥（只剥开头那一道的话，留下的那道收尾会把后面整页吞进代码块）；
     * 首尾只去空行和行尾空白、不 trim 第一行的缩进（缩进四格的代码块开头的页 trim 之后成了一段正文），原页结尾有换行就留着。
     */
    public static String cleanKeeping(String value, String base) {
        if (value == null) {
            return "";
        }
        // 新页也走这里，不走 clean()：clean() 见开头是代码块就剥掉那一道，页只是以代码块开头时留下的收尾会吞掉后面整页（第五遍 review）
        String baseText = base == null ? "" : base.replace("\r\n", "\n").replace("\r", "\n");
        java.util.Set<String> baseLines = new java.util.HashSet<>(java.util.Arrays.asList(baseText.split("\n")));
        String text = trimBlankLines(value.replace("\r\n", "\n").replace("\r", "\n"));
        String unwrapped = unwrapWholePage(text, baseText.stripLeading().split("\n", 2)[0].trim());
        if (unwrapped != null) {
            text = unwrapped;
        }
        List<String> lines = new ArrayList<>();
        for (String line : text.split("\n")) {
            if (baseLines.contains(line) || !modelOnlyLine(line)) {
                lines.add(line);
            }
        }
        String result = trimBlankLines(String.join("\n", lines));
        return result.isEmpty() || !baseText.endsWith("\n") ? result : result + "\n";
    }

    /** 去掉开头的空行和结尾的空白，第一行自己的缩进不动 */
    private static String trimBlankLines(String text) {
        return text.replaceFirst("^(?:[ \\t]*\\n)+", "").stripTrailing();
    }

    /**
     * 整页被包在一个代码块里（模型常回 ```markdown … ```）就剥掉那一层，否则 null（第七十四轮第二、三、四遍 review）：
     * <ul>
     *   <li>开头写明 ```markdown / ```md（不分大小写，又不是原页自己的第一行），而且里面的围栏成对：是包了一层。
     *       ```text 不算 —— 那是常见的「输出」块，页以它开头、以代码块结尾时会被当成包；</li>
     *   <li>原页以代码块开头时，包的里面以围栏开头、围栏成对：是包了一层（模型把 ```javascript 写成 ```js、页又恰好以代码块结尾，不算）；</li>
     *   <li>原页不以代码块开头时，光秃秃的 ``` 只在里面再没有围栏时才算 —— 以光秃秃的代码块开头、结尾的页和光秃秃的包分不开，宁可不剥
     *       （没剥的包在确认框的预览里看得见；剥错了是整页的围栏错位）。</li>
     * </ul>
     * 合入时不再洗第二遍（{@code KnowledgeServiceImpl.upsertRevisionPage}），所以这里只跑一遍。
     */
    private static String unwrapWholePage(String text, String baseFirstLine) {
        int firstBreak = text.indexOf('\n'), lastBreak = text.lastIndexOf('\n');
        if (!text.startsWith("```") || firstBreak < 0 || !text.substring(lastBreak + 1).trim().equals("```")) {
            return null;
        }
        String opening = text.substring(0, firstBreak).trim();
        String inner = lastBreak > firstBreak ? text.substring(firstBreak + 1, lastBreak) : "";
        boolean declared = opening.matches("(?i)```(?:markdown|md)") && !opening.equals(baseFirstLine) && fencesBalanced(inner);
        boolean wrapper = declared || (baseFirstLine.startsWith("```")
                ? inner.stripLeading().startsWith("```") && fencesBalanced(inner)
                : opening.equals("```") && inner.lines().noneMatch(line -> line.stripLeading().startsWith("```")));
        return wrapper ? trimBlankLines(inner) : null;
    }

    /**
     * 每一个打开的代码块都在这段里关上，照 CommonMark：``` 或 ~~~ 开头（三个以上），收尾是同一种字符、不比开头短、后面没有语言名；
     * 块里面带语言名的 ``` 行是内容（第五遍 review：原来只认正好三个反引号，```` 收的块被当成没收）
     */
    private static boolean fencesBalanced(String text) {
        char fence = 0;
        int length = 0;
        for (String line : text.split("\n", -1)) {
            String trimmed = line.strip();
            int run = 0;
            while (run < trimmed.length() && (trimmed.charAt(run) == '`' || trimmed.charAt(run) == '~') && trimmed.charAt(run) == trimmed.charAt(0)) run++;
            if (run < 3) continue;
            if (fence == 0) { fence = trimmed.charAt(0); length = run; }
            else if (trimmed.charAt(0) == fence && run >= length && trimmed.substring(run).isBlank()) fence = 0;
        }
        return fence == 0;
    }
}
