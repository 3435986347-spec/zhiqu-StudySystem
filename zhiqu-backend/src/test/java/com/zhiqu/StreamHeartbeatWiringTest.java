package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 两处结构约束（去掉注释再判 —— 注释里写着「heartbeats.start」不算代码做了这件事）：
 * <ol>
 *   <li>网页聊天流开心跳，并且成功、出错两条路径都关掉它（关不掉的心跳会一直往一个已结束的流里写）。
 *       心跳本身的行为由 HarnessHeartbeatTest 真跑着判。</li>
 *   <li>清空记忆不许逐条删消息：几千条消息就是几千条 UPDATE，全程占着用户锁。行为（删干净、纪元栅栏）由
 *       AiConversationLifecycleIntegrationTest 在真 MySQL 上判；这里判的是「一条语句」这件事本身。</li>
 * </ol>
 */
class StreamHeartbeatWiringTest {

    private static String body(String src, String signature) {
        int start = src.indexOf(signature);
        assertTrue(start >= 0, "找不到方法：" + signature);
        int brace = src.indexOf('{', start);
        int depth = 0;
        for (int i = brace; i < src.length(); i++) {
            char c = src.charAt(i);
            if (c == '{') depth++;
            if (c == '}' && --depth == 0) return SourceText.stripComments(src.substring(brace, i + 1));
        }
        throw new AssertionError("方法没有闭合：" + signature);
    }

    private static int count(String s, String needle) {
        int n = 0;
        for (int i = s.indexOf(needle); i >= 0; i = s.indexOf(needle, i + needle.length())) n++;
        return n;
    }

    @Test
    @DisplayName("网页聊天流：开心跳，成功与出错两条路径都关")
    void 聊天流心跳() throws Exception {
        String src = Files.readString(Path.of("src/main/java/com/zhiqu/service/impl/AiServiceImpl.java"));
        String m = body(src, "public SseEmitter streamChat(Long userId, String message, Long modelConfigId,\n                                 Boolean enableWebSearch, String reasoningMode,\n                                 Long notebookId");
        assertEquals(1, count(m, "heartbeats.start(emitter)"), m);
        assertEquals(2, count(m, "beat.close()"), "成功、出错两条路径各关一次：\n" + m);
    }

    @Test
    @DisplayName("清空记忆：一条语句软删全部消息，不逐条 deleteById")
    void 清空记忆一条语句() throws Exception {
        String src = Files.readString(Path.of("src/main/java/com/zhiqu/service/impl/AiServiceImpl.java"));
        String m = body(src, "public void clearMemory(Long userId)");
        assertFalse(m.contains("messageMapper.deleteById("), "又变回逐条删了：\n" + m);
        assertEquals(1, count(m, "messageMapper.delete("), m);
    }
}
