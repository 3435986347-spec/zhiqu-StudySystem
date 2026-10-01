package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * 模型这一轮的输出撞上单次上限时，两种协议都要报「被截断」，而不是把半截回复当成正常结束。
 * 半截回复里没有完整的工具调用，调用方只会看到「模型不调工具了」—— 于是静默收尾（2026-09-24 马里奥那一轮）。
 */
class ToolTurnTruncationTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    @DisplayName("OpenAI：finish_reason=length 抛截断；stop / tool_calls 照常返回 message")
    void openAi() throws Exception {
        JsonNode cut = JSON.readTree("{\"choices\":[{\"finish_reason\":\"length\",\"message\":"
                + "{\"role\":\"assistant\",\"content\":\"<canvas>...\"}}]}");
        ModelProviderClient.ToolTurnTruncatedException e = assertThrows(ModelProviderClient.ToolTurnTruncatedException.class,
                () -> ModelProviderClient.openAiMessageOrTruncated(cut, 16384));
        assertEquals(16384, e.maxTokens());

        JsonNode ok = JSON.readTree("{\"choices\":[{\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\"}}]}");
        assertEquals("assistant", ModelProviderClient.openAiMessageOrTruncated(ok, 4096).path("role").asText());
        JsonNode empty = JSON.readTree("{\"choices\":[]}");
        assertEquals(null, ModelProviderClient.openAiMessageOrTruncated(empty, 4096));
    }

    @Test
    @DisplayName("Anthropic：stop_reason=max_tokens 抛截断；end_turn / tool_use 照常返回 content")
    void anthropic() throws Exception {
        JsonNode cut = JSON.readTree("{\"stop_reason\":\"max_tokens\",\"content\":[{\"type\":\"text\",\"text\":\"...\"}]}");
        assertThrows(ModelProviderClient.ToolTurnTruncatedException.class,
                () -> ModelProviderClient.anthropicContentOrTruncated(cut, 4096));
        JsonNode ok = JSON.readTree("{\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\"}]}");
        assertEquals(1, ModelProviderClient.anthropicContentOrTruncated(ok, 4096).size());
    }
}
