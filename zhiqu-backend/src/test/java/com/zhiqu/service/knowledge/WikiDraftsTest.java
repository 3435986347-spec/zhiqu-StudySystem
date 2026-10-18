package com.zhiqu.service.knowledge;

import com.zhiqu.entity.UserKnowledgeRevision;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/** Wiki 草稿的三条规矩（第七十四轮第六遍 review）：先洗再截、空的不造、标记洗过 */
class WikiDraftsTest {
    private final SensitiveCryptoService crypto = new SensitiveCryptoService("0123456789abcdef0123456789abcdef");

    @Test
    @DisplayName("先洗再截：很长的 ```markdown 包着的回答，截到上限之前先把包的那层剥掉（先截的话收尾的围栏没了，就剥不掉）")
    void cleansBeforeTruncating() {
        WikiDrafts.Body body = WikiDrafts.body("```markdown\n" + "字".repeat(6000) + "\n```", null, 5000);
        assertNotNull(body);
        assertTrue(body.text().startsWith("字"), "包的那层没剥掉：" + body.text().substring(0, 20));
        assertEquals(5003, body.text().length(), "截到 5000 字（加上 ...）");
    }

    @Test
    @DisplayName("洗完是空的（只有「已写入知识库」）不造")
    void emptyAfterCleaningIsNull() {
        assertNull(WikiDrafts.body("已将以上内容写入知识库。", null, 5000));
        assertNull(WikiDrafts.body("```markdown\n\n```\n已写入 wiki", null, 5000));
        assertNotNull(WikiDrafts.body("正文", null, 5000));
    }

    @Test
    @DisplayName("造出来的草稿：UPSERT、PENDING、加密存洗过的正文、标记洗过（合入时就不再洗）")
    void pendingDraftIsMarkedCleaned() {
        UserKnowledgeRevision revision = WikiDrafts.pending(7L, 9L, "标题", WikiDrafts.body("```markdown\n# 页\n```", null, 5000), crypto);
        assertEquals(7L, revision.getUserId());
        assertEquals(9L, revision.getPatchSetId());
        assertEquals("UPSERT", revision.getActionType());
        assertEquals("PENDING", revision.getStatus());
        assertEquals("v1", revision.getEncryptionVersion());
        assertEquals(1, revision.getContentCleaned());
        assertEquals("# 页", crypto.decrypt(revision.getEncryptedContent()));
    }
}
