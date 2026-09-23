package com.zhiqu.service.ai;

import com.zhiqu.SourceText;
import com.zhiqu.common.BusinessException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 按模型的上下文窗口分配各处上限（2026-09-24，用户问「上下文能不能拓展到 1M」）。
 */
class ContextBudgetTest {

    /** 没填窗口时一个字都不变 —— 这是「已有对话行为不受影响」的全部依据。 */
    @Test
    @DisplayName("没填窗口：与原来写死的那组常量逐项相同（20 条 / 不按字裁 / 代码 12000 / 历史 24000 / Wiki 20000）")
    void 没填就不变() {
        assertEquals(new ContextBudget(20, Integer.MAX_VALUE, 12_000, 24_000, 20_000), ContextBudget.forWindow(null));
    }

    @Test
    @DisplayName("1M 窗口：历史 35 万字、代码与 Wiki 各 15 万字、最多 400 条")
    void 一百万() {
        ContextBudget b = ContextBudget.forWindow(1_000_000);
        assertEquals(400, b.historyMessages());
        assertEquals(350_000, b.historyChars());
        assertEquals(150_000, b.codeContextChars());
        assertEquals(350_000, b.codeHistoryChars());
        assertEquals(150_000, b.wikiContextChars());
    }

    /** 单次调用里各块加起来不能超过窗口 —— 否则填了窗口反而会让请求被服务商拒绝。 */
    @Test
    @DisplayName("任意窗口下，最终回答那一次调用的历史 + 代码 + Wiki 不超过窗口的 70%")
    void 一次调用不超窗口() {
        for (int w = ContextBudget.MIN_WINDOW; w <= ContextBudget.MAX_WINDOW; w += 7_919) {
            ContextBudget b = ContextBudget.forWindow(w);
            long sum = (long) b.historyChars() + b.codeContextChars() + b.wikiContextChars();
            assertTrue(sum <= w * 0.7, "窗口 " + w + " 时单次调用要塞 " + sum + " 字");
            assertTrue(b.codeHistoryChars() <= w * 0.4, "coding agent 的历史占了窗口 " + w + " 的 " + b.codeHistoryChars());
        }
    }

    @Test
    @DisplayName("按字数裁历史：恰好等于预算全留；多一个字就丢最老的；最新一条超了也要留；不按字裁时全留")
    void 按字数裁历史() {
        java.util.List<String> h = java.util.List.of("aaaa", "bbb", "cc");   // 4 + 3 + 2 = 9
        assertEquals(0, ContextBudget.keepFrom(h, String::length, 9), "恰好等于预算应当全留");
        assertEquals(1, ContextBudget.keepFrom(h, String::length, 8), "多一个字应当丢掉最老那条");
        assertEquals(2, ContextBudget.keepFrom(h, String::length, 1), "最新一条自己就超了也要留着");
        assertEquals(0, ContextBudget.keepFrom(h, String::length, Integer.MAX_VALUE), "没配窗口时不该裁");
        assertEquals(0, ContextBudget.keepFrom(java.util.List.<String>of(), String::length, 5));
    }

    @Test
    @DisplayName("保存校验：空 = 默认；8000 到 1000000 之间放行；越界报错说明范围")
    void 保存校验() {
        assertNull(ContextBudget.validate(null));
        assertEquals(128_000, ContextBudget.validate(128_000));
        assertEquals(1_000_000, ContextBudget.validate(1_000_000));
        BusinessException e = assertThrows(BusinessException.class, () -> ContextBudget.validate(2_000_000));
        assertTrue(e.getMessage().contains("1000000"), e.getMessage());
        assertThrows(BusinessException.class, () -> ContextBudget.validate(100));
    }

    /**
     * 这一列必须有读者（V34 退掉的 daily_quota 就是「能写进来、没有任何代码读」）。
     * 读者要在<b>真正决定发给模型什么</b>的地方：取历史、交给 coding agent、交给 Wiki agent。
     */
    @Test
    @DisplayName("上下文窗口真的被读：取历史、coding agent、Wiki agent 三处都按它走")
    void 窗口有读者() throws Exception {
        String svc = SourceText.stripComments(Files.readString(
                Path.of("src/main/java/com/zhiqu/service/impl/AiServiceImpl.java"), StandardCharsets.UTF_8));
        assertTrue(svc.contains("ContextBudget.forWindow(config.getContextWindowTokens())"), "取历史时没按窗口算上限");
        assertTrue(svc.contains("getRecentMessages(userId, liveConversation.getId(), contextBudget.historyMessages())"),
                "流式对话取历史的条数不是按窗口来的");
        assertTrue(svc.contains("historyWithin(fetchedHistory, contextBudget.historyChars())"), "历史没按字数裁");
        assertTrue(svc.contains("liveHistory.size() < fetchedHistory.size()"),
                "「被字数裁过」没算进窗口已满 —— 裁掉的消息不会进滚动摘要，从模型视野里静默消失");
        assertTrue(svc.contains("wikiContextChars()") && svc.contains("ContextBudget.forWindow(s.config.getContextWindowTokens()),"),
                "Wiki / coding agent 的上限没跟着窗口走");
        assertFalse(svc.contains("CHAT_HISTORY_LIMIT"), "又出现了写死的历史条数 —— 20 这个数的唯一定义在 ContextBudget.DEFAULT");
        assertTrue(svc.contains("if (body.containsKey(\"contextWindowTokens\"))"),
                "保存模型时不是「请求体里有这个键才改」—— 旧客户端不发它，会把已填的窗口清掉");
        assertTrue(svc.contains("row.put(\"contextWindowTokens\", model.getContextWindowTokens())"),
                "模型信息里没带窗口 —— 界面回填不了，harness 也没法按它压缩长对话");
    }

    /** 界面能填、能回填；新输入框用 id 取，不能插进按位置取的那四个输入框中间。 */
    @Test
    @DisplayName("个人中心的模型表单能填上下文窗口，保存时发出去、编辑时回填")
    void 表单接线() throws Exception {
        String html = Files.readString(Path.of("src/main/resources/static/profile.html"), StandardCharsets.UTF_8);
        String js = SourceText.stripComments(Files.readString(Path.of("src/main/resources/static/assets/zhiqu-api.js"), StandardCharsets.UTF_8));
        int key = html.indexOf("placeholder=\"留空则不修改已保存 Key\"");
        int ctx = html.indexOf("id=\"zq-model-context\"");
        assertTrue(key > 0 && ctx > key, "上下文窗口输入框要放在 API Key 之后 —— 插在前面会让按位置取的输入框整体错位");
        assertTrue(js.contains("contextWindow: $('#zq-model-context')"), "表单没取到上下文窗口输入框");
        assertTrue(js.contains("body.contextWindowTokens = els.contextWindow.value.trim()"), "保存时没把窗口发出去");
        assertTrue(js.contains("els.contextWindow.value = m.contextWindowTokens || ''"), "编辑模型时没回填窗口");
    }
}
