package com.zhiqu.service.harness;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 图的记账（第一百三十七轮，docs/memory-plan.md 第 1 步）。
 *
 * <p>由来：用户一段 23 小时的会话压缩了 105 次。命令行那一份估算把图按 base64 的字数算（1MB 的截图 = 39 万 token），
 * 这边第一百三十四轮就改成按张算了 —— 同一个公式抄了两份，只修了一份。所以两边用<b>同一份样例</b>对拍
 * （命令行那一头是 {@code zhiqu-cli/test/memory-accounting.test.js}）。
 * 另一处：网关的总字数上限也把 base64 算了进去，一张 6.8MB 的图就回「对话内容太大，请先压缩」。
 */
class HarnessImageAccountingTest {

    private static final Path FIXTURE = Path.of("..", "zhiqu-cli", "test", "fixtures", "token-estimate.json");

    @Test
    @DisplayName("和命令行同一份样例：每条消息估出来的 token 数一样")
    @SuppressWarnings("unchecked")
    void 两边对拍() throws Exception {
        ObjectMapper json = new ObjectMapper();
        JsonNode root = json.readTree(Files.readString(FIXTURE));
        JsonNode cases = root.get("cases");
        assertTrue(cases.size() >= 5, "样例被删空了");
        for (JsonNode c : cases) {
            Map<String, Object> message = json.convertValue(c.get("message"), Map.class);
            if (c.has("imageB64Chars") && message.get("content") instanceof List<?> parts) {
                String pad = "A".repeat(c.get("imageB64Chars").asInt());
                List<Object> filled = new ArrayList<>();
                for (Object p : parts) {
                    Map<String, Object> part = new LinkedHashMap<>((Map<String, Object>) p);
                    if (part.get("image_url") instanceof Map<?, ?> u) {
                        part.put("image_url", Map.of("url", u.get("url") + pad));
                    }
                    filled.add(part);
                }
                message = new LinkedHashMap<>(message);
                message.put("content", filled);
            }
            assertEquals(c.get("tokens").asInt(), HarnessContext.estimateMessage(message), c.get("name").asText());
        }
        assertEquals(1200, HarnessContext.IMAGE_TOKENS, "和 compact.js 的 IMAGE_TOKENS 同一个数");
    }

    private static Map<String, Object> shot(int base64Chars) {
        return Map.of("role", "user", "content", List.of(
                Map.of("type", "text", "text", "看图"),
                Map.of("type", "image_url", "image_url", Map.of("url", "data:image/png;base64," + "A".repeat(base64Chars)))));
    }

    @Test
    @DisplayName("总字数上限不算图的 base64：一张 6.8MB 的截图（932 万字）不该被说成「对话内容太大」")
    void 总字数不算图() {
        List<Map<String, Object>> messages = List.of(Map.of("role", "user", "content", "看一下"), shot(9_322_000));
        assertEquals(2, HarnessModelGateway.validMessages(messages).size());
        assertEquals(2, HarnessModelGateway.textChars(shot(9_322_000).get("content")));
        // 文字照样算：对照组不死的实验不作数
        List<Map<String, Object>> tooLong = List.of(Map.of("role", "user", "content", "x".repeat(HarnessModelGateway.MAX_TOTAL_CHARS + 1)));
        assertThrows(BusinessException.class, () -> HarnessModelGateway.validMessages(tooLong));
        List<Map<String, Object>> tooLongInParts = List.of(Map.of("role", "user", "content",
                List.of(Map.of("type", "text", "text", "x".repeat(HarnessModelGateway.MAX_TOTAL_CHARS + 1)))));
        assertThrows(BusinessException.class, () -> HarnessModelGateway.validMessages(tooLongInParts), "内容块里的文字也要算");
    }

    @Test
    @DisplayName("图另有上限：单张太大、张数太多都说清楚")
    void 图的上限() {
        BusinessException big = assertThrows(BusinessException.class,
                () -> HarnessModelGateway.validMessages(List.of(shot(HarnessModelGateway.MAX_IMAGE_CHARS + 100))));
        assertTrue(big.getMessage().contains("有一张图太大"), big.getMessage());
        List<Map<String, Object>> many = new ArrayList<>();
        for (int i = 0; i <= HarnessModelGateway.MAX_IMAGES; i++) many.add(shot(10));
        BusinessException count = assertThrows(BusinessException.class, () -> HarnessModelGateway.validMessages(many));
        assertTrue(count.getMessage().contains("图太多"), count.getMessage());
    }
}
