package com.zhiqu.service.ai;

import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 把聊天里挂上来的图片拼成<b>多模态用户消息</b>的内容块。
 *
 * <h2>为什么图片不能走检索那条路</h2>
 *
 * <p>上传时图片只存原件、不做文本解析（没有分块），所以它在 RAG 检索里什么都不是 ——
 * 界面上「0 份可用于问答，1 份仅存档」说的就是这件事。图片要被理解，只能<b>原样交给
 * 视觉模型</b>：走 OpenAI 的 {@code image_url} 内容块，和 {@code analyzeImage} 那条
 * 已验证的路子同一个格式。
 *
 * <h2>为什么要有限额</h2>
 *
 * <p>base64 会把体积放大到 4/3，一张 6MB 的手机照片进请求体就是 8MB。多挂几张就会
 * 撞上服务商的请求上限，而那个错误回来是一句「request too large」—— 看不出是图片导致的。
 * 所以这里先挡：单张上限、总量上限、张数上限，<b>并把被跳过的张数说给模型听</b>
 * （附在文本块里）。默默丢掉会让模型以为它看到了全部图片，然后据此下结论。
 */
public final class ChatImageAttachments {

    /**
     * 一张已经读进内存、准备送进模型的图片。
     *
     * <p>{@code sourceId} 不是给模型用的，是给<b>校验器</b>用的：VERIFIER 有一条
     * 「用户选了资料却零证据 → 中止本轮」的规则，而图片天然产生不了检索证据（它没有分块）。
     * 不把图片的 id 从那条判定里排除，只挂一张图就会把整轮对话掐掉。
     */
    public record LoadedImage(Long sourceId, String fileName, byte[] bytes) {
    }

    /** 拼装结果：内容块，以及要不要告诉用户有东西被跳过。 */
    public record Built(List<Map<String, Object>> content, int included, List<String> skipped) {
        public boolean hasImages() {
            return included > 0;
        }
    }

    /** 最多挂几张。再多，模型的注意力和请求体都撑不住。 */
    public static final int MAX_IMAGES = 4;
    /** 单张原始字节上限（base64 后约 5.3MB）。 */
    public static final int MAX_BYTES_PER_IMAGE = 4 * 1024 * 1024;
    /** 所有图片加起来的原始字节上限（base64 后约 10.7MB）。 */
    public static final int MAX_TOTAL_BYTES = 8 * 1024 * 1024;

    /**
     * 从文件名推断 media type。
     *
     * <p>认不出来时回落到 {@code image/jpeg} 而不是抛错：这一步只是给 data URI 写个头，
     * 猜错了最坏是模型解不出这张图，而抛错会让整轮对话失败 —— 后者的代价大得多。
     */
    public static String mediaTypeOf(String fileName) {
        String lower = fileName == null ? "" : fileName.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".bmp")) return "image/bmp";
        return "image/jpeg";
    }

    /**
     * 拼内容块：一个文本块 + 若干图片块。
     *
     * <p>文本块<b>必须在最前面</b>：问题是「用户在问什么」，图片是材料。顺序反过来时，
     * 部分服务商会把最后一条文本当成主要指令，而那条文本此刻是空的。
     */
    public static Built build(String text, List<LoadedImage> images) {
        List<Map<String, Object>> blocks = new ArrayList<>();
        List<String> skipped = new ArrayList<>();
        int included = 0;
        long total = 0;

        for (LoadedImage image : images == null ? List.<LoadedImage>of() : images) {
            if (image == null || image.bytes() == null || image.bytes().length == 0) {
                continue;
            }
            if (included >= MAX_IMAGES) {
                skipped.add(image.fileName() + "（超过一次最多 " + MAX_IMAGES + " 张）");
                continue;
            }
            if (image.bytes().length > MAX_BYTES_PER_IMAGE) {
                skipped.add(image.fileName() + "（单张超过 " + (MAX_BYTES_PER_IMAGE / 1024 / 1024) + "MB）");
                continue;
            }
            if (total + image.bytes().length > MAX_TOTAL_BYTES) {
                skipped.add(image.fileName() + "（本轮图片总量超过 " + (MAX_TOTAL_BYTES / 1024 / 1024) + "MB）");
                continue;
            }
            total += image.bytes().length;
            included++;
            blocks.add(Map.of(
                    "type", "image_url",
                    "image_url", Map.of("url", "data:" + mediaTypeOf(image.fileName())
                            + ";base64," + Base64.getEncoder().encodeToString(image.bytes()))
            ));
        }

        // 被跳过的要说出来 —— 模型不知道有东西没给它，就会把「看到的」当成「全部」。
        String finalText = text == null ? "" : text;
        if (!skipped.isEmpty()) {
            finalText = finalText + "\n\n【有 " + skipped.size() + " 张图片未能附上："
                    + String.join("；", skipped) + "。回答时不要假装看过它们。】";
        }
        blocks.add(0, Map.of("type", "text", "text", finalText));
        return new Built(blocks, included, skipped);
    }

    /** 模型不支持视觉时，附在文本后面的说明 —— 让模型据实回答，而不是编造图片内容。 */
    public static String noVisionNotice(int imageCount) {
        return "\n\n【用户挂了 " + imageCount + " 张图片，但当前模型不支持图片识别，你看不到它们。"
                + "请据实说明，并建议用户在个人中心切换到支持视觉的模型。不要猜测图片内容。】";
    }

    private ChatImageAttachments() {
    }
}
