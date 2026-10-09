package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * AI 助手与知识 Wiki 的主面板要<b>填满视口高度</b>，不被固定像素上限压矮。
 *
 * <p>由来：这两页原本把对话卡片钉死在 {@code min-height:560px}，把聊天区包裹钉死在
 * {@code max-height:430px}、两侧栏 {@code max-height:560px}。在大屏上，页面下方大片留白，
 * 对话只用了一小截。用户要它「长一些」。
 *
 * <p>这条判据盯的不是「好不好看」，而是那几个固定上限<b>别再回来</b> —— 一个
 * {@code max-height:430px} 看着人畜无害，加回去却会把对话区重新压回半屏，而代码评审
 * 很难从一行内联样式里看出这个后果。
 */
class TallPanelsTest {

    private static final Path STATIC = Path.of("src", "main", "resources", "static");

    /**
     * 内容包裹要<b>定高</b>等于视口，而不是 {@code min-height}。
     *
     * <p>先用的是 {@code min-height:calc(100vh - 110px)}，面板确实撑满了，但内容略高于视口时
     * <b>整页会产生外层滚动</b> —— 而侧栏收起后，展开箭头在竖条顶端，是收起状态下唯一的
     * 展开入口。外层一滚它就跑出视野，人得先滚回顶部才能展开。改成 {@code height} 之后
     * 整页不滚，长内容在对话区 / 正文区内部滚，箭头永远在。
     */
    @Test
    @DisplayName("AI 助手与知识页的内容包裹要定高等于视口（height:calc(100vh…)）")
    void 两页都按视口填满高度() throws IOException {
        for (String page : new String[]{"ai-assistant.html", "knowledge-wiki.html"}) {
            String html = Files.readString(STATIC.resolve(page), StandardCharsets.UTF_8);
            assertTrue(html.contains("height:calc(100vh"),
                    page + " 的内容包裹没有按视口定高（缺 height:calc(100vh…）—— "
                            + "面板会退回随内容收缩，大屏上大片留白。");
            assertFalse(html.contains("min-height:calc(100vh"),
                    page + " 用的是 min-height:calc(100vh…。内容略高于视口时整页会外层滚动，"
                            + "而侧栏收起后的展开箭头在竖条顶端，一滚就够不到 —— 必须是 height。");
        }
    }

    @Test
    @DisplayName("AI 聊天区与两侧栏不得有面板级固定 max-height —— 那会把对话压回半屏")
    void AI面板不得被固定上限压矮() throws IOException {
        String html = Files.readString(STATIC.resolve("ai-assistant.html"), StandardCharsets.UTF_8);
        // 只揪「面板级」的固定像素上限（≥300px）。输入框 textarea 的 max-height:120px 是
        // 正当封顶（多行输入到此为止），不在此列 —— 阈值把「压矮整块面板」和
        // 「限制一个输入框」分开。拆掉的那几个是 430 / 560。
        Matcher m = Pattern.compile("max-height:\\s*(\\d+)px").matcher(html);
        StringBuilder offenders = new StringBuilder();
        while (m.find()) {
            if (Integer.parseInt(m.group(1)) >= 300) {
                offenders.append(m.group()).append(' ');
            }
        }
        assertTrue(offenders.length() == 0,
                "ai-assistant.html 里出现了面板级固定 max-height：" + offenders.toString().trim()
                        + "。聊天区和侧栏该随卡片撑满，加固定上限会把它们压回半屏 —— "
                        + "这正是 2026-09-22 拆掉的那几个（chat 430px、侧栏 560px）。");
    }

    @Test
    @DisplayName("顶部精简：两页都不再有那句 13px 描述副标题")
    void 顶部副标题已精简() throws IOException {
        // 副标题挤占了本可留给内容的高度；精简掉是这次改动的另一半。
        String ai = Files.readString(STATIC.resolve("ai-assistant.html"), StandardCharsets.UTF_8);
        assertFalse(ai.contains("继续历史对话、读取 Notebook 资料并创建待确认草稿"),
                "AI 助手顶部那句副标题还在 —— 顶部没精简，内容区就没腾出高度");
        String wiki = Files.readString(STATIC.resolve("knowledge-wiki.html"), StandardCharsets.UTF_8);
        assertFalse(wiki.contains("像文档一样浏览和编辑长期目标"),
                "知识页顶部那句副标题还在");
    }
}
