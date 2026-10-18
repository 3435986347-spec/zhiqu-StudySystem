package com.zhiqu.service.knowledge;

import com.zhiqu.common.MarkdownCanonicalizer;
import com.zhiqu.common.Texts;
import com.zhiqu.entity.UserKnowledgeRevision;
import com.zhiqu.service.privacy.SensitiveCryptoService;

/**
 * Wiki 草稿（{@code user_knowledge_revision}）只在这里造（第七十四轮第六遍 review）。
 *
 * <p>合入时不再洗第二遍（第四遍：洗两遍每次都多一次剥掉真内容的机会），于是「草稿存的就是要落到页上的」。
 * 原来五个地方各自手搭草稿，两处（AI 助手存回答、工作区的 Wiki 工件）从没洗过、有的先截断再洗（截掉了收尾的围栏，包的那层就剥不掉）、
 * 洗完是空的也照样存（要到合入时才报错，同一批里别的草稿也跟着合不进去）。三条规矩收在这里：
 * <ol>
 *   <li>先洗（{@link MarkdownCanonicalizer#cleanKeeping}）再截；</li>
 *   <li>洗完是空的不造 —— {@link #body} 回 null，由调用方决定是说出来还是不存；</li>
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

    /** 洗（{@code base} 是改已有页时的原页正文，新页为 null）、再截到 {@code maxChars}；洗完是空的回 null */
    public static Body body(String raw, String base, int maxChars) {
        String cleaned = MarkdownCanonicalizer.cleanKeeping(raw, base);
        return cleaned.isBlank() ? null : new Body(Texts.limitRaw(cleaned, maxChars));
    }

    /** 删除类草稿没有正文：合入时走 deleteRevisionTarget，不落正文 */
    public static Body forDelete() {
        return new Body("");
    }

    /** 一条待合入的草稿（UPSERT、PENDING、已洗过）；目标页、基线、来源这些由调用方接着设 */
    public static UserKnowledgeRevision pending(Long userId, Long patchSetId, String title, Body body, SensitiveCryptoService crypto) {
        UserKnowledgeRevision revision = new UserKnowledgeRevision();
        revision.setUserId(userId);
        revision.setPatchSetId(patchSetId);
        revision.setActionType("UPSERT");
        revision.setTitle(title);
        revision.setEncryptedContent(crypto.encrypt(body.text()));
        revision.setEncryptionVersion("v1");
        revision.setStatus("PENDING");
        revision.setContentCleaned(1);
        return revision;
    }
}
