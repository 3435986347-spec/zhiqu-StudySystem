package com.zhiqu.service.knowledge;

import com.zhiqu.common.BusinessException;
import com.zhiqu.common.MarkdownCanonicalizer;
import com.zhiqu.entity.UserKnowledgeRevision;
import com.zhiqu.service.privacy.SensitiveCryptoService;

/**
 * Wiki 草稿（{@code user_knowledge_revision}）只在这里造（第七十四轮第六遍 review）。
 *
 * <p>合入时不再洗第二遍（第四遍：洗两遍每次都多一次剥掉真内容的机会），于是「草稿存的就是要落到页上的」。
 * 原来五个地方各自手搭草稿，两处（AI 助手存回答、工作区的 Wiki 工件）从没洗过、有的先截断再洗（截掉了收尾的围栏，包的那层就剥不掉）、
 * 洗完是空的也照样存（要到合入时才报错，同一批里别的草稿也跟着合不进去）。三条规矩收在这里：
 * <ol>
 *   <li>先洗（{@link MarkdownCanonicalizer#cleanKeeping}）再截，截了要说；</li>
 *   <li>洗完是空的不造 —— {@link #require} 当场说出来，{@link #body} 回 null 给「不存也行」的那一处（AI 助手存回答）；</li>
 *   <li>造出来的草稿标记 {@code contentCleaned = 1}：合入时没有这个标记的（这一轮之前存的）补洗一遍。</li>
 * </ol>
 * {@link Body} 只能由 {@link #body} 造出来，所以「没洗过的正文进了草稿」在类型上写不出来；
 * {@code WikiDraftCleaningTest} 钉着「{@code new UserKnowledgeRevision()} 全仓只在这里出现」。
 */
public final class WikiDrafts {

    private WikiDrafts() {
    }

    /** 洗过、截过的草稿正文 */
    public static final class Body {
        private final String text;

        private Body(String text) {
            this.text = text;
        }

        public String text() {
            return text;
        }
    }

    /** 洗（{@code base} 是改已有页时的原页正文，新页为 null）、再截到 {@code maxChars}；洗完是空的回 null（只有「不存也行」的调用方用它） */
    public static Body body(String raw, String base, int maxChars) {
        String cleaned = MarkdownCanonicalizer.cleanKeeping(raw, base);
        return cleaned.isBlank() ? null : new Body(truncate(cleaned, maxChars));
    }

    /** 同 {@link #body}，洗完是空的就当场说出来（建草稿的人还能被告诉；要到合入时才报错的话，同一批里别的草稿也跟着合不进去） */
    public static Body require(String raw, String base, int maxChars, String title) {
        Body body = body(raw, base, maxChars);
        if (body == null) {
            throw new BusinessException("「" + title + "」的草稿没有正文（只有「已写入知识库」这类说明），没有生成");
        }
        return body;
    }

    /**
     * 截断要说出来（第七十四轮第七遍 review）：原来 limitRaw 悄悄在后面加「...」，截在代码块中间时后面整页都成了代码、截在 emoji 中间是半个字。
     * 现在按 {@link #cut} 截、开着的代码块补上收尾、末尾写明只存了多少（按字形数，数的是真正留下的）。
     */
    private static String truncate(String text, int maxChars) {
        if (text.length() <= maxChars) {
            return text;
        }
        String kept = cut(text, maxChars);
        return MarkdownCanonicalizer.closeOpenFence(kept)
                + "\n\n> 草稿只存了前 " + graphemes(kept) + " 字（原文 " + graphemes(text) + " 字），后面的没有存进来。";
    }

    /** 给人看的一段摘录（AI 助手回答里的「草稿摘要」）：和草稿同一套截法，截了就在后面另起一行写「…」 */
    public static String excerpt(String text, int maxChars) {
        String value = text == null ? "" : text;
        return value.length() <= maxChars ? value : MarkdownCanonicalizer.closeOpenFence(cut(value, maxChars)) + "\n…";
    }

    /**
     * 截到 {@code maxChars} 以内：能在整行处截就在整行处截（最后一个换行不早于上限的八成）—— 半行的表格、半个链接、
     * 截在收尾那一行中间留下的「``」都不会有（第九遍 review）；一行特别长时按字形截：一个 emoji（含 ZWJ 组合、国旗、肤色）、
     * 一个带组合符号的字都不切开（第八遍 review）。结尾的空白去掉。
     */
    private static String cut(String text, int maxChars) {
        java.util.regex.Matcher grapheme = GRAPHEME.matcher(text);
        int end = 0;
        while (grapheme.find() && grapheme.end() <= maxChars) end = grapheme.end();
        int lineEnd = text.lastIndexOf('\n', end);
        if (lineEnd >= 0 && lineEnd >= end * 0.8) end = lineEnd;
        return text.substring(0, end).stripTrailing();
    }

    private static long graphemes(String text) {
        return GRAPHEME.matcher(text).results().count();
    }

    private static final java.util.regex.Pattern GRAPHEME = java.util.regex.Pattern.compile("\\X");

    /** 一条待合入的写入草稿（UPSERT、PENDING、已洗过）；目标页、基线、来源这些由调用方接着设 */
    public static UserKnowledgeRevision pending(Long userId, Long patchSetId, String title, Body body, SensitiveCryptoService crypto) {
        return revision(userId, patchSetId, "UPSERT", title, body.text(), crypto);
    }

    /**
     * 一条待合入的删除草稿：合入时走 deleteRevisionTarget、不落正文；附带的说明（「和《X》重复，合并后删除」）洗过照样存着给确认框看，可以是空的。
     * 和 {@link #pending} 分开（第七遍 review：原来是 forDelete() 给一个空 Body，谁都能拿它造一条「洗过的空写入」）。
     */
    public static UserKnowledgeRevision deletion(Long userId, Long patchSetId, String title, String note, SensitiveCryptoService crypto) {
        return revision(userId, patchSetId, "DELETE", title, MarkdownCanonicalizer.cleanKeeping(note, null), crypto);
    }

    private static UserKnowledgeRevision revision(Long userId, Long patchSetId, String actionType, String title, String content, SensitiveCryptoService crypto) {
        UserKnowledgeRevision revision = new UserKnowledgeRevision();
        revision.setUserId(userId);
        revision.setPatchSetId(patchSetId);
        revision.setActionType(actionType);
        revision.setTitle(title);
        revision.setEncryptedContent(crypto.encrypt(content));
        revision.setEncryptionVersion("v1");
        revision.setStatus("PENDING");
        revision.setContentCleaned(1);
        return revision;
    }
}
