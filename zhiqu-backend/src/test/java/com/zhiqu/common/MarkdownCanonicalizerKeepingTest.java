package com.zhiqu.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * AI 改已有的页时的清洗（第七十四轮 review）：clean() 去掉模型自述行、剥掉包住整段的围栏 —— 用在 AI 改已有页上，
 * 用户自己写在页里的「我已经把资料整理进知识库了」、页开头的代码块也一起没了（第七十一轮起用户保存是原样存的）。
 * cleanKeeping 只去掉原页里没有、模型加进来的那些。
 */
class MarkdownCanonicalizerKeepingTest {

    @Test
    @DisplayName("原页里本来就有的「已经…知识库」行、本来就以代码块开头的围栏都留着；模型加的自述行、包住整段的围栏照样去掉")
    void keepsWhatThePageAlreadyHad() {
        String base = "```js\nconst a = 1;\n```\n\n我已经把资料整理进知识库了。\n- 一\n";
        String edited = base + "\n补充一段\n已将以上内容写入知识库。";
        assertEquals("```js\nconst a = 1;\n```\n\n我已经把资料整理进知识库了。\n- 一\n\n补充一段", MarkdownCanonicalizer.cleanKeeping(edited, base));
        assertEquals("正文\n补充", MarkdownCanonicalizer.cleanKeeping("```markdown\n正文\n补充\n```", "正文"), "模型包了一层 ```markdown 照样剥");
        assertEquals(MarkdownCanonicalizer.clean("```\n新页\n已写入 wiki\n```"), MarkdownCanonicalizer.cleanKeeping("```\n新页\n已写入 wiki\n```", null), "没有原页就是 clean()");
    }
}
