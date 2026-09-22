package com.zhiqu.service.ai;

import com.zhiqu.service.ai.ChatImageAttachments.Built;
import com.zhiqu.service.ai.ChatImageAttachments.LoadedImage;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 把图片拼进多模态用户消息的判据。
 *
 * <p>由来：拖一张图片进聊天，界面显示「0 份可用于问答，1 份仅存档」，模型从头到尾没见过它。
 * 图片上传时只存原件、不做文本解析（没有分块），所以它在检索里什么都不是 —— 要被理解
 * 只能原样走视觉内容块，而那条路当时根本没接到聊天里（{@code analyzeImage} 只挂在
 * 「识别课表生成任务」那个独立端点上）。
 */
class ChatImageAttachmentsTest {

    private static LoadedImage img(String name, int bytes) {
        return new LoadedImage(1L, name, new byte[bytes]);
    }

    @Test
    @DisplayName("文本块必须排在最前面 —— 问题是指令，图片是材料")
    void 文本块在最前() {
        Built built = ChatImageAttachments.build("这张图里写了什么？", List.of(img("a.png", 10)));
        assertEquals("text", built.content().get(0).get("type"),
                "第一块必须是文本。部分服务商把最后一条文本当主要指令，顺序反了会拿到空指令");
        assertEquals("image_url", built.content().get(1).get("type"));
        assertEquals(1, built.included());
    }

    @Test
    @DisplayName("图片编成 data URI，media type 按扩展名推断")
    void 图片编码与媒体类型() {
        Built built = ChatImageAttachments.build("看图", List.of(img("shot.png", 3)));
        @SuppressWarnings("unchecked")
        Map<String, Object> url = (Map<String, Object>) built.content().get(1).get("image_url");
        assertTrue(String.valueOf(url.get("url")).startsWith("data:image/png;base64,"),
                "实际：" + url.get("url"));

        assertEquals("image/jpeg", ChatImageAttachments.mediaTypeOf("a.jpg"));
        assertEquals("image/png", ChatImageAttachments.mediaTypeOf("A.PNG"));
        assertEquals("image/webp", ChatImageAttachments.mediaTypeOf("x.webp"));
        assertEquals("image/gif", ChatImageAttachments.mediaTypeOf("x.gif"));
        // 认不出来回落 jpeg 而不是抛错：猜错最坏是这张图解不出来，抛错会让整轮对话失败
        assertEquals("image/jpeg", ChatImageAttachments.mediaTypeOf("noext"));
        assertEquals("image/jpeg", ChatImageAttachments.mediaTypeOf(null));
    }

    @Test
    @DisplayName("超过张数上限的被跳过，而且要在文本里说出来")
    void 张数上限() {
        List<LoadedImage> many = new ArrayList<>();
        for (int i = 0; i < ChatImageAttachments.MAX_IMAGES + 3; i++) {
            many.add(img("p" + i + ".png", 10));
        }
        Built built = ChatImageAttachments.build("看图", many);

        assertEquals(ChatImageAttachments.MAX_IMAGES, built.included());
        assertEquals(3, built.skipped().size());
        String text = String.valueOf(built.content().get(0).get("text"));
        assertTrue(text.contains("未能附上"),
                "被跳过的必须写进文本块 —— 不说的话模型会把「看到的」当成「全部」：" + text);
    }

    @Test
    @DisplayName("单张过大被跳过；总量超限也被跳过")
    void 体积上限() {
        Built one = ChatImageAttachments.build("x",
                List.of(img("huge.png", ChatImageAttachments.MAX_BYTES_PER_IMAGE + 1)));
        assertEquals(0, one.included());
        assertEquals(1, one.skipped().size());
        assertTrue(one.skipped().get(0).contains("单张超过"), one.skipped().toString());

        // 三张各 3MB：前两张进去（6MB），第三张会让总量超过 8MB
        int mb3 = 3 * 1024 * 1024;
        Built total = ChatImageAttachments.build("x",
                List.of(img("a.png", mb3), img("b.png", mb3), img("c.png", mb3)));
        assertEquals(2, total.included(), "总量上限应当在第三张时生效");
        assertTrue(total.skipped().get(0).contains("总量"), total.skipped().toString());
    }

    @Test
    @DisplayName("没有图片时不产生图片块，也不加多余提示")
    void 没有图片() {
        Built built = ChatImageAttachments.build("只是文字", List.of());
        assertEquals(1, built.content().size());
        assertEquals("text", built.content().get(0).get("type"));
        assertEquals("只是文字", built.content().get(0).get("text"));
        assertFalse(built.hasImages());
    }

    @Test
    @DisplayName("空字节 / null 条目被安静跳过，不算进 included")
    void 脏数据不炸() {
        List<LoadedImage> list = new ArrayList<>();
        list.add(null);
        list.add(new LoadedImage(1L, "empty.png", new byte[0]));
        list.add(new LoadedImage(2L, "ok.png", new byte[5]));
        Built built = ChatImageAttachments.build("x", list);
        assertEquals(1, built.included());
    }

    @Test
    @DisplayName("模型不支持视觉时给出据实说明，不让模型编造图片内容")
    void 无视觉能力的说明() {
        String notice = ChatImageAttachments.noVisionNotice(2);
        assertTrue(notice.contains("2"), notice);
        assertTrue(notice.contains("不要猜测"), "必须明确禁止编造：" + notice);
    }

    // ── 接线：图片要从「选了资料却零证据」那条规则里排除 ──────────────

    /**
     * 这条是这次改动里<b>最容易静默出事</b>的地方。
     *
     * <p>VERIFIER 有一条规则：用户选了资料但零检索证据 → 中止本轮。而图片没有分块、
     * 天然产生不了证据。不把图片 id 排除掉的话，<b>只挂一张图片就会把整轮对话掐掉</b>，
     * 而且表现是「问了没反应」，不会说是图片导致的。
     */
    @Test
    @DisplayName("校验器的零证据规则必须排除图片 id")
    void 校验器必须排除图片() throws IOException {
        String src = Files.readString(
                Path.of("src", "main", "java", "com", "zhiqu", "service", "impl", "AiServiceImpl.java"),
                StandardCharsets.UTF_8);
        int at = src.indexOf("selectedSourcesWithoutEvidence");
        assertTrue(at > 0, "找不到零证据判定 —— 判据扫空了");
        String around = src.substring(Math.max(0, at - 800), Math.min(src.length(), at + 400));
        assertTrue(around.contains("hasNonEmptyListExcluding"),
                "零证据判定没有排除图片。只挂一张图片就会被判成「选了资料却什么都没检索到」"
                        + "而中止整轮，表现是问了没反应。上下文：" + around);
        assertTrue(around.contains("attachedImages"),
                "排除用的集合不是本轮图片 id");
    }

    @Test
    @DisplayName("Anthropic 的图片块要走既有转换器，不得另写一份")
    void Anthropic复用既有转换器() throws IOException {
        String src = Files.readString(
                Path.of("src", "main", "java", "com", "zhiqu", "service", "impl", "AiServiceImpl.java"),
                StandardCharsets.UTF_8);
        int at = src.indexOf("ChatImageAttachments.build(userText");
        assertTrue(at > 0, "找不到多模态拼装点 —— 判据扫空了");
        String around = src.substring(at, Math.min(src.length(), at + 700));
        assertTrue(around.contains("toAnthropicContentBlocks"),
                "Anthropic 分支没有复用既有的 toAnthropicContentBlocks。它的图片块格式和 OpenAI "
                        + "不同，另写一份迟早分叉，而分叉的表现是某一家只收到文字、"
                        + "对着没有图的问题编造答案。");
    }
}
