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

    @Test
    @DisplayName("第三遍 review：原页不以代码块开头时，```markdown 里面以代码块开头、结尾的页第二遍不再剥；光秃秃的 ``` 只在里面没有别的围栏时才算包了一层；大写的 ```Markdown 和标题在前的包法也认")
    void secondPassAndOtherWrapperShapes() {
        String plain = "正文\n";
        String once = MarkdownCanonicalizer.cleanKeeping("```markdown\n```\nc1\n```\n正文\n```\nc2\n```\n```", plain);
        assertEquals("```\nc1\n```\n正文\n```\nc2\n```\n", once);
        assertEquals(once, MarkdownCanonicalizer.cleanKeeping(once, plain), "合入时第二遍把页自己的围栏也剥了");
        String codeAround = "```\ncode1\n```\ntext\n```\ncode2\n```";
        assertEquals(codeAround + "\n", MarkdownCanonicalizer.cleanKeeping(codeAround, plain), "以光秃秃的代码块开头、结尾的页不是包了一层");
        assertEquals("# 标题\n正文 改\n", MarkdownCanonicalizer.cleanKeeping("```\n# 标题\n正文 改\n```", plain), "光秃秃的 ``` 包了整页、里面没有别的围栏：剥");
        assertEquals("正文 改\n", MarkdownCanonicalizer.cleanKeeping("```Markdown\n正文 改\n```", plain), "大写的 ```Markdown");
        assertEquals("# 新标题\n```js\na\n```\n正文\n", MarkdownCanonicalizer.cleanKeeping("```markdown\n# 新标题\n```js\na\n```\n正文\n```", "```js\na\n```\n正文\n"),
                "原页以代码块开头、模型在前面加了标题再用 ```markdown 包起来");
        String example = "```markdown\n示例\n```\n正文 改\n```js\nx\n```";
        assertEquals(example + "\n", MarkdownCanonicalizer.cleanKeeping(example, "```markdown\n示例\n```\n正文\n```js\nx\n```\n"),
                "原页自己就以一个 ```markdown 示例块开头、又以代码块结尾：模型原样改了一处，不是包了一层");
    }
}
