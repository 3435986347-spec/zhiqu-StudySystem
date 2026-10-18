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
        assertEquals("```js\nconst a = 1;\n```\n\n我已经把资料整理进知识库了。\n- 一\n\n补充一段\n", MarkdownCanonicalizer.cleanKeeping(edited, base),
                "原页结尾的换行也留着");
        assertEquals("正文\n补充", MarkdownCanonicalizer.cleanKeeping("```markdown\n正文\n补充\n```", "正文"), "模型包了一层 ```markdown 照样剥");
        assertEquals(MarkdownCanonicalizer.clean("```\n新页\n已写入 wiki\n```"), MarkdownCanonicalizer.cleanKeeping("```\n新页\n已写入 wiki\n```", null), "没有原页就是 clean()");
    }

    @Test
    @DisplayName("第二遍 review：外层围栏只在整页都被包住时才剥；模型改了开头代码块的语言名不算包了一层；首行缩进、结尾换行留着；洗两遍和洗一遍一样")
    void unwrapsOnlyAWholePageWrapper() {
        assertEquals("```js\nfoo\n```\n\n新增一行\n", MarkdownCanonicalizer.cleanKeeping("```js\nfoo\n```\n\n新增一行", "```javascript\nfoo\n```\n"),
                "开头的代码块换了语言名、页不是以代码块结尾：只剥开头那一道的话，留下的收尾会吞掉后面整页");
        String bothEnds = "```js\nfoo\n```\n\n中间 改\n\n```js\nbar\n```";
        assertEquals(bothEnds, MarkdownCanonicalizer.cleanKeeping(bothEnds, "```javascript\nfoo\n```\n\n中间\n\n```js\nbar\n```"),
                "以代码块开头、也以代码块结尾的页，不是被包了一层");
        assertEquals("```\ncode\n```\n正文 改", MarkdownCanonicalizer.cleanKeeping("```\n```\ncode\n```\n正文 改\n```", "```\ncode\n```\n正文"),
                "原页以光秃秃的 ``` 开头、模型又用 ``` 包了整页：照样剥掉那一层");
        assertEquals("    int x = 1;\n    int y;\n\n说明\n补充\n", MarkdownCanonicalizer.cleanKeeping("\n    int x = 1;\n    int y;\n\n说明\n补充\n\n", "    int x = 1;\n    int y;\n\n说明\n"),
                "缩进四格的代码块开头：第一行的缩进不能去掉（去掉就成了一段正文）");
        String codeAtBothEnds = "```js\na\n```\n正文\n```py\nb\n```";
        assertEquals(codeAtBothEnds + "\n", MarkdownCanonicalizer.cleanKeeping(codeAtBothEnds, "正文\n"),
                "原页不以代码块开头、模型把代码放到了开头和结尾：开头是 ```js 不是 ```markdown，不是包了一层");
        assertEquals("```markdown\n# 标题\n正文\n", MarkdownCanonicalizer.cleanKeeping("```markdown\n# 标题\n正文", "旧\n"),
                "开头是 ```markdown 但没收尾（输出被截断）：不是包了一层，最后一行不能丢");
        String base = "```js\na\n```\n正文\n";
        String once = MarkdownCanonicalizer.cleanKeeping("```markdown\n```js\na\n```\n正文\n补\n```", base);
        assertEquals("```js\na\n```\n正文\n补\n", once, "模型用 ```markdown 包了整页（页本身以代码块开头）");
        assertEquals(once, MarkdownCanonicalizer.cleanKeeping(once, base), "建草稿、合入各洗一遍：第二遍不能再剥");
    }
}
