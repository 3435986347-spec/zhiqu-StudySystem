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
        assertEquals("新页", MarkdownCanonicalizer.cleanKeeping("```\n新页\n已写入 wiki\n```", null), "新页：包的那层、自述行照样去掉");
        assertEquals("```js\ncode\n```\n正文", MarkdownCanonicalizer.cleanKeeping("```js\ncode\n```\n正文", null),
                "新页只是以代码块开头（第五遍 review：原来走 clean()，剥掉开头那一道、留下的收尾吞掉后面整页）");
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
    }

    @Test
    @DisplayName("第三、四遍 review：光秃秃的 ``` 只在里面没有别的围栏时才算包了一层；大写的 ```Markdown 和标题在前的包法也认；```text 开头的「输出」块不是包")
    void secondPassAndOtherWrapperShapes() {
        String plain = "正文\n";
        String once = MarkdownCanonicalizer.cleanKeeping("```markdown\n```\nc1\n```\n正文\n```\nc2\n```\n```", plain);
        assertEquals("```\nc1\n```\n正文\n```\nc2\n```\n", once);
        String codeAround = "```\ncode1\n```\ntext\n```\ncode2\n```";
        assertEquals(codeAround + "\n", MarkdownCanonicalizer.cleanKeeping(codeAround, plain), "以光秃秃的代码块开头、结尾的页不是包了一层");
        assertEquals("# 标题\n正文 改\n", MarkdownCanonicalizer.cleanKeeping("```\n# 标题\n正文 改\n```", plain), "光秃秃的 ``` 包了整页、里面没有别的围栏：剥");
        assertEquals("正文 改\n", MarkdownCanonicalizer.cleanKeeping("```Markdown\n正文 改\n```", plain), "大写的 ```Markdown");
        assertEquals("# 新标题\n```js\na\n```\n正文\n", MarkdownCanonicalizer.cleanKeeping("```markdown\n# 新标题\n```js\na\n```\n正文\n```", "```js\na\n```\n正文\n"),
                "原页以代码块开头、模型在前面加了标题再用 ```markdown 包起来");
        String example = "```markdown\n示例\n```\n正文 改\n```js\nx\n```";
        assertEquals(example + "\n", MarkdownCanonicalizer.cleanKeeping(example, "```markdown\n示例\n```\n正文\n```js\nx\n```\n"),
                "原页自己就以一个 ```markdown 示例块开头、又以代码块结尾：模型原样改了一处，不是包了一层");
        String output = "```text\n输出 3\n```\n解释\n```python\nprint(3)\n```";
        assertEquals(output + "\n", MarkdownCanonicalizer.cleanKeeping(output, plain), "以 ```text 输出块开头、以代码块结尾的页不是包了一层");
        String edited = "```text\n输出\n```\n正文\n```js\nb\n```";
        assertEquals(edited + "\n", MarkdownCanonicalizer.cleanKeeping(edited, "```js\na\n```\n正文\n"), "原页以代码块开头、模型把第一块改成了 ```text 输出块");
        String innerLangLine = "```markdown\n```\na\n```js\nb\n```";
        assertEquals(innerLangLine + "\n", MarkdownCanonicalizer.cleanKeeping(innerLangLine, plain),
                "打开的块里带语言名的 ``` 行是内容、不是收尾：最后那个 ``` 收的是里面的块，不是包");
        String declaredButOpen = "```markdown\n# 标题\n```js\nx\n```";
        assertEquals(declaredButOpen + "\n", MarkdownCanonicalizer.cleanKeeping(declaredButOpen, plain),
                "写着 ```markdown、可里面的围栏不成对（最后那个 ``` 是 js 块的收尾）：不是包了一层");
    }

    @Test
    @DisplayName("第六遍 review：包的后面跟着一句「已写入知识库」也剥；```text 包也剥；包里有一行行内代码、缩进代码块里有 ``` 照样成对")
    void moreWrapperShapes() {
        assertEquals("# 页\n正文", MarkdownCanonicalizer.cleanKeeping("```markdown\n# 页\n正文\n```\n\n已将以上内容写入知识库。", null),
                "自述行跟在收尾的围栏后面：先去掉它再看是不是包了一层");
        assertEquals("纯文本的总结", MarkdownCanonicalizer.cleanKeeping("```text\n纯文本的总结\n```", null), "```text 包的回答");
        assertEquals("正文\n```x``` 是行内代码", MarkdownCanonicalizer.cleanKeeping("```markdown\n正文\n```x``` 是行内代码\n```", null),
                "反引号后面还有反引号的那一行是行内代码，不是围栏");
        assertEquals("- 列表\n\n        ```\n        缩进代码", MarkdownCanonicalizer.cleanKeeping("```markdown\n- 列表\n\n        ```\n        缩进代码\n```", null),
                "缩进四格以上的 ``` 是缩进代码块的内容，不是围栏");
    }

    @Test
    @DisplayName("第八遍 review：系统补的「没有生成知识 Wiki 草稿」那一句不是正文")
    void theNoDraftNoteIsNotContent() {
        assertEquals("", MarkdownCanonicalizer.cleanKeeping("已将以上内容写入知识库。\n\n" + MarkdownCanonicalizer.NO_WIKI_DRAFT_NOTE, null));
        assertEquals("正文", MarkdownCanonicalizer.cleanKeeping("正文\n" + MarkdownCanonicalizer.NO_WIKI_DRAFT_NOTE, null));
        assertEquals("正文", MarkdownCanonicalizer.cleanKeeping("正文\n> （没有生成知识 Wiki 草稿：这次的回答里没有可以存进...", null),
                "第九遍 review：被截短的、被引用的那一句也认得");
    }

    @Test
    @DisplayName("第五遍 review：成对照 CommonMark —— 更长的反引号、~~~ 都认")
    void fencesFollowCommonMark() {
        assertEquals("正文\n```py\nx\n````", MarkdownCanonicalizer.cleanKeeping("```markdown\n正文\n```py\nx\n````\n```", null), "里面的块用四个反引号收尾");
        assertEquals("~~~\na\n~~~", MarkdownCanonicalizer.cleanKeeping("```markdown\n~~~\na\n~~~\n```", null), "里面是 ~~~ 块");
        assertEquals("~~~\n```\n~~~", MarkdownCanonicalizer.cleanKeeping("```markdown\n~~~\n```\n~~~\n```", null), "~~~ 块里的 ``` 行是内容：里面成对，是包");
        String tildeOpen = "```markdown\n~~~\na\n```\nb\n```";
        assertEquals(tildeOpen, MarkdownCanonicalizer.cleanKeeping(tildeOpen, null), "~~~ 打开的块不能被 ``` 收尾：里面没成对，不是包");
    }

    /**
     * 明示的取舍：一页新以 ```markdown 示例块开头、又以光秃秃的代码块结尾 —— 和「```markdown 包了一页带代码块的页」一模一样，
     * 按包了一层剥（模型这样包远比页这样开头常见）。原页本来就以这个示例块开头时不受影响（开头一样，不算包）。
     */
    @Test
    void aNewPageStartingWithAMarkdownExampleAndEndingWithCodeIsReadAsWrapped() {
        assertEquals("# 示例\n```\n正文\n```\nx\n", MarkdownCanonicalizer.cleanKeeping("```markdown\n# 示例\n```\n正文\n```\nx\n```", "正文\n"));
        // 同一类（第六遍 review 让 ```text 包又算包之后）：以 ```text 输出块开头、以光秃秃的代码块结尾、里面成对的页
        assertEquals("输出\n```\n解释\n```\nmore\n", MarkdownCanonicalizer.cleanKeeping("```text\n输出\n```\n解释\n```\nmore\n```", "正文\n"));
    }

    /**
     * 明示的取舍：光秃秃的 ``` 包了整页、中间又有代码块 —— 和「以光秃秃的代码块开头、结尾的页」分不开，宁可不剥
     *（没剥的包在确认框的预览里看得见；剥错了是整页的围栏错位）。
     */
    @Test
    void aBareWrapperAroundAPageWithCodeInsideIsLeftAlone() {
        String wrapped = "```\n# 标题\n正文\n```py\nx\n```\n更多\n```";
        assertEquals(wrapped + "\n", MarkdownCanonicalizer.cleanKeeping(wrapped, "正文\n"));
    }
}
