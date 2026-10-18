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
    @DisplayName("先洗再截：很长的 ```markdown 包着的回答，截到上限之前先把包的那层剥掉（先截的话收尾的围栏没了，就剥不掉）；截了要说")
    void cleansBeforeTruncating() {
        WikiDrafts.Body body = WikiDrafts.body("```markdown\n" + "字".repeat(6000) + "\n```", null, 5000);
        assertNotNull(body);
        assertTrue(body.text().startsWith("字"), "包的那层没剥掉：" + body.text().substring(0, 20));
        assertTrue(body.text().startsWith("字".repeat(5000) + "\n\n> 草稿只存了前 5000 字（原文 6000 字）"), "截了没说，或者截的地方不对：" + body.text().substring(4990));
    }

    @Test
    @DisplayName("第七遍 review：截在代码块中间补上收尾（后面不会整页成了代码）、不截半个 emoji")
    void truncationKeepsMarkdownWellFormed() {
        String inCode = WikiDrafts.body("说明\n````js\n" + "x".repeat(100), null, 50).text();
        assertTrue(inCode.contains("x\n````\n\n> 草稿只存了前"), "开着的代码块没补收尾（要和开头一样是四个反引号）：" + inCode);
        String emoji = WikiDrafts.body("a".repeat(9) + "😀" + "b".repeat(20), null, 10).text();
        assertTrue(emoji.startsWith("a".repeat(9) + "\n\n> 草稿只存了前 9 字"), "截在了 emoji 中间：" + emoji);
        assertEquals("不用截", WikiDrafts.body("不用截", null, 50).text(), "没超就原样");
    }

    @Test
    @DisplayName("第八遍 review：ZWJ 组合的 emoji、国旗不切开；说的字数按码点、按真正留下的；截在收尾那一行中间不留半行")
    void graphemesCountsAndHalfClosers() {
        String family = "👨‍👩‍👧";   // 三个人用 ZWJ 连起来，UTF-16 里 8 个单元
        String cut = WikiDrafts.body("a".repeat(5) + family + "b".repeat(20), null, 8).text();
        assertTrue(cut.startsWith("aaaaa\n\n> 草稿只存了前 5 字"), "ZWJ 组合被切开了：" + cut);
        String halfFlag = WikiDrafts.body("a".repeat(5) + "🇨🇳" + "b".repeat(20), null, 8).text();
        assertTrue(halfFlag.startsWith("aaaaa\n\n> 草稿只存了前 5 字"), "国旗被切开了（放不下整面就不放）：" + halfFlag);
        String flag = WikiDrafts.body("a".repeat(5) + "🇨🇳" + "b".repeat(20), null, 9).text();
        assertTrue(flag.startsWith("aaaaa🇨🇳\n\n> 草稿只存了前 6 字（原文 26 字）"), "字数要按字形数（一面国旗是一个字），不按 UTF-16 的长度：" + flag);
        String spaces = WikiDrafts.body("abc" + " ".repeat(10) + "d".repeat(20), null, 8).text();
        assertTrue(spaces.startsWith("abc\n\n> 草稿只存了前 3 字"), "说的字数要是去掉结尾空白之后真正留下的：" + spaces);
        String text = "说明\n```js\ncode\n```\n后文后文后文";
        String half = WikiDrafts.body(text, null, text.indexOf("```\n后文") + 2).text();
        assertTrue(half.startsWith("说明\n```js\ncode\n```\n\n> 草稿只存了前 13 字"), "截在收尾那一行中间，留下了半行「``」、或字数数的不是真正留下的：" + half);
    }

    @Test
    @DisplayName("第九遍 review：在整行处截 —— 块里本来就有的一行 ``` 不被当成半个收尾删掉；摘录同一套截法")
    void cutsAtLineBoundaries() {
        String doc = "````md\n```js\ncode\n```\nmore more more more";
        String kept = WikiDrafts.body(doc, null, doc.indexOf("\nmore") + 3).text();
        assertTrue(kept.startsWith("````md\n```js\ncode\n```\n````\n\n> 草稿只存了前"), "块里那一行 ``` 被删了：" + kept);
        String excerpt = WikiDrafts.excerpt("第一行\n" + "a".repeat(9) + "👨‍👩‍👧" + "b".repeat(30), 14);
        assertEquals("第一行\n" + "a".repeat(9) + "\n…", excerpt, "摘录：不切开 emoji、截了另起一行写「…」");
        assertEquals("短的", WikiDrafts.excerpt("短的", 14));
    }

    @Test
    @DisplayName("require：洗完是空的当场说出来；删除草稿的说明洗过照样存（可以是空的），标成 DELETE")
    void requireAndDeletion() {
        RuntimeException empty = assertThrows(RuntimeException.class, () -> WikiDrafts.require("已将以上内容写入知识库。", null, 5000, "某页"));
        assertTrue(empty.getMessage().contains("「某页」的草稿没有正文"), empty.getMessage());
        UserKnowledgeRevision deletion = WikiDrafts.deletion(7L, 9L, "旧页", "这页和《X》重复，合并后删除\n已将以上内容写入知识库。", crypto);
        assertEquals("DELETE", deletion.getActionType());
        assertEquals("这页和《X》重复，合并后删除", crypto.decrypt(deletion.getEncryptedContent()));
        assertEquals("", crypto.decrypt(WikiDrafts.deletion(7L, 9L, "旧页", "", crypto).getEncryptedContent()));
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
